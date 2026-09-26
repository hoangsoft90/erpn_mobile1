/**
 * Line parsing shared by the WRITE builders (B2/B3/B4) and the C2 slot form.
 *
 * Why this module exists: C0's static guard forbids `src/ocr/**` from
 * referencing `skills/` at all — the OCR layer must not be able to reach an
 * executor, and an import of the write-skill module would hand it the whole
 * surface. But the C2 form must show EXACTLY what the builder would parse
 * (a second extractor is where "the user confirmed one thing and the document
 * says another" is born). So the two PURE steps the builders use — item
 * matching and quantity pairing — live here, and BOTH sides import this file:
 * the builders re-export for compatibility, the OCR layer imports directly.
 *
 * PURE by construction: no I/O, no ERPNext client, no gateway, no contract —
 * rows in, decisions out. The guard in c0-ocr-foundation.test.mjs still holds
 * (src/ocr never references skills/), and a drift between form and builder is
 * now impossible rather than merely forbidden.
 */

import { matchItemsByText, selectNonOverlappingItems } from "./skills/inventory.mjs";
import { normalizeUomToken } from "./uom.mjs";

/**
 * Blank out the PARTY's own name before matching items — the R6 rule, measured
 * on the real site 2026-09-24.
 *
 * The defect it fixes: `matchItemsByText` matches word-PREFIXES of a stored item
 * name, longest first, and it goes all the way DOWN TO ONE WORD. So on a site
 * whose supplier is `Đại lý Cám Bình Dương`, the sentence
 *
 *   `đặt mua 3 Nos Phí vận chuyển & bốc xếp từ Đại lý Cám Bình Dương`
 *
 * made every `Cám …` item match on the single word `cám` — from INSIDE the
 * supplier's name. The READ path survived (it keeps only the best prefix length),
 * but the ORDER path keeps every non-overlapping match, so a phantom line
 * appeared, carried no quantity, and the builder refused while naming an item the
 * user never said. The user's decision (2026-09-24) was: a span inside the
 * resolved party's name is not a line.
 *
 * Equal-length replacement (spaces) is deliberate: every span offset the caller
 * already holds — including the ones `pairLinesPure` attributes quantities with —
 * stays valid, and the masked word can no longer match an item. Only the
 * occurrence(s) INSIDE the party phrase are masked, so an item genuinely named
 * `Cám` still matches when the user says `2 bao Cám` outside the party name.
 *
 * Exact diacritics are required (only case is folded): if the resolved name and
 * the text disagree on diacritics nothing is masked and behaviour is unchanged —
 * guessing at near-matches here would blank out spans the user did mean.
 *
 * @param {string} text the (normalized) utterance
 * @param {(string|null|undefined)[]} partyNames resolved supplier/customer names
 * @returns {string} same length as `text`
 */
export function maskPartyMention(text, partyNames = []) {
  let out = String(text ?? "");
  const low = out.toLowerCase();
  for (const raw of partyNames ?? []) {
    const name = String(raw ?? "").toLowerCase().trim();
    if (!name) continue;
    let at = low.indexOf(name);
    while (at >= 0) {
      out = out.slice(0, at) + " ".repeat(name.length) + out.slice(at + name.length);
      at = low.indexOf(name, at + name.length);
    }
  }
  return out;
}

/**
 * Which items an ORDER is about: every named item, non-overlapping, in text
 * order. (Full rule doc lives on the re-exports in sales-order-write.mjs.)
 *
 * @param {object[]} items Item rows from ERPNext
 * @param {string} text the (normalized) utterance
 * @returns {{item:object, hit:number, span:{start:number,end:number,phrase:string}}[]}
 */
export function orderItemsInText(items, text, { partyNames = [] } = {}) {
  const { matched, scored } = matchItemsByText(items, maskPartyMention(text, partyNames));
  return selectNonOverlappingItems(scored ?? matched);
}

/**
 * Pair each named item with the quantity Vietnamese word order gives it.
 *
 * Deterministic and explainable (the alternative — "assume the numbers are in
 * order" — is a guess about the user's meaning, and this project does not put
 * guesses into documents):
 *
 *  1. A quantity whose text is part of a matched item's OWN NAME is ERPNext
 *     data, not a request ("Cám gà thịt 10kg" — B1 lesson, kept here).
 *  2. Vietnamese puts the number BEFORE the noun, so an item at span `s` claims
 *     the NEAREST unclaimed quantity that ends at or before `s`.
 *  3. A quantity that FOLLOWS the item is only used when exactly one item is
 *     named — with two items there is no way to tell which one it belongs to.
 *  4. Nothing is summed. Two quantities for one item = ASK.
 *
 * @param {object} input
 * @param {{item:object, hit:number, span:{start:number,end:number,phrase:string}}[]} input.matched
 * @param {{value:number, canonical_unit?:string, raw?:string, start?:number, end?:number}[]} input.quantities
 * @param {string} [input.codePrefix] the CALLING capability's code prefix. The
 *   condition is the same for an order and a quotation, but the taxonomy is
 *   per-capability (each contract entry must declare the codes its own path can
 *   emit — B1 lesson), so a quotation reports QT_QTY_* rather than SO_QTY_*.
 * @returns {{lines:{item:object, quantity:object}[], problems:{code:string, reason:string, item?:object}[]}}
 */
export function pairLinesPure({ matched, quantities = [], codePrefix = "SO_" }) {
  const nameKeys = matched.map((m) =>
    normalizeUomToken(`${m.item?.item_name ?? ""} ${m.item?.item_code ?? ""}`).replace(/\s+/g, ""),
  );
  const usable = quantities
    .filter((q) => Number.isFinite(Number(q?.value)))
    .filter((q) => {
      const key = normalizeUomToken(q?.raw ?? "").replace(/\s+/g, "");
      // A quantity inside ANY matched item's name is that item's packaging.
      if (!key) return true;
      return !nameKeys.some((nk) => nk && nk.includes(key));
    });

  const claimed = new Set();
  const lines = [];
  const problems = [];
  const ordered = [...matched].sort((a, b) => (a.span?.start ?? 0) - (b.span?.start ?? 0));

  for (const m of ordered) {
    const at = m.span?.start ?? 0;
    const before = usable
      .map((q, i) => ({ q, i }))
      .filter(({ q, i }) => !claimed.has(i) && Number(q.end) <= at)
      .sort((a, b) => Number(b.q.end) - Number(a.q.end));
    const pick = before[0] ?? (ordered.length === 1
      ? usable
          .map((q, i) => ({ q, i }))
          .filter(({ q, i }) => !claimed.has(i) && Number(q.start) >= (m.span?.end ?? 0))
          .sort((a, b) => Number(a.q.start) - Number(b.q.start))[0]
      : null);
    if (!pick) {
      problems.push({
        code: `${codePrefix}QTY_MISSING`,
        reason: `chưa rõ số lượng cho mặt hàng "${m.item?.item_name ?? m.item?.item_code ?? "?"}" — nói rõ số lượng (vd: "10 bao ...")`,
        item: m.item,
      });
      continue;
    }
    claimed.add(pick.i);
    lines.push({ item: m.item, quantity: pick.q });
  }

  if (problems.length === 0 && claimed.size < usable.length) {
    // Leftover numbers cannot be attributed to a line. Refusing beats dropping
    // them silently: a dropped line is an order that is missing goods.
    problems.push({
      code: `${codePrefix}QTY_AMBIGUOUS`,
      reason: `còn ${usable.length - claimed.size} con số không gắn được với mặt hàng nào — nói lại theo từng mặt hàng`,
    });
  }
  return { lines, problems };
}
