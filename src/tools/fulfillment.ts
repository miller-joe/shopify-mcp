import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ShopifyClient } from "../shopify/client.js";
import { throwIfUserErrors } from "../shopify/client.js";
import type { ShopifyUserError } from "../shopify/types.js";

interface FulfillmentOrderLineItem {
  id: string;
  totalQuantity: number;
  remainingQuantity: number;
  lineItem: { id: string; title: string; sku?: string | null };
}

interface FulfillmentOrderNode {
  id: string;
  status: string;
  requestStatus: string;
  assignedLocation: {
    name: string;
    location?: { id: string } | null;
  };
  destination?: {
    address1?: string | null;
    city?: string | null;
    countryCode?: string | null;
    zip?: string | null;
  } | null;
  lineItems: {
    edges: Array<{ node: FulfillmentOrderLineItem }>;
    pageInfo: { hasNextPage: boolean };
  };
  createdAt: string;
}

interface TrackingInfo {
  company?: string | null;
  number?: string | null;
  url?: string | null;
}

interface FulfillmentNode {
  id: string;
  status: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  trackingInfo: TrackingInfo[];
  totalQuantity?: number | null;
  order?: { id: string; name: string } | null;
}

const LIST_FULFILLMENT_ORDERS_QUERY = /* GraphQL */ `
  query ListFulfillmentOrders($orderId: ID!) {
    order(id: $orderId) {
      id
      name
      fulfillmentOrders(first: 50) {
        edges {
          node {
            id
            status
            requestStatus
            assignedLocation { name location { id } }
            destination { address1 city countryCode zip }
            lineItems(first: 50) {
              edges {
                node {
                  id
                  totalQuantity
                  remainingQuantity
                  lineItem { id title sku }
                }
              }
              pageInfo { hasNextPage }
            }
            createdAt
          }
        }
      }
    }
  }
`;

const GET_FULFILLMENT_ORDER_QUERY = /* GraphQL */ `
  query GetFulfillmentOrder($id: ID!) {
    fulfillmentOrder(id: $id) {
      id
      status
      requestStatus
      assignedLocation { name location { id } }
      destination { address1 city countryCode zip }
      lineItems(first: 100) {
        edges {
          node {
            id
            totalQuantity
            remainingQuantity
            lineItem { id title sku }
          }
        }
        pageInfo { hasNextPage }
      }
      createdAt
    }
  }
`;

const GET_FULFILLMENT_QUERY = /* GraphQL */ `
  query GetFulfillment($id: ID!) {
    fulfillment(id: $id) {
      id
      status
      name
      createdAt
      updatedAt
      totalQuantity
      trackingInfo { company number url }
      order { id name }
    }
  }
`;

const FULFILLMENT_CREATE_MUTATION = /* GraphQL */ `
  mutation FulfillmentCreate($fulfillment: FulfillmentInput!) {
    fulfillmentCreate(fulfillment: $fulfillment) {
      fulfillment {
        id
        status
        name
        createdAt
        trackingInfo { company number url }
        order { id name }
      }
      userErrors { field message }
    }
  }
`;

const FULFILLMENT_TRACKING_UPDATE_MUTATION = /* GraphQL */ `
  mutation FulfillmentTrackingUpdate(
    $fulfillmentId: ID!
    $trackingInfoInput: FulfillmentTrackingInput!
    $notifyCustomer: Boolean
  ) {
    fulfillmentTrackingInfoUpdate(
      fulfillmentId: $fulfillmentId
      trackingInfoInput: $trackingInfoInput
      notifyCustomer: $notifyCustomer
    ) {
      fulfillment {
        id
        status
        trackingInfo { company number url }
      }
      userErrors { field message }
    }
  }
`;

const FULFILLMENT_CANCEL_MUTATION = /* GraphQL */ `
  mutation FulfillmentCancel($id: ID!) {
    fulfillmentCancel(id: $id) {
      fulfillment {
        id
        status
      }
      userErrors { field message }
    }
  }
`;

