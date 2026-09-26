/**
 * C2 (`plan3` Trụ C §6.1/§6.3) — SLOTS: what a reading appears to say, shown to
 * the user for correction BEFORE anything becomes a proposal.
 *
 * Why this module exists at all, in one measured fact: a photo has no imperative
 * verb. On the real path (Phase 1 normalize + routeIntent, measured 2026-09-20)
 * "HÓA ĐƠN BÁN HÀNG …" → `invoice.lookup` and "PHIẾU THU …" → `payment.history`
 * — every invoice-shaped reading lands on a READ, so a photo can never become a
 * proposal by itself. Two consequences shape this file:
 *
 *  1. The DOCUMENT KIND is chosen by the user (a visible tap on the sheet), and
 *     the mapping kind → capability lives in the contract
 *     (`ocr_policy.document_kinds`), never in the client. The client sends a
 *     WORD ("sales"), never a capability id.
 *  2. The slots are produced by the SAME steps the real proposal uses —
 *     `matchItemsByText` → `selectNonOverlappingItems` → `pairLines` — so the
 *     form shows exactly what the builder would build. A second extractor would
 *     drift from the builder and the user would be confirming one thing while
 *     the document says another.
 *
 * What this module CANNOT do: nothing here writes, builds a proposal, or reads
 * a price. It answers one question — "what did that photo seem to say?" — and
 * the answer is editable text, not a document.
 */

import { getCapability, ocrDocumentKinds, ocrPolicy } from "../capability-contract.mjs";
import { OCR_STATUSES } from "./ocr-provider.mjs";
import { pickerForRowsByText } from "../entity-resolution.mjs";
// The builder's OWN parse steps, imported from line-parse (the pure single home
// both consumers share) — C0's static guard rightly forbids the OCR layer from
// importing the write-skill MODULE (an import would hand it the whole executor
// surface), so form and builder share this file instead and cannot drift.
import { orderItemsInText, pairLinesPure } from "../line-parse.mjs";

/** Refusal codes this module can raise (mapped to HTTP by http-ask.mjs). */
export const OCR_SLOTS_CODES = Object.freeze({
  READ_UNVERIFIED: "OCR_READ_UNVERIFIED",
  READ_UNUSABLE: "OCR_READ_UNUSABLE",
  READ_IS_MOCK: "OCR_READ_IS_MOCK",
  READ_LOW_CONFIDENCE: "OCR_READ_LOW_CONFIDENCE",
  READ_TOO_LONG: "OCR_READ_TOO_LONG",
  KIND_UNKNOWN: "OCR_KIND_UNKNOWN",
  SLOTS_EMPTY: "OCR_SLOTS_EMPTY",
});

/**
 * The length the reading may carry, RE-ENFORCED here.
 *
 * Why the route needs its own check when `prepareOcrText` already bounds the
 * text produced by `/ocr`: the slots route accepts text that TRAVELLED VIA THE
 * CLIENT, and nothing on that trip enforces the policy — the C0 bound lives in
 * the seam that PRODUCES a reading, not on every consumer of one. A caller (or
 * a buggy/compromised client) posting a near-1 MB string would push it into
 * NLP, the item matcher and the party resolver (whose candidate generation is
 * quadratic in the number of words) on every request. Fail with the caller's
 * error (400) — the input is wrong, exactly like an unknown kind.
 *
 * @param {unknown} text
 * @param {{policy?: object}} [opts]
 * @returns {string} the text, verified within the policy bound
 */
export function assertSlotsText(text, { policy = ocrPolicy() } = {}) {
  const value = typeof text === "string" ? text : "";
  if (value.length > policy.max_text_length) {
    throw new OcrSlotsError(
      OCR_SLOTS_CODES.READ_TOO_LONG,
      `bản đọc dài ${value.length} ký tự, vượt trần ${policy.max_text_length} của ocr_policy — chụp lại khu vực cần lập chứng từ`,
    );
  }
  return value;
}

export class OcrSlotsError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "OcrSlotsError";
    this.code = code;
  }
}

/**
 * The contract entry for a kind the user picked.
 *
 * Throws for anything the contract does not declare — including a capability id
 * sent by a client (this takes a KIND, and an id is simply not a kind).
 *
 * @param {string} kind
 * @returns {{capability:string, party:string, label:string}}
 */
