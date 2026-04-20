import type { GraphQLResponse, ShopifyUserError } from "./types.js";

export interface ShopifyClientOptions {
  /** Store domain, e.g. "my-store.myshopify.com" (no protocol) */
  store: string;
  /** Admin API access token (shpat_... or token-exchange result) */
  accessToken: string;
  /** API version, e.g. "2026-04" */
  apiVersion?: string;
}

const DEFAULT_API_VERSION = "2026-04";

export class ShopifyClient {
  private readonly endpoint: string;
  private readonly accessToken: string;

  constructor(options: ShopifyClientOptions) {
    const store = normalizeStore(options.store);
    const apiVersion = options.apiVersion ?? DEFAULT_API_VERSION;
    this.endpoint = `https://${store}/admin/api/${apiVersion}/graphql.json`;
    this.accessToken = options.accessToken;
  }

  async graphql<T>(
    query: string,
    variables?: Record<string, unknown>,
  ): Promise<T> {
    const res = await fetch(this.endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": this.accessToken,
      },
      body: JSON.stringify({ query, variables }),
    });

    if (!res.ok) {
      throw new Error(
        `Shopify API ${res.status}: ${await res.text()}`,
      );
    }

    const body = (await res.json()) as GraphQLResponse<T>;
    if (body.errors?.length) {
      throw new Error(
        `Shopify GraphQL errors: ${body.errors.map((e) => e.message).join("; ")}`,
      );
    }
    if (!body.data) {
      throw new Error("Shopify returned no data");
    }
    return body.data;
  }
}

export function normalizeStore(input: string): string {
  let store = input.trim().replace(/^https?:\/\//, "").replace(/\/$/, "");
  if (!store.includes(".")) {
    store = `${store}.myshopify.com`;
  }
  return store;
}

export function throwIfUserErrors(
  errors: ShopifyUserError[] | undefined,
  operation: string,
): void {
  if (!errors || errors.length === 0) return;
  const messages = errors
    .map((e) => (e.field ? `${e.field.join(".")}: ${e.message}` : e.message))
    .join("; ");
  throw new Error(`Shopify ${operation} userErrors: ${messages}`);
}
