import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeStore, throwIfUserErrors } from "../src/shopify/client.js";
import { toGid } from "../src/tools/products.js";

test("normalizeStore: strips protocol and trailing slash", () => {
  assert.equal(normalizeStore("https://my-store.myshopify.com"), "my-store.myshopify.com");
  assert.equal(normalizeStore("http://my-store.myshopify.com/"), "my-store.myshopify.com");
  assert.equal(normalizeStore("my-store.myshopify.com"), "my-store.myshopify.com");
});

test("normalizeStore: appends .myshopify.com for bare handles", () => {
  assert.equal(normalizeStore("my-store"), "my-store.myshopify.com");
});

test("toGid: passes through existing gids and wraps bare IDs", () => {
  assert.equal(
    toGid("gid://shopify/Product/123", "Product"),
    "gid://shopify/Product/123",
  );
  assert.equal(toGid("123", "Product"), "gid://shopify/Product/123");
  assert.equal(toGid("456", "Order"), "gid://shopify/Order/456");
});

test("throwIfUserErrors: no-op on empty", () => {
  assert.doesNotThrow(() => throwIfUserErrors(undefined, "op"));
  assert.doesNotThrow(() => throwIfUserErrors([], "op"));
});

test("throwIfUserErrors: throws with field path joined", () => {
  assert.throws(
    () =>
      throwIfUserErrors(
        [{ field: ["input", "title"], message: "can't be blank" }],
        "productCreate",
      ),
    /productCreate.*input.title.*can't be blank/,
  );
});
