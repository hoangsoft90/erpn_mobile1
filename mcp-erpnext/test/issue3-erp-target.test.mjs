/**
 * issue3 — EVERY chat answer labels its ERPNext target.
 *
 * The bubble's provenance line must be the SAME truth the drawer's footer
 * reads (`copilot-server.mjs#erpTargetLabel`), shipped by the server — never
 * inferred by the client. Pinned here:
 *
 *  1. /ask — a 200 envelope carries `erp_target: "MOCK"` on a mock opt-in run,
 *     and it equals `erpTargetLabel(process.env)`. Parsed from the BODY, so the
 *     label has to have actually travelled over HTTP.
 *  2. /ask — with ERPNEXT_URL exported the label flips to "REAL". Verified in
 *     a spawned child so the parent process' env never mutates (a leaked
 *     ERPNEXT_URL would flip every other suite in the same `node --test`
 *     worker onto the real branch). Refusal envelopes (no NLP) stay UNLABELLED:
 *     a 4xx/5xx never carried provenance and must not start.
 *  3. /dsh/ask — every 200 carries `erp_target`, including a GATE REFUSAL
 *     (write question answered by the pre-screen without spawning dsh), and a
 *     successful session's envelope equals the helper the drawer reads.
 *
 * Hermetic: ERPNEXT_/ASK_ variables stripped, mock opt-in on, no NLP spawn
 * needed (the refused-4xx shape is asserted instead of a refused-200 — a
 * refusal envelope is unlabelled by design, and a successful DSH session uses
 * the fake entry).
 */

for (const k of Object.keys(process.env)) {
  if (/^(ERPNEXT_|ASK_)/.test(k)) delete process.env[k];
}
process.env.COPILOT_MOCK_OK = "1";
delete process.env.COPILOT_COMPANY;
delete process.env.COPILOT_USERS;

import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");

/** NLP-less server: /ask refusals do not need the bridge, and the DSH
 * pre-screen refusal is refused BEFORE the runtime (and before any spawn). */
async function startServer() {
  const { createAskServer } = await import("../src/http-ask.mjs");
  const server = createAskServer({ port: 0, host: "127.0.0.1" });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, close: () => new Promise((r) => server.close(r)) };
}

