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
  first: z
    .number()
    .int()
    .min(1)
    .max(100)
    .default(20)
    .describe("Page size (1-100)."),
  query: z
    .string()
    .optional()
    .describe(
      "Shopify draft order query syntax. Examples: 'status:OPEN' (not yet completed), 'status:COMPLETED', 'customer_id:1234567890', 'tag:wholesale', 'updated_at:>=2026-01-01'.",
    ),
  after: z
    .string()
    .optional()
    .describe("Cursor from the previous page's pageInfo. Omit on the first call."),
};

const getDraftOrderSchema = {
  id: z
    .string()
    .describe(
      "Draft order GID, e.g. 'gid://shopify/DraftOrder/12345'. Get one from list_draft_orders.",
    ),
};

const createDraftOrderSchema = {
  lineItems: z
    .array(lineItemSchema)
    .min(1)
    .describe(
      "At least one line item. Each item is EITHER a variant reference (just variantId + quantity) OR a custom item (title + originalUnitPrice + quantity, no variantId). Mixing both shapes in one item is rejected by the refine() validator.",
    ),
  customerId: z
    .string()
    .optional()
    .describe(
      "GID of an existing customer to attach to the draft. Get one from list_customers. Optional — drafts can be customer-less and converted to a guest checkout.",
    ),
  email: z
    .string()
    .email()
    .optional()
    .describe(
      "Email address for the order. Useful when you don't have a customer record yet but want to email the invoice URL.",
    ),
  note: z
    .string()
    .optional()
    .describe("Internal note visible to staff only (not the customer)."),
  tags: z
    .array(z.string())
    .optional()
    .describe("Tags to apply to the draft for filtering/segmentation."),
  useCustomerDefaultAddress: z
    .boolean()
    .optional()
    .describe(
      "If true and customerId is set, copy the customer's default shipping address onto the draft.",
    ),
};

const updateDraftOrderSchema = {
  id: z
    .string()
    .describe(
      "GID of the draft order to update. Cannot update completed drafts (those are real orders — use the order tools).",
    ),
  lineItems: z
    .array(lineItemSchema)
    .optional()
    .describe(
      "If provided, REPLACES the entire current line-items array — this is a replace, not a merge. To add or remove specific items you must read the current items first and resubmit the full set.",
    ),
  customerId: z
    .string()
    .optional()
    .describe("New customer GID to attach. Pass to swap or set the customer."),
  email: z.string().email().optional().describe("New email for the order."),
  note: z.string().optional().describe("New internal note. Replaces any prior note."),
  tags: z
    .array(z.string())
    .optional()
    .describe("New tag set. Replaces existing tags entirely."),
};

const completeDraftOrderSchema = {
  id: z
    .string()
    .describe("GID of an OPEN draft order. Already-completed drafts are rejected."),
  paymentPending: z
    .boolean()
    .optional()
    .describe(
      "If true, the resulting order is marked payment-pending — Shopify creates the order but does NOT capture payment. Use when you'll collect payment offline (cash, bank transfer, manual card auth) or via a separate flow. Default false (attempts to capture immediately).",
    ),
};

const deleteDraftOrderSchema = {
  id: z
    .string()
    .describe(
      "GID of a draft order to delete. Permanent. Cannot delete drafts that have been completed (those are real orders — orders cannot be deleted, only cancelled or archived).",
    ),
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
    "List draft orders (carts/quotes that haven't yet been completed into real orders), most recently updated first. Returns each draft's name (e.g. 'D1023'), status (OPEN/COMPLETED/INVOICE_SENT), total price, customer name, and whether it's already been converted to an order. Supports Shopify's draft-order query syntax for filtering by status, customer, tag, or update time. Cursor-paginated.",
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
    "Fetch a single draft order with full details: status, customer, line items (with quantity, title, and unit price), invoice URL, and the resulting real order if it's already been completed. Use to inspect a draft before calling update_draft_order or complete_draft_order. Returns a friendly text summary.",
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
    "Create a new draft order — Shopify's term for an editable cart/quote not yet placed as an order. Each line item is EITHER a variant reference (variantId + quantity) for catalog products, OR a custom item (title + originalUnitPrice + quantity) for one-off charges or services not in the catalog. Optionally attach a customer, email, internal note, tags, and choose whether to copy the customer's default address. Returns the new draft's GID and an invoice URL the customer can use to pay. Drafts stay OPEN until you call complete_draft_order or send the invoice.",
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
    "Modify an existing OPEN draft order's customer, email, note, tags, or line items. Important: if `lineItems` is provided, it REPLACES the existing items entirely (not a merge or append) — read the current items first if you need to preserve any. Cannot update completed drafts; those are real orders. To pause and pick up a draft later, leave it OPEN and re-invoke update later; nothing here triggers payment.",
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
    "Convert an OPEN draft order into a real Shopify order. With paymentPending=false (default), Shopify attempts to capture payment immediately; the call fails if no payment method is on file. With paymentPending=true, the order is created in payment-pending status — useful when collecting payment offline (cash, bank transfer, manual processing). Once completed, the draft transitions to COMPLETED and the new order's GID is returned. The transition is one-way: completed drafts cannot be re-opened or edited via draft tools (use the order tools, or refund/cancel for the resulting order).",
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
    "Permanently delete a draft order. Only OPEN/INVOICE_SENT drafts can be deleted — completed drafts are real orders and orders cannot be deleted (cancel them instead). Irreversible. Returns the deleted GID, or a no-op message if the GID didn't match anything.",
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
