/**
 * A0 — WRITE handoff (openspec/changes/next7-a0-dsh-write-handoff).
 *
 * Dedicated file (the shared route test pins the happy handoff + slot gap; this
 * one pins the rules that make the handoff SAFE):
 *
 *   1. The metering parity — a handoff proposal charges the WRITE budget, and
 *      an exhausted budget denies the card (never "AI mode is the cheap way").
 *   2. The proposal carries the RESOLVED id (A7) — not just a display name.
 *   3. A non-payment WRITE is refused (DSH_WRITE_BLOCKED) at the route — the
 *      handoff set is explicit, not "everything write-shaped".
 *
 * Runs against createAskServer() on an ephemeral port with the REAL Python NLP
 * service spawned (mock ERPNext — no credentials, no LLM). Same hermetic env
 * discipline as http-ask.test.mjs (result9/result21): strip leaked ERPNEXT_ and ASK_ vars.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

for (const k of Object.keys(process.env)) {
  if (/^(ERPNEXT_|ASK_)/.test(k)) delete process.env[k];
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");

/** Spawn the Python NLP bridge on an ephemeral port -> {child, port}. */
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

/** One server on an ephemeral port with the given limiter; cleans up after. */
async function withServer({ limiter = null, patchDir = null, envOverride = null, idemStore = null } = {}, fn) {
  const nlp = await startNlpService();
  const { __setNlpServicePortForTest } = await import("../src/copilot-server.mjs");
  const previousPort = process.env.NLP_SERVICE_PORT;
  let server = null;
  try {
    process.env.NLP_SERVICE_PORT = String(nlp.port);
    __setNlpServicePortForTest(nlp.port);
    const { createAskServer } = await import("../src/http-ask.mjs");
    let env = { ...process.env };
    let dir = patchDir;
    if (dir === null) {
      dir = mkdtempSync(path.join(tmpdir(), "a0-handoff-"));
      writeFileSync(path.join(dir, "safe.patch.yml"), "- insert:\n    - id: erpn-copilot-mcp\n      config:\n        env:\n          COPILOT_DSH_CONTEXT: '1'\n");
    }
    env.DSH_ENTRY = path.join(dir, "does-not-exist.mjs");
    env.DSH_PATCH = path.join(dir, "safe.patch.yml");
    // A1: test-level env overrides (e.g. MOCK_ERP_STATE) reach the mock ERP
    // child through the SERVER's env object — the mock inherits it, the same
    // way DSH_ENTRY does.
    if (envOverride) env = envOverride(dir);
    server = createAskServer({ port: 0, host: "127.0.0.1", limiter, env, idemStore });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    return await fn({ base: `http://127.0.0.1:${server.address().port}` });
  } finally {
    server?.close();
    nlp.child.kill();
    __setNlpServicePortForTest(previousPort ?? "8787");
  }
}

const askDsh = (base, message) =>
  fetch(`${base}/dsh/ask`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message }),
  });

test("A0 parity — the handoff proposal is charged to write_proposal and the exhausted budget denies the card", async () => {
  // A real (tiny) limiter injected through the createAskServer seam: the same
  // class the route uses, same per-user buckets. write_proposal limit = 1, so
  // the FIRST complete payment sentence gets its proposal and the SECOND gets
  // the 429 — the parity /ask has, asserted by behaviour, not by reading code.
  const { RateLimiter } = await import("../src/rate-limit.mjs");
  const limiter = new RateLimiter({
    rules: {
      perUser: {
        read: { limit: 100, windowMs: 60_000 },
        write_proposal: { limit: 1, windowMs: 60_000 },
        write_execute: { limit: 100, windowMs: 60_000 },
      },
      perCapability: {},
    },
  });

  await withServer({ limiter }, async ({ base }) => {
    const first = await askDsh(base, "thu tiền cho Nguyễn Thị Lan 10000");
    assert.equal(first.status, 200);
    const firstBody = await first.json();
    assert.equal(firstBody.ok, true);
    assert.equal(firstBody.handoff, "payment.create");
    assert.ok(firstBody.result?.proposal, "the first handoff delivers the card");

    const second = await askDsh(base, "thu tiền cho Nguyễn Thị Lan 50000");
    assert.equal(second.status, 429, "the SECOND proposal is denied by the WRITE budget, not delivered");
    const secondBody = await second.json();
    assert.equal(secondBody.code, "RATE_LIMITED");
    assert.ok(!secondBody.result?.proposal && !secondBody.proposal, "no proposal id escapes a throttled handoff");

    // The READ budget is still separate: with the write budget exhausted, an
    // ordinary question is NOT rate-limited — it moves past metering into the
    // runtime path (which, with this test's dead DSH_ENTRY, fails loudly as a
    // session failure — never as a 429, and never as a handoff).
    const read = await fetch(`${base}/dsh/ask`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "chị Lan còn nợ bao nhiêu" }),
    });
    const readBody = await read.json();
    assert.notEqual(read.status, 429, "a READ question does not spend the exhausted write budget");
    assert.notEqual(readBody.code, "RATE_LIMITED");
    assert.equal(readBody.handoff ?? null, null, "a READ is not marked as a handoff");
    assert.equal(read.status, 502);
    assert.equal(readBody.code, "DSH_UNAVAILABLE", "the READ reached the runtime path — the one the handoff bypasses");
  });
});

