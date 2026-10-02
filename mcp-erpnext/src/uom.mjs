/**
 * UOM resolution — the "KHÔNG quy đổi ẩn" rule of plan3_review3 §B.3, made
 * checkable instead of aspirational.
 *
 * The danger this module exists for: "500 bao xi măng" becoming 500 TẤN because
 * something upstream silently applied a conversion, or "1 xe cát" being written
 * as 5 m3 by a hardcoded factor. So:
 *
 *  1. The unit NAME always comes from ERPNext (`UOM` doctype), never from this
 *     file. The alias table below only turns colloquial speech into CANDIDATE
 *     names ("khối" → "m3"); a candidate that ERPNext does not have is
 *     UOM_UNKNOWN, not a guess. (Live site 2026-09-20 stores the Vietnamese
 *     "Thung" with no diacritic — inventing "Thùng" would be a LinkValidationError.)
 *  2. The FACTOR always comes from ERPNext (`UOM Conversion Factor`), and only a
 *     DIRECT factor (user_uom → item stock_uom) is ever applied. No inverse, no
 *     two-hop chain: the site has Tấn→Kg = 1000 but no Kg→Bao, so "1 tấn cám"
 *     (stock Bao) must ASK, not compute 1000/25 = 40 by itself.
 *  3. Every conversion carries a human `display` string. A conversion that has
 *     no display is a bug by construction (asserted in the tests), because the
 *     confirm card is the only place the user can see it.
 *
 * Anything not explicitly converted is returned as action "ask" — fail closed,
 * with a Vietnamese `reason` that says what is missing.
 *
 * Verified against the live site (read-only, 2026-09-20):
 *   Item.uom          → HTTP 417 "Trường không được phép trong truy vấn: uom"
 *   UOM Conversion Factor.item_code → HTTP 417 ⇒ factors are GLOBAL, not per item
 *   UOM list          → Bao, Tấn, Kg, Xe, Thung, Viên, Mét, m3 … (246 rows)
 *   factors           → Tấn→Kg 1000, Bao→Kg 25 (no Kg→Bao, no Tấn→Bao)
 */

/**
 * Candidate ERPNext names for one unit FORM. A form is what either side of the
 * boundary produces: the Python layer's `canonical_unit` ("khoi", "bao", "tan")
 * or a word read out of the raw text ("khối", "bao", "tấn"). Both normalize to
 * the same key on purpose — that is what keeps ONE unit table instead of two.
 *
 * @param {string|null} form
 * @returns {string[]}
 */
export function candidatesForUnit(form) {
  const key = normalizeUomToken(form);
  if (!key) return [];
  return UOM_SYNONYMS[key] ?? [form];
}

