import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ShopifyClient } from "../shopify/client.js";
import { throwIfUserErrors } from "../shopify/client.js";
import type { Connection, ShopifyUserError } from "../shopify/types.js";

interface DraftOrder {
  id: string;
  name: string;
  status: string;
  invoiceUrl?: string | null;
  totalPriceSet: { shopMoney: { amount: string; currencyCode: string } };
  subtotalPriceSet?: { shopMoney: { amount: string; currencyCode: string } };
  customer?: { id: string; displayName?: string | null; email?: string | null } | null;
  lineItems?: {
    edges: Array<{
      node: {
        title: string;
        quantity: number;
        originalUnitPriceSet?: {
          shopMoney: { amount: string; currencyCode: string };
        };
        variant?: { id: string; sku?: string | null } | null;
      };
    }>;
  };
  createdAt: string;
  updatedAt: string;
  completedAt?: string | null;
  order?: { id: string; name: string } | null;
}

const LIST_DRAFT_ORDERS_QUERY = /* GraphQL */ `
  query ListDraftOrders($first: Int!, $after: String, $query: String) {
    draftOrders(first: $first, after: $after, query: $query, sortKey: UPDATED_AT, reverse: true) {
      edges {
        cursor
        node {
          id
          name
          status
          totalPriceSet { shopMoney { amount currencyCode } }
          customer { id displayName email }
          createdAt
          updatedAt
          completedAt
          order { id name }
        }
      }
      pageInfo { hasNextPage hasPreviousPage startCursor endCursor }
    }
  }
`;

const GET_DRAFT_ORDER_QUERY = /* GraphQL */ `
  query GetDraftOrder($id: ID!) {
    draftOrder(id: $id) {
      id
      name
      status
      invoiceUrl
      totalPriceSet { shopMoney { amount currencyCode } }
      subtotalPriceSet { shopMoney { amount currencyCode } }
      customer { id displayName email }
      lineItems(first: 50) {
        edges {
          node {
            title
            quantity
            originalUnitPriceSet { shopMoney { amount currencyCode } }
            variant { id sku }
          }
        }
      }
      createdAt
      updatedAt
      completedAt
      order { id name }
    }
  }
`;

const CREATE_DRAFT_ORDER_MUTATION = /* GraphQL */ `
  mutation DraftOrderCreate($input: DraftOrderInput!) {
    draftOrderCreate(input: $input) {
      draftOrder {
        id
        name
        status
        invoiceUrl
        totalPriceSet { shopMoney { amount currencyCode } }
      }
      userErrors { field message }
    }
  }
`;

const UPDATE_DRAFT_ORDER_MUTATION = /* GraphQL */ `
  mutation DraftOrderUpdate($id: ID!, $input: DraftOrderInput!) {
    draftOrderUpdate(id: $id, input: $input) {
      draftOrder {
        id
        name
        status
        totalPriceSet { shopMoney { amount currencyCode } }
      }
      userErrors { field message }
    }
  }
`;

const COMPLETE_DRAFT_ORDER_MUTATION = /* GraphQL */ `
  mutation DraftOrderComplete($id: ID!, $paymentPending: Boolean) {
    draftOrderComplete(id: $id, paymentPending: $paymentPending) {
      draftOrder {
        id
        name
        status
        order { id name }
      }
      userErrors { field message }
    }
  }
`;

const DELETE_DRAFT_ORDER_MUTATION = /* GraphQL */ `
  mutation DraftOrderDelete($input: DraftOrderDeleteInput!) {
    draftOrderDelete(input: $input) {
      deletedId
      userErrors { field message }
    }
  }
`;

const lineItemSchema = z
  .object({
    variantId: z
      .string()
      .optional()
      .describe("GID of a product variant. Omit for custom items."),
    quantity: z.number().int().min(1).default(1),
    title: z
      .string()
      .optional()
      .describe("Custom line-item title (required if variantId omitted)."),
    originalUnitPrice: z
      .string()
      .optional()
      .describe("Unit price as a decimal string, e.g. '19.99'. Required for custom items."),
  })
  .refine(
    (li) =>
      (li.variantId && !li.title && !li.originalUnitPrice) ||
      (!li.variantId && li.title && li.originalUnitPrice),
    {
      message:
        "Provide either variantId OR (title + originalUnitPrice) for a line item, not both.",
    },
  );

const listDraftOrdersSchema = {
  first: z.number().int().min(1).max(100).default(20),
  query: z
    .string()
    .optional()
    .describe("Shopify draft order query, e.g. 'status:OPEN', 'customer_id:123'."),
  after: z.string().optional(),
};

