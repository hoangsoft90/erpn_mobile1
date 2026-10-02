/**
 * Execution State Machine (plan2_final §10.1 + §10.2) — the SUBSET that is
 * implementable today, with the transitions enforced in code instead of being
 * a diagram in a document.
 *
 *   PROPOSED → WAITING_CONFIRM → CONFIRMED → EXECUTING
 *                                              ├── RETRYING
 *                                              ├── RECONCILING
 *                                              ├── SUCCEEDED → VERIFIED
 *                                              └── FAILED
 *
 * §10.2 is the reason this exists: when the response to a write is LOST, the
 * system must NOT guess. It transitions to RECONCILING, looks the document up
 * by the stable correlation field, and only then finishes
 * (FOUND → VERIFIED / return existing result; NOT FOUND → execute/retry).
 *
 * The store's own `status` (PENDING/COMPLETED/FAILED/CANCELLED) stays exactly
 * as it is — Phase 7/9 code and the Flutter client depend on it. This module
 * is the finer-grained layer NEXT to it: `state` is an additive field, and
 * `mapStoreStatus` is how the two stay consistent.
 */

/** Canonical states (§10.1 order preserved for readability). */
export const EXECUTION_STATES = Object.freeze({
  PROPOSED: "PROPOSED",
  WAITING_CONFIRM: "WAITING_CONFIRM",
  CONFIRMED: "CONFIRMED",
  EXECUTING: "EXECUTING",
  RETRYING: "RETRYING",
  RECONCILING: "RECONCILING",
  SUCCEEDED: "SUCCEEDED",
  VERIFIED: "VERIFIED",
  FAILED: "FAILED",
  CANCELLED: "CANCELLED",
});

/**
 * Allowed transitions. Anything not listed is refused (throws) — a state
 * machine that accepts every transition is a state machine that guarantees
 * nothing, and "VERIFIED → EXECUTING" is exactly the shape of a double write.
 */
const TRANSITIONS = Object.freeze({
  PROPOSED: ["WAITING_CONFIRM", "CANCELLED", "FAILED"],
  WAITING_CONFIRM: ["CONFIRMED", "CANCELLED", "FAILED"],
  CONFIRMED: ["EXECUTING", "CANCELLED", "FAILED"],
  EXECUTING: ["SUCCEEDED", "RETRYING", "RECONCILING", "FAILED", "CANCELLED"],
  RETRYING: ["EXECUTING", "RECONCILING", "FAILED", "CANCELLED"],
  // RECONCILING may finish either way — that is the whole point of §10.2:
  // the lookup decides, not the timeout.
  RECONCILING: ["VERIFIED", "SUCCEEDED", "EXECUTING", "FAILED", "CANCELLED"],
  SUCCEEDED: ["VERIFIED", "RECONCILING"],
  VERIFIED: [],
  FAILED: [],
  CANCELLED: [],
});

/** Terminal states: nothing may follow them. */
export const TERMINAL_STATES = Object.freeze([EXECUTION_STATES.VERIFIED, EXECUTION_STATES.FAILED, EXECUTION_STATES.CANCELLED]);

/** §10.2: the state to enter when the outcome is genuinely unknown. */
export const UNKNOWN_EXECUTION_STATE = EXECUTION_STATES.RECONCILING;

/**
 * @param {string} from
 * @param {string} to
 * @returns {boolean}
 */
export function canTransition(from, to) {
  if (!EXECUTION_STATES[from] || !EXECUTION_STATES[to]) return false;
  return (TRANSITIONS[from] ?? []).includes(to);
}

/**
 * Throw unless the transition is legal — the store calls this so an illegal
 * transition fails loudly instead of corrupting the record.
 * @param {string} from
 * @param {string} to
 */
export function assertTransition(from, to) {
  if (!EXECUTION_STATES[from]) {
    throw Object.assign(new Error(`EXECUTION_STATE_UNKNOWN: "${from}" is not a state`), {
      code: "EXECUTION_STATE_UNKNOWN",
    });
  }
  if (!canTransition(from, to)) {
    throw Object.assign(
      new Error(`EXECUTION_TRANSITION_INVALID: ${from} → ${to} is not allowed (terminal: ${TERMINAL_STATES.join("/")})`),
      { code: "EXECUTION_TRANSITION_INVALID" },
    );
  }
}

/**
 * Map the idempotency store's coarse status onto the state machine so both
 * layers agree. `PENDING` is deliberately NOT "EXECUTING": a PENDING record
 * whose document existence is unproven is the §10.2 unknown case.
 *
 * @param {string|null|undefined} status store status
 * @param {object} [opts]
 * @param {boolean} [opts.referenceRegistered] the command reached ERPNext
 * @param {boolean} [opts.verified] the written document was read back
 * @returns {string}
 */
export function mapStoreStatus(status, { referenceRegistered = false, verified = false } = {}) {
  switch (status) {
    case "PENDING":
      return referenceRegistered && !verified ? UNKNOWN_EXECUTION_STATE : EXECUTION_STATES.EXECUTING;
    case "COMPLETED":
      return EXECUTION_STATES.VERIFIED;
    case "FAILED":
      return EXECUTION_STATES.FAILED;
    case "CANCELLED":
      return EXECUTION_STATES.CANCELLED;
    default:
      return EXECUTION_STATES.PROPOSED;
  }
}
