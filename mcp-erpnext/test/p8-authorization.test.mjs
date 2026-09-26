/**
 * P8 — Authorization (plan2_final §5 + §24.2, phases2/p8-multiuser-rbac-tenant.md).
 *
 * The properties that matter:
 *  1. an account without the contract's required permission is refused BEFORE
 *     anything reaches ERPNext — and the refusal does not burn a command_id;
 *  2. the requirement comes from the CONTRACT, not a list written in code;
 *  3. a company outside the principal's allow-list is refused, and a client
 *     cannot widen its own scope by asking for a different company;
 *  4. the actor survives into the write record AND into a queued retry (an
 *     authorization that forgets WHO asked is not authorization).
 *
 * Hermetic: no ERPNext, no NLP, credentials stripped from the shell env.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import {
  AUTHZ_CODES,
  AUTHZ_MODES,
  authorize,
  checkPermissions,
  contractDeclaredPermissions,
  describeAuthorization,
  parseUsers,
  resolveCompanyScope,
  resolvePrincipal,
} from "../src/authorization.mjs";
import { getCapability } from "../src/capability-contract.mjs";
import { toUncertaintyCode, uncertaintyCopy } from "../src/uncertainty.mjs";
import { runExecute } from "../src/safety-gateway.mjs";

// Never let a leaked shell env decide the outcome of an authorization test.
for (const k of Object.keys(process.env)) {
  if (/^(ERPNEXT_|ASK_)/.test(k)) delete process.env[k];
}
delete process.env.COPILOT_USERS;
delete process.env.COPILOT_DEFAULT_PERMISSIONS;
delete process.env.COPILOT_COMPANY;

const PROPOSAL = {
  schema: "erpn.proposal/v1",
  proposal_id: "prp_test-p8-authz",
  version: 1,
  action: "create_payment_entry",
  risk: "HIGH",
  created_at: new Date().toISOString(),
  action_id: "act_test-p8",
  entity: { kind: "customer", id: "CUST-00001", name: "Khách mock" },
  params: { amount_vnd: 10_000, invoice: "SINV-0001", outstanding_vnd: 2_500_000, mode: "Tiền mặt" },
  summary: "Thu 10.000đ từ Khách mock cho chứng từ SINV-0001",
};

/**
 * P9-D companion proposals — a SECOND and THIRD distinct debt.
 *
 * After P9-D a successful /execute leaves a live DRAFT holding that money, and
 * re-executing the SAME proposal is refused (PROPOSAL_STALE): its snapshot no
 * longer matches the effective remainder. This file deliberately shares ONE mock
 * state dir across all tests, so its three write-succeeding tests can no longer
 * all use PROPOSAL — each needs its own debt. Distinct `action_id`s too, because
 * the action id is what the ERPNext-side duplicate check looks up.
 */
const PROPOSAL_B = {
  ...PROPOSAL,
  proposal_id: "prp_test-p8-authz-b",
  action_id: "act_test-p8-b",
  entity: { kind: "customer", id: "CUST-00002", name: "Khách hai" },
  params: { ...PROPOSAL.params, invoice: "SINV-0003", outstanding_vnd: 7_500_000 },
  summary: "Thu 10.000đ từ Khách hai cho chứng từ SINV-0003",
};
const PROPOSAL_C = {
  ...PROPOSAL,
  proposal_id: "prp_test-p8-authz-c",
  action_id: "act_test-p8-c",
  entity: { kind: "supplier", id: "SUP-HATIEN", name: "Hà Tiên" },
  params: { ...PROPOSAL.params, invoice: "PINV-0001", outstanding_vnd: 5_000_000, direction: "pay" },
  summary: "Chi 10.000đ cho Hà Tiên cho chứng từ PINV-0001",
};

/**
 * A principal holding exactly the given permissions (multi-user shape).
 * Carries a pinned company by default: `payment.create` declares
 * scope.company="required", and in multi-user mode an unpinned company is a
 * refusal — so controls must look like a real deployment, not a bare actor.
 */
const principalWith = (permissions, extra = {}) => ({
  user_id: "tester",
  permissions,
  companies: ["A"],
  company: "A",
  mode: AUTHZ_MODES.MULTI_USER,
  known: true,
  implicit_permissions: false,
  ...extra,
});

