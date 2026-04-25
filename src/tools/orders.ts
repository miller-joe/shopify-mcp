import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ShopifyClient } from "../shopify/client.js";
import { throwIfUserErrors } from "../shopify/client.js";
import type { Connection, Order, ShopifyUserError } from "../shopify/types.js";
import { toGid } from "./products.js";

const LIST_ORDERS_QUERY = /* GraphQL */ `
  query ListOrders($first: Int!, $after: String, $query: String) {
    orders(first: $first, after: $after, query: $query, sortKey: CREATED_AT, reverse: true) {
      edges {
        cursor
        node {
          id
          name
          email
          displayFinancialStatus
          displayFulfillmentStatus
          totalPriceSet { shopMoney { amount currencyCode } }
          createdAt
        }
      }
      pageInfo { hasNextPage hasPreviousPage startCursor endCursor }
    }
  }
`;

const GET_ORDER_QUERY = /* GraphQL */ `
  query GetOrder($id: ID!) {
    order(id: $id) {
      id
      name
      email
      displayFinancialStatus
      displayFulfillmentStatus
      totalPriceSet { shopMoney { amount currencyCode } }
      createdAt
      lineItems(first: 50) {
        edges { node { title quantity } }
      }
    }
  }
`;

const ORDER_CREATE_MUTATION = /* GraphQL */ `
  mutation OrderCreate($order: OrderCreateOrderInput!, $options: OrderCreateOptionsInput) {
    orderCreate(order: $order, options: $options) {
      order {
        id
        name
        displayFinancialStatus
        totalPriceSet { shopMoney { amount currencyCode } }
      }
      userErrors { field message }
    }
  }
`;

const ORDER_UPDATE_MUTATION = /* GraphQL */ `
  mutation OrderUpdate($input: OrderInput!) {
    orderUpdate(input: $input) {
      order {
        id
        name
        email
        tags
        note
      }
      userErrors { field message }
    }
  }
`;

const ORDER_CANCEL_MUTATION = /* GraphQL */ `
  mutation OrderCancel(
    $orderId: ID!
    $reason: OrderCancelReason!
    $refund: Boolean!
    $restock: Boolean!
    $staffNote: String
    $notifyCustomer: Boolean
  ) {
    orderCancel(
      orderId: $orderId
      reason: $reason
      refund: $refund
      restock: $restock
      staffNote: $staffNote
      notifyCustomer: $notifyCustomer
    ) {
      job { id done }
      orderCancelUserErrors { field message code }
    }
  }
`;

const REFUND_CREATE_MUTATION = /* GraphQL */ `
  mutation RefundCreate($input: RefundInput!) {
    refundCreate(input: $input) {
      refund {
        id
        totalRefundedSet { shopMoney { amount currencyCode } }
        note
      }
      userErrors { field message }
    }
  }
`;

const listOrdersSchema = {
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
      "Shopify order query syntax. Common filters: 'financial_status:paid' (paid/pending/refunded/voided), 'fulfillment_status:unfulfilled' (unfulfilled/fulfilled/partial), 'status:open' (open/closed/cancelled), 'created_at:>=2026-01-01', 'tag:wholesale', 'name:#1001'. Combine with AND/OR/NOT.",
    ),
  after: z
    .string()
    .optional()
    .describe(
      "Cursor from a prior page's pageInfo for pagination. Omit on the first call.",
    ),
};

const getOrderSchema = {
  id: z
    .string()
    .describe(
      "Order GID ('gid://shopify/Order/123') or numeric ID — both forms accepted; numeric IDs are auto-promoted. Get one from list_orders.",
    ),
};

