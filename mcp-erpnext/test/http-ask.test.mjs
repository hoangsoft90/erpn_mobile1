/**
 * Tests for the /ask HTTP wrapper (http-ask.mjs).
 *
 * Behaviour tests run against createAskServer() on an ephemeral port with the
 * REAL Python NLP service spawned (mock ERPNext — no credentials, no LLM).
 * One spawn test covers the CLI main() ready-line contract.
 *
 * NOTE: copilot-server.mjs reads NLP_SERVICE_PORT at import time, so the env
 * var is set BEFORE the dynamic import below.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

// Hermetic (result9 fix): strip leaked ERPNEXT_* from the parent shell so the
// in-process createAskServer() also resolves the MOCK target, never the real
// ERPNext — the in-process tests set NLP_SERVICE_PORT on process.env below.
for (const k of Object.keys(process.env)) {
  if (/^ERPNEXT_/.test(k)) delete process.env[k];
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const REPO = path.resolve(ROOT, "..");

/** Spawn the Python NLP bridge on an ephemeral port -> {child, port}. */
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

test("/ask wrapper: health, happy path, and error contracts", async () => {
  const nlp = await startNlpService();
  process.env.NLP_SERVICE_PORT = String(nlp.port);
  const { createAskServer } = await import("../src/http-ask.mjs");

  const server = createAskServer({ port: 0, host: "127.0.0.1" });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  try {
    // health
    const health = await fetch(`${base}/health`);
    assert.equal(health.status, 200);
    const healthBody = await health.json();
    assert.equal(healthBody.ok, true);
    assert.equal(healthBody.service, "copilot-ask");

    // happy path (mock ERPNext — same customer as copilot.test.mjs)
    const ask = await fetch(`${base}/ask`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "chị Lan còn nợ bao nhiêu" }),
    });
    assert.equal(ask.status, 200);
    const askBody = await ask.json();
    assert.equal(askBody.ok, true);
    assert.equal(askBody.result.answer, "Nguyễn Thị Lan còn nợ 2.500.000đ (1 hóa đơn chưa trả).");
    assert.equal(askBody.result.outstanding_vnd, 2_500_000);
    assert.equal(askBody.result.routed.group, "customer");
    // Phase 1 really ran (bridge over HTTP, not a stub)
    assert.ok(askBody.result.normalized.titles.includes("chị"));

    // missing text -> 400 clean JSON
    const missing = await fetch(`${base}/ask`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(missing.status, 400);
    const missingBody = await missing.json();
    assert.equal(missingBody.ok, false);
    assert.match(missingBody.error, /missing required field: text/);

    // invalid JSON -> 400 clean JSON
    const bad = await fetch(`${base}/ask`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not json",
    });
    assert.equal(bad.status, 400);
    assert.equal((await bad.json()).ok, false);

    // unknown path -> 404, shape {ok:false,error} (Flutter maps error string
    // from this shape — a bare-text 404 would become a generic network error)
    const nf = await fetch(`${base}/nope`);
    assert.equal(nf.status, 404);
    const nfBody = await nf.json();
    assert.equal(nfBody.ok, false);
    assert.match(nfBody.error, /no such path/);
    assert.match(nf.headers.get("content-type") ?? "", /application\/json/);
  } finally {
    server.close();
    nlp.child.kill();
  }
});

test("/ask CLI main(): ready line on stdout then exit on close", async () => {
  const nlp = await startNlpService();
  const child = spawn(process.execPath, [path.join(ROOT, "src", "http-ask.mjs"), "--port", "0"], {
    cwd: REPO,
    // Hermetic: strip ERPNEXT_* — this file tests the MOCK path (a leaked env
    // var from an earlier `source .env` shell flipped the target, result9 fix).
    env: Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^ERPNEXT_/.test(k))),
    stdio: ["ignore", "pipe", "inherit"],
  });
  try {
    const ready = await new Promise((resolve, reject) => {
      child.stdout.on("data", (d) => {
        try {
          resolve(JSON.parse(String(d).trim()));
        } catch {
          /* partial line */
        }
      });
      setTimeout(() => reject(new Error("no ready line")), 8000);
    });
    assert.equal(ready.ready, true);
    assert.equal(typeof ready.port, "number");
    const res = await fetch(`http://127.0.0.1:${ready.port}/health`);
    assert.equal(res.status, 200);
  } finally {
    child.kill();
    nlp.child.kill();
  }
});
