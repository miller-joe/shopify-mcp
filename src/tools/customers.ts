import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ShopifyClient } from "../shopify/client.js";
import type { Connection, Customer } from "../shopify/types.js";

const LIST_CUSTOMERS_QUERY = /* GraphQL */ `
  query ListCustomers($first: Int!, $after: String, $query: String) {
    customers(first: $first, after: $after, query: $query, sortKey: CREATED_AT, reverse: true) {
      edges {
        cursor
        node {
          id
          firstName
          lastName
          email
          displayName
          numberOfOrders
          amountSpent { amount currencyCode }
          createdAt
        }
      }
      pageInfo { hasNextPage hasPreviousPage startCursor endCursor }
    }
  }
`;

const listCustomersSchema = {
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
      "Shopify customer query syntax. Examples: 'email:*@gmail.com' (domain match), 'tag:vip' (tagged), 'orders_count:>=5' (repeat customer), 'amount_spent:>=500' (high value), 'state:enabled', 'accepts_marketing:true'. Combine with AND/OR.",
    ),
  after: z
    .string()
    .optional()
    .describe(
      "Cursor from the previous page's pageInfo for pagination. Omit on the first call.",
    ),
};

export function registerCustomerTools(
  server: McpServer,
  client: ShopifyClient,
): void {
  server.tool(
    "list_customers",
    "List customers in the store, newest first by creation date. Returns each customer's display name, email, lifetime order count, and total amount spent (in shop currency). Supports Shopify's customer query syntax for filtering by email, tag, order count, spend, marketing-consent, account state, and more. Cursor-paginated; pass `after` to advance pages. Use this to find customer GIDs before referencing them in draft orders or to segment for marketing.",
    listCustomersSchema,
    async (args) => {
      const data = await client.graphql<{ customers: Connection<Customer> }>(
        LIST_CUSTOMERS_QUERY,
        { first: args.first, query: args.query, after: args.after },
      );
      const lines = [
        `Found ${data.customers.edges.length} customer(s):`,
        ...data.customers.edges.map(({ node }) => {
          const name = node.displayName ?? "(no name)";
          const email = node.email ?? "(no email)";
          const orders = node.numberOfOrders ?? "0";
          const spent = node.amountSpent
            ? `${node.amountSpent.amount} ${node.amountSpent.currencyCode}`
            : "0";
          return `  ${name} <${email}> — ${orders} orders, ${spent} — ${node.id}`;
        }),
      ];
      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    },
  );
}
