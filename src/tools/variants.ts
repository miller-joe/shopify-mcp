import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ShopifyClient } from "../shopify/client.js";
import { throwIfUserErrors } from "../shopify/client.js";
import type { ShopifyUserError } from "../shopify/types.js";

interface VariantNode {
  id: string;
  title: string;
  price: string;
  compareAtPrice?: string | null;
  sku?: string | null;
  barcode?: string | null;
  position?: number | null;
  taxable?: boolean | null;
  inventoryPolicy?: string | null;
  inventoryQuantity?: number | null;
  selectedOptions?: Array<{ name: string; value: string }>;
}

interface ProductOptionNode {
  id: string;
  name: string;
  position: number;
  optionValues: Array<{ id: string; name: string; hasVariants?: boolean }>;
}

const LIST_VARIANTS_QUERY = /* GraphQL */ `
  query ListVariants($productId: ID!, $first: Int!) {
    product(id: $productId) {
      id
      title
      options {
        id
        name
        position
        optionValues { id name hasVariants }
      }
      variants(first: $first) {
        edges {
          node {
            id
            title
            price
            compareAtPrice
            sku
            barcode
            position
            taxable
            inventoryPolicy
            inventoryQuantity
            selectedOptions { name value }
          }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
`;

const VARIANTS_BULK_CREATE_MUTATION = /* GraphQL */ `
  mutation VariantsBulkCreate(
    $productId: ID!
    $variants: [ProductVariantsBulkInput!]!
    $strategy: ProductVariantsBulkCreateStrategy
  ) {
    productVariantsBulkCreate(
      productId: $productId
      variants: $variants
      strategy: $strategy
    ) {
      productVariants {
        id
        title
        price
        sku
        selectedOptions { name value }
      }
      userErrors { field message }
    }
  }
`;

const VARIANTS_BULK_UPDATE_MUTATION = /* GraphQL */ `
  mutation VariantsBulkUpdate(
    $productId: ID!
    $variants: [ProductVariantsBulkInput!]!
  ) {
    productVariantsBulkUpdate(productId: $productId, variants: $variants) {
      productVariants {
        id
        title
        price
        compareAtPrice
        sku
        barcode
      }
      userErrors { field message }
    }
  }
`;

const VARIANTS_BULK_DELETE_MUTATION = /* GraphQL */ `
  mutation VariantsBulkDelete($productId: ID!, $variantsIds: [ID!]!) {
    productVariantsBulkDelete(productId: $productId, variantsIds: $variantsIds) {
      product { id }
      userErrors { field message }
    }
  }
`;

const VARIANTS_BULK_REORDER_MUTATION = /* GraphQL */ `
  mutation VariantsBulkReorder(
    $productId: ID!
    $positions: [ProductVariantPositionInput!]!
  ) {
    productVariantsBulkReorder(productId: $productId, positions: $positions) {
      userErrors { field message }
    }
  }
`;

const PRODUCT_OPTIONS_CREATE_MUTATION = /* GraphQL */ `
  mutation ProductOptionsCreate(
    $productId: ID!
    $options: [OptionCreateInput!]!
  ) {
    productOptionsCreate(productId: $productId, options: $options) {
      product {
        id
        options {
          id
          name
          position
          optionValues { id name }
        }
      }
      userErrors { field message }
    }
  }
`;

const optionValueInputSchema = z.object({
  optionName: z.string().describe("Name of the option (e.g. 'Size')."),
  name: z.string().describe("Value for that option (e.g. 'Medium')."),
});

const inventoryQuantityInputSchema = z.object({
  locationId: z.string().describe("Location GID ('gid://shopify/Location/123') where this stock lives. Get one from list_locations."),
  name: z
    .enum(["available", "on_hand"])
    .default("available")
    .describe("Which quantity field to set: 'available' (what customers can buy) or 'on_hand' (physically present). Default 'available'."),
  quantity: z.number().int().min(0).describe("Initial absolute stock count at this location (non-negative integer)."),
});

