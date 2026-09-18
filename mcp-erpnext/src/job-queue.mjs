/**
 * P7 — Job queue for confirmed-but-unreachable writes (plan2_final §19 P7;
 * phases2/p7-background-jobs-tts.md).
 *
 * THE PROBLEM: `runExecute()` already refuses a confirmed write with 503 +
 * `retry_same_command_id: true` when ERPNext is unreachable (client-open
 * failure = nothing written) or the write outcome is unverified (§10.2 —
 * kept PENDING so the next attempt reconciles). Until P7 that retry existed
 * ONLY if the human pressed Confirm again. If they closed the app instead,
 * the intent sat invisible.
 *
 * THE P7 CONTRACT (this module):
 *  - The gateway verdicts that are RETRYABLE (503 + retry_same_command_id)
 *    may be ENQUEUED verbatim (command_id + proposal + dedup_ack). Nothing is
 *    re-derived — the queue replays the SAME Safety Gateway path, so every
 *    guard that applied at confirm time applies again at drain time.
 *  - Persistent JSONL store (repo-local, never /tmp — result31 lesson),
 *    append-only: one event line per transition, the last line per
 *    command_id wins on load.
 *  - Bounded retry: max N attempts with a delay. A job that keeps failing is
 *    marked FAILED with the last error — never silently dropped, never
 *    "succeeded" without VERIFIED proof.
 *  - NO new write path: the runner calls runExecute() (the only write in the
 *    project). It never talks to ERPNext itself.
 *  - Double-write safety is inherited, not re-implemented: runExecute +
 *    idempotency store guarantee one command_id writes at most once, and a
 *    lost response reconciles by reference_no.
 *
 * NOT in P7: push notifications (client polls /jobs), TTS (client-side),
 * multi-tenant queues.
 */

import { appendFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

export const JOB_STATES = Object.freeze({
  QUEUED: "QUEUED",       // enqueued from a retryable 503, waiting for the runner
  RUNNING: "RUNNING",     // drained once, awaiting a verdict
  RETRYING: "RETRYING",   // a retryable verdict came back; waiting for next attempt
  VERIFIED: "VERIFIED",   // runExecute returned ok:true (gateway verified the doc)
  FAILED: "FAILED",       // non-retryable verdict, or retry budget exhausted
  CANCELLED: "CANCELLED", // the user cancelled the intent before it drained
});

/** Legal transitions (mirrors the spirit of execution-state.mjs). */
const JOB_TRANSITIONS = Object.freeze({
  QUEUED: ["RUNNING", "CANCELLED"],
  RUNNING: ["RETRYING", "VERIFIED", "FAILED"],
  RETRYING: ["RUNNING", "CANCELLED"],
  VERIFIED: [],
  FAILED: [],
  CANCELLED: [],
});

export function canJobTransition(from, to) {
  return (JOB_TRANSITIONS[from] ?? []).includes(to);
}

/** Defaults overridable via env — bounded so a broken config cannot spin. */
export function jobQueueConfig(env = process.env) {
  // env-number law (451cd8f): finite AND positive or the default.
  const num = (v, d) => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : d;
  };
  return {
    enabled: String(env.JOB_QUEUE ?? "on").toLowerCase() !== "off",
    dir: env.JOB_QUEUE_DIR ?? path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..", "job-queue"),
    maxAttempts: num(env.JOB_QUEUE_MAX_ATTEMPTS, 5),
    delayMs: num(env.JOB_QUEUE_DELAY_MS, 60_000),
  };
}

export class JobQueue {
  /** @param {{config?: object, now?: () => number}} [opts] */
  constructor(opts = {}) {
    this.config = opts.config ?? jobQueueConfig();
    this.now = opts.now ?? Date.now;
    this.jobs = new Map(); // command_id -> job record
    this._load();
  }

  get file() {
    return path.join(this.config.dir, "jobs.jsonl");
  }

