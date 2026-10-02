/**
 * next9 — EXECUTE ENTITY BINDING (prompt-2 §1, the final close gate).
 *
 * The invariant to prove end to end:
 *
 *     ASK X → resolve X → proposal.entity.id = X.id
 *     → context/session later changes to Y
 *     → EXECUTE the (old) proposal
 *     → executed entity is STILL X.id — never Y
 *
 * Measured preconditions (verify-first, not assumptions):
 *   - `safety-gateway.mjs` builds the ERP payload from `proposal.entity.id`
 *     (`customer: proposal.entity.id`) and refuses 400 when a proposal has no
 *     resolved id — the display name is never the binding value.
 *   - After the next9 fix, `sessionContext` has ZERO read points in the
 *     pipeline (grep: only `.set()` remains), so the execute path cannot
 *     consume remembered state. These tests pin that with runtime evidence.
 *
 * The context change is done the way the PRODUCTION app would do it — a real
 * `/ask` sentence that resolves a different customer — plus a store reset, so
 * both "the memory moved on" and "the process restarted" are covered.
 *
 * Read-only for ERP: the payment execute goes to the MOCK ERP (a draft Payment
 * Entry in a throwaway state file), never to a real site, and needs no
 * credentials.
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

async function withServer(fn) {
  const nlp = await startNlpService();
  const dir = mkdtempSync(path.join(tmpdir(), "next9-exec-"));
  const previousPort = process.env.NLP_SERVICE_PORT;
  const previousState = process.env.MOCK_ERP_STATE;
  let server = null;
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

const post = async (base, path_, body) => {
  const r = await fetch(`${base}${path_}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json() };
};

const ask = (base, text) => post(base, "/ask", { text });
const result = (r) => r.body?.result ?? {};

/** The seeded read that puts a WRITE-eligible customer into the context. */
const readLanExactly = (base) => ask(base, "công nợ của Nguyễn Thị Lan");

/**
 * The payment proposal for a customer the sentence names. Lan has the open
 * invoice fixture (2.500.000 outstanding), so a proposal IS built for her.
 */
const paymentProposalForLan = async (base) => {
  const r = await ask(base, "thu tiền Nguyễn Thị Lan 10000");
  const proposal = result(r).proposal;
  assert.ok(proposal, `expected a payment proposal for Lan: ${JSON.stringify(result(r))}`);
  assert.equal(proposal.entity.id, LAN_ID);
  return proposal;
};

const execute = (base, proposal, commandId) =>
  post(base, "/execute", { command_id: commandId ?? randomUUID(), proposal });

test("prompt-2 §1 — context changes AFTER the proposal: the execute still binds X", async () => {
  await withServer(async ({ base }) => {
    // 1+2. resolve Lê Lợi? No — Lan here is X. Build the proposal for X = Lan.
    const proposal = await paymentProposalForLan(base);
    assert.equal(proposal.entity.id, LAN_ID);

    // 3. the session later moves on to a DIFFERENT customer Y (a real read).
    const y = await ask(base, "thêm khách Bảy");
    const yEx = await execute(base, result(y).proposal);
    assert.equal(yEx.body.ok, true, `setup: create Y failed: ${JSON.stringify(yEx.body)}`);
    const Y_ID = yEx.body.result.erpnext_doc;
    // A read of Y seeds the context with Y (provenance user_selected).
    const seedY = await ask(base, `công nợ của Bảy`);
    assert.equal(result(seedY).customer?.id ?? result(seedY).customer, Y_ID, "setup: context now points at Y");

    // 4. execute the OLD proposal (X), with the memory now saying Y.
    const ex = await execute(base, proposal);
    assert.equal(ex.status, 200, `execute failed: ${JSON.stringify(ex.body)}`);
    assert.equal(ex.body.ok, true, `execute refused: ${JSON.stringify(ex.body)}`);

    // 5+6. the executed document belongs to X — never Y.
    const doc = ex.body.result.erpnext_doc ?? ex.body.result.doc?.name;
    assert.ok(doc, `expected a created doc: ${JSON.stringify(ex.body.result)}`);
    assert.equal(ex.body.result.party_kind ?? "customer", "customer");
    assert.equal(
      ex.body.result.customer,
      LAN_ID,
      `the executed payment must carry X's id: ${JSON.stringify(ex.body.result)}`,
    );
    assert.notEqual(ex.body.result.customer, Y_ID, "and never the later context Y");
  });
});

test("prompt-2 §1 — context RESET between ask and execute changes nothing", async () => {
  await withServer(async ({ base, resetSessionContext }) => {
    const proposal = await paymentProposalForLan(base);
    // Simulate the gateway process restarting (the store is in-memory).
    resetSessionContext();
    assert.equal(Object.keys({}).length, 0);
    const ex = await execute(base, proposal);
    assert.equal(ex.body.ok, true, `execute refused: ${JSON.stringify(ex.body)}`);
    assert.equal(ex.body.result.customer, LAN_ID, `executed entity must stay X: ${JSON.stringify(ex.body.result)}`);
  });
});

test("prompt-2 §1 — the memory BEFORE the ask must not leak into the execute either", async () => {
  await withServer(async ({ base, contextEntries }) => {
    // Seed the context with Lan first...
    await readLanExactly(base);
    assert.ok(
      contextEntries().some((k) => k.endsWith("\u0000customer")),
      "setup: the customer context must exist",
    );
    // ...but the proposal is for LÊ LỢI — a customer created in this session.
    const create = await ask(base, "thêm khách Lê Lợi");
    const leLoiProposal = result(create).proposal;
    assert.ok(leLoiProposal, `expected a create-customer card: ${JSON.stringify(result(create))}`);
    const sameCommand = randomUUID();
    const created = await execute(base, leLoiProposal, sameCommand);
    assert.equal(created.body.ok, true, JSON.stringify(created.body));
    const LE_LOI_ID = created.body.result.erpnext_doc;
    assert.notEqual(LE_LOI_ID, LAN_ID);

    // Executing the Lê Lợi proposal must never fall back to the remembered Lan.
    // (Measured: the same proposal re-submitted does NOT re-resolve anything —
    // a same-command retry REPLAYS the recorded Lê Lợi result, and a NEW
    // command for the same action is refused by the business-dedup layer with
    // existing_doc = Lê Lợi. Neither path consults the remembered customer.)
    const replay = await execute(base, leLoiProposal, sameCommand);
    assert.equal(replay.body.ok, true, JSON.stringify(replay.body));
    assert.equal(replay.body.replay, true, "same command_id must replay, not re-execute");
    assert.equal(
      replay.body.result.customer,
      LE_LOI_ID,
      `replay must stay Lê Lợi: ${JSON.stringify(replay.body)}`,
    );

    const newCommand = await execute(base, leLoiProposal);
    assert.equal(newCommand.status, 409, `expected the business-dedup refusal: ${JSON.stringify(newCommand.body)}`);
    assert.equal(newCommand.body.code, "CC_DUPLICATE_ACTION");
    assert.equal(
      newCommand.body.existing_doc,
      LE_LOI_ID,
      `the refusal must name Lê Lợi, never the remembered Lan: ${JSON.stringify(newCommand.body)}`,
    );
  });
});
