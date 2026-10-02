/**
 * Tests for the Phase 5 LLM Router (scripts/llm-router.mjs) — the SIMPLIFIED
 * gateway per SIGNOFF-phase5-pii.md signed 2026-09-15 (no scrub, no PII
 * 2-tier): config-driven fallback chain, health cooldown, audit JSONL.
 *
 * Strategy: in-process real HTTP. Router + 2 local mock upstreams on ephemeral
 * ports — no internet, no credentials. Hermetic (no env dependence).
 */

import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { PassThrough } from "node:stream";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  loadConfig,
  UpstreamPool,
  upstreamUrl,
  createRouterServer,
  ThoughtSignatureCache,
  injectThoughtSignatures,
  captureThoughtSignatures,
} from "../llm-router.mjs";

/** Minimal OpenAI-compatible mock upstream: /v1/chat/completions + /v1/models. */
async function mockUpstream({ failFirst = 0, statusAfterFail = 500 } = {}) {
  let calls = 0;
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      calls += 1;
      if (req.url.endsWith("/models")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ object: "list", data: [{ id: "mock-up-model" }], seen: calls }));
        return;
      }
      if (calls <= failFirst) {
        res.writeHead(statusAfterFail, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: `upstream failure #${calls}` } }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          id: "chatcmpl-test",
          object: "chat.completion",
          choices: [{ index: 0, message: { role: "assistant", content: `ok-from-${server.name}` }, finish_reason: "stop" }],
        }),
      );
    });
  });
  server.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r)); // address() is null until listening
  server.calls = () => calls;
  server.port = () => server.address().port;
  return server;
}

function get(server, urlPath) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port: server.port ?? server.address().port, path: urlPath, method: "GET", headers: { connection: "close" } },
      (res) => {
        let out = "";
        res.on("data", (c) => (out += c));
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: out }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

function post(server, urlPath, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(typeof body === "string" ? body : JSON.stringify(body));
    const req = http.request(
      { host: "127.0.0.1", port: server.port ?? server.address().port, path: urlPath, method: "POST", headers: { "content-type": "application/json", "content-length": data.length, connection: "close", ...headers } },
      (res) => {
        let out = "";
        res.on("data", (c) => (out += c));
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: out }));
      },
    );
    req.on("error", reject);
    req.end(data);
  });
}

test("loadConfig: valid chain passes, defaults filled", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "router-cfg-"));
  const file = path.join(dir, "cfg.json");
  const written = {
    upstreams: [{ name: "a", baseUrl: "http://127.0.0.1:1/v1" }],
  };
  writeFileSync(file, JSON.stringify(written));
  const cfg = loadConfig(file);
  assert.equal(cfg.port, 8900);
  assert.equal(cfg.host, "127.0.0.1");
  assert.equal(cfg.timeoutMs, 60000);
  assert.equal(cfg.cooldownMs, 30000);
});

test("loadConfig: stripFields must be an array of strings (hard error — a string iterates chars)", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "router-cfg-"));
  const f1 = path.join(dir, "strip-string.json");
  writeFileSync(f1, JSON.stringify({ upstreams: [{ name: "x", baseUrl: "http://x/v1", stripFields: "store" }] }));
  assert.throws(() => loadConfig(f1), /stripFields must be an array/);

  const f2 = path.join(dir, "strip-num.json");
  writeFileSync(f2, JSON.stringify({ upstreams: [{ name: "x", baseUrl: "http://x/v1", stripFields: [1] }] }));
  assert.throws(() => loadConfig(f2), /stripFields must be an array/);

  const f3 = path.join(dir, "strip-ok.json");
  writeFileSync(f3, JSON.stringify({ upstreams: [{ name: "x", baseUrl: "http://x/v1", stripFields: ["store"] }] }));
  assert.doesNotThrow(() => loadConfig(f3));
});

