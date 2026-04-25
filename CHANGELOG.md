# Changelog

All notable changes to shopify-mcp are documented here.

## 0.2.0 — 2026-04-25

### Added
- `--stdio` flag (and `MCP_TRANSPORT=stdio` env var) — speak MCP over stdio instead of HTTP, for use with stdio-first MCP clients (Claude Desktop, mcp-inspector). HTTP remains the default. Sample Claude Desktop config in the README.
- Six new tools to round out the order/customer lifecycle:
  - `create_order` — direct order creation, bypassing the draft flow (for imports, phone/in-person sales, custom-priced line items)
  - `update_order` — patch the order metadata Shopify allows post-creation (email, tags, note, custom attributes)
  - `cancel_order` — async cancellation with optional refund + restock
  - `refund_order` — partial refunds at line-item or shipping granularity, with restock-to-location handling
  - `create_customer` — record creation with addresses, tags, and email-marketing consent state
  - `update_customer` — profile edits (email, name, phone, tags, note)
- Glama "Card Badge" in the README, linking to the listing.
- Repository topics (`mcp`, `shopify`, `shopify-api`, `ecommerce`, `graphql`, `ai-tools`, ...).

### Changed
- Missing `SHOPIFY_STORE` / `SHOPIFY_ACCESS_TOKEN` no longer cause a fatal startup error — server now starts and registers tools, with a stderr warning. Tool calls still fail clearly at invocation time when credentials are absent. Lets the server work with stdio-first clients that supply credentials at MCP-client config time rather than via environment.

### Improved
- All tool descriptions rewritten to cover what each tool does, side effects, return shape, and when to reach for it vs. an alternative. Parameter descriptions cover shape, validation, and how to obtain GIDs. Targets glama.ai's per-tool quality rubric.

## 0.1.x — initial releases

Core Admin GraphQL surface: products, variants, collections, customers, orders, draft orders, fulfillment, inventory, metafields, metaobjects, webhooks, ShopifyQL analytics, and ComfyUI bridge tools (`generate_and_create_product`, `generate_product_image`, `refine_product_image`, `bulk_regenerate_images`).
