import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ShopifyClient } from "../shopify/client.js";
import { throwIfUserErrors } from "../shopify/client.js";
import type { ShopifyUserError } from "../shopify/types.js";

interface Metafield {
  id: string;
  namespace: string;
  key: string;
  type: string;
  value: string;
  description?: string | null;
  ownerType: string;
  createdAt: string;
  updatedAt: string;
}

const METAFIELDS_SET_MUTATION = /* GraphQL */ `
  mutation MetafieldsSet($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      metafields {
        id
        namespace
        key
        type
        value
        ownerType
        createdAt
        updatedAt
      }
      userErrors { field message code }
    }
  }
`;

const METAFIELD_DELETE_MUTATION = /* GraphQL */ `
  mutation MetafieldDelete($input: MetafieldIdentifierInput!) {
    metafieldDelete(input: $input) {
      deletedId
      userErrors { field message }
    }
  }
`;

const GET_METAFIELDS_QUERY = /* GraphQL */ `
  query GetMetafields($ownerId: ID!, $first: Int!, $namespace: String) {
    node(id: $ownerId) {
      ... on HasMetafields {
        metafields(first: $first, namespace: $namespace) {
          edges {
            node {
              id
              namespace
              key
              type
              value
              description
              createdAt
              updatedAt
            }
          }
          pageInfo { hasNextPage endCursor }
        }
      }
    }
  }
`;

const setMetafieldSchema = {
  ownerId: z
    .string()
    .describe(
      "GID of the resource to attach the metafield to (e.g. gid://shopify/Product/123, gid://shopify/Collection/456, gid://shopify/Customer/789, gid://shopify/Order/...)",
    ),
  namespace: z
    .string()
    .min(2)
    .max(255)
    .describe("Metafield namespace (2-255 chars). Convention: app-specific prefix."),
  key: z
    .string()
    .min(1)
    .max(64)
    .describe("Metafield key within the namespace (1-64 chars)."),
  type: z
    .string()
    .describe(
      "Metafield type: 'single_line_text_field', 'multi_line_text_field', 'number_integer', 'number_decimal', 'boolean', 'json', 'url', 'date', 'date_time', 'rating', 'color', 'weight', 'volume', 'dimension', 'money', 'rich_text_field', or reference types like 'product_reference', 'collection_reference', 'file_reference'.",
    ),
  value: z
    .string()
    .describe(
      "Metafield value, serialized per the type. JSON/reference types take a JSON string; primitives take the literal string.",
    ),
};

const listMetafieldsSchema = {
  ownerId: z.string().describe("GID of the resource to read metafields from."),
  namespace: z
    .string()
    .optional()
    .describe("Filter to a single namespace. Omit to return all."),
  first: z.number().int().min(1).max(100).default(50),
};

const deleteMetafieldSchema = {
  ownerId: z.string().describe("GID of the owning resource."),
  namespace: z.string().describe("Metafield namespace."),
  key: z.string().describe("Metafield key."),
};

export function registerMetafieldTools(
  server: McpServer,
  client: ShopifyClient,
): void {
  server.tool(
    "set_metafield",
    "Create or update (upsert) a single metafield on any supported Shopify resource — product, variant, collection, customer, order, draft order, shop, or shop policies. The (ownerId, namespace, key) triple is the unique identifier; calling this tool with an existing triple replaces the value, otherwise creates a new metafield. The `type` must be a Shopify-supported metafield type and the `value` must serialize per that type — e.g. JSON types take a JSON string, references take a target GID, primitives take literal text. Errors come back as MCP tool errors with the validation messages from Shopify.",
    setMetafieldSchema,
    async (args) => {
      const data = await client.graphql<{
        metafieldsSet: {
          metafields: Metafield[];
          userErrors: ShopifyUserError[];
        };
      }>(METAFIELDS_SET_MUTATION, {
        metafields: [
          {
            ownerId: args.ownerId,
            namespace: args.namespace,
            key: args.key,
            type: args.type,
            value: args.value,
          },
        ],
      });
      throwIfUserErrors(data.metafieldsSet.userErrors, "metafieldsSet");
      const mf = data.metafieldsSet.metafields[0];
      if (!mf) {
        return {
          content: [
            { type: "text" as const, text: "metafieldsSet returned no metafield." },
          ],
        };
      }
      return {
        content: [
          {
            type: "text" as const,
            text: [
              "Metafield saved:",
              `  ${mf.namespace}.${mf.key} (${mf.type})`,
              `  = ${mf.value}`,
              `  ID: ${mf.id}`,
              `  Owner: ${mf.ownerType}`,
            ].join("\n"),
          },
        ],
      };
    },
  );

  server.tool(
    "list_metafields",
    "List metafields attached to a single Shopify resource. Returns each metafield's namespace.key, type, current value, and optional description. Pass a `namespace` to scope the read to one app/integration's metafields (recommended when the resource has many). Empty result is normal for resources without metafields. Use this to inspect existing custom data before calling set_metafield, or to audit which apps have written what to a record.",
    listMetafieldsSchema,
    async (args) => {
      const data = await client.graphql<{
        node: {
          metafields?: {
            edges: Array<{ node: Metafield }>;
            pageInfo: { hasNextPage: boolean; endCursor?: string | null };
          };
        } | null;
      }>(GET_METAFIELDS_QUERY, {
        ownerId: args.ownerId,
        first: args.first,
        namespace: args.namespace,
      });
      if (!data.node) {
        return {
          content: [
            { type: "text" as const, text: `Owner not found: ${args.ownerId}` },
          ],
        };
      }
      const edges = data.node.metafields?.edges ?? [];
      if (edges.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: `No metafields on ${args.ownerId}${args.namespace ? ` (namespace=${args.namespace})` : ""}.`,
            },
          ],
        };
      }
      const lines = [
        `Found ${edges.length} metafield(s):`,
        ...edges.map(({ node }) => {
          const desc = node.description ? ` — ${node.description}` : "";
          return `  ${node.namespace}.${node.key} (${node.type}) = ${node.value}${desc}`;
        }),
      ];
      if (data.node.metafields?.pageInfo.hasNextPage) {
        lines.push("(more available; raise `first` to page further)");
      }
      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    },
  );

  server.tool(
    "delete_metafield",
    "Permanently delete a single metafield by (ownerId, namespace, key). Irreversible — the value is gone after this call. Use list_metafields first to confirm the namespace and key, since typos result in a no-op rather than an error. Other metafields on the same resource are unaffected. To delete every metafield on a resource, you'd need a list+loop pattern; this tool only deletes one at a time.",
    deleteMetafieldSchema,
    async (args) => {
      const data = await client.graphql<{
        metafieldDelete: {
          deletedId: string | null;
          userErrors: ShopifyUserError[];
        };
      }>(METAFIELD_DELETE_MUTATION, {
        input: {
          ownerId: args.ownerId,
          namespace: args.namespace,
          key: args.key,
        },
      });
      throwIfUserErrors(data.metafieldDelete.userErrors, "metafieldDelete");
      return {
        content: [
          {
            type: "text" as const,
            text: data.metafieldDelete.deletedId
              ? `Deleted metafield ${data.metafieldDelete.deletedId}.`
              : "No metafield matched; nothing deleted.",
          },
        ],
      };
    },
  );
}