test("loadConfig: empty chain / bad URL / invalid JSON → hard error", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "router-cfg-"));
  const f1 = path.join(dir, "empty.json");
  writeFileSync(f1, JSON.stringify({ upstreams: [] }));
  assert.throws(() => loadConfig(f1), /non-empty upstreams/);

  const f2 = path.join(dir, "badurl.json");
  writeFileSync(f2, JSON.stringify({ upstreams: [{ name: "x", baseUrl: "ftp://nope" }] }));
  assert.throws(() => loadConfig(f2), /http\(s\) URL/);

  const f3 = path.join(dir, "broken.json");
  writeFileSync(f3, "{ not json");
  assert.throws(() => loadConfig(f3), /not valid JSON/);
});

test("upstreamUrl: preserves the /v1 path prefix (regression: new URL would drop it)", () => {
  assert.equal(upstreamUrl({ baseUrl: "http://h:8899/v1" }, "/chat/completions").pathname, "/v1/chat/completions");
  assert.equal(upstreamUrl({ baseUrl: "http://h:8899/v1/" }, "/chat/completions").pathname, "/v1/chat/completions");
  assert.equal(upstreamUrl({ baseUrl: "http://h:8899" }, "/chat/completions").pathname, "/chat/completions");
});

test("UpstreamPool: cooldown excludes unhealthy, then recovers", () => {
  const pool = new UpstreamPool([{ name: "a", baseUrl: "http://a/v1" }, { name: "b", baseUrl: "http://b/v1" }], { timeoutMs: 1000, cooldownMs: 30 });
  assert.deepEqual(pool.healthy().map((u) => u.name), ["a", "b"]);
  pool.markUnhealthy("a", 30);
  assert.deepEqual(pool.healthy().map((u) => u.name), ["b"]);
  return new Promise((resolve) => setTimeout(resolve, 40)).then(() => {
    assert.deepEqual(pool.healthy().map((u) => u.name), ["a", "b"]);
  });
});

test("[result17] candidates(): healthy first, then cooling soonest-first — never empty while entries exist", () => {
  const pool = new UpstreamPool(
    [{ name: "a", baseUrl: "http://a/v1", model: "m-a" }, { name: "b", baseUrl: "http://b/v1", model: "m-b" }],
    { timeoutMs: 1000, cooldownMs: 30_000 },
  );
  pool.markUnhealthy("a", 50_000); // cooling longest
  pool.markUnhealthy("b", 1_000); // recovers sooner
  assert.deepEqual(pool.healthy().map((u) => u.name), [], "both are cooling down");
  assert.deepEqual(
    pool.candidates(null).map((u) => u.name),
    ["b", "a"],
    "cooling upstreams are still candidates, ordered by soonest recovery — cooldown deprioritises, never disables",
  );
  assert.deepEqual(pool.candidates("m-b").map((u) => u.name), ["b"], "model filter still applies while cooling");
  assert.equal(pool.candidates("only-this-model").length, 0);
});