  _load() {
    if (!existsSync(this.file)) return;
    const lines = readFileSync(this.file, "utf8").split("\n").filter((l) => l.trim());
    for (const line of lines) {
      try {
        const job = JSON.parse(line);
        // Crash recovery (review 2026-09-18, finding F-B): a job persisted in
        // RUNNING means the process died mid-attempt — the write outcome is
        // UNKNOWN, and dueJobs() would never pick RUNNING up again (permanent
        // stall). RETRYING is the safe branch: replaying through the Safety
        // Gateway is idempotent (command_id store + reconcile-by-reference),
        // so an unknown outcome is retried, not assumed failed or written.
        if (job.state === JOB_STATES.RUNNING) {
          job.state = JOB_STATES.RETRYING;
          job.next_attempt_at = Date.now(); // due immediately
        }
        // Terminal jobs are kept for the audit trail but never re-run.
        this.jobs.set(job.command_id, job);
      } catch { /* skip corrupt line — evidence lives in the raw file */ }
    }
  }

  _persistEvent(job, event) {
    mkdirSync(this.config.dir, { recursive: true });
    appendFileSync(this.file, JSON.stringify({ ...job, event, ts: new Date(this.now()).toISOString() }) + "\n", "utf8");
  }

  /**
   * Enqueue a retryable gateway refusal. The verdict body MUST carry
   * retry_same_command_id (that is what makes it queueable) and the caller
   * MUST pass the original command_id + proposal verbatim.
   * @returns {{ok: true, job: object} | {ok: false, reason: string}}
   */
  enqueue({ command_id, proposal, dedup_ack = false, reason }) {
    if (!this.config.enabled) return { ok: false, reason: "JOB_QUEUE_DISABLED" };
    if (!command_id || !proposal) return { ok: false, reason: "MISSING_COMMAND_OR_PROPOSAL" };
    if (this.jobs.has(command_id)) {
      const existing = this.jobs.get(command_id);
      // Idempotent enqueue: the same intent may be enqueued by a second retry
      // tap — that must not double the attempts budget or fork the record.
      return { ok: true, job: existing, duplicate: true };
    }
    if (!canJobTransition("QUEUED", "QUEUED")) { /* unreachable, kept for symmetry */ }
    const job = {
      command_id,
      proposal, // verbatim — replayed through the gateway, never re-built
      dedup_ack: dedup_ack === true,
      reason: reason ?? null,
      state: JOB_STATES.QUEUED,
      attempts: 0,
      last_error: null,
      next_attempt_at: this.now(),
      created_at: new Date(this.now()).toISOString(),
    };
    this.jobs.set(command_id, job);
    this._persistEvent(job, "ENQUEUED");
    return { ok: true, job };
  }

  /** Jobs the runner may pick up right now (QUEUED, or RETRYING past its delay). */
  dueJobs() {
    const now = this.now();
    return [...this.jobs.values()]
      .filter((j) => j.state === JOB_STATES.QUEUED || (j.state === JOB_STATES.RETRYING && now >= j.next_attempt_at))
      .sort((a, b) => a.next_attempt_at - b.next_attempt_at);
  }

  _transition(job, to) {
    if (!canJobTransition(job.state, to)) {
      throw Object.assign(new Error(`JOB_TRANSITION_INVALID: ${job.state} → ${to}`), {
        code: "JOB_TRANSITION_INVALID",
      });
    }
    job.state = to;
  }

