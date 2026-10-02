/**
 * Rate limiting — P10 slice (plan2_final §24.3 operational_controls.rate_limit).
 *
 * The Capability Contract already DECLARED the limits; nothing enforced them.
 * This module is that enforcement, kept as thin as the slice allows:
 *
 *   per_user:        read 30/minute · write_proposal 10/minute · write_execute 5/minute
 *   per_capability:  payment.create 20/hour
 *
 * Safety properties (why this is not just "config in YAML"):
 *
 *  1. FAIL-SAFE on a broken contract: a missing/garbled spec falls back to the
 *     built-in DEFAULT of that bucket and says so on stderr. A typo must not
 *     silently remove a limit (the same class of bug as result47 §6: garbage
 *     config disabling a safety gate).
 *  2. The limiter is consulted BEFORE the Safety Gateway on the WRITE path, so
 *     a rate-limited execute never begins an idempotency record — the caller's
 *     command_id is still fresh when the window reopens.
 *  3. Charging is per identity (the authenticated user, "local" on loopback):
 *     one noisy client cannot exhaust another's budget.
 *  4. In-process windows only. Deliberate slice limitation (documented gap):
 *     a restart clears the counters, and a multi-process gateway would need the
 *     contract's [redis, file_fallback] storage. This is enough for a single
 *     gateway on one host; it is NOT a distributed quota system.
 */

import { operationalControls } from "./capability-contract.mjs";

// NOTE: mapping a proposal action → capability id is `capabilityForAction()`
// in capability-contract.mjs. This module used to carry its own copy that read
// `operationalControls().capabilities` — a branch that does not exist — so it
// returned null for EVERY action and the declared per-capability limit
// (payment.create 20/hour) silently never fired. import the real one; do not
// re-derive contract knowledge here.
// `export { x } from` alone creates NO local binding — proposalBucketFor()
// below needs the real import, otherwise every /ask that returns a result
// throws ReferenceError inside the try and answers 500.
import { capabilityForAction, getCapability } from "./capability-contract.mjs";

export { capabilityForAction };

const UNITS = { second: 1000, minute: 60_000, hour: 3_600_000 };

/**
 * Built-in defaults. Also the fallback when the contract entry is malformed —
 * never "no limit".
 */
export const DEFAULT_USER_RULES = Object.freeze({
  read: Object.freeze({ limit: 30, windowMs: UNITS.minute }),
  write_proposal: Object.freeze({ limit: 10, windowMs: UNITS.minute }),
  write_execute: Object.freeze({ limit: 5, windowMs: UNITS.minute }),
});

export const DEFAULT_CAPABILITY_RULE = Object.freeze({ limit: 20, windowMs: UNITS.hour });

const USER_BUCKETS = Object.freeze(["read", "write_proposal", "write_execute"]);

/**
 * Parse a contract spec like "30/minute" or "20/hour" into a window rule.
 * @returns {{limit: number, windowMs: number}|null} null when unusable
 */
export function parseRateSpec(spec) {
  // Plain string match, not `Number()`: "30/minute garbage" must NOT parse, and
  // Number("") === 0 style coercion has bitten this project before (451cd8f).
  const m = /^\s*(\d+)\s*\/\s*(second|minute|hour)s?\s*$/i.exec(String(spec ?? ""));
  if (!m) return null;
  const limit = Number(m[1]);
  const windowMs = UNITS[m[2].toLowerCase()];
  if (!Number.isFinite(limit) || limit <= 0 || !Number.isFinite(windowMs)) return null;
  return { limit, windowMs };
}

/**
 * Resolve the effective rules from the Capability Contract.
 * @param {{controls?: object, env?: object, warn?: (msg: string) => void}} [opts]
 */
export function rateLimitRules({ controls = operationalControls(), env = process.env, warn } = {}) {
  const say = warn ?? ((msg) => { try { process.stderr.write(msg); } catch { /* stderr gone */ } });
  const rl = controls?.rate_limit ?? {};
  const bad = [];

  const perUser = {};
  for (const bucket of USER_BUCKETS) {
    const raw = rl?.per_user?.[bucket];
    const parsed = parseRateSpec(raw);
    if (parsed) {
      perUser[bucket] = parsed;
    } else {
      if (raw !== undefined) bad.push(`per_user.${bucket}=${JSON.stringify(raw)}`);
      perUser[bucket] = DEFAULT_USER_RULES[bucket];
    }
  }

  const perCapability = {};
  for (const [capabilityId, raw] of Object.entries(rl?.per_capability ?? {})) {
    const parsed = parseRateSpec(raw);
    if (parsed) {
      perCapability[capabilityId] = parsed;
    } else {
      bad.push(`per_capability.${capabilityId}=${JSON.stringify(raw)}`);
      perCapability[capabilityId] = DEFAULT_CAPABILITY_RULE;
    }
  }

  if (bad.length > 0) {
    say(`[rate-limit] unusable spec(s) in the contract, using safe defaults: ${bad.join(", ")}\n`);
  }
  return { perUser, perCapability };
}

