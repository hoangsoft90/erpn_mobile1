/**
 * next9 — cross-turn entity isolation (`.plan/next9/plan-debug.md`,
 * `.plan/next9/prompt-1.md` §4–§9).
 *
 * The incident: after (a) an EARLIER sentence about customer X and (b) creating
 * customer Y, the sentence "thu tiền Y <amount>" was answered about X. The
 * invariant this file pins is the business rule the plan states at §16:
 *
 *     USER ASKED ENTITY X  →  RESOLVE X  →  FOUND X  →  USE X
 *     USER ASKED ENTITY X  →  X NOT FOUND  →  NO_MATCH (never another entity)
 *
 * Measured cause (probe `scripts/debug-next9-probe.mjs`, 2026-09-28): the WRITE
 * path REPLACED the party the sentence had just resolved EXACTLY with the
 * customer remembered in the server-side session context — `customerId` came
 * from `sessionContext.writeEligible("customer")` unconditionally. So a
 * remembered Lan overwrote a freshly resolved Lê Lợi and the proposal named the
 * wrong payer (a money document about the wrong customer).
 *
 *   Test A  read Lan (exact) → create Lê Lợi → "thu tiền Lê lợi": must be Lê Lợi
 *   Test B  read Lan (exact) → "thu tiền Nguyễn Thị Lan": must still be Lan
 *   Test C  read Lan (exact) → an ABSENT name: MISSING_ENTITY, no party bound
 *   Test E  the same sentence with and without the context binds the same id
 *   Test F  six turns in one process: every turn resolves its OWN entity
 *   Test H  "explicit entity always wins over stale session context"
 *
 * Every assertion is on an ID (never on display text alone) — prompt-1 §3.1.
 * Test D (ambiguous) and Test G (cross entity type) need injected master data
 * and live in `next9-entity-isolation-fixtures.test.mjs`: the mock reads its
 * state file at import time, so a fixture cannot be added inside this process.
 *
 * Runs against createAskServer() on an ephemeral port with the REAL Python NLP
 * service (mock ERPNext, no credentials, no LLM) — the same hermetic harness
 * next8-entity-pick.test.mjs uses.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

for (const k of Object.keys(process.env)) {
  if (/^(ERPNEXT_|ASK_)/.test(k)) delete process.env[k];
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");

/** The customer already in the mock fixture (used to seed the context). */
const LAN_ID = "CUST-00001";

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

/**
 * One hermetic server per test: a fresh mock-ERP state file AND a fresh NLP
 * port. The session store is module-level (that is the thing under test), so
 * each test clears it explicitly rather than relying on module identity.
 */
async function withServer(fn) {
  const nlp = await startNlpService();
  const dir = mkdtempSync(path.join(tmpdir(), "next9-"));
  const previousPort = process.env.NLP_SERVICE_PORT;
  const previousState = process.env.MOCK_ERP_STATE;
  let server = null;
  // Imported BEFORE the try: the finally block below also needs the seam, and a
  // `const` declared inside try is not visible there (the same scope bug the
  // pipeline's own hoisting comment records).
  const { __setNlpServicePortForTest, __resetSessionContext, __sessionContext } =
    await import("../src/copilot-server.mjs");
  try {
    process.env.NLP_SERVICE_PORT = String(nlp.port);
    process.env.MOCK_ERP_STATE = path.join(dir, "mock-erp.json");
    __setNlpServicePortForTest(nlp.port);
    __resetSessionContext();
    const { createAskServer } = await import("../src/http-ask.mjs");
    const { IdempotencyStore } = await import("../src/idempotency.mjs");
    server = createAskServer({
      port: 0,
      host: "127.0.0.1",
      idemStore: new IdempotencyStore(dir),
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    return await fn({
      base: `http://127.0.0.1:${server.address().port}`,
      resetSessionContext: __resetSessionContext,
      // The store's own map: tests assert the SEED took effect, so a test can
      // never pass by never remembering anything (prompt-1 §8).
      contextEntries: () => [...__sessionContext().entries.keys()],
    });
  } finally {
    server?.close();
    nlp.child.kill();
    __setNlpServicePortForTest(previousPort ?? "8787");
    if (previousPort === undefined) delete process.env.NLP_SERVICE_PORT;
    if (previousState === undefined) delete process.env.MOCK_ERP_STATE;
    else process.env.MOCK_ERP_STATE = previousState;
    rmSync(dir, { recursive: true, force: true });
  }
}

const ask = async (base, body) => {
  const r = await fetch(`${base}/ask`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json() };
};

const result = (r) => r.body?.result ?? {};


/**
 * The id of the party an answer is bound to, read from the RESULT field the
 * client uses — never from the answer text. Reads expose `customer`, writes
 * expose the proposal's entity.
 */
const boundPartyId = (r) => {
  const res = result(r);
  const c = res.customer;
  return (
    res.proposal?.entity?.id ??
    (c && typeof c === "object" ? (c.id ?? c.name ?? null) : (c ?? null))
  );
};

/** The seeded read that puts a WRITE-eligible customer into the session context. */
const readLanExactly = (base) => ask(base, { text: "công nợ của Nguyễn Thị Lan" });

/**
 * Creates a customer the way the app does: /ask builds the proposal, /execute
 * (human confirm) writes it. Returns the new ERPNext id.
 */
async function createCustomer(base, name) {
  const card = await ask(base, { text: `thêm khách ${name}` });
  const proposal = result(card).proposal;
  assert.ok(proposal, `expected a create-customer card for ${name}: ${JSON.stringify(result(card))}`);
  const ex = await fetch(`${base}/execute`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ command_id: randomUUID(), proposal }),
  });
  const body = await ex.json();
  assert.equal(body.ok, true, `create ${name} failed: ${JSON.stringify(body)}`);
  return body.result.erpnext_doc;
}

