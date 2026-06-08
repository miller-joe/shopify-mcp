import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ShopifyClient } from "../shopify/client.js";
import { throwIfUserErrors } from "../shopify/client.js";
import type {
  Connection,
  Product,
  ProductDetail,
  ShopifyUserError,
} from "../shopify/types.js";

const LIST_PRODUCTS_QUERY = /* GraphQL */ `
  query ListProducts($first: Int!, $after: String, $query: String) {
    products(first: $first, after: $after, query: $query) {
      edges {
        cursor
        node {
          id
          title
          handle
          status
          vendor
          productType
          totalInventory
          createdAt
          updatedAt
          featuredImage { url altText }
        }
      }
      pageInfo { hasNextPage hasPreviousPage startCursor endCursor }
    }
  }
`;

const GET_PRODUCT_QUERY = /* GraphQL */ `
  query GetProduct($id: ID!) {
    product(id: $id) {
      id
      title
      handle
      status
      vendor
      productType
      description
      tags
      totalInventory
      createdAt
      updatedAt
      featuredImage { url altText }
      images(first: 10) { edges { node { url altText } } }
      variants(first: 20) {
        edges {
          node {
            id
            title
            price
            sku
            inventoryQuantity
            inventoryItem { id }
          }
        }
      }
      media(first: 10) {
        edges { node { id mediaContentType } }
      }
    }
  }
`;

const CREATE_PRODUCT_MUTATION = /* GraphQL */ `
  mutation CreateProduct($input: ProductInput!) {
    productCreate(input: $input) {
      product {
        id
        title
        handle
        status
      }
      userErrors { field message }
    }
  }
`;

const UPDATE_PRODUCT_MUTATION = /* GraphQL */ `
  mutation UpdateProduct($input: ProductInput!) {
    productUpdate(input: $input) {
      product {
        id
        title
        handle
        status
      }
      userErrors { field message }
    }
  }
`;

const CREATE_MEDIA_MUTATION = /* GraphQL */ `
  mutation ProductCreateMedia($productId: ID!, $media: [CreateMediaInput!]!) {
    productCreateMedia(productId: $productId, media: $media) {
      media {
        ... on MediaImage {
          id
          image { url altText }
        }
      }
      mediaUserErrors { field message }
    }
  }
`;

const listProductsSchema = {
  first: z
    .number()
    .int()
    .min(1)
    .max(100)
    .default(20)
    .describe("Page size — number of products to return (1-100). Default 20."),
  query: z
    .string()
    .optional()
    .describe(
      "Shopify product query syntax, e.g. 'status:active', 'title:*shirt*', 'vendor:MyVendor', 'product_type:Art', 'tag:sale', 'created_at:>=2026-01-01'. Combine terms with AND/OR/NOT. Omit to list all products.",
    ),
  after: z
    .string()
    .optional()
    .describe(
      "Opaque pagination cursor from a prior call's 'next cursor:' line. Omit on the first call.",
    ),
};

const getProductSchema = {
  id: z
    .string()
    .describe(
      "Product identifier — Shopify GID ('gid://shopify/Product/123') or a bare numeric ID (auto-promoted to a GID). Get one from list_products.",
    ),
};

const createProductSchema = {
  title: z.string().min(1).describe("Product title shown to shoppers. Required, non-empty."),
  description: z
    .string()
    .optional()
    .describe("Product body/description as HTML (maps to descriptionHtml). Plain text is fine; tags render."),
  vendor: z.string().optional().describe("Vendor/brand name (free text). Optional."),
  product_type: z
    .string()
    .optional()
    .describe("Merchant-defined product category/type, e.g. 'Art' or 'T-Shirt' (free text). Optional."),
  tags: z
    .array(z.string())
    .optional()
    .describe("Tag strings for filtering, smart-collection rules, and search. Optional."),
  status: z
    .enum(["ACTIVE", "DRAFT", "ARCHIVED"])
    .default("DRAFT")
    .describe(
      "Storefront visibility. ACTIVE = live/purchasable, DRAFT = hidden work-in-progress, ARCHIVED = retired but order history kept. Defaults to DRAFT to avoid accidentally publishing.",
    ),
  image_urls: z
    .array(z.string().url())
    .optional()
    .describe(
      "Publicly fetchable image URLs to attach after the product is created. Shopify pulls each URL server-side and rehosts it on its CDN. Optional.",
    ),
};

