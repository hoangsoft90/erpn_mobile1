/**
 * A2 (`.plan/next3/implementation.md` workstream A) — parsed e-invoice → the
 * SAME kind of slots the camera channel produces.
 *
 * WHY SLOTS AND NOT A PROPOSAL: an e-invoice is a document the shop received,
 * not an instruction to the system. The pipeline's own rule is that a proposal
 * is built from a SENTENCE the user can see and correct (`ocr_compose.dart`
 * shows the composed sentence as the user's own turn). So this module answers
 * exactly one question — "what does this file appear to say?" — and returns
 * editable lines. Nothing here builds a proposal, reads a price, or writes.
 *
 * WHAT IT REUSES RATHER THAN REIMPLEMENTS:
 *  - `orderItemsInText` (the builder's OWN item matcher, via `line-parse.mjs`),
 *    so the form shows what the purchase-order builder would match. A second
 *    matcher is how "the user confirmed one thing and the document says
 *    another" is born. (Both input channels are forbidden by a static guard from
 *    importing a write-skill module; `line-parse.mjs` is the shared pure home
 *    that keeps single-writer-single-reader true.)
 *  - `resolvePartyFromPhoto` — a FILE is as lossy as a photo once names have
 *    typos/abbreviations, so partial names are offered as candidates and never
 *    auto-picked.
 *
 * WHAT IT ADDS: tax-id resolution. A Vietnamese invoice carries the seller's
 * MST, and the site's Supplier master carries `tax_id` (measured on the real
 * site 2026-09-23: 0300000002 → "Đại lý Cám Bình Dương"). Matching on that
 * business key BEFORE the name is stricter than name matching and still never
 * trusts a document id: the value is resolved against the site's own list, so a
 * forged MST simply fails to resolve.
 *
 * `einvoice_policy.authoritative_identifiers = false` is enforced by
 * construction: nothing on this path can emit an ERPNext id that did not come
 * from a row the server itself read.
 */

import { einvoiceDocumentKinds } from "../capability-contract.mjs";
import { orderItemsInText } from "../line-parse.mjs";
import { pickerForRowsByText } from "../entity-resolution.mjs";
import { sanitizeUntrustedText } from "../untrusted-data.mjs";
import { EINVOICE_CODES, EinvoiceError } from "./einvoice-xml.mjs";

/** Refusal codes this module can raise (mapped to HTTP by http-ask.mjs). */
export const EINVOICE_SLOTS_CODES = Object.freeze({
  KIND_UNKNOWN: "EINVOICE_KIND_UNKNOWN",
  INVOICE_INCOMPLETE: "EINVOICE_INCOMPLETE",
  // A3: the request carried BOTH an `xml` and a `pdf_base64`. Refused rather than
  // "prefer one": the two are readings of the same document, and picking silently
  // means the user confirms a document different from the file they attached.
  INPUT_AMBIGUOUS: "EINVOICE_INPUT_AMBIGUOUS",
});

/** The master-data accessors each kind's party lives under (same shape as C2). */
const PARTY_ACCESSORS = Object.freeze({
  customer: {
    idOf: (row) => row?.name ?? null,
    nameOf: (row) => row?.customer_name ?? row?.name ?? null,
  },
  supplier: {
    idOf: (row) => row?.name ?? null,
    nameOf: (row) => row?.supplier_name ?? row?.name ?? null,
  },
});

/** Digits only — an MST printed with dashes/dots still compares equal. */
function normalizeTaxId(value) {
  const digits = String(value ?? "").replace(/\D/g, "");
  return digits === "" ? null : digits;
}

/**
 * The contract entry for a kind the user picked.
 *
 * Resolved through the SAME kind table the camera uses (`ocr_policy.document_kinds`),
 * narrowed to the kinds `einvoice_policy.document_kinds` says this channel
 * offers — a second kind → capability mapping is a second thing that can drift,
 * and the whole point of the contract is one place where a kind is allowed to
 * mean something. Called with a capability id (not a kind) it refuses.
 *
 * @param {string} kind
 * @returns {{capability:string, party:string, label:string}}
 */
