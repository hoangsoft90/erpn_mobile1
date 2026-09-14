/**
 * Unit tests for the ERPNext target switch (copilot-server.mjs).
 *
 * Contract: no ERPNEXT_* -> mock; all three -> pinned real server binary;
 * partial or malformed config -> hard error (never a silent mock fallback).
 */

import test from "node:test";
import assert from "node:assert/strict";
import { pickServerScript } from "../src/copilot-server.mjs";
import { MOCK_SERVER } from "../src/client.mjs";
import { realServerScript } from "../src/index.mjs";

test("no ERPNEXT_* env -> mock server", () => {
  assert.equal(pickServerScript({}), MOCK_SERVER);
});

test("all three ERPNEXT_* env -> pinned real server binary", () => {
  const script = pickServerScript({
    ERPNEXT_URL: "https://example.ngrok-free.dev",
    ERPNEXT_API_KEY: "k",
    ERPNEXT_API_SECRET: "s",
  });
  assert.equal(script, realServerScript());
  assert.ok(script.includes("@casys/mcp-erpnext"), script);
});

test("partial config -> hard error naming the missing vars", () => {
  assert.throws(() => pickServerScript({ ERPNEXT_URL: "https://x.dev" }), /PARTIAL_ERPNEXT_CONFIG.*ERPNEXT_API_KEY, ERPNEXT_API_SECRET/);
  assert.throws(() => pickServerScript({ ERPNEXT_API_KEY: "k", ERPNEXT_API_SECRET: "s" }), /PARTIAL_ERPNEXT_CONFIG.*ERPNEXT_URL/);
});

test("malformed URL -> hard error, not silent mock fallback", () => {
  assert.throws(
    () => pickServerScript({ ERPNEXT_URL: "not a url", ERPNEXT_API_KEY: "k", ERPNEXT_API_SECRET: "s" }),
    /INVALID_ERPNEXT_URL/,
  );
});

test("non-http(s) protocol refused", () => {
  assert.throws(
    () => pickServerScript({ ERPNEXT_URL: "ftp://x.dev", ERPNEXT_API_KEY: "k", ERPNEXT_API_SECRET: "s" }),
    /INVALID_ERPNEXT_URL.*protocol/,
  );
});
