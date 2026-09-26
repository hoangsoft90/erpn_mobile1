/**
 * READ drill-down views (A1, plan3 Trụ A) — the data behind the bubble button.
 *
 * Two responsibilities, both READ-only:
 *
 *  1. `uiIntentForAction()` — the STRUCTURED UI intent attached to a /ask
 *     answer: which screen to open and which entity id to open it for. The
 *     Flutter client maps a screen from this block and never classifies text
 *     itself (A1 deliverable 3: "map màn từ server — không NLP client").
 *  2. `readScreen()` — the fresh ERPNext read behind `POST /read/list`: it
 *     re-validates the entity id against live data and returns a BOUNDED list
 *     (limit declared in the contract, 5–10).
 *
 * Safety rules this file exists to keep:
 *   - No write surface at all. It only imports READ skills; it cannot reach
 *     `/execute`, the Safety Gateway, or a WRITE tool (there is a static test).
 *   - The screen id is looked up in the contract, fail-closed: an undeclared
 *     screen is refused instead of guessed.
 *   - The entity id comes from the CLIENT (it echoes what /ask answered with),
 *     so it is a hint: it must be found in a list just read from ERPNext before
 *     it becomes authoritative. An id that is not there is refused — the same
 *     rule §4.2 applies to the candidate picker.
 *   - Money is never computed here. The balance figure is whatever
 *     `getCustomerBalance()` (the same skill the chat answer uses) returns, so
 *     the screen and the answer cannot drift apart.
 */

import {
  capabilityForAction,
  clampUiLimit,
  getUiScreen,
  listUiScreens,
  uiScreenForCapability,
} from "./capability-contract.mjs";
import { pickFromCandidates } from "./entity-resolution.mjs";
import * as customerSkill from "./skills/customer.mjs";

/** Refusal codes this module can raise (mapped to HTTP by http-ask.mjs). */
export const READ_VIEW_CODES = Object.freeze({
  UNKNOWN_SCREEN: "UNKNOWN_READ_SCREEN",
  MISSING_ENTITY: "MISSING_ENTITY_ID",
  ENTITY_NOT_FOUND: "CUSTOMER_NOT_FOUND",
});

function refuse(code, message) {
  return Object.assign(new Error(message), { code });
}

/**
 * The screen declaration for a proposal action, or null when this action has no
 * drill-down. Contract-driven in both directions: the screen must be declared,
 * and it must list this capability in `offered_by`.
 *
 * @param {object} p
 * @param {string} p.action proposal action, e.g. "read_open_invoices"
 * @param {{id?: string|null, name?: string|null}} p.entity resolved entity
 * @param {unknown} [p.limit] page size the answer suggests (clamped)
 * @returns {object|null} `{screen, title, entity:{kind,id,name}, limit}`
 */
export function uiIntentForAction({ action, entity, limit }) {
  const capabilityId = capabilityForAction(action);
  const hit = uiScreenForCapability(capabilityId);
  if (!hit) return null;
  const id = typeof entity?.id === "string" && entity.id.trim() !== "" ? entity.id.trim() : null;
  // Fail closed: a drill-down is opened BY entity id. Without a resolved id
  // there is nothing to open, so no button is offered (never a button that
  // would have to re-guess the customer on the client).
  if (!id) return null;
  return {
    screen: hit.id,
    title: hit.screen.title,
    entity: {
      kind: hit.screen.entity,
      id,
      name: entity?.name ?? null,
    },
    limit: clampUiLimit(hit.screen, limit),
  };
}

/**
 * Look up a screen id from the contract, fail-closed.
 * @param {unknown} screenId
 * @returns {object} frozen screen definition
 */
export function resolveReadScreen(screenId) {
  if (typeof screenId !== "string" || screenId.trim() === "") {
    throw refuse(READ_VIEW_CODES.UNKNOWN_SCREEN, "thiếu mã màn hình (screen)");
  }
  const screen = getUiScreen(screenId);
  if (!screen) {
    throw refuse(
      READ_VIEW_CODES.UNKNOWN_SCREEN,
      `màn hình "${screenId}" không có trong hợp đồng capability — không mở được (chỉ những màn đã khai báo mới đọc được dữ liệu)`,
    );
  }
  return { id: String(screenId).trim(), screen };
}