// ONE state dir for this whole file. src/mock-server.mjs reads MOCK_ERP_STATE
// when it loads and the job queue reads JOB_QUEUE_DIR per instance, so a fresh
// path per test would silently keep pointing at the first one.
const STATE_DIR = mkdtempSync(join(tmpdir(), "p8-authz-"));
process.env.MOCK_ERP_STATE = join(STATE_DIR, "mock-erp.json");
process.env.JOB_QUEUE_DIR = STATE_DIR;

/**
 * Documents written for OUR command id.
 *
 * Deliberately not a raw count: the mock lazily seeds its own demo payments
 * (PE-0001 with no reference_no), so "how many payments" measures seeding, not
 * writing. The gateway sets reference_no = command_id, which is the only
 * question this suite actually asks: did THIS confirmed intent reach ERPNext,
 * and exactly once?
 */
function writtenFor(commandId) {
  try {
    const state = JSON.parse(readFileSync(process.env.MOCK_ERP_STATE, "utf8"));
    return (state.payments ?? []).filter((p) => p.reference_no === commandId).length;
  } catch {
    return 0;
  }
}

async function withServer({ store, principal, env, jobs }, fn) {
  const { createAskServer } = await import("../src/http-ask.mjs");
  const server = createAskServer({
    port: 0,
    host: "127.0.0.1",
    idemStore: store,
    jobs: jobs ?? null,
    principal: principal ?? null,
    env,
  });
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

// ───────────────────────────── unit: the contract is the source ─────────────

test("P8: the permission requirement is READ FROM THE CONTRACT, not hardcoded", () => {
  // Pin the real entry so a contract edit that drops the requirement is caught.
  const cap = getCapability("payment.create");
  assert.deepEqual(cap.authorization.permissions, ["Accounts User"]);
  assert.equal(cap.authorization.scope.company, "required");

  // The check follows the contract: same principal, different capability.
  const noPerms = principalWith([]);
  assert.equal(checkPermissions("payment.create", noPerms).ok, false);
  // A READ capability declares no permissions, so it stays available — a user
  // without Accounts User must still be able to LOOK at the debt.
  assert.equal(checkPermissions("customer.balance", noPerms).ok, true);

  // …and the default single-tenant grant is derived, not authored.
  const declared = contractDeclaredPermissions();
  assert.ok(declared.includes("Accounts User"));
  assert.ok(!declared.includes("System Manager"), "a forbidden capability must not hand out its permission");
});

test("P8: a malformed COPILOT_USERS fails loudly instead of restoring 'everyone allowed'", () => {
  assert.throws(() => parseUsers("{not json"), (err) => err.code === AUTHZ_CODES.CONFIG_INVALID);
  assert.throws(() => parseUsers("[]"), (err) => err.code === AUTHZ_CODES.CONFIG_INVALID);
  assert.throws(() => parseUsers('{"a":{"permissions":"Accounts User"}}'), (err) => err.code === AUTHZ_CODES.CONFIG_INVALID);

  // A typo must also surface at boot rather than silently downgrading the mode.
  const summary = describeAuthorization({ COPILOT_USERS: "{oops" });
  assert.equal(summary.mode, "invalid");
  assert.match(summary.warnings.join(" "), /KHÔNG hợp lệ/);
});

test("P8: parseUsers — permissions keep their spaces, companies derive from company", () => {
  const users = parseUsers(
    '{"op":{"permissions":["Accounts User","System Manager"],"company":"Công ty A"}}',
  );
  assert.deepEqual(users.get("op").permissions, ["Accounts User", "System Manager"]);
  assert.deepEqual(users.get("op").companies, ["Công ty A"]);
});

// ───────────────────────────── unit: principals ─────────────────────────────

test("P8: single-tenant grants the contract permissions by default, and can be narrowed", () => {
  const implicit = resolvePrincipal({ user: "op", env: {} });
  assert.equal(implicit.mode, AUTHZ_MODES.SINGLE_TENANT);
  assert.equal(implicit.implicit_permissions, true);
  assert.deepEqual(implicit.permissions, contractDeclaredPermissions());

  const narrowed = resolvePrincipal({ user: "op", env: { COPILOT_DEFAULT_PERMISSIONS: "Accounts User" } });
  assert.deepEqual(narrowed.permissions, ["Accounts User"]);

  // An EXPLICIT empty string means strict: nothing is granted implicitly.
  const strict = resolvePrincipal({ user: "op", env: { COPILOT_DEFAULT_PERMISSIONS: "" } });
  assert.deepEqual(strict.permissions, []);
  assert.equal(strict.implicit_permissions, false);
  assert.equal(checkPermissions("payment.create", strict).ok, false);
});

test("P8: an unknown multi-user account degrades to read-only, it does not crash", () => {
  const env = { COPILOT_USERS: '{"alice":{"permissions":["Accounts User"]}}' };

  const alice = resolvePrincipal({ user: "alice", env });
  assert.deepEqual(alice.permissions, ["Accounts User"]);
  assert.equal(alice.known, true);
  assert.equal(checkPermissions("payment.create", alice).ok, true);

  const stranger = resolvePrincipal({ user: "bob", env });
  assert.equal(stranger.mode, AUTHZ_MODES.MULTI_USER);
  assert.equal(stranger.known, false);
  assert.deepEqual(stranger.permissions, []);
  assert.equal(checkPermissions("payment.create", stranger).ok, false);
  assert.equal(checkPermissions("customer.balance", stranger).ok, true);
});

// ───────────────────────────── unit: company scope ──────────────────────────

test("P8: company scope — server config wins over the request, allow-list is enforced", () => {
  const env = { COPILOT_USERS: '{"alice":{"permissions":["Accounts User"],"company":"A"}}' };
  const alice = resolvePrincipal({ user: "alice", env });

  // The request cannot redirect scope away from what the account owns.
  const redirected = resolveCompanyScope("payment.create", {
    principal: alice,
    requested: "B",
    env,
  });
  assert.equal(redirected.ok, false, "a request must not redirect scope");
  assert.equal(redirected.code, AUTHZ_CODES.DENIED);
  assert.match(redirected.error, /company/);

  // Own company passes, and the source is named.
  const own = resolveCompanyScope("payment.create", { principal: alice, requested: "A", env });
  assert.equal(own.ok, true);
  assert.equal(own.company, "A");
  assert.equal(own.source, "principal");

  // A capability that does not require a company is unaffected.
  assert.equal(resolveCompanyScope("customer.balance", { principal: alice, env }).enforced, false);

  // The ALLOW-LIST is a separate defence from the "request must not redirect"
  // check above: that one compares the request against what this deployment
  // pinned, which says nothing about what the ACCOUNT owns. These two cases
  // reach the allow-list specifically — a principal with no pinned company of
  // its own — and were unreachable until a falsification run showed the whole
  // branch could be deleted with every test still green.
  const roaming = resolvePrincipal({
    user: "alice",
    env: { COPILOT_USERS: '{"alice":{"permissions":["Accounts User"],"companies":["A"]}}' },
  });
  assert.equal(roaming.company, null, "this principal has no pinned company");

  const outsideAllowList = resolveCompanyScope("payment.create", {
    principal: roaming,
    requested: "B",
    env: {},
  });
  assert.equal(outsideAllowList.ok, false, "a company the account does not own is refused");
  assert.equal(outsideAllowList.code, AUTHZ_CODES.DENIED);
  assert.match(outsideAllowList.error, /chỉ: A/);

  const pinnedByDeployment = resolveCompanyScope("payment.create", {
    principal: roaming,
    requested: null,
    env: { COPILOT_COMPANY: "C" },
  });
  assert.equal(pinnedByDeployment.ok, false, "a deployment-pinned company the account may not touch is refused");
  assert.equal(pinnedByDeployment.code, AUTHZ_CODES.DENIED);

  // Control: the same shape, but a company the account DOES own, still passes.
  const inside = resolveCompanyScope("payment.create", {
    principal: roaming,
    requested: "A",
    env: {},
  });
  assert.equal(inside.ok, true);
  assert.equal(inside.company, "A");
  assert.equal(inside.source, "request");
});

test("P8: multi-user without any resolvable company is REFUSED; single-tenant is only warned", () => {
  const multi = principalWith(["Accounts User"], { company: null, companies: [] });
  const refused = resolveCompanyScope("payment.create", { principal: multi, env: {} });
  assert.equal(refused.ok, false);
  assert.equal(refused.code, AUTHZ_CODES.COMPANY_REQUIRED);

  // Single-tenant: one company by construction, and older installs have no
  // company concept at all — allowed, but never silently (see the warning test).
  const single = resolvePrincipal({ user: "op", env: {} });
  const allowed = resolveCompanyScope("payment.create", { principal: single, env: {} });
  assert.equal(allowed.ok, true);
  assert.equal(allowed.enforced, false);
  assert.equal(allowed.source, "unset_single_tenant");

  const summary = describeAuthorization({});
  assert.match(summary.warnings.join(" "), /chưa pin company/);
});

// ───────────────────────────── E2E: the gateway ─────────────────────────────
test("P8 E2E: /execute without the permission writes NOTHING and burns no command_id", async () => {
  const { IdempotencyStore } = await import("../src/idempotency.mjs");
  const store = new IdempotencyStore(STATE_DIR);
  const cid = randomUUID();

  await withServer({ store, principal: principalWith([]) }, async (base) => {
    const r = await fetch(`${base}/execute`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command_id: cid, proposal: PROPOSAL }),
    });
    const body = await r.json();
    assert.equal(r.status, 403, JSON.stringify(body));
    assert.equal(body.code, AUTHZ_CODES.DENIED);
    assert.equal(body.user_id, "tester");
    assert.match(body.error, /Accounts User/);
  });

  assert.equal(writtenFor(cid), 0, "a denied account must not reach ERPNext");
  assert.equal(store.status(cid), null, "a denied execute must not burn the command_id");
});