  /**
   * Drain due jobs by replaying them through the Safety Gateway.
   * @param {{runExecute: Function}} deps runExecute is REQUIRED and is the
   *        same function the /execute endpoint uses — no second write path.
   * @returns {Promise<Array<{command_id, state, error?}>>} per-job outcomes
   */
  async drain(deps) {
    if (typeof deps?.runExecute !== "function") {
      throw new Error("JobQueue.drain requires deps.runExecute (the Safety Gateway)");
    }
    const outcomes = [];
    for (const job of this.dueJobs()) {
      this._transition(job, JOB_STATES.RUNNING);
      job.attempts += 1;
      this._persistEvent(job, "ATTEMPT");

      let verdict;
      try {
        verdict = await deps.runExecute({
          command_id: job.command_id,
          proposal: job.proposal,
          dedup_ack: job.dedup_ack,
        });
      } catch (err) {
        // runExecute is supposed to return verdicts, not throw. A throw here
        // is a bug — the job must NOT be marked FAILED (that is a terminal
        // lie about a write whose outcome we do not know). Retry instead.
        verdict = { status: 503, body: { retry_same_command_id: true, error: `runner bug: ${err?.message ?? err}` } };
      }

      if (verdict.status === 200 && verdict.body?.ok === true) {
        this._transition(job, JOB_STATES.VERIFIED);
        job.last_error = null;
        this._persistEvent(job, "VERIFIED");
        outcomes.push({ command_id: job.command_id, state: JOB_STATES.VERIFIED });
        continue;
      }

      const retryable =
        verdict.status === 503 && verdict.body?.retry_same_command_id === true;
      if (retryable && job.attempts < this.config.maxAttempts) {
        this._transition(job, JOB_STATES.RETRYING);
        job.last_error = verdict.body?.error ?? `HTTP ${verdict.status}`;
        job.next_attempt_at = this.now() + this.config.delayMs;
        this._persistEvent(job, "RETRYING");
        outcomes.push({ command_id: job.command_id, state: JOB_STATES.RETRYING, error: job.last_error });
        continue;
      }

      // Non-retryable verdict, or the retry budget ran out. The Safety Gateway
      // already wrote the terminal store state for non-retryable errors; the
      // job only reflects it. NEVER invent success here.
      this._transition(job, JOB_STATES.FAILED);
      job.last_error = verdict.body?.error ?? `HTTP ${verdict.status}`;
      this._persistEvent(job, "FAILED");
      outcomes.push({ command_id: job.command_id, state: JOB_STATES.FAILED, error: job.last_error });
    }
    return outcomes;
  }

  status(commandId) {
    return this.jobs.get(commandId) ?? null;
  }

  /** All non-terminal jobs (for /jobs reporting). */
  pending() {
    return [...this.jobs.values()].filter((j) => ![JOB_STATES.VERIFIED, JOB_STATES.FAILED, JOB_STATES.CANCELLED].includes(j.state));
  }

  /** Terminal jobs, newest intent first (review finding F-C: a poller that
   *  only ever sees "pending" can never observe VERIFIED/FAILED — the queue's
   *  whole point). Capped so a long-lived process report stays small. */
  completed(limit = 20) {
    return [...this.jobs.values()]
      .filter((j) => [JOB_STATES.VERIFIED, JOB_STATES.FAILED, JOB_STATES.CANCELLED].includes(j.state))
      .sort((a, b) => String(b.created_at ?? "").localeCompare(String(a.created_at ?? "")))
      .slice(0, limit);
  }

  cancel(commandId) {
    const job = this.jobs.get(commandId);
    if (!job) return { ok: false, reason: "UNKNOWN_JOB" };
    if (!canJobTransition(job.state, JOB_STATES.CANCELLED)) {
      return { ok: false, reason: `NOT_CANCELLABLE (${job.state})` };
    }
    this._transition(job, JOB_STATES.CANCELLED);
    this._persistEvent(job, "CANCELLED");
    return { ok: true, job };
  }

  /**
   * Release a queued intent after the /execute/cancel endpoint PROVED (via
   * reconcile: 0 documents) that the write never landed. Review finding F-D:
   * without this, a cancelled PENDING command's job stayed QUEUED and drained
   * later — landing as a surprising FAILED (PROPOSAL_CANCELLED) instead of
   * just going away. Only QUEUED/RETRYING jobs are releasable: RUNNING means
   * an attempt may be in flight and the replay is idempotent anyway.
   */
  release(commandId) {
    const job = this.jobs.get(commandId);
    if (!job) return { ok: false, reason: "UNKNOWN_JOB" };
    if (job.state !== JOB_STATES.QUEUED && job.state !== JOB_STATES.RETRYING) {
      return { ok: false, reason: `NOT_RELEASABLE (${job.state})` };
    }
    this._transition(job, JOB_STATES.CANCELLED);
    this._persistEvent(job, "CANCELLED");
    return { ok: true, job };
  }
}
