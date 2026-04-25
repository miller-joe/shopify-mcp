import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ShopifyClient } from "../shopify/client.js";
import type { Connection, Order } from "../shopify/types.js";
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
}
