import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ShopifyClient } from "../shopify/client.js";
import { throwIfUserErrors } from "../shopify/client.js";
import type { Connection, ShopifyUserError } from "../shopify/types.js";

interface Collection {
  id: string;
  handle: string;
  title: string;
  updatedAt: string;
  productsCount?: { count: number } | null;
  description?: string | null;
  sortOrder?: string | null;
  image?: { url: string; altText?: string | null } | null;
}

const LIST_COLLECTIONS_QUERY = /* GraphQL */ `
  query ListCollections($first: Int!, $after: String, $query: String) {
    collections(first: $first, after: $after, query: $query, sortKey: UPDATED_AT, reverse: true) {
      edges {
        cursor
        node {
          id
          handle
          title
          updatedAt
          productsCount { count }
        }
      }
      pageInfo { hasNextPage hasPreviousPage startCursor endCursor }
    }
  }
`;

const GET_COLLECTION_QUERY = /* GraphQL */ `
  query GetCollection($id: ID!, $productsFirst: Int!) {
    collection(id: $id) {
      id
      handle
      title
      description
      sortOrder
      updatedAt
      image { url altText }
      productsCount { count }
      products(first: $productsFirst) {
        edges {
          node {
            id
            title
            handle
            status
            featuredImage { url }
          }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
`;

const CREATE_COLLECTION_MUTATION = /* GraphQL */ `
  mutation CollectionCreate($input: CollectionInput!) {
    collectionCreate(input: $input) {
      collection {
        id
        handle
        title
      }
      userErrors { field message }
    }
  }
`;

const UPDATE_COLLECTION_MUTATION = /* GraphQL */ `
  mutation CollectionUpdate($input: CollectionInput!) {
    collectionUpdate(input: $input) {
      collection {
        id
        handle
        title
      }
      userErrors { field message }
    }
  }
`;

const DELETE_COLLECTION_MUTATION = /* GraphQL */ `
  mutation CollectionDelete($input: CollectionDeleteInput!) {
    collectionDelete(input: $input) {
      deletedCollectionId
      userErrors { field message }
    }
  }
`;

const ADD_PRODUCTS_MUTATION = /* GraphQL */ `
  mutation CollectionAddProducts($id: ID!, $productIds: [ID!]!) {
    collectionAddProductsV2(id: $id, productIds: $productIds) {
      job { id done }
      userErrors { field message }
    }
  }
`;

const REMOVE_PRODUCTS_MUTATION = /* GraphQL */ `
  mutation CollectionRemoveProducts($id: ID!, $productIds: [ID!]!) {
    collectionRemoveProducts(id: $id, productIds: $productIds) {
      job { id done }
      userErrors { field message }
    }
  }
`;

const TAGS_ADD_MUTATION = /* GraphQL */ `
  mutation TagsAdd($id: ID!, $tags: [String!]!) {
    tagsAdd(id: $id, tags: $tags) {
      node { id }
      userErrors { field message }
    }
  }
`;

const TAGS_REMOVE_MUTATION = /* GraphQL */ `
  mutation TagsRemove($id: ID!, $tags: [String!]!) {
    tagsRemove(id: $id, tags: $tags) {
      node { id }
      userErrors { field message }
    }
  }
`;

const listCollectionsSchema = {
  first: z
    .number()
    .int()
    .min(1)
    .max(100)
    .default(20)
    .describe("Page size (1-100). Lower this if responses get truncated."),
  query: z
    .string()
    .optional()
    .describe(
      "Shopify collection query syntax. Examples: 'title:summer*' (prefix match), 'collection_type:smart' (filter to smart collections), 'updated_at:>2026-01-01'.",
    ),
  after: z
    .string()
    .optional()
    .describe(
      "Cursor from a prior page's pageInfo. Pass to fetch the next page; omit on the first call.",
    ),
};

const getCollectionSchema = {
  id: z
    .string()
    .describe(
      "Collection GID, e.g. 'gid://shopify/Collection/123456'. Get one from list_collections.",
    ),
  productsFirst: z
    .number()
    .int()
    .min(0)
    .max(100)
    .default(20)
    .describe(
      "How many products to include alongside the collection. Pass 0 to skip products entirely (faster for collection-only metadata).",
    ),
};

