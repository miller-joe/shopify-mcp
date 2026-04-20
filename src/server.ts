import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { randomUUID } from "node:crypto";
import { ShopifyClient } from "./shopify/client.js";
import { ComfyUIClient } from "./comfyui/client.js";
import { registerProductTools } from "./tools/products.js";
import { registerOrderTools } from "./tools/orders.js";
import { registerInventoryTools } from "./tools/inventory.js";
import { registerCustomerTools } from "./tools/customers.js";
import { registerMetafieldTools } from "./tools/metafields.js";
import { registerDraftOrderTools } from "./tools/draft_orders.js";
import { registerCollectionTools } from "./tools/collections.js";
import { registerVariantTools } from "./tools/variants.js";
import { registerFulfillmentTools } from "./tools/fulfillment.js";
import { registerBridgeTools } from "./tools/bridge.js";

export interface ServerConfig {
  host: string;
  port: number;
  shopifyStore: string;
  shopifyAccessToken: string;
  shopifyApiVersion?: string;
  comfyUIUrl?: string;
  comfyUIPublicUrl?: string;
  comfyUIDefaultCkpt: string;
}

interface Session {
  server: McpServer;
  transport: StreamableHTTPServerTransport;
}

export async function startServer(config: ServerConfig): Promise<void> {
  const shopify = new ShopifyClient({
    store: config.shopifyStore,
    accessToken: config.shopifyAccessToken,
    apiVersion: config.shopifyApiVersion,
  });

  const comfyui = config.comfyUIUrl
    ? new ComfyUIClient({
        baseUrl: config.comfyUIUrl,
        publicUrl: config.comfyUIPublicUrl ?? config.comfyUIUrl,
      })
    : null;

  const sessions = new Map<string, Session>();

  const buildServer = () => {
    const s = new McpServer({ name: "shopify-mcp", version: "0.1.0" });
    registerProductTools(s, shopify);
    registerOrderTools(s, shopify);
    registerInventoryTools(s, shopify);
    registerCustomerTools(s, shopify);
    registerMetafieldTools(s, shopify);
    registerDraftOrderTools(s, shopify);
    registerCollectionTools(s, shopify);
    registerVariantTools(s, shopify);
    registerFulfillmentTools(s, shopify);
    registerBridgeTools(s, shopify, comfyui, config.comfyUIDefaultCkpt);
    return s;
  };

  const httpServer = createServer(async (req, res) => {
    try {
      await handleMcpRequest(req, res, sessions, buildServer);
    } catch (err) {
      if (!res.headersSent) {
        res.statusCode = 500;
        res.setHeader("Content-Type", "application/json");
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            error: { code: -32603, message: (err as Error).message },
            id: null,
          }),
        );
      }
    }
  });

  httpServer.listen(config.port, config.host, () => {
    const bridge = comfyui ? `yes (${config.comfyUIUrl})` : "no";
    process.stdout.write(
      `shopify-mcp listening on http://${config.host}:${config.port} (store: ${config.shopifyStore}, comfyui: ${bridge})\n`,
    );
  });

  const shutdown = () => {
    for (const { transport } of sessions.values()) {
      void transport.close();
    }
    httpServer.close(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

async function handleMcpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  sessions: Map<string, Session>,
  buildServer: () => McpServer,
): Promise<void> {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  let body: unknown = undefined;

  if (req.method === "POST") {
    body = await readJsonBody(req);
  }

  let session = sessionId ? sessions.get(sessionId) : undefined;

  if (!session && body !== undefined && isInitializeRequest(body)) {
    const server = buildServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        sessions.set(id, { server, transport });
      },
    });
    transport.onclose = () => {
      if (transport.sessionId) sessions.delete(transport.sessionId);
    };
    await server.connect(transport);
    session = { server, transport };
  }

  if (!session) {
    res.statusCode = 400;
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        jsonrpc: "2.0",
        error: {
          code: -32000,
          message:
            "Bad Request: no valid session. Send initialize first or include Mcp-Session-Id header.",
        },
        id: null,
      }),
    );
    return;
  }

  await session.transport.handleRequest(req, res, body);
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return undefined;
  const raw = Buffer.concat(chunks).toString("utf-8");
  if (raw.length === 0) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}
