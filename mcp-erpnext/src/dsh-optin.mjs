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

import { getCapability, isForbidden, listCapabilities } from "./capability-contract.mjs";

/**
 * The route groups whose capabilities are WRITE — derived from the contract,
 * never a list maintained here (B2: sales_order.create joined payment.create
 * without this file having to be told).
 */
const WRITE_ROUTE_GROUPS = new Set(
  listCapabilities()
    .filter((id) => isForbidden(id) === false && getCapability(id)?.type === "WRITE")
    .map((id) => getCapability(id).route_group),
);

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
  // B2: every WRITE group, derived from the contract rather than naming
  // payment_write. A second WRITE (sales_order.create) therefore inherits the
  // opt-in block WITHOUT an edit here — the failure mode to avoid is a new write
  // capability that silently becomes reachable from the read-only AI mode.
  // The group is matched as well as the capability id: the route shape is not
  // required to carry a capability (and tests pin that older shape).
  if (route.capability && getCapability(route.capability)?.type === "WRITE") return true;
  return WRITE_ROUTE_GROUPS.has(route.group);
}

/**
 * A0/A1 — the capabilities whose question, asked in AI mode, is HANDED OFF to the
 * deterministic pipeline instead of being refused (plan_final §2/§3.1:
 * `POST /dsh/ask → routeIntent → WRITE? → answerQuestion() // cùng /ask`).
 *
 * A LIST OF CAPABILITY IDS, one at a time, on purpose. `WRITE_ROUTE_GROUPS`
 * above is DERIVED from the contract so a new write inherits the opt-in BLOCK —
 * that is the safe direction (more restricted by default). Reachability FROM AI
 * mode must work the other way round: a capability becomes handoff-able only by
 * being named here, never by looking write-shaped, or a new write capability
 * could grow a route out of the read-only mode without anyone deciding it.
 *
 * A1 (plan_final §3.2–§3.3): EVERY WIRED write joins — each one below already
 * has its own entity-resolution + slot + proposal path inside `answerQuestion`,
 * so the handoff gives AI mode the SAME card the ordinary chat builds, with the
 * SAME guards (picker on >1 match, MISSING_ENTITY on 0 match, slot
 * clarification on missing amount/item/qty). Per id, why it is safe to hand off:
 *   - payment.create       — A0; the receipt/payment card, amount explicit-only.
 *   - sales_order.create   — B2; order card, prices read from ERPNext Item Price.
 *   - quotation.create     — B3; same line-document shape as the order.
 *   - purchase_order.create— B4; supplier party, buying price, source-document.
 *   - delivery.create      — P9-A2; lines come from a SUBMITTED order, never invented.
 *   - purchase_receipt.create — P9-B; lines come from a SUBMITTED PO.
 *   - sales_invoice.create — P9-D; lines+prices from a SUBMITTED order.
 *   - sales_return.create  — P9-F; entity is the ORIGINAL invoice, read verbatim.
 *   - stock.adjustment     — P9-E; item+qty+warehouse, nothing priced.
 *   - customer.create      — M1; master-data create, duplicate pre-check is the
 *                            entity resolution (no picker by design).
 * `document.delete` is deliberately ABSENT: the contract marks it FORBIDDEN
 * (FORBIDDEN_IN_AI_PATH) and the pipeline refuses it before any builder runs —
 * it can never be handed off without a contract change first.
 * A FUTURE write capability: wire its `answerQuestion` branch FIRST, then add
 * its id here explicitly — inheriting the handoff from being write-shaped is
 * the failure mode this list exists to prevent.
 *
 * Read by the GATEWAY only (dsh-gateway.mjs). The in-child gate below keeps
 * refusing every WRITE — the handoff chooses a different route for the question,
 * it never loosens the runtime's own gate.
 */
export const DSH_WRITE_HANDOFF_CAPABILITIES = new Set([
  "payment.create",
  "sales_order.create",
  "quotation.create",
  "purchase_order.create",
  "delivery.create",
  "purchase_receipt.create",
  "sales_invoice.create",
  "sales_return.create",
  "stock.adjustment",
  "customer.create",
]);

/**
 * True when AI mode must HAND OFF this route to the deterministic pipeline
 * rather than refuse it. The value is the capability that was handed off
 * (falsy = not a handoff), so a caller can report exactly WHAT it handed over
 * instead of a bare boolean.
 *
 * Keyed on the CAPABILITY ID only, never on the route group. Matching a group
 * would be a wider net than what was decided here (one group can hold several
 * capabilities), and `routeIntent` always resolves an id — its single return
 * shape sets `capability: hit.id` — so a group-only route is not a shape this
 * code can ever be handed. It was written, measured against the router, and
 * removed; if the router ever grows a group-only route, the id check fails
 * CLOSED (no handoff), which is the direction AI mode must break in.
 */
export function dshWriteHandoffFor(route) {
  if (!route || route.forbidden) return null;
  if (route.capability && DSH_WRITE_HANDOFF_CAPABILITIES.has(route.capability)) {
    return route.capability;
  }
  return null;
}

export const DSH_WRITE_HANDOFF_CODE = "DSH_WRITE_HANDOFF";

/** The one sentence the gateway/card uses to explain a handoff. */
export function dshWriteHandoffReason() {
  return (
    "câu này là một thao tác GHI — em chuyển sang luồng chat chính để tạo đề xuất "
    + "(chế độ AI không tự ghi sổ), anh/chị vẫn phải bấm Xác nhận"
  );
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
      "chế độ Phân tích bằng AI chỉ ĐỌC — mọi thao tác GHI (phiếu thu, đơn bán) phải qua mục chat chính và cần bạn bấm Xác nhận",
    proposal: null,
  };
}
