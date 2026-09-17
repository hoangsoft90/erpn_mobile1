/**
 * P3 — LLM Classifier tests (plan2_final §15, §19 P3).
 *
 * Safety properties under test (each maps to a P3 exit criterion):
 *  1. the classifier can NEVER surface an ERP id — id-like slot keys are
 *     stripped before the caller sees them (and reported);
 *  2. an intent outside the Capability Contract is rejected (the contract, not
 *     the model, decides what the system can do); forbidden capabilities are
 *     not even offered to the model;
 *  3. confidence is only a route/ask-again gate — invalid confidence fails
 *     closed, low confidence becomes LOW_CONFIDENCE, never a silent route;
 *  4. LLM down / timeout / malformed ⇒ rule-only, never a crash;
 *  5. E2E: a sentence the keyword router misses is routed by the classifier
 *     through the SAME skill path (routed.matched === "classifier").
 *
 * Deterministic: the LLM is a local mock HTTP server. No provider, no quota.
 */

import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

import {
  validateClassification,
  classifyIntent,
  allowedIntents,
  SLOT_KEYS,
  CLASSIFIER_DEFAULTS,
} from "../src/classifier.mjs";
import { getCapability, isForbidden, listCapabilities } from "../src/capability-contract.mjs";
import { routeByCapability } from "../src/router.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const REPO = path.resolve(ROOT, "..");
const COPILOT = path.join(ROOT, "src", "copilot-server.mjs");

/** A canned OpenAI-compatible response carrying `content` as the message. */
function openAiBody(content) {
  return { choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }] };
}

// ───────────────────────── front 1: validation ─────────────────────────

test("validateClassification — never surfaces an ERP id (id-like keys stripped)", () => {
  const result = validateClassification({
    intent: "customer.balance",
    confidence: 0.9,
    slots: { customer_text: "lan", customer_id: "CUST-00001", docname: "SINV-0001" },
    missing_entities: [],
    needs_clarification: false,
  });
  assert.equal(result.ok, true);
  assert.equal(result.intent, "customer.balance");
  assert.deepEqual(Object.keys(result.slots), ["customer_text"]);
  assert.equal(result.slots.customer_id, undefined);
  assert.ok(result.rejected_keys.includes("customer_id"));
  assert.ok(result.rejected_keys.includes("docname"));
});

test("validateClassification — intent outside the contract is rejected", () => {
  const result = validateClassification({ intent: "delete_everything", confidence: 0.99, slots: {} });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "INTENT_NOT_IN_CONTRACT");
});

test("validateClassification — forbidden capabilities are not offerable", () => {
  // document.delete is in the contract but forbidden on the AI path: the
  // classifier must not even be allowed to name it.
  assert.ok(isForbidden("document.delete"));
  assert.ok(!allowedIntents().includes("document.delete"));
  const result = validateClassification(
    { intent: "document.delete", confidence: 0.99, slots: {} },
    { knownIntents: allowedIntents() },
  );
  assert.equal(result.ok, false);
  assert.equal(result.reason, "INTENT_NOT_IN_CONTRACT");
});

test("validateClassification — invalid confidence fails closed", () => {
  assert.equal(validateClassification({ intent: "customer.balance", confidence: "high" }).ok, false);
  assert.equal(validateClassification({ intent: "customer.balance", confidence: 2 }).ok, false);
  // null/true coerce to numbers — they must still be refused by the type check.
  assert.equal(validateClassification({ intent: "customer.balance", confidence: null }).reason, "CONFIDENCE_INVALID");
  assert.equal(validateClassification({ intent: "customer.balance", confidence: undefined }).reason, "CONFIDENCE_INVALID");
  assert.equal(validateClassification({ intent: "customer.balance", confidence: true }).reason, "CONFIDENCE_INVALID");
});

test("validateClassification — low confidence / empty intent ⇒ low_confidence, not a route", () => {
  const low = validateClassification({ intent: "customer.balance", confidence: 0.2, slots: {} });
  assert.equal(low.ok, true);
  assert.equal(low.low_confidence, true);

  const empty = validateClassification({ intent: "", confidence: 0.9, slots: {} });
  assert.equal(empty.ok, true);
  assert.equal(empty.intent, null);
  assert.equal(empty.low_confidence, true);
});