export function kindSpec(kind) {
  const wanted = String(kind ?? "").trim();
  const spec = ocrDocumentKinds()[wanted];
  if (!spec) {
    const known = Object.keys(ocrDocumentKinds()).join(", ");
    throw new OcrSlotsError(
      OCR_SLOTS_CODES.KIND_UNKNOWN,
      `loại chứng từ "${wanted}" không có trong hợp đồng (chỉ nhận: ${known})`,
    );
  }
  return spec;
}

/**
 * The provenance gate: only a CONFIDENT, REAL reading may seed a proposal.
 *
 * Fail-closed in four ways, and each one is a different lie it prevents:
 *  * an unrecognised status is not a reading (`OCR_READ_UNVERIFIED`);
 *  * `LOW_CONFIDENCE` / `NO_TEXT` mean the policy says ask again
 *    (`OCR_READ_UNUSABLE`) — C0's rule, applied before a form is even offered;
 *  * a MOCK reading is a fixture, and a form built from it would put invented
 *    goods in front of the shop owner (`OCR_READ_IS_MOCK`);
 *  * an unknown or too-low confidence is refused (`OCR_READ_LOW_CONFIDENCE`):
 *    "the reader could not say how sure it was" is not permission.
 *
 * HONEST LIMIT — this is a SAFETY DEFAULT, not a security boundary: the
 * provenance travels with the request, so a caller determined to lie can claim a
 * confident read. What it cannot do is get a document written: the text still
 * goes to `/ask`, and every write still needs human confirmation through the
 * Safety Gateway. The gate exists so an ordinary client (and a deployment left
 * on the mock provider) cannot seed a proposal by accident.
 *
 * @param {{status?:string, confidence?:number|null, mock?:boolean}} [provenance]
 */
export function assertSlotsProvenance(provenance = {}, { policy = ocrPolicy() } = {}) {
  const status = String(provenance?.status ?? "");
  if (!OCR_STATUSES.includes(status)) {
    throw new OcrSlotsError(
      OCR_SLOTS_CODES.READ_UNVERIFIED,
      "kết quả đọc ảnh không rõ trạng thái — không dựng đề xuất từ nó",
    );
  }
  if (status !== "OK") {
    throw new OcrSlotsError(
      OCR_SLOTS_CODES.READ_UNUSABLE,
      `ảnh đọc ở trạng thái ${status} — chụp lại rõ hơn hoặc nhập tay, không dựng đề xuất`,
    );
  }
  if (provenance?.mock === true) {
    throw new OcrSlotsError(
      OCR_SLOTS_CODES.READ_IS_MOCK,
      "bản đọc này là bản THỬ của máy chủ (mock) — không dựng đề xuất từ dữ liệu mô phỏng",
    );
  }
  const confidence = provenance?.confidence;
  if (typeof confidence !== "number" || !Number.isFinite(confidence)) {
    throw new OcrSlotsError(
      OCR_SLOTS_CODES.READ_LOW_CONFIDENCE,
      "máy đọc không báo độ tin cậy — không dựng đề xuất từ bản đọc không kiểm chứng được",
    );
  }
  if (confidence < policy.min_confidence) {
    throw new OcrSlotsError(
      OCR_SLOTS_CODES.READ_LOW_CONFIDENCE,
      `độ tin cậy ${Math.round(confidence * 100)}% dưới mức ${Math.round(policy.min_confidence * 100)}% — không dựng đề xuất`,
    );
  }
  return { status, confidence, min_confidence: policy.min_confidence };
}

/**
 * The refusal codes of ONE capability, derived from its own taxonomy.
 *
 * `pairLines` reports `<PREFIX>QTY_MISSING` / `<PREFIX>QTY_AMBIGUOUS`, and each
 * contract entry declares the codes its own path can emit (B1 lesson). So the
 * prefix is READ from the contract instead of hardcoded per kind: a form whose
 * problems carry the capability's own vocabulary can be compared with what the
 * builder refuses later, and cannot drift from it.
 */
function qtyCodePrefix(capabilityId) {
  const cap = getCapability(capabilityId);
  const found = (cap?.errors ?? []).find((code) => code.endsWith("QTY_MISSING"));
  return found ? found.slice(0, found.length - "QTY_MISSING".length) : "";
}

/** The master-data accessors each kind's party lives under. */
const PARTY_ACCESSORS = Object.freeze({
  customer: { idOf: (row) => row?.name ?? null, nameOf: (row) => row?.customer_name ?? row?.name ?? null },
  supplier: { idOf: (row) => row?.name ?? null, nameOf: (row) => row?.supplier_name ?? row?.name ?? null },
});

