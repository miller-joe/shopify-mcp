import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ShopifyClient } from "../shopify/client.js";
import { throwIfUserErrors } from "../shopify/client.js";
import type { Connection, Product, ShopifyUserError } from "../shopify/types.js";
import type { ComfyUIClient, ImageRef } from "../comfyui/client.js";
import { stagedUploadImage } from "../shopify/upload.js";
import { attachImages, toGid } from "./products.js";

const CREATE_PRODUCT_MUTATION = /* GraphQL */ `
  mutation CreateProduct($input: ProductInput!) {
    productCreate(input: $input) {
      product { id title handle status }
      userErrors { field message }
    }
  }
`;

const LIST_PRODUCTS_FOR_REGEN_QUERY = /* GraphQL */ `
  query ListForRegen($first: Int!, $query: String, $after: String) {
    products(first: $first, after: $after, query: $query) {
      edges { cursor node { id title handle } }
      pageInfo { hasNextPage }
    }
  }
`;

const generateAndCreateSchema = {
  prompt: z
    .string()
    .min(1)
    .describe(
      "Image prompt describing the product to generate. The title, description, and alt-text are derived from this prompt if not provided explicitly.",
    ),
  title: z
    .string()
    .optional()
    .describe("Product title; defaults to a cleaned-up version of the prompt"),
  description: z
    .string()
    .optional()
    .describe(
      "Product description (HTML). If omitted, a short placeholder description derived from the prompt is used",
    ),
  price: z.string().optional().describe("Product price (string, e.g. '29.99')"),
  vendor: z.string().optional(),
  product_type: z.string().optional(),
  tags: z.array(z.string()).optional(),
  status: z.enum(["ACTIVE", "DRAFT", "ARCHIVED"]).default("DRAFT"),
  width: z.number().int().min(64).max(2048).default(1024),
  height: z.number().int().min(64).max(2048).default(1024),
  steps: z.number().int().min(1).max(150).default(25),
  cfg: z.number().min(1).max(30).default(7),
  seed: z.number().int().optional(),
  checkpoint: z
    .string()
    .optional()
    .describe(
      "ComfyUI checkpoint filename. Defaults to COMFYUI_DEFAULT_CKPT env var.",
    ),
};

const generateProductImageSchema = {
  product_id: z.string().describe("Product GID or numeric ID"),
  prompt: z.string().min(1).describe("Image prompt"),
  alt_text: z.string().optional(),
  width: z.number().int().min(64).max(2048).default(1024),
  height: z.number().int().min(64).max(2048).default(1024),
  steps: z.number().int().min(1).max(150).default(25),
  cfg: z.number().min(1).max(30).default(7),
  seed: z.number().int().optional(),
  checkpoint: z.string().optional(),
};

const refineProductImageSchema = {
  product_id: z.string().describe("Product GID or numeric ID"),
  prompt: z
    .string()
    .min(1)
    .describe("Prompt guiding the refinement (img2img)."),
  source_image_url: z
    .string()
    .url()
    .optional()
    .describe(
      "URL of the source image. If omitted, uses the product's featured image.",
    ),
  denoise: z
    .number()
    .min(0)
    .max(1)
    .default(0.5)
    .describe("0 = no change, 1 = fully regenerate. Typical 0.3–0.7."),
  negative_prompt: z.string().optional(),
  steps: z.number().int().min(1).max(150).default(25),
  cfg: z.number().min(1).max(30).default(7),
  seed: z.number().int().optional(),
  checkpoint: z.string().optional(),
  alt_text: z.string().optional(),
};

const GET_FEATURED_IMAGE_QUERY = /* GraphQL */ `
  query GetFeaturedImage($id: ID!) {
    product(id: $id) {
      id
      title
      featuredImage { url altText }
    }
  }
`;

const bulkRegenerateSchema = {
  product_query: z
    .string()
    .describe(
      "Shopify product query filter (e.g. 'tag:ai-regen', 'product_type:Art')",
    ),
  prompt_template: z
    .string()
    .describe(
      "Template for the image prompt. `{title}` and `{handle}` are substituted from each matching product. Example: 'high-quality product photo of {title} on white background'",
    ),
  max_products: z
    .number()
    .int()
    .min(1)
    .max(100)
    .default(10)
    .describe("Safety cap on how many products to process in one call"),
  width: z.number().int().min(64).max(2048).default(1024),
  height: z.number().int().min(64).max(2048).default(1024),
  steps: z.number().int().min(1).max(150).default(25),
  cfg: z.number().min(1).max(30).default(7),
  checkpoint: z.string().optional(),
};

