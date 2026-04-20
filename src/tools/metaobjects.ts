import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ShopifyClient } from "../shopify/client.js";
import { throwIfUserErrors } from "../shopify/client.js";
import type { Connection, ShopifyUserError } from "../shopify/types.js";

interface MetaobjectField {
  key: string;
  type: string;
  value?: string | null;
  jsonValue?: unknown;
}

interface MetaobjectNode {
  id: string;
  type: string;
  handle: string;
  displayName?: string | null;
  updatedAt: string;
  capabilities?: {
    publishable?: { status: string } | null;
  } | null;
  fields: MetaobjectField[];
}

interface MetaobjectDefinitionNode {
  id: string;
  name: string;
  type: string;
  description?: string | null;
  metaobjectsCount?: number | null;
  fieldDefinitions: Array<{
    key: string;
    name: string;
    type: { name: string };
    required: boolean;
    description?: string | null;
  }>;
}

const LIST_METAOBJECT_DEFINITIONS_QUERY = /* GraphQL */ `
  query ListMetaobjectDefinitions($first: Int!, $after: String) {
    metaobjectDefinitions(first: $first, after: $after) {
      edges {
        cursor
        node {
          id
          name
          type
          description
          metaobjectsCount
          fieldDefinitions {
            key
            name
            type { name }
            required
            description
          }
        }
      }
      pageInfo { hasNextPage hasPreviousPage startCursor endCursor }
    }
  }
`;

const LIST_METAOBJECTS_QUERY = /* GraphQL */ `
  query ListMetaobjects($type: String!, $first: Int!, $after: String) {
    metaobjects(type: $type, first: $first, after: $after) {
      edges {
        cursor
        node {
          id
          type
          handle
          displayName
          updatedAt
          capabilities { publishable { status } }
          fields { key type value }
        }
      }
      pageInfo { hasNextPage hasPreviousPage startCursor endCursor }
    }
  }
`;

const GET_METAOBJECT_QUERY = /* GraphQL */ `
  query GetMetaobject($id: ID!) {
    metaobject(id: $id) {
      id
      type
      handle
      displayName
      updatedAt
      capabilities { publishable { status } }
      fields { key type value jsonValue }
    }
  }
`;

const METAOBJECT_CREATE_MUTATION = /* GraphQL */ `
  mutation MetaobjectCreate($metaobject: MetaobjectCreateInput!) {
    metaobjectCreate(metaobject: $metaobject) {
      metaobject {
        id
        type
        handle
        displayName
        fields { key type value }
        capabilities { publishable { status } }
      }
      userErrors { field message code }
    }
  }
`;

const METAOBJECT_UPDATE_MUTATION = /* GraphQL */ `
  mutation MetaobjectUpdate($id: ID!, $metaobject: MetaobjectUpdateInput!) {
    metaobjectUpdate(id: $id, metaobject: $metaobject) {
      metaobject {
        id
        type
        handle
        displayName
        fields { key type value }
        capabilities { publishable { status } }
      }
      userErrors { field message code }
    }
  }
`;

const METAOBJECT_DELETE_MUTATION = /* GraphQL */ `
  mutation MetaobjectDelete($id: ID!) {
    metaobjectDelete(id: $id) {
      deletedId
      userErrors { field message }
    }
  }
`;

const fieldInputSchema = z.object({
  key: z.string().describe("Field key as defined in the metaobject definition."),
  value: z
    .string()
    .describe(
      "Field value as a string. JSON/reference fields expect a JSON-encoded string.",
    ),
});

const listDefinitionsSchema = {
  first: z.number().int().min(1).max(100).default(25),
  after: z.string().optional(),
};

const listMetaobjectsSchema = {
  type: z
    .string()
    .describe(
      "Metaobject definition type (e.g. 'lookbook', 'product_feature'). Use list_metaobject_definitions to discover.",
    ),
  first: z.number().int().min(1).max(100).default(25),
  after: z.string().optional(),
};

