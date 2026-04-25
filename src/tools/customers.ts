import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ShopifyClient } from "../shopify/client.js";
import { throwIfUserErrors } from "../shopify/client.js";
import type { Connection, Customer, ShopifyUserError } from "../shopify/types.js";
import { toGid } from "./products.js";

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

const CUSTOMER_CREATE_MUTATION = /* GraphQL */ `
  mutation CustomerCreate($input: CustomerInput!) {
    customerCreate(input: $input) {
      customer {
        id
        displayName
        email
        firstName
        lastName
      }
      userErrors { field message }
    }
  }
`;

const CUSTOMER_UPDATE_MUTATION = /* GraphQL */ `
  mutation CustomerUpdate($input: CustomerInput!) {
    customerUpdate(input: $input) {
      customer {
        id
        displayName
        email
        firstName
        lastName
      }
      userErrors { field message }
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

const addressInputSchema = z.object({
  address1: z.string().optional(),
  address2: z.string().optional(),
  city: z.string().optional(),
  province: z.string().optional().describe("State/province name or code (e.g. 'CA' or 'California')."),
  country: z.string().optional().describe("Country name or 2-letter code (e.g. 'US', 'United States')."),
  zip: z.string().optional(),
  phone: z.string().optional(),
  firstName: z.string().optional(),
  lastName: z.string().optional(),
  company: z.string().optional(),
});

const createCustomerSchema = {
  email: z
    .string()
    .email()
    .optional()
    .describe(
      "Customer email. At minimum email or phone is required for the customer to be useful. Must be unique across the store.",
    ),
  firstName: z.string().optional(),
  lastName: z.string().optional(),
  phone: z
    .string()
    .optional()
    .describe(
      "Phone in E.164 format (+15551234567). Must be unique across the store.",
    ),
  tags: z
    .array(z.string())
    .optional()
    .describe(
      "Tags to apply to the new customer for segmentation/automation. Used by smart collections, marketing automations, and Flow triggers.",
    ),
  note: z.string().optional().describe("Internal staff-only note about the customer."),
  addresses: z
    .array(addressInputSchema)
    .optional()
    .describe(
      "Initial address(es). The first becomes the default shipping address; the rest are additional saved addresses. Customers can be created without addresses.",
    ),
  emailMarketingConsent: z
    .object({
      marketingState: z.enum(["NOT_SUBSCRIBED", "PENDING", "SUBSCRIBED", "UNSUBSCRIBED", "REDACTED", "INVALID"]),
      marketingOptInLevel: z.enum(["SINGLE_OPT_IN", "CONFIRMED_OPT_IN", "UNKNOWN"]).optional(),
    })
    .optional()
    .describe(
      "Email marketing consent state. Set marketingState=SUBSCRIBED only with documented customer opt-in. NOT_SUBSCRIBED is the default and the safe choice when in doubt.",
    ),
};

const updateCustomerSchema = {
  id: z
    .string()
    .describe("Customer GID or numeric ID. Get one from list_customers."),
  email: z.string().email().optional().describe("New email. Must remain unique."),
  firstName: z.string().optional(),
  lastName: z.string().optional(),
  phone: z.string().optional().describe("New phone in E.164 format."),
  tags: z
    .array(z.string())
    .optional()
    .describe(
      "New tag set. REPLACES all existing tags. Use add_tags / remove_tags for additive/subtractive changes that preserve other tags.",
    ),
  note: z.string().optional().describe("New internal staff note. Replaces prior note."),
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

  server.tool(
    "create_customer",
    "Create a new customer record. At minimum, supply email or phone (one is required for the customer to be reachable; both is fine). Email and phone must each be unique across the store — duplicates trigger validation errors. Optionally seed addresses (the first becomes the default shipping address), apply tags for segmentation, and set email-marketing consent. Default consent is NOT_SUBSCRIBED — only set SUBSCRIBED when you have documented opt-in (legal requirement in many jurisdictions). Returns the new customer's GID for use as customerId in create_order, create_draft_order, etc.",
    createCustomerSchema,
    async (args) => {
      const input: Record<string, unknown> = {};
      if (args.email) input.email = args.email;
      if (args.firstName) input.firstName = args.firstName;
      if (args.lastName) input.lastName = args.lastName;
      if (args.phone) input.phone = args.phone;
      if (args.tags) input.tags = args.tags;
      if (args.note) input.note = args.note;
      if (args.addresses) input.addresses = args.addresses;
      if (args.emailMarketingConsent) {
        input.emailMarketingConsent = args.emailMarketingConsent;
      }

      const data = await client.graphql<{
        customerCreate: {
          customer: Customer | null;
          userErrors: ShopifyUserError[];
        };
      }>(CUSTOMER_CREATE_MUTATION, { input });
      throwIfUserErrors(data.customerCreate.userErrors, "customerCreate");
      const c = data.customerCreate.customer;
      if (!c) {
        return {
          content: [
            { type: "text" as const, text: "customerCreate returned no customer." },
          ],
        };
      }
      return {
        content: [
          {
            type: "text" as const,
            text: `Created customer ${c.displayName ?? "(no name)"} <${c.email ?? "(no email)"}> — ${c.id}`,
          },
        ],
      };
    },
  );

  server.tool(
    "update_customer",
    "Update an existing customer's profile fields — email, name, phone, tags, internal note. Only provide fields you want changed; omitted fields stay as-is. Tags is a full replacement (use add_tags / remove_tags for additive/subtractive changes). Email and phone changes still need to satisfy the per-store uniqueness constraint. To change addresses, use Shopify's address-specific mutations (not yet exposed by this server). To change marketing consent, the dedicated customerEmailMarketingConsentUpdate mutation is preferred.",
    updateCustomerSchema,
    async (args) => {
      const input: Record<string, unknown> = { id: toGid(args.id, "Customer") };
      if (args.email !== undefined) input.email = args.email;
      if (args.firstName !== undefined) input.firstName = args.firstName;
      if (args.lastName !== undefined) input.lastName = args.lastName;
      if (args.phone !== undefined) input.phone = args.phone;
      if (args.tags !== undefined) input.tags = args.tags;
      if (args.note !== undefined) input.note = args.note;

      const data = await client.graphql<{
        customerUpdate: {
          customer: Customer | null;
          userErrors: ShopifyUserError[];
        };
      }>(CUSTOMER_UPDATE_MUTATION, { input });
      throwIfUserErrors(data.customerUpdate.userErrors, "customerUpdate");
      const c = data.customerUpdate.customer;
      if (!c) {
        return {
          content: [
            { type: "text" as const, text: "customerUpdate returned no customer." },
          ],
        };
      }
      return {
        content: [
          {
            type: "text" as const,
            text: `Updated customer ${c.displayName ?? "(no name)"} <${c.email ?? "(no email)"}> — ${c.id}`,
          },
        ],
      };
    },
  );
}
