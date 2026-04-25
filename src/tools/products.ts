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
  first: z.number().int().min(1).max(100).default(20),
  query: z
    .string()
    .optional()
    .describe(
      "Shopify query syntax, e.g. 'status:active', 'title:*shirt*', 'vendor:MyVendor'",
    ),
  after: z.string().optional().describe("Cursor from a previous page"),
};

const getProductSchema = {
  id: z
    .string()
    .describe("Product GID (gid://shopify/Product/123...) or numeric ID"),
};

const createProductSchema = {
  title: z.string().min(1),
  description: z.string().optional().describe("Description as HTML"),
  vendor: z.string().optional(),
  product_type: z.string().optional(),
  tags: z.array(z.string()).optional(),
  status: z.enum(["ACTIVE", "DRAFT", "ARCHIVED"]).default("DRAFT"),
  image_urls: z
    .array(z.string().url())
    .optional()
    .describe("Image URLs to attach after creation"),
};

const updateProductSchema = {
  id: z.string().describe("Product GID or numeric ID"),
  title: z.string().optional(),
  description: z.string().optional(),
  vendor: z.string().optional(),
  product_type: z.string().optional(),
  tags: z.array(z.string()).optional(),
  status: z.enum(["ACTIVE", "DRAFT", "ARCHIVED"]).optional(),
};

const uploadProductImageSchema = {
  product_id: z.string().describe("Product GID or numeric ID"),
  image_url: z.string().url().describe("Public image URL to attach"),
  alt_text: z.string().optional(),
};

export function registerProductTools(
  server: McpServer,
  client: ShopifyClient,
): void {
  server.tool(
    "list_products",
    "List products in the store with cursor-based pagination. Returns each product's title, status (ACTIVE/DRAFT/ARCHIVED), GID, and total inventory across all variants/locations. Supports Shopify's product query syntax for filtering by status, vendor, type, tag, title (wildcard), and date ranges. The last line of output shows the next cursor when more pages exist — pass it as `after` on the next call. Use this to find product GIDs before calling get_product, update_product, list_variants, or any product-scoped tool.",
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
    "Fetch a single product's full record by GID or numeric ID. Returns header fields (title, handle, status, vendor, productType, description, tags), inventory totals, the first 10 images and 10 media items, and the first 20 variants with their prices, SKUs, inventory quantities, and inventoryItem GIDs. Returned as JSON for downstream tooling. The variant inventoryItem GIDs are needed by set_inventory_quantity. For more than 20 variants, follow up with list_variants.",
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
    "Create a new product. The product is created first, then any image_urls (publicly fetchable) are attached as a follow-up call — Shopify pulls each URL and hosts the image on its CDN. The default `status` is DRAFT to prevent accidentally publishing half-configured products to the storefront; pass status=ACTIVE only when you're ready to go live. New products start with a single hidden 'Default Title' variant; to add real variants with options, call create_variants with strategy='REMOVE_STANDALONE_VARIANT'. Returns the new product's GID and handle.",
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
    "Update an existing product's core fields — title, description (HTML), vendor, productType, tags, or status. Only provide fields you want changed; omitted fields are left untouched. Setting status=ARCHIVED hides the product from the storefront but preserves order history. To change variants, prices, or inventory use create_variants/update_variants and set_inventory_quantity. To change images use upload_product_image (or one of the bridge tools to generate new ones).",
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
    "Attach an image to an existing product by URL. Shopify fetches the URL server-side and hosts the file on its CDN — the URL must be publicly reachable from Shopify's network. Multiple calls add multiple images; this tool does not replace existing images. Use the bridge tools (generate_product_image, refine_product_image) instead when you want the image generated by ComfyUI rather than provided as a URL.",
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
