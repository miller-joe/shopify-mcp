import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ShopifyClient } from "../shopify/client.js";
import { throwIfUserErrors } from "../shopify/client.js";
import type { Connection, ShopifyUserError } from "../shopify/types.js";

interface WebhookEndpoint {
  __typename?: string;
  callbackUrl?: string | null;
  pubSubProject?: string | null;
  pubSubTopic?: string | null;
  arn?: string | null;
}

interface WebhookSubscriptionNode {
  id: string;
  topic: string;
  format: string;
  createdAt: string;
  updatedAt: string;
  includeFields?: string[] | null;
  metafieldNamespaces?: string[] | null;
  apiVersion: { handle: string };
  endpoint: WebhookEndpoint;
}

const LIST_WEBHOOKS_QUERY = /* GraphQL */ `
  query ListWebhooks($first: Int!, $after: String, $topics: [WebhookSubscriptionTopic!]) {
    webhookSubscriptions(first: $first, after: $after, topics: $topics) {
      edges {
        cursor
        node {
          id
          topic
          format
          createdAt
          updatedAt
          includeFields
          metafieldNamespaces
          apiVersion { handle }
          endpoint {
            __typename
            ... on WebhookHttpEndpoint { callbackUrl }
            ... on WebhookPubSubEndpoint { pubSubProject pubSubTopic }
            ... on WebhookEventBridgeEndpoint { arn }
          }
        }
      }
      pageInfo { hasNextPage hasPreviousPage startCursor endCursor }
    }
  }
`;

const GET_WEBHOOK_QUERY = /* GraphQL */ `
  query GetWebhook($id: ID!) {
    webhookSubscription(id: $id) {
      id
      topic
      format
      createdAt
      updatedAt
      includeFields
      metafieldNamespaces
      apiVersion { handle }
      endpoint {
        __typename
        ... on WebhookHttpEndpoint { callbackUrl }
        ... on WebhookPubSubEndpoint { pubSubProject pubSubTopic }
        ... on WebhookEventBridgeEndpoint { arn }
      }
    }
  }
`;

const WEBHOOK_CREATE_MUTATION = /* GraphQL */ `
  mutation WebhookCreate(
    $topic: WebhookSubscriptionTopic!
    $webhookSubscription: WebhookSubscriptionInput!
  ) {
    webhookSubscriptionCreate(
      topic: $topic
      webhookSubscription: $webhookSubscription
    ) {
      webhookSubscription {
        id
        topic
        format
        endpoint {
          __typename
          ... on WebhookHttpEndpoint { callbackUrl }
        }
      }
      userErrors { field message }
    }
  }
`;

const WEBHOOK_UPDATE_MUTATION = /* GraphQL */ `
  mutation WebhookUpdate($id: ID!, $webhookSubscription: WebhookSubscriptionInput!) {
    webhookSubscriptionUpdate(id: $id, webhookSubscription: $webhookSubscription) {
      webhookSubscription {
        id
        topic
        format
        endpoint {
          __typename
          ... on WebhookHttpEndpoint { callbackUrl }
        }
      }
      userErrors { field message }
    }
  }
`;

const WEBHOOK_DELETE_MUTATION = /* GraphQL */ `
  mutation WebhookDelete($id: ID!) {
    webhookSubscriptionDelete(id: $id) {
      deletedWebhookSubscriptionId
      userErrors { field message }
    }
  }
`;

const listWebhooksSchema = {
  first: z.number().int().min(1).max(100).default(20),
  topics: z
    .array(z.string())
    .optional()
    .describe(
      "Filter by WebhookSubscriptionTopic values, e.g. ['ORDERS_CREATE', 'PRODUCTS_UPDATE']. Use uppercase underscore form.",
    ),
  after: z.string().optional(),
};

const getWebhookSchema = {
  id: z.string().describe("Webhook subscription GID."),
};

const createWebhookSchema = {
  topic: z
    .string()
    .describe(
      "WebhookSubscriptionTopic, e.g. 'ORDERS_CREATE', 'ORDERS_PAID', 'PRODUCTS_UPDATE', 'INVENTORY_LEVELS_UPDATE', 'APP_UNINSTALLED'. See Shopify docs for full list.",
    ),
  callbackUrl: z
    .string()
    .url()
    .describe("HTTPS endpoint that will receive the webhook POSTs."),
  format: z.enum(["JSON", "XML"]).default("JSON"),
  includeFields: z
    .array(z.string())
    .optional()
    .describe(
      "Optional: only include these fields in the payload (reduces payload size).",
    ),
  metafieldNamespaces: z
    .array(z.string())
    .optional()
    .describe(
      "Optional: include metafields from these namespaces in the payload.",
    ),
};

