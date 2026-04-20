# shopify-mcp

MCP server for [Shopify](https://shopify.dev) — Admin API tooling plus **AI-driven product creation** via [ComfyUI](https://github.com/comfyanonymous/ComfyUI) image generation.

Part of the [MCP Server Series](https://github.com/miller-joe).

[![GitHub Sponsors](https://img.shields.io/github/sponsors/miller-joe?style=social&logo=github)](https://github.com/sponsors/miller-joe)
[![Ko-fi](https://img.shields.io/badge/Ko--fi-Support-ff5e5b?logo=kofi&logoColor=white)](https://ko-fi.com/indivisionjoe)

## The pitch

Every other Shopify MCP is a plain Admin API wrapper. This one *pairs with [@miller-joe/comfyui-mcp](https://github.com/miller-joe/comfyui-mcp)* so you can say things like:

> "Create a product called *'Nebula Dreamer'* — generate a cosmic abstract image for it, description matching the vibe, tagged astrology, status draft."

...and Claude runs ComfyUI → gets an image → creates the Shopify product → attaches the image, in one call.

## Install

```bash
# npx — no install
npx @miller-joe/shopify-mcp \
  --shopify-store your-store.myshopify.com \
  --shopify-access-token shpat_xxx

# Docker
docker run -p 9110:9110 \
  -e SHOPIFY_STORE=your-store.myshopify.com \
  -e SHOPIFY_ACCESS_TOKEN=shpat_xxx \
  -e COMFYUI_URL=http://comfyui:8188 \
  ghcr.io/miller-joe/shopify-mcp:latest
```

## Connect an MCP client

```bash
claude mcp add --transport http shopify http://localhost:9110/mcp
```

Or point your MCP gateway at the Streamable HTTP endpoint.

## Configuration

| CLI flag | Env var | Default | Notes |
|---|---|---|---|
| `--shopify-store` | `SHOPIFY_STORE` | *(required)* | `my-store` or `my-store.myshopify.com` |
| `--shopify-access-token` | `SHOPIFY_ACCESS_TOKEN` | *(required)* | Admin API token (`shpat_…`) |
| `--shopify-api-version` | `SHOPIFY_API_VERSION` | `2026-04` | GraphQL Admin API version |
| `--host` | `MCP_HOST` | `0.0.0.0` | Bind host |
| `--port` | `MCP_PORT` | `9110` | Bind port |
| `--comfyui-url` | `COMFYUI_URL` | *(optional)* | Enables bridge tools when set |
| `--comfyui-public-url` | `COMFYUI_PUBLIC_URL` | same as `--comfyui-url` | External URL used for image references passed to Shopify |
| — | `COMFYUI_DEFAULT_CKPT` | `sd_xl_base_1.0.safetensors` | Default checkpoint for bridge tools |

### Getting a Shopify access token

**Easy path (existing dev store):** Shopify Admin → Apps → *Develop apps* → Create custom app → enable relevant Admin API scopes (`write_products`, `read_orders`, `write_inventory`, `read_customers`) → install → copy the admin API access token (starts with `shpat_`).

**For new apps (post-Jan 2026):** legacy custom-app tokens are deprecated for freshly-created apps. Use the Dev Dashboard → token-exchange flow once to obtain a working token, then supply it here. Multi-tenant OAuth is on the roadmap (v0.2).

## Tools

### Core Admin

| Tool | Description |
|---|---|
| `list_products` | Paginated product search with Shopify query syntax |
| `get_product` | Fetch one product with variants, images, media |
| `create_product` | Create a product (default DRAFT); optionally attach images |
| `update_product` | Update title, description, tags, status, etc. |
| `upload_product_image` | Attach a public image URL to an existing product |
| `list_orders` | List orders, newest first, with query filters |
| `get_order` | Fetch one order with line items |
| `set_inventory_quantity` | Set absolute on-hand inventory at a location |
| `list_locations` | List store locations (for inventory ops) |
| `list_customers` | List customers with query filters |

### Metafields

| Tool | Description |
|---|---|
| `set_metafield` | Upsert a metafield on any `HasMetafields` resource (product, variant, collection, customer, order, shop, …) |
| `list_metafields` | List metafields for a resource, optionally filtered by namespace |
| `delete_metafield` | Delete a metafield by (ownerId, namespace, key) |

### Draft orders

| Tool | Description |
|---|---|
| `list_draft_orders` | List draft orders with Shopify query filters |
| `get_draft_order` | Fetch one draft order with its line items |
| `create_draft_order` | Create a draft order; line items can be variant refs or custom (title + price) |
| `update_draft_order` | Update customer, line items, tags, note, email |
| `complete_draft_order` | Convert a draft order to a real order; `paymentPending` skips capture |
| `delete_draft_order` | Delete a non-completed draft order |

### Fulfillment

| Tool | Description |
|---|---|
| `list_fulfillment_orders` | List an order's fulfillment orders (one per shipping location), with remaining quantities per line item |
| `get_fulfillment_order` | Fetch a single fulfillment order |
| `get_fulfillment` | Fetch a single fulfillment (shipment record) with tracking info |
| `create_fulfillment` | Mark fulfillment orders (or specific quantities) as fulfilled; optionally attach tracking + notify customer |
| `update_fulfillment_tracking` | Update carrier/number/url on an existing fulfillment |
| `cancel_fulfillment` | Cancel a fulfillment by ID |

Partial fulfillment is supported — pass specific `fulfillmentOrderLineItems` with `quantity` per line; omit the array to fulfill everything on the fulfillment order.

### Variants & product options

| Tool | Description |
|---|---|
| `list_variants` | List all variants of a product with their selected options, price, SKU, inventory |
| `create_variants` | Bulk-create variants (up to 100) with option values, price, SKU, compareAtPrice, initial inventory |
| `update_variants` | Bulk-update variant price, compareAtPrice, SKU, barcode, taxable, inventoryPolicy, option values |
| `delete_variants` | Bulk-delete variants from a product |
| `reorder_variants` | Set 1-indexed positions for variants |
| `add_product_options` | Add options (Size/Color/…) with their possible values; up to 3 options per product |

For an entirely new product, creating the first real variant requires `strategy="REMOVE_STANDALONE_VARIANT"` to replace the auto-generated "Default Title" variant.

### Collections & tagging

| Tool | Description |
|---|---|
| `list_collections` | List collections with query filters |
| `get_collection` | Fetch one collection with its products |
| `create_collection` | Create a manual collection, optionally seeded with products |
| `update_collection` | Update title, description, or handle |
| `delete_collection` | Delete a collection |
| `add_products_to_collection` | Add products to a manual collection (async job on Shopify's side) |
| `remove_products_from_collection` | Remove products from a manual collection |
| `add_tags` | Add tags to any taggable resource (Product, Order, Customer, DraftOrder, Collection) |
| `remove_tags` | Remove tags from a taggable resource |

### ComfyUI bridge (when `COMFYUI_URL` is configured)

| Tool | Description |
|---|---|
| `generate_and_create_product` | Generate an image and create a product with it, in one call. Title/description derive from the prompt if not given. |
| `generate_product_image` | Generate an image and attach it to an existing product. |
| `bulk_regenerate_images` | For all products matching a query, run the generator with a templated prompt and attach fresh images. |

Template placeholders for `bulk_regenerate_images`: `{title}`, `{handle}`.

## Example — the whole pitch in one call

```
Claude, use generate_and_create_product:
  prompt: "minimalist sunset mountain silhouette, warm gradient, vector style"
  title: "Mountain Sunset Poster"
  status: DRAFT
  tags: ["posters", "nature", "minimalist"]
```

Result: ComfyUI generates the image → Shopify product created with image attached → you get back the product ID and image URL. One prompt, one call, real listing.

## Architecture

```
┌────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│  MCP client    │────▶│  shopify-mcp     │────▶│  Shopify Admin  │
│  (Claude etc.) │◀────│  (this server)   │◀────│  GraphQL API    │
└────────────────┘     └────────┬─────────┘     └─────────────────┘
                                │
                                │ (bridge tools only)
                                ▼
                       ┌──────────────────┐
                       │  ComfyUI         │
                       │  (txt2img)       │
                       └──────────────────┘
```

Bridge tools call ComfyUI directly over HTTP, get an image URL, and pass it to Shopify's `productCreateMedia` mutation — Shopify fetches and hosts the image on its CDN.

## Development

```bash
git clone https://github.com/miller-joe/shopify-mcp
cd shopify-mcp
npm install
npm run dev   # hot reload via tsx watch
npm run build
npm run typecheck
npm test
```

Requires Node 20+.

## Roadmap

- [x] Core products CRUD + image attach
- [x] Orders read
- [x] Inventory set + locations
- [x] Customers read
- [x] ComfyUI bridge: `generate_and_create_product`, `generate_product_image`, `bulk_regenerate_images`
- [x] Metafields: `set_metafield`, `list_metafields`, `delete_metafield`
- [x] Draft orders: create/update/complete/delete + list/get
- [x] Collections + tagging: CRUD, product add/remove, `add_tags` / `remove_tags`
- [x] Variants + product options: bulk create/update/delete/reorder + `add_product_options`
- [x] Fulfillment: list/get fulfillment orders, create fulfillment (partial supported), update tracking, cancel
- [ ] Metaobjects (separate from metafields)
- [ ] OAuth token-exchange flow for new-app auth
- [ ] ShopifyQL analytics wrappers
- [ ] Webhook subscription management
- [ ] Image refinement: given an existing product image, run ComfyUI img2img for controlled variations

## License

MIT © Joe Miller

## Support

If this saves you time, consider supporting development:

[![GitHub Sponsors](https://img.shields.io/github/sponsors/miller-joe?style=social&logo=github)](https://github.com/sponsors/miller-joe)
[![Ko-fi](https://img.shields.io/badge/Ko--fi-Support-ff5e5b?logo=kofi&logoColor=white)](https://ko-fi.com/indivisionjoe)