test("validateClassification — keeps only allowlisted TEXT slots", () => {
  const result = validateClassification({
    intent: "stock.balance",
    confidence: 0.8,
    slots: { item_text: "cám gà", evil: "x", nested: { a: 1 }, count: 3 },
  });
  assert.deepEqual(result.slots, { item_text: "cám gà" });
  for (const k of Object.keys(result.slots)) assert.ok(SLOT_KEYS.includes(k));
});

test("classifyIntent — parses a fenced/padded JSON answer from the model", async () => {
  const fetchImpl = async () =>
    ({ ok: true, json: async () => openAiBody("```json\n{\"intent\":\"invoice.lookup\",\"confidence\":0.77,\"slots\":{}}\n```") });
  const result = await classifyIntent("đơn hàng của hai", {
    config: { ...CLASSIFIER_DEFAULTS, enabled: true },
    fetchImpl,
  });
  assert.equal(result.ok, true);
  assert.equal(result.intent, "invoice.lookup");
  assert.equal(result.confidence, 0.77);
});

test("classifyIntent — non-2xx / unparseable / abort all fail closed", async () => {
  const cfg = { ...CLASSIFIER_DEFAULTS, enabled: true, timeoutMs: 50 };

  const http500 = await classifyIntent("x", { config: cfg, fetchImpl: async () => ({ ok: false, status: 500 }) });
  assert.equal(http500.ok, false);
  assert.match(http500.reason, /HTTP_500/);

  const junk = await classifyIntent("x", { config: cfg, fetchImpl: async () => ({ ok: true, json: async () => openAiBody("not json at all") }) });
  assert.equal(junk.ok, false);
  assert.equal(junk.reason, "UNPARSEABLE");

  const aborted = await classifyIntent("x", {
    config: cfg,
    fetchImpl: async (_url, opts) =>
      new Promise((_resolve, reject) => {
        opts.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
      }),
  });
  assert.equal(aborted.ok, false);
  assert.equal(aborted.reason, "TIMEOUT");
});

test("routeByCapability — every non-forbidden capability resolves to a callable factory", () => {
  // Guards a future contract entry: a runnable capability whose route_group has
  // no skill factory must resolve to null (UNKNOWN_INTENT), never to a route
  // that throws at call time.
  for (const id of listCapabilities()) {
    const r = routeByCapability(id);
    if (isForbidden(id)) {
      assert.ok(r, `${id} is forbidden but has no route (the refusal path needs it)`);
      assert.equal(r.forbidden, true);
      continue;
    }
    assert.ok(r, `${id} must resolve to a route`);
    assert.equal(typeof r.factory, "function", `${id} must carry a skill factory`);
  }
  assert.equal(routeByCapability("not.a.capability"), null);
});

test("classifyIntent — disabled classifier never touches the network", async () => {
  let called = false;
  const result = await classifyIntent("x", {
    config: { ...CLASSIFIER_DEFAULTS, enabled: false },
    fetchImpl: async () => {
      called = true;
      return { ok: true, json: async () => openAiBody("{}") };
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "CLASSIFIER_DISABLED");
  assert.equal(called, false);
});

// ─────────────────── front 2: E2E through the real pipeline ───────────────────

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

/** Start a mock LLM router; `content` is the assistant message it returns. */
function startMockClassifier() {
  const state = { content: "{}", status: 200, hang: false };
  const server = http.createServer((req, res) => {
    if (req.method !== "POST" || !req.url.startsWith("/v1/chat/completions")) {
      res.writeHead(404);
      return res.end();
    }
    req.resume();
    if (state.hang) return; // never answers → the client's timeout must fire
    const body = JSON.stringify(openAiBody(state.content));
    res.writeHead(state.status, { "Content-Type": "application/json" });
    res.end(body);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, state, port: server.address().port }));
  });
}

function startCopilot(port, env) {
  const child = spawn(process.execPath, [COPILOT], {
    env: { ...env, NLP_SERVICE_PORT: String(port) },
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
      const msg = JSON.parse(line);
      const entry = pending.get(msg.id);
      if (!entry) continue;
      pending.delete(msg.id);
      // Match the MCP result shape the server sends: structuredContent when
      // present, else the JSON inside the first text block.
      entry.resolve(msg.result?.structuredContent ?? JSON.parse(msg.result.content[0].text));
    }
  });
  const call = (text) =>
    new Promise((resolve) => {
      const id = nextId++;
      pending.set(id, { resolve });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "copilot_ask", arguments: { text } } }) + "\n");
    });
  return { child, call, close: () => child.stdin.end() };
}