test("A0/A7 — the handoff proposal carries the RESOLVED id, and the snapshot is a DRAFT", async () => {
  await withServer({}, async ({ base }) => {
    const res = await askDsh(base, "thu tiền cho Nguyễn Thị Lan 10000");
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.handoff, "payment.create");
    assert.equal(body.runtime, null, "no runtime ran for the WRITE branch");
    assert.equal(typeof body.erp_target, "string");
    assert.equal(body.result.proposal.action, "create_payment_entry");
    // A7: the proposal is bound to the ID the entity resolution found — the
    // display name from the sentence is advisory, the id is what /execute uses.
    assert.equal(body.result.proposal.entity.id, "CUST-00001");
    assert.equal(body.result.proposal.entity.kind, "customer");
    // DRAFT by construction: the AI route's body carries no submit policy.
    assert.equal(body.result.proposal.params.submit_now, false);
    assert.equal(body.result.proposal.params.amount_vnd, 10_000, "the user's stated amount, clamped by the pipeline only");
    assert.ok(body.result.proposal.action_id, "the immutable action id travels with the card");
  });
});

test("A0 explicitness — a FORBIDDEN WRITE (document.delete) is NEVER answered with a handoff", async () => {
  await withServer({}, async ({ base }) => {
    const res = await askDsh(base, "xóa hóa đơn ACC-SINV-0001");
    // next6's ORIGINAL routing, unchanged by A0/A1: the gate does not refuse a
    // forbidden capability (the pipeline's P0 check owns that refusal, and the
    // in-child gate refuses it again in dsh context), so the question goes to
    // the RUNTIME path — which, with this test's dead DSH_ENTRY, fails loudly.
    // What A1 must guarantee is only: no response ever hands a forbidden write
    // to the deterministic pipeline.
    const body = await res.json();
    assert.equal(body.ok, false, "it does not succeed either way");
    assert.equal(body.handoff ?? null, null, "a forbidden WRITE is never handed off");
    assert.notEqual(body.code, "DSH_WRITE_HANDOFF");
    // Mutation guard (falsify M3): drop the forbidden guard inside
    // dshWriteHandoffFor and this very sentence comes back handoff-marked —
    // pin the CAPABILITY name so the regression is named, not just "some code".
    assert.equal(body.handoff === "document.delete", false);
  });
});

// ─── A1 — every WIRED write hands off, with the pipeline's own entity/slot rules ───

/**
 * A5 fixture: the mock merges a STATE file into its master tables, so a second
 * "Nguyễn Thị Lan" can be added WITHOUT touching the shared fixtures (a state
 * file with only the customers_created key restores nothing else). The var
 * must live in the TEST PROCESS's env — the mock child inherits process.env,
 * not the route's env object — so it is set inside the test and removed after.
 */
const dupStateDir = mkdtempSync(path.join(tmpdir(), "a1-dup-"));
const dupStateFile = path.join(dupStateDir, "dup-customer.json");
writeFileSync(
  dupStateFile,
  JSON.stringify({ customers_created: [{ doctype: "Customer", name: "CUST-DUP-LAN", customer_name: "Nguyễn Thị Lan", customer_group: "Individual", disabled: 0 }] }),
);

