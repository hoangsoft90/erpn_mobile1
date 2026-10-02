/**
 * BUSINESS DOCUMENT IDENTITY (next3 workstream B) — the dedup layer keyed on the
 * REAL-WORLD document instead of on the command that carried it.
 *
 * Why a second layer exists at all, given `business-dedup.mjs`:
 *
 *   `business-dedup.mjs` answers "did the user just INTEND this again?" — its
 *   fingerprint is (party + intent + capability + a 15-minute bucket) and its
 *   action is `warn_extra_confirm`: it warns, it never blocks, and by
 *   construction it cannot see tomorrow. That is right for "anh Tuấn trả 5 triệu"
 *   said twice. It is the WRONG tool for a supplier invoice: the same tờ hóa đơn
 *   re-sent a week later (or after a restart, or as a different sentence) has the
 *   same identity and must produce ONE purchase order, not two.
 *
 *   `custom_ai_action_id` (the correlation field, already on the site) answers a
 *   third question: "was THIS COMMAND confirmed twice?". Two different commands
 *   carrying the same invoice are, by construction, different action ids — which
 *   is exactly the hole this module closes.
 *
 * The key is derived from what the DOCUMENT says about itself:
 *
 *    document kind | party (MST, else resolved ERPNext id) | invoice_no | invoice_date
 *
 * Deliberate choices, each one a decision someone will later want to revisit:
 *
 *  - TAX ID IS PREFERRED over the resolved ERPNext id, because the invoice's own
 *    MST survives a supplier record being renamed or re-created on the site,
 *    while a docname does not. (`party_id` remains a fallback for a channel that
 *    resolved a party but has no MST — a warning path in the file channel.)
 *  - THE SERIES IS NOT PART OF THE KEY, although the XML carries it. A future OCR
 *    reading may not see the series at all; a key that included it would then
 *    MISS a duplicate across channels, and a missed duplicate writes a second
 *    document — the failure this module exists to prevent. The trade-off is the
 *    documented one: two DIFFERENT invoices from the same issuer that share the
 *    number AND the date AND the MST would collide. That combination is not a
 *    legitimate pairing in the HĐĐT numbering rules (a number is unique per
 *    issuer per series, and a re-issue keeps its number with a new date/status).
 *  - THE NUMBER IS COMPARED EXACTLY — never zero-stripped, never "cleaned". A
 *    character outside a strict allowlist makes the whole identity REFUSE instead
 *    of being normalised away: silently dropping a separator would merge two
 *    different invoice numbers into one key, and the resulting refusal would name
 *    the wrong document to a user who has no way to see why.
 *  - NO MONEY IS PART OF THE KEY. Totals read from a file are display-only on
 *    every path in this project (`rate_source: erpnext`); an identity that moved
 *    when a price was corrected would silently stop matching.
 *
 * CHANGING THE COMPOSITION IS A MIGRATION, not a refactor: keys already stored in
 * `custom_business_doc_key` on the site were computed by this function, so an
 * edit here makes every existing document unmatchable (and the next send of that
 * invoice would create a duplicate). Bump nothing silently — see
 * `.plan/next4/B-dedupe-result.md`.
 */

import { createHash } from "node:crypto";

/** The code the `/ask` boundary refuses an unusable identity with. */
export const SOURCE_DOCUMENT_CODE = "SOURCE_DOCUMENT_INVALID";

/**
 * The ERPNext-side field, used when the capability contract does not declare one.
 * Read through the contract everywhere it matters (`businessDocKeyField`), so the
 * migration script and the executor cannot disagree about the column name.
 */
export const DOC_KEY_FIELD_FALLBACK = "custom_business_doc_key";

/** Identifier shapes. An allowlist, never a "strip the weird bits" pass. */
const TAX_ID_RE = /^[0-9A-Za-z]{1,32}$/;
const INVOICE_NO_RE = /^[0-9A-Za-z][0-9A-Za-z._/-]{0,63}$/;
const YMD_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const KIND_RE = /^[a-z][a-z_]{0,31}$/;
/** Controls + line separators: never allowed into anything we store or echo. */
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;

/** Safe display text: control characters removed, length capped. */
export function safeText(raw, max = 120) {
  const s = String(raw ?? "").replace(CONTROL_RE, " ").replace(/\s+/g, " ").trim();
  return s === "" ? null : s.slice(0, max);
}

/**
 * MST → digits+letters, uppercase. Separators are FORMATTING on a tax id
 * ("0312345678-001" and "0312345678001" are one MST; the branch suffix is kept
 * because it stays a digit), so they are the one place normalisation is safe.
 * @returns {string|null}
 */
export function normalizeTaxId(raw) {
  const s = String(raw ?? "").replace(/[^0-9A-Za-z]/g, "").toUpperCase();
  return TAX_ID_RE.test(s) ? s : null;
}

/**
 * Invoice number → EXACT, uppercase, trimmed. Anything outside the allowlist
 * returns null so the caller REFUSES: see the header for why this one is not
 * normalised.
 * @returns {string|null}
 */
export function normalizeInvoiceNo(raw) {
  const s = String(raw ?? "").trim().toUpperCase();
  return INVOICE_NO_RE.test(s) ? s : null;
}

/** A REAL calendar date, strict YYYY-MM-DD (2026-02-30 is not a date). */
export function strictYmd(raw) {
  const m = YMD_RE.exec(String(raw ?? "").trim());
  if (!m) return null;
  const [, y, mo, d] = m;
  const iso = `${y}-${mo}-${d}`;
  const parsed = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return null;
  // Round-trip: JS rolls "2026-02-30" forward to March, so equality is the check.
  return parsed.toISOString().slice(0, 10) === iso ? iso : null;
}

