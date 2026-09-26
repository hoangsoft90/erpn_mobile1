/**
 * Risk Level — the Phase 6 SAFETY SCHEMA (spec: .plan/phases/phase-06-*.md).
 *
 * Spec warning implemented here: "Đừng thiết kế Risk Level như một cấu hình
 * có thể tắt dễ dàng trong production — đây là safety mechanism, không phải
 * feature flag thông thường."
 *
 * Enforced in CODE, not config:
 *  - the four levels are frozen; unknown levels throw at construction
 *  - every Action Proposal carries one (the builder refuses to build without)
 *  - `assertProposalAllowed()` refuses execution intents for HIGH/CRITICAL
 *    until the confirmation flow exists (Phase 7). Phase 6 stops at display.
 *
 * Levels (phase-06 spec, verbatim intent):
 *  🟢 READ     — reads only; no confirmation ever needed.
 *  🟡 LOW      — quick-confirm (display-only in Phase 6).
 *  🔴 HIGH     — mandatory confirm: payment, invoice create/submit, price.
 *  ⚫ CRITICAL — two-step confirm: delete/cancel documents, big stock moves.
 */

export const RISK_LEVELS = Object.freeze({
  READ: "READ",
  LOW: "LOW",
  HIGH: "HIGH",
  CRITICAL: "CRITICAL",
});

/** Frozen list — order matters (display hierarchy). */
export const RISK_ORDER = Object.freeze(["READ", "LOW", "HIGH", "CRITICAL"]);

/**
 * Vietnamese display hints — the LLM/UI layer copies these verbatim; the
 * pipeline never recomputes them.
 */
export const RISK_DISPLAY = Object.freeze({
  READ: { icon: "🟢", label: "Chỉ đọc", needConfirm: false, needDoubleConfirm: false },
  LOW: { icon: "🟡", label: "Thao tác nhẹ", needConfirm: true, needDoubleConfirm: false },
  HIGH: { icon: "🔴", label: "Cần xác nhận", needConfirm: true, needDoubleConfirm: false },
  CRITICAL: { icon: "⚫", label: "Nguy hiểm cao", needConfirm: true, needDoubleConfirm: true },
});

/**
 * Whether a risk level may proceed to EXECUTION without the (Phase 7)
 * confirmation flow. In Phase 6 only READ is ever executable — and even READ
 * proposals are display-only today, because the execute step does not exist.
 * @param {string} level
 */
export function isExecutable(level) {
  if (!(level in RISK_DISPLAY)) return false;
  return RISK_DISPLAY[level].needConfirm === false;
}

/**
 * Guard used by the proposal path: refuses an execution attempt for anything
 * above READ until Phase 7 wires the confirmation flow.
 * @param {string} level
 * @param {{phase?: string}} [ctx]
 */
export function assertProposalAllowed(level, ctx = {}) {
  const where = ctx.phase ? ` (phase: ${ctx.phase})` : "";
  if (!RISK_ORDER.includes(level)) {
    throw new Error(`RISK_LEVEL_INVALID: "${level}" is not one of ${RISK_ORDER.join("/")}${where}`);
  }
  if (!isExecutable(level)) {
    throw new Error(
      `EXECUTION_BLOCKED: risk ${level} requires the Phase 7 confirmation flow${where} — Phase 6 stops at the proposal card`,
    );
  }
  return true;
}

/**
 * Classify a skill operation. FAILS CLOSED: only verbs explicitly mapped (or
 * in the known-read allowlist) get a level — anything else throws, so a
 * Phase 7 write verb with a typo or a name not seen here CANNOT silently
 * classify as READ/executable. (Review 2026-09-16: the first version returned
 * READ for unknown verbs — "resubmit"/"post"/a typo like "creat_payment" would
 * have bypassed the gate.)
 * @param {string} op action verb, e.g. "read_balance", "create_payment_entry"
 * @returns {string} one of RISK_LEVELS
 */
const KNOWN_READ_OPS = Object.freeze(new Set([
  "read_balance",
  "read_open_invoices",
  "read_payment_history",
  "read_stock_balance",
  "read_supplier", // B1 — the supplier READ resolver
]));

export function riskFor(op) {
  const key = String(op ?? "").toLowerCase();
  if (KNOWN_READ_OPS.has(key)) return RISK_LEVELS.READ;
  // WRITE verbs — the Phase 7 surface. Mapped now so the schema is complete.
  if (/(^|_)(delete|remove|cancel|amend)(_|$)/.test(key)) return RISK_LEVELS.CRITICAL;
  if (/(^|_)(create|submit|update|set_value|adjust|write|pay|insert|apply|post|allocate|reconcile)(_|$)/.test(key)) {
    return RISK_LEVELS.HIGH;
  }
  throw new Error(
    `RISK_UNKNOWN: no risk mapping for action "${op}" — add it to risk-levels.mjs explicitly (fail-closed)`,
  );
}