const getMetaobjectSchema = {
  id: z.string().describe("Metaobject GID."),
};

const createMetaobjectSchema = {
  type: z.string().describe("Metaobject definition type."),
  handle: z
    .string()
    .optional()
    .describe("Optional handle. Shopify generates one from displayName if omitted."),
  fields: z.array(fieldInputSchema).min(1),
  status: z
    .enum(["ACTIVE", "DRAFT"])
    .optional()
    .describe(
      "Publishable status if the metaobject's type supports the publishable capability.",
    ),
};

const updateMetaobjectSchema = {
  id: z.string().describe("Metaobject GID to update."),
  handle: z.string().optional(),
  fields: z.array(fieldInputSchema).optional(),
  status: z.enum(["ACTIVE", "DRAFT"]).optional(),
  redirectNewHandle: z
    .boolean()
    .optional()
    .describe("If handle changes, redirect from the old handle to the new one."),
};

const deleteMetaobjectSchema = {
  id: z.string().describe("Metaobject GID to delete."),
};

function formatMetaobjectFields(fields: MetaobjectField[]): string[] {
  return fields.map((f) => {
    const val =
      f.value === null || f.value === undefined
        ? "(null)"
        : f.value.length > 120
          ? `${f.value.slice(0, 120)}…`
          : f.value;
    return `    ${f.key} (${f.type}): ${val}`;
  });
}

