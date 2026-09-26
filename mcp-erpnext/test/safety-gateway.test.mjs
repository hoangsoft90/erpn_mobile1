/**
 * P0 — Safety Gateway tests (plan2_final §7 invariant, §8 delete policy,
 * §24.3 kill switch, §24.6 property tests, §25).
 *
 * The property that matters most here is the INVARIANT:
 *   "no AI runtime may call ERPNext WRITE without going through the Safety
 *    Gateway" — asserted twice: behaviourally (HTTP) and statically (source
 *    scan, so a future module cannot quietly add a second write path).
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

import { checkAmountPolicy } from "../src/safety-gateway.mjs";
import { getCapability, isStub, listCapabilities } from "../src/capability-contract.mjs";
import { checkKillSwitch, isGlobalReadOnly, killSwitchFlagPath } from "../src/kill-switch.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, "..", "src");

// Hermetic: never let a leaked shell env flip the target or the switch.
for (const k of Object.keys(process.env)) {
  if (/^(ERPNEXT_|ASK_)/.test(k)) delete process.env[k];
}
delete process.env.COPILOT_GLOBAL_READ_ONLY;
delete process.env.COPILOT_DISABLE_CAPABILITIES;

const PROPOSAL = {
  schema: "erpn.proposal/v1",
  // P1 §9: an executable proposal is an immutable snapshot; the gateway refuses
  // one without proposal_id/version (see the "snapshot" test). Real proposals
  // get these from buildProposal().
  proposal_id: "prp_test-safety-gateway",
  version: 1,
  action: "create_payment_entry",
  risk: "HIGH",
  created_at: new Date().toISOString(),
  action_id: "act_test-0000",
  entity: { kind: "customer", id: "CUST-00001", name: "Khách mock" },
  params: { amount_vnd: 2_500_000, invoice: "SINV-0001", outstanding_vnd: 2_500_000, mode: "Tiền mặt" },
  summary: "Thu 2.500.000đ từ Khách mock cho chứng từ SINV-0001",
};

async function withServer(store, fn) {
  const { createAskServer } = await import("../src/http-ask.mjs");
  const server = createAskServer({ port: 0, host: "127.0.0.1", idemStore: store });
  const port = await new Promise((res, rej) => {
    server.once("error", rej);
    server.listen(0, "127.0.0.1", () => res(server.address().port));
  });
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    server.close();
  }
}

test("kill switch: global_read_only refuses a NEW write with SYSTEM_MAINTENANCE and burns nothing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sg-kill-"));
  const stateFile = join(dir, "mock-erp.json");
  process.env.MOCK_ERP_STATE = stateFile;
  process.env.COPILOT_GLOBAL_READ_ONLY = "1";
  try {
    const { IdempotencyStore } = await import("../src/idempotency.mjs");
    const store = new IdempotencyStore(dir);
    const cid = randomUUID();
    await withServer(store, async (base) => {
      const r = await fetch(`${base}/execute`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command_id: cid, proposal: PROPOSAL }),
      });
      const body = await r.json();
      assert.equal(r.status, 503, JSON.stringify(body));
      assert.equal(body.ok, false);
      assert.equal(body.code, "SYSTEM_MAINTENANCE");
      assert.equal(body.level, "global_read_only");
      assert.equal(body.retry_same_command_id, undefined, "maintenance is not a retry-now signal");
    });
    // Nothing reserved, nothing written: the proposal can be re-confirmed later.
    assert.equal(store.status(cid), null, "a refused maintenance write must not burn the command_id");
    const wrote = (() => {
      try {
        return (JSON.parse(readFileSync(stateFile, "utf8")).payments ?? []).length;
      } catch {
        return 0;
      }
    })();
    assert.equal(wrote, 0, "nothing may reach ERPNext while read-only");
  } finally {
    delete process.env.COPILOT_GLOBAL_READ_ONLY;
    delete process.env.MOCK_ERP_STATE;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("kill switch: flag FILE also trips it; READ (/ask) is unaffected", () => {
  const flag = killSwitchFlagPath();
  assert.equal(isGlobalReadOnly({ env: {}, flagFile: flag }), false, "no flag file in a clean checkout");
  assert.equal(isGlobalReadOnly({ env: {}, flagFile: `${flag}.test-copy` }), false);
  // a real flag file trips it, and the verdict carries the structured code
  const dir = mkdtempSync(join(tmpdir(), "sg-flag-"));
  try {
    const f = join(dir, "read-only.flag");
    writeFileSync(f, "maintenance\n", "utf8");
    assert.equal(isGlobalReadOnly({ env: {}, flagFile: f }), true);
    const v = checkKillSwitch("payment.create", { env: {}, flagFile: f });
    assert.equal(v.allowed, false);
    assert.equal(v.code, "SYSTEM_MAINTENANCE");
    assert.equal(v.level, "global_read_only");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  // env layer, including the values that must NOT count as "on"
  assert.equal(isGlobalReadOnly({ env: { COPILOT_GLOBAL_READ_ONLY: "true" } }), true);
  for (const off of ["0", "false", "", "no", undefined]) {
    assert.equal(isGlobalReadOnly({ env: { COPILOT_GLOBAL_READ_ONLY: off }, flagFile: flag }), false, `${off} must not trip it`);
  }
});

test("kill switch: disable_capability refuses only the listed capability", () => {
  const env = { COPILOT_DISABLE_CAPABILITIES: "payment.create" };
  const v = checkKillSwitch("payment.create", { env });
  assert.equal(v.allowed, false);
  assert.equal(v.code, "CAPABILITY_DISABLED");
  assert.equal(checkKillSwitch("sales_order.create", { env }).allowed, true);
  assert.equal(checkKillSwitch("payment.create", { env: {} }).allowed, true);
});

test("amount policy comes from the contract (zero/negative/full-balance are declared)", () => {
  const cap = getCapability("payment.create");
  assert.equal(checkAmountPolicy(cap, 10_000).ok, true);
  for (const bad of [0, -1, "abc", null, undefined, NaN]) {
    assert.equal(checkAmountPolicy(cap, bad).ok, false, `${bad} must be refused by the policy`);
  }
  // The policy is data: a capability that allowed zero would say so explicitly.
  assert.equal(cap.amount_policy.allow_zero, false);
  assert.equal(cap.amount_policy.allow_negative, false);
});

test("forbidden capability (document.delete) is refused at the gateway with 403 FORBIDDEN_IN_AI_PATH", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sg-forbid-"));
  try {
    const { IdempotencyStore } = await import("../src/idempotency.mjs");
    const store = new IdempotencyStore(dir);
    const cid = randomUUID();
    await withServer(store, async (base) => {
      const r = await fetch(`${base}/execute`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          command_id: cid,
          proposal: { ...PROPOSAL, action: "delete_document", entity: { kind: "document", id: "PE-0001", name: "PE-0001" } },
        }),
      });
      const body = await r.json();
      assert.equal(r.status, 403, JSON.stringify(body));
      assert.equal(body.code, "FORBIDDEN_IN_AI_PATH");
    });
    assert.equal(store.status(cid), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("INVARIANT (static): the write path is referenced from exactly one module — the gateway", () => {
  const files = walk(SRC).filter((f) => f.endsWith(".mjs"));
  // Any executor, by shape: each write skill DEFINES `execute…Proposal(` and
  // the gateway is the only other module allowed to name it.
  const writeCallers = files.filter((f) => /execute[A-Za-z]*Proposal\s*\(/.test(readFileSync(f, "utf8")));
  const rawWriteCallers = files.filter((f) => /callWriteTool\s*\(/.test(readFileSync(f, "utf8")));

  const rel = (f) => f.slice(SRC.length + 1);
  // B2: the write skills are the modules the CONTRACT declares as WRITE skills.
  // Deriving the list from capabilities.json is what keeps this tripwire honest
  // as a second (and third…) write arrives: adding a step here is not what makes
  // a module allowed to write — declaring it in the contract is, and then this
  // list follows automatically. Anything else reaching callWriteTool still fails.
  // A capability may point at a PROPOSAL BUILDER while still being a stub (P9-A1
  // shipped delivery.create that way). A stub is not on the write path — the
  // pipeline refuses it before `route.factory`, and it has no executor — so the
  // tripwire derives its expectation from the IMPLEMENTED writes only. Keeping a
  // stub's builder OUT of this list is also the stronger statement: if that
  // module ever reached callWriteTool, the assertion below would fail.
  const writeSkills = listCapabilities()
    .filter((id) => getCapability(id)?.type === "WRITE" && !isStub(id))
    .map((id) => getCapability(id)?.skill)
    .filter((s) => typeof s === "string" && s.includes("#"))
    .map((s) => s.split("#")[0])
    .sort();
  assert.deepEqual(
    writeSkills,
    [
      "skills/payment-write.mjs",
      "skills/sales-order-write.mjs",
      "skills/quotation-write.mjs",
      // B4: the purchase path. This list is the tripwire's EXPECTED set, so a new
      // write skill cannot join the write path without someone stating it here —
      // which is exactly how the omission would otherwise be noticed only in prod.
      "skills/purchase-order-write.mjs",
      // P9-A2: the delivery path. This list is the tripwire's EXPECTED set — a
      // new write skill cannot join the write path without someone stating it
      // here, which is how an omission is forced into a code review instead of
      // being noticed in prod.
      "skills/delivery-write.mjs",
      // P9-B: the receiving path (the delivery's supplier-party mirror).
      "skills/purchase-receipt-write.mjs",
      // P9-D: the invoice path. Its documents book revenue and receivable once
      // submitted, so it belongs on this list more than any of the above.
      "skills/sales-invoice-write.mjs",
      // P9-E: the stock write-off path. It is the only write whose document has
      // no price and no party — and the only one whose DRAFT moves nothing, so
      // its executor's read-back is the sole proof that the goods were not
      // actually issued. Stated here on purpose, like every line above.
      "skills/stock-adjustment-write.mjs",
      // P9-F: the return path (a DRAFT Sales Invoice with is_return=1). It is
      // the FIRST write here that is the REVERSAL of another write skill's
      // document, which is why it is stated on its own line: reading money
      // backwards is exactly the shape an omission would hide.
      "skills/sales-return-write.mjs",
      // M1: the customer-CREATE path (master data). The FIRST write whose entity
      // does not exist until it is written — the skill's whole pre-check (list
      // re-read, business-key collision) is the safety story, so it is stated
      // here on its own line like every path above.
      "skills/customer-create.mjs",
    ].sort(),
    "the contract's WRITE skills are the ones this file expects to guard",
  );
  // `executeXxxProposal(` may only be NAMED by its own skill and the gateway.
  assert.deepEqual(
    writeCallers.map(rel).sort(),
    ["safety-gateway.mjs", ...writeSkills].sort(),
    "an executor may be called from the gateway only (each skill defines its own)",
  );
  assert.deepEqual(
    rawWriteCallers.map(rel).sort(),
    ["client.mjs", ...writeSkills].sort(),
    "callWriteTool() may be defined in client.mjs and used only by a declared WRITE skill",
  );
  // Every executor call site must go through the gateway's dispatch table: the
  // table is the ONE place that binds a capability id to an implementation, so
  // nothing else may bind one (a second binding would bypass the amount/intent
  // policy that lives per capability).
  const gateway = readFileSync(join(SRC, "safety-gateway.mjs"), "utf8");
  assert.match(gateway, /const WRITE_EXECUTORS = Object\.freeze\(\{/, "the dispatch table is literal, in the gateway");
  // ...and NOBODY imports an executor. The builders in those skills are meant to
  // be imported (the pipeline builds proposals with them); the EXECUTOR is the
  // part that touches ERPNext, and the check above already proves the gateway is
  // its only caller. This states the rule the other way round, so a future
  // `import { executeSalesOrderProposal } from "./skills/sales-order-write.mjs"`
  // in a new module fails here even if it never calls it.
  for (const f of files.filter((f) => rel(f) !== "safety-gateway.mjs")) {
    assert.ok(
      !/import\s*\{[^}]*\bexecute[A-Za-z]*Proposal\b/.test(readFileSync(f, "utf8")),
      `${rel(f)} must not import an executor — the gateway dispatches them`,
    );
  }
  // http-ask must delegate, not implement: no money policy may live there.
  const httpAsk = readFileSync(join(SRC, "http-ask.mjs"), "utf8");
  assert.match(httpAsk, /runExecute\(/, "http-ask delegates /execute to the gateway");
  assert.ok(!/executePaymentProposal/.test(httpAsk), "http-ask must not reach the write skill directly");
  assert.ok(!/callWriteTool/.test(httpAsk), "http-ask must not reach a raw write tool");

  // Self-review 2026-09-17: the scan used to cover src/ only, so operator
  // tooling (scripts/) was an unscanned place to hide a second AI write path.
  const scriptsDir = join(HERE, "..", "scripts");
  const scriptFiles = walk(scriptsDir).filter((f) => f.endsWith(".mjs"));
  for (const f of scriptFiles) {
    const src = readFileSync(f, "utf8");
    assert.ok(!/executePaymentProposal\s*\(/.test(src), `scripts/ must not call executePaymentProposal: ${f}`);
    assert.ok(!/callWriteTool\s*\(/.test(src), `scripts/ must not call callWriteTool: ${f}`);
  }
});

// ---------------------------------------------------------------- config ----
// Self-review 2026-09-17: a broken/partial ERPNext config used to ESCAPE
// runExecute() (client creation sat outside the try/catch) → escaped the async
// HTTP handler → unhandled rejection killed the gateway process, while the
// command stayed PENDING and the intent lock blocked every later attempt.

test("config failure: refuses (503, non-terminal) instead of throwing out of the gateway", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sg-cfg-"));
  try {
    const { runExecute } = await import("../src/safety-gateway.mjs");
    const { IdempotencyStore, fingerprintProposal } = await import("../src/idempotency.mjs");
    const store = new IdempotencyStore(dir);
    const cid = randomUUID();
    const broken = () => {
      throw new Error("PARTIAL_ERPNEXT_CONFIG: set all three or none — missing: ERPNEXT_API_KEY");
    };

    const verdict = await runExecute({ command_id: cid, proposal: PROPOSAL, store, createClient: broken });
    assert.equal(verdict.status, 503, JSON.stringify(verdict.body));
    assert.equal(verdict.body.code, "PAYMENT_CLIENT_UNAVAILABLE");
    assert.equal(verdict.body.retry_same_command_id, true);

    // Nothing reached ERPNext, so the command must NOT be terminal: the
    // operator fixes .env and retries the SAME command_id.
    assert.equal(store.status(cid).status, "PENDING");
    const again = store.begin(cid, {
      action: "create_payment_entry",
      fingerprint: fingerprintProposal(PROPOSAL),
      intentKey: `${PROPOSAL.entity.id}|${PROPOSAL.params.invoice}`,
    });
    assert.equal(again.resumed, true, "the same command_id is still usable after a config failure");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("config failure over HTTP: 503 + the gateway process survives (a bad .env must not kill it)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sg-cfg-http-"));
  process.env.MOCK_ERP_STATE = join(dir, "mock-erp.json");
  process.env.ERPNEXT_URL = "https://example.invalid"; // partial on purpose
  try {
    const { IdempotencyStore } = await import("../src/idempotency.mjs");
    const store = new IdempotencyStore(dir);
    const cid = randomUUID();
    await withServer(store, async (base) => {
      const r = await fetch(`${base}/execute`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command_id: cid, proposal: PROPOSAL }),
      });
      const body = await r.json();
      assert.equal(r.status, 503, JSON.stringify(body));
      assert.equal(body.code, "PAYMENT_CLIENT_UNAVAILABLE");

      // The real assertion: the process is STILL serving. An unhandled
      // rejection would have taken the whole gateway down.
      const health = await fetch(`${base}/health`);
      assert.equal(health.status, 200);
      assert.equal((await health.json()).ok, true);
    });
    assert.equal(store.status(cid).status, "PENDING", "no write happened ⇒ keep the intent retryable");
  } finally {
    delete process.env.ERPNEXT_URL;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("client open: a failing initialize still closes the spawned server (no leaked child process)", async () => {
  const { __openClientForTest } = await import("../src/safety-gateway.mjs");
  let closed = 0;
  const stub = {
    initialize: async () => {
      throw new Error("initialize failed");
    },
    close: async () => {
      closed += 1;
    },
  };
  await assert.rejects(() => __openClientForTest(() => stub), /initialize failed/);
  assert.equal(closed, 1, "a spawned server must be closed when initialize() fails");
});

test("amount policy: an OMITTED amount is refused at the boundary (stricter than allow_full_balance, on purpose)", () => {
  const cap = getCapability("payment.create");
  assert.equal(cap.amount_policy.allow_full_balance, true, "contract allows full-balance collection");
  for (const missing of [undefined, null]) {
    const verdict = checkAmountPolicy(cap, missing);
    assert.equal(verdict.ok, false, "the proposal builder owns the amount — a missing one is malformed");
  }
  assert.equal(checkAmountPolicy(cap, 0).ok, false);
  assert.equal(checkAmountPolicy(cap, -1).ok, false);
  assert.equal(checkAmountPolicy(cap, 10_000).ok, true);
});

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}