/** Accent-insensitive, case-insensitive comparison key. */
export function normalizeUomToken(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Colloquial Vietnamese → CANDIDATE ERPNext UOM names. Deliberately a list of
 * candidates, not a mapping to a final name: the live UOM list decides.
 * Kept short on purpose — every entry here is a synonym expansion, never a
 * conversion factor.
 */
export const UOM_SYNONYMS = Object.freeze({
  bao: ["Bao"],
  bich: ["Bao"],
  goi: ["Gói"],
  can: ["Can"],
  lo: ["Lọ"],
  hop: ["Hộp"],
  yen: ["Yến"],
  tan: ["Tấn"],
  tong: ["Tấn"],
  ta: ["Tạ"],
  kg: ["Kg"],
  ky: ["Kg"],
  ki: ["Kg"],
  kilogam: ["Kg"],
  gam: ["Gram"],
  gram: ["Gram"],
  xe: ["Xe"],
  thung: ["Thung", "Thùng"],
  vien: ["Viên"],
  met: ["Mét"],
  m: ["Mét"],
  m3: ["m3"],
  khoi: ["m3"],
  lit: ["Lít"],
  cay: ["Cây"],
  bo: ["Bó"],
  cuon: ["Cuộn"],
  tam: ["Tấm"],
  pallet: ["Pallet"],
  chiec: ["Chiếc"],
  cai: ["Cái"],
  // `Nos` is ERPNext's own name for a countable unit. Measured on the live site
  // 2026-09-24: the `UOM` doctype HAS `Nos` (and does NOT have `Cái`/`Chiếc`), and
  // the service item `PHI-VAN-CHUYEN` has `stock_uom: "Nos"`. ONE candidate on
  // purpose: offering `Cái` as well would be the guess this table exists to
  // avoid — the site has no such UOM, so it could only ever resolve to
  // UOM_UNKNOWN. The candidate is still only a CANDIDATE; the `UOM` list decides.
  nos: ["Nos"],
});

/**
 * Phrases where a UOM word is NOT a unit. "cám còn bao nhiêu" must not read as
 * "Bao" — that mistake would turn a stock question into a unit question.
 * Compared as normalized bigrams (word + next word).
 */
export const UOM_DENY_BIGRAMS = Object.freeze([
  "bao nhieu",
  "bao lau",
  "bao gio",
  "bao xa",
  "bao tien",
  // "báo giá" / "báo cáo" / "bao gồm" / "bao bì" all normalize to a "bao …"
  // bigram. Without these, "báo giá 5 tấn cám" reads as TWO units (Báo… and Tấn)
  // and asks a question nobody asked.
  "bao gia",
  "bao cao",
  "bao gom",
  "bao bi",
]);

/**
 * Homograph note: "con" is deliberately NOT in the alias table. "con" (animal)
 * and "còn" (still/left) share a normalized form, so a stock question like
 * "cám còn bao nhiêu" would name the unit "Con" — a unit this site does not
 * have anyway. A unit that can only be recognised by ignoring the diacritics of
 * a common word is not evidence, so "Con" is left to the ASK path.
 */

/** Words that are quantities, not units — "tám bao" (8 bao) has no UOM "tám". */
const NUMBER_WORDS = new Set([
  "khong", "mot", "hai", "ba", "bon", "tu", "nam", "lam", "sau", "bay", "tam",
  "chin", "muoi", "chuc", "tram", "nghin", "ngan", "trieu", "nua", "ruoi",
]);

const UOM_CODES = Object.freeze({
  NO_UOM: "NO_UOM",
  UOM_UNKNOWN: "UOM_UNKNOWN",
  UOM_AMBIGUOUS: "UOM_AMBIGUOUS",
  UOM_FACTOR_MISSING: "UOM_FACTOR_MISSING",
  NO_CONVERSION_NEEDED: "NO_CONVERSION_NEEDED",
  CONVERTED: "CONVERTED",
});

export { UOM_CODES };

/** Actions a caller may take. Anything that is not exactly this set is a bug. */
export const UOM_ACTIONS = Object.freeze({ USE: "use", CONVERT: "convert", ASK: "ask" });

/**
 * Which UOM does this (already normalized) utterance name?
 *
 * Returns EVERY surface form found so the caller can treat "2 tấn 5 bao" as
 * ambiguous instead of silently taking one.
 *
 * @param {string} text normalized text (Phase 1 output)
 * @returns {{surface:string|null, candidates:string[], matches:string[], ambiguous:boolean, quantity_context:boolean}}
 */
export function extractUom(text) {
  const raw = String(text ?? "");
  const norm = normalizeUomToken(raw);
  const words = norm.split(" ").filter(Boolean);
  const aliasKeys = Object.keys(UOM_SYNONYMS);
  const found = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (!aliasKeys.includes(w)) continue;
    // Deny phrases: the UOM word plus the word after it.
    const bigram = `${w} ${words[i + 1] ?? ""}`.trim();
    if (UOM_DENY_BIGRAMS.some((d) => normalizeUomToken(d) === bigram)) continue;
    // A number word is a quantity, never a unit: "tám bao cám" (8 bao) is not
    // UOM "tấm". "tám" and "tấm" share the normalized form "tam", so the only
    // safe reading of a bare "tam" is "quantity" — never invent a unit from it.
    if (NUMBER_WORDS.has(w)) continue;
    found.push({ surface: UOM_SYNONYMS[w][0], key: w, at: i });
  }
  const distinct = [...new Set(found.map((f) => f.key))];
  const quantityContext = found.some((f) => {
    const prev = words[f.at - 1] ?? "";
    return /\d/.test(prev) || NUMBER_WORDS.has(prev);
  });
  const form = distinct.length === 1 ? distinct[0] : null;
  return {
    form,
    surface: form ? (UOM_SYNONYMS[form][0] ?? form) : null,
    candidates: form ? UOM_SYNONYMS[form] : distinct.flatMap((k) => UOM_SYNONYMS[k] ?? []),
    matches: found.map((f) => f.key),
    ambiguous: distinct.length > 1,
    quantity_context: quantityContext,
  };
}