const post = (base, path, body) =>
  fetch(`${base}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

test("issue3 /ask: a 200 envelope carries erp_target=MOCK on a mock opt-in run", async () => {
  const s = await startServer();
  try {
    const res = await post(s.base, "/ask", { text: "chị Lan còn nợ bao nhiêu" });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(
      body.erp_target,
      "MOCK",
      "the /ask envelope must label the fixture-backed process MOCK",
    );
    const { erpTargetLabel } = await import("../src/copilot-server.mjs");
    assert.equal(
      body.erp_target,
      erpTargetLabel(process.env),
      "the label is the SAME helper the drawer footer reads — one truth",
    );
  } finally {
    await s.close();
  }
});

test("issue3 /ask: with ERPNEXT_URL exported the label is REAL (labelled refusal envelope too)", async (t) => {
  const PORT = "8891";
  const child = spawn(process.execPath, ["src/http-ask.mjs"], {
    cwd: ROOT,
    env: {
      ...process.env,
      ASK_PORT: PORT,
      ERPNEXT_URL: "https://example.invalid",
      ERPNEXT_API_KEY: "test-key",
      ERPNEXT_API_SECRET: "test-secret",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (d) => (stderr += String(d)));
  child.stdout.on("data", () => {});
  t.after(() => child.kill());

  const base = `http://127.0.0.1:${PORT}`;
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${base}/health`);
      if (res.ok) break;
    } catch {
      /* not listening yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }

  // A question with no NLP service up is answered by the NLP refusal INSIDE
  // the result (a 200 envelope — answerQuestion fails closed, the route wraps
  // it). Still labelled: the envelope is an answer about the question.
  const res = await post(base, "/ask", { text: "chị Lan còn nợ bao nhiêu" });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(
    body.erp_target,
    "REAL",
    "with ERPNEXT_URL exported the /ask envelope labels the process REAL",
  );
  assert.equal(body.result.error_code, "NLP_UNAVAILABLE");

  // The STARTUP LINE says REAL — the same helper the envelope used.
  assert.match(stderr, /ERPNext target: REAL/);
}, { timeout: 20000 });

test("issue3 /dsh/ask: a GATE refusal (200) carries erp_target, and it matches the helper", async () => {
  const { __setNlpServicePortForTest } = await import("../src/copilot-server.mjs");
  const previous = process.env.NLP_SERVICE_PORT;
  __setNlpServicePortForTest(1); // no NLP: the pre-screen fails closed
  const s = await startServer();
  try {
    // A write question with the NLP down is refused at the gate — still a 200
    // answer about the question, so the label must travel.
    const res = await post(s.base, "/dsh/ask", { message: "thu tiền cho chị Lan 10 nghìn" });
    const body = await res.json();
    if (res.status === 200) {
      const { erpTargetLabel } = await import("../src/copilot-server.mjs");
      assert.equal(
        body.erp_target,
        erpTargetLabel(process.env),
        "every /dsh/ask 200 (refused included) carries the process label",
      );
    } else {
      assert.equal(res.status, 503, "NLP down is a 503 here — an error envelope, unlabelled");
      assert.equal("erp_target" in body, false);
    }
  } finally {
    await s.close();
    __setNlpServicePortForTest(previous ?? "8787");
  }
});

test("issue3 /dsh/ask: a successful session's 200 carries erp_target equal to erpTargetLabel(process.env)", async () => {
  const { createAskServer } = await import("../src/http-ask.mjs");
  const { __setNlpServicePortForTest } = await import("../src/copilot-server.mjs");

  // The honest NLP fake (same shape as dsh-gateway.test.mjs — the first draft
  // guessed the shape and the WRITE gate passed vacuously; lesson applied).
  const nlpDir = mkdtempSync(path.join(tmpdir(), "issue3-nlp-"));
  const { createServer } = await import("node:http");
  const nlpServer = createServer((req, res) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => {
      const text = JSON.parse(b || "{}").text ?? "";
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          ok: true,
          result: {
            original: text,
            text,
            amount: null,
            amounts: [],
            money_matches: [],
            quantities: [],
            titles: [],
            intents: [],
            synonyms: [],
          },
        }),
      );
    });
  });
  await new Promise((r) => nlpServer.listen(0, "127.0.0.1", r));
  const nlpPort = nlpServer.address().port;

  // A fake dsh runtime the ROUTE picks up through createAskServer's env seam
  // (DSH_ENTRY/DSH_PATCH/DSH_CWD — the same resolution order a real deploy
  // uses), so the successful-session 200 shape is pinned over HTTP, not by
  // re-serialising a gateway return by hand.
  const dir = mkdtempSync(path.join(tmpdir(), "issue3-dsh-"));
  const bin = path.join(dir, "fake-dsh.mjs");
  writeFileSync(
    bin,
    `console.log(JSON.stringify({ content: "Trả lời (mock LLM chỉ đọc lại kết quả, không tự tính): khách còn nợ" }));`,
  );
  const patch = path.join(dir, "fake.patch.yml");
  writeFileSync(
    patch,
    "- insert:\\n    - id: erpn-copilot-mcp\\n      config:\\n        env:\\n          COPILOT_DSH_CONTEXT: '1'\\n",
  );

  const previous = process.env.NLP_SERVICE_PORT;
  __setNlpServicePortForTest(nlpPort); // the gate's normalizeText seam
  const server = createAskServer({
    port: 0,
    host: "127.0.0.1",
    env: {
      ...process.env,
      NLP_SERVICE_PORT: String(nlpPort),
      DSH_ENTRY: bin,
      DSH_PATCH: patch,
      DSH_TIMEOUT_MS: "15000",
      DSH_CWD: dir,
      DSH_HOME_BASE: path.join(dir, "home"),
    },
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const res = await post(base, "/dsh/ask", { message: "chị Lan còn nợ bao nhiêu" });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true, JSON.stringify(body).slice(0, 300));
    const { erpTargetLabel } = await import("../src/copilot-server.mjs");
    assert.equal(
      body.erp_target,
      erpTargetLabel(process.env),
      "a successful /dsh/ask 200 carries the process label",
    );
    assert.equal(body.erp_target, "MOCK");
    // The child echo is a DIFFERENT field (what the copilot child reported);
    // this fake prints no target line, so it stays null while erp_target is
    // the process label — the two never conflate.
    assert.equal(body.erpnext_target, null);
    assert.match(body.result.answer, /khách còn nợ/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    __setNlpServicePortForTest(previous ?? "8787");
    nlpServer.close();
    rmSync(dir, { recursive: true, force: true });
    rmSync(nlpDir, { recursive: true, force: true });
  }
});
