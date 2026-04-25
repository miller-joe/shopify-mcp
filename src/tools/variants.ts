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
  locationId: z.string().describe("Location GID."),
  name: z
    .enum(["available", "on_hand"])
    .default("available")
    .describe("Quantity name. 'available' is what customers can buy."),
  quantity: z.number().int().min(0),
});

const variantCreateSchema = z.object({
  optionValues: z
    .array(optionValueInputSchema)
    .describe(
      "One entry per product option. Shape must match the product's options (order-insensitive, matched by optionName).",
    ),
  price: z.string().describe("Variant price as decimal string, e.g. '19.99'."),
  compareAtPrice: z.string().optional(),
  sku: z.string().optional(),
  barcode: z.string().optional(),
  taxable: z.boolean().optional(),
  inventoryPolicy: z
    .enum(["DENY", "CONTINUE"])
    .optional()
    .describe(
      "Oversell policy: DENY blocks sales at 0 stock, CONTINUE allows backorder.",
    ),
  inventoryQuantities: z
    .array(inventoryQuantityInputSchema)
    .optional()
    .describe(
      "Initial stock per location. Only accepted on create — use set_inventory_quantity for subsequent updates.",
    ),
});

const variantUpdateSchema = z.object({
  id: z.string().describe("Variant GID to update."),
  price: z.string().optional(),
  compareAtPrice: z.string().optional().nullable(),
  sku: z.string().optional(),
  barcode: z.string().optional(),
  taxable: z.boolean().optional(),
  inventoryPolicy: z.enum(["DENY", "CONTINUE"]).optional(),
  optionValues: z.array(optionValueInputSchema).optional(),
});

const listVariantsSchema = {
  productId: z.string().describe("Product GID."),
  first: z.number().int().min(1).max(100).default(50),
};

const createVariantsSchema = {
  productId: z.string().describe("Product GID."),
  variants: z.array(variantCreateSchema).min(1).max(100),
  strategy: z
    .enum(["DEFAULT", "REMOVE_STANDALONE_VARIANT"])
    .optional()
    .describe(
      "DEFAULT: add to existing variants. REMOVE_STANDALONE_VARIANT: replace the auto-created 'Default Title' variant (use on first real variant create).",
    ),
};

const updateVariantsSchema = {
  productId: z.string().describe("Product GID."),
  variants: z.array(variantUpdateSchema).min(1).max(100),
};

const deleteVariantsSchema = {
  productId: z.string().describe("Product GID."),
  variantIds: z.array(z.string()).min(1).max(100),
};

const reorderVariantsSchema = {
  productId: z.string().describe("Product GID."),
  positions: z
    .array(
      z.object({
        id: z.string().describe("Variant GID."),
        position: z.number().int().min(1),
      }),
    )
    .min(1),
};

const addOptionSchema = {
  productId: z.string().describe("Product GID."),
  options: z
    .array(
      z.object({
        name: z.string().describe("Option name, e.g. 'Size' or 'Color'."),
        values: z
          .array(z.string())
          .min(1)
          .describe("Possible values for this option."),
        position: z.number().int().min(1).optional(),
      }),
    )
    .min(1)
    .max(3)
    .describe("Up to 3 options per product (Shopify limit)."),
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
    "List all variants of a single product, plus the product's option definitions (Size, Color, etc.) and possible values. For each variant returns: title, GID, price, compareAtPrice, SKU, barcode, current inventory quantity, taxable flag, inventory policy, and the option-value combination that produced it. Use to inspect a product's full SKU matrix before calling create_variants/update_variants/delete_variants.",
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
    "Create one or more variants on an existing product. Each variant's optionValues must cover EVERY option declared on the product (Size + Color + Material if there are 3 options) — partial coverage is rejected. New products from create_product start with a single hidden 'Default Title' variant; when adding the first real variants, pass strategy='REMOVE_STANDALONE_VARIANT' so Shopify replaces the placeholder rather than leaving it. inventoryQuantities seeds initial stock per location at create time; for ongoing changes use set_inventory_quantity instead.",
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
    "Update one or more existing variants in a single call. Editable fields: price, compareAtPrice (set to null to clear), SKU, barcode, taxable, inventoryPolicy (DENY blocks oversells, CONTINUE allows backorders), and optionValues (e.g. rename a size). Per-variant only; only the fields you provide are written. For inventory quantity changes use set_inventory_quantity — this tool deliberately doesn't accept quantities to keep that audit trail in one place.",
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