test("[result17] single transient 503 must NOT disable the only upstream (retry inside cooldown must reach it)", async () => {
  // Real failure this reproduces: one 503 put the sole upstream into a 30s
  // cooldown; every later request was answered instantly with 502
  // "(tried: none)" without contacting the upstream, and the dsh session died.
  const flaky = await mockUpstream({ failFirst: 1, statusAfterFail: 503 });
  const auditDir = mkdtempSync(path.join(tmpdir(), "router-audit-"));
  const cfg = {
    port: 0, host: "127.0.0.1", cooldownMs: 30_000, timeoutMs: 5_000,
    upstreams: [{ name: "only", baseUrl: `http://127.0.0.1:${flaky.port()}/v1`, model: "m-1" }],
  };
  const pool = new UpstreamPool(cfg.upstreams, { timeoutMs: cfg.timeoutMs, cooldownMs: cfg.cooldownMs });
  const { server: router } = createRouterServer({ config: cfg, pool, auditPath: path.join(auditDir, "a.jsonl") });
  await new Promise((r) => router.listen(0, "127.0.0.1", r));
  try {
    const first = await post(router, "/v1/chat/completions", { model: "m-1", messages: [{ role: "user", content: "lan1" }] });
    assert.equal(first.status, 502);
    const firstErr = JSON.parse(first.body).error;
    assert.equal(firstErr.type, "llm_router_all_failed");
    assert.match(firstErr.message, /tried: only/, "the failure must report the attempt that actually happened");
    assert.equal(flaky.calls(), 1);

    // Still inside the cooldown window — the buggy version answered from the
    // cooldown alone (attempts: []) without ever asking the upstream.
    const second = await post(router, "/v1/chat/completions", { model: "m-1", messages: [{ role: "user", content: "lan2" }] });
    assert.equal(second.status, 200, "cooldown must deprioritise, not disable the only path");
    assert.match(second.body, /ok-from-/);
    assert.equal(flaky.calls(), 2, "the retry reached the upstream");
    const rows = readFileSync(path.join(auditDir, "a.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.deepEqual(rows[1].attempts, ["only"]);
    assert.equal(rows[0].attempts.length, 1, "never audit an empty attempt list for a configured upstream");
  } finally {
    closeAll(flaky, router);
  }
});

test("[result17] no upstream serves the requested model → honest 'no model match' error (not 'all upstreams failed')", async () => {
  const up = await mockUpstream();
  const auditDir = mkdtempSync(path.join(tmpdir(), "router-audit-"));
  const cfg = {
    port: 0, host: "127.0.0.1", cooldownMs: 30_000, timeoutMs: 5_000,
    upstreams: [{ name: "known", baseUrl: `http://127.0.0.1:${up.port()}/v1`, model: "m-known" }],
  };
  const pool = new UpstreamPool(cfg.upstreams, { timeoutMs: cfg.timeoutMs, cooldownMs: cfg.cooldownMs });
  const { server: router } = createRouterServer({ config: cfg, pool, auditPath: path.join(auditDir, "a.jsonl") });
  await new Promise((r) => router.listen(0, "127.0.0.1", r));
  try {
    const res = await post(router, "/v1/chat/completions", { model: "totally-unknown", messages: [{ role: "user", content: "x" }] });
    assert.equal(res.status, 502);
    const err = JSON.parse(res.body).error;
    assert.equal(err.type, "llm_router_no_model_match");
    assert.match(err.message, /totally-unknown/, "the message must name the model nobody serves");
    assert.ok(!/tried:/.test(err.message), "nothing was tried — do not claim otherwise");
    assert.equal(up.calls(), 0);
  } finally {
    closeAll(up, router);
  }
});

test("router: 429 on primary → falls back to healthy secondary, audit records both attempts", async () => {
  const failing = await mockUpstream({ failFirst: 99, statusAfterFail: 429 }); // always 429
  const working = await mockUpstream();
  working.name = "up-b";

  const auditDir = mkdtempSync(path.join(tmpdir(), "router-audit-"));
  const auditPath = path.join(auditDir, "audit.jsonl");
  const cfg = {
    port: 0,
    host: "127.0.0.1",
    cooldownMs: 30_000,
    timeoutMs: 5_000,
    upstreams: [
      { name: "up-a", baseUrl: `http://127.0.0.1:${failing.port()}/v1` },
      { name: "up-b", baseUrl: `http://127.0.0.1:${working.port()}/v1` },
    ],
  };
  const pool = new UpstreamPool(cfg.upstreams, { timeoutMs: cfg.timeoutMs, cooldownMs: cfg.cooldownMs });
  const { server: router } = createRouterServer({ config: cfg, pool, auditPath });
  await new Promise((r) => router.listen(0, "127.0.0.1", r));

  try {
    const res = await post(router, "/v1/chat/completions", { model: "any", messages: [{ role: "user", content: "xin chào" }] });
    assert.equal(res.status, 200);
    assert.match(res.body, /ok-from-up-b/);
    assert.equal(res.headers["x-llm-router-upstream"], "up-b");
    assert.equal(failing.calls(), 1, "primary hit exactly once");
    assert.equal(working.calls(), 1);

    const lines = readFileSync(auditPath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(lines.length, 1);
    assert.deepEqual(lines[0].attempts, ["up-a", "up-b"]);
    assert.equal(lines[0].upstream, "up-b");
    assert.equal(lines[0].status, 200);
    assert.equal(lines[0].messages, 1);
    assert.ok(lines[0].latencyMs >= 0);
    assert.ok(!JSON.stringify(lines).includes("xin chào"), "audit must NOT copy message content");
  } finally {
    closeAll(failing, working, router);
  }
});

/** close() alone leaves keep-alive sockets open (Node ≥19 default agent) → node --test never exits. */
function closeAll(...servers) {
  for (const s of servers) {
    s.closeAllConnections?.();
    s.close();
  }
}

test("router: debug mode drains retry-status bodies once, still falls back (regression: no double-consume)", async () => {
  const failing = await mockUpstream({ failFirst: 99, statusAfterFail: 429 });
  const working = await mockUpstream();
  working.name = "up-b2";

  const auditDir = mkdtempSync(path.join(tmpdir(), "router-audit-"));
  const cfg = {
    port: 0, host: "127.0.0.1", cooldownMs: 30_000, timeoutMs: 5_000,
    upstreams: [
      { name: "up-a2", baseUrl: `http://127.0.0.1:${failing.port()}/v1` },
      { name: "up-b2", baseUrl: `http://127.0.0.1:${working.port()}/v1` },
    ],
  };
  const pool = new UpstreamPool(cfg.upstreams, { timeoutMs: cfg.timeoutMs, cooldownMs: cfg.cooldownMs });
  const { server: router } = createRouterServer({ config: cfg, pool, auditPath: path.join(auditDir, "a.jsonl") });
  await new Promise((r) => router.listen(0, "127.0.0.1", r));

  const prevDebug = process.env.LLM_ROUTER_DEBUG;
  process.env.LLM_ROUTER_DEBUG = "1";
  try {
    const res = await post(router, "/v1/chat/completions", { model: "any", messages: [{ role: "user", content: "debug-drain" }] });
    assert.equal(res.status, 200);
    assert.match(res.body, /ok-from-up-b2/);
    assert.equal(failing.calls(), 1);
    assert.equal(working.calls(), 1);
  } finally {
    if (prevDebug === undefined) delete process.env.LLM_ROUTER_DEBUG;
    else process.env.LLM_ROUTER_DEBUG = prevDebug;
    closeAll(failing, working, router);
  }
});

test("router: client aborts mid-chain → process survives, no 502 attempt on dead socket", async () => {
  const slow = await mockUpstream();
  slow.responses = [];
  // Make the ONLY upstream hang until we abort the client side.
  const origHandler = slow.listeners("request");
  slow.removeAllListeners("request");
  slow.on("request", (req, res) => {
    if (req.url.endsWith("/models")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ object: "list", data: [] }));
      return;
    }
    // never respond — hold the request open
  });

  const auditDir = mkdtempSync(path.join(tmpdir(), "router-audit-"));
  const cfg = {
    port: 0, host: "127.0.0.1", cooldownMs: 30_000, timeoutMs: 20_000,
    upstreams: [{ name: "slow", baseUrl: `http://127.0.0.1:${slow.port()}/v1` }],
  };
  const pool = new UpstreamPool(cfg.upstreams, { timeoutMs: cfg.timeoutMs, cooldownMs: cfg.cooldownMs });
  const { server: router } = createRouterServer({ config: cfg, pool, auditPath: path.join(auditDir, "a.jsonl") });
  await new Promise((r) => router.listen(0, "127.0.0.1", r));

  try {
    const req = http.request(
      { host: "127.0.0.1", port: router.address().port, path: "/v1/chat/completions", method: "POST", headers: { "content-type": "application/json", "content-length": 2, connection: "close" } },
      () => {},
    );
    req.on("error", () => {}); // expected when we destroy
    req.end("{}");
    await new Promise((r) => setTimeout(r, 150)); // request reaches router + upstream
    req.destroy(); // client aborts while the chain is stuck
    await new Promise((r) => setTimeout(r, 100)); // give the router a beat
    // If the router had crashed, this follow-up would ECONNREFUSE.
    const h = await get(router, "/health");
    assert.equal(h.status, 200);
  } finally {
    closeAll(slow, router);
  }
});