const variantCreateSchema = z.object({
  optionValues: z
    .array(optionValueInputSchema)
    .describe(
      "One entry per product option. Must cover EVERY option declared on the product (order-insensitive, matched by optionName).",
    ),
  price: z.string().describe("Variant price as a decimal string, e.g. '19.99'."),
  compareAtPrice: z
    .string()
    .optional()
    .describe("'Compare at' / was-price as a decimal string, e.g. '29.99', for strike-through pricing. Optional."),
  sku: z.string().optional().describe("Stock keeping unit identifier. Optional."),
  barcode: z.string().optional().describe("Barcode (ISBN, UPC, GTIN, etc.). Optional."),
  taxable: z.boolean().optional().describe("Whether tax is charged on this variant. Defaults to Shopify's default (true) when omitted."),
  inventoryPolicy: z
    .enum(["DENY", "CONTINUE"])
    .optional()
    .describe(
      "Oversell policy when stock hits 0: DENY blocks further sales, CONTINUE allows backorders. Optional.",
    ),
  inventoryQuantities: z
    .array(inventoryQuantityInputSchema)
    .optional()
    .describe(
      "Initial stock per location. Only accepted at create time — use set_inventory_quantity for subsequent changes. Optional.",
    ),
});

const variantUpdateSchema = z.object({
  id: z.string().describe("Variant GID to update ('gid://shopify/ProductVariant/123'). Required."),
  price: z.string().optional().describe("New price as a decimal string, e.g. '19.99'. Omit to leave unchanged."),
  compareAtPrice: z
    .string()
    .optional()
    .nullable()
    .describe("New 'compare at' price as a decimal string; pass null to clear it. Omit to leave unchanged."),
  sku: z.string().optional().describe("New SKU. Omit to leave unchanged."),
  barcode: z.string().optional().describe("New barcode. Omit to leave unchanged."),
  taxable: z.boolean().optional().describe("New taxable flag. Omit to leave unchanged."),
  inventoryPolicy: z
    .enum(["DENY", "CONTINUE"])
    .optional()
    .describe("New oversell policy: DENY blocks sales at 0 stock, CONTINUE allows backorders. Omit to leave unchanged."),
  optionValues: z
    .array(optionValueInputSchema)
    .optional()
    .describe("New option-value assignments (e.g. to rename a size). Omit to leave unchanged."),
});

const listVariantsSchema = {
  productId: z.string().describe("Product GID ('gid://shopify/Product/123') whose variants to list."),
  first: z
    .number()
    .int()
    .min(1)
    .max(100)
    .default(50)
    .describe("Page size — max variants to return (1-100). Default 50."),
};

const createVariantsSchema = {
  productId: z.string().describe("Product GID to add variants to ('gid://shopify/Product/123')."),
  variants: z
    .array(variantCreateSchema)
    .min(1)
    .max(100)
    .describe("Variants to create (1-100). Each variant's optionValues must cover all of the product's options."),
  strategy: z
    .enum(["DEFAULT", "REMOVE_STANDALONE_VARIANT"])
    .optional()
    .describe(
      "DEFAULT: add alongside existing variants. REMOVE_STANDALONE_VARIANT: also delete the auto-created 'Default Title' placeholder (use when adding the first real variants to a new product). Optional.",
    ),
};

const updateVariantsSchema = {
  productId: z.string().describe("Product GID owning the variants being updated."),
  variants: z
    .array(variantUpdateSchema)
    .min(1)
    .max(100)
    .describe("Variants to update (1-100), each identified by its variant GID. Only provided per-variant fields are written."),
};

const deleteVariantsSchema = {
  productId: z.string().describe("Product GID owning the variants to delete."),
  variantIds: z
    .array(z.string())
    .min(1)
    .max(100)
    .describe("Variant GIDs to delete (1-100). The product must retain at least one variant."),
};

const reorderVariantsSchema = {
  productId: z.string().describe("Product GID whose variants are being reordered."),
  positions: z
    .array(
      z.object({
        id: z.string().describe("Variant GID to move."),
        position: z.number().int().min(1).describe("New 1-indexed display position. Must be unique across the product's variants."),
      }),
    )
    .min(1)
    .describe("Variant GID → new position pairs. Only include variants whose position changes; positions must be unique."),
};

const addOptionSchema = {
  productId: z.string().describe("Product GID to add options to ('gid://shopify/Product/123')."),
  options: z
    .array(
      z.object({
        name: z.string().describe("Option name, e.g. 'Size' or 'Color'."),
        values: z
          .array(z.string())
          .min(1)
          .describe("Initial possible values for this option, e.g. ['S','M','L']."),
        position: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe("1-indexed display position of this option among the product's options. Optional."),
      }),
    )
    .min(1)
    .max(3)
    .describe("Options to add. A product can have at most 3 options total (Shopify limit)."),
};