/**
 * Which unit FORM does this utterance mean, given the Python NLP result?
 *
 * The Python layer's `quantities` (a unit only counts when a NUMBER precedes it)
 * is the AUTHORITY when it found one — that is also why "cám còn bao nhiêu" can
 * never be read as the unit Bao without any deny-list: `quantity.py` requires the
 * number, and the phrase has none. The local extractor is the FALLBACK for units
 * the Python table does not know (cây, xe, mét, viên, m3…), so those still
 * produce a refusal instead of silently falling back to the item's default unit.
 *
 * @param {object|null} nlp result of the Python normalizer ({ text, quantities })
 * @param {string|null} [text] raw/cleaned text, defaults to nlp.text
 * @param {{item?:object|null}} [opts] the resolved item, so a quantity that is
 *        part of the item's OWN NAME can be ignored (live finding 2026-09-20:
 *        "Cám gà thịt 25kg" made the parser report "25kg" as a quantity, and
 *        asking for stock then looked like the user had asked for Kg)
 * Caveat (measured, and deliberate for B1): this resolves ONE unit for ONE
 * line. "2 bao và 3 bao" returns the FIRST quantity (2) — summing/splitting is a
 * multi-line concern (B2), so the resolver must not silently invent a total.
 * Two DIFFERENT units, on the other hand, are refused as ambiguous.
 *
 * @returns {{form:string|null, quantity:number|null, ambiguous:boolean, source:"nlp"|"text"|"none"}}
 */
export function unitFormFromNlp(nlp, text = null, { item = null } = {}) {
  const nameKey = normalizeUomToken(`${item?.item_name ?? ""} ${item?.item_code ?? ""}`).replace(/\s+/g, "");
  const quantities = (nlp?.quantities ?? []).filter((q) => {
    const rawKey = normalizeUomToken(q?.raw ?? "").replace(/\s+/g, "");
    // A quantity string that is inside the item name is ERPNext data, not a
    // request: "25kg" in "Cám gà thịt 25kg" says which bag the item is.
    return !(rawKey && nameKey && nameKey.includes(rawKey));
  });
  const canon = [...new Set(quantities.map((q) => String(q?.canonical_unit ?? "").trim()).filter(Boolean))];
  const extracted = extractUom(text ?? nlp?.text ?? "");
  if (canon.length > 1) return { form: null, quantity: null, ambiguous: true, source: "nlp" };
  if (canon.length === 1) {
    const val = Number(quantities[0]?.value);
    return {
      form: canon[0],
      quantity: Number.isFinite(val) ? val : null,
      ambiguous: false,
      source: "nlp",
    };
  }
  if (extracted.ambiguous) return { form: null, quantity: null, ambiguous: true, source: "text" };
  return {
    form: extracted.form,
    quantity: null,
    ambiguous: false,
    source: extracted.form ? "text" : "none",
  };
}

/**
 * First candidate name that ERPNext really has. Candidate ORDER is the alias
 * table's, never the live list's — the table says which spelling is preferred
 * (the site's own "Thung" before the correct-Vietnamese "Thùng"), and a
 * candidate the site lacks simply does not match (no fuzzy fallback).
 *
 * @param {string[]} candidates
 * @param {string[]} erpUomNames
 */
export function matchUomCandidates(candidates, erpUomNames) {
  const live = new Map((erpUomNames ?? []).map((n) => [normalizeUomToken(n), n]));
  for (const candidate of candidates ?? []) {
    const hit = live.get(normalizeUomToken(candidate));
    if (hit) return { name: hit, candidates };
  }
  return { name: null, candidates };
}

/**
 * The UOM policy block from the contract. Kept as a function (not a constant) so
 * the policy has exactly one home: capabilities.json.
 * @param {object} contract validated contract
 */
export function uomPolicy(contract) {
  const policy = contract?.defaults?.uom_policy;
  if (!policy) throw new Error("UOM_POLICY_MISSING: capabilities.json defaults.uom_policy is required");
  return policy;
}