const lineItemByFulfillmentOrderSchema = z.object({
  fulfillmentOrderId: z.string().describe("FulfillmentOrder GID."),
  fulfillmentOrderLineItems: z
    .array(
      z.object({
        id: z.string().describe("FulfillmentOrderLineItem GID."),
        quantity: z.number().int().min(1),
      }),
    )
    .optional()
    .describe(
      "Per-line-item quantities. Omit to fulfill the entire fulfillment order.",
    ),
});

const trackingInfoSchema = z
  .object({
    company: z
      .string()
      .optional()
      .describe("Carrier name, e.g. 'USPS', 'UPS', 'FedEx', 'DHL'."),
    number: z.string().optional().describe("Tracking number."),
    url: z.string().url().optional().describe("Tracking URL."),
  })
  .describe("Tracking info. Company+number is enough; Shopify auto-derives URL for known carriers.");

const listFulfillmentOrdersSchema = {
  orderId: z
    .string()
    .describe("Order GID to list fulfillment orders for (e.g. gid://shopify/Order/123)."),
};

const getFulfillmentOrderSchema = {
  id: z.string().describe("FulfillmentOrder GID."),
};

const getFulfillmentSchema = {
  id: z.string().describe("Fulfillment GID."),
};

const createFulfillmentSchema = {
  lineItemsByFulfillmentOrder: z
    .array(lineItemByFulfillmentOrderSchema)
    .min(1)
    .describe("One entry per fulfillment order being fulfilled in this shipment."),
  trackingInfo: trackingInfoSchema.optional(),
  notifyCustomer: z
    .boolean()
    .optional()
    .describe("Send the customer a shipment notification email."),
};

const updateTrackingSchema = {
  fulfillmentId: z.string().describe("Fulfillment GID to update tracking on."),
  company: z.string().optional(),
  number: z.string().optional(),
  url: z.string().url().optional(),
  notifyCustomer: z.boolean().optional(),
};

const cancelFulfillmentSchema = {
  id: z.string().describe("Fulfillment GID to cancel."),
};

function summarizeFulfillmentOrder(fo: FulfillmentOrderNode): string[] {
  const lines: string[] = [
    `  ${fo.id} [${fo.status}/${fo.requestStatus}] at ${fo.assignedLocation.name}`,
  ];
  if (fo.destination) {
    const d = fo.destination;
    lines.push(
      `    ship to: ${[d.address1, d.city, d.zip, d.countryCode].filter(Boolean).join(", ") || "(no address)"}`,
    );
  }
  for (const edge of fo.lineItems.edges) {
    const li = edge.node;
    lines.push(
      `    - ${li.lineItem.title}${li.lineItem.sku ? ` (SKU ${li.lineItem.sku})` : ""} — ${li.remainingQuantity}/${li.totalQuantity} remaining — ${li.id}`,
    );
  }
  if (fo.lineItems.pageInfo.hasNextPage) {
    lines.push("    (more line items available)");
  }
  return lines;
}