const orderLineItemSchema = z
  .object({
    variantId: z
      .string()
      .optional()
      .describe("Product variant GID. Omit for custom (non-catalog) line items."),
    quantity: z.number().int().min(1).default(1),
    title: z
      .string()
      .optional()
      .describe(
        "Custom line-item title. Required when variantId is omitted (custom item).",
      ),
    priceSet: z
      .object({
        shopMoney: z.object({
          amount: z.string(),
          currencyCode: z.string().describe("ISO currency code (USD, EUR, GBP, ...)"),
        }),
      })
      .optional()
      .describe(
        "Per-unit price for custom items. Required when variantId is omitted.",
      ),
  })
  .refine(
    (li) =>
      (li.variantId && !li.title && !li.priceSet) ||
      (!li.variantId && li.title && li.priceSet),
    {
      message:
        "Provide either variantId, OR (title + priceSet) for a custom item — not both.",
    },
  );

const createOrderSchema = {
  lineItems: z
    .array(orderLineItemSchema)
    .min(1)
    .describe(
      "At least one line item. Each is either a variant reference (variantId + quantity) or a custom item (title + priceSet + quantity). Use draft orders (create_draft_order → complete_draft_order) when you want Shopify to handle pricing/taxes automatically; use this tool when you need to create an order directly with explicit line-item pricing.",
    ),
  email: z
    .string()
    .email()
    .optional()
    .describe("Customer email for the order. Recommended even when customerId is set."),
  customerId: z
    .string()
    .optional()
    .describe(
      "GID of an existing customer to attach. Get one from list_customers. Optional.",
    ),
  tags: z.array(z.string()).optional().describe("Tags applied to the new order."),
  note: z
    .string()
    .optional()
    .describe("Internal staff-only note attached to the order."),
  financialStatus: z
    .enum(["AUTHORIZED", "PAID", "PARTIALLY_PAID", "PENDING", "REFUNDED", "VOIDED"])
    .optional()
    .describe(
      "Initial financial status to record. Defaults to PENDING if omitted. Use PAID when capturing payment outside Shopify (manual offline payment).",
    ),
  sendReceipt: z
    .boolean()
    .optional()
    .describe("Whether to email the customer a receipt for the new order."),
  inventoryBehaviour: z
    .enum(["BYPASS", "DECREMENT_IGNORING_POLICY", "DECREMENT_OBEYING_POLICY"])
    .optional()
    .describe(
      "How inventory is handled. BYPASS: don't touch inventory. DECREMENT_OBEYING_POLICY (default): decrement and respect each variant's oversell policy. DECREMENT_IGNORING_POLICY: decrement always, even past zero.",
    ),
};

const updateOrderSchema = {
  id: z
    .string()
    .describe(
      "Order GID or numeric ID to update. Most order fields are immutable post-creation; only the metadata fields below can be edited via this tool.",
    ),
  email: z
    .string()
    .email()
    .optional()
    .describe("New customer email. Pass to update or fix the contact email."),
  tags: z
    .array(z.string())
    .optional()
    .describe(
      "New tag set. REPLACES the existing tags entirely. Read current tags first if you want to merge rather than replace.",
    ),
  note: z
    .string()
    .optional()
    .describe("New internal staff note. Replaces any prior note."),
  customAttributes: z
    .array(z.object({ key: z.string(), value: z.string() }))
    .optional()
    .describe(
      "Custom attributes (cart attributes / order notes). Replaces the entire set if provided.",
    ),
};

const cancelOrderSchema = {
  id: z
    .string()
    .describe("Order GID or numeric ID to cancel. The order must not already be cancelled."),
  reason: z
    .enum(["CUSTOMER", "FRAUD", "INVENTORY", "DECLINED", "OTHER", "STAFF"])
    .describe(
      "Why the order is being cancelled. CUSTOMER (customer requested), FRAUD (suspected fraud), INVENTORY (out of stock), DECLINED (payment declined), STAFF (staff decision), OTHER.",
    ),
  refund: z
    .boolean()
    .default(true)
    .describe(
      "Whether to refund the customer's payment as part of cancellation. true = refund any captured payment in full; false = cancel without refunding (use for unpaid orders, or when you'll handle the refund separately).",
    ),
  restock: z
    .boolean()
    .default(true)
    .describe(
      "Whether to restock cancelled line items back to inventory. true = decrement inventory back; false = leave inventory as-is (use when items were physically lost/damaged).",
    ),
  staffNote: z
    .string()
    .optional()
    .describe("Internal note about the cancellation reason. Visible to staff only."),
  notifyCustomer: z
    .boolean()
    .optional()
    .describe("Send the customer a cancellation email. Default false."),
};

