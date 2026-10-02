/**
 * next8 / Phase 1 — the collect HANDOFF and the /collect/propose route, run
 * end-to-end against the real gateway + real NLP + the mock ERPNext.
 *
 * What this suite is really protecting (plan1_final_v2 §8/§9 + owner lock §6.1–6.5):
 *   1. a routed collect sentence that is missing a SLOT answers with a ticket
 *      instead of a dead end — and the ticket carries no number;
 *   2. the ticket is the ONLY way in: fabricated, foreign-principal and
 *      foreign-conversation tickets are all refused with the same code;
 *   3. the form's values are re-validated server-side, so the lock's rules hold
 *      even when a client ignores them (one method, allocations when something is
 *      open, per-invoice ceiling, totals must match);
 *   4. the route returns the ORDINARY proposal object (so confirm/execute needs no
 *      second implementation) and never writes: no write tool is reachable from
 *      this path, asserted both statically and by the mock's own state.
 */

import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

for (const k of Object.keys(process.env)) {
  if (/^(ERPNEXT_|ASK_)/.test(k)) delete process.env[k];
}
// The mock is opt-in EVERYWHERE (never a silent fallback): state it explicitly so
// this suite cannot pass by accident against a real deployment's config.
process.env.COPILOT_MOCK_OK = "1";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");

import { buildHandoff, handoffStore, SLOT_STATES } from "../src/business-handoff.mjs";

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
    handoffStore.clear();
    const { createAskServer } = await import("../src/http-ask.mjs");
    server = createAskServer({ port: 0, host: "127.0.0.1", env: process.env });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    return await fn({ base: `http://127.0.0.1:${server.address().port}` });
  } finally {
    server?.close();
    nlp.child.kill();
    __setNlpServicePortForTest(previousPort ?? "8787");
    handoffStore.clear();
  }
}

