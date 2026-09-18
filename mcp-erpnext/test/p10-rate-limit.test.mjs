/**
 * P10 slice tests — rate limiting + correlation trail (plan2_final §17, §24.3).
 *
 * Safety properties under test:
 *  1. A contract spec that is missing or garbled falls back to a REAL limit —
 *     broken config must never silently remove a safety gate (result47 §6).
 *  2. Windows are per identity and per bucket: one noisy client cannot spend
 *     another's budget.
 *  3. THE money property: a throttled /execute is refused BEFORE the Safety
 *     Gateway. The idempotency store stays untouched (command_id not burned)
 *     and the SAME command_id still executes exactly once after the window
 *     reopens.
 *  4. /execute/cancel is never throttled (it releases a lock; it writes
 *     nothing) — refusing it during a burst would freeze intents.
 *  5. Every /ask, /execute and job event appends ONE correlation line carrying
 *     request_id / user_id / command_id / action_id / outcome.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

// Hermetic: same shell-leak protection as the other HTTP tests.
for (const k of Object.keys(process.env)) {
  if (/^(ERPNEXT_|ASK_)/.test(k)) delete process.env[k];
}
delete process.env.COPILOT_GLOBAL_READ_ONLY;
delete process.env.COPILOT_RATE_LIMIT;

// copilot-server.mjs freezes NLP_PORT at MODULE LOAD (`process.env.NLP_SERVICE_PORT
// || "8787"`). http-ask imports it, and the earlier tests in this file import
// http-ask first — so setting the port later has NO effect and the pipeline
// silently degrades to NLP_UNAVAILABLE. Pin the port before ANY import and
// start the service on it (harness lesson from result48 §8).
const NLP_PORT = 8791;
process.env.NLP_SERVICE_PORT = String(NLP_PORT);

const {
  parseRateSpec,
  rateLimitRules,
  RateLimiter,
  capabilityForAction,
  proposalBucketFor,
  rateLimitEnabled,
  rateLimitMessage,
  DEFAULT_USER_RULES,
} = await import("../src/rate-limit.mjs");
const { writeOutcomeFor, LEARNING_OUTCOMES } = await import("../src/learning-log.mjs");

// --------------------------------------------------------------- spec parse --

test("parseRateSpec: reads the contract's spec strings, rejects anything else", () => {
  assert.deepEqual(parseRateSpec("30/minute"), { limit: 30, windowMs: 60_000 });
  assert.deepEqual(parseRateSpec("20/hour"), { limit: 20, windowMs: 3_600_000 });
  assert.deepEqual(parseRateSpec(" 5 / minutes "), { limit: 5, windowMs: 60_000 });
  assert.deepEqual(parseRateSpec("1/second"), { limit: 1, windowMs: 1000 });
  // Anything unusable MUST be null (never a 0 or NaN limit that would make
  // every comparison false and disable the gate).
  for (const bad of ["", "   ", null, undefined, 0, "abc", "0/minute", "-5/minute", "5/fortnight", "5", "minute/5"]) {
    assert.equal(parseRateSpec(bad), null, `expected null for ${JSON.stringify(bad)}`);
  }
});

test("rateLimitRules: a garbled contract entry falls back to a REAL default and says so", () => {
  const warnings = [];
  const rules = rateLimitRules({
    controls: { rate_limit: { per_user: { read: "garbage", write_execute: "5/minute" }, per_capability: { "payment.create": "" } } },
    warn: (m) => warnings.push(m),
  });
  assert.deepEqual(rules.perUser.read, DEFAULT_USER_RULES.read, "read falls back to the default limit");
  assert.deepEqual(rules.perUser.write_proposal, DEFAULT_USER_RULES.write_proposal, "absent entry → default");
  assert.deepEqual(rules.perUser.write_execute, { limit: 5, windowMs: 60_000 }, "valid entry honoured");
  assert.equal(rules.perCapability["payment.create"].limit > 0, true, "garbled capability spec still limits");
  assert.equal(warnings.length, 1, "one warning, not silence");
  assert.match(warnings[0], /garbage/);

  // And the shipped contract itself parses.
  const live = rateLimitRules({ controls: null, warn: () => {} });
  assert.equal(live.perUser.read.limit, 30);
  assert.equal(live.perUser.write_execute.limit, 5);
});

// ------------------------------------------------------------------ limiter --

test("RateLimiter: window, refusal with retry-after, and per-identity isolation", () => {
  let now = 1_000_000;
  const limiter = new RateLimiter({
    rules: {
      perUser: { read: { limit: 2, windowMs: 10_000 }, write_proposal: { limit: 2, windowMs: 10_000 }, write_execute: { limit: 2, windowMs: 10_000 } },
      perCapability: { "payment.create": { limit: 1, windowMs: 60_000 } },
    },
    clock: () => now,
  });

  assert.equal(limiter.chargeUser("read", "alice").ok, true);
  assert.equal(limiter.chargeUser("read", "alice").ok, true);
  const third = limiter.chargeUser("read", "alice");
  assert.equal(third.ok, false);
  assert.equal(third.retryAfterMs, 10_000);
  // Another identity is untouched by alice's burst.
  assert.equal(limiter.chargeUser("read", "bob").ok, true);
  // Buckets do not share a counter.
  assert.equal(limiter.chargeUser("write_execute", "alice").ok, true);

  // Window boundary reopens the budget.
  now += 10_000;
  assert.equal(limiter.chargeUser("read", "alice").ok, true);

  // Per-capability rules are keyed by capability id, not by user.
  assert.equal(limiter.chargeCapability("payment.create", "alice").ok, true);
  assert.equal(limiter.chargeCapability("payment.create", "alice").ok, false);
  assert.equal(limiter.chargeCapability("unknown.capability", "alice").ok, true, "undeclared capability is not limited");

  // Disabled limiter lets everything through (the operator's opt-out).
  assert.equal(RateLimiter.disabled().chargeUser("read", "alice").ok, true);

  // A backwards clock jump must not lock the bucket forever.
  const rewound = new RateLimiter({ rules: { perUser: { read: { limit: 1, windowMs: 10_000 } }, perCapability: {} }, clock: () => now });
  assert.equal(rewound.chargeUser("read", "a").ok, true, "fresh bucket: the one slot is spent");
  assert.equal(rewound.chargeUser("read", "a").ok, false, "exhausted");
  now -= 5_000;
  assert.equal(rewound.chargeUser("read", "a").ok, true, "clock going backwards opens a new window instead of hanging");
});

test("capabilityForAction maps the proposal action to the contract's capability id", () => {
  // This mapping is contract-owned (capability-contract.mjs). rate-limit.mjs
  // used to re-derive it from a branch that does not exist and answered null
  // for everything — which would have silently disabled the declared
  // per-capability limit. Pin the real behaviour here.
  assert.equal(capabilityForAction("create_payment_entry"), "payment.create");
  assert.equal(capabilityForAction("delete_document"), "document.delete");
  assert.equal(capabilityForAction("nonsense_action"), null);
  assert.equal(capabilityForAction(null), null);
});

test("proposalBucketFor: a READ proposal never spends the write budget", () => {
  // Phase 6 makes every route return a proposal object, so "has a proposal"
  // cannot be the test — a contract WRITE (or an explicit HIGH/CRITICAL
  // declaration) is what the write budget meters.
  assert.equal(proposalBucketFor({ action: "read_balance", risk: "READ" }), null);
  assert.equal(proposalBucketFor({ action: "read_invoices", risk: "READ" }), null);
  assert.equal(proposalBucketFor({ action: "create_payment_entry", risk: "HIGH" }), "write_proposal");
  assert.equal(proposalBucketFor({ action: "create_payment_entry", risk: { level: "HIGH" } }), "write_proposal");
  assert.equal(proposalBucketFor({ action: "not_in_contract", risk: "HIGH" }), "write_proposal");
  assert.equal(proposalBucketFor({ action: "not_in_contract", risk: "READ" }), null);
  assert.equal(proposalBucketFor(null), null);
});

test("rate limiting is ON by default (opt-out only via COPILOT_RATE_LIMIT=off)", () => {
  assert.equal(rateLimitEnabled({}), true);
  assert.equal(rateLimitEnabled({ COPILOT_RATE_LIMIT: "OFF" }), false);
  assert.equal(rateLimitEnabled({ COPILOT_RATE_LIMIT: "off" }), false);
  assert.equal(rateLimitEnabled({ COPILOT_RATE_LIMIT: "maybe" }), true, "anything that is not an explicit off keeps the gate on");

  // The production default (no injected rules, no injected clock) really does
  // refuse the 31st read — the contract's 30/minute is live, not decorative.
  const dflt = new RateLimiter();
  for (let i = 0; i < 30; i++) assert.equal(dflt.chargeUser("read", "u").ok, true, `read ${i + 1} allowed`);
  assert.equal(dflt.chargeUser("read", "u").ok, false, "read 31 refused with the shipped config");
  assert.equal(new RateLimiter({ enabled: false }).chargeUser("read", "u").ok, true);
});

test("writeOutcomeFor + rateLimitMessage: one vocabulary, friendly copy", () => {
  assert.equal(writeOutcomeFor({ status: 200, body: { ok: true } }), "write_verified");
  assert.equal(writeOutcomeFor({ status: 200, body: { ok: true, replay: true } }), "write_replayed");
  assert.equal(writeOutcomeFor({ status: 503, body: { retry_same_command_id: true } }), "write_retryable");
  assert.equal(writeOutcomeFor({ status: 409, body: { code: "PROPOSAL_STALE" } }), "write_refused");
  for (const outcome of ["write_verified", "write_replayed", "write_retryable", "write_refused", "rate_limited"]) {
    assert.ok(LEARNING_OUTCOMES.includes(outcome), `${outcome} must be in the log taxonomy`);
  }
  assert.match(rateLimitMessage({ retryAfterMs: 30_000 }), /thử lại sau khoảng 30 giây/);
  assert.match(rateLimitMessage({ retryAfterMs: 0 }, { write: true }), /chưa có giao dịch nào được ghi/);
});

// ------------------------------------------------------- HTTP / the money path --

const PROPOSAL = {
  schema: "erpn.proposal/v1",
  proposal_id: "prp_test-p10",
  version: 1,
  action: "create_payment_entry",
  risk: "HIGH",
  created_at: new Date().toISOString(),
  entity: { kind: "customer", id: "CUST-00001", name: "Khách mock" },
  params: { amount_vnd: 2_500_000, invoice: "SINV-0001", outstanding_vnd: 2_500_000, mode: "Tiền mặt" },
  summary: "Thu 2.500.000đ từ Khách mock cho chứng từ SINV-0001",
};

async function listen(server) {
  return new Promise((res, rej) => {
    server.once("error", rej);
    server.listen(0, "127.0.0.1", () => res(server.address().port));
  });
}

function writeExecEntries(stateFile) {
  // The mock ledger persists as { payments: [...] } — count the ones this test
  // produced by their reference_no (= command_id).
  const state = JSON.parse(readFileSync(stateFile, "utf8"));
  return state.payments ?? [];
}

test("MONEY: a throttled /execute never burns the command_id — the same command writes exactly once after the window", async () => {
  const dir = mkdtempSync(join(tmpdir(), "p10-rl-"));
  const stateFile = join(dir, "mock-erp.json");
  process.env.MOCK_ERP_STATE = stateFile;
  let server = null;
  let now = Date.now();
  try {
    const { createAskServer } = await import("../src/http-ask.mjs");
    const { IdempotencyStore } = await import("../src/idempotency.mjs");
    const store = new IdempotencyStore(dir);
    // write_execute = 2 per window; window kept short so the test advances the
    // injected clock instead of sleeping.
    const limiter = new RateLimiter({
      rules: { perUser: { read: { limit: 99, windowMs: 60_000 }, write_proposal: { limit: 99, windowMs: 60_000 }, write_execute: { limit: 2, windowMs: 20_000 } }, perCapability: {} },
      clock: () => now,
    });
    server = createAskServer({ port: 0, host: "127.0.0.1", idemStore: store, limiter });
    const base = `http://127.0.0.1:${await listen(server)}`;
    const post = (body) =>
      fetch(`${base}/execute`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

    // Spend the budget on two other commands.
    for (let i = 0; i < 2; i++) {
      const r = await post({ command_id: randomUUID(), proposal: PROPOSAL });
      assert.equal(r.status, 200, `attempt ${i + 1} should be allowed`);
    }

    // Third command: throttled. The store must not have heard of it.
    const throttledCommand = randomUUID();
    const refused = await post({ command_id: throttledCommand, proposal: PROPOSAL });
    const refusedBody = await refused.json();
    assert.equal(refused.status, 429);
    assert.equal(refusedBody.code, "RATE_LIMITED");
    assert.match(refusedBody.error, /thử lại sau/);
    assert.ok(refusedBody.retry_after_ms > 0);
    assert.ok(Number(refused.headers.get("retry-after")) >= 1, "Retry-After header present");
    assert.equal(store.status(throttledCommand), null, "THE property: no idempotency record was created");
    assert.equal(
      writeExecEntries(stateFile).filter((p) => p.reference_no === throttledCommand).length,
      0,
      "nothing was written to ERPNext",
    );

    // Window reopens → the SAME command_id is still fresh and executes ONCE.
    now += 20_000;
    const ok = await post({ command_id: throttledCommand, proposal: PROPOSAL });
    assert.equal(ok.status, 200, JSON.stringify(await ok.json()));
    const writes = writeExecEntries(stateFile).filter((p) => p.reference_no === throttledCommand);
    assert.equal(writes.length, 1, "exactly one write for that command_id");
    assert.equal(writes[0].paid_amount, 2_500_000);
  } finally {
    delete process.env.MOCK_ERP_STATE;
    server?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("/execute/cancel is NOT throttled — a burst must not freeze lock release", async () => {
  const dir = mkdtempSync(join(tmpdir(), "p10-cancel-"));
  let server = null;
  let now = Date.now();
  try {
    const { createAskServer } = await import("../src/http-ask.mjs");
    const { IdempotencyStore } = await import("../src/idempotency.mjs");
    const store = new IdempotencyStore(dir);
    // Zero budget left in every user bucket: cancel must still be served.
    const limiter = new RateLimiter({
      rules: { perUser: { read: { limit: 1, windowMs: 60_000 }, write_proposal: { limit: 1, windowMs: 60_000 }, write_execute: { limit: 1, windowMs: 60_000 } }, perCapability: {} },
      clock: () => now,
    });
    assert.equal(limiter.chargeUser("write_execute", "local").ok, true); // exhaust it
    server = createAskServer({ port: 0, host: "127.0.0.1", idemStore: store, limiter });
    const base = `http://127.0.0.1:${await listen(server)}`;

    const res = await fetch(`${base}/execute/cancel`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command_id: randomUUID() }),
    });
    assert.notEqual(res.status, 429, "cancel must never be rate limited");
  } finally {
    server?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("/ask: the read bucket refuses with the friendly 429 before any work", async () => {
  const dir = mkdtempSync(join(tmpdir(), "p10-read-"));
  let server = null;
  let now = Date.now();
  try {
    const { createAskServer } = await import("../src/http-ask.mjs");
    const { IdempotencyStore } = await import("../src/idempotency.mjs");
    const limiter = new RateLimiter({
      rules: { perUser: { read: { limit: 1, windowMs: 60_000 }, write_proposal: { limit: 99, windowMs: 60_000 }, write_execute: { limit: 99, windowMs: 60_000 } }, perCapability: {} },
      clock: () => now,
    });
    server = createAskServer({ port: 0, host: "127.0.0.1", idemStore: new IdempotencyStore(dir), limiter });
    const base = `http://127.0.0.1:${await listen(server)}`;
    const ask = () =>
      fetch(`${base}/ask`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: "chị Lan còn nợ bao nhiêu" }) });

    const first = await ask();
    assert.equal(first.status, 200, "first question passes the gate");
    const second = await ask();
    const body = await second.json();
    assert.equal(second.status, 429);
    assert.equal(body.code, "RATE_LIMITED");
    assert.match(body.error, /quá nhiều câu hỏi/);

    // A malformed request is rejected on its own merits and costs no budget.
    const empty = await fetch(`${base}/ask`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: "  " }) });
    assert.equal(empty.status, 400);
  } finally {
    server?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("E2E: READ questions never spend the write budget, a WRITE question does (real pipeline)", async () => {
  // The unit test pins proposalBucketFor(); this pins the WIRING — the bug it
  // was written for lived in http-ask (charging on `proposal != null`, which
  // every READ route satisfies). Real NLP service spawn + mock ERPNext, same
  // harness shape as the P3/P4 E2E tests.
  const { spawn } = await import("node:child_process");
  const path = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const HERE = path.dirname(fileURLToPath(import.meta.url));
  const REPO = path.resolve(HERE, "..", "..");

  const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^ERPNEXT_/.test(k)));
  const nlp = spawn("python3", ["-m", "nlp_service.server", "--port", String(NLP_PORT)], {
    cwd: REPO,
    env: { ...cleanEnv, PYTHONPATH: path.join(REPO, "src") },
    stdio: ["ignore", "pipe", "inherit"],
  });
  const nlpPort = await new Promise((resolve, reject) => {
    nlp.stdout.on("data", (d) => {
      const m = String(d).match(/"port":\s*(\d+)/);
      if (m) resolve(Number(m[1]));
    });
    nlp.on("exit", (code) => reject(new Error(`nlp service exited early (${code}) — port ${NLP_PORT} busy?`)));
    setTimeout(() => reject(new Error("nlp service: no ready line in 5s")), 5000);
  });
  assert.equal(nlpPort, NLP_PORT, "the service must listen on the port copilot-server froze at import");

  const dir = mkdtempSync(join(tmpdir(), "p10-e2e-"));
  let server = null;
  let now = Date.now();
  try {
    const { createAskServer } = await import("../src/http-ask.mjs");
    const { IdempotencyStore } = await import("../src/idempotency.mjs");
    const limiter = new RateLimiter({
      rules: {
        perUser: {
          read: { limit: 99, windowMs: 60_000 },
          write_proposal: { limit: 1, windowMs: 60_000 },
          write_execute: { limit: 99, windowMs: 60_000 },
        },
        perCapability: {},
      },
      clock: () => now,
    });
    server = createAskServer({ port: 0, host: "127.0.0.1", idemStore: new IdempotencyStore(dir), limiter });
    const base = `http://127.0.0.1:${await listen(server)}`;
    const ask = async (text) => {
      const r = await fetch(`${base}/ask`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      return { status: r.status, body: await r.json() };
    };

    // Two READ questions. Both must pass: with write_proposal = 1, a single
    // mis-charged read proposal would already have refused the second.
    const read1 = await ask("chị Lan còn nợ bao nhiêu");
    assert.equal(read1.status, 200, JSON.stringify(read1.body));
    assert.equal(read1.body.result?.proposal?.action, "read_balance", "READ routes do carry a proposal");
    const read2 = await ask("chị Lan còn nợ bao nhiêu");
    assert.equal(read2.status, 200, "a READ proposal must not have spent the write budget");

    // A WRITE question does get an executable proposal and DOES spend it.
    // Full name on purpose: a fragment ("chị Lan") is a WRITE-time entity
    // choice (ENTITY_PICK_REQUIRED, Phase 6) and would stop before a proposal.
    const write1 = await ask("thu tiền cho Nguyễn Thị Lan 50000");
    assert.equal(write1.status, 200, JSON.stringify(write1.body));
    assert.equal(
      write1.body.result?.proposal?.action,
      "create_payment_entry",
      `write question must propose a payment: ${JSON.stringify(write1.body).slice(0, 600)}`,
    );
    const write2 = await ask("thu tiền cho Nguyễn Thị Lan 50000");
    const refused = write2;
    assert.equal(refused.status, 429, "the write_proposal budget is now exhausted");
    assert.equal(refused.body.code, "RATE_LIMITED");
  } finally {
    server?.close();
    nlp.kill();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("per-capability limit fires on the REAL /execute wiring (the F1 blast radius)", async () => {
  // Why this test exists: the first version of this slice mapped the proposal
  // action to a capability id through a branch that does not exist, so the
  // contract's `payment.create 20/hour` was silently never enforced — and every
  // HTTP test passed `perCapability: {}`, so nothing caught it. The unit test
  // covers the limiter; THIS one covers the wiring (action -> capability ->
  // bucket), which is the part that actually failed.
  const dir = mkdtempSync(join(tmpdir(), "p10-cap-"));
  const logDir = join(dir, "logs");
  const stateFile = join(dir, "mock-erp.json");
  process.env.MOCK_ERP_STATE = stateFile;
  process.env.LEARNING_LOG_DIR = logDir;
  let server = null;
  let now = Date.now();
  try {
    const { createAskServer } = await import("../src/http-ask.mjs");
    const { IdempotencyStore } = await import("../src/idempotency.mjs");
    const store = new IdempotencyStore(dir);
    const limiter = new RateLimiter({
      rules: {
        // The USER budget is generous: only the capability rule can refuse.
        perUser: { read: { limit: 99, windowMs: 60_000 }, write_proposal: { limit: 99, windowMs: 60_000 }, write_execute: { limit: 99, windowMs: 60_000 } },
        perCapability: { "payment.create": { limit: 1, windowMs: 60_000 } },
      },
      clock: () => now,
    });
    server = createAskServer({ port: 0, host: "127.0.0.1", idemStore: store, limiter });
    const base = `http://127.0.0.1:${await listen(server)}`;
    const post = (body) =>
      fetch(`${base}/execute`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

    const first = await post({ command_id: randomUUID(), proposal: PROPOSAL });
    assert.equal(first.status, 200, JSON.stringify(await first.json()));

    const blockedCommand = randomUUID();
    const second = await post({ command_id: blockedCommand, proposal: PROPOSAL });
    const body = await second.json();
    assert.equal(second.status, 429, "the capability budget, not the user budget, must refuse");
    assert.equal(body.code, "RATE_LIMITED");
    assert.equal(store.status(blockedCommand), null, "still no command_id burned on the capability path");
    assert.equal(
      writeExecEntries(stateFile).filter((p) => p.reference_no === blockedCommand).length,
      0,
      "nothing written",
    );

    // The refusal names the capability scope, so an operator can tell WHICH
    // budget bit (per-user vs per-capability) from the trail alone.
    const lines = readFileSync(join(logDir, "observations.jsonl"), "utf8")
      .split("\n").filter((l) => l.trim() !== "").map((l) => JSON.parse(l));
    const refusal = lines.find((l) => l.outcome === "rate_limited");
    assert.ok(refusal, "the refusal is logged");
    assert.equal(refusal.scope, "per_capability");
    assert.equal(refusal.capability, "payment.create");

    // A different action (or a reopened window) is not blocked by that rule.
    now += 60_000;
    const third = await post({ command_id: randomUUID(), proposal: PROPOSAL });
    assert.equal(third.status, 200, "new window, new capability budget");
  } finally {
    delete process.env.MOCK_ERP_STATE;
    delete process.env.LEARNING_LOG_DIR;
    server?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------- observability --

test("correlation: /execute + a throttled attempt each append ONE line with command_id/action_id/outcome", async () => {
  const dir = mkdtempSync(join(tmpdir(), "p10-log-"));
  const logDir = join(dir, "logs");
  let server = null;
  let now = Date.now();
  process.env.LEARNING_LOG_DIR = logDir;
  try {
    const { createAskServer } = await import("../src/http-ask.mjs");
    const { IdempotencyStore } = await import("../src/idempotency.mjs");
    const limiter = new RateLimiter({
      rules: { perUser: { read: { limit: 99, windowMs: 60_000 }, write_proposal: { limit: 99, windowMs: 60_000 }, write_execute: { limit: 1, windowMs: 20_000 } }, perCapability: {} },
      clock: () => now,
    });
    server = createAskServer({ port: 0, host: "127.0.0.1", idemStore: new IdempotencyStore(dir), limiter });
    const base = `http://127.0.0.1:${await listen(server)}`;
    const post = (body) =>
      fetch(`${base}/execute`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

    const cid = randomUUID();
    const proposal = { ...PROPOSAL, action_id: "act_p10_test" };
    assert.equal((await post({ command_id: cid, proposal })).status, 200);
    now += 20_000; // window reopens so the next charge is the new window's first
    assert.equal((await post({ command_id: randomUUID(), proposal })).status, 200);
    const throttledCommand = randomUUID();
    assert.equal((await post({ command_id: throttledCommand, proposal })).status, 429);

    const lines = readFileSync(join(logDir, "observations.jsonl"), "utf8")
      .split("\n")
      .filter((l) => l.trim() !== "")
      .map((l) => JSON.parse(l));
    const exec = lines.filter((l) => l.phase === "execute");
    assert.equal(exec.length, 3, "one line per /execute attempt, including the refusal");
    assert.equal(exec[0].outcome, "write_verified");
    assert.equal(exec[0].command_id, cid);
    assert.equal(exec[0].action_id, "act_p10_test");
    assert.equal(exec[0].capability, "payment.create", "capability derived from the proposal action");
    assert.equal(exec[0].user_id, "local");
    assert.ok(typeof exec[0].request_id === "string" && exec[0].request_id.length > 0);
    assert.ok(typeof exec[0].latency_ms === "number");
    assert.equal(exec[2].outcome, "rate_limited", "the refusal is its own bucket, not 'error'");
    assert.equal(exec[2].command_id, throttledCommand);
    assert.equal(exec[2].scope, "per_user");
  } finally {
    delete process.env.LEARNING_LOG_DIR;
    server?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