test("router: chain exhausted → 502 with tried list, audit records failure", async () => {
  const a = await mockUpstream({ failFirst: 99, statusAfterFail: 500 });
  const b = await mockUpstream({ failFirst: 99, statusAfterFail: 503 });
  const auditDir = mkdtempSync(path.join(tmpdir(), "router-audit-"));
  const auditPath = path.join(auditDir, "audit.jsonl");
  const cfg = {
    port: 0, host: "127.0.0.1", cooldownMs: 30_000, timeoutMs: 5_000,
    upstreams: [
      { name: "f-a", baseUrl: `http://127.0.0.1:${a.port()}/v1` },
      { name: "f-b", baseUrl: `http://127.0.0.1:${b.port()}/v1` },
    ],
  };
  const pool = new UpstreamPool(cfg.upstreams, { timeoutMs: cfg.timeoutMs, cooldownMs: cfg.cooldownMs });
  const { server: router } = createRouterServer({ config: cfg, pool, auditPath });
  await new Promise((r) => router.listen(0, "127.0.0.1", r));

  try {
    const res = await post(router, "/v1/chat/completions", { messages: [] });
    assert.equal(res.status, 502);
    assert.match(res.body, /all upstreams failed/);
    assert.match(res.body, /f-a, f-b/);

    const lines = readFileSync(auditPath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(lines.length, 1);
    assert.equal(lines[0].upstream, null);
    assert.equal(lines[0].status, 502);
    assert.deepEqual(lines[0].attempts, ["f-a", "f-b"]);
  } finally {
    closeAll(a, b, router);
  }
});

test("router: /health reports per-upstream state, /v1/models proxies first healthy", async () => {
  const up = await mockUpstream();
  const auditDir = mkdtempSync(path.join(tmpdir(), "router-audit-"));
  const cfg = {
    port: 0, host: "127.0.0.1", cooldownMs: 30_000, timeoutMs: 5_000,
    upstreams: [{ name: "only", baseUrl: `http://127.0.0.1:${up.port()}/v1` }],
  };
  const pool = new UpstreamPool(cfg.upstreams, { timeoutMs: cfg.timeoutMs, cooldownMs: cfg.cooldownMs });
  const { server: router } = createRouterServer({ config: cfg, pool, auditPath: path.join(auditDir, "a.jsonl") });
  await new Promise((r) => router.listen(0, "127.0.0.1", r));

  try {
    const health = await get(router, "/health");
    assert.equal(health.status, 200);
    const h = JSON.parse(health.body);
    assert.equal(h.ok, true);
    assert.equal(h.upstreams[0].name, "only");
    assert.equal(h.upstreams[0].healthy, true);

    const models = await get(router, "/v1/models");
    assert.equal(models.status, 200);
    assert.match(models.body, /mock-up-model/);
  } finally {
    closeAll(up, router);
  }
});

/** Mock upstream that records every request body and answers the first call with
 *  an SSE tool_call carrying a Gemini thought_signature. */
async function mockToolUpstream() {
  const received = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      received.push(body);
      if (req.url.endsWith("/models")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ object: "list", data: [] }));
        return;
      }
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      if (received.length === 1) {
        const tool_calls = [
          {
            index: 0,
            id: "call_abc",
            type: "function",
            function: { name: "copilot_ask", arguments: "{}" },
            extra_content: { google: { thought_signature: "SIG-TEST-123" } },
          },
        ];
        res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls } }] })}\n\n`);
      } else {
        res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "ok" } }] })}\n\n`);
      }
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  server.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  server.received = () => received;
  server.port = () => server.address().port;
  return server;
}