/**
 * Party resolution for a PHOTO — deliberately stricter than the chat path.
 *
 * The typed path reuses [resolveEntityByText] as-is; here two photo-specific
 * failure modes had to be handled first (both reproduced from the mock data
 * before being fixed):
 *
 *  1. A TRUNCATED name ("Lan" for "Nguyễn Thị Lan") matched exactly one row by
 *     substring and was ABOUT to be auto-picked. A photo is a lossy read, so a
 *     partial name is evidence, not identity: it becomes candidates for the user
 *     to choose from, and the pipeline still re-resolves the name when the
 *     corrected sentence is sent (that picker is unchanged).
 *  2. A name followed by a DIGIT ("Hà Tiên 20 Bao") absorbed the digit into the
 *     name and matched the wrong stored row ("Hà Tiên 2"). Matching is therefore
 *     done with word boundaries, not raw substring.
 *
 * What still auto-picks: a FULL stored name or id appearing word-bounded in the
 * text, uniquely. That is the same confidence the chat path requires, just
 * verified with the boundary fix.
 *
 * @param {object[]} rows
 * @param {string} text
 * @param {{idOf:Function, nameOf:Function}} accessors
 * @returns {{entity:object|null, ambiguous:boolean, candidates:string[]}}
 */
export function resolvePartyFromPhoto(rows, text, { idOf, nameOf }) {
  const norm = (s) => String(s ?? "").toLowerCase().trim();
  const hay = norm(text);
  const wordBounded = (needle, haystack) => {
    if (!needle) return false;
    const re = new RegExp(`(^|\\W)${needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\W|$)`);
    return re.test(haystack);
  };
  const list = rows ?? [];

  // Pass 1 — a FULL stored name or id, word-bounded, is identity.
  const exact = list.filter(
    (row) =>
      (wordBounded(norm(nameOf(row)), hay) && norm(nameOf(row)).length >= 2) ||
      (wordBounded(norm(idOf(row)), hay) && norm(idOf(row)).length >= 2),
  );
  if (exact.length === 1) return { entity: exact[0], ambiguous: false, candidates: [] };
  if (exact.length > 1) {
    // Genuinely twin full names ⇒ ambiguous (same stance as the chat path).
    const longest = Math.max(...exact.map((r) => norm(nameOf(r)).length));
    const atLongest = exact.filter((r) => norm(nameOf(r)).length === longest);
    if (atLongest.length === 1) return { entity: atLongest[0], ambiguous: false, candidates: [] };
    return { entity: null, ambiguous: true, candidates: atLongest.map((r) => nameOf(r)).slice(0, 5) };
  }

  // Pass 2 — PARTIAL names: a stored row whose name appears in the text the
  // other way round (stored name CONTAINS a run of words from the text). Every
  // hit is offered; nothing is picked.
  const words = hay.split(/\s+/).filter((w) => w.length >= 2);
  const runs = [];
  for (let start = 0; start < words.length; start++) {
    for (let len = Math.min(words.length - start, 6); len >= 1; len--) {
      runs.push(words.slice(start, start + len).join(" "));
    }
  }
  const partial = [];
  for (const row of list) {
    const name = norm(nameOf(row));
    if (!name || name.length < 2) continue;
    if (runs.some((run) => name.includes(run) && wordBounded(run, name)) && !partial.includes(row)) {
      partial.push(row);
    }
  }
  if (partial.length >= 1) {
    return { entity: null, ambiguous: false, candidates: partial.map((r) => nameOf(r)).slice(0, 5) };
  }
  return { entity: null, ambiguous: false, candidates: [] };
}

/**
 * What the reading appears to say, as editable slots.
 *
 * Pure: every read is injected, so this is testable without ERPNext, without
 * NLP and without a photo. Order matters and mirrors the builder exactly:
 * item candidates → drop quantities that are part of an item's own name (B1
 * lesson: "Cám gà thịt 25kg" is packaging, not an order of 25) → pair each item
 * with the quantity Vietnamese word order gives it.
 *
 * @param {object} input
 * @param {string} input.text      the sanitised reading (already normalized)
 * @param {object} input.spec      contract entry from [kindSpec]
 * @param {object|null} [input.nlp] Python normalizer output (quantities carry offsets)
 * @param {object[]} [input.items] Item rows from ERPNext
 * @param {object[]} [input.parties] Customer/Supplier rows for this kind
 * @returns {object} slots for the form (never a proposal)
 */
