/**
 * next7 / C3 — the DAY PHRASE a Vietnamese revenue question names.
 *
 * WHAT THIS IS: `sales.summary` ("báo cáo doanh thu hôm nay") could only ever
 * answer the SHOP'S TODAY, because the chat path never handed a day to the skill
 * — the day came from the skill's own clock. So "doanh thu ngày 15/9" answered
 * with today's number inside a sentence that also said "ngày <today>": the day
 * was silently wrong, and a wrong day is a wrong money figure.
 *
 * WHY DETERMINISTIC, NOT THE LLM: `date_text` IS in the classifier's slot
 * allowlist, but the classifier only runs when the KEYWORD router misses, and a
 * "doanh thu ..." sentence always hits the `sales` keyword route (measured: C2
 * probe, 2026-09-27). Reading the day from a model would also put a second,
 * unmeasurable source of truth on a money answer. This module is PURE — no
 * clock (the caller passes `today`), no ERP, no I/O — so every rule below is
 * unit-testable at its own boundary.
 *
 * POLICY (user decision 2026-09-27 — fail closed, like the rest of the money
 * path; the alternative "answer today instead" was explicitly rejected because
 * the number would then be about a day nobody asked for):
 *
 *   UNDERSTOOD
 *     "hôm nay" · "hôm qua" · "hôm kia"
 *     `d/m` · `d/m/yyyy` · `d-m-yyyy` · `d.m.yyyy` · `yyyy-mm-dd`
 *     "ngày d tháng m" · "ngày d tháng m năm yyyy" · "d tháng m [yyyy]"
 *     (unaccented spellings too — the product's own routing keywords ship
 *      unaccented forms, so a keyboard without diacritics is expected input)
 *
 *   REFUSED (never silently answered with a different day)
 *     a PERIOD          tuần/tháng/quý/năm, "mấy ngày nay", "3 ngày qua"
 *     a vague day       "hôm trước", "bữa nọ" — the day is not knowable
 *     a future day      "ngày mai", and any date AFTER today
 *     year-less + future   "30/9" asked on 27/9: the year is not inferable
 *     a 2-digit year     "15/9/26" — the century is not inferable
 *     an impossible date "31/2", "0/5", "15/13"
 *     two different days in one sentence
 *
 * A question that names NO day at all is NOT an error: it returns
 * `{ ok: true, date: null }` and the caller keeps the existing "today"
 * behaviour (that is the shape the product shipped in C1).
 */

/**
 * The refusal codes this module can emit.
 *
 * `DAY_PHRASE_INVALID` is a taxonomy code (uncertainty.mjs) — the client shows
 * its copy and, later, can react to it with a date picker. The PERIOD case
 * reuses `KNOWN_INTENT_UNIMPLEMENTED`, which is exactly what it is: the
 * sentence was understood ("you want a span"), the feature for it does not
 * exist yet. Neither code is invented at the call site.
 */
export const DAY_PHRASE_CODES = Object.freeze({
  DAY_PHRASE_INVALID: "DAY_PHRASE_INVALID",
  DAY_PHRASE_PERIOD: "KNOWN_INTENT_UNIMPLEMENTED",
});

