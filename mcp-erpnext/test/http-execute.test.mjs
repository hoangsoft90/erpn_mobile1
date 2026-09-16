/**
 * Tests for the Phase 7 POST /execute endpoint (http-ask.mjs).
 *
 * Runs the FULL HTTP path with the MOCK ERPNext client (in-process server,
 * ephemeral port, no NLP needed — /execute does not call the pipeline).
 * Spec exit criteria exercised end-to-end:
 *  - duplicate command_id → HTTP 200 replay:true, exactly ONE mock write;
 *  - invalid/missing command_id or action → 400/403 without touching ERPNext;
 *  - FAILED terminal command → 409 with the failed-terminal message.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { fingerprintProposal } from "../src/idempotency.mjs";

// ------------------------------------------------------------------ cancel --
// Phase 9 (user decision 2026-09-16): /execute/cancel releases a zombie
// PENDING intent — but ONLY after ERPNext proves zero documents exist.

test("/execute/cancel: PENDING + reconcile finds 0 docs → CANCELLED, intent lock released", async () => {
  const dir = mkdtempSync(join(tmpdir(), "idem-cancel-"));
  let server = null;
  try {
    const { createAskServer } = await import("../src/http-ask.mjs");
    const { IdempotencyStore } = await import("../src/idempotency.mjs");
    const store = new IdempotencyStore(dir);
    server = createAskServer({ port: 0, host: "127.0.0.1", idemStore: store });
    const port = await new Promise((res, rej) => {
      server.once("error", rej);
      server.listen(0, "127.0.0.1", () => res(server.address().port));
    });
    // A zombie PENDING command (crash before/during write, nothing landed).
    const cid = randomUUID();
    store.begin(cid, { action: "create_payment_entry", fingerprint: "fp-cancel-ok" });
    store.setReference(cid, cid);

    const r = await fetch(`http://127.0.0.1:${port}/execute/cancel`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command_id: cid }),
    });
    const body = await r.json();
    assert.equal(r.status, 200, JSON.stringify(body));
    assert.equal(body.cancelled, true);
    assert.equal(store.status(cid).status, "CANCELLED");
  } finally {
    server?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("/execute/cancel: ERPNext HAS the document → refuse (409) + surface the doc; retry /execute still completes it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "idem-cancel-"));
  let server = null;
  process.env.MOCK_ERP_STATE = join(dir, "mock-erp.json");
  try {
    const { createAskServer } = await import("../src/http-ask.mjs");
    const { IdempotencyStore } = await import("../src/idempotency.mjs");
    const store = new IdempotencyStore(dir);
    server = createAskServer({ port: 0, host: "127.0.0.1", idemStore: store });
    const port = await new Promise((res, rej) => {
      server.once("error", rej);
      server.listen(0, "127.0.0.1", () => res(server.address().port));
    });
    // Crash AFTER the write: ERPNext really has the document. The fingerprint
    // must MATCH the PROPOSAL the retry will carry (begin() compares them).
    const cid = randomUUID();
    store.begin(cid, { action: "create_payment_entry", fingerprint: fingerprintProposal(PROPOSAL) });
    store.setReference(cid, cid);
    writeFileSync(
      process.env.MOCK_ERP_STATE,
      JSON.stringify({ payments: [{ name: "PE-CANCEL-TEST", reference_no: cid, paid_amount: 500000, docstatus: 0 }] }),
      "utf8",
    );

    const r = await fetch(`http://127.0.0.1:${port}/execute/cancel`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command_id: cid }),
    });
    const body = await r.json();
    assert.equal(r.status, 409, JSON.stringify(body));
    assert.equal(body.erpnext_doc, "PE-CANCEL-TEST");
    assert.match(body.error, /KHÔNG huỷ/);
    assert.equal(store.status(cid).status, "PENDING", "cancel must not change a landed write");

    // The correct path instead: retry /execute → reconcile completes it.
    const retry = await fetch(`http://127.0.0.1:${port}/execute`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command_id: cid, proposal: PROPOSAL }),
    });
    const rbody = await retry.json();
    assert.equal(retry.status, 200, JSON.stringify(rbody));
    assert.equal(rbody.replay, true);
    assert.equal(rbody.reconciled, true);
  } finally {
    delete process.env.MOCK_ERP_STATE;
    server?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("/execute/cancel: COMPLETED / FAILED / unknown ids are refused; reconcile-down is 503", async () => {
  const dir = mkdtempSync(join(tmpdir(), "idem-cancel-"));
  let server = null;
  process.env.MOCK_ERP_STATE = join(dir, "mock-erp.json");
  try {
    const { createAskServer } = await import("../src/http-ask.mjs");
    const { IdempotencyStore } = await import("../src/idempotency.mjs");
    const store = new IdempotencyStore(dir);
    server = createAskServer({ port: 0, host: "127.0.0.1", idemStore: store });
    const port = await new Promise((res, rej) => {
      server.once("error", rej);
      server.listen(0, "127.0.0.1", () => res(server.address().port));
    });
    const post = (cid) =>
      fetch(`http://127.0.0.1:${port}/execute/cancel`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command_id: cid }),
      }).then(async (r) => ({ status: r.status, body: await r.json() }));

    // unknown id
    const missing = await post(randomUUID());
    assert.equal(missing.status, 404);

    // COMPLETED: cancelling must never hide a landed write
    const done = randomUUID();
    store.begin(done, { action: "create_payment_entry", fingerprint: "fp-done" });
    store.complete(done, { erpnext_doc: "PE-DONE" });
    const doneRes = await post(done);
    assert.equal(doneRes.status, 409, JSON.stringify(doneRes.body));
    assert.match(doneRes.body.error, /COMPLETED/);

    // FAILED is terminal already — cancel is pointless, refuse with guidance
    const failed = randomUUID();
    store.begin(failed, { action: "create_payment_entry", fingerprint: "fp-failed" });
    store.fail(failed, "bad params");
    const failedRes = await post(failed);
    assert.equal(failedRes.status, 409);
    assert.match(failedRes.body.error, /FAILED/);

    // PENDING without reference: cannot reconcile ⇒ refuse
    const noRef = randomUUID();
    store.begin(noRef, { action: "create_payment_entry", fingerprint: "fp-noref" });
    const noRefRes = await post(noRef);
    assert.equal(noRefRes.status, 409, JSON.stringify(noRefRes.body));
    assert.match(noRefRes.body.error, /reference_no/);

    // PENDING with reference but ERPNext down: 503, never a blind cancel
    const down = randomUUID();
    store.begin(down, { action: "create_payment_entry", fingerprint: "fp-down" });
    store.setReference(down, down);
    process.env.MOCK_ERP_FAIL_LIST = "1";
    const downRes = await post(down);
    assert.equal(downRes.status, 503, JSON.stringify(downRes.body));
    assert.equal(store.status(down).status, "PENDING", "still recoverable after a 503");
    delete process.env.MOCK_ERP_FAIL_LIST; // the following cancels need ERPNext healthy

    // idempotent second cancel (ERPNext healthy again — FAIL_LIST cleared)
    const c1 = randomUUID();
    store.begin(c1, { action: "create_payment_entry", fingerprint: "fp-c1" });
    store.setReference(c1, c1);
    const ok1 = await post(c1);
    assert.equal(ok1.status, 200, JSON.stringify(ok1.body));
    const ok2 = await post(c1);
    assert.equal(ok2.status, 200, JSON.stringify(ok2.body));
    assert.equal(ok2.body.replay, true);
  } finally {
    delete process.env.MOCK_ERP_FAIL_LIST;
    delete process.env.MOCK_ERP_STATE;
    server?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// Hermetic: same shell-leak protection as http-ask.test.mjs.
for (const k of Object.keys(process.env)) {
  if (/^(ERPNEXT_|ASK_)/.test(k)) delete process.env[k];
}

const PROPOSAL = {
  schema: "erpn.proposal/v1",
  action: "create_payment_entry",
  risk: "HIGH",
  // Phase 9: the age gate needs the server build time, and the drift check
  // needs the snapshot of the debt AT THAT TIME. Both are produced by
  // buildProposal()/buildPaymentProposal(); the mock invoice SINV-0001 carries
  // 2.500.000 outstanding, so the snapshot here matches live.
  created_at: new Date().toISOString(),
  entity: { kind: "customer", id: "CUST-00001", name: "Khách mock" },
  params: {
    amount_vnd: 2_500_000,
    invoice: "SINV-0001",
    outstanding_vnd: 2_500_000,
    mode: "Tiền mặt",
  },
  summary: "Thu 2.500.000đ từ Khách mock cho chứng từ SINV-0001",
};

test("/execute: happy path + duplicate command_id replays with ONE mock write", async () => {
  const dir = mkdtempSync(join(tmpdir(), "idem-http-"));
  let server = null;
  try {
    const { createAskServer } = await import("../src/http-ask.mjs");
    const { IdempotencyStore } = await import("../src/idempotency.mjs");
    const store = new IdempotencyStore(dir);
    server = createAskServer({ port: 0, host: "127.0.0.1", idemStore: store });
    const port = await new Promise((res, rej) => {
      server.once("error", rej);
      server.listen(0, "127.0.0.1", () => res(server.address().port));
    });
    const base = `http://127.0.0.1:${port}`;

    const cid = randomUUID();
    const r1 = await fetch(`${base}/execute`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command_id: cid, proposal: PROPOSAL }),
    });
    const b1 = await r1.json();
    assert.equal(r1.status, 200, JSON.stringify(b1));
    assert.equal(b1.ok, true);
    assert.equal(b1.replay, false);
    assert.match(b1.result.erpnext_doc, /^PE-/);
    assert.equal(b1.result.paid_vnd, 2_500_000);

    // client retry (lost network) — same command_id
    const r2 = await fetch(`${base}/execute`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command_id: cid, proposal: PROPOSAL }),
    });
    const b2 = await r2.json();
    assert.equal(r2.status, 200);
    assert.equal(b2.replay, true, "second call must be a replay");
    assert.equal(b2.result.erpnext_doc, b1.result.erpnext_doc, "same doc returned");
  } finally {
    server?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("/execute: rejects bad command_id, wrong action, missing entity id", async () => {
  const dir = mkdtempSync(join(tmpdir(), "idem-http-"));
  let server = null;
  try {
    const { createAskServer } = await import("../src/http-ask.mjs");
    const { IdempotencyStore } = await import("../src/idempotency.mjs");
    server = createAskServer({ port: 0, host: "127.0.0.1", idemStore: new IdempotencyStore(dir) });
    const port = await new Promise((res, rej) => {
      server.once("error", rej);
      server.listen(0, "127.0.0.1", () => res(server.address().port));
    });
    const base = `http://127.0.0.1:${port}`;
    const post = (body) =>
      fetch(`${base}/execute`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

    const noId = await post({ proposal: PROPOSAL });
    assert.equal(noId.status, 400);

    const badId = await post({ command_id: "oops", proposal: PROPOSAL });
    assert.equal(badId.status, 400);

    const badAction = await post({ command_id: randomUUID(), proposal: { ...PROPOSAL, action: "delete_customer" } });
    assert.equal(badAction.status, 400);

    const noEntity = await post({
      command_id: randomUUID(),
      proposal: { ...PROPOSAL, entity: { kind: "customer", id: null, name: "x" } },
    });
    assert.equal(noEntity.status, 400);
  } finally {
    server?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test(
  "/execute: RESUMED command reconciles against ERPNext — NO second write (regression: the real double-write of 2026-09-16)",
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "idem-http-"));
    let server = null;
    // The mock must keep its ledger across the server restarts below, exactly
    // like ERPNext does — otherwise reconcile would always answer "nothing is
    // written" and the test could not tell a fixed run from a broken one.
    process.env.MOCK_ERP_STATE = join(dir, "mock-erp.json");
    try {
      const { createAskServer } = await import("../src/http-ask.mjs");
      const { IdempotencyStore } = await import("../src/idempotency.mjs");
      const cid = randomUUID();
      const post = (base) =>
        fetch(`${base}/execute`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ command_id: cid, proposal: PROPOSAL }),
        });
      const listen = async (store) => {
        const s = createAskServer({ port: 0, host: "127.0.0.1", idemStore: store });
        const port = await new Promise((res, rej) => {
          s.once("error", rej);
          s.listen(0, "127.0.0.1", () => res(s.address().port));
        });
        return s;
      };

      // 1. A real write through the HTTP path.
      server = await listen(new IdempotencyStore(dir));
      const first = await (await post(`http://127.0.0.1:${server.address().port}`)).json();
      assert.equal(first.ok, true, JSON.stringify(first));
      const writtenDoc = first.result.erpnext_doc;

      // 2. Simulate the crash: the process died after ERPNext accepted the
      //    write but before store.complete(). Rewrite the record as PENDING and
      //    restart the server so its in-memory cache is gone (as after a crash).
      server.close();
      server = null;
      const store = new IdempotencyStore(dir);
      const rec = store._load().commands[cid.toLowerCase()];
      assert.ok(rec.reference_no, "the store holds the ERPNext reference to search with");
      rec.status = "PENDING";
      delete rec.result;
      store._persist();

      // 3. The client retries the same command_id (it only saw a timeout).
      server = await listen(new IdempotencyStore(dir));
      const resumed = await (await post(`http://127.0.0.1:${server.address().port}`)).json();

      // 4. It MUST have reconciled to the existing document instead of writing
      //    again. Before the fix this returned replay:false with a NEW doc name
      //    — i.e. a second payment for the same money.
      assert.equal(resumed.ok, true, JSON.stringify(resumed));
      assert.equal(resumed.reconciled, true, "reconcile path must have run");
      assert.equal(resumed.replay, true, "a resumed command is never a fresh write");
      assert.equal(resumed.result.erpnext_doc, writtenDoc, "the ORIGINAL document is returned");
      assert.equal(resumed.duplicate_documents, 0, "exactly one document carries this reference");
    } finally {
      server?.close();
      delete process.env.MOCK_ERP_STATE;
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test(
  "/execute: a transient write failure keeps the command PENDING (503, retry the SAME id) and never burns it as FAILED",
  async () => {
    // Regression for the review finding of 2026-09-16: a failure AFTER the
    // ERPNext reference was registered may mean the document DID land and only
    // the response was lost. Marking it FAILED would make reconcile impossible
    // (begin() refuses FAILED) and push the caller to a NEW command_id — the
    // exact recipe for a second payment for the same money.
    const dir = mkdtempSync(join(tmpdir(), "idem-http-"));
    let server = null;
    process.env.MOCK_ERP_STATE = join(dir, "mock-erp.json");
    try {
      const { createAskServer } = await import("../src/http-ask.mjs");
      const { IdempotencyStore } = await import("../src/idempotency.mjs");
      const store = new IdempotencyStore(dir);
      server = createAskServer({ port: 0, host: "127.0.0.1", idemStore: store });
      const port = await new Promise((res, rej) => {
        server.once("error", rej);
        server.listen(0, "127.0.0.1", () => res(server.address().port));
      });
      const base = `http://127.0.0.1:${port}`;
      const cid = randomUUID();
      const post = () =>
        fetch(`${base}/execute`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ command_id: cid, proposal: PROPOSAL }),
        });

      // 1. ERPNext accepts nothing (simulated failure) — the reference is
      //    already registered, so the outcome of the write is UNKNOWN.
      process.env.MOCK_ERP_FAIL_WRITE = "1";
      const r1 = await post();
      const b1 = await r1.json();
      assert.equal(r1.status, 503, JSON.stringify(b1));
      assert.equal(b1.retry_same_command_id, true);

      // 2. The command is still retryable with the SAME id (not terminal).
      const rec = store.status(cid);
      assert.notEqual(rec?.status, "FAILED", "a post-write failure must not be terminal");

      // 3. Retry with the same id once ERPNext is healthy again: nothing was
      //    written, so it must write exactly ONCE and complete.
      delete process.env.MOCK_ERP_FAIL_WRITE;
      const r2 = await post();
      const b2 = await r2.json();
      assert.equal(r2.status, 200, JSON.stringify(b2));
      assert.equal(b2.ok, true);
      assert.equal(store.status(cid).status, "COMPLETED");
    } finally {
      delete process.env.MOCK_ERP_FAIL_WRITE;
      delete process.env.MOCK_ERP_STATE;
      server?.close();
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test(
  "/execute chaos: ERPNext COMMITTED but the response was lost → the retry reconciles to that same document (no second write)",
  async () => {
    // The end-to-end version of the 2026-09-16 double-write: the dangerous part
    // is not a failure before the write, it is a failure AFTER it. The mock
    // writes the document, then throws (MOCK_ERP_FAIL_AFTER_WRITE).
    const dir = mkdtempSync(join(tmpdir(), "idem-http-"));
    const stateFile = join(dir, "mock-erp.json");
    let server = null;
    process.env.MOCK_ERP_STATE = stateFile;
    try {
      const { createAskServer } = await import("../src/http-ask.mjs");
      const { IdempotencyStore } = await import("../src/idempotency.mjs");
      const { readFileSync } = await import("node:fs");
      const store = new IdempotencyStore(dir);
      const listen = async () => {
        const s = createAskServer({ port: 0, host: "127.0.0.1", idemStore: new IdempotencyStore(dir) });
        const port = await new Promise((res, rej) => {
          s.once("error", rej);
          s.listen(0, "127.0.0.1", () => res(s.address().port));
        });
        return s;
      };
      const cid = randomUUID();
      const post = async () => {
        const r = await fetch(`http://127.0.0.1:${server.address().port}/execute`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ command_id: cid, proposal: PROPOSAL }),
        });
        return { status: r.status, body: await r.json() };
      };
      const ledgerCount = () => {
        const rows = JSON.parse(readFileSync(stateFile, "utf8")).payments ?? [];
        return rows.filter((p) => p.reference_no === cid).length;
      };

      // 1. Lost response: ERPNext HAS the document, the client only sees an error.
      process.env.MOCK_ERP_FAIL_AFTER_WRITE = "1";
      server = await listen();
      const first = await post();
      assert.equal(first.status, 503, JSON.stringify(first.body));
      assert.equal(first.body.retry_same_command_id, true);
      assert.equal(ledgerCount(), 1, "ERPNext really did commit the document");
      assert.notEqual(store.status(cid)?.status, "FAILED", "must stay retryable");

      // 2. The client retries the SAME command_id (it never learned the outcome),
      //    after a restart so the in-memory cache cannot mask the reconcile path.
      delete process.env.MOCK_ERP_FAIL_AFTER_WRITE;
      server.close();
      server = await listen();
      const retry = await post();

      assert.equal(retry.status, 200, JSON.stringify(retry.body));
      assert.equal(retry.body.replay, true, "a resumed command is a replay, never a fresh write");
      assert.equal(retry.body.reconciled, true, "it reconciled against ERPNext");
      assert.equal(retry.body.duplicate_documents, 0);
      // The independent check: the ledger itself.
      assert.equal(ledgerCount(), 1, "exactly ONE document carries this payment");
    } finally {
      delete process.env.MOCK_ERP_FAIL_AFTER_WRITE;
      delete process.env.MOCK_ERP_STATE;
      server?.close();
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test(
  "/execute chaos: reconciliation itself fails (ERPNext unreachable) → 503, refuses to guess, writes nothing",
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "idem-http-"));
    const stateFile = join(dir, "mock-erp.json");
    let server = null;
    process.env.MOCK_ERP_STATE = stateFile;
    try {
      const { createAskServer } = await import("../src/http-ask.mjs");
      const { IdempotencyStore } = await import("../src/idempotency.mjs");
      const { readFileSync } = await import("node:fs");
      const store = new IdempotencyStore(dir);
      const listen = async () => {
        const s = createAskServer({ port: 0, host: "127.0.0.1", idemStore: new IdempotencyStore(dir) });
        const port = await new Promise((res, rej) => {
          s.once("error", rej);
          s.listen(0, "127.0.0.1", () => res(s.address().port));
        });
        return s;
      };
      const cid = randomUUID();
      const post = async () => {
        const r = await fetch(`http://127.0.0.1:${server.address().port}/execute`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ command_id: cid, proposal: PROPOSAL }),
        });
        return { status: r.status, body: await r.json() };
      };
      const ledgerCount = () => {
        const rows = JSON.parse(readFileSync(stateFile, "utf8")).payments ?? [];
        return rows.filter((p) => p.reference_no === cid).length;
      };

      // Write once for real, then simulate the crash (PENDING with a reference).
      server = await listen();
      const ok = await post();
      assert.equal(ok.status, 200, JSON.stringify(ok.body));

      server.close();
      const live = new IdempotencyStore(dir);
      const rec = live._load().commands[cid.toLowerCase()];
      rec.status = "PENDING";
      delete rec.result;
      live._persist();

      // ERPNext is now unreachable exactly when we must reconcile.
      process.env.MOCK_ERP_FAIL_LIST = "1";
      server = await listen();
      const blind = await post();

      assert.equal(blind.status, 503, JSON.stringify(blind.body));
      assert.match(blind.body.error, /đối soát/);
      assert.equal(ledgerCount(), 1, "nothing was written while blind");
      assert.equal(store.status(cid)?.status, "PENDING", "still recoverable later");
    } finally {
      delete process.env.MOCK_ERP_FAIL_LIST;
      delete process.env.MOCK_ERP_STATE;
      server?.close();
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test("/execute: an invalid amount is refused at the boundary and does NOT burn the command_id", async () => {
  // A client (or a buggy builder) that sends amount 0 must never be silently
  // promoted into "collect the WHOLE debt", and a malformed request must not
  // reserve the id, so the corrected request can still use it.
  const dir = mkdtempSync(join(tmpdir(), "idem-http-"));
  let server = null;
  process.env.MOCK_ERP_STATE = join(dir, "mock-erp.json");
  try {
    const { createAskServer } = await import("../src/http-ask.mjs");
    const { IdempotencyStore } = await import("../src/idempotency.mjs");
    const store = new IdempotencyStore(dir);
    server = createAskServer({ port: 0, host: "127.0.0.1", idemStore: store });
    const port = await new Promise((res, rej) => {
      server.once("error", rej);
      server.listen(0, "127.0.0.1", () => res(server.address().port));
    });
    const base = `http://127.0.0.1:${port}`;
    const cid = randomUUID();
    const post = (amount) =>
      fetch(`${base}/execute`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          command_id: cid,
          proposal: { ...PROPOSAL, params: { ...PROPOSAL.params, amount_vnd: amount } },
        }),
      });

    for (const bad of [0, -1, "abc", null]) {
      const r = await post(bad);
      assert.equal(r.status, 400, `amount_vnd=${JSON.stringify(bad)} must be refused`);
    }
    assert.equal(store.status(cid), null, "a rejected request must not reserve the command_id");

    // The corrected request, same id, goes through normally.
    const ok = await post(2_500_000);
    const body = await ok.json();
    assert.equal(ok.status, 200, JSON.stringify(body));
    assert.equal(body.result.paid_vnd, 2_500_000, "paid exactly what was asked, not the whole debt");
  } finally {
    delete process.env.MOCK_ERP_STATE;
    server?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("/execute Phase 9: an EXPIRED proposal is refused before the gate, so the command_id is not burned", async () => {
  const dir = mkdtempSync(join(tmpdir(), "idem-http-"));
  let server = null;
  process.env.MOCK_ERP_STATE = join(dir, "mock-erp.json");
  try {
    const { createAskServer } = await import("../src/http-ask.mjs");
    const { IdempotencyStore } = await import("../src/idempotency.mjs");
    const { readFileSync } = await import("node:fs");
    const store = new IdempotencyStore(dir);
    server = createAskServer({ port: 0, host: "127.0.0.1", idemStore: store });
    const port = await new Promise((res, rej) => {
      server.once("error", rej);
      server.listen(0, "127.0.0.1", () => res(server.address().port));
    });
    const cid = randomUUID();
    const stale = {
      ...PROPOSAL,
      created_at: new Date(Date.now() - 11 * 60 * 1000).toISOString(), // TTL = 10 phút
    };
    const r = await fetch(`http://127.0.0.1:${port}/execute`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command_id: cid, proposal: stale }),
    });
    const body = await r.json();
    assert.equal(r.status, 409, JSON.stringify(body));
    assert.equal(body.code, "PROPOSAL_EXPIRED");
    assert.equal(store.status(cid), null, "an expired proposal must not reserve the command_id");
    // No state file ⇒ the mock never wrote ⇒ zero rows (that IS the assertion).
    const rows = existsSync(process.env.MOCK_ERP_STATE)
      ? JSON.parse(readFileSync(process.env.MOCK_ERP_STATE, "utf8")).payments ?? []
      : [];
    assert.equal(rows.filter((p) => p.reference_no === cid).length, 0, "nothing may be written");

    // Same command_id, fresh proposal → goes through: the refusal was not a burn.
    const ok = await fetch(`http://127.0.0.1:${port}/execute`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command_id: cid, proposal: { ...PROPOSAL } }),
    });
    assert.equal(ok.status, 200, JSON.stringify(await ok.json()));
  } finally {
    delete process.env.MOCK_ERP_STATE;
    server?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("/execute Phase 9: a proposal whose SNAPSHOT drifted is refused (409), NOT silently clamped", async () => {
  const dir = mkdtempSync(join(tmpdir(), "idem-http-"));
  let server = null;
  process.env.MOCK_ERP_STATE = join(dir, "mock-erp.json");
  try {
    const { createAskServer } = await import("../src/http-ask.mjs");
    const { IdempotencyStore } = await import("../src/idempotency.mjs");
    const { readFileSync } = await import("node:fs");
    const store = new IdempotencyStore(dir);
    server = createAskServer({ port: 0, host: "127.0.0.1", idemStore: store });
    const port = await new Promise((res, rej) => {
      server.once("error", rej);
      server.listen(0, "127.0.0.1", () => res(server.address().port));
    });
    const cid = randomUUID();
    // Someone collected part of the debt after the proposal was built.
    const drifted = {
      ...PROPOSAL,
      params: { ...PROPOSAL.params, outstanding_vnd: 3_000_000 },
    };
    const r = await fetch(`http://127.0.0.1:${port}/execute`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command_id: cid, proposal: drifted }),
    });
    const body = await r.json();
    assert.equal(r.status, 409, JSON.stringify(body));
    assert.equal(body.code, "PROPOSAL_STALE");
    assert.ok(body.problems.some((p) => /nợ lúc tạo đề xuất/.test(p)), JSON.stringify(body.problems));
    assert.equal(store.status(cid).status, "FAILED", "a stale intent is terminal — the user re-asks");
    // No state file ⇒ the mock never wrote ⇒ zero rows (that IS the assertion).
    const rows = existsSync(process.env.MOCK_ERP_STATE)
      ? JSON.parse(readFileSync(process.env.MOCK_ERP_STATE, "utf8")).payments ?? []
      : [];
    assert.equal(rows.filter((p) => p.reference_no === cid).length, 0, "nothing may be written");
  } finally {
    delete process.env.MOCK_ERP_STATE;
    server?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("/execute Phase 9: a second command_id for the SAME (customer, invoice) is refused while one is in flight", async () => {
  const dir = mkdtempSync(join(tmpdir(), "idem-http-"));
  let server = null;
  process.env.MOCK_ERP_STATE = join(dir, "mock-erp.json");
  try {
    const { createAskServer } = await import("../src/http-ask.mjs");
    const { IdempotencyStore, fingerprintProposal } = await import("../src/idempotency.mjs");
    const store = new IdempotencyStore(dir);
    server = createAskServer({ port: 0, host: "127.0.0.1", idemStore: store });
    const port = await new Promise((res, rej) => {
      server.once("error", rej);
      server.listen(0, "127.0.0.1", () => res(server.address().port));
    });
    // An earlier command is already PENDING on this debt (e.g. it crashed
    // after registering its reference and nobody has reconciled it yet).
    const inFlight = randomUUID();
    store.begin(inFlight, {
      action: PROPOSAL.action,
      fingerprint: fingerprintProposal(PROPOSAL),
      intentKey: `${PROPOSAL.entity.id}|${PROPOSAL.params.invoice}`,
    });

    const cid = randomUUID();
    const r = await fetch(`http://127.0.0.1:${port}/execute`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command_id: cid, proposal: PROPOSAL }),
    });
    const body = await r.json();
    assert.equal(r.status, 409, JSON.stringify(body));
    assert.match(body.error, /IDEMPOTENCY_INTENT_IN_FLIGHT/);
    // Review 2026-09-16: the client must be told WHICH command to resume —
    // structured field, not a string to parse.
    assert.equal(body.code, "IDEMPOTENCY_INTENT_IN_FLIGHT");
    assert.equal(body.clash_command_id, inFlight);
    assert.equal(store.status(cid), null, "the refused command must not be recorded");
  } finally {
    delete process.env.MOCK_ERP_STATE;
    server?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("/execute: FAILED command is terminal (409) even before any ERPNext call", async () => {
  const dir = mkdtempSync(join(tmpdir(), "idem-http-"));
  let server = null;
  try {
    const { createAskServer } = await import("../src/http-ask.mjs");
    const { IdempotencyStore } = await import("../src/idempotency.mjs");
    const store = new IdempotencyStore(dir);
    server = createAskServer({ port: 0, host: "127.0.0.1", idemStore: store });
    const port = await new Promise((res, rej) => {
      server.once("error", rej);
      server.listen(0, "127.0.0.1", () => res(server.address().port));
    });
    const base = `http://127.0.0.1:${port}`;
    const cid = randomUUID();

    // Make the write fail by pointing at an invoice the mock never settles:
    // the mock mcp inside createAskServer uses the REAL mock-server (in-DB),
    // where CUST-00001 has SINV-0001 with 2.500.000 outstanding. A proposal
    // for a non-existent invoice still re-reads live data and fails cleanly.
    const badProposal = { ...PROPOSAL, params: { ...PROPOSAL.params, invoice: "SINV-9999" } };
    const r1 = await fetch(`${base}/execute`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command_id: cid, proposal: badProposal }),
    });
    assert.equal(r1.status, 500, "re-read finds no such invoice → clean failure");
    const b1 = await r1.json();
    assert.match(b1.error, /không còn nợ|không tìm thấy|execute failed/);

    // retry with the SAME id → 409 terminal, never re-executed
    const r2 = await fetch(`${base}/execute`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command_id: cid, proposal: badProposal }),
    });
    assert.equal(r2.status, 409);
    const b2 = await r2.json();
    assert.match(b2.error, /IDEMPOTENCY_FAILED_TERMINAL/);
  } finally {
    server?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
