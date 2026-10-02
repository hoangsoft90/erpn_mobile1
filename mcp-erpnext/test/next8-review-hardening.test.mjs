/**
 * next8 / Review hardening — find-bugs L1/L2/L4 (openspec/changes/next8-review-hardening).
 *
 * Pins the boundary contract the second next8 review asked for:
 *
 *   T-A  /ask refuses an over-long entity_id with the SAME 400 shape
 *        /dsh/ask has (RED before the fix: /ask parsed it uncapped and
 *        let the 141+ char id reach the pipeline's refusal copy/stderr).
 *   T-B  an id of exactly 140 chars passes BOTH boundaries and keeps the
 *        ordinary behaviour (no cap regression for in-contract ids).
 *   T-C  an ambiguous-item answer makes NO always-failing
 *        set("item", {id:null}) attempt — no "session context write
 *        refused" stderr noise when there is nothing to remember
 *        (RED before the fix: one guaranteed-refused call per question).
 *   T-D  /dsh/ask keeps its 400 (pin against drift — green already).
 *
 * Runs against createAskServer() on an ephemeral port with the REAL Python
 * NLP service (mock ERPNext — no credentials, no LLM). Same hermetic env
 * discipline as next8-entity-pick.test.mjs.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

for (const k of Object.keys(process.env)) {
  if (/^(ERPNEXT_|ASK_)/.test(k)) delete process.env[k];
}
// Same opt-in discipline as p44/p42 suites: this file is also run directly
// (node --test), so it must not depend on `npm test` setting COPILOT_MOCK_OK.
process.env.COPILOT_MOCK_OK = "1";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");

async function startNlpService() {
  const REPO = path.resolve(ROOT, "..");
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

async function withServer(fn) {
  const nlp = await startNlpService();
  const { __setNlpServicePortForTest } = await import("../src/copilot-server.mjs");
  const previousPort = process.env.NLP_SERVICE_PORT;
  let server = null;
  try {
    process.env.NLP_SERVICE_PORT = String(nlp.port);
    __setNlpServicePortForTest(nlp.port);
    const { createAskServer } = await import("../src/http-ask.mjs");
    server = createAskServer({ port: 0, host: "127.0.0.1" });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    return await fn({ base: `http://127.0.0.1:${server.address().port}` });
  } finally {
    server?.close();
    nlp.child.kill();
    __setNlpServicePortForTest(previousPort ?? "8787");
  }
}

const post = (base, route, body) =>
  fetch(`${base}${route}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

test("T-A — /ask refuses an over-long entity_id with /dsh/ask's 400 shape", async () => {
  await withServer(async ({ base }) => {
    const res = await post(base, "/ask", {
      text: "nhà cung cấp tiên",
      entity_id: "X".repeat(141),
    });
    assert.equal(res.status, 400, "the boundary refuses before the pipeline runs");
    const body = await res.json();
    assert.equal(body.ok, false);
    assert.equal(body.code, "DSH_GATEWAY_BAD_REQUEST");
    assert.equal(body.error, "entity_id không hợp lệ");
  });
});

test("T-B — a 140-char entity_id passes both boundaries, ordinary behaviour stands", async () => {
  await withServer(async ({ base }) => {
    // /ask: the capped-but-legal id is re-validated against the fresh list
    // (not held) ⇒ ENTITY_PICK_STALE — the cap never answers for in-contract ids.
    const res = await post(base, "/ask", {
      text: "nhà cung cấp tiên",
      entity_id: "S".repeat(140),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.result.error_code, "ENTITY_PICK_STALE");

    // /dsh/ask: the id passes the boundary into the handoff (200 + handoff) —
    // the pipeline then refuses it (the id names nobody), never a 400.
    const dsh = await post(base, "/dsh/ask", {
      message: "thu tiền cho ai đó lạ lẫm hoàn toàn 10000",
      entity_id: "C".repeat(140),
    });
    assert.equal(dsh.status, 200);
    const dshBody = await dsh.json();
    assert.equal(dshBody.ok, true);
    assert.equal(dshBody.handoff, "payment.create");
  });
});

test("T-C — an ambiguous-item answer makes no always-failing context write attempt", async () => {
  await withServer(async ({ base }) => {
    const records = [];
    const original = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk, ...rest) => {
      records.push(String(chunk));
      return original(chunk, ...rest);
    };
    let body;
    try {
      const res = await post(base, "/ask", { text: "tồn kho cám" });
      assert.equal(res.status, 200);
      body = await res.json();
    } finally {
      process.stderr.write = original;
    }
    // The branch really ran (ambiguous + chips), but there is nothing to
    // remember before a pick — so no "session context write refused" line.
    assert.ok(body.result.candidates?.length >= 2, "the ambiguous picker is offered");
    assert.ok(
      !records.some((line) => line.includes("session context write refused")),
      `stderr must carry no context-write noise; saw: ${records.join(" | ").slice(0, 400)}`,
    );
  });
});

test("T-D — /dsh/ask keeps its 400 for an over-long entity_id (drift guard)", async () => {
  await withServer(async ({ base }) => {
    const res = await post(base, "/dsh/ask", {
      message: "nhà cung cấp tiên",
      entity_id: "X".repeat(141),
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.ok, false);
    assert.equal(body.code, "DSH_GATEWAY_BAD_REQUEST");
    assert.equal(body.error, "entity_id không hợp lệ");
  });
});