test("[result17] ThoughtSignatureCache: learns from deltas split across chunks, then injects", () => {
  const c = new ThoughtSignatureCache();
  c.record([{ index: 0, extra_content: { google: { thought_signature: "S1" } } }]); // signature first
  c.record([{ index: 0, id: "call_1" }]); // id in a later chunk
  const parsed = { messages: [{ role: "assistant", tool_calls: [{ id: "call_1", type: "function", function: { name: "f", arguments: "{}" } }] }] };
  assert.equal(c.inject(parsed), true);
  assert.equal(parsed.messages[0].tool_calls[0].extra_content.google.thought_signature, "S1");
  assert.equal(c.inject(parsed), false, "idempotent — never rewrite an existing signature");

  const unknown = { messages: [{ role: "assistant", tool_calls: [{ id: "never-seen" }] }] };
  assert.equal(c.inject(unknown), false);
  assert.equal(unknown.messages[0].tool_calls[0].extra_content, undefined);

  const userOnly = { messages: [{ role: "user", content: "hi" }, { role: "assistant", content: "hello" }] };
  assert.equal(c.inject(userOnly), false);
});

test("[result17] ThoughtSignatureCache: bounded — oldest signature evicted", () => {
  const c = new ThoughtSignatureCache(2);
  for (const id of ["a", "b", "c"]) c.record([{ index: 0, id, extra_content: { google: { thought_signature: `s-${id}` } } }]);
  const bodyFor = (id) => ({ messages: [{ role: "assistant", tool_calls: [{ id }] }] });
  assert.equal(c.inject(bodyFor("a")), false, "oldest dropped at the cap");
  assert.equal(c.inject(bodyFor("b")), true);
  assert.equal(c.inject(bodyFor("c")), true);
});