const post = (base, route, body) =>
  fetch(`${base}${route}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }).then(async (res) => ({ status: res.status, body: await res.json() }));

/** Ask a collect question and hand back the ticket it issued. */
async function askForHandoff(base, text) {
  const res = await post(base, "/ask", { text });
  assert.equal(res.status, 200, `the chat must answer 200 for "${text}"`);
  const handoff = res.body?.result?.business_handoff;
  assert.ok(handoff, `"${text}" must carry a business handoff`);
  return { ask: res.body.result, handoff };
}

const values = (over = {}) => ({
  customer_id: "CUST-00001",
  allocations: [{ invoice_id: "SINV-0001", allocated_amount: 500_000 }],
  payment_methods: [{ mode: "cash", amount: 500_000 }],
  ...over,
});

test("a routed collect sentence missing its amount yields a ticket, not a dead end", async () => {
  await withServer(async ({ base }) => {
    const { ask, handoff } = await askForHandoff(base, "thu tiền cho Nguyễn Thị Lan");

    // The refusal it came with is unchanged (nothing is proposed in chat) …
    assert.equal(ask.proposal, null);
    assert.equal(ask.error_code, "PAYMENT_AMOUNT_MISSING");
    // … and the ticket says exactly what the screen must open.
    assert.equal(handoff.type, "business_handoff");
    assert.equal(handoff.capability, "payment.create");
    assert.equal(handoff.screen, "collect");
    // The party DID resolve, so the screen opens with the customer chosen…
    assert.equal(handoff.prefill.customer.state, SLOT_STATES.RESOLVED);
    assert.equal(handoff.prefill.customer.id, "CUST-00001");
    assert.equal(handoff.prefill.customer.label, "Nguyễn Thị Lan");
    // … and only the money slots remain: amount MISSING (no number was said),
    // allocations MISSING (there IS an open invoice), method MISSING.
    assert.equal(handoff.prefill.amount.state, SLOT_STATES.MISSING);
    assert.equal(handoff.prefill.allocations.state, SLOT_STATES.MISSING);
    assert.equal(handoff.prefill.payment_methods.state, SLOT_STATES.MISSING);
    // No authoritative number travels: not even the outstanding it read.
    assert.equal(/"(amount|outstanding)[a-z_]*"\s*:\s*\d/.test(JSON.stringify(handoff)), false);
  });
});

test("the ticket opens the form: propose returns the ordinary proposal object", async () => {
  await withServer(async ({ base }) => {
    const { handoff } = await askForHandoff(base, "thu tiền cho Nguyễn Thị Lan");
    const res = await post(base, "/collect/propose", { handoff_id: handoff.handoff_id, values: values() });

    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.capability, "payment.create", "the canonical id (lock §6.5), never the alias");
    assert.equal(res.body.handoff_id, handoff.handoff_id);
    // The SAME proposal shape the chat card carries — so /execute needs no change.
    assert.equal(res.body.proposal.schema, "erpn.proposal/v1");
    assert.equal(res.body.proposal.action, "create_payment_entry");
    assert.equal(res.body.proposal.risk, "HIGH");
    assert.equal(res.body.proposal.params.amount_vnd, 500_000, "the server's number, from the invoice it re-read");
    assert.equal(res.body.invoice, "SINV-0001", "the invoice the USER allocated, never a default");
    // The summary is the server's own arithmetic.
    assert.equal(res.body.summary.payment_total_vnd, 500_000);
    assert.equal(res.body.summary.allocated_total_vnd, 500_000);
    assert.equal(res.body.summary.unallocated_vnd, 0);
  });
});

test("a fabricated, foreign-principal or foreign-conversation ticket is refused the same way", async () => {
  await withServer(async ({ base }) => {
    const { handoff } = await askForHandoff(base, "thu tiền cho Nguyễn Thị Lan");

    const invented = await post(base, "/collect/propose", { handoff_id: "11111111-2222-3333-4444-555555555555", values: values() });
    assert.equal(invented.status, 409);
    assert.equal(invented.body.code, "STALE_HANDOFF");
    assert.equal(invented.body.proposal, null);

    // A ticket issued to somebody else, put straight into the store the server
    // reads (no way to do this over HTTP — that is the point).
    const foreign = buildHandoff({
      capability: "payment.create",
      principalId: "someone-else",
      conversationId: "conv-other",
      question: "thu tiền cho Nguyễn Thị Lan",
      prefill: { customer: { state: SLOT_STATES.MISSING } },
    });
    handoffStore.put(foreign, { principalId: "someone-else", conversationId: "conv-other" });
    const stolen = await post(base, "/collect/propose", { handoff_id: foreign.handoff_id, values: values() });
    assert.equal(stolen.status, 409);
    assert.equal(stolen.body.code, "STALE_HANDOFF", "the same answer a non-existent id gets — no probing");

    // …and the legitimate ticket still works right after.
    const ok = await post(base, "/collect/propose", { handoff_id: handoff.handoff_id, values: values() });
    assert.equal(ok.status, 200);
  });
});

test("the form's values are re-validated server-side: the lock holds even if the client ignores it", async () => {
  await withServer(async ({ base }) => {
    const { handoff } = await askForHandoff(base, "thu tiền cho Nguyễn Thị Lan");
    const propose = (v) => post(base, "/collect/propose", { handoff_id: handoff.handoff_id, values: v });

    // §6.1 — two methods in one receipt.
    const twoModes = await propose(values({
      payment_methods: [{ mode: "cash", amount: 300_000 }, { mode: "bank_transfer", amount: 200_000 }],
    }));
    assert.equal(twoModes.status, 422);
    assert.equal(twoModes.body.code, "PAYMENT_METHOD_COUNT_INVALID");
    assert.match(twoModes.body.reason, /một hình thức thanh toán/);

    // §6.3 — nothing allocated while an invoice is open.
    const noAlloc = await propose(values({ allocations: [] }));
    assert.equal(noAlloc.status, 422);
    assert.equal(noAlloc.body.code, "MISSING_REQUIRED_FIELD");

    // allocations ≠ payment total.
    const mismatch = await propose(values({ payment_methods: [{ mode: "cash", amount: 300_000 }] }));
    assert.equal(mismatch.status, 422);
    assert.equal(mismatch.body.code, "ALLOCATION_TOTAL_MISMATCH");

    // over the invoice's live outstanding (2.5M on SINV-0001).
    const over = await propose(values({
      allocations: [{ invoice_id: "SINV-0001", allocated_amount: 3_000_000 }],
      payment_methods: [{ mode: "cash", amount: 3_000_000 }],
    }));
    assert.equal(over.status, 422);
    assert.equal(over.body.code, "INSUFFICIENT_OUTSTANDING");

    // an invoice this customer does not have.
    const notMine = await propose(values({
      allocations: [{ invoice_id: "SINV-0003", allocated_amount: 500_000 }],
    }));
    assert.equal(notMine.status, 422);
    assert.equal(notMine.body.code, "NO_MATCH");

    // Phase 3: multi-invoice is no longer refused by COUNT (the 422 is gone).
    // This draft still fails, but for a REAL reason: SINV-0002 is settled
    // (outstanding 0), so it is not an allocatable target — `NO_MATCH`, not a
    // "not ready yet" dead end. The valid two-invoice case is pinned as a unit
    // test of buildCollectProposal (the mock has no customer with 2 open).
    const multi = await propose(values({
      allocations: [
        { invoice_id: "SINV-0001", allocated_amount: 250_000 },
        { invoice_id: "SINV-0002", allocated_amount: 250_000 },
      ],
    }));
    assert.equal(multi.status, 422);
    assert.equal(multi.body.code, "NO_MATCH");
    assert.equal(multi.body.proposal, null);
  });
});

test("a deployment that never pinned a company still works: the ERPNext session default is the authority", async () => {
  // Regression guard. Phase 3 briefly required `authz.company` (i.e. a pin) at
  // propose time, which killed the feature on the normal one-company site: the
  // invoice list and the account picker this very screen uses resolve the SITE
  // default instead. The company must be resolved by the SAME rule as
  // /collect/accounts (config pin → ERPNext session default → refusal).
  delete process.env.COPILOT_COMPANY;
  await withServer(async ({ base }) => {
    const { handoff } = await askForHandoff(base, "thu tiền cho Nguyễn Thị Lan");
    const res = await post(base, "/collect/propose", { handoff_id: handoff.handoff_id, values: values() });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    // The money account proves the resolved company was the real one: "Demo
    // Feed Co"'s default cash account is only readable under that company.
    assert.equal(
      res.body.proposal.params.payment_methods[0].account_id,
      "1110 - Cash - DFC",
      "the account was resolved against the company the site default named",
    );
  });
});

test("no pinned company AND no site default is COMPANY_SCOPE_REQUIRED (+ copy), never a guess", async () => {
  // §5.4 row 7. With nothing naming a company anywhere, picking one of the
  // site's companies is not a decision an error path may make (C0 §6.4).
  delete process.env.COPILOT_COMPANY;
  process.env.MOCK_ERP_DEFAULT_COMPANY = "";
  try {
    await withServer(async ({ base }) => {
      const { handoff } = await askForHandoff(base, "thu tiền cho Nguyễn Thị Lan");
      const res = await post(base, "/collect/propose", { handoff_id: handoff.handoff_id, values: values() });
      assert.equal(res.body.code, "COMPANY_SCOPE_REQUIRED", JSON.stringify(res.body));
      assert.equal(res.body.proposal, null, "no proposal may be built without a company");
      assert.match(res.body.reason, /COPILOT_COMPANY/, "the copy says what to configure");
    });
  } finally {
    delete process.env.MOCK_ERP_DEFAULT_COMPANY;
  }
});

test("§5.4 #8 an unreadable ERPNext is fail-closed: ERP_UNAVAILABLE + no proposal (never a 0)", async () => {
  // Row 8 of the validation table. The account read is the last ERPNext read
  // before the proposal is built: if it fails, the ONLY honest answer is "try
  // again" — a proposal with a fabricated account (or an import of zero) would
  // move money against a ledger nobody confirmed.
  process.env.MOCK_ERP_FAIL_ACCOUNT_LIST = "1";
  try {
    await withServer(async ({ base }) => {
      const { handoff } = await askForHandoff(base, "thu tiền cho Nguyễn Thị Lan");
      const res = await post(base, "/collect/propose", { handoff_id: handoff.handoff_id, values: values() });
      assert.equal(res.status, 503, JSON.stringify(res.body));
      assert.equal(res.body.code, "ERP_UNAVAILABLE");
      assert.equal(res.body.proposal, null, "nothing may be proposed on an unread ERPNext");
      assert.match(res.body.reason, /thử lại/, "the copy tells the seller this is retryable");
    });
  } finally {
    delete process.env.MOCK_ERP_FAIL_ACCOUNT_LIST;
  }
});

test("malformed requests are 400s, and every refusal carries no proposal", async () => {
  await withServer(async ({ base }) => {
    const missingTicket = await post(base, "/collect/propose", { values: values() });
    assert.equal(missingTicket.status, 400);
    assert.equal(missingTicket.body.code, "MISSING_REQUIRED_FIELD");

    const { handoff } = await askForHandoff(base, "thu tiền cho Nguyễn Thị Lan");
    const noCustomer = await post(base, "/collect/propose", { handoff_id: handoff.handoff_id, values: { allocations: [], payment_methods: [] } });
    assert.equal(noCustomer.status, 400);
    assert.equal(noCustomer.body.code, "MISSING_REQUIRED_FIELD");
    assert.equal(noCustomer.body.proposal, null);
  });
});

test("F3: a collect question must carry ONLY a stored ticket (put-or-nothing)", async () => {
  await withServer(async ({ base }) => {
    // The chat path is the only producer: every ticket an answer carries must be
    // readable by the route that comes after it. Probing the STORE directly:
    const before = new Set([...handoffStore.entries.keys()]);
    const first = await post(base, "/ask", { text: "thu tiền cho Nguyễn Thị Lan" });
    const after = new Set([...handoffStore.entries.keys()]);
    const added = [...after].filter((id) => !before.has(id));
    assert.equal(added.length, 1, "exactly one ticket is stored per collect question");
    // And the answer's ticket IS the stored one (same id, readable, owned).
    const ticketId = first.body?.result?.business_handoff?.handoff_id;
    assert.equal(added.includes(ticketId), true, "the ticket in the answer is the ticket in the store");
    assert.equal(handoffStore.read(ticketId, { principalId: "local", conversationId: null }).ok, true);
  });
});

test("TRIPWIRE: nothing on the collect path can write", async () => {
  // Static: the two new modules hold no write surface at all…
  for (const file of ["business-handoff.mjs", "transaction-draft.mjs"]) {
    const src = readFileSync(path.resolve(ROOT, "src", file), "utf8");
    for (const banned of ["callTool", "runExecute", "executePaymentProposal", "assertReadOnly"]) {
      assert.equal(src.includes(banned), false, `${file} must not reference ${banned}`);
    }
  }
  // …and the route itself calls the propose helper, never the gateway.
  const httpSrc = readFileSync(path.resolve(ROOT, "src", "http-ask.mjs"), "utf8");
  const start = httpSrc.indexOf('path === "/collect/propose"');
  assert.ok(start > 0, "the route exists");
  const routeBlock = httpSrc.slice(start, start + 6000);
  assert.equal(routeBlock.includes("runExecute("), false, "/collect/propose must never call the write gateway");
  assert.ok(routeBlock.includes("proposeCollectFromHandoff("), "it calls the read+build helper");
  // F4 (plan §7): the propose helper itself must not name a write surface. The
  // only write-shaped import in the pipeline belongs to the chat's card builder
  // (buildPaymentProposal BUILDS, never writes — it is called through the same
  // factory the chat uses); what is banned here is the GATEWAY and the executor.
  const serverSrc = readFileSync(path.resolve(ROOT, "src", "copilot-server.mjs"), "utf8");
  const helper = serverSrc.slice(
    serverSrc.indexOf("proposeCollectFromHandoff"),
    serverSrc.indexOf("export async function answerQuestionLogged"),
  );
  assert.ok(helper.length > 0, "the helper block is locatable");
  for (const banned of ["runExecute", "executePaymentProposal", "WRITE_EXECUTORS"]) {
    assert.equal(helper.includes(banned), false, `the propose helper must not reference ${banned}`);
  }
});
