/**
 * P5 — DSH explicit opt-in gate (plan2_final §2 D2/D3/D8, §19 P5;
 * phases2/p5-dsh-opt-in-read.md).
 *
 * LAWS (from plan2_final, verbatim):
 *  - D2: "Cấm unknown → DSH auto-fallback" — the deterministic path owns every
 *    /ask question. DSH is NEVER spawned by the pipeline to rescue an unknown.
 *  - D8: "DSH = explicit opt-in advanced runtime" — DSH runs only when the
 *    user actively chooses "Phân tích bằng AI" (or an allowed advanced-READ
 *    flow). When dsh runs, it reaches ERPNext ONLY through this copilot's
 *    skill layer (copilot_ask), never raw MCP mutation.
 *  - D3: no runtime bypasses the Skill/Safety Gateway. In P5 dsh may drive
 *    READ capabilities only; a WRITE proposal produced from a dsh-driven ask
 *    is refused BEFORE it is built (fail closed, not "executed with a warning").
 *
 * IMPLEMENTATION (one seam, probed): dsh starts this copilot as an MCP stdio
 * child with COPILOT_DSH_CONTEXT=1 in the env (see dsh.cordis.patch.yml).
 * The /ask HTTP server never sets it, so:
 *   - /ask      → context off → full behavior (READ answers + WRITE proposals
 *                 through the Safety Gateway confirm flow) — unchanged.
 *   - dsh child → context on  → any question that would produce an executable
 *                 (WRITE) proposal is refused with DSH_WRITE_BLOCKED instead.
 * There is deliberately NO env flag that turns DSH routing on inside /ask:
 * the gate can only make dsh MORE restricted, never the main path less.
 */

/** Env key that marks this copilot process as a dsh-driven (opt-in) child. */
export const DSH_CONTEXT_ENV = "COPILOT_DSH_CONTEXT";

/** True when THIS process was spawned by dsh (explicit opt-in context). */
export function isDshContext(env = process.env) {
  return String(env[DSH_CONTEXT_ENV] ?? "").trim() === "1";
}

/**
 * P5 gate for a dsh-driven ask: block anything whose proposal would be
 * executable (risk above READ). Called by copilot_ask AFTER routing, BEFORE
 * the skill factory runs — a blocked question never touches ERPNext.
 *
 * @param {object|null} route the routed capability (routeByCapability/routeIntent shape)
 * @returns {boolean} true when this question must be refused in dsh context
 */
export function blockedInDshContext(route) {
  if (!route) return false; // unrouted → UNKNOWN_INTENT path, not a dsh issue
  if (route.forbidden) return false; // already refused by the pipeline anyway
  return route.group === "payment_write"; // the only WRITE group today (Phase 7b)
}

export const DSH_WRITE_BLOCKED_CODE = "DSH_WRITE_BLOCKED";

/** The refusal answer for a blocked dsh WRITE question (P2 copy shape). */
export function dshWriteBlockedAnswer(rawText) {
  return {
    question: rawText,
    normalized: null,
    routed: null,
    answer: null,
    error_code: DSH_WRITE_BLOCKED_CODE,
    reason:
      "chế độ Phân tích bằng AI chỉ ĐỌC — ghi phiếu thu phải qua mục chat chính và cần bạn bấm Xác nhận",
    proposal: null,
  };
}
