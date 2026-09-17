/**
 * Action Proposal — the Phase 6 STANDARD OBJECT every copilot action produces
 * BEFORE the answer is returned (spec: "mọi hành động ghi phải sinh ra JSON
 * proposal (action, entity đã resolve, tham số, risk level) trước khi hiển
 * thị cho user — không gọi thẳng create_*").
 *
 * User decision 2026-09-16: Phase 6 builds proposals for READ actions too —
 * the structure must exist and be proven before Phase 7 (first write) plugs
 * in. A proposal for a read is informational; for writes it is the future
 * confirmation gate.
 *
 * The card the Flutter UI renders comes from this object — never raw JSON.
 */

import { randomUUID } from "node:crypto";

import { RISK_LEVELS, RISK_DISPLAY, RISK_ORDER, riskFor, isExecutable } from "./risk-levels.mjs";
import { proposalTtlMs } from "./proposal-freshness.mjs";

/**
 * Proposal schema version (plan2_final §9). Bumped only when the shape of an
 * executable proposal changes: the Safety Gateway refuses an executable
 * proposal whose version is missing or older, because "the fields I validated"
 * and "the fields the executor reads" must be the same contract.
 */
export const PROPOSAL_VERSION = 1;

/**
 * Build one standard proposal object. Throws (does not silently default)
 * when required fields are missing — a proposal without an action, entity or
 * risk level is a schema bug, not a display problem.
 *
 * @param {object} p
 * @param {string} p.action      action verb, e.g. "read_balance"
 * @param {string} p.risk        one of RISK_LEVELS (caller may pass explicitly,
 *                               otherwise derived from the action via riskFor)
 * @param {{id?: string|null, name?: string|null, kind?: string}} p.entity
 *                               the RESOLVED entity (id from a tool result only)
 * @param {object} [p.params]    operation parameters ( amounts stay VND ints)
 * @param {string} [p.summary]   Vietnamese one-liner for the card
 * @param {object} [p.extra]     passthrough (rows counts, sources...)
 * @returns {object} frozen proposal
 */
export function buildProposal({ action, risk, entity, params = {}, summary = "", extra = {} }) {
  if (typeof action !== "string" || action.trim().length === 0) {
    throw new Error("PROPOSAL_INVALID: action is required");
  }
  if (!entity || typeof entity !== "object") {
    throw new Error(`PROPOSAL_INVALID: entity is required for action "${action}"`);
  }
  const level = risk ?? riskFor(action);
  if (!RISK_ORDER.includes(level)) {
    throw new Error(`PROPOSAL_INVALID: unknown risk "${level}" for action "${action}"`);
  }
  const display = RISK_DISPLAY[level];
  const createdAt = new Date();
  const proposal = {
    schema: "erpn.proposal/v1",
    // §9 Immutable Action Proposal: the proposal IS the snapshot of what the
    // user approved. `proposal_id` identifies this snapshot, `version` lets the
    // gateway refuse a snapshot built by older code, and `expires_at` makes the
    // TTL visible to the client instead of being a server-only rule.
    proposal_id: `prp_${randomUUID()}`,
    version: PROPOSAL_VERSION,
    expires_at: new Date(createdAt.getTime() + proposalTtlMs()).toISOString(),
    action,
    // Phase 9: age gate. A proposal that cannot prove when it was built (or is
    // older than PROPOSAL_TTL_MS) is refused by /execute — see
    // proposal-freshness.mjs. Additive field: clients that ignore it still work
    // (they just cannot execute), and it survives the client round-trip so a
    // restored card carries the ORIGINAL build time.
    created_at: createdAt.toISOString(),
    risk: level,
    risk_display: { icon: display.icon, label: display.label },
    need_confirm: display.needConfirm,
    need_double_confirm: display.needDoubleConfirm,
    executable: isExecutable(level),
    entity: {
      kind: entity.kind ?? "customer",
      id: entity.id ?? null,
      name: entity.name ?? null,
      // §9: the display name is a SNAPSHOT. Execute must never re-look-up the
      // customer by text ("Nguyễn Văn A") — only by this id, re-validated
      // against live data. Kept separate from `name` so the two can be
      // compared: a divergence means the source data moved.
      name_snapshot: entity.name ?? null,
    },
    params,
    summary,
    ...extra,
  };
  // Review 2026-09-16 hardening:
  //  1. `...extra` spreads LAST so it would override control fields — safety
  //     fields (risk/need_confirm/need_double_confirm/executable) are re-pinned
  //     from `display` AFTER the spread: extras can only ADD information
  //     (source, next_action_hint...), never weaken the gate. `params` stays
  //     caller-owned (extras must not smuggle amounts past validation).
  //  2. Object.freeze is shallow — nested objects stayed mutable. Freeze the
  //     nested containers so risk/entity/params cannot be mutated post-build.
  proposal.risk = level;
  proposal.need_confirm = display.needConfirm;
  proposal.need_double_confirm = display.needDoubleConfirm;
  proposal.executable = isExecutable(level);
  proposal.entity = Object.freeze({ ...proposal.entity });
  proposal.params = Object.freeze({ ...proposal.params });
  return Object.freeze(proposal);
}

/**
 * Convenience: READ-level proposal for an already-resolved customer (or an
 * inventory read with no customer entity).
 * @param {object} p
 * @param {string} p.action
 * @param {{id?: string|null, name?: string|null, kind?: string}} p.entity
 * @param {object} [p.params]
 * @param {string} [p.summary]
 */
export function readProposal({ action, entity, params = {}, summary = "" }) {
  return buildProposal({ action, risk: RISK_LEVELS.READ, entity, params, summary });
}

export { RISK_LEVELS, RISK_ORDER, RISK_DISPLAY, riskFor, isExecutable };