const createCollectionSchema = {
  title: z
    .string()
    .min(1)
    .describe("Display title shown to shoppers. Required."),
  description: z
    .string()
    .optional()
    .describe(
      "HTML body for the collection page. Plain text works; HTML tags render.",
    ),
  handle: z
    .string()
    .optional()
    .describe(
      "URL slug (e.g. 'summer-sale'). Defaults to a slugified title. Must be unique per shop.",
    ),
  productIds: z
    .array(z.string())
    .optional()
    .describe(
      "Product GIDs to seed into the new (manual) collection. Smart collections built from rules aren't supported by this tool — use the Shopify admin UI for those.",
    ),
};

const updateCollectionSchema = {
  id: z
    .string()
    .describe("GID of the collection to update."),
  title: z.string().optional().describe("New display title. Omit to leave unchanged."),
  description: z
    .string()
    .optional()
    .describe(
      "New HTML body for the collection page. Pass an empty string to clear it.",
    ),
  handle: z
    .string()
    .optional()
    .describe(
      "New URL slug. Changing a handle breaks any external links pointing at the old URL — Shopify does NOT auto-redirect.",
    ),
};

const deleteCollectionSchema = {
  id: z
    .string()
    .describe(
      "GID of the collection to delete. The collection's products are NOT deleted, only the collection grouping. Irreversible.",
    ),
};

const addProductsSchema = {
  collectionId: z
    .string()
    .describe(
      "GID of a manual collection. Will fail on smart collections (those have rule-based membership).",
    ),
  productIds: z
    .array(z.string())
    .min(1)
    .describe("Product GIDs to add. Duplicates are silently ignored by Shopify."),
};

const removeProductsSchema = {
  collectionId: z
    .string()
    .describe("GID of a manual collection."),
  productIds: z
    .array(z.string())
    .min(1)
    .describe(
      "Product GIDs to remove. Products not currently in the collection are silently ignored.",
    ),
};

const tagsSchema = {
  id: z
    .string()
    .describe(
      "GID of any taggable resource — Product, Order, Customer, DraftOrder, Collection, Article, Blog. The tool name does the verb (add vs remove); pick the right tool for the operation.",
    ),
  tags: z
    .array(z.string())
    .min(1)
    .describe(
      "Tag strings to add (or remove). Shopify normalises whitespace and case for matching but preserves the literal strings on display.",
    ),
};

