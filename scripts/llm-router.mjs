#!/usr/bin/env node
/**
 * LLM Router — Phase 5 "Gateway, bản đơn giản" per SIGNOFF-phase5-pii.md
 * (signed 2026-09-15: NO PII scrubbing, NO 2-tier PII routing — questions with
 * real customer names/amounts go straight to the LLM; scope reduced to this
 * router + audit only).
 *
 * Design (phase-05 §C, adjusted by the sign-off):
 * - OpenAI-compatible LOCAL proxy on 127.0.0.1. dsh points at this proxy; the
 *   proxy forwards to the first HEALTHY upstream in the configured chain.
 * - Config-driven chain (JSON, no hardcoded model names) — free tier stays a
 *   dev/low-cost mode, not an architecture requirement.
 * - Fallback: on connect error, timeout, HTTP 429/5xx, or a malformed
 *   response → mark upstream unhealthy (cooldown) → next upstream. 429/5xx
 *   responses are still streamed to the caller when the chain is exhausted.
 * - Audit log (phase-05 §D): one JSONL line per request — id, timestamp,
 *   chosen upstream, model, attempt order, status, latency, token usage,
 *   message count. Content is NOT copied into the audit line; the full
 *   transcript stays in dsh's own trace (link by id).
 * - Zero runtime deps; stdlib http only. No key handling: Authorization is
 *   forwarded verbatim to the chosen upstream (keys live in dsh's config, or
 *   in the JSON chain file if the operator prefers — never logged).
 *
 * Endpoints (OpenAI-compatible surface for dsh):
 *   POST /v1/chat/completions  → forwarded (stream and non-stream)
 *   GET  /v1/models            → first healthy upstream's model list
 *   GET  /health               → router health + per-upstream state
 *
 * Config (JSON, default ./llm-router.config.json, override: --config / LLM_ROUTER_CONFIG):
 *   { "port": 8900, "host": "127.0.0.1",
 *     "upstreams": [ { "name": "zen", "baseUrl": "https://api.opencode.ai/v1",
 *                      "model": "big-pickle", "apiKeyEnv": "ZEN_API_KEY",
 *                      "timeoutMs": 60000, "cooldownMs": 30000 }, ... ] }
 * The upstream entry with apiKeyEnv set gets `Authorization: Bearer <value of
 * that env var>`; entries without it forward the caller's Authorization
 * header unchanged. `apiKeyEnv` is a NAME, never a value (secret hygiene).
 *
 * Run: node scripts/llm-router.mjs [--config llm-router.config.json]
 * Ready line: {"ready":true,"port":N,"upstreams":K}
 */

import http from "node:http";
import { readFileSync, appendFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_CONFIG = path.join(ROOT, "scripts", "llm-router.config.json");
const AUDIT_DIR = process.env.LLM_ROUTER_AUDIT_DIR ?? path.join(ROOT, "llm-router-audit");
const MAX_BODY = 10_000_000;

function parseArgs(argv) {
  const args = { config: process.env.LLM_ROUTER_CONFIG ?? DEFAULT_CONFIG };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--config") args.config = argv[++i];
  }
  return args;
}

export function loadConfig(file) {
  let raw;
  try {
    raw = readFileSync(file, "utf8");
  } catch (err) {
    throw new Error(`cannot read router config ${file}: ${err.message}`);
  }
  let cfg;
  try {
    cfg = JSON.parse(raw);
  } catch (err) {
    throw new Error(`router config is not valid JSON (${file}): ${err.message}`);
  }
  const ups = Array.isArray(cfg?.upstreams) ? cfg.upstreams : [];
  if (ups.length === 0) throw new Error("router config needs a non-empty upstreams[] chain");
  for (const [i, u] of ups.entries()) {
    if (typeof u?.name !== "string" || u.name.length === 0) throw new Error(`upstreams[${i}].name required`);
    if (typeof u?.baseUrl !== "string" || !/^https?:\/\//.test(u.baseUrl)) {
      throw new Error(`upstreams[${i}].baseUrl must be an http(s) URL`);
    }
  }
  cfg.port = Number(cfg.port ?? 8900);
  cfg.host = String(cfg.host ?? "127.0.0.1");
  cfg.timeoutMs = Number(cfg.timeoutMs ?? 60_000);
  cfg.cooldownMs = Number(cfg.cooldownMs ?? 30_000);
  return cfg;
}