const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** "yyyy-mm-dd" ± n days, in UTC — the same date-string arithmetic the drills use. */
export function addDays(iso, days) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Real calendar date? (Feb 30, month 13 and day 0 are all refused.) */
function isRealDate(y, m, d) {
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return false;
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

const pad = (n) => String(n).padStart(2, "0");
const iso = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;

/* ─────────────────────────── word boundaries ─────────────────────────── */

/**
 * Word boundaries, the Vietnamese way — measured, not assumed (2026-09-27).
 *
 * `\b` is NOT usable around these words: JS `\w` is ASCII, so whether a
 * boundary exists after a diacritic depends on how that character is encoded.
 * Probed on Node 24 with this very module: `/\b(tuần|tháng|quý|năm)\b/` matched
 * "tuần", "tháng", "năm" but NOT "quý" — so "doanh thu quý này" fell through to
 * the "no day named" branch and would have answered with TODAY's number inside a
 * sentence about a quarter. A letter/mark/number lookaround has no such hole.
 */
/** A letter, a combining mark, or a digit — the three things a WORD can touch. */
const LETTER = "\\p{L}\\p{M}\\p{N}";
/** Not preceded / not followed by one of those. (Written out rather than built
 *  from a negated class: `(?<![^...])` would read as "the previous character IS
 *  a letter", which is the exact opposite — measured the hard way.) */
const NOT_AFTER = `(?<![${LETTER}])`;
const NOT_BEFORE = `(?![${LETTER}])`;

/** `alternatives`, matched as a whole word (lookarounds instead of `\b`). */
function words(alternatives, flags = "") {
  return new RegExp(`${NOT_AFTER}(?:${alternatives})${NOT_BEFORE}`, `u${flags}`);
}

/* ─────────────────────────── match collection ─────────────────────────── */

/**
 * A date written BEFORE a money word is not a date: "doanh thu 1/5 triệu" is an
 * amount, and reading it as 1 May would answer a day nobody named.
 */
const MONEY_AFTER_RE = /^\s*(triệu|trieu|ngàn|ngan|nghìn|nghin|tr\b|k\b|đ\b|đồng|dong|vnd)/i;

/**
 * Date shapes, tried in this order. An earlier pattern CLAIMS its span (the span
 * is blanked before the next shape runs) so one written date can never be read
 * twice — e.g. `2026-09-15` must not also offer `26-09` to the `d/m` shape, and
 * `15/9 năm 2026` must not leave a lone "năm" behind to be read as a period.
 */
const SHAPES = Object.freeze([
  { name: "iso", re: new RegExp(`${NOT_AFTER}(\\d{4})-(\\d{2})-(\\d{2})${NOT_BEFORE}`, "gu") },
  {
    name: "words",
    re: new RegExp(
      `${NOT_AFTER}(?:(?:ngày|ngay)\\s+)?(\\d{1,2})\\s+(?:tháng|thang)\\s+(\\d{1,2})(?:\\s+(?:(?:năm|nam)\\s+)?(\\d{1,4}))?`,
      "gu",
    ),
  },
  {
    name: "dmy",
    re: new RegExp(
      `${NOT_AFTER}(\\d{1,2})\\s*[/-]\\s*(\\d{1,2})(?:\\s*(?:[/-]|năm\\s*|nam\\s*)\\s*(\\d{1,4}))?`,
      "gu",
    ),
  },
  // The dotted form ONLY with a 4-digit year: "1.5" is a number, not 1 May.
  { name: "dotted", re: new RegExp(`${NOT_AFTER}(\\d{1,2})\\.(\\d{1,2})\\.(\\d{4})${NOT_BEFORE}`, "gu") },
]);

/** "hôm nay" | "hôm qua" | "hôm kia" — with an optional leading "ngày". */
const RELATIVE_WORD = "hôm\\s+nay|hom\\s+nay|hôm\\s+qua|hom\\s+qua|hôm\\s+kia|hom\\s+kia";
// `g` matters: the relatives are walked with `exec`, and a non-global regex
// would return the SAME first match forever (measured: heap exhaustion, not a
// wrong answer — the loop is guarded below too).
const RELATIVE_RE = words(`(?:ngày|ngay)\\s+(${RELATIVE_WORD})|(${RELATIVE_WORD})`, "gi");

/**
 * PERIOD words. A bare `năm`/`nam`/`quý`/`quy` is NOT enough — "doanh thu của
 * anh Nam" and "chị Năm" are PEOPLE, and refusing those would be a wrong answer
 * of a different kind. The word counts as a period only when a period marker or
 * a number sits beside it ("tuần này", "tháng 9", "cuối tháng", "năm 2026").
 */
const PERIOD_MARKER = "này|nay|trước|truoc|sau|ngoái|ngoai|rồi|roi|tới|toi|vừa\\s+rồi|vua\\s+roi|đầu|dau|giữa|giua|cuối|cuoi";
const PERIOD_WORD = "tuần|tuan|tháng|thang|quý|quy|năm|nam";
const PERIOD_RE = words(
  `(?:${PERIOD_MARKER})\\s+(?:${PERIOD_WORD})|(?:${PERIOD_WORD})\\s+(?:${PERIOD_MARKER})|(?:${PERIOD_WORD})\\s*\\d{1,4}`,
);

/** "3 ngày qua", "mấy ngày nay" — a span said without a period word. */
const COUNTED_DAYS_RE = words("(?:\\d+|mấy|may|vài|vai)\\s+(?:ngày|ngay)");
const SPAN_MARKER_RE = words("nay|này|qua|trước|truoc|sau|tới|toi|gần\\s+đây|gan\\s+day|rồi|roi|dạo\\s+này|dao\\s+nay");

/** A day word that does NOT pin one day: "hôm trước", "bữa nọ". */
const VAGUE_DAY_RE = words(
  "hôm\\s+trước|hom\\s+truoc|hôm\\s+bữa|hom\\s+bua|hôm\\s+nọ|hom\\s+no|hôm\\s+nào|hom\\s+nao|bữa\\s+trước|bua\\s+truoc|bữa\\s+nọ|bua\\s+no|bữa\\s+nào|bua\\s+nao",
);

/**
 * Days the sentence can name but that cannot have revenue yet. Bare "mai"
 * (accented) is enough; unaccented "mot" is accepted ONLY after "ngày/ngay",
 * because "mot" on its own is also "một" (one).
 */
const FUTURE_DAY_RE = words("(?:ngày|ngay)\\s+(?:mai|mốt|mot)|mai|mốt");

function blankSpans(text, spans) {
  const chars = text.split("");
  for (const [from, to] of spans) {
    for (let i = from; i < to && i < chars.length; i += 1) chars[i] = " ";
  }
  return chars.join("");
}

/**
 * Every date written in the text, in order of appearance.
 * @returns {{matches: object[], rest: string}} `rest` = the text with the
 *          claimed date spans blanked, so "is there a PERIOD left over?" can be
 *          asked of the remainder alone (otherwise "ngày 15 tháng 9" would
 *          always look like a period question).
 */
function collectMatches(text) {
  const matches = [];
  const spans = [];
  for (const shape of SHAPES) {
    const re = new RegExp(shape.re.source, shape.re.flags);
    let m;
    while ((m = re.exec(text)) !== null) {
      const from = m.index;
      const to = from + m[0].length;
      // A zero-length match cannot advance `lastIndex` — step over it instead of
      // spinning (the guard is here because this loop walks a built regex).
      if (from === to) {
        re.lastIndex += 1;
        continue;
      }
      // Already claimed by an earlier shape (or overlapping one) — skip.
      if (spans.some(([a, b]) => from < b && to > a)) continue;
      // A number immediately followed by a money word is money, not a day.
      if (MONEY_AFTER_RE.test(text.slice(to, to + 12))) continue;
      spans.push([from, to]);
      matches.push({ raw: m[0].trim(), from, to, shape: shape.name, groups: m.slice(1) });
    }
  }
  matches.sort((a, b) => a.from - b.from);
  return { matches, rest: blankSpans(text, spans) };
}

/* ──────────────────────────── the public read ──────────────────────────── */

function refuse(code, reason) {
  return { ok: false, code, reason };
}

/**
 * Read the day a revenue question names.
 *
 * @param {string} text the sentence the pipeline routed on (`nlp.text`)
 * @param {{today: string}} opts `today` = the SHOP's day (`vnDay()`), required:
 *        this module owns no clock, so the caller's one reading is the only one.
 * @returns {{ok:true, date:string|null} | {ok:false, code:string, reason:string}}
 *          `date: null` means "no day was named" — the caller keeps its default.
 *          Nothing else is returned: the pipeline needs the DAY, and a field
 *          nobody reads is a promise nobody keeps.
 */
export function readDayPhrase(text, { today } = {}) {
  if (typeof today !== "string" || !ISO_RE.test(today)) {
    throw new Error("DAY_PHRASE_TODAY_REQUIRED: today (YYYY-MM-DD, Asia/Ho_Chi_Minh) is required");
  }
  const raw = String(text ?? "");
  const year = Number(today.slice(0, 4));

  const { matches, rest } = collectMatches(raw);

  // ── Relatives, claimed from the same remainder as the written dates ───────
  const relatives = [];
  let rel;
  const relRe = new RegExp(RELATIVE_RE.source, RELATIVE_RE.flags);
  while ((rel = relRe.exec(rest)) !== null) {
    if (rel[0].length === 0) {
      relRe.lastIndex += 1;
      continue;
    }
    const word = (rel[1] ?? rel[2]).toLowerCase().replace(/\s+/g, " ");
    const unaccented = word.replace(/ô/g, "o").replace(/à/g, "a");
    const offset = unaccented === "hom nay" ? 0 : unaccented === "hom qua" ? -1 : -2;
    // `resolved` (not `date`) so a relative day travels through the SAME
    // resolution/ambiguity checks below as a written one.
    relatives.push({ raw: rel[0].trim(), from: rel.index, resolved: addDays(today, offset), shape: "relative" });
  }
  const restNoRel = blankSpans(
    rest,
    relatives.map((r) => [r.from, r.from + r.raw.length]),
  );

  // ── A PERIOD, or a day that cannot be pinned, is refused BEFORE any
  // arithmetic: there is no single day to compute, so nothing below could
  // rescue the sentence — and answering "today" here is the exact silent-wrong
  // -day failure this module exists to prevent.
  if (PERIOD_RE.test(restNoRel)) {
    return refuse(
      DAY_PHRASE_CODES.DAY_PHRASE_PERIOD,
      `hiện chỉ hỏi được doanh thu theo TỪNG NGÀY — chưa hỗ trợ kỳ (tuần/tháng/quý/năm). Ví dụ: "doanh thu ngày 15/9/2026", "doanh thu hôm qua".`,
    );
  }
  if (COUNTED_DAYS_RE.test(restNoRel) && SPAN_MARKER_RE.test(restNoRel)) {
    return refuse(
      DAY_PHRASE_CODES.DAY_PHRASE_PERIOD,
      `hiện chỉ hỏi được doanh thu theo TỪNG NGÀY — chưa hỗ trợ khoảng nhiều ngày. Ví dụ: "doanh thu ngày 15/9/2026".`,
    );
  }
  if (VAGUE_DAY_RE.test(restNoRel)) {
    return refuse(
      DAY_PHRASE_CODES.DAY_PHRASE_INVALID,
      `chưa rõ bạn muốn ngày nào (câu có "hôm/bữa" mà không nêu ngày cụ thể) — nói kèm ngày, ví dụ: "doanh thu ngày 15/9/2026".`,
    );
  }
  const futureWord = FUTURE_DAY_RE.exec(restNoRel);
  if (futureWord) {
    return refuse(
      DAY_PHRASE_CODES.DAY_PHRASE_INVALID,
      `doanh thu chỉ có cho ngày đã qua — "${futureWord[0].trim()}" là ngày chưa tới.`,
    );
  }

  // ── Nothing named: the caller's own default (today) still applies ─────────
  const named = [...matches, ...relatives].sort((a, b) => a.from - b.from);
  if (named.length === 0) return { ok: true, date: null };

  // ── Resolve each written date ─────────────────────────────────────────────
  let yearWasExplicit = false;
  for (const m of named) {
    if (m.shape === "relative") continue;
    const [a, b, c] = m.groups;
    const isYmd = m.shape === "iso";
    const d = Number(isYmd ? c : a);
    const mo = Number(b);
    const y = isYmd ? Number(a) : c === undefined ? null : Number(c);
    if (!isYmd && y !== null && String(c).length !== 4) {
      return refuse(
        DAY_PHRASE_CODES.DAY_PHRASE_INVALID,
        `chưa rõ năm trong "${m.raw}" — ghi đủ 4 chữ số năm, ví dụ: "doanh thu ngày ${d}/${mo}/${year}".`,
      );
    }
    if (!isRealDate(y ?? year, mo, d)) {
      return refuse(
        DAY_PHRASE_CODES.DAY_PHRASE_INVALID,
        `"${m.raw}" không phải một ngày có thật — kiểm lại ngày/tháng (ví dụ: "doanh thu ngày 15/9/${year}").`,
      );
    }
    if (y !== null) yearWasExplicit = true;
    m.resolved = iso(y ?? year, mo, d);
  }

  const distinct = [...new Set(named.map((m) => m.resolved))];
  if (distinct.length > 1) {
    return refuse(
      DAY_PHRASE_CODES.DAY_PHRASE_INVALID,
      `câu này nêu nhiều ngày khác nhau (${distinct.join(", ")}) — mỗi lần chỉ hỏi doanh thu của MỘT ngày.`,
    );
  }

  const date = distinct[0];
  if (date > today) {
    return refuse(
      DAY_PHRASE_CODES.DAY_PHRASE_INVALID,
      yearWasExplicit
        ? `ngày ${date} chưa tới — doanh thu chỉ có cho ngày đã qua.`
        : `ngày ${date} chưa tới trong năm ${year}, và câu không nêu năm nên chưa rõ bạn muốn ngày nào — nói kèm năm (4 chữ số), ví dụ: "doanh thu ngày ${date.slice(8, 10)}/${date.slice(5, 7)}/${year - 1}".`,
    );
  }

  return { ok: true, date };
}