test("A1/A5 — an ambiguous name hands off into the pipeline's PICKER: candidates, never a proposal", async () => {
  // The master list then holds TWO customers named "Nguyễn Thị Lan" (fixture
  // CUST-00001 + the state-injected CUST-DUP-LAN), so the resolver's ambiguous
  // state is real data, not a stub.
  process.env.MOCK_ERP_STATE = dupStateFile;
  try {
    await withServer({}, async ({ base }) => {
      const res = await askDsh(base, "thu tiền cho Nguyễn Thị Lan 10000");
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.ok, true);
      assert.equal(body.handoff, "payment.create", "the write still hands off — the PIPELINE owns the refusal");
      assert.equal(body.runtime, null);
      assert.equal(body.result.proposal, null, "no proposal on an ambiguous name");
      assert.equal(body.result.error_code, "AMBIGUOUS_ENTITY", "the picker code the entity policy names for AMBIGUOUS_MATCH");
      assert.ok(Array.isArray(body.result.candidates) && body.result.candidates.length >= 2, "the answer carries the colliding names");
    });
  } finally {
    delete process.env.MOCK_ERP_STATE;
  }
});

test("A1/A6 — a WRITE sentence that names no party hands off into MISSING_ENTITY, never a proposal", async () => {
  // "đặt hàng" (not "tạo đơn": the Phase-1 synonym turns that into a READ —
  // a measured B2 gap) with no customer named: the WRITE hands off, and the
  // pipeline's own party guard answers MISSING_ENTITY.
  await withServer({}, async ({ base }) => {
    const res = await askDsh(base, "đặt hàng 3 bao cám heo");
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.handoff, "sales_order.create", "the non-payment write IS handed off after A1");
    assert.equal(body.runtime, null);
    assert.equal(body.result.proposal, null);
    assert.equal(body.result.error_code, "MISSING_ENTITY");
    assert.match(body.result.reason, /không tìm thấy/);
  });
});

test("A1/A7 — a non-payment write with 1 match + complete slots carries the RESOLVED id", async () => {
  await withServer({}, async ({ base }) => {
    const res = await askDsh(base, "đặt hàng cho Nguyễn Thị Lan 2 bao cám heo");
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.handoff, "sales_order.create");
    assert.equal(body.runtime, null, "no runtime ran for the order write either");
    assert.equal(typeof body.erp_target, "string");
    assert.equal(body.result.proposal.action, "create_sales_order");
    assert.equal(body.result.proposal.entity.id, "CUST-00001", "the id, not the display name");
    assert.equal(body.result.proposal.entity.kind, "customer");
    assert.equal(body.result.proposal.params.submit_now, false, "DRAFT freeze applies to every handed-off write");
    assert.ok(body.result.proposal.action_id);
    assert.match(body.result.answer, /NHÁP/);
  });
});

// ─── A2 — the handoff's proposal EXECUTES bound and idempotent, verified in the ERP ledger ───