test("[result17] injectThoughtSignatures: unusable bodies pass through untouched", () => {
  const c = new ThoughtSignatureCache();
  assert.equal(injectThoughtSignatures("not json", c), "not json");
  const body = JSON.stringify({ messages: [{ role: "user", content: "hi" }] });
  assert.equal(injectThoughtSignatures(body, c), body, "nothing to add → identical string");
});

test("[result17] captureThoughtSignatures: SSE split mid-event + non-streaming JSON body", async () => {
  // SSE: the id arrives in one chunk, the signature in the next (real Gemini
  // streams do split them) — and the trailing partial line must be carried over.
  const sse = new PassThrough();
  const cache = new ThoughtSignatureCache();
  captureThoughtSignatures(sse, { isStreaming: true, cache });
  sse.write('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_x"}]}}]}\n\n');
  sse.write('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"extra_con');
  sse.write('tent":{"google":{"thought_signature":"SIG-X"}}}]}}]}\n\n');
  sse.end("data: [DONE]\n\n");
  await once(sse, "end");
  const bodyX = { messages: [{ role: "assistant", tool_calls: [{ id: "call_x" }] }] };
  assert.equal(cache.inject(bodyX), true);
  assert.equal(bodyX.messages[0].tool_calls[0].extra_content.google.thought_signature, "SIG-X");

  // Non-streaming upstream: no `data:` framing at all — parsed once at 'end'.
  const json = new PassThrough();
  const cache2 = new ThoughtSignatureCache();
  captureThoughtSignatures(json, { isStreaming: false, cache: cache2 });
  json.end(
    JSON.stringify({
      choices: [{ message: { tool_calls: [{ id: "call_y", extra_content: { google: { thought_signature: "SIG-Y" } } }] } }],
    }),
  );
  await once(json, "end");
  const bodyY = { messages: [{ role: "assistant", tool_calls: [{ id: "call_y" }] }] };
  assert.equal(cache2.inject(bodyY), true);
  assert.equal(bodyY.messages[0].tool_calls[0].extra_content.google.thought_signature, "SIG-Y");
});

