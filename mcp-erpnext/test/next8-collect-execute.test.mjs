/**
 * next8 / Phase 4 — COLLECT: safety execute (multi-reference) end to end.
 *
 * Runs the REAL `/execute` gateway path against the REAL MCP client and the mock
 * ERPNext, with the REAL idempotency store and job queue, so what is pinned here
 * is the whole chain and not a helper:
 *
 *   propose (authoritative, Phase 3) → confirm → ONE Payment Entry, NHÁP, with
 *   ONE reference row per allocated invoice and the unallocated part written
 *   EXPLICITLY (plan §5, lock §6.1/§6.3);
 *   a live number that moved between propose and confirm ⇒ PROPOSAL_STALE, and
 *   an invoice that stopped being receivable ⇒ PAYMENT_INVOICE_NOT_RECEIVABLE —
 *   both BEFORE `setReference`, so neither registers nor writes;
 *   a second confirm of the SAME command_id REPLAYS (one document, never two);
 *   ERPNext losing the response after committing ⇒ 503 retry_same_command_id,
 *   the job is queued, and the retry RECONCILES to the one document.
 *
 * The two-invoice case needs a customer with TWO open invoices, which the shared
 * fixture does not have (CUST-00001's second invoice is settled on purpose — the
 * "credit note / settled" reads depend on it). It is supplied the way every other
 * suite supplies site data: `MOCK_ERP_INV_FIXTURE` (an env-declared array of
 * already-submitted invoices), so the default ledger stays byte-identical.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

for (const k of Object.keys(process.env)) {
  if (/^(ERPNEXT_|ASK_)/.test(k)) delete process.env[k];
}
// The mock is opt-in everywhere: state it explicitly so this suite cannot pass
// by accident against a real deployment's configuration.
process.env.COPILOT_MOCK_OK = "1";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");

import { buildHandoff, handoffStore, SLOT_STATES } from "../src/business-handoff.mjs";

const COMPANY = "Demo Feed Co";
/** Nguyễn Thị Lan — SINV-0001 open (2.500.000). */
const LAN = "CUST-00001";
const RECEIVABLE = "1310 - Debtors - DFC";

/** The extra open invoice on the SAME customer: the second half of a real split. */
const SINV_0005 = {
  name: "SINV-0005",
  customer: LAN,
  company: COMPANY,
  posting_date: "2026-09-02",
  grand_total: 1_800_000,
  outstanding_amount: 1_800_000,
  debit_to: RECEIVABLE,
  docstatus: 1,
  is_return: 0,
  status: "Unpaid",
};
const withFixture = (rows) => {
  if (rows === null) delete process.env.MOCK_ERP_INV_FIXTURE;
  else process.env.MOCK_ERP_INV_FIXTURE = JSON.stringify(rows);
};

/**
 * Boot the real ask server over the mock ERPNext with a temp state file + a temp
 * idempotency/job directory, then hand the test the pieces it needs to inspect
 * the LEDGER (what ERPNext actually holds) rather than trusting the response.
 */
