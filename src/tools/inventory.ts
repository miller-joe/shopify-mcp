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
  inventory_item_id: z.string().describe("Inventory item GID or numeric ID"),
  location_id: z.string().describe("Location GID or numeric ID"),
  quantity: z.number().int().min(0).describe("New absolute on-hand quantity"),
  reason: z
    .string()
    .default("correction")
    .describe(
      "Shopify reason code (e.g. 'correction', 'cycle_count_available', 'received')",
    ),
};

const listLocationsSchema = {
  first: z.number().int().min(1).max(100).default(20),
};

export function registerInventoryTools(
  server: McpServer,
  client: ShopifyClient,
): void {
  server.tool(
    "set_inventory_quantity",
    "Set the on-hand inventory quantity for an inventory item at a specific location. Use list_locations to find location IDs, and get_product to find inventory_item IDs from variants.",
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
    "List store locations (useful for finding location IDs to use with set_inventory_quantity).",
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