test("next9 Test A — stale context must not override the explicit entity", async () => {
  await withServer(async ({ base }) => {
    const lan = await readLanExactly(base);
    assert.equal(boundPartyId(lan), LAN_ID, "seed: the read resolves Lan exactly");

    const leLoi = await createCustomer(base, "Lê Lợi");
    assert.notEqual(leLoi, LAN_ID);

    const t2 = await ask(base, { text: "thu tiền Lê lợi 10000" });
    assert.equal(t2.status, 200);
    const body = result(t2);
    assert.equal(boundPartyId(t2), leLoi, `the WRITE must bind the customer the sentence named: ${JSON.stringify(body)}`);
    assert.notEqual(boundPartyId(t2), LAN_ID, "and never the remembered customer");
    assert.equal(
      JSON.stringify(body).includes("Nguyễn Thị Lan"),
      false,
      "no part of a Lê Lợi answer may talk about Lan",
    );
  });
});

test("next9 Test B — naming the remembered customer still resolves HER (no over-correction)", async () => {
  await withServer(async ({ base }) => {
    await readLanExactly(base);
    await createCustomer(base, "Lê Lợi");

    const tB = await ask(base, { text: "thu tiền Nguyễn Thị Lan 10000" });
    assert.equal(boundPartyId(tB), LAN_ID, `expected Lan: ${JSON.stringify(result(tB))}`);
    assert.ok(result(tB).proposal, "Lan has an open invoice, so a proposal is built");
    assert.equal(result(tB).proposal.entity.id, LAN_ID);
  });
});

test("next9 Test C — an absent entity is MISSING_ENTITY, never the remembered one", async () => {
  await withServer(async ({ base }) => {
    await readLanExactly(base);
    const leLoi = await createCustomer(base, "Lê Lợi");

    // Measured on this fixture (scripts/probe-next9-fixtures.mjs): a name that
    // matches nothing is refused with MISSING_ENTITY before any proposal.
    const tC = await ask(base, { text: "thu tiền Không Có Ai Tên Này 10000" });
    assert.equal(tC.status, 200);
    const body = result(tC);
    assert.equal(body.error_code, "MISSING_ENTITY", `expected a not-found refusal: ${JSON.stringify(body)}`);
    assert.equal(body.proposal, null, "nothing may be proposed for an absent customer");
    assert.equal(boundPartyId(tC), null, "and no party may be bound");
    assert.equal(body.answer, null, "a refusal is not an answer");
    // The three substitutions the plan forbids by name:
    for (const forbidden of [LAN_ID, leLoi]) {
      assert.equal(
        JSON.stringify(body).includes(forbidden),
        false,
        `the refusal must not mention ${forbidden}`,
      );
    }
  });
});

test("next9 Test E — with and without the session context, the binding is the same id", async () => {
  await withServer(async ({ base, resetSessionContext }) => {
    await readLanExactly(base);
    const leLoi = await createCustomer(base, "Lê Lợi");

    // #1 — the context is ALIVE and points at Lan, a different customer.
    const first = await ask(base, { text: "thu tiền Lê lợi 10000" });
    // #2 — the same sentence with the whole store dropped.
    resetSessionContext();
    const second = await ask(base, { text: "thu tiền Lê lợi 10000" });

    assert.equal(boundPartyId(first), leLoi, `request #1 bound the wrong party: ${JSON.stringify(result(first))}`);
    assert.equal(boundPartyId(second), leLoi, `request #2 bound the wrong party: ${JSON.stringify(result(second))}`);
    assert.equal(boundPartyId(first), boundPartyId(second), "the remembered context changed nothing");
  });
});

test("next9 Test F — multi-turn isolation: every turn resolves its own entity", async () => {
  await withServer(async ({ base }) => {
    await readLanExactly(base);
    const leLoi = await createCustomer(base, "Lê Lợi");

    const seq = [
      { text: "thu tiền Nguyễn Thị Lan 5000", expect: LAN_ID },
      { text: "thu tiền Lê lợi 5000", expect: leLoi },
      { text: "công nợ Nguyễn Thị Lan", expect: LAN_ID },
      { text: "thu tiền Lê lợi 5000", expect: leLoi },
      // A turn that resolves NOTHING must not fall back to the previous turn.
      { text: "thu tiền Không Có Ai Tên Này 5000", expect: null },
      { text: "thu tiền Nguyễn Thị Lan 5000", expect: LAN_ID },
    ];
    for (const step of seq) {
      const r = await ask(base, { text: step.text });
      assert.equal(
        boundPartyId(r),
        step.expect,
        `"${step.text}" bound the wrong party: ${JSON.stringify(result(r))}`,
      );
    }
  });
});

test("next9 Test H — explicit entity always wins over stale session context", async () => {
  await withServer(async ({ base, contextEntries }) => {
    await readLanExactly(base);
    const leLoi = await createCustomer(base, "Lê Lợi");
    assert.ok(
      contextEntries().some((k) => k.endsWith("\u0000customer")),
      "setup assertion: a customer context must actually exist, or this test proves nothing",
    );

    const r = await ask(base, { text: "thu tiền Lê lợi 10000" });
    assert.equal(boundPartyId(r), leLoi, `resolved and bound must both be Lê Lợi: ${JSON.stringify(result(r))}`);
  });
});