/**
 * Find the factor that converts `fromUom` → `toUom`, DIRECT only.
 *
 * @param {Array<{name?:string, from_uom:string, to_uom:string, value:number}>} factors rows from ERPNext
 * @param {string} fromUom
 * @param {string} toUom
 * @returns {{value:number, row:object}|null}
 */
export function findDirectFactor(factors, fromUom, toUom) {
  const from = normalizeUomToken(fromUom);
  const to = normalizeUomToken(toUom);
  const row = (factors ?? []).find(
    (f) => normalizeUomToken(f?.from_uom) === from && normalizeUomToken(f?.to_uom) === to,
  );
  const value = Number(row?.value);
  if (!row || !Number.isFinite(value) || value <= 0) return null;
  return { value, row };
}

/**
 * Resolve the unit for ONE line: which UOM, and whether a conversion happens.
 *
 * @param {object} input
 * @param {string|null} input.text            normalized utterance (UOM extract)
 * @param {string|null} [input.uom]           explicit surface form, if the caller already extracted it
 * @param {number|null} [input.quantity]      quantity as parsed upstream (NEVER recomputed here)
 * @param {object} input.item                 { name, item_code, item_name, stock_uom }
 * @param {string[]} [input.erpUomNames]      UOM names read from ERPNext
 * @param {object[]} [input.factors]          UOM Conversion Factor rows read from ERPNext
 * @param {object} input.policy               contract defaults.uom_policy
 * @returns {object} decision (see the module doc — `action` is the contract)
 */