const updateProductSchema = {
  id: z
    .string()
    .describe("Product GID ('gid://shopify/Product/123') or numeric ID to update."),
  title: z.string().optional().describe("New product title. Omit to leave unchanged."),
  description: z
    .string()
    .optional()
    .describe("New HTML description (descriptionHtml). Omit to leave unchanged; pass empty string to clear."),
  vendor: z.string().optional().describe("New vendor/brand name. Omit to leave unchanged."),
  product_type: z
    .string()
    .optional()
    .describe("New product type/category. Omit to leave unchanged."),
  tags: z
    .array(z.string())
    .optional()
    .describe("New tag set. REPLACES the existing tags entirely (not additive). Use add_tags/remove_tags for incremental changes."),
  status: z
    .enum(["ACTIVE", "DRAFT", "ARCHIVED"])
    .optional()
    .describe(
      "New status. ACTIVE = live, DRAFT = hidden, ARCHIVED = hidden but order history preserved. Omit to leave unchanged.",
    ),
};

const uploadProductImageSchema = {
  product_id: z
    .string()
    .describe("Product GID ('gid://shopify/Product/123') or numeric ID to attach the image to."),
  image_url: z
    .string()
    .url()
    .describe(
      "Public image URL. Must be reachable from Shopify's network — Shopify fetches it server-side and rehosts on its CDN.",
    ),
  alt_text: z
    .string()
    .optional()
    .describe("Alt text for accessibility/SEO. Optional."),
};

