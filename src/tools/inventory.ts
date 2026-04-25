import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ShopifyClient } from "../shopify/client.js";
import { throwIfUserErrors } from "../shopify/client.js";
import type { ShopifyUserError } from "../shopify/types.js";
import { toGid } from "./products.js";

const SET_INVENTORY_MUTATION = /* GraphQL */ `
  mutation InventorySetQuantities($input: InventorySetQuantitiesInput!) {
    inventorySetQuantities(input: $input) {
      inventoryAdjustmentGroup { id }
      userErrors { field message }
    }
  }
`;

const LIST_LOCATIONS_QUERY = /* GraphQL */ `
  query ListLocations($first: Int!) {
    locations(first: $first) {
      edges {
        node { id name isActive address { city countryCode } }
      }
    }
  }
`;

const setInventorySchema = {
  inventory_item_id: z
    .string()
    .describe(
      "InventoryItem GID ('gid://shopify/InventoryItem/123') or numeric ID. Found on each variant in get_product output as variants[].inventoryItem.id.",
    ),
  location_id: z
    .string()
    .describe(
      "Location GID or numeric ID. Get from list_locations. Each variant tracks inventory per location.",
    ),
  quantity: z
    .number()
    .int()
    .min(0)
    .describe(
      "New absolute available quantity. This OVERWRITES the current count, it doesn't increment — pass the desired final number, not a delta.",
    ),
  reason: z
    .string()
    .default("correction")
    .describe(
      "Shopify-defined reason code recorded in the inventory audit history. Common values: 'correction' (manual fix), 'cycle_count_available' (systematic recount), 'received' (receiving new stock), 'damaged', 'shrinkage', 'other'.",
    ),
};

const listLocationsSchema = {
  first: z
    .number()
    .int()
    .min(1)
    .max(100)
    .default(20)
    .describe("Page size (1-100). Most stores have under a dozen locations."),
};

export function registerInventoryTools(
  server: McpServer,
  client: ShopifyClient,
): void {
  server.tool(
    "set_inventory_quantity",
    "Set the absolute available inventory for one variant at one location. This is a direct overwrite, not an adjustment — passing 5 sets the count to 5 regardless of what was there before. The pair (inventory_item_id, location_id) uniquely identifies the inventory level: get inventory_item_id from get_product (it's on each variant) and location_id from list_locations. Records a Shopify inventory adjustment with the reason code you provide. Use 'correction' for cycle counts/manual fixes, 'received' when receiving stock, 'cycle_count_available' for systematic counts. Tracks history; the audit log shows who/when via the API user.",
    setInventorySchema,
    async (args) => {
      const data = await client.graphql<{
        inventorySetQuantities: {
          inventoryAdjustmentGroup: { id: string } | null;
          userErrors: ShopifyUserError[];
        };
      }>(SET_INVENTORY_MUTATION, {
        input: {
          reason: args.reason,
          name: "available",
          ignoreCompareQuantity: true,
          quantities: [
            {
              inventoryItemId: toGid(args.inventory_item_id, "InventoryItem"),
              locationId: toGid(args.location_id, "Location"),
              quantity: args.quantity,
            },
          ],
        },
      });
      throwIfUserErrors(
        data.inventorySetQuantities.userErrors,
        "inventorySetQuantities",
      );
      const groupId = data.inventorySetQuantities.inventoryAdjustmentGroup?.id;
      return {
        content: [
          {
            type: "text" as const,
            text: `Set inventory to ${args.quantity} (item: ${args.inventory_item_id}, location: ${args.location_id}, adjustment: ${groupId ?? "(no adjustment required)"})`,
          },
        ],
      };
    },
  );

  server.tool(
    "list_locations",
    "List the store's locations — physical or virtual places where inventory is stocked or fulfilled from (warehouses, retail stores, drop-ship partners). Returns each location's name, active/inactive flag, city + country, and GID. The location GID is required by set_inventory_quantity and create_fulfillment. Inactive locations still exist but cannot accept new inventory or fulfillments.",
    listLocationsSchema,
    async (args) => {
      const data = await client.graphql<{
        locations: {
          edges: Array<{
            node: {
              id: string;
              name: string;
              isActive: boolean;
              address?: { city?: string | null; countryCode?: string | null };
            };
          }>;
        };
      }>(LIST_LOCATIONS_QUERY, { first: args.first });
      const lines = [
        `Found ${data.locations.edges.length} location(s):`,
        ...data.locations.edges.map(({ node }) => {
          const city = node.address?.city ?? "?";
          const country = node.address?.countryCode ?? "?";
          const active = node.isActive ? "active" : "inactive";
          return `  ${node.name} (${active}) — ${city}, ${country} — ${node.id}`;
        }),
      ];
      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    },
  );
}
