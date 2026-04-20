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
- [ ] Draft orders / checkout / fulfillment
- [ ] Metafields / metaobjects
- [ ] Collections / tagging ops
- [ ] Variant pricing + bulk variants
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