const getDraftOrderSchema = {
  id: z.string().describe("Draft order GID, e.g. gid://shopify/DraftOrder/12345"),
};

const createDraftOrderSchema = {
  lineItems: z
    .array(lineItemSchema)
    .min(1)
    .describe("At least one line item (variant reference or custom item)."),
  customerId: z.string().optional().describe("GID of an existing customer."),
  email: z.string().email().optional(),
  note: z.string().optional(),
  tags: z.array(z.string()).optional(),
  useCustomerDefaultAddress: z.boolean().optional(),
};

const updateDraftOrderSchema = {
  id: z.string().describe("Draft order GID to update."),
  lineItems: z.array(lineItemSchema).optional(),
  customerId: z.string().optional(),
  email: z.string().email().optional(),
  note: z.string().optional(),
  tags: z.array(z.string()).optional(),
};

const completeDraftOrderSchema = {
  id: z.string().describe("Draft order GID to complete."),
  paymentPending: z
    .boolean()
    .optional()
    .describe(
      "If true, complete without capturing payment (mark as pending). Default false.",
    ),
};

const deleteDraftOrderSchema = {
  id: z.string().describe("Draft order GID to delete."),
};

function mapLineItemsForInput(
  items: z.infer<typeof lineItemSchema>[] | undefined,
):
  | Array<{
      variantId?: string;
      quantity: number;
      title?: string;
      originalUnitPrice?: string;
    }>
  | undefined {
  if (!items) return undefined;
  return items.map((li) => {
    if (li.variantId) {
      return { variantId: li.variantId, quantity: li.quantity };
    }
    return {
      title: li.title!,
      quantity: li.quantity,
      originalUnitPrice: li.originalUnitPrice!,
    };
  });
}