test("P8 E2E: /execute WITH the permission is the control — it writes exactly once", async () => {
  const { IdempotencyStore } = await import("../src/idempotency.mjs");
  const store = new IdempotencyStore(STATE_DIR);
  const cid = randomUUID();

  await withServer({ store, principal: principalWith(["Accounts User"]) }, async (base) => {
    const r = await fetch(`${base}/execute`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command_id: cid, proposal: PROPOSAL }),
    });
    assert.equal(r.status, 200, JSON.stringify(await r.json()));
  });

  assert.equal(writtenFor(cid), 1);
});

test("P8 E2E: the write record names the ACTOR and the authorized company", async () => {
  const { IdempotencyStore } = await import("../src/idempotency.mjs");
  const store = new IdempotencyStore(STATE_DIR);
  const cid = randomUUID();
  const env = { COPILOT_USERS: '{"alice":{"permissions":["Accounts User"],"company":"A"}}' };
  const alice = resolvePrincipal({ user: "alice", env });

  await withServer({ store, principal: alice, env }, async (base) => {
    const r = await fetch(`${base}/execute`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // A debt of its own (P9-D): the control test above already wrote SINV-0001.
      body: JSON.stringify({ command_id: cid, proposal: PROPOSAL_B }),
    });
    assert.equal(r.status, 200, JSON.stringify(await r.json()));
  });

  assert.equal(writtenFor(cid), 1, "the authorized write really landed");
  const record = store.status(cid);
  assert.equal(record.user_id, "alice");
  assert.equal(record.company, "A");
});