test("E2E — unknown sentence is routed by the classifier through the same skill path", async (t) => {
  const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^ERPNEXT_/.test(k)));
  const nlp = await startNlpService();
  const mock = await startMockClassifier();
  const copilot = startCopilot(nlp.port, { ...cleanEnv, COPILOT_CLASSIFIER_URL: `http://127.0.0.1:${mock.port}` });
  try {
    // "tình hình của lan" matches NO keyword route, but names a mock customer.
    mock.state.content = JSON.stringify({
      intent: "customer.balance",
      confidence: 0.92,
      slots: { customer_text: "lan" },
      missing_entities: [],
      needs_clarification: false,
    });
    const res = await copilot.call("tình hình của lan");
    assert.equal(res.routed?.matched, "classifier");
    assert.equal(res.routed?.group, "customer");
    assert.equal(getCapability("customer.balance").type, "READ");
    assert.match(res.answer ?? "", /Nguyễn Thị Lan/);
    assert.match(res.answer ?? "", /2\.500\.000đ/);
  } finally {
    copilot.close();
    mock.server.close();
    nlp.child.kill();
  }
});

test("E2E — classifier low confidence becomes LOW_CONFIDENCE (ask again), not a route", async () => {
  const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^ERPNEXT_/.test(k)));
  const nlp = await startNlpService();
  const mock = await startMockClassifier();
  const copilot = startCopilot(nlp.port, { ...cleanEnv, COPILOT_CLASSIFIER_URL: `http://127.0.0.1:${mock.port}` });
  try {
    mock.state.content = JSON.stringify({ intent: "customer.balance", confidence: 0.1, slots: {}, missing_entities: ["khách"], needs_clarification: true });
    const res = await copilot.call("tình hình của lan");
    assert.equal(res.error_code, "LOW_CONFIDENCE");
    assert.equal(res.uncertainty?.code, "LOW_CONFIDENCE");
    assert.equal(res.proposal ?? null, null);
  } finally {
    copilot.close();
    mock.server.close();
    nlp.child.kill();
  }
});

test("E2E — LLM down ⇒ rule-only UNKNOWN_INTENT, never a crash", async () => {
  const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^ERPNEXT_/.test(k)));
  const nlp = await startNlpService();
  // Point at a port nothing listens on.
  const copilot = startCopilot(nlp.port, { ...cleanEnv, COPILOT_CLASSIFIER_URL: "http://127.0.0.1:1" });
  try {
    const res = await copilot.call("tình hình của lan");
    assert.equal(res.error_code, "UNKNOWN_INTENT");
    assert.equal(res.uncertainty?.code, "UNKNOWN_INTENT");
  } finally {
    copilot.close();
    nlp.child.kill();
  }
});

test("E2E — a write intent from the classifier still yields a HIGH proposal (confirm still required)", async () => {
  const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^ERPNEXT_/.test(k)));
  const nlp = await startNlpService();
  const mock = await startMockClassifier();
  const copilot = startCopilot(nlp.port, { ...cleanEnv, COPILOT_CLASSIFIER_URL: `http://127.0.0.1:${mock.port}` });
  try {
    // "xử lý 500 nghìn cho nguyễn thị lan" — contains NO routing keyword
    // (so the deterministic router misses), but names the mock customer exactly,
    // so entity resolution is EXACT (a fuzzy name would demand the picker first).
    mock.state.content = JSON.stringify({
      intent: "payment.create",
      confidence: 0.9,
      slots: { customer_text: "nguyễn thị lan", amount_text: "500 nghìn" },
      missing_entities: [],
      needs_clarification: false,
    });
    const res = await copilot.call("xử lý 500 nghìn cho nguyễn thị lan");
    assert.equal(res.routed?.matched, "classifier");
    assert.equal(res.routed?.group, "payment_write");
    // The classifier NEVER executes: it produced a proposal that still needs
    // the human confirm (risk HIGH), exactly like the keyword write path.
    assert.equal(res.proposal?.action, "create_payment_entry");
    assert.equal(res.proposal?.risk, "HIGH");
  } finally {
    copilot.close();
    mock.server.close();
    nlp.child.kill();
  }
});