export function registerProductTools(
  server: McpServer,
  client: ShopifyClient,
): void {
  server.tool(
    "list_products",
    "List products in the store with cursor-based pagination via the Shopify Admin GraphQL API. Read-only, no side effects (requires read_products scope). Returns a text summary, one line per product: title, status (ACTIVE/DRAFT/ARCHIVED), GID, and total inventory across all variants/locations; the last line is either 'next cursor: ...' (pass as `after` to page) or '(end of results)'. Supports Shopify's product query syntax for filtering by status, vendor, type, tag, title (wildcard), and date ranges. Use this to find product GIDs before calling get_product, update_product, list_variants, or any product-scoped tool.",
    listProductsSchema,
    async (args) => {
      const data = await client.graphql<{ products: Connection<Product> }>(
        LIST_PRODUCTS_QUERY,
        { first: args.first, query: args.query, after: args.after },
      );
      const lines = [
        `Found ${data.products.edges.length} product(s):`,
        ...data.products.edges.map(
          ({ node }) =>
            `  ${node.title} (${node.status}) — ${node.id}` +
            (node.totalInventory != null
              ? ` [inventory: ${node.totalInventory}]`
              : ""),
        ),
        data.products.pageInfo.hasNextPage
          ? `next cursor: ${data.products.edges[data.products.edges.length - 1]?.cursor}`
          : "(end of results)",
      ];
      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    },
  );

  server.tool(
    "get_product",
    "Fetch a single product's full record by GID or numeric ID. Read-only, no side effects (requires read_products scope). Returns pretty-printed JSON: header fields (title, handle, status, vendor, productType, description, tags), inventory totals, the first 10 images and 10 media items, and the first 20 variants with their prices, SKUs, inventory quantities, and inventoryItem GIDs (those inventoryItem GIDs are required by set_inventory_quantity). Returns 'Product not found: <id>' if the GID doesn't resolve. Use list_products to discover IDs first; for more than 20 variants follow up with list_variants.",
    getProductSchema,
    async (args) => {
      const data = await client.graphql<{ product: ProductDetail | null }>(
        GET_PRODUCT_QUERY,
        { id: toGid(args.id, "Product") },
      );
      if (!data.product) {
        return {
          content: [{ type: "text" as const, text: `Product not found: ${args.id}` }],
        };
      }
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(data.product, null, 2),
          },
        ],
      };
    },
  );

  server.tool(
    "create_product",
    "Create a new product via the Shopify Admin API. Side effect: writes live store data (requires write_products scope); not reversible via this tool — use update_product to set status=ARCHIVED to retire it. The product is created first, then any image_urls (publicly fetchable) are attached as a follow-up call — Shopify pulls each URL and rehosts on its CDN. Defaults to status=DRAFT to prevent accidentally publishing half-configured products; pass status=ACTIVE only when ready to go live. New products start with a single hidden 'Default Title' variant; to add real variants with options, call create_variants with strategy='REMOVE_STANDALONE_VARIANT'. Returns a text summary with the new product's GID and handle. Use update_product to edit an existing product instead.",
    createProductSchema,
    async (args) => {
      const data = await client.graphql<{
        productCreate: {
          product: Product | null;
          userErrors: ShopifyUserError[];
        };
      }>(CREATE_PRODUCT_MUTATION, {
        input: {
          title: args.title,
          descriptionHtml: args.description,
          vendor: args.vendor,
          productType: args.product_type,
          tags: args.tags,
          status: args.status,
        },
      });
      throwIfUserErrors(data.productCreate.userErrors, "productCreate");
      const product = data.productCreate.product;
      if (!product) throw new Error("productCreate returned no product");

      const attached: string[] = [];
      if (args.image_urls?.length) {
        await attachImages(client, product.id, args.image_urls);
        attached.push(...args.image_urls);
      }

      const lines = [
        `Created ${args.status} product: ${product.title} (${product.id})`,
        `  handle: ${product.handle}`,
      ];
      if (attached.length) {
        lines.push(`  attached ${attached.length} image(s)`);
      }
      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    },
  );

  server.tool(
    "update_product",
    "Update an existing product's core fields — title, description (HTML), vendor, productType, tags, or status — via the Shopify Admin API. Side effect: mutates live store data immediately (requires write_products scope); not reversible via this tool. Only provide fields you want changed; omitted fields are left untouched. Note `tags` is a full replacement, not additive. Setting status=ARCHIVED hides the product from the storefront but preserves order history. Returns a text confirmation with the product's title and GID. Use create_product to add a new product, get_product to read without modifying; for variants/prices/inventory use create_variants/update_variants and set_inventory_quantity; for images use upload_product_image or the bridge tools.",
    updateProductSchema,
    async (args) => {
      const input: Record<string, unknown> = { id: toGid(args.id, "Product") };
      if (args.title !== undefined) input.title = args.title;
      if (args.description !== undefined)
        input.descriptionHtml = args.description;
      if (args.vendor !== undefined) input.vendor = args.vendor;
      if (args.product_type !== undefined)
        input.productType = args.product_type;
      if (args.tags !== undefined) input.tags = args.tags;
      if (args.status !== undefined) input.status = args.status;

      const data = await client.graphql<{
        productUpdate: {
          product: Product | null;
          userErrors: ShopifyUserError[];
        };
      }>(UPDATE_PRODUCT_MUTATION, { input });
      throwIfUserErrors(data.productUpdate.userErrors, "productUpdate");
      const product = data.productUpdate.product;
      if (!product) throw new Error("productUpdate returned no product");
      return {
        content: [
          {
            type: "text" as const,
            text: `Updated product: ${product.title} (${product.id})`,
          },
        ],
      };
    },
  );

  server.tool(
    "upload_product_image",
    "Attach an image to an existing product by URL via the Shopify Admin API. Side effect: adds media to live store data (requires write_products scope); Shopify fetches the URL server-side and rehosts on its CDN, so the URL must be publicly reachable from Shopify's network. Additive — multiple calls add multiple images; this tool never replaces or deletes existing images. Returns a text confirmation with the new media GID(s). Use the bridge tools (generate_product_image, refine_product_image) instead when you want the image generated by ComfyUI rather than provided as a URL.",
    uploadProductImageSchema,
    async (args) => {
      const productId = toGid(args.product_id, "Product");
      const result = await attachImages(client, productId, [args.image_url], args.alt_text);
      return {
        content: [
          {
            type: "text" as const,
            text: `Attached image to ${productId}: ${result.map((m) => m.id).join(", ")}`,
          },
        ],
      };
    },
  );
}

export async function attachImages(
  client: ShopifyClient,
  productId: string,
  imageUrls: string[],
  altText?: string,
): Promise<Array<{ id: string }>> {
  const data = await client.graphql<{
    productCreateMedia: {
      media: Array<{ id: string } | null>;
      mediaUserErrors: ShopifyUserError[];
    };
  }>(CREATE_MEDIA_MUTATION, {
    productId,
    media: imageUrls.map((url) => ({
      originalSource: url,
      mediaContentType: "IMAGE",
      alt: altText,
    })),
  });
  throwIfUserErrors(data.productCreateMedia.mediaUserErrors, "productCreateMedia");
  return data.productCreateMedia.media.filter(
    (m): m is { id: string } => m !== null,
  );
}

export function toGid(id: string, type: string): string {
  if (id.startsWith("gid://")) return id;
  return `gid://shopify/${type}/${id}`;
}
