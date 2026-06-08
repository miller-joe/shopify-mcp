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
  price: z
    .string()
    .optional()
    .describe(
      "Informational price as a decimal string, e.g. '29.99'. NOTE: in this version it is only echoed in the output, not yet applied to the product's variant — set real prices via create_variants/update_variants afterwards.",
    ),
  vendor: z.string().optional().describe("Vendor/brand name for the new product (free text). Optional."),
  product_type: z
    .string()
    .optional()
    .describe("Product type/category for the new product (free text). Optional."),
  tags: z.array(z.string()).optional().describe("Tag strings applied to the new product. Optional."),
  status: z
    .enum(["ACTIVE", "DRAFT", "ARCHIVED"])
    .default("DRAFT")
    .describe(
      "Storefront visibility of the new product. ACTIVE = live, DRAFT = hidden, ARCHIVED = retired. Defaults to DRAFT to avoid auto-publishing a freshly generated listing.",
    ),
  width: z
    .number()
    .int()
    .min(64)
    .max(2048)
    .default(1024)
    .describe("Generated image width in pixels (64-2048). Default 1024."),
  height: z
    .number()
    .int()
    .min(64)
    .max(2048)
    .default(1024)
    .describe("Generated image height in pixels (64-2048). Default 1024."),
  steps: z
    .number()
    .int()
    .min(1)
    .max(150)
    .default(25)
    .describe("ComfyUI sampler steps (1-150). More steps = slower but potentially higher quality. Default 25."),
  cfg: z
    .number()
    .min(1)
    .max(30)
    .default(7)
    .describe("Classifier-free guidance scale (1-30). Higher = follows the prompt more strictly. Default 7."),
  seed: z
    .number()
    .int()
    .optional()
    .describe("Sampler seed for reproducible generation. Omit for a random seed each call."),
  checkpoint: z
    .string()
    .optional()
    .describe(
      "ComfyUI checkpoint (model) filename to load. Defaults to the server's COMFYUI_DEFAULT_CKPT env var.",
    ),
};

const generateProductImageSchema = {
  product_id: z
    .string()
    .describe("Existing product to attach the generated image to — Shopify GID or numeric ID."),
  prompt: z.string().min(1).describe("Text-to-image prompt describing the image to generate. Required, non-empty."),
  alt_text: z
    .string()
    .optional()
    .describe("Alt text for the attached image. Defaults to the prompt if omitted."),
  width: z
    .number()
    .int()
    .min(64)
    .max(2048)
    .default(1024)
    .describe("Generated image width in pixels (64-2048). Default 1024."),
  height: z
    .number()
    .int()
    .min(64)
    .max(2048)
    .default(1024)
    .describe("Generated image height in pixels (64-2048). Default 1024."),
  steps: z
    .number()
    .int()
    .min(1)
    .max(150)
    .default(25)
    .describe("ComfyUI sampler steps (1-150). Default 25."),
  cfg: z
    .number()
    .min(1)
    .max(30)
    .default(7)
    .describe("Classifier-free guidance scale (1-30). Higher = stricter prompt adherence. Default 7."),
  seed: z
    .number()
    .int()
    .optional()
    .describe("Sampler seed for reproducible generation. Omit for random."),
  checkpoint: z
    .string()
    .optional()
    .describe("ComfyUI checkpoint filename. Defaults to the server's COMFYUI_DEFAULT_CKPT env var."),
};