export function registerFulfillmentTools(
  server: McpServer,
  client: ShopifyClient,
): void {
  server.tool(
    "list_fulfillment_orders",
    "List the fulfillment orders attached to a Shopify order. A fulfillment order groups line items by the location that will ship them — a single order can have multiple fulfillment orders if items split across warehouses. Each one tracks per-line remaining quantity (totalQuantity minus what's already shipped/cancelled). Returns the assigned location, destination address, and line-item progress for each. This is the primary read tool you'll call before create_fulfillment to figure out which fulfillmentOrderLineItem IDs and quantities to mark as shipped.",
    listFulfillmentOrdersSchema,
    async (args) => {
      const data = await client.graphql<{
        order:
          | {
              id: string;
              name: string;
              fulfillmentOrders: {
                edges: Array<{ node: FulfillmentOrderNode }>;
              };
            }
          | null;
      }>(LIST_FULFILLMENT_ORDERS_QUERY, { orderId: args.orderId });
      if (!data.order) {
        return {
          content: [
            { type: "text" as const, text: `Order not found: ${args.orderId}` },
          ],
        };
      }
      const fos = data.order.fulfillmentOrders.edges;
      if (fos.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Order ${data.order.name} has no fulfillment orders.`,
            },
          ],
        };
      }
      const lines: string[] = [
        `Order ${data.order.name} has ${fos.length} fulfillment order(s):`,
      ];
      for (const { node } of fos) {
        lines.push(...summarizeFulfillmentOrder(node));
      }
      return {
        content: [{ type: "text" as const, text: lines.join("\n") }],
      };
    },
  );

  server.tool(
    "get_fulfillment_order",
    "Fetch a single fulfillment order by GID with its full line-item set and remaining quantities. Use this when you have the FulfillmentOrder ID directly (e.g. from a webhook payload) and want detail without having to look up its parent order first. Returns the same shape as list_fulfillment_orders for one record.",
    getFulfillmentOrderSchema,
    async (args) => {
      const data = await client.graphql<{
        fulfillmentOrder: FulfillmentOrderNode | null;
      }>(GET_FULFILLMENT_ORDER_QUERY, { id: args.id });
      if (!data.fulfillmentOrder) {
        return {
          content: [
            { type: "text" as const, text: `Fulfillment order not found: ${args.id}` },
          ],
        };
      }
      return {
        content: [
          {
            type: "text" as const,
            text: summarizeFulfillmentOrder(data.fulfillmentOrder).join("\n"),
          },
        ],
      };
    },
  );

  server.tool(
    "get_fulfillment",
    "Fetch a single fulfillment (a shipment record produced by create_fulfillment) by GID. Returns its status (SUCCESS/CANCELLED/etc.), tracking entries (carrier, number, URL), the parent order, and timestamps. Use after create_fulfillment to confirm the shipment took, or when a webhook delivers a fulfillment GID and you need the details.",
    getFulfillmentSchema,
    async (args) => {
      const data = await client.graphql<{ fulfillment: FulfillmentNode | null }>(
        GET_FULFILLMENT_QUERY,
        { id: args.id },
      );
      if (!data.fulfillment) {
        return {
          content: [
            { type: "text" as const, text: `Fulfillment not found: ${args.id}` },
          ],
        };
      }
      const f = data.fulfillment;
      const tracking = f.trackingInfo
        .map((t) => {
          const parts = [t.company, t.number, t.url].filter(Boolean);
          return parts.length > 0 ? `    - ${parts.join(" | ")}` : "    - (empty)";
        })
        .join("\n");
      return {
        content: [
          {
            type: "text" as const,
            text: [
              `${f.name} [${f.status}]`,
              `  ID: ${f.id}`,
              f.order ? `  Order: ${f.order.name} (${f.order.id})` : "",
              f.totalQuantity !== null && f.totalQuantity !== undefined
                ? `  Total quantity: ${f.totalQuantity}`
                : "",
              "  Tracking:",
              tracking || "    (none)",
              `  Created: ${f.createdAt}`,
              `  Updated: ${f.updatedAt}`,
            ]
              .filter(Boolean)
              .join("\n"),
          },
        ],
      };
    },
  );

    server.tool(
    "create_fulfillment",
    "Mark items as shipped — creates a fulfillment record covering one or more fulfillment orders. For each fulfillment order in the request, you can either fulfill everything still remaining (omit `fulfillmentOrderLineItems`) or specify per-line {id, quantity} pairs for partial shipments. Optionally attach tracking info (carrier + number; URL is auto-derived for major carriers like USPS/UPS/FedEx/DHL) and set notifyCustomer=true to send the shipment-confirmation email. The fulfillmentOrderLineItem IDs come from list_fulfillment_orders. Side effects: customer-facing email if notifyCustomer is true; webhook fires; remaining quantities decrement.",
    createFulfillmentSchema,
    async (args) => {
      const fulfillment: Record<string, unknown> = {
        lineItemsByFulfillmentOrder: args.lineItemsByFulfillmentOrder,
      };
      if (args.trackingInfo) fulfillment.trackingInfo = args.trackingInfo;
      if (args.notifyCustomer !== undefined) {
        fulfillment.notifyCustomer = args.notifyCustomer;
      }

      const data = await client.graphql<{
        fulfillmentCreate: {
          fulfillment: FulfillmentNode | null;
          userErrors: ShopifyUserError[];
        };
      }>(FULFILLMENT_CREATE_MUTATION, { fulfillment });
      throwIfUserErrors(data.fulfillmentCreate.userErrors, "fulfillmentCreate");
      const f = data.fulfillmentCreate.fulfillment;
      if (!f) {
        return {
          content: [
            { type: "text" as const, text: "fulfillmentCreate returned no fulfillment." },
          ],
        };
      }
      const tracking = f.trackingInfo
        .map((t) => [t.company, t.number, t.url].filter(Boolean).join(" | "))
        .filter(Boolean)
        .join("; ");
      return {
        content: [
          {
            type: "text" as const,
            text: [
              `Created fulfillment ${f.name} [${f.status}] — ${f.id}`,
              f.order ? `  Order: ${f.order.name} (${f.order.id})` : "",
              tracking ? `  Tracking: ${tracking}` : "",
            ]
              .filter(Boolean)
              .join("\n"),
          },
        ],
      };
    },
  );

  server.tool(
    "update_fulfillment_tracking",
    "Update or add tracking info on an existing fulfillment after the fact. Use this when you've already called create_fulfillment but didn't have the carrier/tracking number yet, or when a tracking number was wrong and needs fixing. company+number is enough; Shopify auto-derives the URL for known carriers (USPS, UPS, FedEx, DHL, etc.). Set notifyCustomer=true to re-send the shipping email with the updated tracking. Omitted fields are left unchanged.",
    updateTrackingSchema,
    async (args) => {
      const trackingInfoInput: Record<string, unknown> = {};
      if (args.company !== undefined) trackingInfoInput.company = args.company;
      if (args.number !== undefined) trackingInfoInput.number = args.number;
      if (args.url !== undefined) trackingInfoInput.url = args.url;

      const data = await client.graphql<{
        fulfillmentTrackingInfoUpdate: {
          fulfillment: FulfillmentNode | null;
          userErrors: ShopifyUserError[];
        };
      }>(FULFILLMENT_TRACKING_UPDATE_MUTATION, {
        fulfillmentId: args.fulfillmentId,
        trackingInfoInput,
        notifyCustomer: args.notifyCustomer,
      });
      throwIfUserErrors(
        data.fulfillmentTrackingInfoUpdate.userErrors,
        "fulfillmentTrackingInfoUpdate",
      );
      const f = data.fulfillmentTrackingInfoUpdate.fulfillment;
      if (!f) {
        return {
          content: [
            { type: "text" as const, text: "fulfillmentTrackingInfoUpdate returned no fulfillment." },
          ],
        };
      }
      const tracking = f.trackingInfo
        .map((t) => [t.company, t.number, t.url].filter(Boolean).join(" | "))
        .filter(Boolean)
        .join("; ");
      return {
        content: [
          {
            type: "text" as const,
            text: `Updated tracking on ${f.id} [${f.status}]${tracking ? `: ${tracking}` : ""}.`,
          },
        ],
      };
    },
  );

  server.tool(
    "cancel_fulfillment",
    "Cancel an existing fulfillment — use when an item that was marked shipped won't actually ship (lost in warehouse, address bounced, customer cancelled). Restores remaining quantity on the underlying fulfillment order so the items can be re-fulfilled later. Does NOT issue a refund — combine with order-level refund tools if money needs to come back to the customer. Returns the new fulfillment status (typically CANCELLED).",
    cancelFulfillmentSchema,
    async (args) => {
      const data = await client.graphql<{
        fulfillmentCancel: {
          fulfillment: FulfillmentNode | null;
          userErrors: ShopifyUserError[];
        };
      }>(FULFILLMENT_CANCEL_MUTATION, { id: args.id });
      throwIfUserErrors(data.fulfillmentCancel.userErrors, "fulfillmentCancel");
      const f = data.fulfillmentCancel.fulfillment;
      return {
        content: [
          {
            type: "text" as const,
            text: f
              ? `Cancelled fulfillment ${f.id} — new status: ${f.status}`
              : `Cancelled fulfillment ${args.id}.`,
          },
        ],
      };
    },
  );
}