/** Screen ids the contract declares (for docs/tests, not for the client). */
export function declaredScreenIds() {
  return Object.keys(listUiScreens());
}

/**
 * Fresh, bounded READ behind the drill-down.
 *
 * @param {object} p
 * @param {object} p.mcp           MCP client (real or mock)
 * @param {Set<string>} [p.knownIds] ids already seen from tool results
 * @param {string} p.screenId      declared screen id
 * @param {string} p.entityId      the id /ask answered with (re-validated here)
 * @param {unknown} [p.limit]      requested page size (clamped by the contract)
 * @param {string|null} [p.erpTarget] `"REAL"`/`"MOCK"`, from `erpTargetLabel(env)` —
 *   travels with the numbers for the same reason it does on the day summary
 *   (§2.1: a payload whose source cannot be named must not be rendered as the
 *   shop's figures). Computed by the ROUTE, so this module keeps importing only
 *   READ skills.
 * @returns {Promise<object>} the screen payload for the client
 */
export async function readScreen({ mcp, knownIds = new Set(), screenId, entityId, limit, erpTarget = null }) {
  const { id, screen } = resolveReadScreen(screenId);
  if (screen.entity !== "customer") {
    // The contract is the only place that decides what a screen needs; today
    // every screen is customer-bound. Refuse rather than guess a resolver.
    throw refuse(READ_VIEW_CODES.UNKNOWN_SCREEN, `màn hình "${id}" cần entity "${screen.entity}" chưa được hỗ trợ`);
  }
  if (typeof entityId !== "string" || entityId.trim() === "") {
    throw refuse(READ_VIEW_CODES.MISSING_ENTITY, "thiếu id khách hàng (entity_id) — mở lại từ câu trả lời trong chat");
  }

  // ── Trust boundary: the id is a HINT from the client. It only becomes
  // authoritative if it is in the list just read from ERPNext (§4.2).
  const all = (await customerSkill.findCustomer(mcp, "", knownIds)).data?.data ?? [];
  const picked = pickFromCandidates(all, entityId);
  if (!picked.ok) {
    throw refuse(
      READ_VIEW_CODES.ENTITY_NOT_FOUND,
      `không xác định được khách "${entityId}" từ dữ liệu ERPNext — đóng màn và hỏi lại trong chat`,
    );
  }
  const customerId = String(picked.customer.name);
  const customerName = picked.customer.customer_name ?? customerId;

  // One bounded read of the documents + the balance from the SAME skill the
  // chat answer uses (money is copied, never recomputed here).
  const invoices = await customerSkill.listUnpaidInvoices(mcp, customerId, knownIds);
  const balance = await customerSkill.getCustomerBalance(mcp, customerId, knownIds);
  const rows = invoices.data?.data ?? [];
  const pageSize = clampUiLimit(screen, limit);
  const shown = rows.slice(0, pageSize);

  return {
    screen: id,
    title: screen.title,
    entity: { kind: screen.entity, id: customerId, name: customerName },
    limit: pageSize,
    // Same provenance field as `/read/drill` and `/read/daily-summary`.
    erp_target: erpTarget,
    generated_at: new Date().toISOString(),
    summary: {
      outstanding_vnd: Number(balance.data?.outstanding_vnd) || 0,
      // Kept next to the list on purpose: the count the user sees ("hiện 5/7")
      // and the count in the summary line come from the same array.
      open_documents: rows.length,
    },
    total_documents: rows.length,
    truncated: rows.length > pageSize,
    rows: shown.map((r) => ({
      name: r.name ?? null,
      date: r.posting_date ?? null,
      outstanding_vnd: Number(r.outstanding_amount) || 0,
      total_vnd: Number(r.grand_total) || 0,
      is_return: r.is_return === 1 || r.is_return === true,
    })),
  };
}