const refineProductImageSchema = {
  product_id: z
    .string()
    .describe("Product whose image is being refined and which the result is attached to — Shopify GID or numeric ID."),
  prompt: z
    .string()
    .min(1)
    .describe("Text prompt guiding the img2img refinement. Required, non-empty."),
  source_image_url: z
    .string()
    .url()
    .optional()
    .describe(
      "URL of the source image to refine. If omitted, the product's featured image is used (the tool errors if the product has no featured image).",
    ),
  denoise: z
    .number()
    .min(0)
    .max(1)
    .default(0.5)
    .describe("img2img denoising strength (0-1): 0 = keep the source unchanged, 1 = fully regenerate from the prompt. Typical 0.3–0.7. Default 0.5."),
  negative_prompt: z
    .string()
    .optional()
    .describe("Negative prompt — concepts to steer away from. Optional."),
  steps: z
    .number()
    .int()
    .min(1)
    .max(150)
    .default(25)
    .describe("ComfyUI sampler steps (1-150). Default 25."),
  cfg: z
    .number()
    .min(1)
    .max(30)
    .default(7)
    .describe("Classifier-free guidance scale (1-30). Higher = stricter prompt adherence. Default 7."),
  seed: z
    .number()
    .int()
    .optional()
    .describe("Sampler seed for reproducible generation. Omit for random."),
  checkpoint: z
    .string()
    .optional()
    .describe("ComfyUI checkpoint filename. Defaults to the server's COMFYUI_DEFAULT_CKPT env var."),
  alt_text: z
    .string()
    .optional()
    .describe("Alt text for the attached refined image. Defaults to the prompt if omitted."),
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
    .describe("Safety cap on how many matching products to process in one call (1-100). Default 10. Each product triggers a separate ComfyUI generation."),
  width: z
    .number()
    .int()
    .min(64)
    .max(2048)
    .default(1024)
    .describe("Generated image width in pixels (64-2048). Default 1024."),
  height: z
    .number()
    .int()
    .min(64)
    .max(2048)
    .default(1024)
    .describe("Generated image height in pixels (64-2048). Default 1024."),
  steps: z
    .number()
    .int()
    .min(1)
    .max(150)
    .default(25)
    .describe("ComfyUI sampler steps (1-150). Default 25."),
  cfg: z
    .number()
    .min(1)
    .max(30)
    .default(7)
    .describe("Classifier-free guidance scale (1-30). Higher = stricter prompt adherence. Default 7."),
  checkpoint: z
    .string()
    .optional()
    .describe("ComfyUI checkpoint filename used for every generation in the batch. Defaults to the server's COMFYUI_DEFAULT_CKPT env var."),
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
    "Generate a product image with the configured ComfyUI server, upload it to Shopify's staged storage, then create a new Shopify product with that image attached. Only available when the server is configured with a ComfyUI URL (otherwise this tool is not registered). Side effects: runs a (potentially slow, GPU-bound) image generation on ComfyUI, then writes a new product to live store data (requires write_products scope); not reversible via this tool. Title and description default from the prompt when not given; the created product defaults to DRAFT. The `price` argument is currently echoed only, not applied — set pricing via create_variants afterward. Returns a text summary with the new product's GID, handle, image filename, and the ComfyUI prompt_id. Use create_product for a plain (non-AI) product, or generate_product_image to add an AI image to a product that already exists.",
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
    "Generate a new image with the configured ComfyUI server, upload it to Shopify's staged storage, and attach it to an existing product. Only registered when the server has a ComfyUI URL configured. Side effects: runs a GPU-bound generation on ComfyUI, then adds media to live store data (requires write_products scope). Additive only — it never replaces or removes existing product images. Returns a text confirmation with the product GID, image filename, and ComfyUI prompt_id. Use generate_and_create_product to create a brand-new product with a generated image, refine_product_image to img2img an existing image, or upload_product_image to attach an externally provided URL.",
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
    "Refine an image with ComfyUI img2img using a text prompt, then attach the refined result to the product. Only registered when the server has a ComfyUI URL configured. The source is `source_image_url` if given, otherwise the product's current featured image (errors if neither is available). Side effects: runs a GPU-bound generation on ComfyUI, then adds the new image to live store data (requires write_products scope) — the original image is left in place, not replaced. Lower `denoise` keeps more of the original; higher follows the prompt more freely. Returns a text confirmation with the product GID, source URL, denoise, new filename, and ComfyUI prompt_id. Use generate_product_image for a fresh text-to-image generation instead of refining an existing one.",
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
    "Bulk operation: for each product matching `product_query` (up to `max_products`), generate a fresh ComfyUI image from `prompt_template` (with {title}/{handle} substituted) and attach it. Only registered when the server has a ComfyUI URL configured. Side effects: runs one GPU-bound generation per matched product and adds an image to each (additive, never replaces existing images); writes to live store data (requires write_products and read_products scopes). Per-product failures are caught and reported rather than aborting the whole run. Potentially slow and resource-heavy — keep `max_products` conservative. Returns a text summary listing each product with a ✓ (success + filename) or ✗ (error message). Use generate_product_image for a single product.",
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
