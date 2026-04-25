#!/usr/bin/env node
import { parseArgs } from "node:util";
import { startServer, startStdioServer } from "./server.js";

const { values } = parseArgs({
  options: {
    host: { type: "string" },
    port: { type: "string" },
    "shopify-store": { type: "string" },
    "shopify-access-token": { type: "string" },
    "shopify-api-version": { type: "string" },
    "comfyui-url": { type: "string" },
    "comfyui-public-url": { type: "string" },
    stdio: { type: "boolean" },
    help: { type: "boolean", short: "h" },
  },
});

if (values.help) {
  process.stdout.write(
    [
      "shopify-mcp — MCP server for Shopify with ComfyUI image generation bridge",
      "",
      "Usage: shopify-mcp [options]",
      "",
      "Required:",
      "  --shopify-store <domain>         Store domain (env: SHOPIFY_STORE)",
      "                                   e.g. 'my-store' or 'my-store.myshopify.com'",
      "  --shopify-access-token <token>   Admin API token (env: SHOPIFY_ACCESS_TOKEN)",
      "",
      "Optional:",
      "  --shopify-api-version <ver>      API version (default: 2026-04, env: SHOPIFY_API_VERSION)",
      "  --host <host>                    Bind host (default: 0.0.0.0, env: MCP_HOST)",
      "  --port <port>                    Bind port (default: 9110, env: MCP_PORT)",
      "  --comfyui-url <url>              ComfyUI URL for bridge tools (env: COMFYUI_URL)",
      "                                   When unset, generate_* bridge tools are disabled",
      "  --comfyui-public-url <url>       Externally-reachable ComfyUI URL used in image URLs",
      "                                   (env: COMFYUI_PUBLIC_URL, default: same as --comfyui-url)",
      "  --stdio                          Speak MCP over stdio instead of starting an HTTP",
      "                                   server. Use when launched as a subprocess by an",
      "                                   MCP client (Claude Desktop, mcp-inspector, etc.)",
      "                                   (env: MCP_TRANSPORT=stdio)",
      "  -h, --help                       Show this help",
      "",
      "Other env:",
      "  COMFYUI_DEFAULT_CKPT             Default ComfyUI checkpoint filename",
      "                                   (default: sd_xl_base_1.0.safetensors)",
      "",
    ].join("\n"),
  );
  process.exit(0);
}

const host = values.host ?? process.env.MCP_HOST ?? "0.0.0.0";
const port = Number(values.port ?? process.env.MCP_PORT ?? "9110");
const shopifyStore =
  values["shopify-store"] ?? process.env.SHOPIFY_STORE;
const shopifyAccessToken =
  values["shopify-access-token"] ?? process.env.SHOPIFY_ACCESS_TOKEN;
const shopifyApiVersion =
  values["shopify-api-version"] ?? process.env.SHOPIFY_API_VERSION;
const comfyUIUrl = values["comfyui-url"] ?? process.env.COMFYUI_URL;
const comfyUIPublicUrl =
  values["comfyui-public-url"] ?? process.env.COMFYUI_PUBLIC_URL;
const comfyUIDefaultCkpt =
  process.env.COMFYUI_DEFAULT_CKPT ?? "sd_xl_base_1.0.safetensors";

if (!shopifyStore) {
  process.stderr.write(
    "Warning: SHOPIFY_STORE / --shopify-store not set. Shopify tool calls will fail until configured.\n",
  );
}
if (!shopifyAccessToken) {
  process.stderr.write(
    "Warning: SHOPIFY_ACCESS_TOKEN / --shopify-access-token not set. Shopify tool calls will fail until configured.\n",
  );
}

const useStdio = values.stdio || process.env.MCP_TRANSPORT === "stdio";
const config = {
  host,
  port,
  shopifyStore: shopifyStore ?? "",
  shopifyAccessToken: shopifyAccessToken ?? "",
  shopifyApiVersion,
  comfyUIUrl,
  comfyUIPublicUrl,
  comfyUIDefaultCkpt,
};
if (useStdio) {
  await startStdioServer(config);
} else {
  await startServer(config);
}