/** Rate limiting is ON unless the operator explicitly switches it off. */
export function rateLimitEnabled(env = process.env) {
  return String(env?.COPILOT_RATE_LIMIT ?? "on").trim().toLowerCase() !== "off";
}

/**
 * Fixed-window counter per bucket key. Fixed (not sliding) on purpose: it is
 * the simplest thing that bounds a burst, and the window boundary is a known,
 * accepted artefact of this slice.
 */
export class RateLimiter {
  constructor({ rules = rateLimitRules(), clock = Date.now, enabled = rateLimitEnabled() } = {}) {
    this.rules = rules;
    this.clock = clock;
    this.enabled = enabled;
    this._windows = new Map();
  }

  /** @returns {RateLimiter} a limiter that lets everything through (tests/off) */
  static disabled() {
    return new RateLimiter({ enabled: false });
  }

  /**
   * Charge one hit against a per-user bucket.
   * @param {"read"|"write_proposal"|"write_execute"} bucket
   * @param {string|null} userId identity; null/'' becomes "local" (loopback)
   */
  chargeUser(bucket, userId) {
    const spec = this.rules.perUser?.[bucket] ?? DEFAULT_USER_RULES[bucket];
    return this._hit(`${bucket}:${userId || "local"}`, spec);
  }

  /**
   * Charge one hit against a declared per-capability rule. A capability with no
   * declared rule is not limited (the contract is the source of truth).
   * @param {string|null} capabilityId
   * @param {string|null} userId
   */
  chargeCapability(capabilityId, userId) {
    const spec = capabilityId ? this.rules.perCapability?.[capabilityId] : null;
    if (!spec) return { ok: true, skipped: true };
    return this._hit(`cap:${capabilityId}:${userId || "local"}`, spec);
  }

  _hit(key, spec) {
    if (!this.enabled) return { ok: true, skipped: true };
    const now = this.clock();
    const w = this._windows.get(key);
    if (!w || now - w.start >= w.windowMs || now < w.start) {
      // New window. `now < w.start` guards an injected clock that went
      // backwards (test/VM clock jump) — otherwise the bucket would be stuck
      // refusing until wall time caught up with the future window start.
      this._prune(now);
      // The window's own length is stored with it: the entries are keyed by
      // identity+bucket, so looking the length up again from the key prefix
      // (the previous approach) was guesswork and could prune too late.
      this._windows.set(key, { start: now, count: 1, windowMs: spec.windowMs });
      return { ok: true, limit: spec.limit, windowMs: spec.windowMs, remaining: spec.limit - 1 };
    }
    if (w.count >= spec.limit) {
      return {
        ok: false,
        limit: spec.limit,
        windowMs: spec.windowMs,
        retryAfterMs: Math.max(0, spec.windowMs - (now - w.start)),
      };
    }
    w.count += 1;
    return { ok: true, limit: spec.limit, windowMs: spec.windowMs, remaining: spec.limit - w.count };
  }

  /** Drop elapsed windows so a long-lived gateway cannot grow the map forever. */
  _prune(now) {
    if (this._windows.size < 500) return;
    for (const [key, w] of this._windows) {
      if (now - w.start >= w.windowMs) this._windows.delete(key);
    }
  }

  reset() {
    this._windows.clear();
  }
}

/**
 * Which metering bucket a delivered proposal belongs to.
 *
 * NOT `proposal != null`: every READ route also returns a proposal object
 * (action "read_balance", Phase 6), so charging on presence alone would spend
 * the user's WRITE budget answering ordinary questions. A proposal is metered
 * as a write when the contract says its capability is a WRITE, or — for an
 * action the contract does not know — when it declares itself HIGH/CRITICAL.
 *
 * @param {object|null} proposal
 * @returns {"write_proposal"|null}
 */
export function proposalBucketFor(proposal) {
  if (!proposal) return null;
  const id = capabilityForAction(proposal.action);
  if (id && getCapability(id)?.type === "WRITE") return "write_proposal";
  const level = typeof proposal.risk === "string" ? proposal.risk : proposal.risk?.level;
  if (level === "HIGH" || level === "CRITICAL") return "write_proposal";
  return null;
}

/** Uniform friendly copy — the user gets a sentence, not a bare 429. */
export function rateLimitMessage(verdict, { write = false } = {}) {
  const seconds = Math.max(1, Math.ceil((verdict?.retryAfterMs ?? 0) / 1000));
  return write
    ? `Bạn đã gửi quá nhiều yêu cầu ghi trong thời gian ngắn. Vui lòng thử lại sau khoảng ${seconds} giây — chưa có giao dịch nào được ghi.`
    : `Bạn đã gửi quá nhiều câu hỏi trong thời gian ngắn. Vui lòng thử lại sau khoảng ${seconds} giây.`;
}
