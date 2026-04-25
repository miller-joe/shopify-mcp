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
  key: z
    .string()
    .describe(
      "Field key as declared in the metaobject definition (case-sensitive). Get the list of valid keys from list_metaobject_definitions.",
    ),
  value: z
    .string()
    .describe(
      "Field value, always serialized as a string. Primitive types take literal strings ('hello', '42', 'true'). JSON, list, and reference types take JSON-encoded strings (e.g. '\"gid://shopify/Product/123\"' for a product reference, '[1,2,3]' for a list).",
    ),
});

const listDefinitionsSchema = {
  first: z
    .number()
    .int()
    .min(1)
    .max(100)
    .default(25)
    .describe("Page size (1-100). 25 is usually plenty — most stores have <50 metaobject types total."),
  after: z
    .string()
    .optional()
    .describe("Cursor from a prior page's pageInfo. Omit on the first call."),
};

const listMetaobjectsSchema = {
  type: z
    .string()
    .describe(
      "Metaobject type handle (e.g. 'lookbook', 'product_feature', '$app:landing_page'). Get valid values from list_metaobject_definitions. Custom app namespaces use the '$app:' prefix.",
    ),
  first: z
    .number()
    .int()
    .min(1)
    .max(100)
    .default(25)
    .describe("Page size (1-100)."),
  after: z
    .string()
    .optional()
    .describe("Cursor from a prior page's pageInfo. Omit on the first call."),
};

const getMetaobjectSchema = {
  id: z
    .string()
    .describe(
      "Metaobject GID, e.g. 'gid://shopify/Metaobject/123456'. Discover GIDs via list_metaobjects.",
    ),
};

const createMetaobjectSchema = {
  type: z
    .string()
    .describe(
      "Type handle from a registered metaobject definition. The definition must already exist; this tool does not create new types/schemas.",
    ),
  handle: z
    .string()
    .optional()
    .describe(
      "Optional URL-safe handle. If the type has a 'displayName' field, Shopify generates a handle from it; otherwise pass one here.",
    ),
  fields: z
    .array(fieldInputSchema)
    .min(1)
    .describe(
      "Field values. Provide at least the required fields from the type's definition. Required fields without values cause a validation error.",
    ),
  status: z
    .enum(["ACTIVE", "DRAFT"])
    .optional()
    .describe(
      "Publish status. Only applies to types that declared the `publishable` capability — passing this for non-publishable types is silently ignored. ACTIVE = visible on storefront, DRAFT = hidden.",
    ),
};

const updateMetaobjectSchema = {
  id: z
    .string()
    .describe("GID of the metaobject to update."),
  handle: z
    .string()
    .optional()
    .describe(
      "New handle. Changes the storefront URL slug. Pair with redirectNewHandle=true to keep old links working.",
    ),
  fields: z
    .array(fieldInputSchema)
    .optional()
    .describe(
      "Field-level upserts: only the keys present here are written; other fields keep their current values. Pass empty string to clear a field.",
    ),
  status: z
    .enum(["ACTIVE", "DRAFT"])
    .optional()
    .describe(
      "New publishable status (only for publishable types). Omit to leave unchanged.",
    ),
  redirectNewHandle: z
    .boolean()
    .optional()
    .describe(
      "If true and `handle` is being changed, Shopify creates a 301 redirect from the old handle to the new one on the storefront.",
    ),
};

const deleteMetaobjectSchema = {
  id: z
    .string()
    .describe(
      "GID of the metaobject to delete. Irreversible; metafield references to this metaobject become broken (Shopify does not auto-clean referrers).",
    ),
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
    "List the metaobject definitions (custom types/schemas) registered on this Shopify store, with their field definitions. Each definition declares a `type` handle, a set of typed fields, and which fields are required. Use this tool to discover what custom data shapes the store supports before calling list_metaobjects (which queries instances of one type) or create_metaobject (which creates a new instance). Cursor-paginated.",
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
    "List instances of a single metaobject type — e.g. all 'lookbook' or 'product_feature' entries. Returns each metaobject's display name, handle, GID, and (when the type is publishable) ACTIVE/DRAFT status. The type handle comes from list_metaobject_definitions. Cursor-paginated; pass `after` to advance pages. To inspect an individual metaobject's full field values, follow up with get_metaobject.",
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
    "Fetch a single metaobject by GID and return its display name, handle, type, publishable status, and all of its field values. Field values longer than 120 characters are truncated in the rendered output (full values are still on the underlying record). Use list_metaobjects to discover GIDs first.",
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
    "Create a new metaobject (instance) of an existing type. The `type` must match a registered metaobject definition — call list_metaobject_definitions first if you're unsure. `fields` is an array of {key, value} pairs; values are always strings (JSON/reference fields take a JSON-encoded string, primitives take literal text). `handle` is optional; Shopify generates one from the displayName field if present. `status` only applies to types that have the `publishable` capability — passing it for non-publishable types is silently ignored. Returns the new metaobject's GID for use in subsequent set_metafield calls (e.g. linking the metaobject to a product via a metaobject_reference metafield).",
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
    "Update an existing metaobject's handle, field values, or publishable status. Fields are upserted by key — pass only the fields you want to change; omitted fields keep their current values. To clear a field, pass an empty string or null-ish value matching the field type. If you change the handle, set redirectNewHandle=true to have Shopify redirect from the old handle on the storefront. The `type` cannot be changed by this tool — delete and recreate to change type.",
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
    "Permanently delete a metaobject by GID. Irreversible. Any metafield references pointing at this metaobject will become broken — Shopify does NOT auto-clean references, you have to find and fix them. Use get_metaobject to confirm the right record before deleting. Returns the deleted GID, or a no-op message if nothing matched.",
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
