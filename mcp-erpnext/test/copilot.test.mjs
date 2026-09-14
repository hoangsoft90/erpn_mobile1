/**
 * End-to-end tests for the copilot MCP server (user task 2026-09-13):
 * real Python NLP service + real copilot-server process + real mock-server
 * process — the full Phase 1 → Phase 2 → answer pipeline over stdio.
 *
 * No ERPNext credentials needed (mock server), no LLM needed (deterministic).
 */

import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const REPO = path.resolve(ROOT, "..");
const COPILOT = path.join(ROOT, "src", "copilot-server.mjs");

/** E2E tests are HERMETIC: strip ERPNEXT_* so the copilot child always talks
 * to the in-memory mock, never to the real server (a leaked env var from an
 * earlier `source .env` shell silently flipped the target — result9 fix). */
const MOCK_ENV = Object.fromEntries(
  Object.entries(process.env).filter(([k]) => !/^ERPNEXT_/.test(k)),
);

/** Spawn the Python bridge on an ephemeral port, return {child, port}. */
async function startNlpService() {
  const child = spawn("python3", ["-m", "nlp_service.server", "--port", "0"], {
    cwd: REPO,
    stdio: ["ignore", "pipe", "inherit"],
  });
  const port = await new Promise((resolve, reject) => {
    child.stdout.on("data", (d) => {
      const m = String(d).match(/"port":\s*(\d+)/);
      if (m) resolve(Number(m[1]));
    });
    child.on("exit", (code) => reject(new Error(`nlp service exited early (${code})`)));
    setTimeout(() => reject(new Error("nlp service: no ready line in 5s")), 5000);
  });
  return { child, port };
}

/** Minimal stdio JSON-RPC client for one copilot-server process. */
function startCopilot(port) {
  const child = spawn(process.execPath, [COPILOT], {
    env: { ...MOCK_ENV, NLP_SERVICE_PORT: String(port) },
    stdio: ["pipe", "pipe", "inherit"],
  });
  const pending = new Map();
  let nextId = 1;
  let buffer = "";
  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString();
    let nl;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      const entry = pending.get(msg.id);
      if (!entry) continue;
      pending.delete(msg.id);
      if (msg.error) entry.reject(new Error(`MCP_ERROR ${msg.error.code}: ${msg.error.message}`));
      else entry.resolve(msg.result);
    }
  });
  const request = (method, params) => {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  };
  return {
    child,
    request,
    async call(text) {
      const res = await request("tools/call", { name: "copilot_ask", arguments: { text } });
      assert.equal(res.isError, undefined, `tool error: ${res.content?.[0]?.text}`);
      return res.structuredContent ?? JSON.parse(res.content[0].text);
    },
    async close() {
      child.stdin.end();
      await new Promise((r) => child.once("exit", r));
    },
  };
}

test("copilot E2E: pipeline answers a receivable question end-to-end", async () => {
  const nlp = await startNlpService();
  const copilot = startCopilot(nlp.port);
  try {
    const init = await copilot.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "0.0.0" },
    });
    assert.equal(init.serverInfo.name, "erpn-copilot");

    const tools = await copilot.request("tools/list", {});
    assert.equal(tools.tools.length, 1);
    assert.equal(tools.tools[0].name, "copilot_ask");
    assert.equal(tools.tools[0].annotations.readOnlyHint, true);

    const out = await copilot.call("chị Lan còn nợ bao nhiêu");
    assert.equal(out.routed.group, "customer");
    assert.equal(out.customer.id, "CUST-00001");
    assert.equal(out.outstanding_vnd, 2_500_000);
    assert.ok(out.answer.includes("2.500.000"), out.answer);
    // Phase 1 normalization really ran: kinship stripped + intent canonical.
    assert.ok(out.normalized.titles.includes("chị"), JSON.stringify(out.normalized.titles));
    assert.ok(out.normalized.intents.includes("receivable"), JSON.stringify(out.normalized.intents));
  } finally {
    await copilot.close();
    nlp.child.kill();
  }
});

test("copilot E2E: second customer resolves independently", async () => {
  const nlp = await startNlpService();
  const copilot = startCopilot(nlp.port);
  try {
    await copilot.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } });
    const out = await copilot.call("Trần Văn Hai còn nợ bao nhiêu");
    assert.equal(out.customer.id, "CUST-00002");
    assert.equal(out.outstanding_vnd, 7_500_000);
  } finally {
    await copilot.close();
    nlp.child.kill();
  }
});

test("copilot E2E: payment question lists receipts, not balances", async () => {
  const nlp = await startNlpService();
  const copilot = startCopilot(nlp.port);
  try {
    await copilot.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } });
    const out = await copilot.call("chị Lan đã trả bao nhiêu tiền");
    assert.equal(out.routed.group, "payment");
    assert.equal(out.customer.id, "CUST-00001");
    assert.equal(out.rows.length, 1);
    assert.equal(out.rows[0].amount_vnd, 8_000_000);
    assert.ok(out.answer.includes("8.000.000"), out.answer);
  } finally {
    await copilot.close();
    nlp.child.kill();
  }
});

test("copilot E2E: inventory question lists stock without a customer", async () => {
  const nlp = await startNlpService();
  const copilot = startCopilot(nlp.port);
  try {
    await copilot.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } });
    const out = await copilot.call("trong kho còn bao nhiêu cám heo");
    assert.equal(out.routed.group, "inventory");
    const joined = out.answer.join(" | ");
    assert.ok(joined.includes("CAM-HEO-25KG"), joined);
    assert.ok(joined.includes("120"), joined);
  } finally {
    await copilot.close();
    nlp.child.kill();
  }
});

test("copilot E2E: unroutable question returns honest null, never a guess", async () => {
  const nlp = await startNlpService();
  const copilot = startCopilot(nlp.port);
  try {
    await copilot.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } });
    const out = await copilot.call("xin chào");
    assert.equal(out.routed, false);
    assert.equal(out.answer, null);
  } finally {
    await copilot.close();
    nlp.child.kill();
  }
});

test("copilot E2E: unknown customer is reported, no invented IDs", async () => {
  const nlp = await startNlpService();
  const copilot = startCopilot(nlp.port);
  try {
    await copilot.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } });
    const out = await copilot.call("chị Hằng còn nợ bao nhiêu");
    assert.equal(out.answer, null);
    assert.ok(out.reason.includes("không tìm thấy khách hàng"), out.reason);
  } finally {
    await copilot.close();
    nlp.child.kill();
  }
});
