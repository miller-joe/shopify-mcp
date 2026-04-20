import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ShopifyClient } from "../shopify/client.js";

interface TableDataColumn {
  name: string;
  displayName: string;
  dataType: string;
}

interface TableData {
  columns: TableDataColumn[];
  rowData: string[][];
  unformattedData?: string | null;
}

interface ParseError {
  code: string;
  message: string;
  range?: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  } | null;
}

interface ShopifyqlResponse {
  __typename?: string;
  tableData?: TableData | null;
  parseErrors?: ParseError[] | null;
}

const RUN_SHOPIFYQL_QUERY = /* GraphQL */ `
  query RunShopifyQL($query: String!) {
    shopifyqlQuery(query: $query) {
      __typename
      ... on TableResponse {
        tableData {
          columns { name displayName dataType }
          rowData
          unformattedData
        }
        parseErrors {
          code
          message
          range {
            start { line character }
            end { line character }
          }
        }
      }
    }
  }
`;

const runShopifyqlSchema = {
  query: z
    .string()
    .describe(
      "ShopifyQL query string. Example: 'FROM sales SHOW total_sales, gross_sales BY day SINCE -30d TIMESERIES'",
    ),
  raw: z
    .boolean()
    .default(false)
    .describe("Return the raw unformatted JSON payload instead of a rendered table."),
};

function renderTable(td: TableData): string {
  if (td.rowData.length === 0) {
    return "(no rows)";
  }
  const headers = td.columns.map((c) => c.displayName);
  const widths = headers.map((h, i) =>
    Math.max(
      h.length,
      ...td.rowData.map((row) => (row[i] ?? "").length),
    ),
  );
  const pad = (s: string, w: number) => s + " ".repeat(Math.max(0, w - s.length));
  const headerLine = headers.map((h, i) => pad(h, widths[i] ?? 0)).join(" | ");
  const sepLine = widths.map((w) => "-".repeat(w)).join("-+-");
  const bodyLines = td.rowData.map((row) =>
    row.map((cell, i) => pad(cell ?? "", widths[i] ?? 0)).join(" | "),
  );
  const typeLine = td.columns
    .map((c, i) => pad(`(${c.dataType})`, widths[i] ?? 0))
    .join(" | ");
  return [headerLine, typeLine, sepLine, ...bodyLines].join("\n");
}

export function registerAnalyticsTools(
  server: McpServer,
  client: ShopifyClient,
): void {
  server.tool(
    "run_shopifyql_query",
    "Run a ShopifyQL query against the store and return the result as a rendered ASCII table. ShopifyQL is Shopify's SQL-like analytics language. Examples: 'FROM sales SHOW total_sales BY day SINCE -30d TIMESERIES', 'FROM products SHOW product_title, quantity_sold BY product_id SINCE -7d ORDER BY quantity_sold DESC LIMIT 10'.",
    runShopifyqlSchema,
    async (args) => {
      const data = await client.graphql<{
        shopifyqlQuery: ShopifyqlResponse | null;
      }>(RUN_SHOPIFYQL_QUERY, { query: args.query });
      const resp = data.shopifyqlQuery;
      if (!resp) {
        return {
          content: [{ type: "text" as const, text: "ShopifyQL returned no response." }],
        };
      }
      if (resp.parseErrors && resp.parseErrors.length > 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: [
                "ShopifyQL parse errors:",
                ...resp.parseErrors.map(
                  (e) =>
                    `  [${e.code}] ${e.message}${e.range ? ` (line ${e.range.start.line}:${e.range.start.character})` : ""}`,
                ),
              ].join("\n"),
            },
          ],
        };
      }
      if (!resp.tableData) {
        return {
          content: [
            {
              type: "text" as const,
              text: `No table data returned (typename=${resp.__typename ?? "unknown"}).`,
            },
          ],
        };
      }
      if (args.raw) {
        return {
          content: [
            {
              type: "text" as const,
              text: resp.tableData.unformattedData ?? JSON.stringify(resp.tableData, null, 2),
            },
          ],
        };
      }
      return {
        content: [
          {
            type: "text" as const,
            text: [
              `Rows: ${resp.tableData.rowData.length}`,
              renderTable(resp.tableData),
            ].join("\n"),
          },
        ],
      };
    },
  );
}