const updateWebhookSchema = {
  id: z.string().describe("Webhook subscription GID to update."),
  callbackUrl: z.string().url().optional(),
  format: z.enum(["JSON", "XML"]).optional(),
  includeFields: z.array(z.string()).optional(),
  metafieldNamespaces: z.array(z.string()).optional(),
};

const deleteWebhookSchema = {
  id: z.string().describe("Webhook subscription GID to delete."),
};

function summarizeWebhook(w: WebhookSubscriptionNode): string {
  const target =
    w.endpoint.callbackUrl ??
    (w.endpoint.pubSubProject
      ? `pubsub ${w.endpoint.pubSubProject}/${w.endpoint.pubSubTopic}`
      : null) ??
    w.endpoint.arn ??
    "(unknown endpoint)";
  const filters: string[] = [];
  if (w.includeFields?.length) {
    filters.push(`fields: ${w.includeFields.join(",")}`);
  }
  if (w.metafieldNamespaces?.length) {
    filters.push(`metafields: ${w.metafieldNamespaces.join(",")}`);
  }
  const filterStr = filters.length ? ` (${filters.join("; ")})` : "";
  return `  ${w.topic} [${w.format}@${w.apiVersion.handle}] → ${target}${filterStr} — ${w.id}`;
}

export function registerWebhookTools(
  server: McpServer,
  client: ShopifyClient,
): void {
  server.tool(
    "list_webhooks",
    "List webhook subscriptions on the store. Each subscription wires a Shopify event topic (ORDERS_CREATE, PRODUCTS_UPDATE, INVENTORY_LEVELS_UPDATE, etc.) to a delivery target — typically an HTTPS callback URL, but Pub/Sub and EventBridge are also supported. Returns each subscription's topic, delivery format (JSON/XML), endpoint, API version, and any field/metafield filters applied. Filter by topic to scope the result. Use this to audit existing automation hooks before creating new ones.",
    listWebhooksSchema,
    async (args) => {
      const data = await client.graphql<{
        webhookSubscriptions: Connection<WebhookSubscriptionNode>;
      }>(LIST_WEBHOOKS_QUERY, {
        first: args.first,
        after: args.after,
        topics: args.topics,
      });
      const edges = data.webhookSubscriptions.edges;
      if (edges.length === 0) {
        return {
          content: [
            { type: "text" as const, text: "No webhook subscriptions." },
          ],
        };
      }
      return {
        content: [
          {
            type: "text" as const,
            text: [
              `Found ${edges.length} webhook subscription(s):`,
              ...edges.map(({ node }) => summarizeWebhook(node)),
            ].join("\n"),
          },
        ],
      };
    },
  );

  server.tool(
    "get_webhook",
    "Fetch a single webhook subscription's full configuration by GID — topic, endpoint, format, API version, includeFields filter, metafield namespaces, and timestamps. Use to verify subscription details before update or delete, or when debugging delivery issues.",
    getWebhookSchema,
    async (args) => {
      const data = await client.graphql<{
        webhookSubscription: WebhookSubscriptionNode | null;
      }>(GET_WEBHOOK_QUERY, { id: args.id });
      if (!data.webhookSubscription) {
        return {
          content: [
            { type: "text" as const, text: `Webhook not found: ${args.id}` },
          ],
        };
      }
      const w = data.webhookSubscription;
      return {
        content: [
          {
            type: "text" as const,
            text: [
              summarizeWebhook(w),
              `  Created: ${w.createdAt}`,
              `  Updated: ${w.updatedAt}`,
            ].join("\n"),
          },
        ],
      };
    },
  );

  server.tool(
    "create_webhook",
    "Subscribe to a Shopify event topic and have payloads POSTed to your HTTPS endpoint. Common topics: ORDERS_CREATE, ORDERS_PAID, ORDERS_FULFILLED, PRODUCTS_CREATE, PRODUCTS_UPDATE, INVENTORY_LEVELS_UPDATE, CUSTOMERS_CREATE, APP_UNINSTALLED. Use includeFields to receive only specific fields in the payload (reduces bandwidth and avoids leaking unrelated data). metafieldNamespaces opts in to including metafields from the listed namespaces. callbackUrl must be HTTPS in production. Returns the new subscription's GID; verify delivery is working with a few real events before relying on it.",
    createWebhookSchema,
    async (args) => {
      const webhookSubscription: Record<string, unknown> = {
        callbackUrl: args.callbackUrl,
        format: args.format,
      };
      if (args.includeFields) {
        webhookSubscription.includeFields = args.includeFields;
      }
      if (args.metafieldNamespaces) {
        webhookSubscription.metafieldNamespaces = args.metafieldNamespaces;
      }
      const data = await client.graphql<{
        webhookSubscriptionCreate: {
          webhookSubscription: WebhookSubscriptionNode | null;
          userErrors: ShopifyUserError[];
        };
      }>(WEBHOOK_CREATE_MUTATION, {
        topic: args.topic,
        webhookSubscription,
      });
      throwIfUserErrors(
        data.webhookSubscriptionCreate.userErrors,
        "webhookSubscriptionCreate",
      );
      const w = data.webhookSubscriptionCreate.webhookSubscription;
      if (!w) {
        return {
          content: [
            { type: "text" as const, text: "webhookSubscriptionCreate returned no subscription." },
          ],
        };
      }
      return {
        content: [
          {
            type: "text" as const,
            text: `Created webhook ${w.topic} → ${w.endpoint.callbackUrl ?? "(endpoint)"} — ${w.id}`,
          },
        ],
      };
    },
  );

  server.tool(
    "update_webhook",
    "Modify an existing webhook subscription's callback URL, payload format, includeFields filter, or metafield-namespace filter. Topic cannot be changed — to switch event types, delete and recreate the subscription. Use when migrating an endpoint to a new domain, switching from JSON to XML, or tightening payload size by adding includeFields. Omitted parameters are left unchanged.",
    updateWebhookSchema,
    async (args) => {
      const webhookSubscription: Record<string, unknown> = {};
      if (args.callbackUrl !== undefined) {
        webhookSubscription.callbackUrl = args.callbackUrl;
      }
      if (args.format !== undefined) webhookSubscription.format = args.format;
      if (args.includeFields !== undefined) {
        webhookSubscription.includeFields = args.includeFields;
      }
      if (args.metafieldNamespaces !== undefined) {
        webhookSubscription.metafieldNamespaces = args.metafieldNamespaces;
      }

      const data = await client.graphql<{
        webhookSubscriptionUpdate: {
          webhookSubscription: WebhookSubscriptionNode | null;
          userErrors: ShopifyUserError[];
        };
      }>(WEBHOOK_UPDATE_MUTATION, {
        id: args.id,
        webhookSubscription,
      });
      throwIfUserErrors(
        data.webhookSubscriptionUpdate.userErrors,
        "webhookSubscriptionUpdate",
      );
      const w = data.webhookSubscriptionUpdate.webhookSubscription;
      return {
        content: [
          {
            type: "text" as const,
            text: w
              ? `Updated webhook ${w.topic} → ${w.endpoint.callbackUrl ?? "(endpoint)"} — ${w.id}`
              : `Updated webhook ${args.id}.`,
          },
        ],
      };
    },
  );

  server.tool(
    "delete_webhook",
    "Permanently unsubscribe from an event topic by deleting the webhook subscription. Stops all future deliveries to that endpoint for that topic — irreversible (you'd have to re-create with create_webhook). Use when retiring an integration or switching topics. Returns the deleted GID, or a no-op message if nothing matched.",
    deleteWebhookSchema,
    async (args) => {
      const data = await client.graphql<{
        webhookSubscriptionDelete: {
          deletedWebhookSubscriptionId: string | null;
          userErrors: ShopifyUserError[];
        };
      }>(WEBHOOK_DELETE_MUTATION, { id: args.id });
      throwIfUserErrors(
        data.webhookSubscriptionDelete.userErrors,
        "webhookSubscriptionDelete",
      );
      return {
        content: [
          {
            type: "text" as const,
            text: data.webhookSubscriptionDelete.deletedWebhookSubscriptionId
              ? `Deleted webhook ${data.webhookSubscriptionDelete.deletedWebhookSubscriptionId}.`
              : "No webhook matched; nothing deleted.",
          },
        ],
      };
    },
  );
}