export function registerBridgeTools(
  server: McpServer,
  shopify: ShopifyClient,
  comfyui: ComfyUIClient | null,
  defaultCheckpoint: string,
): void {
  if (!comfyui) {
    return;
  }

  server.tool(
    "generate_and_create_product",
    "Generate a product image with ComfyUI and create a Shopify product with the image attached. Title/description default from the prompt if not provided. Use this to spin up catalog listings from natural-language prompts.",
    generateAndCreateSchema,
    async (args) => {
      const checkpoint = args.checkpoint ?? defaultCheckpoint;
      const gen = await comfyui.generate({
        prompt: args.prompt,
        width: args.width,
        height: args.height,
        steps: args.steps,
        cfg: args.cfg,
        seed: args.seed,
        checkpoint,
      });
      if (gen.internalImageRefs.length === 0) {
        throw new Error("ComfyUI returned no images");
      }
      const ref = gen.internalImageRefs[0]!;
      const stagedResource = await uploadRefToShopify(shopify, comfyui, ref);

      const title = args.title ?? titleFromPrompt(args.prompt);
      const description =
        args.description ?? `<p>${escapeHtml(args.prompt)}</p>`;

      const input: Record<string, unknown> = {
        title,
        descriptionHtml: description,
        status: args.status,
      };
      if (args.vendor) input.vendor = args.vendor;
      if (args.product_type) input.productType = args.product_type;
      if (args.tags) input.tags = args.tags;

      const created = await shopify.graphql<{
        productCreate: {
          product: Product | null;
          userErrors: ShopifyUserError[];
        };
      }>(CREATE_PRODUCT_MUTATION, { input });
      throwIfUserErrors(created.productCreate.userErrors, "productCreate");
      const product = created.productCreate.product;
      if (!product) throw new Error("productCreate returned no product");

      await attachImages(shopify, product.id, [stagedResource], title);

      const lines = [
        `Created ${args.status} product: ${product.title}`,
        `  id:     ${product.id}`,
        `  handle: ${product.handle}`,
        `  image:  ${ref.filename} (uploaded via Shopify staged storage)`,
        `  comfyui prompt_id: ${gen.promptId}`,
      ];
      if (args.price) {
        lines.push(
          `  price:  ${args.price} — note: variant pricing via productSet or variantsBulkCreate is a v0.2 tool`,
        );
      }
      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    },
  );

  server.tool(
    "generate_product_image",
    "Generate a new image with ComfyUI and attach it to an existing product. Does not replace existing images (use update_product or delete_product_image — v0.2 — to prune).",
    generateProductImageSchema,
    async (args) => {
      const checkpoint = args.checkpoint ?? defaultCheckpoint;
      const gen = await comfyui.generate({
        prompt: args.prompt,
        width: args.width,
        height: args.height,
        steps: args.steps,
        cfg: args.cfg,
        seed: args.seed,
        checkpoint,
      });
      if (gen.internalImageRefs.length === 0) {
        throw new Error("ComfyUI returned no images");
      }
      const ref = gen.internalImageRefs[0]!;
      const stagedResource = await uploadRefToShopify(shopify, comfyui, ref);
      const productId = toGid(args.product_id, "Product");
      await attachImages(shopify, productId, [stagedResource], args.alt_text ?? args.prompt);
      return {
        content: [
          {
            type: "text" as const,
            text: `Attached generated image to ${productId}\n  image: ${ref.filename} (uploaded via Shopify staged storage)\n  comfyui prompt_id: ${gen.promptId}`,
          },
        ],
      };
    },
  );

  server.tool(
    "refine_product_image",
    "Refine an existing product image with ComfyUI img2img, then attach the refined result to the product. Pass a source_image_url explicitly, or omit it to use the product's featured image. Lower denoise preserves more of the original; higher denoise follows the prompt more freely.",
    refineProductImageSchema,
    async (args) => {
      const checkpoint = args.checkpoint ?? defaultCheckpoint;
      const productId = toGid(args.product_id, "Product");

      let sourceUrl = args.source_image_url;
      if (!sourceUrl) {
        const lookup = await shopify.graphql<{
          product: {
            id: string;
            title: string;
            featuredImage?: { url: string; altText?: string | null } | null;
          } | null;
        }>(GET_FEATURED_IMAGE_QUERY, { id: productId });
        if (!lookup.product) {
          throw new Error(`Product not found: ${productId}`);
        }
        if (!lookup.product.featuredImage?.url) {
          throw new Error(
            `Product ${productId} has no featured image. Pass source_image_url explicitly.`,
          );
        }
        sourceUrl = lookup.product.featuredImage.url;
      }

      const result = await comfyui.refine({
        prompt: args.prompt,
        negativePrompt: args.negative_prompt,
        sourceImageUrl: sourceUrl,
        denoise: args.denoise,
        steps: args.steps,
        cfg: args.cfg,
        seed: args.seed,
        checkpoint,
      });
      if (result.internalImageRefs.length === 0) {
        throw new Error("ComfyUI returned no refined images");
      }
      const ref = result.internalImageRefs[0]!;
      const staged = await uploadRefToShopify(shopify, comfyui, ref);
      await attachImages(shopify, productId, [staged], args.alt_text ?? args.prompt);
      return {
        content: [
          {
            type: "text" as const,
            text: [
              `Refined image attached to ${productId}`,
              `  source:   ${sourceUrl}`,
              `  denoise:  ${args.denoise}`,
              `  new file: ${ref.filename}`,
              `  comfyui prompt_id: ${result.promptId}`,
            ].join("\n"),
          },
        ],
      };
    },
  );

  server.tool(
    "bulk_regenerate_images",
    "For each product matching product_query, generate a new image using the prompt_template and attach it. Honours max_products as a safety cap. Useful for seasonal refreshes or AI-catalog updates.",
    bulkRegenerateSchema,
    async (args) => {
      const checkpoint = args.checkpoint ?? defaultCheckpoint;
      const products: Array<{ id: string; title: string; handle: string }> = [];
      let cursor: string | undefined = undefined;
      while (products.length < args.max_products) {
        const remaining = args.max_products - products.length;
        const data: { products: Connection<{ id: string; title: string; handle: string }> } = await shopify.graphql(
          LIST_PRODUCTS_FOR_REGEN_QUERY,
          {
            first: Math.min(50, remaining),
            query: args.product_query,
            after: cursor,
          },
        );
        products.push(...data.products.edges.map((e) => e.node));
        if (!data.products.pageInfo.hasNextPage) break;
        cursor = data.products.edges[data.products.edges.length - 1]?.cursor;
      }

      const results: string[] = [];
      for (const p of products.slice(0, args.max_products)) {
        const prompt = args.prompt_template
          .replaceAll("{title}", p.title)
          .replaceAll("{handle}", p.handle);
        try {
          const gen = await comfyui.generate({
            prompt,
            width: args.width,
            height: args.height,
            steps: args.steps,
            cfg: args.cfg,
            checkpoint,
          });
          if (gen.internalImageRefs.length === 0) {
            results.push(`  ✗ ${p.title}: ComfyUI returned no images`);
            continue;
          }
          const ref = gen.internalImageRefs[0]!;
          const stagedResource = await uploadRefToShopify(shopify, comfyui, ref);
          await attachImages(shopify, p.id, [stagedResource], p.title);
          results.push(`  ✓ ${p.title} — ${ref.filename}`);
        } catch (err) {
          results.push(`  ✗ ${p.title}: ${(err as Error).message}`);
        }
      }

      return {
        content: [
          {
            type: "text" as const,
            text: [
              `Processed ${results.length} product(s) matching '${args.product_query}':`,
              ...results,
            ].join("\n"),
          },
        ],
      };
    },
  );
}

async function uploadRefToShopify(
  shopify: ShopifyClient,
  comfyui: ComfyUIClient,
  ref: ImageRef,
): Promise<string> {
  const { bytes, contentType } = await comfyui.fetchImageBytes(ref);
  return stagedUploadImage(shopify, bytes, ref.filename, contentType);
}

function titleFromPrompt(prompt: string): string {
  const trimmed = prompt.trim().replace(/\s+/g, " ");
  const shortened =
    trimmed.length > 60 ? trimmed.slice(0, 60).replace(/,\s*$/, "") + "…" : trimmed;
  return shortened.charAt(0).toUpperCase() + shortened.slice(1);
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
