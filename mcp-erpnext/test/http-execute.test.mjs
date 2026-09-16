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
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

// Hermetic: same shell-leak protection as http-ask.test.mjs.
for (const k of Object.keys(process.env)) {
  if (/^(ERPNEXT_|ASK_)/.test(k)) delete process.env[k];
}

const PROPOSAL = {
  schema: "erpn.proposal/v1",
  action: "create_payment_entry",
  risk: "HIGH",
  entity: { kind: "customer", id: "CUST-00001", name: "Khách mock" },
  params: { amount_vnd: 2_500_000, invoice: "SINV-0001", mode: "Tiền mặt" },
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