export function kindSpec(kind) {
  const wanted = String(kind ?? "").trim();
  const offered = einvoiceDocumentKinds();
  const spec = offered[wanted];
  if (!spec) {
    const known = Object.keys(offered).join(", ");
    throw new EinvoiceError(
      EINVOICE_SLOTS_CODES.KIND_UNKNOWN,
      `loại chứng từ "${wanted}" không có trong hợp đồng (chỉ nhận: ${known})`,
    );
  }
  return spec;
}

/**
 * Refuse an INCOMPLETE reading.
 *
 * The parser reports what it could not read instead of guessing, and this is
 * where that becomes a refusal: a form missing the invoice number or a whole
 * line is a form the user would confirm without seeing the gap. The user can
 * still enter the document by hand — that path never pretends a file was read.
 *
 * @param {{complete:boolean, problems:{code:string,reason:string}[]}} parsed
 */
export function assertParsedComplete(parsed) {
  if (parsed?.complete === true) return parsed;
  const reasons = (parsed?.problems ?? []).map((p) => p.reason).filter(Boolean);
  throw new EinvoiceError(
    EINVOICE_SLOTS_CODES.INVOICE_INCOMPLETE,
    reasons.length > 0
      ? `file XML còn ${reasons.length} chỗ chưa đọc được: ${reasons.join("; ")}`
      : "file XML thiếu dữ liệu bắt buộc — nhập tay giúp tôi",
  );
}

/**
 * Resolve the party (seller for a purchase, buyer for a sale) of an e-invoice.
 *
 * Order is the safety argument:
 *  1. TAX ID exact (digits only) — the document's own business key, matched
 *     against rows the server read. Ambiguity (two suppliers sharing an MST) is
 *     reported, never resolved by picking one.
 *  2. The stored NAME, word-bounded — full stored names/ids only (the same rule
 *     the photo path uses), with partial names becoming candidates.
 *  3. The picker's substring search over the document's name — candidates only.
 *
 * @param {object[]} parties rows from ERPNext (Supplier or Customer)
 * @param {{tax_id:string|null, name:string|null}} party the file's claim
 * @param {{idOf:Function, nameOf:Function}} accessors
 * @param {(rows:object[], terms:string[], accessors:object)=>object[]} picker
 * @returns {{entity:object|null, ambiguous:boolean, candidates:object[], tax_id_unknown:boolean, by:string|null}}
 */
export function resolveEinvoiceParty(parties, party, accessors, picker) {
  const list = parties ?? [];
  const claimTax = normalizeTaxId(party?.tax_id);
  const claimName = String(party?.name ?? "").trim();

  if (claimTax) {
    const byTax = list.filter((row) => normalizeTaxId(row?.tax_id) === claimTax);
    if (byTax.length === 1) {
      return { entity: byTax[0], ambiguous: false, candidates: [], tax_id_unknown: false, by: "tax_id" };
    }
    if (byTax.length > 1) {
      return {
        entity: null,
        ambiguous: true,
        candidates: byTax.map((r) => ({ name: accessors.nameOf(r) })).slice(0, 5),
        tax_id_unknown: false,
        by: "tax_id",
      };
    }
    // A claimed MST that is NOT on the site is information the user needs: it
    // usually means a supplier master was never created. It is NOT authority to
    // create one (phases3 Cấm: no auto-create master) — so resolution falls
    // through to the name, and the warning list says what happened.
    const fallthrough = resolveByName(list, claimName, accessors, picker);
    return { ...fallthrough, tax_id_unknown: true, by: fallthrough.entity ? "name" : null };
  }
  return { ...resolveByName(list, claimName, accessors, picker), tax_id_unknown: false };
}