test("P8 E2E: /execute from a request claiming another company is refused", async () => {
  const { IdempotencyStore } = await import("../src/idempotency.mjs");
  const store = new IdempotencyStore(STATE_DIR);
  const cid = randomUUID();
  const env = { COPILOT_USERS: '{"alice":{"permissions":["Accounts User"],"company":"A"}}' };

  await withServer({ store, principal: resolvePrincipal({ user: "alice", env }), env }, async (base) => {
    const r = await fetch(`${base}/execute`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command_id: cid, proposal: PROPOSAL, company: "B" }),
    });
    const body = await r.json();
    assert.equal(r.status, 403, JSON.stringify(body));
    assert.equal(body.code, AUTHZ_CODES.DENIED);
  });

  assert.equal(writtenFor(cid), 0);
});

// ───────────────────────────── E2E: the ask path ────────────────────────────

test("P8 E2E: /ask refuses a write intent the account may not run — and builds NO proposal", async () => {
  const { spawn } = await import("node:child_process");
  const nlp = spawn("python3", ["-m", "nlp_service.server"], {
    cwd: join(import.meta.dirname, "..", ".."),
    stdio: "ignore",
    env: { ...process.env, PYTHONPATH: "src" },
  });
  const { IdempotencyStore } = await import("../src/idempotency.mjs");
  const store = new IdempotencyStore(STATE_DIR);

  try {
    await new Promise((r) => setTimeout(r, 3500));
    await withServer({ store, principal: principalWith([]) }, async (base) => {
      const r = await fetch(`${base}/ask`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "thu tiền cho chị Lan 2 triệu" }),
      });
      const body = await r.json();
      assert.equal(r.status, 200, JSON.stringify(body));
      assert.equal(body.result.error_code, AUTHZ_CODES.DENIED);
      // Without a proposal there is no card, so there is nothing to confirm and
      // nothing that could ever reach /execute.
      assert.equal(body.result.proposal, null);
      assert.ok(body.result.uncertainty?.message, "a refusal must carry Vietnamese copy");
    });
  } finally {
    nlp.kill();
  }
});

