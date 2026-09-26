/**
 * Phase 2 skill-layer entrypoint.
 *
 * - `createMcpClient` (src/client.mjs) does full JSON-RPC correlation; it takes
 *   an explicit `serverScript` so the whole layer is testable WITHOUT real
 *   ERPNext credentials (user decision 2026-09-13).
 * - The fixture server is opt-in-only at runtime (`COPILOT_MOCK_OK=1` through
 *   `pickServerScript()`); a missing ERPNEXT_* config refuses to start rather
 *   than silently answering from fixtures (issue1_fix1).
 * - When real credentials arrive: set ERPNEXT_URL / ERPNEXT_API_KEY /
 *   ERPNEXT_API_SECRET and `pickServerScript()` points at the pinned
 *   @casys/mcp-erpnext 3.0.4 stdio binary — logic stays identical.
 */

import { createRequire } from "node:module";
export { createMcpClient, MOCK_SERVER } from "./client.mjs";
export { routeIntent } from "./router.mjs";
export { assertReadOnly, assertKnownId, markUntrusted, READ_ONLY_TOOLS } from "./readonly-guard.mjs";

const require = createRequire(import.meta.url);

const ENV_VARS = ["ERPNEXT_URL", "ERPNEXT_API_KEY", "ERPNEXT_API_SECRET"];

/**
 * Path of the pinned @casys/mcp-erpnext 3.0.4 stdio server binary.
 * Resolved from node_modules so the pin in package.json is the single source
 * of truth. Throws when the package is not installed.
 */
export function realServerScript() {
  const pkgPath = require.resolve("@casys/mcp-erpnext/package.json");
  const pkg = require(pkgPath);
  const bin = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.["mcp-erpnext"];
  if (!bin) throw new Error("@casys/mcp-erpnext exposes no stdio binary");
  return new URL(`file://${pkgPath.replace(/package\.json$/, "")}${bin}`).pathname;
}

function requireEnv() {
  const missing = ENV_VARS.filter((k) => !process.env[k]);
  if (missing.length > 0) {
    console.error(
      `[erpn-mcp] refusing to start against the REAL server — missing env vars: ${missing.join(", ")}\n` +
        `Provide ERPNext credentials before connecting to the real server.\n` +
        `Runtime never falls back to fixtures: without credentials, pickServerScript() ` +
        `refuses (ERPNEXT_NOT_CONFIGURED) unless COPILOT_MOCK_OK=1 is set explicitly for tests.`,
    );
    process.exit(2);
  }
}

// CLI entry: `node src/index.mjs` intentionally REQUIRES env — it means "run
// for real". Tests and development use the mock via createMcpClient() instead.
if (import.meta.url === `file://${process.argv[1]}`) {
  requireEnv();
  const { createMcpClient: c, realServerScript: r } = await import("./index.mjs");
  const client = c({ serverScript: r() });
  await client.initialize();
  console.error("[erpn-mcp] connected to real ERPNext MCP server");
}