function resolveByName(list, claimName, accessors, picker) {
  if (!claimName) return { entity: null, ambiguous: false, candidates: [], by: null };
  // Reuse the photo resolver's word-bounded rules: a full stored name/id found
  // in the text is identity; a partial one is only ever a candidate.
  const norm = (s) => String(s ?? "").toLowerCase().trim();
  const hay = norm(claimName);
  const bounded = (needle) => {
    if (!needle) return false;
    const re = new RegExp(`(^|\\W)${needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\W|$)`);
    return re.test(hay);
  };
  const exact = list.filter(
    (row) =>
      (bounded(norm(accessors.nameOf(row))) && norm(accessors.nameOf(row)).length >= 2) ||
      (bounded(norm(accessors.idOf(row))) && norm(accessors.idOf(row)).length >= 2),
  );
  if (exact.length === 1) return { entity: exact[0], ambiguous: false, candidates: [], by: "name" };
  if (exact.length > 1) {
    const longest = Math.max(...exact.map((r) => norm(accessors.nameOf(r)).length));
    const atLongest = exact.filter((r) => norm(accessors.nameOf(r)).length === longest);
    if (atLongest.length === 1) return { entity: atLongest[0], ambiguous: false, candidates: [], by: "name" };
    return { entity: null, ambiguous: true, candidates: atLongest.map((r) => ({ name: accessors.nameOf(r) })).slice(0, 5), by: "name" };
  }
  const candidates = picker(list, [claimName], { ...accessors, limit: 5 });
  return { entity: null, ambiguous: false, candidates, by: null };
}

/**
 * Turn a parsed e-invoice into editable slots.
 *
 * Pure: every read is injected (items/parties rows come from the caller), so
 * this is testable without ERPNext and without a file on disk.
 *
 * @param {object} input
 * @param {object} input.parsed  output of `parseEinvoiceXml`
 * @param {object} input.spec    contract entry from [kindSpec]
 * @param {object[]} [input.items] Item rows from ERPNext
 * @param {object[]} [input.parties] Customer/Supplier rows for this kind
 * @returns {object} slots for the form (never a proposal)
 */
