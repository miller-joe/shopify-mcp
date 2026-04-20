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
  first: z.number().int().min(1).max(100).default(20),
  query: z
    .string()
    .optional()
    .describe(
      "Shopify customer query, e.g. 'email:*@gmail.com', 'tag:vip', 'orders_count:>=5'",
    ),
  after: z.string().optional(),
};

export function registerCustomerTools(
  server: McpServer,
  client: ShopifyClient,
): void {
  server.tool(
    "list_customers",
    "List customers, newest first. Supports Shopify customer query filtering.",
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