function formatVariant(v: VariantNode): string {
  const opts =
    v.selectedOptions?.map((o) => `${o.name}=${o.value}`).join(", ") ??
    "(no options)";
  const sku = v.sku ? ` SKU:${v.sku}` : "";
  const cmp = v.compareAtPrice ? ` cmp:${v.compareAtPrice}` : "";
  const qty =
    v.inventoryQuantity !== null && v.inventoryQuantity !== undefined
      ? ` qty:${v.inventoryQuantity}`
      : "";
  return `  ${v.title} [${opts}] ${v.price}${cmp}${sku}${qty} — ${v.id}`;
}

export function registerVariantTools(
  server: McpServer,
  client: ShopifyClient,
): void {
  server.tool(
    "list_variants",
    "List up to `first` variants of a single product, plus the product's option definitions (Size, Color, etc.) and possible values. Read-only, no side effects (requires read_products scope). Returns a text summary: per variant title, GID, price, compareAtPrice, SKU, barcode, current inventory quantity, taxable flag, inventory policy, and the option-value combination. Returns 'Product not found' if the GID doesn't resolve. Use to inspect a product's full SKU matrix before calling create_variants/update_variants/delete_variants.",
    listVariantsSchema,
    async (args) => {
      const data = await client.graphql<{
        product:
          | {
              id: string;
              title: string;
              options: ProductOptionNode[];
              variants: {
                edges: Array<{ node: VariantNode }>;
                pageInfo: { hasNextPage: boolean };
              };
            }
          | null;
      }>(LIST_VARIANTS_QUERY, { productId: args.productId, first: args.first });
      if (!data.product) {
        return {
          content: [
            { type: "text" as const, text: `Product not found: ${args.productId}` },
          ],
        };
      }
      const p = data.product;
      const optionLines = p.options.map(
        (o) =>
          `  ${o.name} (#${o.position}): ${o.optionValues.map((v) => v.name).join(", ")}`,
      );
      const variantLines = p.variants.edges.map(({ node }) => formatVariant(node));
      return {
        content: [
          {
            type: "text" as const,
            text: [
              `${p.title} — ${p.id}`,
              "Options:",
              ...optionLines,
              `Variants (${p.variants.edges.length}):`,
              ...variantLines,
              p.variants.pageInfo.hasNextPage
                ? "(more variants available; raise `first` to page further)"
                : "",
            ]
              .filter(Boolean)
              .join("\n"),
          },
        ],
      };
    },
  );

  server.tool(
    "create_variants",
    "Create one or more variants (SKUs) on an existing product via the Shopify Admin API. Side effect: writes live store data (requires write_products scope); not reversible via this tool (use delete_variants to remove). Each variant's optionValues must cover EVERY option declared on the product — partial coverage is rejected. New products from create_product start with a single hidden 'Default Title' variant; when adding the first real variants, pass strategy='REMOVE_STANDALONE_VARIANT' so Shopify replaces the placeholder. inventoryQuantities seeds initial stock per location at create time; use set_inventory_quantity for ongoing changes. Returns a text summary of the created variants with their GIDs. Use update_variants to edit existing variants.",
    createVariantsSchema,
    async (args) => {
      const data = await client.graphql<{
        productVariantsBulkCreate: {
          productVariants: VariantNode[];
          userErrors: ShopifyUserError[];
        };
      }>(VARIANTS_BULK_CREATE_MUTATION, {
        productId: args.productId,
        variants: args.variants,
        strategy: args.strategy,
      });
      throwIfUserErrors(
        data.productVariantsBulkCreate.userErrors,
        "productVariantsBulkCreate",
      );
      const created = data.productVariantsBulkCreate.productVariants;
      return {
        content: [
          {
            type: "text" as const,
            text: [
              `Created ${created.length} variant(s):`,
              ...created.map((v) => formatVariant(v)),
            ].join("\n"),
          },
        ],
      };
    },
  );

  server.tool(
    "update_variants",
    "Update one or more existing variants in a single call via the Shopify Admin API. Side effect: mutates live store data immediately (requires write_products scope); price changes affect the storefront right away. Editable fields: price, compareAtPrice (set null to clear), SKU, barcode, taxable, inventoryPolicy, and optionValues. Per-variant; only the fields you provide are written. Inventory quantity is intentionally NOT editable here — use set_inventory_quantity to keep that audit trail in one place. Returns a text summary of the updated variants with their GIDs. Use create_variants to add new variants.",
    updateVariantsSchema,
    async (args) => {
      const data = await client.graphql<{
        productVariantsBulkUpdate: {
          productVariants: VariantNode[];
          userErrors: ShopifyUserError[];
        };
      }>(VARIANTS_BULK_UPDATE_MUTATION, {
        productId: args.productId,
        variants: args.variants,
      });
      throwIfUserErrors(
        data.productVariantsBulkUpdate.userErrors,
        "productVariantsBulkUpdate",
      );
      const updated = data.productVariantsBulkUpdate.productVariants;
      return {
        content: [
          {
            type: "text" as const,
            text: [
              `Updated ${updated.length} variant(s):`,
              ...updated.map(
                (v) =>
                  `  ${v.title} ${v.price}${v.compareAtPrice ? ` (cmp ${v.compareAtPrice})` : ""}${v.sku ? ` SKU:${v.sku}` : ""} — ${v.id}`,
              ),
            ].join("\n"),
          },
        ],
      };
    },
  );

  server.tool(
    "delete_variants",
    "Permanently delete one or more variants from a product. Irreversible. Each product must keep at least one variant — Shopify rejects requests that would empty the product (delete the whole product via update_product status:ARCHIVED, or use the admin UI for full deletion). Variants in completed orders are kept-but-hidden by Shopify automatically; the historical record on the order is preserved.",
    deleteVariantsSchema,
    async (args) => {
      const data = await client.graphql<{
        productVariantsBulkDelete: {
          product: { id: string } | null;
          userErrors: ShopifyUserError[];
        };
      }>(VARIANTS_BULK_DELETE_MUTATION, {
        productId: args.productId,
        variantsIds: args.variantIds,
      });
      throwIfUserErrors(
        data.productVariantsBulkDelete.userErrors,
        "productVariantsBulkDelete",
      );
      return {
        content: [
          {
            type: "text" as const,
            text: `Deleted ${args.variantIds.length} variant(s) from ${args.productId}.`,
          },
        ],
      };
    },
  );

  server.tool(
    "reorder_variants",
    "Set the display order of variants on a product. Positions are 1-indexed and must be unique across all variants in the product (you can't have two variants both at position 2). Affects the order variants appear on the product page and in Shopify admin. Only provide the variants whose positions are changing — others stay where they are.",
    reorderVariantsSchema,
    async (args) => {
      const data = await client.graphql<{
        productVariantsBulkReorder: {
          userErrors: ShopifyUserError[];
        };
      }>(VARIANTS_BULK_REORDER_MUTATION, {
        productId: args.productId,
        positions: args.positions,
      });
      throwIfUserErrors(
        data.productVariantsBulkReorder.userErrors,
        "productVariantsBulkReorder",
      );
      return {
        content: [
          {
            type: "text" as const,
            text: `Reordered ${args.positions.length} variant(s).`,
          },
        ],
      };
    },
  );

  server.tool(
    "add_product_options",
    "Add new options (like Size, Color, Material) to an existing product, along with their initial possible values. Shopify caps products at 3 options total — passing more is rejected. Adding an option creates new option-values that existing variants must be assigned to (Shopify auto-assigns the first value if not specified). After adding, use create_variants to add SKUs across the new option-value combinations. Cannot remove options via this tool — that requires re-creating the product.",
    addOptionSchema,
    async (args) => {
      const options = args.options.map((o) => ({
        name: o.name,
        position: o.position,
        values: o.values.map((v) => ({ name: v })),
      }));
      const data = await client.graphql<{
        productOptionsCreate: {
          product: { id: string; options: ProductOptionNode[] } | null;
          userErrors: ShopifyUserError[];
        };
      }>(PRODUCT_OPTIONS_CREATE_MUTATION, {
        productId: args.productId,
        options,
      });
      throwIfUserErrors(
        data.productOptionsCreate.userErrors,
        "productOptionsCreate",
      );
      const p = data.productOptionsCreate.product;
      if (!p) {
        return {
          content: [
            { type: "text" as const, text: "productOptionsCreate returned no product." },
          ],
        };
      }
      return {
        content: [
          {
            type: "text" as const,
            text: [
              `Added options to ${p.id}. Current options:`,
              ...p.options.map(
                (o) =>
                  `  ${o.name} (#${o.position}): ${o.optionValues.map((v) => v.name).join(", ")}`,
              ),
            ].join("\n"),
          },
        ],
      };
    },
  );
}