const refundLineItemSchema = z.object({
  lineItemId: z.string().describe("LineItem GID from the order."),
  quantity: z.number().int().min(1).describe("How many of this line item to refund."),
  restockType: z
    .enum(["NO_RESTOCK", "CANCEL", "RETURN"])
    .default("NO_RESTOCK")
    .describe(
      "How to handle inventory: NO_RESTOCK (don't restock), CANCEL (restock as if cancelled), RETURN (restock as a return).",
    ),
  locationId: z
    .string()
    .optional()
    .describe("Location GID to restock to (required when restockType is CANCEL or RETURN)."),
});

const refundOrderSchema = {
  id: z
    .string()
    .describe("Order GID or numeric ID to refund."),
  refundLineItems: z
    .array(refundLineItemSchema)
    .optional()
    .describe(
      "Specific line items to refund with quantities. Omit to do a refund without item-level breakdown (use for shipping-only or adjustment refunds).",
    ),
  shipping: z
    .object({
      fullRefund: z.boolean().optional(),
      amount: z.string().optional().describe("Specific shipping refund amount as decimal string."),
    })
    .optional()
    .describe(
      "Refund part or all of shipping. Pass {fullRefund: true} to refund everything paid in shipping; or {amount: '5.00'} for a specific amount.",
    ),
  currency: z
    .string()
    .optional()
    .describe(
      "ISO currency code. Required for multi-currency stores; defaults to the order's currency otherwise.",
    ),
  note: z.string().optional().describe("Internal note explaining the refund."),
  notify: z
    .boolean()
    .default(false)
    .describe("Email the customer a refund notification."),
};