export function registerMetaobjectTools(
  server: McpServer,
  client: ShopifyClient,
): void {
  server.tool(
    "list_metaobject_definitions",
    "List metaobject definitions (schemas) on the store. Use to discover types before list_metaobjects or create_metaobject.",
    listDefinitionsSchema,
    async (args) => {
      const data = await client.graphql<{
        metaobjectDefinitions: Connection<MetaobjectDefinitionNode>;
      }>(LIST_METAOBJECT_DEFINITIONS_QUERY, {
        first: args.first,
        after: args.after,
      });
      const edges = data.metaobjectDefinitions.edges;
      if (edges.length === 0) {
        return {
          content: [
            { type: "text" as const, text: "No metaobject definitions on this store." },
          ],
        };
      }
      const rows: string[] = [`Found ${edges.length} definition(s):`];
      for (const { node } of edges) {
        rows.push(`  ${node.name} (${node.type}) — ${node.metaobjectsCount ?? "?"} objects — ${node.id}`);
        for (const f of node.fieldDefinitions) {
          const req = f.required ? "*" : "";
          rows.push(`    - ${f.key}${req}: ${f.type.name}`);
        }
      }
      return {
        content: [{ type: "text" as const, text: rows.join("\n") }],
      };
    },
  );

  server.tool(
    "list_metaobjects",
    "List metaobjects of a given type (from a metaobject definition).",
    listMetaobjectsSchema,
    async (args) => {
      const data = await client.graphql<{
        metaobjects: Connection<MetaobjectNode>;
      }>(LIST_METAOBJECTS_QUERY, {
        type: args.type,
        first: args.first,
        after: args.after,
      });
      const edges = data.metaobjects.edges;
      if (edges.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: `No metaobjects of type "${args.type}".`,
            },
          ],
        };
      }
      const rows: string[] = [
        `Found ${edges.length} metaobject(s) of type "${args.type}":`,
      ];
      for (const { node } of edges) {
        const status = node.capabilities?.publishable?.status;
        const label = node.displayName ?? node.handle;
        rows.push(`  ${label}${status ? ` [${status}]` : ""} — ${node.handle} — ${node.id}`);
      }
      return {
        content: [{ type: "text" as const, text: rows.join("\n") }],
      };
    },
  );

  server.tool(
    "get_metaobject",
    "Fetch a single metaobject by GID with all its fields.",
    getMetaobjectSchema,
    async (args) => {
      const data = await client.graphql<{
        metaobject: MetaobjectNode | null;
      }>(GET_METAOBJECT_QUERY, { id: args.id });
      if (!data.metaobject) {
        return {
          content: [
            { type: "text" as const, text: `Metaobject not found: ${args.id}` },
          ],
        };
      }
      const m = data.metaobject;
      const status = m.capabilities?.publishable?.status;
      return {
        content: [
          {
            type: "text" as const,
            text: [
              `${m.displayName ?? m.handle} (${m.type})${status ? ` [${status}]` : ""}`,
              `  ID: ${m.id}`,
              `  Handle: ${m.handle}`,
              `  Updated: ${m.updatedAt}`,
              "  Fields:",
              ...formatMetaobjectFields(m.fields),
            ].join("\n"),
          },
        ],
      };
    },
  );

  server.tool(
    "create_metaobject",
    "Create a metaobject of a given type. The type must already exist as a metaobject definition on the store.",
    createMetaobjectSchema,
    async (args) => {
      const metaobject: Record<string, unknown> = {
        type: args.type,
        fields: args.fields,
      };
      if (args.handle) metaobject.handle = args.handle;
      if (args.status) {
        metaobject.capabilities = {
          publishable: { status: args.status },
        };
      }

      const data = await client.graphql<{
        metaobjectCreate: {
          metaobject: MetaobjectNode | null;
          userErrors: ShopifyUserError[];
        };
      }>(METAOBJECT_CREATE_MUTATION, { metaobject });
      throwIfUserErrors(data.metaobjectCreate.userErrors, "metaobjectCreate");
      const m = data.metaobjectCreate.metaobject;
      if (!m) {
        return {
          content: [
            { type: "text" as const, text: "metaobjectCreate returned no metaobject." },
          ],
        };
      }
      return {
        content: [
          {
            type: "text" as const,
            text: `Created metaobject ${m.displayName ?? m.handle} (${m.type}) — ${m.id}`,
          },
        ],
      };
    },
  );

  server.tool(
    "update_metaobject",
    "Update a metaobject's handle, fields, or publishable status. Fields are upserted per key.",
    updateMetaobjectSchema,
    async (args) => {
      const metaobject: Record<string, unknown> = {};
      if (args.handle !== undefined) metaobject.handle = args.handle;
      if (args.fields) metaobject.fields = args.fields;
      if (args.redirectNewHandle !== undefined) {
        metaobject.redirectNewHandle = args.redirectNewHandle;
      }
      if (args.status) {
        metaobject.capabilities = {
          publishable: { status: args.status },
        };
      }
      const data = await client.graphql<{
        metaobjectUpdate: {
          metaobject: MetaobjectNode | null;
          userErrors: ShopifyUserError[];
        };
      }>(METAOBJECT_UPDATE_MUTATION, { id: args.id, metaobject });
      throwIfUserErrors(data.metaobjectUpdate.userErrors, "metaobjectUpdate");
      const m = data.metaobjectUpdate.metaobject;
      if (!m) {
        return {
          content: [
            { type: "text" as const, text: "metaobjectUpdate returned no metaobject." },
          ],
        };
      }
      return {
        content: [
          {
            type: "text" as const,
            text: `Updated metaobject ${m.displayName ?? m.handle} (${m.type}) — ${m.id}`,
          },
        ],
      };
    },
  );

  server.tool(
    "delete_metaobject",
    "Delete a metaobject by GID.",
    deleteMetaobjectSchema,
    async (args) => {
      const data = await client.graphql<{
        metaobjectDelete: {
          deletedId: string | null;
          userErrors: ShopifyUserError[];
        };
      }>(METAOBJECT_DELETE_MUTATION, { id: args.id });
      throwIfUserErrors(data.metaobjectDelete.userErrors, "metaobjectDelete");
      return {
        content: [
          {
            type: "text" as const,
            text: data.metaobjectDelete.deletedId
              ? `Deleted metaobject ${data.metaobjectDelete.deletedId}.`
              : "No metaobject matched; nothing deleted.",
          },
        ],
      };
    },
  );
}