export function registerCollectionTools(
  server: McpServer,
  client: ShopifyClient,
): void {
  server.tool(
    "list_collections",
    "List collections in the store, most recently updated first. Returns each collection's title, handle, ID, and product count. Supports Shopify's collection query syntax for filtering by title, type, or update time. Cursor-paginated; pass `after` from the previous response to advance. Use this to find a collection's GID before calling get_collection, update_collection, or add_products_to_collection.",
    listCollectionsSchema,
    async (args) => {
      const data = await client.graphql<{
        collections: Connection<Collection>;
      }>(LIST_COLLECTIONS_QUERY, {
        first: args.first,
        after: args.after,
        query: args.query,
      });
      const lines = [
        `Found ${data.collections.edges.length} collection(s):`,
        ...data.collections.edges.map(({ node }) => {
          const count = node.productsCount?.count ?? "?";
          return `  ${node.title} (${count} products) — ${node.handle} — ${node.id}`;
        }),
      ];
      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    },
  );

  server.tool(
    "get_collection",
    "Fetch a single collection by GID with full details — title, handle, sort order, description, and the first N products inside it. Pass productsFirst=0 for metadata-only when you don't need the products array. Returns a friendly text view; pageInfo flags when more products exist beyond the requested page.",
    getCollectionSchema,
    async (args) => {
      const data = await client.graphql<{
        collection:
          | (Collection & {
              products: {
                edges: Array<{
                  node: {
                    id: string;
                    title: string;
                    handle: string;
                    status: string;
                    featuredImage?: { url: string } | null;
                  };
                }>;
                pageInfo: { hasNextPage: boolean };
              };
            })
          | null;
      }>(GET_COLLECTION_QUERY, {
        id: args.id,
        productsFirst: args.productsFirst,
      });
      if (!data.collection) {
        return {
          content: [
            { type: "text" as const, text: `Collection not found: ${args.id}` },
          ],
        };
      }
      const c = data.collection;
      const productLines = c.products.edges.map(
        ({ node }) => `    - ${node.title} [${node.status}] (${node.handle}) — ${node.id}`,
      );
      return {
        content: [
          {
            type: "text" as const,
            text: [
              `${c.title}`,
              `  ID: ${c.id}`,
              `  Handle: ${c.handle}`,
              `  Sort order: ${c.sortOrder ?? "(default)"}`,
              c.description ? `  Description: ${c.description}` : "",
              `  Products (${c.productsCount?.count ?? "?"}):`,
              ...productLines,
              c.products.pageInfo.hasNextPage
                ? "  (more products available; raise productsFirst to page further)"
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
    "create_collection",
    "Create a new manual collection (rule-based 'smart' collections aren't supported here — use the Shopify admin for those). Title is required; description, handle, and an initial product list are optional. Returns the new collection's GID, which you'll need for subsequent add_products_to_collection or update_collection calls. Side effect: collection becomes immediately visible in the storefront unless you've configured publication channels separately.",
    createCollectionSchema,
    async (args) => {
      const input: Record<string, unknown> = { title: args.title };
      if (args.description) input.descriptionHtml = args.description;
      if (args.handle) input.handle = args.handle;
      if (args.productIds) input.products = args.productIds;

      const data = await client.graphql<{
        collectionCreate: {
          collection: Collection | null;
          userErrors: ShopifyUserError[];
        };
      }>(CREATE_COLLECTION_MUTATION, { input });
      throwIfUserErrors(data.collectionCreate.userErrors, "collectionCreate");
      const c = data.collectionCreate.collection;
      if (!c) {
        return {
          content: [
            { type: "text" as const, text: "collectionCreate returned no collection." },
          ],
        };
      }
      return {
        content: [
          {
            type: "text" as const,
            text: `Created collection "${c.title}" — ${c.handle} — ${c.id}`,
          },
        ],
      };
    },
  );

  server.tool(
    "update_collection",
    "Update an existing collection's title, description (HTML), or URL handle. Only provide fields you want to change; omitted fields are left untouched. Changing the handle changes the storefront URL — Shopify does NOT create automatic redirects from the old slug, so existing links break. To change collection membership use add_products_to_collection / remove_products_from_collection instead.",
    updateCollectionSchema,
    async (args) => {
      const input: Record<string, unknown> = { id: args.id };
      if (args.title !== undefined) input.title = args.title;
      if (args.description !== undefined) input.descriptionHtml = args.description;
      if (args.handle !== undefined) input.handle = args.handle;

      const data = await client.graphql<{
        collectionUpdate: {
          collection: Collection | null;
          userErrors: ShopifyUserError[];
        };
      }>(UPDATE_COLLECTION_MUTATION, { input });
      throwIfUserErrors(data.collectionUpdate.userErrors, "collectionUpdate");
      const c = data.collectionUpdate.collection;
      if (!c) {
        return {
          content: [
            { type: "text" as const, text: "collectionUpdate returned no collection." },
          ],
        };
      }
      return {
        content: [
          {
            type: "text" as const,
            text: `Updated collection "${c.title}" — ${c.handle} — ${c.id}`,
          },
        ],
      };
    },
  );

  server.tool(
    "delete_collection",
    "Permanently delete a collection. Products inside it are NOT deleted — only the grouping is removed; products keep all their other associations (other collections, tags, inventory). Irreversible. Confirm the collection ID with get_collection before calling. Returns the deleted collection ID, or a 'nothing deleted' message if the GID didn't match anything.",
    deleteCollectionSchema,
    async (args) => {
      const data = await client.graphql<{
        collectionDelete: {
          deletedCollectionId: string | null;
          userErrors: ShopifyUserError[];
        };
      }>(DELETE_COLLECTION_MUTATION, { input: { id: args.id } });
      throwIfUserErrors(data.collectionDelete.userErrors, "collectionDelete");
      return {
        content: [
          {
            type: "text" as const,
            text: data.collectionDelete.deletedCollectionId
              ? `Deleted collection ${data.collectionDelete.deletedCollectionId}.`
              : "No collection matched; nothing deleted.",
          },
        ],
      };
    },
  );

  server.tool(
    "add_products_to_collection",
    "Add one or more products to a manual collection. Runs as an async background job on Shopify's side — the response includes a job ID and `done` flag, so very large batches may still be queued when the call returns. Smart collections (rule-based) reject manual additions; this tool only works on manual collections. Duplicates are silently ignored.",
    addProductsSchema,
    async (args) => {
      const data = await client.graphql<{
        collectionAddProductsV2: {
          job: { id: string; done: boolean } | null;
          userErrors: ShopifyUserError[];
        };
      }>(ADD_PRODUCTS_MUTATION, {
        id: args.collectionId,
        productIds: args.productIds,
      });
      throwIfUserErrors(
        data.collectionAddProductsV2.userErrors,
        "collectionAddProductsV2",
      );
      const job = data.collectionAddProductsV2.job;
      return {
        content: [
          {
            type: "text" as const,
            text: job
              ? `Queued add of ${args.productIds.length} product(s) to collection. Job: ${job.id} (done=${job.done})`
              : `Added ${args.productIds.length} product(s) to collection.`,
          },
        ],
      };
    },
  );

  server.tool(
    "remove_products_from_collection",
    "Remove one or more products from a manual collection. Like add_products_to_collection, this runs as an async job for larger batches — the response includes job ID and `done` status. Products not currently in the collection are silently skipped. Removes the membership only; products themselves are not deleted or modified.",
    removeProductsSchema,
    async (args) => {
      const data = await client.graphql<{
        collectionRemoveProducts: {
          job: { id: string; done: boolean } | null;
          userErrors: ShopifyUserError[];
        };
      }>(REMOVE_PRODUCTS_MUTATION, {
        id: args.collectionId,
        productIds: args.productIds,
      });
      throwIfUserErrors(
        data.collectionRemoveProducts.userErrors,
        "collectionRemoveProducts",
      );
      const job = data.collectionRemoveProducts.job;
      return {
        content: [
          {
            type: "text" as const,
            text: job
              ? `Queued removal of ${args.productIds.length} product(s) from collection. Job: ${job.id} (done=${job.done})`
              : `Removed ${args.productIds.length} product(s) from collection.`,
          },
        ],
      };
    },
  );

  server.tool(
    "add_tags",
    "Add tags to any taggable Shopify resource — Product, Order, Customer, DraftOrder, Collection, Article, Blog. Tags are stored as a unique set per resource; adding a tag that already exists is a no-op. Useful for ad-hoc segmentation, marketing campaigns, or driving smart collection membership rules. Pair with remove_tags to fully manage taxonomy.",
    tagsSchema,
    async (args) => {
      const data = await client.graphql<{
        tagsAdd: {
          node: { id: string } | null;
          userErrors: ShopifyUserError[];
        };
      }>(TAGS_ADD_MUTATION, { id: args.id, tags: args.tags });
      throwIfUserErrors(data.tagsAdd.userErrors, "tagsAdd");
      return {
        content: [
          {
            type: "text" as const,
            text: `Added tags [${args.tags.join(", ")}] to ${args.id}.`,
          },
        ],
      };
    },
  );

  server.tool(
    "remove_tags",
    "Remove tags from any taggable Shopify resource (Product, Order, Customer, DraftOrder, Collection, Article, Blog). Tags not currently on the resource are silently ignored. To replace the full tag set rather than remove specific ones, use update_product/update_customer/etc. with the new tag list.",
    tagsSchema,
    async (args) => {
      const data = await client.graphql<{
        tagsRemove: {
          node: { id: string } | null;
          userErrors: ShopifyUserError[];
        };
      }>(TAGS_REMOVE_MUTATION, { id: args.id, tags: args.tags });
      throwIfUserErrors(data.tagsRemove.userErrors, "tagsRemove");
      return {
        content: [
          {
            type: "text" as const,
            text: `Removed tags [${args.tags.join(", ")}] from ${args.id}.`,
          },
        ],
      };
    },
  );
}