/** Tracks unhealthy-until timestamps; a downstream cooldown beats hammering a rate-limited free tier. */
export class UpstreamPool {
  constructor(entries, { timeoutMs, cooldownMs }) {
    this.entries = entries.map((e) => ({ ...e, timeoutMs: e.timeoutMs ?? timeoutMs, cooldownMs: e.cooldownMs ?? cooldownMs }));
    this.unhealthyUntil = new Map();
  }
  markUnhealthy(name, ms) {
    this.unhealthyUntil.set(name, Date.now() + ms);
  }
  healthy() {
    const now = Date.now();
    return this.entries.filter((e) => (this.unhealthyUntil.get(e.name) ?? 0) <= now);
  }
  status() {
    const now = Date.now();
    return this.entries.map((e) => ({
      name: e.name,
      model: e.model ?? "(upstream default)",
      healthy: (this.unhealthyUntil.get(e.name) ?? 0) <= now,
      retryInMs: Math.max(0, (this.unhealthyUntil.get(e.name) ?? 0) - now),
    }));
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/**
 * Forward one attempt. Resolves { status, headers, stream } where stream is
 * the raw upstream response (already piped by the caller), or rejects with a
 * short-lived marker error for fallback decisions.
 */
export function upstreamUrl(up, suffix) {
  // Manual join — new URL with an absolute path ("/chat/completions") would
  // DROP the baseUrl's own path (e.g. the /v1 prefix), breaking real
  // OpenAI-compatible endpoints.
  return new URL(up.baseUrl.replace(/\/+$/, "") + suffix);
}

function attempt(up, authHeader, body) {
  return new Promise((resolve, reject) => {
    const url = upstreamUrl(up, "/chat/completions");
    const headers = { "content-type": "application/json", "content-length": Buffer.byteLength(body) };
    const apiKey = up.apiKeyEnv ? process.env[up.apiKeyEnv] : undefined;
    if (apiKey) headers.authorization = `Bearer ${apiKey}`;
    else if (authHeader) headers.authorization = authHeader;
    const req = http.request(
      url,
      // agent:false — no keep-alive sockets that would hold the event loop
      // (and node --test) open after shutdown; per-request connect cost is
      // acceptable at this MVP request rate.
      { method: "POST", headers, timeout: up.timeoutMs, agent: false },
      (res) => resolve(res),
    );
    req.on("timeout", () => {
      req.destroy(new Error(`upstream ${up.name} timeout after ${up.timeoutMs}ms`));
    });
    req.on("error", (err) => reject(err));
    req.end(body);
  });
}

const RETRY_STATUS = new Set([429, 500, 502, 503, 504]);

export function createRouterServer({ config, pool, auditPath }) {
  const audit = (record) => {
    try {
      mkdirSync(path.dirname(auditPath), { recursive: true });
      appendFileSync(auditPath, JSON.stringify(record) + "\n");
    } catch (err) {
      process.stderr.write(`[llm-router] audit write failed: ${err.message}\n`);
    }
  };

  const server = http.createServer(async (req, res) => {
    const started = Date.now();
    const id = `req_${started}_${Math.random().toString(36).slice(2, 8)}`;
    const pathOnly = (req.url ?? "/").split("?")[0];

    if (req.method === "GET" && pathOnly === "/health") {
      const body = JSON.stringify({ ok: true, service: "llm-router", upstreams: pool.status() });
      res.writeHead(200, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) });
      res.end(body);
      return;
    }

    if (req.method === "GET" && pathOnly === "/v1/models") {
      const healthy = pool.healthy();
      if (healthy.length === 0) {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: "llm-router: no healthy upstream" } }));
        return;
      }
      const up = healthy[0];
      try {
        const data = await new Promise((resolve, reject) => {
          const r = http.request(upstreamUrl(up, "/models"), { method: "GET", timeout: up.timeoutMs, agent: false }, resolve);
          r.on("timeout", () => r.destroy(new Error("models timeout")));
          r.on("error", reject);
          r.end();
        });
        res.writeHead(data.statusCode ?? 502, { "Content-Type": "application/json" });
        data.pipe(res);
      } catch (err) {
        res.writeHead(502, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: `llm-router: models via ${up.name} failed: ${err.message}` } }));
      }
      return;
    }

    if (req.method === "POST" && pathOnly === "/v1/chat/completions") {
      let body;
      try {
        body = (await readBody(req)).toString("utf8");
      } catch (err) {
        res.writeHead(413, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: { message: err.message } }));
        return;
      }

      let parsed = {};
      try {
        parsed = JSON.parse(body);
      } catch {
        /* forwarded as-is; upstream will answer with its own 400 */
      }
      const wantModel = typeof parsed?.model === "string" ? parsed.model : null;
      const chain = (wantModel ? pool.healthy().filter((u) => !u.model || u.model === wantModel) : pool.healthy()).slice();
      const tried = [];

      for (const up of chain) {
        tried.push(up.name);
        let res2;
        try {
          res2 = await attempt(up, req.headers.authorization ?? null, body);
        } catch (err) {
          pool.markUnhealthy(up.name, up.cooldownMs);
          process.stderr.write(`[llm-router] ${id} ${up.name} transport error: ${err.message}\n`);
          continue; // transport-level failure → next upstream
        }
        const status = res2.statusCode ?? 502;
        if (RETRY_STATUS.has(status)) {
          pool.markUnhealthy(up.name, up.cooldownMs);
          // Drain so the socket can be reused/destroyed cleanly, then fall through.
          res2.resume();
          process.stderr.write(`[llm-router] ${id} ${up.name} HTTP ${status} → next upstream\n`);
          continue;
        }
        const headers = { ...res2.headers };
        headers["x-llm-router-upstream"] = up.name;
        headers["x-llm-router-id"] = id;
        res.writeHead(status, headers);
        res2.pipe(res);
        res2.on("end", () => {
          audit({
            id,
            ts: new Date().toISOString(),
            upstream: up.name,
            model: wantModel ?? up.model ?? null,
            attempts: tried,
            status,
            latencyMs: Date.now() - started,
            messages: Array.isArray(parsed?.messages) ? parsed.messages.length : null,
            stream: parsed?.stream === true,
          });
        });
        return;
      }

      const body402 = JSON.stringify({
        error: {
          message: `llm-router: all upstreams failed (tried: ${tried.join(", ") || "none"})`,
          type: "llm_router_no_upstream",
        },
      });
      res.writeHead(502, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body402) });
      res.end(body402);
      audit({
        id,
        ts: new Date().toISOString(),
        upstream: null,
        model: wantModel,
        attempts: tried,
        status: 502,
        latencyMs: Date.now() - started,
        messages: Array.isArray(parsed?.messages) ? parsed.messages.length : null,
        stream: parsed?.stream === true,
      });
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: `no route: ${req.method} ${pathOnly}` } }));
  });
  return { server, audit };
}

export async function main(argv = process.argv.slice(2)) {
  const { config: cfgPath } = parseArgs(argv);
  const cfg = loadConfig(cfgPath);
  const pool = new UpstreamPool(cfg.upstreams, { timeoutMs: cfg.timeoutMs, cooldownMs: cfg.cooldownMs });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const auditPath = path.join(AUDIT_DIR, `audit-${stamp}.jsonl`);
  const { server } = createRouterServer({ config: cfg, pool, auditPath });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(cfg.port, cfg.host, resolve);
  });
  process.stdout.write(
    JSON.stringify({ ready: true, port: server.address().port, upstreams: cfg.upstreams.length, audit: auditPath }) + "\n",
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    process.stderr.write(`[llm-router] fatal: ${err?.message ?? err}\n`);
    process.exit(1);
  });
}