export function registerDraftOrderTools(
  server: McpServer,
  client: ShopifyClient,
): void {
  server.tool(
    "list_draft_orders",
    "List draft orders (most recently updated first). Supports Shopify draft order query filtering.",
    listDraftOrdersSchema,
    async (args) => {
      const data = await client.graphql<{
        draftOrders: Connection<DraftOrder>;
      }>(LIST_DRAFT_ORDERS_QUERY, {
        first: args.first,
        after: args.after,
        query: args.query,
      });
      const lines = [
        `Found ${data.draftOrders.edges.length} draft order(s):`,
        ...data.draftOrders.edges.map(({ node }) => {
          const total = `${node.totalPriceSet.shopMoney.amount} ${node.totalPriceSet.shopMoney.currencyCode}`;
          const customer = node.customer?.displayName ?? "(no customer)";
          const completed = node.order
            ? ` → order ${node.order.name}`
            : "";
          return `  ${node.name} [${node.status}] ${total} — ${customer}${completed} — ${node.id}`;
        }),
      ];
      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    },
  );

  server.tool(
    "get_draft_order",
    "Fetch a single draft order with line items.",
    getDraftOrderSchema,
    async (args) => {
      const data = await client.graphql<{ draftOrder: DraftOrder | null }>(
        GET_DRAFT_ORDER_QUERY,
        { id: args.id },
      );
      if (!data.draftOrder) {
        return {
          content: [
            { type: "text" as const, text: `Draft order not found: ${args.id}` },
          ],
        };
      }
      const d = data.draftOrder;
      const total = `${d.totalPriceSet.shopMoney.amount} ${d.totalPriceSet.shopMoney.currencyCode}`;
      const customer = d.customer
        ? `${d.customer.displayName ?? ""} <${d.customer.email ?? ""}>`
        : "(no customer)";
      const lineItemLines =
        d.lineItems?.edges.map(({ node }) => {
          const price = node.originalUnitPriceSet
            ? `@ ${node.originalUnitPriceSet.shopMoney.amount} ${node.originalUnitPriceSet.shopMoney.currencyCode}`
            : "";
          return `    - ${node.quantity}× ${node.title} ${price}`.trim();
        }) ?? [];
      return {
        content: [
          {
            type: "text" as const,
            text: [
              `${d.name} [${d.status}]`,
              `  ID: ${d.id}`,
              `  Total: ${total}`,
              `  Customer: ${customer}`,
              d.invoiceUrl ? `  Invoice: ${d.invoiceUrl}` : "",
              d.order ? `  Completed as order: ${d.order.name} (${d.order.id})` : "",
              "  Line items:",
              ...lineItemLines,
            ]
              .filter(Boolean)
              .join("\n"),
          },
        ],
      };
    },
  );

  server.tool(
    "create_draft_order",
    "Create a new draft order. Each line item is either a variantId reference or a custom (title + originalUnitPrice) pair.",
    createDraftOrderSchema,
    async (args) => {
      const input: Record<string, unknown> = {
        lineItems: mapLineItemsForInput(args.lineItems),
      };
      if (args.customerId) input.customerId = args.customerId;
      if (args.email) input.email = args.email;
      if (args.note) input.note = args.note;
      if (args.tags) input.tags = args.tags;
      if (args.useCustomerDefaultAddress !== undefined) {
        input.useCustomerDefaultAddress = args.useCustomerDefaultAddress;
      }

      const data = await client.graphql<{
        draftOrderCreate: {
          draftOrder: DraftOrder | null;
          userErrors: ShopifyUserError[];
        };
      }>(CREATE_DRAFT_ORDER_MUTATION, { input });
      throwIfUserErrors(data.draftOrderCreate.userErrors, "draftOrderCreate");
      const d = data.draftOrderCreate.draftOrder;
      if (!d) {
        return {
          content: [
            { type: "text" as const, text: "draftOrderCreate returned no draft order." },
          ],
        };
      }
      const total = `${d.totalPriceSet.shopMoney.amount} ${d.totalPriceSet.shopMoney.currencyCode}`;
      return {
        content: [
          {
            type: "text" as const,
            text: [
              `Created draft order ${d.name} [${d.status}]`,
              `  ID: ${d.id}`,
              `  Total: ${total}`,
              d.invoiceUrl ? `  Invoice: ${d.invoiceUrl}` : "",
            ]
              .filter(Boolean)
              .join("\n"),
          },
        ],
      };
    },
  );

  server.tool(
    "update_draft_order",
    "Update an existing draft order. Replaces line items if provided.",
    updateDraftOrderSchema,
    async (args) => {
      const input: Record<string, unknown> = {};
      const mapped = mapLineItemsForInput(args.lineItems);
      if (mapped) input.lineItems = mapped;
      if (args.customerId) input.customerId = args.customerId;
      if (args.email) input.email = args.email;
      if (args.note) input.note = args.note;
      if (args.tags) input.tags = args.tags;

      const data = await client.graphql<{
        draftOrderUpdate: {
          draftOrder: DraftOrder | null;
          userErrors: ShopifyUserError[];
        };
      }>(UPDATE_DRAFT_ORDER_MUTATION, { id: args.id, input });
      throwIfUserErrors(data.draftOrderUpdate.userErrors, "draftOrderUpdate");
      const d = data.draftOrderUpdate.draftOrder;
      if (!d) {
        return {
          content: [
            { type: "text" as const, text: "draftOrderUpdate returned no draft order." },
          ],
        };
      }
      const total = `${d.totalPriceSet.shopMoney.amount} ${d.totalPriceSet.shopMoney.currencyCode}`;
      return {
        content: [
          {
            type: "text" as const,
            text: `Updated draft order ${d.name} [${d.status}] — Total: ${total}`,
          },
        ],
      };
    },
  );

  server.tool(
    "complete_draft_order",
    "Complete a draft order, converting it into a real order. Pass paymentPending=true to skip capture.",
    completeDraftOrderSchema,
    async (args) => {
      const data = await client.graphql<{
        draftOrderComplete: {
          draftOrder: DraftOrder | null;
          userErrors: ShopifyUserError[];
        };
      }>(COMPLETE_DRAFT_ORDER_MUTATION, {
        id: args.id,
        paymentPending: args.paymentPending ?? false,
      });
      throwIfUserErrors(data.draftOrderComplete.userErrors, "draftOrderComplete");
      const d = data.draftOrderComplete.draftOrder;
      if (!d) {
        return {
          content: [
            { type: "text" as const, text: "draftOrderComplete returned no draft order." },
          ],
        };
      }
      const orderInfo = d.order
        ? ` → order ${d.order.name} (${d.order.id})`
        : "";
      return {
        content: [
          {
            type: "text" as const,
            text: `Completed draft order ${d.name} [${d.status}]${orderInfo}`,
          },
        ],
      };
    },
  );

  server.tool(
    "delete_draft_order",
    "Delete a draft order by ID. Cannot delete completed draft orders.",
    deleteDraftOrderSchema,
    async (args) => {
      const data = await client.graphql<{
        draftOrderDelete: {
          deletedId: string | null;
          userErrors: ShopifyUserError[];
        };
      }>(DELETE_DRAFT_ORDER_MUTATION, { input: { id: args.id } });
      throwIfUserErrors(data.draftOrderDelete.userErrors, "draftOrderDelete");
      return {
        content: [
          {
            type: "text" as const,
            text: data.draftOrderDelete.deletedId
              ? `Deleted draft order ${data.draftOrderDelete.deletedId}.`
              : "No draft order matched; nothing deleted.",
          },
        ],
      };
    },
  );
}
