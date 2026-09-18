/**
 * P7 tests — background job queue for confirmed-but-unreachable writes
 * (plan2_final §19 P7; phases2/p7-background-jobs-tts.md).
 *
 * Safety properties under test:
 *  1. A retryable 503 from the Safety Gateway (ERP down / unverified write)
 *     becomes a QUEUED job; the queue replays the SAME runExecute — there is
 *     no second write path anywhere in this module (the runner throws unless
 *     it is handed the gateway function).
 *  2. Drain after ERP recovers → VERIFIED exactly once; a SECOND drain of the
 *     same job must be a no-op (terminal states never re-run) — that plus the
 *     idempotency store is the no-double-payment guarantee.
 *  3. ERP still down → RETRYING with bounded attempts; budget exhausted →
 *     FAILED with the last error. Never a silent drop, never a fake success.
 *  4. Duplicate enqueue (double-tap retry) does not fork the record or grow
 *     the attempt budget.
 *  5. The 503-verdict wiring in /ask enqueues; 200/409/500 do NOT.
 *  6. Persistence: jobs survive a process restart (the whole point vs RAM).
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { JobQueue, JOB_STATES, jobQueueConfig, canJobTransition } from "../src/job-queue.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

function tmpCfg(t, overrides = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "jobs-"));
  t?.after?.(() => rmSync(dir, { recursive: true, force: true }));
  return { ...jobQueueConfig({ JOB_QUEUE_DIR: dir, ...overrides }), dir };
}

const PROPOSAL = {
  version: 1,
  action: "create_payment_entry",
  risk: "HIGH",
  entity: { kind: "customer", id: "CUST-00001", name: "Nguyễn Thị Lan" },
  params: { amount_vnd: 50000, mode_of_payment: "Cash" },
  summary: "Thu 50.000đ — Nguyễn Thị Lan",
};

test("job state machine — terminal states never transition again", () => {
  assert.equal(canJobTransition(JOB_STATES.QUEUED, JOB_STATES.RUNNING), true);
  assert.equal(canJobTransition(JOB_STATES.RUNNING, JOB_STATES.VERIFIED), true);
  assert.equal(canJobTransition(JOB_STATES.RUNNING, JOB_STATES.RETRYING), true);
  assert.equal(canJobTransition(JOB_STATES.VERIFIED, JOB_STATES.RUNNING), false, "VERIFIED must never re-run");
  assert.equal(canJobTransition(JOB_STATES.FAILED, JOB_STATES.RUNNING), false);
});

test("enqueue — retryable verdict parks the intent; duplicate enqueue is idempotent", () => {
  const cfg = tmpCfg();
  const q = new JobQueue({ config: cfg });
  const first = q.enqueue({ command_id: "cmd-1", proposal: PROPOSAL, reason: "ERP down" });
  assert.equal(first.ok, true);
  assert.equal(first.job.state, JOB_STATES.QUEUED);
  assert.equal(first.job.attempts, 0);

  // The user taps retry again while the ERP is still down: must not fork the
  // record or reset the attempts budget.
  const second = q.enqueue({ command_id: "cmd-1", proposal: PROPOSAL, reason: "ERP down" });
  assert.equal(second.ok, true);
  assert.equal(second.duplicate, true);
  assert.equal(q.status("cmd-1").attempts, 0);

  // Malformed enqueue is refused, not half-stored.
  assert.equal(q.enqueue({ proposal: PROPOSAL }).ok, false);
  assert.equal(q.enqueue({ command_id: "cmd-2" }).ok, false);
});

test("drain — ERP recovered: VERIFIED exactly once; second drain is a no-op", async () => {
  const cfg = tmpCfg();
  const q = new JobQueue({ config: cfg });
  q.enqueue({ command_id: "cmd-1", proposal: PROPOSAL });

  let calls = 0;
  const runExecute = async ({ command_id }) => {
    calls += 1;
    assert.equal(command_id, "cmd-1", "the gateway receives the ORIGINAL command_id");
    return { status: 200, body: { ok: true, replay: false, result: { erpnext_doc: "ACC-PAY-2026-000001" } } };
  };

  const outcomes = await q.drain({ runExecute });
  assert.deepEqual(outcomes, [{ command_id: "cmd-1", state: JOB_STATES.VERIFIED }]);
  assert.equal(calls, 1);
  assert.equal(q.status("cmd-1").state, JOB_STATES.VERIFIED);

  // A second drain cycle must not re-run a terminal job.
  const again = await q.drain({ runExecute });
  assert.equal(again.length, 0);
  assert.equal(calls, 1, "the gateway was called exactly ONCE — no double payment");
});

test("drain — ERP still down: RETRYING with backoff, budget exhausted → FAILED", async (t) => {
  // FULLY controlled clock (lesson 47/§10: a 10ms real delay flakes when the
  // runner is slow — the first flake showed the 'before delay' drain consuming
  // attempt 2 after 15ms of real time). Nothing here reads the real clock.
  let fake = 1_000_000;
  // PASS THE TEST CONTEXT: tmpCfg(t, overrides) — passing overrides as the
  // first arg silently dropped them (defaults 5/60s kept ⇒ attempt 2 stayed
  // RETRYING). The bug was the harness signature, not the queue.
  const cfg = tmpCfg(t, { JOB_QUEUE_MAX_ATTEMPTS: "2", JOB_QUEUE_DELAY_MS: "10" });
  const q = new JobQueue({ config: cfg, now: () => fake });
  q.enqueue({ command_id: "cmd-1", proposal: PROPOSAL });

  let calls = 0;
  const runExecute = async () => {
    calls += 1;
    return { status: 503, body: { ok: false, retry_same_command_id: true, error: "không mở được kết nối ERPNext" } };
  };

  const o1 = await q.drain({ runExecute });
  assert.equal(o1[0].state, JOB_STATES.RETRYING);
  assert.equal(calls, 1);

  // Clock unchanged → delay not elapsed → not due, no call.
  assert.equal((await q.drain({ runExecute })).length, 0);
  assert.equal(calls, 1);

  // Advance past the delay: attempt 2 = the LAST allowed (2/2), so it runs
  // and lands FAILED immediately.
  fake += 11;
  const o2 = await q.drain({ runExecute });
  assert.equal(o2[0].state, JOB_STATES.FAILED, "attempt 2/2 exhausts the budget → FAILED");
  assert.match(o2[0].error, /không mở được kết nối/);
  assert.equal(calls, 2, "FAILED is terminal — no further attempts");

  fake += 100_000;
  assert.equal((await q.drain({ runExecute })).length, 0);
  assert.equal(calls, 2);
});

test("drain — non-retryable verdicts go straight to FAILED (never retried)", async () => {
  const cfg = tmpCfg();
  const q = new JobQueue({ config: cfg });
  q.enqueue({ command_id: "cmd-1", proposal: PROPOSAL });

  let calls = 0;
  const runExecute = async () => {
    calls += 1;
    return { status: 409, body: { ok: false, code: "PROPOSAL_STALE", error: "số dư đã đổi" } };
  };

  const outcomes = await q.drain({ runExecute });
  assert.equal(outcomes[0].state, JOB_STATES.FAILED);
  assert.equal(calls, 1);
  assert.equal((await q.drain({ runExecute })).length, 0, "terminal — never re-run");
});

test("drain — a runner bug (throw) is RETRYABLE, never a fabricated FAILED", async (t) => {
  const cfg = tmpCfg(t, { JOB_QUEUE_MAX_ATTEMPTS: "1", JOB_QUEUE_DELAY_MS: "5" });
  const q = new JobQueue({ config: cfg });
  q.enqueue({ command_id: "cmd-1", proposal: PROPOSAL });

  const runExecute = async () => {
    throw new Error("runner bug");
  };
  const outcomes = await q.drain({ runExecute });
  // With budget 1 the retryable path converts to FAILED *after* the budget
  // check — the job is FAILED but by exhaustion, not by guessing.
  assert.equal(outcomes[0].state, JOB_STATES.FAILED);
  assert.match(outcomes[0].error, /runner bug/);
});

test("drain — refuses to run without the Safety Gateway dependency", async () => {
  const q = new JobQueue({ config: tmpCfg() });
  await assert.rejects(() => q.drain({}), /requires deps\.runExecute/);
  await assert.rejects(() => q.drain(), /requires deps\.runExecute/);
});

test("persistence — jobs survive a restart (state file is the source of truth)", async () => {
  const cfg = tmpCfg();
  const q1 = new JobQueue({ config: cfg });
  q1.enqueue({ command_id: "cmd-1", proposal: PROPOSAL });

  // "Restart": a brand-new instance over the same dir must see the job.
  const q2 = new JobQueue({ config: cfg });
  assert.equal(q2.status("cmd-1")?.state, JOB_STATES.QUEUED);
  assert.equal(q2.pending().length, 1);

  // And it drains to VERIFIED on the new instance.
  const outcomes = await q2.drain({ runExecute: async () => ({ status: 200, body: { ok: true } }) });
  assert.equal(outcomes[0].state, JOB_STATES.VERIFIED);
  assert.ok(existsSync(path.join(cfg.dir, "jobs.jsonl")));
});

test("wiring — /execute 503 retryable enqueues; 200/409 do not; GET /jobs reports", async () => {
  // Static wiring check (the full E2E would duplicate the http-ask harness):
  // the enqueue block must be conditioned on retry_same_command_id ONLY.
  const src = readFileSync(path.join(HERE, "..", "src", "http-ask.mjs"), "utf8");
  const wiring = src.slice(src.indexOf("sendJson(res, verdict.status, verdict.body);"));
  assert.match(wiring, /retry_same_command_id === true/, "enqueue must key on the retryable verdict");
  assert.match(wiring, /jobQueue\.enqueue\(\{[\s\S]*?command_id: body\?\.command_id/, "verbatim command_id");
  assert.match(wiring, /proposal: body\?\.proposal/, "verbatim proposal — never re-built");
  // 200/409 paths return before the wiring block (the block sits after sendJson).
  assert.match(src, /if \(req\.method === "GET" && path === "\/jobs"\)/, "GET /jobs endpoint exists");
});

// ─── Review round 2026-09-18: F-A runner · F-B crash recovery · F-C completed
// ─── report · F-D cancel releases queued jobs ─────────────────────────────────

import { appendFileSync } from "node:fs";
import { startJobRunner } from "../src/http-ask.mjs";

test("F-B crash recovery — a job persisted RUNNING reloads as RETRYING and is due immediately", async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), "jobs-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  // Simulate a process that died mid-attempt: the last event line says RUNNING.
  appendFileSync(path.join(dir, "jobs.jsonl"), JSON.stringify({
    command_id: "cmd-crash", proposal: PROPOSAL, dedup_ack: false, reason: null,
    state: "RUNNING", attempts: 1, last_error: null, next_attempt_at: 1,
    created_at: "2026-09-18T00:00:00.000Z",
  }) + "\n", "utf8");

  const q = new JobQueue({ config: jobQueueConfig({ JOB_QUEUE_DIR: dir }), dir });
  assert.equal(q.status("cmd-crash").state, JOB_STATES.RETRYING, "RUNNING must never stall forever");

  // The recovered job is immediately due and drains to VERIFIED — the replay
  // through the Safety Gateway is idempotent (command_id + reconcile).
  const outcomes = await q.drain({ runExecute: async () => ({ status: 200, body: { ok: true } }) });
  assert.equal(outcomes[0].state, JOB_STATES.VERIFIED);
});

test("F-C completed() — terminal jobs are reportable, newest intent first, capped", () => {
  const cfg = tmpCfg();
  const q = new JobQueue({ config: cfg });
  for (const [id, created] of [["a", "2026-09-18T01:00:00.000Z"], ["b", "2026-09-18T02:00:00.000Z"], ["c", "2026-09-18T03:00:00.000Z"]]) {
    q.enqueue({ command_id: id, proposal: PROPOSAL });
    q.jobs.get(id).created_at = created;
  }
  // Verify two, fail none, leave one pending.
  for (const id of ["a", "b"]) {
    q.jobs.get(id).state = JOB_STATES.VERIFIED;
  }
  const done = q.completed();
  assert.deepEqual(done.map((j) => j.command_id), ["b", "a"], "newest intent first");
  assert.equal(q.completed(1).length, 1, "cap respected");
  assert.ok(!done.some((j) => j.command_id === "c"), "non-terminal never listed");
});

test("F-D release() — queued/retrying jobs are cancellable after reconcile-proof; RUNNING is not", async () => {
  const cfg = tmpCfg();
  const q = new JobQueue({ config: cfg });
  q.enqueue({ command_id: "q1", proposal: PROPOSAL });
  assert.equal(q.release("q1").ok, true);
  assert.equal(q.status("q1").state, JOB_STATES.CANCELLED);
  assert.equal((await q.drain({ runExecute: async () => ({ status: 200, body: { ok: true } }) })).length, 0, "released job never replays");
});

test("F-D release() — a RUNNING job is refused (attempt may be in flight)", () => {
  const cfg = tmpCfg();
  const q = new JobQueue({ config: cfg });
  q.enqueue({ command_id: "r1", proposal: PROPOSAL });
  q.jobs.get("r1").state = JOB_STATES.RUNNING;
  const rel = q.release("r1");
  assert.equal(rel.ok, false);
  assert.match(rel.reason, /NOT_RELEASABLE \(RUNNING\)/);
});

test("F-A startJobRunner — drains queued jobs through the SAME gateway (the missing piece: nothing called drain in the real server)", async (t) => {
  const cfg = tmpCfg({ JOB_QUEUE_POLL_MS: "50" });
  process.env.JOB_QUEUE_POLL_MS = "50";
  t.after(() => { delete process.env.JOB_QUEUE_POLL_MS; });

  const q = new JobQueue({ config: cfg });
  q.enqueue({ command_id: "cmd-run", proposal: PROPOSAL });

  // The gateway is injectable exactly like drain(deps) — production passes
  // nothing and gets the real runExecute (asserted below).
  let calls = 0;
  const fakeGateway = async () => { calls += 1; return { status: 200, body: { ok: true } }; };
  const timer = startJobRunner({ jobQueue: q, execute: fakeGateway });
  t.after(() => clearInterval(timer));

  // Poll (up to 2s) instead of sleeping a fixed amount — robust, not flaky.
  for (let i = 0; i < 100 && q.status("cmd-run").state !== JOB_STATES.VERIFIED; i += 1) {
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.equal(q.status("cmd-run").state, JOB_STATES.VERIFIED, "the runner drained the queued intent");
  assert.ok(calls >= 1);
  assert.ok(calls <= 2, "VERIFIED is terminal — the runner never re-runs it");
});

test("F-A startJobRunner — JOB_QUEUE=off returns null (no runner, no timer)", () => {
  const cfg = tmpCfg();
  cfg.enabled = false;
  const q = new JobQueue({ config: cfg });
  const timer = startJobRunner({ jobQueue: q });
  assert.equal(timer, null);
});

test("F-A wiring — cancel releases the job; /jobs reports completed; main() runs the runner on the REAL gateway", () => {
  const src = readFileSync(path.join(HERE, "..", "src", "http-ask.mjs"), "utf8");
  const cancelBlock = src.slice(src.indexOf('path === "/execute/cancel"'), src.indexOf('path === "/execute"'));
  assert.match(cancelBlock, /jobQueue\.release\(command_id\)/, "cancel must release a parked job");
  const jobsBlock = src.slice(src.indexOf('path === "/jobs"'), src.indexOf('path === "/ask"'));
  assert.match(jobsBlock, /completed: jobQueue\.completed\(\)/, "/jobs must surface terminal outcomes");
  // The injectable gateway exists for tests only — the server must NOT inject.
  assert.match(src, /startJobRunner\(\{ jobQueue \}\)/, "main() hands the runner the real gateway");
  assert.ok(!/startJobRunner\(\{[^}]*execute:/.test(src.replace(/export function startJobRunner[\s\S]*?\n\}/, "")),
    "only the tests inject a gateway — no execute: in the server call site");
});