// ───────────────────────────── E2E: the queued retry ────────────────────────

test("P8 E2E: a queued retry re-authorizes the ORIGINAL actor (and writes nothing when denied)", async () => {
  const { IdempotencyStore } = await import("../src/idempotency.mjs");
  const { JobQueue } = await import("../src/job-queue.mjs");
  const store = new IdempotencyStore(STATE_DIR);
  const queue = new JobQueue();
  const cid = randomUUID();

  // Queued by "bob", who currently has no permission.
  queue.enqueue({
    command_id: cid,
    proposal: PROPOSAL,
    reason: "erp down",
    user_id: "bob",
    company: "A",
  });

  const env = { COPILOT_USERS: '{"bob":{"permissions":[]},"alice":{"permissions":["Accounts User"],"company":"A"}}' };

  await queue.drain({
    runExecute: (args) => runExecute({ ...args, store, env }),
  });

  // The replay must be attributed to bob, not to the default principal, and it
  // must be refused — a job must not be able to execute what its author cannot.
  const jobs = queue.pending();
  assert.equal(jobs.length, 1, "a denied job stays in the queue, it is not silently dropped");
  assert.equal(jobs[0].user_id, "bob");
  assert.match(jobs[0].last_error ?? "", /quyền/);
  assert.equal(writtenFor(cid), 0);
});

test("P8 E2E: the same queued retry goes through once the actor IS authorized", async () => {
  const { IdempotencyStore } = await import("../src/idempotency.mjs");
  const { JobQueue } = await import("../src/job-queue.mjs");
  const store = new IdempotencyStore(STATE_DIR);
  const queue = new JobQueue();
  const cid = randomUUID();

  queue.enqueue({
    command_id: cid,
    // A THIRD debt (P9-D): the two tests above already wrote SINV-0001/SINV-0003.
    proposal: PROPOSAL_C,
    reason: "erp down",
    user_id: "alice",
    company: "A",
  });

  const env = { COPILOT_USERS: '{"alice":{"permissions":["Accounts User"],"company":"A"}}' };
  await queue.drain({ runExecute: (args) => runExecute({ ...args, store, env }) });

  assert.equal(writtenFor(cid), 1);
  assert.equal(queue.completed().length, 1);
});

// ──────────────── the job report is somebody's payment queue ────────────────

test("P8 E2E: /jobs is scoped to the account that asked (multi-user)", async () => {
  const { IdempotencyStore } = await import("../src/idempotency.mjs");
  const { JobQueue } = await import("../src/job-queue.mjs");
  const store = new IdempotencyStore(mkdtempSync(join(tmpdir(), "p8-jobs-")));
  const queue = new JobQueue({ config: { enabled: true, dir: mkdtempSync(join(tmpdir(), "p8-jobsq-")) } });
  const env = {
    COPILOT_USERS: JSON.stringify({
      alice: { permissions: ["Accounts User"], company: "A" },
      bob: { permissions: [], company: "A" },
      carol: { permissions: ["Accounts User"], company: "A" },
    }),
  };
  queue.enqueue({ command_id: "c-alice", proposal: PROPOSAL, user_id: "alice" });
  queue.enqueue({ command_id: "c-bob", proposal: PROPOSAL, user_id: "bob" });
  queue.enqueue({ command_id: "c-legacy", proposal: PROPOSAL }); // no owner (pre-P8)

  // bob sees exactly his own: a job names the customer and the amount, so it is
  // the same data class as the payment itself.
  await withServer({ store, jobs: queue, principal: resolvePrincipal({ user: "bob", env }), env }, async (base) => {
    const body = await (await fetch(`${base}/jobs`)).json();
    assert.deepEqual(body.pending.map((j) => j.command_id), ["c-bob"]);
    assert.equal(body.hidden, 2, "the reply says something was filtered, it does not pretend to be empty");
  });

  // carol holds the permission → she may work the whole queue (operator view).
  await withServer({ store, jobs: queue, principal: resolvePrincipal({ user: "carol", env }), env }, async (base) => {
    const body = await (await fetch(`${base}/jobs`)).json();
    assert.equal(body.pending.length, 3);
    assert.equal(body.hidden, 0);
  });
});