export function registerOrderTools(
  server: McpServer,
  client: ShopifyClient,
): void {
  server.tool(
    "list_orders",
    "List orders in the store, newest first by creation date. Returns each order's name (e.g. '#1042'), total price (in shop currency), financial status (paid/pending/refunded), fulfillment status (fulfilled/unfulfilled/partial), and timestamp. Supports Shopify's order query syntax for filtering by status, date range, customer, tags, and more. Cursor-paginated; the last line shows the next cursor when more pages exist. Use this to find order GIDs before calling get_order or list_fulfillment_orders.",
    listOrdersSchema,
    async (args) => {
      const data = await client.graphql<{ orders: Connection<Order> }>(
        LIST_ORDERS_QUERY,
        { first: args.first, query: args.query, after: args.after },
      );
      const lines = [
        `Found ${data.orders.edges.length} order(s):`,
        ...data.orders.edges.map(({ node }) => {
          const amount = node.totalPriceSet.shopMoney;
          return `  ${node.name} — ${amount.amount} ${amount.currencyCode} — ${node.displayFinancialStatus ?? "?"}/${node.displayFulfillmentStatus ?? "?"} — ${node.createdAt}`;
        }),
        data.orders.pageInfo.hasNextPage
          ? `next cursor: ${data.orders.edges[data.orders.edges.length - 1]?.cursor}`
          : "(end of results)",
      ];
      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    },
  );

  server.tool(
    "get_order",
    "Fetch a single order's full record by GID or numeric ID — includes header fields (email, totals, both status flags, timestamps), full line items (title + quantity), and the customer email if on file. Returned as JSON for downstream tooling. Use list_orders to discover order IDs first. To inspect or act on shipments for this order, follow up with list_fulfillment_orders.",
    getOrderSchema,
    async (args) => {
      const data = await client.graphql<{ order: Order | null }>(
        GET_ORDER_QUERY,
        { id: toGid(args.id, "Order") },
      );
      if (!data.order) {
        return {
          content: [{ type: "text" as const, text: `Order not found: ${args.id}` }],
        };
      }
      return {
        content: [{ type: "text" as const, text: JSON.stringify(data.order, null, 2) }],
      };
    },
  );

  server.tool(
    "create_order",
    "Create a real Shopify order directly, bypassing the draft-order flow. Each line item is either a variant reference (variantId + quantity) or a custom item (title + priceSet + quantity). Use when you need to import historical orders, record a phone/in-person sale, or create an order without involving Shopify's checkout pricing engine. For interactive carts where Shopify should compute taxes/shipping/discounts, use create_draft_order then complete_draft_order instead. Defaults: PENDING financial status, customer not notified, inventory decremented respecting each variant's oversell policy.",
    createOrderSchema,
    async (args) => {
      const lineItems = args.lineItems.map((li) => {
        if (li.variantId) {
          return { variantId: li.variantId, quantity: li.quantity };
        }
        return {
          title: li.title!,
          quantity: li.quantity,
          priceSet: li.priceSet!,
        };
      });
      const order: Record<string, unknown> = { lineItems };
      if (args.email) order.email = args.email;
      if (args.customerId) order.customerId = args.customerId;
      if (args.tags) order.tags = args.tags;
      if (args.note) order.note = args.note;
      if (args.financialStatus) order.financialStatus = args.financialStatus;

      const options: Record<string, unknown> = {};
      if (args.sendReceipt !== undefined) options.sendReceipt = args.sendReceipt;
      if (args.inventoryBehaviour) options.inventoryBehaviour = args.inventoryBehaviour;

      const data = await client.graphql<{
        orderCreate: {
          order: Order | null;
          userErrors: ShopifyUserError[];
        };
      }>(ORDER_CREATE_MUTATION, {
        order,
        options: Object.keys(options).length > 0 ? options : undefined,
      });
      throwIfUserErrors(data.orderCreate.userErrors, "orderCreate");
      const o = data.orderCreate.order;
      if (!o) {
        return {
          content: [
            { type: "text" as const, text: "orderCreate returned no order." },
          ],
        };
      }
      const total = `${o.totalPriceSet.shopMoney.amount} ${o.totalPriceSet.shopMoney.currencyCode}`;
      return {
        content: [
          {
            type: "text" as const,
            text: [
              `Created order ${o.name} [${o.displayFinancialStatus ?? "?"}]`,
              `  ID: ${o.id}`,
              `  Total: ${total}`,
            ].join("\n"),
          },
        ],
      };
    },
  );

  server.tool(
    "update_order",
    "Update an existing order's metadata: email, tags, internal note, or custom attributes. Most order fields are immutable post-creation in Shopify (line items, totals, customer-of-record can't be changed via the Admin API after the fact) — for those, use refund_order or cancel_order to back out, then create a corrected order. Tags and customAttributes are full replacements: read the current values first if you want to merge rather than replace. Use when fixing a typo'd email, adding a fulfillment-team note, or attaching internal segmentation tags.",
    updateOrderSchema,
    async (args) => {
      const input: Record<string, unknown> = { id: toGid(args.id, "Order") };
      if (args.email !== undefined) input.email = args.email;
      if (args.tags !== undefined) input.tags = args.tags;
      if (args.note !== undefined) input.note = args.note;
      if (args.customAttributes !== undefined) {
        input.customAttributes = args.customAttributes;
      }

      const data = await client.graphql<{
        orderUpdate: {
          order: { id: string; name: string; email?: string | null; tags?: string[] | null; note?: string | null } | null;
          userErrors: ShopifyUserError[];
        };
      }>(ORDER_UPDATE_MUTATION, { input });
      throwIfUserErrors(data.orderUpdate.userErrors, "orderUpdate");
      const o = data.orderUpdate.order;
      if (!o) {
        return {
          content: [
            { type: "text" as const, text: "orderUpdate returned no order." },
          ],
        };
      }
      return {
        content: [
          {
            type: "text" as const,
            text: `Updated order ${o.name} — ${o.id}`,
          },
        ],
      };
    },
  );

  server.tool(
    "cancel_order",
    "Cancel a Shopify order. Triggers an async job (the response includes a jobId; cancellation finishes shortly after the call returns). Combine with `refund: true` to issue a full refund of any captured payment, or `refund: false` if the order is unpaid or you'll handle refunds separately via refund_order. `restock: true` restores cancelled line items back to inventory; set false if items were physically lost/damaged. `notifyCustomer: true` sends the cancellation email. Cannot cancel an already-cancelled order or one with active fulfillments still in flight (cancel those fulfillments first via cancel_fulfillment).",
    cancelOrderSchema,
    async (args) => {
      const data = await client.graphql<{
        orderCancel: {
          job: { id: string; done: boolean } | null;
          orderCancelUserErrors: ShopifyUserError[];
        };
      }>(ORDER_CANCEL_MUTATION, {
        orderId: toGid(args.id, "Order"),
        reason: args.reason,
        refund: args.refund,
        restock: args.restock,
        staffNote: args.staffNote,
        notifyCustomer: args.notifyCustomer,
      });
      throwIfUserErrors(data.orderCancel.orderCancelUserErrors, "orderCancel");
      const job = data.orderCancel.job;
      return {
        content: [
          {
            type: "text" as const,
            text: job
              ? `Queued cancellation of ${args.id} (reason: ${args.reason}). Job: ${job.id} (done=${job.done})`
              : `Cancelled ${args.id} (reason: ${args.reason}).`,
          },
        ],
      };
    },
  );

  server.tool(
    "refund_order",
    "Issue a refund against an order — for specific line items (with quantities and optional restock behaviour), for shipping, or both. Returns the new refund's GID and total amount refunded. To refund a full order use cancel_order with refund=true instead (one-step). Use this tool when refunding partially: just one item, just shipping, an adjustment without item breakdown, or a return that needs explicit restock-to-location handling. The `restockType` per line item controls inventory behaviour: NO_RESTOCK (default — the items aren't coming back), CANCEL (restock as if cancelled), RETURN (restock with a return record at the given locationId). Pass `notify: true` to email the customer.",
    refundOrderSchema,
    async (args) => {
      const input: Record<string, unknown> = {
        orderId: toGid(args.id, "Order"),
        notify: args.notify,
      };
      if (args.refundLineItems) {
        input.refundLineItems = args.refundLineItems.map((li) => ({
          lineItemId: li.lineItemId,
          quantity: li.quantity,
          restockType: li.restockType,
          locationId: li.locationId,
        }));
      }
      if (args.shipping) input.shipping = args.shipping;
      if (args.currency) input.currency = args.currency;
      if (args.note) input.note = args.note;

      const data = await client.graphql<{
        refundCreate: {
          refund: {
            id: string;
            totalRefundedSet: {
              shopMoney: { amount: string; currencyCode: string };
            };
            note?: string | null;
          } | null;
          userErrors: ShopifyUserError[];
        };
      }>(REFUND_CREATE_MUTATION, { input });
      throwIfUserErrors(data.refundCreate.userErrors, "refundCreate");
      const r = data.refundCreate.refund;
      if (!r) {
        return {
          content: [
            { type: "text" as const, text: "refundCreate returned no refund." },
          ],
        };
      }
      const total = `${r.totalRefundedSet.shopMoney.amount} ${r.totalRefundedSet.shopMoney.currencyCode}`;
      return {
        content: [
          {
            type: "text" as const,
            text: `Refunded ${total} on ${args.id} — refund ${r.id}`,
          },
        ],
      };
    },
  );
}
