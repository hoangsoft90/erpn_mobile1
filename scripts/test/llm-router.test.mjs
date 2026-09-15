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
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { loadConfig, UpstreamPool, upstreamUrl, createRouterServer } from "../llm-router.mjs";

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