// ──────────────── cancel releases SOMEONE ELSE'S intent lock ────────────────

test("P8 E2E: /execute/cancel — an account cannot release another account's command", async () => {
  const { IdempotencyStore } = await import("../src/idempotency.mjs");
  const store = new IdempotencyStore(mkdtempSync(join(tmpdir(), "p8-cancel-")));

  // alice confirmed the intent; bob has NO permission at all.
  const env = {
    COPILOT_USERS: JSON.stringify({
      alice: { permissions: ["Accounts User"], company: "A" },
      bob: { permissions: [], company: "A" },
      carol: { permissions: ["Accounts User"], company: "A" },
    }),
  };
  const cid = randomUUID();
  store.begin(cid, { action: "create_payment_entry", fingerprint: "fp-p8-cancel", user_id: "alice", company: "A" });
  store.setReference(cid, cid);

  await withServer({ store, principal: resolvePrincipal({ user: "bob", env }), env }, async (base) => {
    const r = await fetch(`${base}/execute/cancel`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command_id: cid }),
    });
    const body = await r.json();
    assert.equal(r.status, 403, JSON.stringify(body));
    assert.equal(body.code, AUTHZ_CODES.DENIED);
    assert.equal(store.status(cid).status, "PENDING", "the lock is still held");
  });

  // Control 1: the OWNER releases it without needing the permission — proving
  // the 403 above was authorization, not a broken endpoint.
  await withServer({ store, principal: resolvePrincipal({ user: "alice", env }), env }, async (base) => {
    const r = await fetch(`${base}/execute/cancel`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command_id: cid }),
    });
    const body = await r.json();
    assert.equal(r.status, 200, JSON.stringify(body));
    assert.equal(body.cancelled, true);
    assert.equal(store.status(cid).status, "CANCELLED");
  });

  // Control 2: a PERMISSION HOLDER may clear a stranger's command (operator
  // emptying the shop's queue) — it is the permission that widens this, not
  // ownership alone.
  const cid2 = randomUUID();
  store.begin(cid2, { action: "create_payment_entry", fingerprint: "fp-p8-cancel-2", user_id: "alice", company: "A" });
  store.setReference(cid2, cid2);
  await withServer({ store, principal: resolvePrincipal({ user: "carol", env }), env }, async (base) => {
    const r = await fetch(`${base}/execute/cancel`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command_id: cid2 }),
    });
    const body = await r.json();
    assert.equal(r.status, 200, JSON.stringify(body));
    assert.equal(store.status(cid2).status, "CANCELLED");
  });

  // Control 3: an ownerless LEGACY record is not cancellable by a plain user —
  // it fails closed instead of being free for anyone to release.
  const cid3 = randomUUID();
  store.begin(cid3, { action: "create_payment_entry", fingerprint: "fp-p8-cancel-legacy" });
  store.setReference(cid3, cid3);
  await withServer({ store, principal: resolvePrincipal({ user: "bob", env }), env }, async (base) => {
    const r = await fetch(`${base}/execute/cancel`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command_id: cid3 }),
    });
    assert.equal(r.status, 403);
    assert.equal(store.status(cid3).status, "PENDING");
  });
});

test("P8: every refusal this layer can emit reaches the user WITH words (P2 taxonomy)", () => {
  // A refusal code the taxonomy does not know is a dead end: the app has no
  // copy to render. COMPANY_SCOPE_REQUIRED is deliberately its own code in the
  // log/body (operator diagnostics) yet must still resolve for the user.
  for (const code of [AUTHZ_CODES.DENIED, AUTHZ_CODES.COMPANY_REQUIRED]) {
    const mapped = toUncertaintyCode(code);
    assert.ok(mapped, `${code} must map to a P2 taxonomy code`);
    assert.equal(mapped, "AUTHORIZATION_DENIED");
    assert.match(uncertaintyCopy(mapped).message, /quyền/);
  }
});
