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
  first: z.number().int().min(1).max(100).default(20),
  query: z
    .string()
    .optional()
    .describe("Shopify collection query, e.g. 'title:summer*', 'collection_type:smart'."),
  after: z.string().optional(),
};

const getCollectionSchema = {
  id: z.string().describe("Collection GID, e.g. gid://shopify/Collection/123"),
  productsFirst: z.number().int().min(0).max(100).default(20),
};

const createCollectionSchema = {
  title: z.string().min(1),
  description: z.string().optional(),
  handle: z.string().optional(),
  productIds: z
    .array(z.string())
    .optional()
    .describe("Product GIDs to seed into the (manual) collection."),
};

const updateCollectionSchema = {
  id: z.string().describe("Collection GID to update."),
  title: z.string().optional(),
  description: z.string().optional(),
  handle: z.string().optional(),
};

const deleteCollectionSchema = {
  id: z.string().describe("Collection GID to delete."),
};

const addProductsSchema = {
  collectionId: z.string(),
  productIds: z.array(z.string()).min(1),
};

const removeProductsSchema = {
  collectionId: z.string(),
  productIds: z.array(z.string()).min(1),
};

const tagsSchema = {
  id: z
    .string()
    .describe(
      "GID of a taggable resource (Product, Order, Customer, DraftOrder, Collection, ...).",
    ),
  tags: z.array(z.string()).min(1).describe("Tags to add or remove."),
};

export function registerCollectionTools(
  server: McpServer,
  client: ShopifyClient,
): void {
  server.tool(
    "list_collections",
    "List collections (most recently updated first). Supports Shopify collection query filtering.",
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
    "Fetch a single collection with its products.",
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
    "Create a manual collection. Optionally seed with productIds.",
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
    "Update a collection's title, description, or handle.",
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
    "Delete a collection by ID.",
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
    "Add one or more products to a manual collection. Runs as a background job on Shopify's side.",
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
    "Remove one or more products from a manual collection.",
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
    "Add tags to any taggable Shopify resource (Product, Order, Customer, DraftOrder, etc.).",
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
    "Remove tags from a taggable Shopify resource.",
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