export function extractSlots({ text, spec, nlp = null, items = [], parties = [] }) {
  const normalized = String(nlp?.text ?? text ?? "");
  const accessors = PARTY_ACCESSORS[spec.party];

  const namedItems = orderItemsInText(items, normalized);
  const { lines: paired, problems } = pairLinesPure({
    matched: namedItems,
    quantities: Array.isArray(nlp?.quantities) ? nlp.quantities : [],
    codePrefix: qtyCodePrefix(spec.capability),
  });

  const resolution = resolvePartyFromPhoto(parties, normalized, accessors);
  // Candidates shown on the form: the resolver's own partial-name offers first,
  // then the picker's substring search over the whole reading — either way the
  // USER picks, nothing is ever auto-filled from a partial match.
  const picker = resolution.entity
    ? []
    : resolution.candidates.length > 0
      ? resolution.candidates.map((name) => ({ name }))
      : pickerForRowsByText(parties, [normalized], { ...accessors, limit: 5 });

  const lines = paired.map(({ item, quantity }) => ({
    item_code: item?.name ?? null,
    item_name: item?.item_name ?? item?.name ?? null,
    stock_uom: item?.stock_uom ?? null,
    qty: Number(quantity?.value),
    uom: quantity?.canonical_unit ?? null,
    // The raw text the number came from — the user is correcting a PHOTO, so
    // they must be able to see which words produced the number.
    raw_quantity: quantity?.raw ?? null,
  }));

  const warnings = problems.map((p) => ({ code: p.code, reason: p.reason }));
  if (resolution.ambiguous) {
    warnings.push({
      code: spec.party === "supplier" ? "AMBIGUOUS_SUPPLIER" : "AMBIGUOUS_CUSTOMER",
      reason: `tên ${spec.party === "supplier" ? "nhà cung cấp" : "khách"} trên ảnh khớp nhiều hồ sơ — chọn đúng người`,
    });
  } else if (!resolution.entity) {
    warnings.push({
      code: spec.party === "supplier" ? "SUPPLIER_NOT_FOUND" : "CUSTOMER_NOT_FOUND",
      reason: `chưa thấy tên ${spec.party === "supplier" ? "nhà cung cấp" : "khách"} trong ảnh — điền tay hoặc chụp lại`,
    });
  }
  if (namedItems.length === 0) {
    warnings.push({
      code: spec.capability === "purchase_order.create" ? "PO_ITEM_UNRESOLVED" : "SO_ITEM_UNRESOLVED",
      reason: "chưa nhận ra mặt hàng nào trên ảnh — điền tay hoặc chụp lại",
    });
  }

  return {
    kind: spec.capability === "purchase_order.create" ? "purchase" : "sales",
    capability: spec.capability,
    label: spec.label,
    text: normalized,
    party: {
      role: spec.party,
      resolved: resolution.entity
        ? { id: accessors.idOf(resolution.entity), name: accessors.nameOf(resolution.entity) }
        : null,
      ambiguous: resolution.ambiguous === true,
      candidates: picker,
    },
    lines,
    // Money read off the photo is DISPLAY ONLY: a rate never comes from an
    // utterance (B2/B4 `rate_source: erpnext`), so this number is a hint the
    // user can compare against the price ERPNext will actually charge.
    money_vnd: Number.isFinite(Number(nlp?.amount)) ? Number(nlp.amount) : null,
    warnings,
    // "nothing usable was read" is a REFUSAL the UI can act on (fall back to
    // manual entry) rather than an empty form that looks like a bug.
    empty: lines.length === 0 && !resolution.entity,
  };
}

/**
 * Turn slots into the text that goes down the ONE existing pipeline.
 *
 * Not used by the server: the client composes (see `ocr_compose.dart`) because
 * the user must SEE the sentence before it is sent, and the composed sentence is
 * what appears in the chat. This helper exists so server-side tests can prove
 * that the shape the client composes routes where the contract says it must —
 * the tripwire in `test/c2-ocr-proposal.test.mjs` reads the client's own
 * templates rather than a copy of them.
 *
 * @param {{kind:string, party?:string|null, lines?:object[]}} slots
 * @returns {string}
 */
export function composeQuestion({ kind, party = null, lines = [] }) {
  const goods = lines
    .filter((l) => l?.qty != null)
    .map((l) => `${l.qty} ${l.uom ?? ""} ${l.item_name ?? ""}`.trim())
    .join(" + ");
  if (kind === "purchase") {
    return `đặt mua ${goods}${party ? ` từ ${party}` : ""}`.trim();
  }
  return `đặt hàng cho ${party ?? ""} ${goods}`.replace(/\s+/g, " ").trim();
}
