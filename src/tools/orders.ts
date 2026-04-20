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
  first: z.number().int().min(1).max(100).default(20),
  query: z
    .string()
    .optional()
    .describe(
      "Shopify order query, e.g. 'financial_status:paid', 'fulfillment_status:unfulfilled', 'created_at:>=2026-01-01'",
    ),
  after: z.string().optional(),
};

const getOrderSchema = {
  id: z.string().describe("Order GID or numeric ID"),
};

export function registerOrderTools(
  server: McpServer,
  client: ShopifyClient,
): void {
  server.tool(
    "list_orders",
    "List orders, newest first. Supports Shopify query filtering by status, date, customer, etc.",
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
    "Fetch a single order with line items by GID or numeric ID.",
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