test("[result17] captureThoughtSignatures: a signature never lands on the previous response's tool call", async () => {
  // Both regression shapes found in review: (1) stream indexes restart per
  // response, so stale scratch state must not pair a new signature with an old
  // id; (2) a new id at the same index must not inherit an earlier signature.
  const cache = new ThoughtSignatureCache();
  const first = new PassThrough();
  captureThoughtSignatures(first, { isStreaming: true, cache });
  first.end('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_first"}]}}]}\n\n');
  await once(first, "end");

  const second = new PassThrough();
  captureThoughtSignatures(second, { isStreaming: true, cache });
  second.end('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"extra_content":{"google":{"thought_signature":"SIG-LATE"}}}]}}]}\n\n');
  await once(second, "end");

  const stale = { messages: [{ role: "assistant", tool_calls: [{ id: "call_first" }] }] };
  assert.equal(cache.inject(stale), false, "signature belongs to another function call");
  assert.equal(stale.messages[0].tool_calls[0].extra_content, undefined);

  // Same index, new id, no signature yet → must stay unsigned until its own arrives.
  cache.record([{ index: 0, id: "call_first", extra_content: { google: { thought_signature: "SA" } } }]);
  cache.record([{ index: 0, id: "call_new" }]);
  const fresh = { messages: [{ role: "assistant", tool_calls: [{ id: "call_new" }] }] };
  assert.equal(cache.inject(fresh), false, "must not inherit the previous call's signature");
  cache.record([{ index: 0, id: "call_new", extra_content: { google: { thought_signature: "SB" } } }]);
  assert.equal(cache.inject(fresh), true);
  assert.equal(fresh.messages[0].tool_calls[0].extra_content.google.thought_signature, "SB");
});

test("[result17] router: thought_signature from a streamed tool_call is re-injected on the next turn", async () => {
  // Reproduces the exact Gemini 3.x failure (400 "Function call is missing a
  // thought_signature") at the gateway level: OpenAI-shaped clients drop the field.
  const up = await mockToolUpstream();
  const auditDir = mkdtempSync(path.join(tmpdir(), "router-audit-"));
  const cfg = {
    port: 0, host: "127.0.0.1", cooldownMs: 30_000, timeoutMs: 5_000,
    upstreams: [
      { name: "sig", baseUrl: `http://127.0.0.1:${up.port()}/v1`, model: "m", geminiThoughtSignatures: true },
    ],
  };
  const pool = new UpstreamPool(cfg.upstreams, { timeoutMs: cfg.timeoutMs, cooldownMs: cfg.cooldownMs });
  const { server: router } = createRouterServer({ config: cfg, pool, auditPath: path.join(auditDir, "a.jsonl") });
  await new Promise((r) => router.listen(0, "127.0.0.1", r));
  try {
    const turn1 = await post(router, "/v1/chat/completions", { model: "m", stream: true, messages: [{ role: "user", content: "nợ bao nhiêu" }] });
    assert.equal(turn1.status, 200);
    assert.match(turn1.body, /SIG-TEST-123/, "upstream sent a signature through the router untouched");

    const turn1Body = JSON.parse(up.received()[0]);
    assert.equal(turn1Body.messages[0].tool_calls, undefined, "first request had no tool_calls to sign");

    // Second turn: the client echoes the tool_call but (like dsh) without extra_content.
    const turn2 = await post(router, "/v1/chat/completions", {
      model: "m",
      stream: true,
      messages: [
        { role: "user", content: "nợ bao nhiêu" },
        { role: "assistant", content: null, tool_calls: [{ id: "call_abc", type: "function", function: { name: "copilot_ask", arguments: "{}" } }] },
        { role: "tool", tool_call_id: "call_abc", content: '{"answer":"457875"}' },
      ],
    });
    assert.equal(turn2.status, 200);
    const sent = JSON.parse(up.received()[1]);
    assert.equal(
      sent.messages[1].tool_calls[0].extra_content.google.thought_signature,
      "SIG-TEST-123",
      "the gateway must put the signature back on the replayed function call",
    );
  } finally {
    closeAll(up, router);
  }
});
