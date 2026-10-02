/**
 * next8 / D4 — acceptance table (plan_final_v3 §11) executed, not asserted.
 *
 * Pins the T-cases NOT already pinned by D1–D3 suites:
 *
 *   T4   1 match (exact) ⇒ detail directly, NO picker (`candidates: []`).
 *   T4b  item fuzzy-single READ ⇒ auto-select per policy, NO chips.
 *   T5   0 match ⇒ MISSING / SUPPLIER_NOT_FOUND — never an invented entity.
 *   T10  a picker is WAITING and the user asks a NEW clear business question
 *        (`doanh thu hôm nay`) ⇒ the NEW intent is processed normally (no
 *        bailout code, no inherited candidates).
 *   T13  a WRITE with an ambiguous party AND the amount said ⇒ handoff keeps
 *        the amount in the sentence context (candidates ask WHO, the amount is
 *        not lost — the pipeline's own refusal shape).
 *
 * T1/T2/T3/T9 → next8-entity-pick · T11/T12/T14 → next8-picker-safety ·
 * T15/T16 → Flutter next8_picker_safety · T6/T7/T8 → next8-d3-shared.
 * Same harness discipline: createAskServer + real NLP + mock ERP, env stripped.
 */

import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

for (const k of Object.keys(process.env)) {
  if (/^(ERPNEXT_|ASK_)/.test(k)) delete process.env[k];
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");

async function startNlpService() {
  const { spawn } = await import("node:child_process");
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

async function withServer(opts = {}, fn) {
  if (typeof opts === "function") { fn = opts; opts = {}; }
  const nlp = await startNlpService();
  const { __setNlpServicePortForTest } = await import("../src/copilot-server.mjs");
  const previousPort = process.env.NLP_SERVICE_PORT;
  let server = null;
  try {
    process.env.NLP_SERVICE_PORT = String(nlp.port);
    __setNlpServicePortForTest(nlp.port);
    const { createAskServer } = await import("../src/http-ask.mjs");
    // `env` seam (createAskServer's own config surface): T10's revenue question
    // needs a pinned COPILOT_COMPANY — without it the pipeline answers
    // COMPANY_SCOPE_REQUIRED (the correct refusal), not a revenue answer.
    const env = opts.env
      ? { ...process.env, ...opts.env }
      : process.env;
    server = createAskServer({ port: 0, host: "127.0.0.1", env });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    return await fn({ base: `http://127.0.0.1:${server.address().port}` });
  } finally {
    server?.close();
    nlp.child.kill();
    __setNlpServicePortForTest(previousPort ?? "8787");
  }
}

const askPost = (base, body) =>
  fetch(`${base}/ask`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

test("D4 T4 — a supplier question with EXACTLY ONE match answers directly, no picker", async () => {
  await withServer(async ({ base }) => {
    // "Anh Bảy" is one row; the longest-name rule resolves it directly.
    const res = await askPost(base, { text: "nhà cung cấp anh bảy" });
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.result.error_code, undefined, JSON.stringify(body.result).slice(0, 300));
    assert.deepEqual(
      body.result.candidates ?? [],
      [],
      "T4: one match ⇒ no picker is offered",
    );
    assert.equal(body.result.supplier?.id, "SUP-BAY");
    assert.ok(body.result.answer, "the detail answer is returned");
  });
});

test("D4 T4b — an item question with ONE match auto-selects (policy), no chips", async () => {
  await withServer(async ({ base }) => {
    const res = await askPost(base, { text: "tồn kho cám gà" });
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.result.error_code, undefined, JSON.stringify(body.result).slice(0, 300));
    assert.deepEqual(
      body.result.candidates ?? [],
      [],
      "T4b: a fuzzy-single READ auto-selects (stock.balance policy), no chips",
    );
    assert.equal(body.result.proposal?.entity?.id, "CAM-GA-10KG");
  });
});

test("D4 T5 — a question naming NOTHING real refuses, never invents an entity", async () => {
  await withServer(async ({ base }) => {
    const s = await askPost(base, { text: "nhà cung cấp phương nam" });
    const sBody = await s.json();
    assert.equal(sBody.result.error_code, "SUPPLIER_NOT_FOUND");
    assert.deepEqual(sBody.result.candidates ?? [], [], "no candidate is invented");
    assert.equal(sBody.result.supplier ?? null, null);

    const c = await askPost(base, { text: "công nợ của người không tồn tại" });
    const cBody = await c.json();
    assert.equal(cBody.result.error_code, "MISSING_ENTITY");
    assert.equal(cBody.result.customer ?? null, null);
  });
});

test("D4 T10 — WAITING + a NEW clear business question is processed, never a bailout", async () => {
  await withServer({ env: { COPILOT_COMPANY: "DFC" } }, async ({ base }) => {
    // The picker is up (ambiguous supplier question).
    const s1 = await askPost(base, { text: "nhà cung cấp tiên" });
    const s1Body = await s1.json();
    assert.equal(s1Body.result.error_code, "AMBIGUOUS_SUPPLIER");

    // A clear NEW business intent: answered normally — not PICKER_BAILOUT, not
    // the old picker, and carrying none of the old supplier candidates.
    const s2 = await askPost(base, { text: "doanh thu hôm nay" });
    const s2Body = await s2.json();
    assert.notEqual(s2Body.result.error_code, "PICKER_BAILOUT");
    assert.notEqual(s2Body.result.error_code, "AMBIGUOUS_SUPPLIER");
    assert.deepEqual(
      s2Body.result.candidates ?? [],
      [],
      "T10: the new intent inherits nothing from the stale picker",
    );
    assert.ok(
      s2Body.result.answer || s2Body.result.rows,
      "the revenue question gets a real answer",
    );
  });
});

test("D4 T13 — a WRITE with an ambiguous party keeps the amount in the question context", async () => {
  await withServer(async ({ base }) => {
    // Two customers share the name; the amount is in the sentence. The handoff
    // refuses with the picker and the reason QUOTES the amount-bearing text —
    // the amount is not lost with the party (the pick resumes the SAME sentence).
    const res = await askPost(base, { text: "thu tiền cho chị Lan 10000" });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.result.error_code, "ENTITY_PICK_REQUIRED");
    assert.ok(body.result.candidates?.length >= 1, "the picker asks WHO");
    assert.match(
      body.result.question ?? "",
      /10000/,
      "the amount travels inside the resumed question (pick re-sends it verbatim)",
    );
  });
});