test("A2 — confirm the handoff's proposal: execute uses the bound id, verifies by read-back, and a double confirm yields ONE draft", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "a2-execute-"));
  process.env.MOCK_ERP_STATE = path.join(dir, "mock-erp.json");
  const { IdempotencyStore } = await import("../src/idempotency.mjs");
  const { readFileSync } = await import("node:fs");
  let server = null;
  try {
    server = await withServer({ idemStore: new IdempotencyStore(dir) }, async ({ base }) => {
      // 1. The WRITE question hands off and produces the ordinary proposal.
      const asked = await askDsh(base, "thu tiền cho Nguyễn Thị Lan 10000");
      assert.equal(asked.status, 200);
      const askBody = await asked.json();
      const proposal = askBody.result.proposal;
      assert.ok(proposal, "the handoff delivered the card");
      assert.equal(proposal.entity.id, "CUST-00001");
      assert.equal(proposal.params.submit_now, false, "AI mode's snapshot is a DRAFT by construction");

      // 2. CONFIRM — POST /execute with the proposal AS the client received it
      //    (the card round-trips unchanged; nothing is re-resolved from names).
      const commandId = randomUUID();
      const execute = (cid) =>
        fetch(`${base}/execute`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ command_id: cid, proposal }),
        }).then(async (r) => ({ status: r.status, body: await r.json() }));

      const first = await execute(commandId);
      assert.equal(first.status, 200, JSON.stringify(first.body));
      assert.equal(first.body.ok, true);
      assert.equal(first.body.replay, false, "the first confirm is a real write");
      const result = first.body.result;
      // A11 evidence: the write is bound to the PROPOSAL's id and verified
      // against the read-back (reference_no = command_id, party = entity.id).
      assert.equal(result.customer, "CUST-00001");
      assert.equal(result.party_kind, "customer");
      assert.equal(result.reference_no, commandId);
      assert.equal(result.docstatus, 0, "the draft state is VERIFIED by reading the document back");
      assert.ok(/^PE-M/.test(String(result.erpnext_doc)), `a real mock document name: ${result.erpnext_doc}`);

      // The ERP ledger holds exactly ONE Payment Entry for this command, with
      // the correlation field naming the proposal's action_id.
      const rows = JSON.parse(readFileSync(process.env.MOCK_ERP_STATE, "utf8")).payments ?? [];
      const mine = rows.filter((p) => p.reference_no === commandId);
      assert.equal(mine.length, 1, "exactly one Payment Entry in the ERP ledger");
      assert.equal(mine[0].party, "CUST-00001", "the ledger row is bound to the proposal's resolved id");
      assert.equal(mine[0].paid_amount, 10_000);
      assert.equal(mine[0].custom_ai_action_id, proposal.action_id, "the action id from the card reached the document");

      // 3. A12 — DOUBLE CONFIRM: the same action_id/command_id again must
      //    replay, never write a second draft.
      const again = await execute(commandId);
      assert.equal(again.status, 200);
      assert.equal(again.body.replay, true, "the second confirm is a replay of the first result");
      assert.equal(again.body.result.erpnext_doc, result.erpnext_doc, "the SAME document, not a new one");
      const rowsAfter = JSON.parse(readFileSync(process.env.MOCK_ERP_STATE, "utf8")).payments ?? [];
      assert.equal(rowsAfter.filter((p) => p.reference_no === commandId).length, 1, "still exactly ONE Payment Entry");

      return { base };
    });
  } finally {
    delete process.env.MOCK_ERP_STATE;
    server?.close?.();
    rmSync(dir, { recursive: true, force: true });
  }
});

// The A2 stale-guard regression IN AI MODE: a second handoff for the same debt
// after a draft exists is refused by the drift gate (the snapshot no longer
// matches), so a careless second confirm cannot write the same money twice.
test("A2 — after a draft exists, a RE-ASKED handoff for the same debt lowers to the remainder (never the raw debt)", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "a2-redraft-"));
  process.env.MOCK_ERP_STATE = path.join(dir, "mock-erp.json");
  const { IdempotencyStore } = await import("../src/idempotency.mjs");
  const { readFileSync } = await import("node:fs");
  let server = null;
  try {
    server = await withServer({ idemStore: new IdempotencyStore(dir) }, async ({ base }) => {
      // First write: a 10.000 draft against SINV-0001 (outstanding 2.500.000).
      const asked = await askDsh(base, "thu tiền cho Nguyễn Thị Lan 10000");
      const proposal = (await asked.json()).result.proposal;
      const cid = randomUUID();
      const first = await fetch(`${base}/execute`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command_id: cid, proposal }),
      });
      assert.equal(first.status, 200, JSON.stringify(await first.json()));

      // The shop asks AGAIN in AI mode. The handoff pipeline re-reads live
      // debt, subtracts the open draft, and the NEW card carries the remainder
      // — not the raw GL number a second confirmation would double-write.
      const asked2 = await askDsh(base, "thu tiền cho Nguyễn Thị Lan 10000");
      assert.equal(asked2.status, 200);
      const second = (await asked2.json()).result;
      assert.ok(second.proposal, JSON.stringify(second).slice(0, 300));
      assert.equal(second.proposal.params.outstanding_vnd, 2_490_000, "the snapshot holds the EFFECTIVE debt (GL minus the open draft)");
      assert.equal(second.proposal.params.draft_cover_vnd, 10_000, "the draft is named as cover, not ignored");
      assert.ok(second.warnings.some((w) => /NHÁP/.test(w)), "the answer warns about the standing draft");

      // And the ledger still holds exactly one WRITTEN draft for the first
      // command (the seeded fixture row PE-0001 is not a write of this run —
      // every mock-written row is named PE-M…).
      const rows = (JSON.parse(readFileSync(process.env.MOCK_ERP_STATE, "utf8")).payments ?? []).filter((p) => /^PE-M/.test(String(p.name ?? "")));
      assert.equal(rows.length, 1, "asking again wrote nothing — only the confirmed card wrote");
    });
  } finally {
    delete process.env.MOCK_ERP_STATE;
    server?.close?.();
    rmSync(dir, { recursive: true, force: true });
  }
});
