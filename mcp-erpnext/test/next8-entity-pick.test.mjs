/**
 * next8 — entity selection loop (openspec/changes/next8-entity-selection-loop).
 *
 * Pins the invariant plan_final_v3 §9 states: after a picker selection, the next
 * response about the same question MUST NOT be another picker for the same kind.
 *
 *   (a) an ambiguous supplier question returns the picker
 *   (b) re-asking the SAME sentence WITH the picked id resolves that supplier —
 *       THE LOOP REGRESSION (red before the fix: the supplier branch ignored
 *       pickedEntityId, so S2 === S1 — D0 probe verbatim)
 *   (c) an id that is NOT in the list the server just read is refused — a hint,
 *       never authority (D2: ENTITY_PICK_STALE with its own Vietnamese copy —
 *       the entity may have been DELETED between picker and tap; the fresh
 *       picker stands, refusal logged to stderr)
 *   (d) the AI route (/dsh/ask) carries the pick id into the handoff — same
 *       contract the ordinary /ask has (red before the fix: the handoff branch
 *       did not pass pickedEntityId)
 *
 * Runs against createAskServer() on an ephemeral port with the REAL Python NLP
 * service spawned (mock ERPNext — no credentials, no LLM). Same hermetic env
 * discipline as http-ask.test.mjs / next7-a0-dsh-write-handoff.test.mjs.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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

const askPost = (base, body) =>
  fetch(`${base}/ask`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

test("next8 supplier picker: selection resumes by id and never re-offers the picker (the loop)", async () => {
  await withServer(async ({ base }) => {
    // (a) two mock suppliers share the fragment "tiên" ("Hà Tiên", "Hà Tiên 2")
    //     and neither name is an exact hit ⇒ ambiguous + picker.
    const s1 = await askPost(base, { text: "nhà cung cấp tiên" });
    assert.equal(s1.status, 200);
    const s1Body = await s1.json();
    assert.equal(s1Body.ok, true);
    assert.equal(s1Body.result.error_code, "AMBIGUOUS_SUPPLIER");
    assert.equal(s1Body.result.candidates?.length, 2, "the picker is offered");
    const pickedId = s1Body.result.candidates[0].id;
    assert.equal(pickedId, "SUP-HATIEN");

    // (b) THE LOOP REGRESSION — the picker tap re-sends the SAME sentence with
    //     the picked id (chat pickEntity contract). The server must resolve
    //     that supplier; returning the same ambiguous picker is the bug.
    const s2 = await askPost(base, { text: "nhà cung cấp tiên", entity_id: pickedId });
    assert.equal(s2.status, 200);
    const s2Body = await s2.json();
    assert.equal(s2Body.ok, true);
    assert.equal(
      s2Body.result.error_code,
      undefined,
      "a valid pick must not answer with the ambiguous refusal again",
    );
    assert.equal(s2Body.result.supplier?.id, pickedId, "the picked supplier id is honoured");
    assert.deepEqual(
      s2Body.result.candidates ?? [],
      [],
      "the resolved answer must NOT re-offer the picker (no loop)",
    );
    assert.ok(s2Body.result.answer, "the ordinary detail answer is returned");
  });
});

test("next8 supplier picker: an id outside the freshly-read list is refused, refusal preserved", async () => {
  await withServer(async ({ base }) => {
    const s1 = await askPost(base, { text: "nhà cung cấp tiên" });
    const s1Body = await s1.json();
    assert.equal(s1Body.result.error_code, "AMBIGUOUS_SUPPLIER");

    // A crafted id the server's own list does not contain: the client hint
    // can never introduce an ERPNext id (§4.2) — D2 upgrades the reading from
    // a bare ambiguous repeat to ENTITY_PICK_STALE ("chọn lại từ danh sách")
    // with the FRESH picker still standing: lỗi rõ, không loop.
    const s2 = await askPost(base, { text: "nhà cung cấp tiên", entity_id: "SUP-99999" });
    const s2Body = await s2.json();
    assert.equal(s2Body.result.error_code, "ENTITY_PICK_STALE");
    assert.deepEqual(s2Body.result.candidates, s1Body.result.candidates);
    assert.equal(s2Body.result.supplier ?? null, null);
  });
});

test("next8 supplier picker: a refused pick is LOGGED server-side, not dropped silently", async () => {
  await withServer(async ({ base }) => {
    // Capture stderr while the route answers: the customer path writes
    // `[copilot] entity pick refused: …` (copilot-server L1274); the supplier
    // path must meet the same convention (plan rule: no silent drop).
    const records = [];
    const original = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk, ...rest) => {
      records.push(String(chunk));
      return original(chunk, ...rest);
    };
    try {
      const res = await askPost(base, { text: "nhà cung cấp tiên", entity_id: "SUP-99999" });
      assert.equal(res.status, 200);
    } finally {
      process.stderr.write = original;
    }
    assert.ok(
      records.some((line) => line.includes("entity pick refused") && line.includes("SUP-99999")),
      `stderr must name the refused id; saw: ${records.join(" | ").slice(0, 400)}`,
    );
  });
});

test("next8 AI mode: the handoff carries the pick id (same contract as /ask)", async () => {
  await withServer(async ({ base }) => {
    const message = "thu tiền cho ai đó lạ lẫm hoàn toàn 10000";
    // Turn 1: a WRITE handoff whose party resolves to nobody ⇒ clarification
    // with the customer picker offer (candidates from the fuzzy resolver).
    const d1 = await fetch(`${base}/dsh/ask`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message }),
    });
    assert.equal(d1.status, 200);
    const d1Body = await d1.json();
    assert.equal(d1Body.ok, true);
    assert.equal(d1Body.handoff, "payment.create");
    assert.equal(d1Body.result.error_code, "MISSING_ENTITY");
    assert.equal(d1Body.result.proposal ?? null, null);

    // Turn 2 — the picker tap in AI mode: SAME message + entity_id. The
    // handoff must pass the id to the pipeline (pickedEntityId), which
    // consumes it on the customer path ⇒ the ordinary proposal appears.
    const d2 = await fetch(`${base}/dsh/ask`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message, entity_id: "CUST-00001" }),
    });
    assert.equal(d2.status, 200);
    const d2Body = await d2.json();
    assert.equal(d2Body.ok, true);
    assert.equal(d2Body.handoff, "payment.create");
    assert.ok(d2Body.result?.proposal, "the picked id completes the party ⇒ proposal");
    assert.equal(
      d2Body.result.proposal.entity?.id,
      "CUST-00001",
      "the proposal binds exactly the picked id (Rule C: bind exact ID)",
    );
  });
});
