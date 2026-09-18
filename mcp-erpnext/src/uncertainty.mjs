/**
 * Uncertainty taxonomy (plan2_final §12, P2 deliverable 1).
 *
 * The pipeline ALREADY refuses for many different reasons; before P2 those
 * refusals were scattered raw strings the client could only display. This
 * module gives every "I am not sure / I cannot" answer a CANONICAL code plus
 * the Vietnamese sentence to show for it, so the UI can react per kind
 * (picker, retry, ask-the-boss) instead of pattern-matching prose.
 *
 * Every code here is a REFUSAL state the server sent on purpose — the module
 * never invents a code for a happy path.
 */

/** Canonical codes (plan2_final §12 taxonomy). Frozen: no near-duplicates. */
export const UNCERTAINTY_CODES = Object.freeze({
  UNKNOWN_INTENT: "UNKNOWN_INTENT",
  KNOWN_INTENT_UNIMPLEMENTED: "KNOWN_INTENT_UNIMPLEMENTED",
  MISSING_ENTITY: "MISSING_ENTITY",
  AMBIGUOUS_ENTITY: "AMBIGUOUS_ENTITY",
  ENTITY_PICK_REQUIRED: "ENTITY_PICK_REQUIRED",
  LOW_CONFIDENCE: "LOW_CONFIDENCE",
  AUTHORIZATION_DENIED: "AUTHORIZATION_DENIED",
  DSH_WRITE_BLOCKED: "DSH_WRITE_BLOCKED",
  BUSINESS_VALIDATION_FAILED: "BUSINESS_VALIDATION_FAILED",
  NLP_UNAVAILABLE: "NLP_UNAVAILABLE",
  ERP_UNAVAILABLE: "ERP_UNAVAILABLE",
  SYSTEM_MAINTENANCE: "SYSTEM_MAINTENANCE",
});

/** Vietnamese copy shown verbatim by the client (Vietnamese-first product). */
const COPY = Object.freeze({
  [UNCERTAINTY_CODES.UNKNOWN_INTENT]:
    "Mình chưa hiểu câu này. Hãy hỏi về công nợ, hóa đơn, phiếu thu hoặc tồn kho của một khách hàng cụ thể.",
  [UNCERTAINTY_CODES.KNOWN_INTENT_UNIMPLEMENTED]:
    "Hiểu yêu cầu nhưng tính năng này chưa có — đã ghi nhận để bổ sung sau.",
  [UNCERTAINTY_CODES.MISSING_ENTITY]:
    "Chưa rõ đối tượng. Hãy nêu tên khách hàng (vd: \"công nợ của chị Lan\").",
  [UNCERTAINTY_CODES.AMBIGUOUS_ENTITY]:
    "Tên khớp nhiều kết quả — hãy chọn đúng khách trong danh sách hoặc nói rõ tên đầy đủ.",
  [UNCERTAINTY_CODES.ENTITY_PICK_REQUIRED]:
    "Ghi phiếu thu cần chọn ĐÚNG khách trước (không đoán tên gần đúng).",
  [UNCERTAINTY_CODES.LOW_CONFIDENCE]:
    "Mình chưa chắc đã hiểu đúng — hãy nói lại rõ hơn.",
  [UNCERTAINTY_CODES.AUTHORIZATION_DENIED]:
    "Tài khoản hiện không có quyền cho thao tác này.",
  [UNCERTAINTY_CODES.DSH_WRITE_BLOCKED]:
    "Chế độ Phân tích bằng AI chỉ ĐỌC — ghi phiếu thu phải qua mục chat chính và cần bạn bấm Xác nhận.",
  [UNCERTAINTY_CODES.BUSINESS_VALIDATION_FAILED]:
    "Dữ liệu không cho phép thao tác này (chứng từ đã tất toán hoặc số tiền không hợp lệ).",
  [UNCERTAINTY_CODES.NLP_UNAVAILABLE]:
    "Dịch vụ chuẩn hoá tiếng Việt đang không phản hồi — không đề xuất ghi gì để tránh sai số tiền. Thử lại sau.",
  [UNCERTAINTY_CODES.ERP_UNAVAILABLE]:
    "ERPNext đang không phản hồi — thử lại sau ít phút.",
  [UNCERTAINTY_CODES.SYSTEM_MAINTENANCE]:
    "Hệ thống đang bảo trì (chế độ chỉ đọc) — thao tác ghi tạm tắt.",
});

/** Copy is mandatory for every code — a refusal without words is a dead end. */
for (const code of Object.keys(UNCERTAINTY_CODES)) {
  if (!COPY[code]) throw new Error(`UNCERTAINTY_COPY_MISSING: ${code}`);
}

/**
 * Full copy object for a code: { code, message } — the server attaches this to
 * refusals (client renders `message` verbatim and can switch on `code`).
 *
 * @param {string} code one of UNCERTAINTY_CODES
 * @param {{detail?:string}} [opts]
 * @returns {{code:string, message:string, detail:string|null}|null} null for an
 *          unknown code — callers must NOT fabricate a taxonomy code
 */
export function uncertaintyCopy(code, opts = {}) {
  if (!Object.values(UNCERTAINTY_CODES).includes(code)) return null;
  return { code, message: COPY[code], detail: opts.detail ?? null };
}

/**
 * Map a raw pipeline error onto the canonical taxonomy.
 * Explicit list, ends with null (unknown stays unknown — no guessing).
 *
 * - INSUFFICIENT_PERMISSION (contract) is a genuine authorization refusal —
 *   AUTHORIZATION_DENIED. 401/403 at the HTTP edge are transport, not
 *   taxonomy: they are the server's own JSON, sent before any pipeline ran.
 * - COMPANY_SCOPE_REQUIRED (P8) keeps its own code in the log and the HTTP body
 *   so an operator can tell "this deployment never pinned COPILOT_COMPANY"
 *   apart from "this account lacks Accounts User" — but to the USER both are
 *   the same answer, so it collapses to AUTHORIZATION_DENIED and never reaches
 *   the screen as a bare code with no words.
 * - every `PAYMENT_*` builder refusal is a business rule: the customer/invoice
 *   exist but this payment would be wrong (settled, not receivable, bad
 *   amount, account/mode unresolvable).
 * - the picker/refusal codes from P1 (ENTITY_PICK_REQUIRED / AMBIGUOUS /
 *   MISSING / NLP_UNAVAILABLE / SYSTEM_MAINTENANCE) already ARE taxonomy codes.
 *
 * @param {string|null} code raw error code from the pipeline
 * @returns {string|null} canonical UNCERTAINTY_CODES value, or null
 */
export function toUncertaintyCode(code) {
  const c = String(code ?? "");
  if (Object.values(UNCERTAINTY_CODES).includes(c)) return c;
  if (c === "INSUFFICIENT_PERMISSION") return UNCERTAINTY_CODES.AUTHORIZATION_DENIED;
  if (c === "COMPANY_SCOPE_REQUIRED") return UNCERTAINTY_CODES.AUTHORIZATION_DENIED;
  if (c.startsWith("PAYMENT_")) return UNCERTAINTY_CODES.BUSINESS_VALIDATION_FAILED;
  if (c === "ENTITY_NOT_FOUND_BLOCKED") return UNCERTAINTY_CODES.MISSING_ENTITY;
  return null;
}