async function withServer(fn) {
  const dir = mkdtempSync(path.join(tmpdir(), "next8-exec-"));
  const previousState = process.env.MOCK_ERP_STATE;
  let server = null;
  const { createAskServer } = await import("../src/http-ask.mjs");
  const { IdempotencyStore } = await import("../src/idempotency.mjs");
  const { JobQueue, jobQueueConfig } = await import("../src/job-queue.mjs");
  try {
    process.env.MOCK_ERP_STATE = path.join(dir, "mock-erp.json");
    handoffStore.clear();
    server = createAskServer({
      port: 0,
      host: "127.0.0.1",
      env: process.env,
      idemStore: new IdempotencyStore(dir),
      // `enabled` must be spelled out: a config without it is "off", and the
      // chaos test needs the queue to actually accept the retryable refusal.
      jobs: new JobQueue({ config: { ...jobQueueConfig(), dir } }),
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    return await fn({
      base: `http://127.0.0.1:${server.address().port}`,
      /** What the mock ERPNext actually holds, read off its persisted ledger. */
      ledger: () => {
        const file = process.env.MOCK_ERP_STATE;
        if (!existsSync(file)) return { payments: [] };
        const raw = JSON.parse(readFileSync(file, "utf8"));
        return { payments: Array.isArray(raw.payments) ? raw.payments : [] };
      },
    });
  } finally {
    server?.close();
    handoffStore.clear();
    if (previousState === undefined) delete process.env.MOCK_ERP_STATE;
    else process.env.MOCK_ERP_STATE = previousState;
    rmSync(dir, { recursive: true, force: true });
  }
}

const post = async (base, route, body) => {
  const res = await fetch(`${base}${route}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
};

/** A ticket the route will accept (subject + principal + conversation all "local"). */
function ticketFor(customerId = LAN) {
  const handoff = buildHandoff({
    capability: "payment.create",
    principalId: "local",
    conversationId: null,
    question: "thu tiền cho khách",
    prefill: { customer: { state: SLOT_STATES.RESOLVED, id: customerId, label: "Nguyễn Thị Lan" } },
  });
  handoffStore.put(handoff, { principalId: "local", conversationId: null });
  return handoff;
}

/** propose → the ordinary proposal object the card confirms. */
async function propose(base, values) {
  return post(base, "/collect/propose", { handoff_id: ticketFor().handoff_id, values });
}

const values = (over = {}) => ({
  customer_id: LAN,
  allocations: [{ invoice_id: "SINV-0001", allocated_amount: 500_000 }],
  payment_methods: [{ mode: "cash", amount: 500_000 }],
  ...over,
});

const execute = (base, proposal, commandId) =>
  post(base, "/execute", { command_id: commandId ?? randomUUID(), proposal });

test("Phase 4 — propose two invoices ⇒ confirm writes ONE draft with a row per invoice", async () => {
  withFixture([SINV_0005]);
  try {
    await withServer(async ({ base, ledger }) => {
      const proposed = await propose(
        base,
        values({
          allocations: [
            { invoice_id: "SINV-0001", allocated_amount: 500_000 },
            { invoice_id: "SINV-0005", allocated_amount: 700_000 },
          ],
          payment_methods: [{ mode: "cash", amount: 1_200_000 }],
        }),
      );
      assert.equal(proposed.status, 200, JSON.stringify(proposed.body));
      assert.equal(proposed.body.proposal.params.allocations.length, 2);
      assert.equal(proposed.body.proposal.params.amount_vnd, 1_200_000);
      assert.equal(proposed.body.proposal.params.unallocated_vnd, 0);

      const commandId = randomUUID();
      const confirmed = await execute(base, proposed.body.proposal, commandId);
      assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));
      assert.equal(confirmed.body.replay, false);
      const result = confirmed.body.result;
      assert.deepEqual(result.invoices, ["SINV-0001", "SINV-0005"]);
      assert.equal(result.invoice, "SINV-0001", "the anchor stays the FIRST allocation");
      assert.equal(result.paid_vnd, 1_200_000);
      assert.equal(result.allocated_vnd, 1_200_000);
      assert.equal(result.unallocated_vnd, 0);
      assert.equal(result.docstatus, 0, "created as a DRAFT, never submitted");
      assert.equal(result.reference_no, commandId);

      // What the SITE holds: one document, two allocated rows, explicit unallocated.
      const payments = ledger().payments.filter((p) => p.reference_no === commandId);
      assert.equal(payments.length, 1, "exactly one Payment Entry");
      const pe = payments[0];
      assert.equal(pe.docstatus, 0);
      assert.equal(pe.paid_amount, 1_200_000);
      assert.equal(pe.unallocated_amount, 0);
      assert.equal(pe.party, LAN);
      assert.equal(pe.company, COMPANY);
      assert.equal(pe.references.length, 2);
      const byName = new Map(pe.references.map((r) => [r.reference_name, r]));
      assert.equal(byName.get("SINV-0001").allocated_amount, 500_000);
      assert.equal(byName.get("SINV-0005").allocated_amount, 700_000);
      for (const r of pe.references) assert.equal(r.reference_doctype, "Sales Invoice");
    });
  } finally {
    withFixture(null);
  }
});

test("Phase 4 — confirming the SAME command_id twice REPLAYS: still one document", async () => {
  withFixture([SINV_0005]);
  try {
    await withServer(async ({ base, ledger }) => {
      const proposed = await propose(
        base,
        values({
          allocations: [
            { invoice_id: "SINV-0001", allocated_amount: 300_000 },
            { invoice_id: "SINV-0005", allocated_amount: 200_000 },
          ],
          payment_methods: [{ mode: "cash", amount: 500_000 }],
        }),
      );
      const commandId = randomUUID();
      const first = await execute(base, proposed.body.proposal, commandId);
      assert.equal(first.status, 200, JSON.stringify(first.body));
      const second = await execute(base, proposed.body.proposal, commandId);
      assert.equal(second.status, 200, JSON.stringify(second.body));
      assert.equal(second.body.replay, true, "the second confirm must REPLAY, not re-write");
      assert.equal(second.body.result.erpnext_doc, first.body.result.erpnext_doc);
      assert.equal(ledger().payments.filter((p) => p.reference_no === commandId).length, 1);
    });
  } finally {
    withFixture(null);
  }
});

test("Phase 4 — the debt MOVED between propose and confirm ⇒ PROPOSAL_STALE, nothing written", async () => {
  withFixture([SINV_0005]);
  try {
    await withServer(async ({ base, ledger }) => {
      const proposed = await propose(
        base,
        values({
          allocations: [{ invoice_id: "SINV-0005", allocated_amount: 500_000 }],
          payment_methods: [{ mode: "cash", amount: 500_000 }],
        }),
      );
      assert.equal(proposed.status, 200, JSON.stringify(proposed.body));
      // Someone else settled 1.500.000 of SINV-0005 while the screen was open:
      // the snapshot the user confirmed (1.800.000) no longer matches.
      withFixture([{ ...SINV_0005, grand_total: 300_000, outstanding_amount: 300_000 }]);
      const drifted = await execute(base, proposed.body.proposal);
      assert.ok(drifted.status >= 400, JSON.stringify(drifted.body));
      // The taxonomy code (P1 §12) plus the legacy one every older client knows.
      assert.equal(drifted.body.code, "PROPOSAL_VERSION_STALE", JSON.stringify(drifted.body));
      assert.equal(drifted.body.legacy_code, "PROPOSAL_STALE");
      assert.equal(ledger().payments.length, 0, "no document may exist after a refused confirm");
    });
  } finally {
    withFixture(null);
  }
});

test("Phase 4 — an allocated invoice that stopped being receivable is REFUSED, nothing written", async () => {
  withFixture([SINV_0005]);
  try {
    await withServer(async ({ base, ledger }) => {
      const proposed = await propose(
        base,
        values({
          allocations: [{ invoice_id: "SINV-0005", allocated_amount: 500_000 }],
          payment_methods: [{ mode: "cash", amount: 500_000 }],
        }),
      );
      // Settled between the proposal and the confirmation.
      withFixture([{ ...SINV_0005, outstanding_amount: 0 }]);
      const refused = await execute(base, proposed.body.proposal);
      assert.ok(refused.status >= 400, JSON.stringify(refused.body));
      assert.equal(refused.body.code, "PAYMENT_INVOICE_NOT_RECEIVABLE", JSON.stringify(refused.body));
      assert.equal(ledger().payments.length, 0);
    });
  } finally {
    withFixture(null);
  }
});

test("Phase 4 — an allocation tampered to ANOTHER customer's invoice is refused, nothing written", async () => {
  await withServer(async ({ base, ledger }) => {
    const proposed = await propose(base, values());
    assert.equal(proposed.status, 200, JSON.stringify(proposed.body));
    // SINV-0003 belongs to CUST-00002. The propose route would never emit this
    // (`NO_MATCH`), so the point is that the EXECUTOR refuses it too — from its
    // own fresh per-invoice read, not from the proposal's word.
    const tampered = {
      ...proposed.body.proposal,
      params: {
        ...proposed.body.proposal.params,
        invoice: "SINV-0003",
        allocations: [{ invoice_id: "SINV-0003", allocated_amount: 500_000 }],
      },
    };
    const refused = await execute(base, tampered);
    assert.ok(refused.status >= 400, JSON.stringify(refused.body));
    // The per-invoice party compare is what catches it (a different master).
    assert.equal(refused.body.code, "PROPOSAL_ENTITY_CHANGED", JSON.stringify(refused.body));
    assert.equal(refused.body.legacy_code, "PROPOSAL_STALE");
    assert.match(refused.body.problems.join(" "), /SINV-0003/);
    assert.equal(ledger().payments.length, 0, "no document may exist after a refused confirm");
  });
});

test("Phase 4 chaos — a LOST response after the commit ⇒ 503, queued, and the retry reconciles to ONE document", async () => {
  await withServer(async ({ base, ledger }) => {
    const proposed = await propose(base, values());
    const commandId = randomUUID();
    process.env.MOCK_ERP_FAIL_AFTER_WRITE = "1";
    let lost;
    try {
      lost = await execute(base, proposed.body.proposal, commandId);
    } finally {
      delete process.env.MOCK_ERP_FAIL_AFTER_WRITE;
    }
    assert.equal(lost.status, 503, JSON.stringify(lost.body));
    assert.equal(lost.body.retry_same_command_id, true);
    // The document IS on the site (only the reply was lost) — that is the whole
    // reason the retry must reconcile rather than write again.
    assert.equal(ledger().payments.filter((p) => p.reference_no === commandId).length, 1);

    const jobs = await (await fetch(`${base}/jobs`)).json();
    assert.ok(
      jobs.pending.some((j) => j.command_id === commandId),
      `the retryable refusal must be queued: ${JSON.stringify(jobs)}`,
    );

    const retried = await execute(base, proposed.body.proposal, commandId);
    assert.equal(retried.status, 200, JSON.stringify(retried.body));
    assert.equal(retried.body.replay, true, "the retry reconciles; it does not create a second document");
    assert.equal(ledger().payments.filter((p) => p.reference_no === commandId).length, 1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// TRIPWIRE — /execute stays the ONE door to the Payment Entry write
// ─────────────────────────────────────────────────────────────────────────────
test("Phase 4 TRIPWIRE — only the Safety Gateway reaches the Payment Entry executor", () => {
  // The executor is what calls `erpnext_doc_create`/`erpnext_doc_submit` for a
  // Payment Entry. `WRITE_EXECUTORS` in the gateway is its ONE registration: a
  // second caller would be a second write door, exactly what this phase forbids.
  const files = [];
  const walk = (rel) => {
    for (const entry of readdirSync(path.resolve(ROOT, rel), { withFileTypes: true })) {
      const child = path.join(rel, entry.name);
      if (entry.isDirectory()) walk(child);
      else if (entry.name.endsWith(".mjs")) files.push(child);
    }
  };
  walk("src");
  if (existsSync(path.resolve(ROOT, "scripts"))) walk("scripts");

  const callers = files.filter((rel) => {
    if (rel === path.join("src", "skills", "payment-write.mjs")) return false; // the definition
    return /executePaymentProposal/.test(readFileSync(path.resolve(ROOT, rel), "utf8"));
  });
  assert.deepEqual(
    callers,
    [path.join("src", "safety-gateway.mjs")],
    "the collect executor must have exactly ONE caller: the Safety Gateway",
  );

  // ...and the gateway registers it under the canonical capability id (lock §6.5),
  // not the alias, so a migrated client cannot reach a second entry.
  const gateway = readFileSync(path.resolve(ROOT, "src", "safety-gateway.mjs"), "utf8");
  assert.match(gateway, /"payment\.create":\s*\{[\s\S]*?executePaymentProposal\(/, "payment.create is the registered executor");
  assert.equal(/executePaymentProposal\([^)]*payment\.collect/.test(gateway), false);
});