/** A document kind is a contract vocabulary word, not free text. */
export function normalizeKind(raw) {
  const s = String(raw ?? "").trim().toLowerCase();
  return KIND_RE.test(s) ? s : null;
}

/**
 * A resolved ERPNext document name (supplier/customer). ERPNext docnames may
 * contain spaces and Vietnamese letters, so this only removes controls and
 * collapses whitespace — never case, never accents (two names differing by case
 * are two different documents on the site).
 * @returns {string|null}
 */
export function normalizePartyId(raw) {
  return safeText(raw, 64);
}

/**
 * The identity, plus WHICH half was missing when it could not be built.
 *
 * @param {{kind?:string, partyTaxId?:string|null, partyId?:string|null,
 *          invoiceNo?:string|null, invoiceDate?:string|null}} input
 * @returns {{key:string|null, canonical:string|null, missing:string[]}}
 */
export function businessDocKeyParts({ kind = null, partyTaxId = null, partyId = null, invoiceNo = null, invoiceDate = null } = {}) {
  const k = normalizeKind(kind);
  const taxId = normalizeTaxId(partyTaxId);
  const id = taxId ? null : normalizePartyId(partyId);
  const no = normalizeInvoiceNo(invoiceNo);
  const date = strictYmd(invoiceDate);

  const missing = [];
  if (!k) missing.push("document_kind");
  if (!taxId && !id) missing.push("party_tax_id_or_party_id");
  if (!no) missing.push("invoice_no");
  if (!date) missing.push("invoice_date");
  if (missing.length > 0) return { key: null, canonical: null, missing };

  // Prefixed so the two sources stay distinguishable in the canonical string —
  // a supplier whose docname HAPPENS to equal another's MST must not collide.
  const party = taxId ? `tax:${taxId}` : `id:${id}`;
  const canonical = `${k}|${party}|${no}|${date}`;
  return {
    key: `bdk_${createHash("sha256").update(canonical).digest("hex").slice(0, 32)}`,
    canonical,
    missing: [],
  };
}

/**
 * @returns {string|null} null when the identity is incomplete (callers REFUSE on
 *          null rather than writing a document that cannot be deduped)
 */
export function businessDocKey(input) {
  return businessDocKeyParts(input).key;
}

/**
 * FAIL-CLOSED validation of a `source_document` arriving at the `/ask` boundary.
 *
 * This is not "parse loosely, use what is there": a client that sends a
 * half-identity gets a 400 naming the field. Dropping a malformed identity
 * silently would be the worst outcome available — the user would believe the
 * duplicate protection is on while the server had quietly thrown the invoice
 * number away, and the second send would write a second draft.
 *
 * Only the IDENTITY travels. Totals are dropped on the floor here on purpose: a
 * rate from a file is display-only on every path in this project.
 *
 * @param {unknown} raw           the request body's `source_document`
 * @param {{allowedKinds?:string[]}} [opts] the kinds the sending channel offers,
 *        read from the contract by the caller — never a list kept here. An empty
 *        list means "not constrained", which is what a unit test uses to isolate
 *        the identity rules; every production caller passes the contract's list.
 * @returns {{ok:true, value:object}|{ok:false, code:string, reason:string, error:string}}
 */
export function validateSourceDocument(raw, { allowedKinds = [] } = {}) {
  const fail = (reason, error) => ({ ok: false, code: SOURCE_DOCUMENT_CODE, reason, error });

  if (raw == null) return fail("absent", "source_document rỗng");
  if (typeof raw !== "object" || Array.isArray(raw)) return fail("shape", "source_document phải là một object");

  const kind = normalizeKind(raw.kind);
  if (!kind) {
    return fail("kind", `source_document.kind không hợp lệ ("${safeText(raw.kind, 40) ?? ""}") — phải là một loại chứng từ đã khai trong contract`);
  }
  if (allowedKinds.length > 0 && !allowedKinds.includes(kind)) {
    return fail(
      "kind",
      `source_document.kind="${kind}" không nằm trong danh sách chứng từ của kênh này (${allowedKinds.join(", ")})`,
    );
  }

  const invoiceNo = normalizeInvoiceNo(raw.invoice_no);
  if (!invoiceNo) {
    return fail(
      "invoice_no",
      `source_document.invoice_no không hợp lệ ("${safeText(raw.invoice_no, 40) ?? ""}") — thiếu số hóa đơn thì không chống trùng được, nên không nhận`,
    );
  }
  const invoiceDate = strictYmd(raw.invoice_date);
  if (!invoiceDate) {
    return fail(
      "invoice_date",
      `source_document.invoice_date="${safeText(raw.invoice_date, 40) ?? ""}" không đúng dạng YYYY-MM-DD`,
    );
  }
  const sellerTaxId = normalizeTaxId(raw.seller_tax_id);
  const partyId = normalizePartyId(raw.party_id);
  if (!sellerTaxId && !partyId) {
    return fail(
      "party",
      "source_document thiếu cả seller_tax_id lẫn party_id — không có bên nào để định danh tờ hóa đơn",
    );
  }

  return {
    ok: true,
    value: {
      kind,
      source: normalizeKind(raw.source),
      invoice_no: invoiceNo,
      invoice_form: safeText(raw.invoice_form, 8),
      invoice_series: safeText(raw.invoice_series, 24),
      invoice_date: invoiceDate,
      seller_tax_id: sellerTaxId,
      seller_name: safeText(raw.seller_name, 300),
      party_id: partyId,
    },
  };
}