export function resolveLineUom({
  text = null,
  uom = null,
  quantity = null,
  item = {},
  erpUomNames = [],
  factors = [],
  policy,
  forceAmbiguous = false,
}) {
  if (!policy) throw new Error("UOM_POLICY_MISSING: resolveLineUom needs the contract policy block");
  const stockUom = item?.stock_uom ?? null;
  if (!stockUom) {
    // No stock_uom ⇒ nothing to convert TO. Never fall back to "each"/"Nos".
    return decision({
      code: UOM_CODES.UOM_FACTOR_MISSING,
      action: UOM_ACTIONS.ASK,
      reason: `mặt hàng ${item?.item_code ?? item?.name ?? "?"} chưa có đơn vị tồn kho (stock_uom) trong ERPNext`,
      stockUom: null,
    });
  }

  if (forceAmbiguous) {
    // The caller already established the sentence names more than one unit
    // (e.g. the Python layer returned two different `canonical_unit`s). Re-reading
    // the text here could find just one of them and quietly pick it.
    return decision({
      code: UOM_CODES.UOM_AMBIGUOUS,
      action: UOM_ACTIONS.ASK,
      stockUom,
      quantity,
      reason: "câu nói có nhiều đơn vị — cần chọn một đơn vị",
    });
  }
  const explicit = uom !== null && uom !== undefined && String(uom).trim() !== "";
  const extracted = explicit
    ? { form: normalizeUomToken(uom), surface: candidatesForUnit(uom)[0] ?? String(uom), candidates: candidatesForUnit(uom), ambiguous: false, quantity_context: false }
    : extractUom(text);
  if (extracted.ambiguous) {
    return decision({
      code: UOM_CODES.UOM_AMBIGUOUS,
      action: UOM_ACTIONS.ASK,
      stockUom,
      quantity,
      reason: `câu nói có nhiều đơn vị (${extracted.candidates.join(", ")}) — cần chọn một đơn vị`,
      candidates: extracted.candidates,
    });
  }

  // No unit said ⇒ the item's own default, SAID OUT LOUD ("mặc định").
  if (!extracted.surface) {
    return decision({
      code: UOM_CODES.NO_UOM,
      action: UOM_ACTIONS.USE,
      stockUom,
      uom: stockUom,
      uom_source: "item_default",
      quantity,
      display: `Đơn vị: ${stockUom} (mặc định của mặt hàng)`,
      reason: null,
    });
  }

  const live = matchUomCandidates(extracted.candidates, erpUomNames);
  if (!live.name) {
    return decision({
      code: UOM_CODES.UOM_UNKNOWN,
      action: UOM_ACTIONS.ASK,
      stockUom,
      quantity,
      reason: `ERPNext không có đơn vị "${extracted.surface}" — không tự đổi sang ${stockUom}`,
      candidates: (erpUomNames ?? []).slice(0, 5),
      uom: null,
    });
  }

  // User unit == stock unit ⇒ nothing to convert, and the ambiguous list does
  // not apply (no arithmetic happens).
  if (normalizeUomToken(live.name) === normalizeUomToken(stockUom)) {
    return decision({
      code: UOM_CODES.NO_CONVERSION_NEEDED,
      action: UOM_ACTIONS.USE,
      stockUom,
      uom: live.name,
      uom_source: "user",
      quantity,
      display: `Đơn vị: ${live.name}`,
      reason: null,
    });
  }

  const ambiguous = (policy.ambiguous_uoms ?? []).map(normalizeUomToken);
  if (ambiguous.includes(normalizeUomToken(live.name))) {
    return decision({
      code: UOM_CODES.UOM_AMBIGUOUS,
      action: UOM_ACTIONS.ASK,
      stockUom,
      uom: live.name,
      uom_source: "user",
      quantity,
      reason: `đơn vị "${live.name}" phụ thuộc loại xe/bao bì nên không tự quy đổi — cần chọn đơn vị cụ thể`,
    });
  }

  const factor = findDirectFactor(factors, live.name, stockUom);
  if (!factor) {
    return decision({
      code: UOM_CODES.UOM_FACTOR_MISSING,
      action: UOM_ACTIONS.ASK,
      stockUom,
      uom: live.name,
      uom_source: "user",
      quantity,
      reason: `ERPNext chưa có quy đổi trực tiếp ${live.name} → ${stockUom} — không tự nghịch đảo/nối chuỗi`,
    });
  }

  // `quantity` may legitimately be ABSENT (a READ question names a unit but no
  // number). `Number(null)` is 0 — that would silently turn "1 tấn" into
  // "0 Kg" both in the display and, later, in a written line quantity. Caught by
  // the live probe 2026-09-20, not by the unit tests (which always passed a
  // quantity), so the null case has its own assertion now.
  const hasQuantity = quantity !== null && quantity !== undefined && quantity !== "" && Number.isFinite(Number(quantity));
  const converted = hasQuantity ? Number(quantity) * factor.value : null;
  const display = `quy đổi: ${hasQuantity ? Number(quantity) : 1} ${live.name} = ${converted ?? factor.value} ${stockUom}`;
  const warnings = [];
  if (policy.show_factor_scope_warning !== false) {
    // Live site: UOM Conversion Factor has no item_code field, so the factor is
    // global. Saying so is the difference between a disclosed conversion and a
    // hidden one.
    warnings.push(`hệ số ${live.name} → ${stockUom} là hệ số chung toàn hệ thống, không theo mặt hàng`);
  }
  const minResultQty = Number.isFinite(Number(policy.min_result_qty)) ? Number(policy.min_result_qty) : 0.1;
  if (converted !== null && Math.abs(converted) > 0 && Math.abs(converted) < minResultQty) {
    warnings.push(`kết quả quá nhỏ (${converted}) — kiểm tra lại đơn vị`);
  }
  if (converted !== null && Number.isFinite(converted) && !Number.isInteger(converted)) {
    warnings.push(`kết quả lẻ (${converted}) — cần xác nhận làm tròn thế nào`);
  }
  return decision({
    code: UOM_CODES.CONVERTED,
    action: UOM_ACTIONS.CONVERT,
    stockUom,
    uom: live.name,
    uom_source: "user",
    quantity,
    converted_quantity: converted,
    factor: { value: factor.value, row_name: factor.row?.name ?? null, scope: "global" },
    display,
    warning: warnings.length ? warnings.join("; ") : null,
  });
}

function decision(fields) {
  return {
    code: fields.code,
    action: fields.action,
    uom: fields.uom ?? null,
    uom_source: fields.uom_source ?? null,
    stock_uom: fields.stockUom ?? null,
    quantity: fields.quantity ?? null,
    converted_quantity: fields.converted_quantity ?? null,
    factor: fields.factor ?? null,
    display: fields.display ?? null,
    warning: fields.warning ?? null,
    reason: fields.reason ?? null,
    candidates: fields.candidates ?? [],
    // A conversion without a visible display is a hidden conversion — the only
    // states that may touch a quantity are USE/CONVERT, and CONVERT always has
    // a display by construction (asserted in tests/uom tests).
    hidden_conversion: fields.action === UOM_ACTIONS.CONVERT && !fields.display,
  };
}