export function buildEinvoiceSlots({ parsed, spec, items = [], parties = [] }) {
  const accessors = PARTY_ACCESSORS[spec.party];
  // The seller is the party of a PURCHASE (we buy from them); the buyer is the
  // party of a SALE. The file's own words decide nothing — the kind the user
  // picked does.
  const claim = spec.party === "supplier" ? parsed.header.seller : parsed.header.buyer;
  const resolution = resolveEinvoiceParty(parties, claim, accessors, pickerForRowsByText);

  const lines = [];
  const warnings = [];

  for (const row of parsed.lines ?? []) {
    const description = sanitizeUntrustedText(row.description ?? "", { maxLength: 300 });
    const matched = description ? orderItemsInText(items, description) : [];
    let item = null;
    if (matched.length === 1) {
      item = matched[0].item;
    } else if (matched.length > 1) {
      // Deterministic: the longest matched phrase is the most specific name.
      const best = [...matched].sort((a, b) => (b.span?.phrase?.length ?? 0) - (a.span?.phrase?.length ?? 0))[0];
      item = best.item;
      warnings.push({
        code: "ITEM_AMBIGUOUS",
        reason: `dòng ${row.index}: "${description}" khớp nhiều mặt hàng — kiểm lại mặt hàng đã chọn`,
      });
    } else {
      warnings.push({
        code: "PO_ITEM_UNRESOLVED",
        reason: `dòng ${row.index}: chưa có mặt hàng "${description || "(trống)"}" trong danh mục ERPNext — chọn mặt hàng hoặc nhập tay (KHÔNG tự tạo mặt hàng mới)`,
      });
    }
    lines.push({
      // An id is present ONLY when it came from a row the server read. A line the
      // matcher could not resolve keeps the DOCUMENT's words and no id at all.
      item_code: item?.name ?? null,
      item_name: item?.item_name ?? item?.name ?? description ?? null,
      stock_uom: item?.stock_uom ?? null,
      qty: row.qty,
      // The unit is the DOCUMENT's word, verbatim: the UOM the document gets is
      // resolved by the builder against the site's own UOM list, never from here.
      uom: row.uom ?? null,
      raw_quantity: [row.qty, row.uom].filter((v) => v != null && v !== "").join(" ") || null,
    });
  }

  if (resolution.ambiguous) {
    warnings.push({
      code: spec.party === "supplier" ? "AMBIGUOUS_SUPPLIER" : "AMBIGUOUS_CUSTOMER",
      reason: `MST/tên ${spec.party === "supplier" ? "nhà cung cấp" : "khách"} trên hóa đơn khớp nhiều hồ sơ — chọn đúng người`,
    });
  } else if (!resolution.entity) {
    warnings.push({
      code: spec.party === "supplier" ? "SUPPLIER_NOT_FOUND" : "CUSTOMER_NOT_FOUND",
      reason: resolution.tax_id_unknown
        ? `MST ${claim?.tax_id ?? "?"} không có trong danh mục ${spec.party === "supplier" ? "nhà cung cấp" : "khách"} của ERPNext — chọn đúng đối tác đã có (KHÔNG tự tạo mới)`
        : `chưa thấy ${spec.party === "supplier" ? "nhà cung cấp" : "khách"} trên hóa đơn — điền tay hoặc chọn từ danh mục`,
    });
  } else if (resolution.tax_id_unknown) {
    // Resolved by NAME even though the file claimed an MST the master does not
    // carry — usually a supplier record that was never given its tax id. The
    // user sees the mismatch BEFORE confirming, and nothing is auto-updated.
    warnings.push({
      code: "SUPPLIER_TAX_ID_UNKNOWN",
      reason: `MST ${claim?.tax_id ?? "?"} trên hóa đơn không có trong danh mục NCC, nhưng khớp theo TÊN "${resolution.entity ? accessors.nameOf(resolution.entity) : ""}" — kiểm lại trước khi xác nhận`,
    });
  }

  return {
    kind: spec.capability === "purchase_order.create" ? "purchase" : "sales",
    capability: spec.capability,
    label: spec.label,
    text: describeDocument(parsed),
    party: {
      role: spec.party,
      resolved: resolution.entity
        ? { id: accessors.idOf(resolution.entity), name: accessors.nameOf(resolution.entity) }
        : null,
      ambiguous: resolution.ambiguous === true,
      candidates: resolution.entity ? [] : resolution.candidates,
      matched_by: resolution.by,
      claimed_tax_id: claim?.tax_id ?? null,
    },
    lines,
    // Money read off the FILE is DISPLAY ONLY: a rate never comes from a
    // document image or file (B2/B4 `rate_source: erpnext`), so this is a hint
    // the user can compare against the price ERPNext will actually charge.
    money_vnd: Number.isFinite(Number(parsed.header?.total_vnd)) ? Number(parsed.header.total_vnd) : null,
    warnings,
    source_document: {
      source: parsed.source,
      invoice_no: parsed.header?.invoice_no ?? null,
      invoice_form: parsed.header?.invoice_form ?? null,
      invoice_series: parsed.header?.invoice_series ?? null,
      invoice_date: parsed.header?.invoice_date ?? null,
      currency: parsed.header?.currency ?? null,
      seller_tax_id: parsed.header?.seller?.tax_id ?? null,
      seller_name: parsed.header?.seller?.name ?? null,
      buyer_tax_id: parsed.header?.buyer?.tax_id ?? null,
      buyer_name: parsed.header?.buyer?.name ?? null,
      net_total_vnd: parsed.header?.net_total_vnd ?? null,
      tax_total_vnd: parsed.header?.tax_total_vnd ?? null,
      total_vnd: parsed.header?.total_vnd ?? null,
    },
    // NOTE: there is deliberately no `empty` flag here. The camera path needs
    // one because a photo can yield nothing at all; a FILE cannot — a file with
    // no usable line is an INCOMPLETE parse and is refused by
    // `assertParsedComplete` before slots are ever built. A flag that can never
    // be true is a lie in the response shape.
  };
}

/**
 * One line of readable text for the chat field, built ONLY from what the file
 * said. Used as the slot form's "what the file appears to say" header — the
 * sentence that actually travels the pipeline is composed by the client from
 * the CORRECTED slots (`ocr_compose.dart`), so nothing is executed from here.
 *
 * @param {object} parsed
 * @returns {string}
 */
export function describeDocument(parsed) {
  const h = parsed?.header ?? {};
  const bits = [];
  if (h.invoice_series || h.invoice_no) {
    bits.push(`hóa đơn ${[h.invoice_series, h.invoice_no].filter(Boolean).join("-")}`);
  }
  if (h.invoice_date) bits.push(`ngày ${h.invoice_date}`);
  if (h.seller?.name) bits.push(`người bán ${h.seller.name}`);
  const goods = (parsed?.lines ?? [])
    .map((l) => [l.qty, l.uom, l.description].filter((v) => v != null && v !== "").join(" "))
    .filter((s) => s !== "")
    .join("; ");
  if (goods) bits.push(goods);
  return sanitizeUntrustedText(bits.join(" · "), { maxLength: 500 });
}
