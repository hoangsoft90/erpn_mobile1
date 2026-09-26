/**
 * A3 (`.plan/next3/implementation.md` workstream A) — HÓA ĐƠN ĐIỆN TỬ **PDF**.
 *
 * WHAT THIS IS, IN ONE SENTENCE: the same output the XML channel produces
 * (`src/einvoice/einvoice-xml.mjs`), read from a PDF with a TEXT LAYER instead of
 * from XML — so a supplier's PDF travels the ONE existing pipeline (slots → form →
 * composed sentence → `/ask` → capability from the contract → proposal → confirm →
 * Safety Gateway → DRAFT). Nothing here writes, prices, or resolves master data.
 *
 * THE RULE THAT SHAPES EVERY DECISION BELOW: a number that was not read is NEVER
 * filled in. A row whose own arithmetic does not close is not "a row we mostly
 * understood" — it is a row we could not read, and it becomes a PROBLEM (which the
 * caller turns into a refusal) rather than a plausible-looking line the user would
 * confirm without seeing the gap. This is the same stance as A1, for the same
 * reason: a wrong quantity or amount in a purchase document is a real loss.
 *
 * TWO LAYERS, so each can be tested without the other:
 *
 *   1. `extractPdfText(bytes)` — bytes → visual lines. A deliberately small PDF
 *      reader: object scan (no xref trust), FlateDecode via stdlib `zlib` (this
 *      package stays dependency-free — operating_rules §13), content-stream text
 *      operators, and ToUnicode CMaps (the ONLY way a CID/Type0 font's 2-byte
 *      codes become Unicode, and therefore the only way Vietnamese diacritics come
 *      out right). FlateDecode is used for CONTENT ONLY: a /DCTDecode image is not
 *      text, and this reader never pretends otherwise.
 *   2. `extractEinvoiceFields(lines)` — visual lines → the header/lines/problems
 *      object. Pure text work, tested against GOLDEN text as well as against the
 *      bytes above, because real provider texts disagree about layout far more
 *      than they disagree about the PDF format.
 *
 * WHAT IT REFUSES INSTEAD OF GUESSING (each one a code with a Vietnamese reason):
 *  - a file that is not a PDF                       (NOT_A_PDF)
 *  - a file over the contract's byte cap            (TOO_LARGE)
 *  - a file carrying /Encrypt                       (ENCRYPTED — reading it anyway
 *    is how mojibake turns into an invoice number)
 *  - a PDF with NO text layer (a scan)               (NO_TEXT — the answer is the
 *    camera path C, never an invented reading)
 *  - a PDF whose objects live in a compressed object stream and yielded nothing
 *    (COMPRESSED_OBJECTS — said by name so the user is not sent to the camera for
 *    a file that is perfectly digital)
 *  - text whose font has no ToUnicode CMap           (TEXT_UNMAPPED — glyph ids are
 *    not characters; the honest answer is "cannot read", not a guess at them)
 *  - a stream compressed with something else          (UNSUPPORTED_FILTER)
 *
 * NUMBER FORMAT, AND WHY IT IS NOT A1'S RULE: on a Vietnamese invoice PRINTED on
 * paper, '.' groups thousands and ',' is the decimal mark ("2.950.000", "10,5") —
 * the OPPOSITE of the XML spec (`QĐ 1450/QĐ-TCT`), where '.' IS the decimal mark.
 * So `strictNumber` is not reused here: the same string means different numbers in
 * the two channels, and one shared reader would silently be wrong in one of them.
 * A token that has two possible readings ("1.234") is returned as BOTH, and the
 * ROW'S OWN ARITHMETIC (qty × rate = amount) settles it. When it cannot settle it,
 * the row is a problem — never a preference.
 *
 * TOTALS ARE DISPLAY-ONLY, and are read the same way: a printed money amount uses
 * the thousands reading, and where the document's own rows can confirm it, the
 * reading closest to the sum of those rows wins. A total changes no rate anywhere
 * in this project (`rate_source: erpnext`), so this choice cannot move money.
 */

import { inflateSync } from "node:zlib";
import { sanitizeUntrustedText } from "../untrusted-data.mjs";
import { EINVOICE_CODES, EinvoiceError } from "./einvoice-xml.mjs";

/** File-level refusals. Field-level ones reuse `EINVOICE_CODES` (one vocabulary). */
export const PDF_CODES = Object.freeze({
  NOT_A_PDF: "EINVOICE_PDF_NOT_A_PDF",
  TOO_LARGE: "EINVOICE_PDF_TOO_LARGE",
  /**
   * A stream that inflates past the policy's OUTPUT cap. Separate from TOO_LARGE
   * (which is about the file the user sent) because the two need different advice:
   * `TOO_LARGE` means "send a smaller file", this means "this is not an invoice".
   */
  INFLATED_TOO_LARGE: "EINVOICE_PDF_INFLATED_TOO_LARGE",
  /**
   * More TEXT lines than any invoice has (L1). Separate from the layer-2 row cap
   * (`EINVOICE_LINE_LIMIT`, a `problem` reported after the fact) because that one
   * can only fire once every line has already been built.
   */
  TOO_MANY_LINES: "EINVOICE_PDF_TOO_MANY_LINES",
  ENCRYPTED: "EINVOICE_PDF_ENCRYPTED",
  NO_TEXT: "EINVOICE_PDF_NO_TEXT",
  COMPRESSED_OBJECTS: "EINVOICE_PDF_COMPRESSED_OBJECTS",
  TEXT_UNMAPPED: "EINVOICE_PDF_TEXT_UNMAPPED",
  UNSUPPORTED_FILTER: "EINVOICE_PDF_UNSUPPORTED_FILTER",
  BROKEN: "EINVOICE_PDF_BROKEN",
});

/** Warnings the form shows beside the fields (never a silent claim). */
export const PDF_WARNING_CODES = Object.freeze({
  MST_UNLABELLED: "PDF_MST_UNLABELLED",
  UNIT_GUESSED_FROM_TEXT: "PDF_UNIT_FROM_TEXT",
});

/** `einvoice_policy` numbers, handed in so this module stays pure (no contract import). */
export function pdfLimits(policy = null) {
  return {
    maxPdfBytes: Number.isInteger(policy?.max_pdf_bytes) ? policy.max_pdf_bytes : 650_000,
    maxLines: Number.isInteger(policy?.max_lines) ? policy.max_lines : 200,
    /** Cap on one stream's DECOMPRESSED size — a different number from the file cap. */
    maxInflatedBytes: Number.isInteger(policy?.max_inflated_bytes) ? policy.max_inflated_bytes : 8_000_000,
    /**
     * Cap on TEXT lines built in layer 1 (L1). Derived from `max_lines` (the row
     * cap) rather than a new policy knob nobody would set: a real invoice is ~90
     * text lines per page, so even a five-page one is ~450 — 200 × 100 is 40×
     * headroom, while 8 MB of `T*` operators is ~4 million lines, i.e. a file that
     * has nothing to do with an invoice. It exists because `max_lines` alone
     * cannot protect anything: it is checked in layer 2, after the array is built.
     */
    maxTextLines: (Number.isInteger(policy?.max_lines) ? policy.max_lines : 200) * 100,
  };
}

/* ─────────────────────────────────────────────────────────────────────────────
 * LAYER 1 — bytes → visual lines
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * How wide a `TJ` gap must be to count as a SPACE (thousandths of an em).
 *
 * A real space is ~250–350/1000 of the font size; kerning between letter pairs is
 * routinely −10…−200. Treating kerning as a space SPLITS WORDS — measured on the
 * WinAnsi fixture, where a −150 pair turned "Nguoi ban" into "Nguoi ba n" and cut
 * an MST into "030 0000002" — so the threshold sits at a quarter of an em, and a
 * narrower gap moves nothing.
 */
const PDF_SPACE_GAP = -250;

/**
 * The request carries base64 in JSON (the same body shape the XML channel uses,
 * so the route keeps ONE body parser). Base64 inflates by 4/3, which is why the
 * policy cap is set where it is — see `max_pdf_bytes` in capabilities.json.
 *
 * A `data:` URL prefix is tolerated because clients paste them; anything else
 * that is not base64 is refused by the `%PDF-` check right after.
 *
 * @param {string|Uint8Array} input
 * @returns {Buffer}
 */
export function toPdfBuffer(input) {
  if (typeof input === "string") {
    const cleaned = input.replace(/\s+/g, "").replace(/^data:[^,]*,/, "");
    if (cleaned === "" || !/^[A-Za-z0-9+/]+={0,2}$/.test(cleaned)) {
      throw new EinvoiceError(PDF_CODES.NOT_A_PDF, "nội dung gửi lên không phải dữ liệu PDF (base64) hợp lệ");
    }
    return Buffer.from(cleaned, "base64");
  }
  if (input instanceof Uint8Array) return Buffer.from(input);
  throw new EinvoiceError(PDF_CODES.NOT_A_PDF, "file PDF phải được gửi dưới dạng base64");
}

/** `%PDF-` within the first 1 KB (the format allows leading junk), else refuse. */
function pdfStartOffset(buf) {
  const head = buf.subarray(0, 1024).toString("latin1");
  return head.indexOf("%PDF-");
}

/**
 * Decode one stream's bytes. FlateDecode is the only filter this reader knows:
 * `/DCTDecode` (a JPEG page image) means there is no text to read, and a filter we
 * do not implement must be NAMED rather than silently yielding nothing.
 *
 * @param {Buffer} raw the bytes between `stream` and `endstream`
 * @param {string} dictText the stream's dictionary
 * @param {{maxInflatedBytes:number}} limits the policy's OUTPUT cap
 * @returns {Buffer}
 */
function decodeStream(raw, dictText, limits) {
  const filters = [...dictText.matchAll(/\/Filter\s*(\[[^\]]*\]|\/\w+)/g)].map((m) => m[1]).join(" ");
  if (filters === "" || /\/FlateDecode/.test(filters)) {
    if (!/\/FlateDecode/.test(filters)) return raw;
    try {
      // A cap on the bytes the user SENT is not a cap on the bytes zlib PRODUCES.
      // Measured before this line existed: a 106.884-byte stream inflated to
      // 31.457.284 bytes (294×) in 4,3 s and cost +541 MB of RSS, and the row cap
      // (`maxLines`) only fires AFTER every line has been built — far too late to
      // protect anything. `maxOutputLength` makes zlib ABORT mid-inflation, and
      // the refusal is NAMED so the user is told this is not an ordinary invoice
      // instead of being sent to the camera for a file that is perfectly digital.
      return inflateSync(raw, { maxOutputLength: limits.maxInflatedBytes });
    } catch (err) {
      if (err?.code === "ERR_BUFFER_TOO_LARGE") {
        throw new EinvoiceError(
          PDF_CODES.INFLATED_TOO_LARGE,
          `nội dung nén bên trong PDF phình quá trần ${limits.maxInflatedBytes} byte khi giải nén — file này không giống hoá đơn thông thường nên không đọc tiếp`,
        );
      }
      // A stream that claims FlateDecode and is not: refuse loudly. (Empty or
      // already-inflated streams exist in the wild, but "cannot decode" is the
      // honest state, and a partially decoded stream is worse than none.)
      throw new EinvoiceError(PDF_CODES.UNSUPPORTED_FILTER, "stream PDF khai FlateDecode nhưng không giải nén được");
    }
  }
  if (/\/DCTDecode|\/JPXDecode|\/JBIG2Decode|\/CCITTFaxDecode/.test(filters)) {
    throw new EinvoiceError(
      PDF_CODES.NO_TEXT,
      "trang PDF là ẢNH (không có lớp chữ) — dùng nút camera để đọc hoá đơn, hoặc nhập tay",
    );
  }
  throw new EinvoiceError(
    PDF_CODES.UNSUPPORTED_FILTER,
    `PDF dùng bộ lọc nén chưa hỗ trợ (${filters.trim()}) — nhập tay hoặc dùng ảnh/OCR`,
  );
}

/**
 * Literal string `(...)` with balanced parens and backslash escapes.
 *
 * `start` points at the first character INSIDE the string, so the depth counter
 * starts at 1 — starting it at 0 makes the closing paren look like an opening one,
 * and the reader then swallows the rest of the stream as one string (measured: a
 * `[(A) -150 (B)] TJ` line made the whole content stream unusable).
 */
function readLiteralString(src, start) {
  let depth = 1;
  let out = "";
  for (let i = start; i < src.length; i++) {
    const ch = src[i];
    if (ch === "\\") {
      const next = src[i + 1];
      const simple = { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", "(": "(", ")": ")", "\\": "\\" };
      if (next in simple) {
        out += simple[next];
        i += 1;
      } else if (next >= "0" && next <= "7") {
        let oct = "";
        let j = i + 1;
        while (j < src.length && oct.length < 3 && src[j] >= "0" && src[j] <= "7") oct += src[j++];
        out += String.fromCharCode(parseInt(oct, 8) & 0xff);
        i = j - 1;
      } else {
        i += 1;
      }
      continue;
    }
    if (ch === "(") {
      depth += 1;
      out += ch;
      continue;
    }
    if (ch === ")") {
      depth -= 1;
      if (depth === 0) return { value: out, end: i };
      out += ch;
      continue;
    }
    out += ch;
  }
  return { value: out, end: src.length };
}

/** Hex string `<48656c6c6f>` → bytes. */
function readHexString(src, start) {
  const end = src.indexOf(">", start);
  const body = src.slice(start, end === -1 ? src.length : end).replace(/[^0-9A-Fa-f]/g, "");
  const padded = body.length % 2 === 1 ? `${body}0` : body;
  return { value: Buffer.from(padded, "hex"), end: end === -1 ? src.length : end };
}

/**
 * Tokenize a content stream into operands and (array) operands. Enough of the
 * format for text: numbers, names, literal/hex strings, `[ … ]`, and operators.
 * Anything else (inline images, dictionaries) is skipped as an operand-less op.
 *
 * @param {Buffer} content
 * @returns {{op:string, operands:unknown[]}[]}
 */
function tokenizeContent(content) {
  const src = content.toString("latin1");
  const ops = [];
  const stack = [];
  let i = 0;
  let array = null;
  while (i < src.length) {
    const ch = src[i];
    if (ch === " " || ch === "\n" || ch === "\r" || ch === "\t" || ch === "\f" || ch === "\0") {
      i += 1;
      continue;
    }
    if (ch === "%") {
      const nl = src.indexOf("\n", i);
      i = nl === -1 ? src.length : nl + 1;
      continue;
    }
    if (ch === "(") {
      const { value, end } = readLiteralString(src, i + 1);
      (array ?? stack).push({ str: Buffer.from(value, "latin1") });
      i = end + 1;
      continue;
    }
    if (ch === "<" && src[i + 1] !== "<") {
      const { value, end } = readHexString(src, i + 1);
      (array ?? stack).push({ str: value });
      i = end + 1;
      continue;
    }
    if (ch === "[") {
      array = [];
      i += 1;
      continue;
    }
    if (ch === "]") {
      const arr = array ?? [];
      array = null;
      stack.push(arr);
      i += 1;
      continue;
    }
    if (ch === "/") {
      let j = i + 1;
      while (j < src.length && !/[\s/<>[\]()]/.test(src[j])) j += 1;
      stack.push(src.slice(i, j));
      i = j;
      continue;
    }
    if (ch === "<" && src[i + 1] === "<") {
      // An inline dictionary (e.g. a BDC property list): skip to its matching `>>`.
      let depth = 0;
      let j = i;
      while (j < src.length) {
        if (src.startsWith("<<", j)) {
          depth += 1;
          j += 2;
          continue;
        }
        if (src.startsWith(">>", j)) {
          depth -= 1;
          j += 2;
          if (depth === 0) break;
          continue;
        }
        j += 1;
      }
      i = j;
      continue;
    }
    const numMatch = /^[+-]?(\d+\.?\d*|\.\d+)/.exec(src.slice(i));
    if (numMatch) {
      // Into the CURRENT array when one is open — a `TJ` array is `[<str> <num> …]`
      // and its numbers are spacing, not stray operands of the next operator.
      (array ?? stack).push(Number(numMatch[0]));
      i += numMatch[0].length;
      continue;
    }
    const opMatch = /^[A-Za-z'"*][A-Za-z0-9'"*]*/.exec(src.slice(i));
    if (opMatch) {
      ops.push({ op: opMatch[0], operands: stack.splice(0, stack.length) });
      i += opMatch[0].length;
      continue;
    }
    // An operator we do not model (BI/EI data, TZ…) — drop the token, keep going.
    i += 1;
  }
  return ops;
}

/**
 * A font resource → how to turn its bytes back into characters.
 *
 * `map` is a `Map<number, string>` for 2-byte codes, or null for a simple font
 * (whose bytes ARE characters). `codeLen` is 1 for simple fonts, 2 when the CMap
 * declared a 2-byte codespace.
 */
function fontDecoder(fromUnicode, { unmappedFont = false } = {}) {
  return { map: fromUnicode, codeLen: fromUnicode ? 2 : 1, unmappedFont };
}

/** Parse a ToUnicode CMap stream: `beginbfchar` blocks and `beginbfrange` rows. */
export function parseToUnicodeCMap(text) {
  const map = new Map();
  const source = String(text ?? "");
  for (const block of source.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const pair of block[1].matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) {
      const code = parseInt(pair[1], 16);
      const value = pair[2];
      // A destination longer than one UTF-16 unit is a ligature/sequence: keep it
      // whole (String.fromCharCode per unit would split it into mojibake).
      const units = [];
      for (let i = 0; i + 4 <= value.length && units.length < 8; i += 4) units.push(parseInt(value.slice(i, i + 4), 16));
      map.set(code, String.fromCharCode(...units));
    }
  }
  for (const block of source.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    for (const row of block[1].matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*(<[0-9A-Fa-f]+>|\[[^\]]*\])/g)) {
      const lo = parseInt(row[1], 16);
      const hi = parseInt(row[2], 16);
      if (row[3].startsWith("[")) {
        const items = [...row[3].matchAll(/<([0-9A-Fa-f]+)>/g)].map((m) => m[1]);
        items.forEach((hex, idx) => {
          if (lo + idx > hi) return;
          const units = [];
          for (let i = 0; i + 4 <= hex.length; i += 4) units.push(parseInt(hex.slice(i, i + 4), 16));
          map.set(lo + idx, String.fromCharCode(...units));
        });
      } else {
        const start = parseInt(row[3].slice(1, -1), 16);
        // Bounded: a hostile range must not allocate a million entries.
        for (let code = lo; code <= Math.min(hi, lo + 4096); code++) {
          map.set(code, String.fromCharCode(start + (code - lo)));
        }
      }
    }
  }
  const hasCidRange = /begincidrange/.test(source);
  return { map: map.size > 0 ? map : null, hasCidRange };
}

/** All `N G obj … endobj` blocks, with a stream's bytes sliced out when present. */
function scanObjects(buf) {
  const text = buf.toString("latin1");
  const objects = new Map();
  const re = /(\d+)\s+(\d+)\s+obj\b/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const num = Number(m[1]);
    const start = m.index + m[0].length;
    const objEnd = text.indexOf("endobj", start);
    const limit = objEnd === -1 ? text.length : objEnd;
    const streamAt = text.indexOf("stream", start);
    let dictText = text.slice(start, Math.min(limit, streamAt === -1 ? limit : streamAt));
    let stream = null;
    if (streamAt !== -1 && streamAt < limit) {
      let dataStart = streamAt + "stream".length;
      if (text[dataStart] === "\r") dataStart += 1;
      if (text[dataStart] === "\n") dataStart += 1;
      const dictLen = Number(/\/Length\s+(\d+)/.exec(dictText)?.[1]);
      let dataEnd;
      if (Number.isFinite(dictLen) && dictLen >= 0 && dataStart + dictLen <= buf.length) {
        dataEnd = dataStart + dictLen;
      } else {
        const at = text.indexOf("endstream", dataStart);
        dataEnd = at === -1 ? limit : at;
        // Trim the EOL that precedes `endstream` (it is not stream data).
        while (dataEnd > dataStart && /[\r\n]/.test(text[dataEnd - 1])) dataEnd -= 1;
      }
      stream = buf.subarray(dataStart, dataEnd);
      dictText += text.slice(streamAt, Math.min(limit, dataEnd));
    }
    if (!objects.has(num)) objects.set(num, { num, dict: dictText, stream });
    re.lastIndex = start;
  }
  return objects;
}

/** `12 0 R` → object 12; an inline value is returned as-is. */
function resolveRef(objects, value) {
  const ref = /^\s*(\d+)\s+\d+\s+R\s*$/.exec(String(value ?? ""));
  if (ref) return objects.get(Number(ref[1])) ?? null;
  return null;
}

/**
 * A key's value as an OBJECT when it is an indirect reference (`/ToUnicode 7 0 R`),
 * else null. Kept separate from [dictOf] on purpose: callers that need the object
 * itself (a CMap STREAM, a page's `/Contents`) must not be handed its dictionary
 * text — that confusion is exactly how a font silently reads as unmapped.
 */
function refTarget(objects, dictText, key) {
  const ref = new RegExp(`/${key}\\s+(\\d+)\\s+\\d+\\s+R`, "m").exec(dictText);
  return ref ? (objects.get(Number(ref[1])) ?? null) : null;
}

/** The dictionary text for a key, inline (`<<…>>`) or through a reference. */
function dictOf(objects, dictText, key) {
  const inline = new RegExp(`/${key}\\s*(<<[\\s\\S]*?>>)`, "m").exec(dictText);
  if (inline) return inline[1];
  return refTarget(objects, dictText, key)?.dict ?? "";
}

/**
 * Bytes → visual lines, one string per rendered line.
 *
 * Line breaks come from the TEXT POSITION, not from the operators: a provider
 * lays a table out with `Td`/`Tm` moves, and two `Tj` calls on the same y are one
 * visual line (two cells), while a y change is a new line. That is what makes
 * "MST: 0300000002" below "Người bán: …" read as two lines instead of one, and
 * what keeps a two-column header on one.
 *
 * @param {string|Uint8Array} input base64, or bytes (tests)
 * @param {{policy?:object}} [opts]
 * @returns {{lines:string[], text:string, pages:number, fontsMapped:number, unmappedChars:number}}
 */
export function extractPdfText(input, { policy = null } = {}) {
  const limits = pdfLimits(policy);
  const buf = toPdfBuffer(input);
  if (buf.length > limits.maxPdfBytes) {
    throw new EinvoiceError(
      PDF_CODES.TOO_LARGE,
      `file PDF ${buf.length} byte vượt trần ${limits.maxPdfBytes} của einvoice_policy — gửi đúng hoá đơn, không gửi kèm phụ lục/ảnh quét`,
    );
  }
  const offset = pdfStartOffset(buf);
  if (offset === -1) {
    throw new EinvoiceError(
      PDF_CODES.NOT_A_PDF,
      "file không phải PDF (thiếu chữ ký %PDF-) — kiểm lại định dạng file trước khi gửi",
    );
  }
  const body = buf.subarray(offset);
  const raw = body.toString("latin1");
  if (/\/Encrypt\b/.test(raw)) {
    throw new EinvoiceError(
      PDF_CODES.ENCRYPTED,
      "file PDF có dấu hiệu mã hoá/đặt mật khẩu (/Encrypt) — chưa đọc được nội dung; dùng bản không khoá hoặc nhập tay",
    );
  }

  const objects = scanObjects(body);
  // The page objects, in file order. Their /Contents is the text to read.
  const pages = [...objects.values()].filter((o) => /\/Type\s*\/Page\b(?!s)/.test(o.dict));
  const contentStreams = [];
  const fontResources = new Map();
  for (const page of pages) {
    // `/Contents` is a single ref or an ARRAY of refs (a page split into several
    // streams is normal), and in both cases the object itself is what is needed.
    const contentsInline = /\/Contents\s*\[([^\]]*)\]/.exec(page.dict);
    const contentRefs = contentsInline
      ? [...contentsInline[1].matchAll(/(\d+)\s+\d+\s+R/g)].map((m) => Number(m[1]))
      : [refTarget(objects, page.dict, "Contents")?.num].filter((n) => typeof n === "number");
    for (const num of contentRefs) {
      const obj = objects.get(num);
      if (obj?.stream) contentStreams.push(obj);
    }
    // /Resources may be inline or a reference, and may sit on the page or an
    // ancestor — a page that declares none inherits its parent's.
    let resourceDict = dictOf(objects, page.dict, "Resources");
    let parent = refTarget(objects, page.dict, "Parent");
    for (let depth = 0; resourceDict === "" && parent && depth < 3; depth++) {
      resourceDict = dictOf(objects, parent.dict, "Resources");
      parent = refTarget(objects, parent.dict, "Parent");
    }
    const fontDict = dictOf(objects, resourceDict, "Font");
    for (const entry of fontDict.matchAll(/\/([^\s/<>[\]()]+)\s+(\d+)\s+\d+\s+R/g)) {
      fontResources.set(entry[1], Number(entry[2]));
    }
  }

  /** resource name → decoder */
  const decoders = new Map();
  let fontsMapped = 0;
  const decoderFor = (name) => {
    if (decoders.has(name)) return decoders.get(name);
    const obj = objects.get(fontResources.get(name));
    let decoder = fontDecoder(null);
    if (obj) {
      const cmapObj = refTarget(objects, obj.dict, "ToUnicode");
      if (cmapObj?.stream) {
        const { map } = parseToUnicodeCMap(cmapObj.stream.toString("latin1"));
        if (map) {
          decoder = fontDecoder(map);
          fontsMapped += 1;
        }
      }
      if (!decoder.map) {
        // A composite (Type0/CID) font WITHOUT a ToUnicode CMap: its bytes are
        // GLYPH INDICES, not characters. Decoding them as latin1 would manufacture
        // plausible-looking letters — the exact "invented content" this module
        // exists to prevent — so this font yields NOTHING and is counted, which
        // turns into a named refusal when it was the only text in the file.
        const composite = /\/Subtype\s*\/Type0|\/Identity-[HV]/.test(obj.dict);
        decoder = fontDecoder(null, { unmappedFont: composite });
      }
    }
    decoders.set(name, decoder);
    return decoder;
  };

  // No page object found (a broken or object-stream-only file): fall back to every
  // stream that looks like content, with NO font map — a simple-font file still
  // reads, and a CID file then reports TEXT_UNMAPPED instead of inventing letters.
  if (contentStreams.length === 0) {
    for (const obj of objects.values()) {
      if (!obj.stream) continue;
      const decoded = /FlateDecode/.test(obj.dict) ? decodeStream(obj.stream, obj.dict, limits) : obj.stream;
      if (/\bBT\b/.test(decoded.toString("latin1"))) contentStreams.push(obj);
    }
  }

  const lines = [];
  let unmappedChars = 0;
  for (const obj of contentStreams) {
    const content = /FlateDecode/.test(obj.dict) ? decodeStream(obj.stream, obj.dict, limits) : obj.stream;
    let decoder = fontDecoder(null);
    let x = 0;
    let y = 0;
    let leading = 0;
    let lastY = null;
    let pendingSpace = false;
    let current = "";
    const flush = () => {
      const line = sanitizeUntrustedText(current, { maxLength: 2000 });
      if (line !== "") lines.push(line);
      current = "";
      // L1: refuse DURING construction. Measured before this check existed: a
      // compressed stream under the file cap produced 341.927 lines and the row
      // cap only popped it back to 200 afterwards — the array, not the row count,
      // is what the memory went into. A refusal (not a truncation) for the same
      // reason as every other limit here: a partially read invoice is a wrong one.
      if (lines.length > limits.maxTextLines) {
        throw new EinvoiceError(
          PDF_CODES.TOO_MANY_LINES,
          `PDF có hơn ${limits.maxTextLines} dòng chữ sau khi giải nén — file này không giống hoá đơn thông thường nên không đọc tiếp; dùng nút camera hoặc nhập tay`,
        );
      }
    };
    const show = (bytes) => {
      let text = "";
      if (decoder.unmappedFont) {
        unmappedChars += bytes.length;
        return;
      }
      if (decoder.map) {
        for (let i = 0; i + 1 < bytes.length; i += 2) {
          const code = bytes.readUInt16BE(i);
          const mapped = decoder.map.get(code);
          if (mapped === undefined) unmappedChars += 1;
          else text += mapped;
        }
      } else {
        text = bytes.toString("latin1");
      }
      if (text === "") return;
      if (lastY === null || Math.abs(y - lastY) > 0.5) {
        flush();
      } else if (pendingSpace && !current.endsWith(" ")) {
        current += " ";
      }
      current += text;
      lastY = y;
      pendingSpace = false;
    };

    for (const { op, operands } of tokenizeContent(content)) {
      switch (op) {
        case "Tf": {
          const name = operands.find((o) => typeof o === "string" && o.startsWith("/"));
          decoder = decoderFor(name ? name.slice(1) : "");
          break;
        }
        case "Tm": {
          const nums = operands.filter((o) => typeof o === "number");
          if (nums.length >= 6) {
            if (Math.abs(nums[5] - y) > 0.5 || Math.abs(nums[4] - x) > 0.5) pendingSpace = true;
            x = nums[4];
            y = nums[5];
          }
          break;
        }
        case "Td":
        case "TD": {
          const nums = operands.filter((o) => typeof o === "number");
          if (nums.length >= 2) {
            if (Math.abs(nums[0]) > 0.5) pendingSpace = true;
            x += nums[0];
            y += nums[1];
            if (op === "TD") leading = -nums[1];
          }
          break;
        }
        case "TL": {
          const n = operands.find((o) => typeof o === "number");
          if (typeof n === "number") leading = n;
          break;
        }
        case "T*": {
          y -= leading;
          pendingSpace = false;
          break;
        }
        case "Tj":
        case "'":
        case '"': {
          if (op !== "Tj") {
            y -= leading;
            pendingSpace = false;
          }
          const piece = [...operands].reverse().find((o) => o && typeof o === "object" && "str" in o);
          if (piece) show(piece.str);
          break;
        }
        case "TJ": {
          const arr = operands.find((o) => Array.isArray(o)) ?? [];
          for (const item of arr) {
            if (item && typeof item === "object" && "str" in item) {
              show(item.str);
            } else if (typeof item === "number" && item <= PDF_SPACE_GAP) {
              pendingSpace = true;
            }
          }
          break;
        }
        case "BT": {
          x = 0;
          y = 0;
          lastY = null;
          pendingSpace = false;
          break;
        }
        case "ET": {
          flush();
          lastY = null;
          break;
        }
        default:
          break;
      }
    }
    flush();
  }

  const text = lines.join("\n");
  if (text.trim() === "") {
    // Three different situations, three different sentences — sending the user to
    // the camera for a perfectly digital file (a compressed-object PDF) would be
    // the wrong instruction, and calling an unmappable font "a scan" would hide
    // the real reason entirely.
    if (unmappedChars > 0) {
      throw new EinvoiceError(
        PDF_CODES.TEXT_UNMAPPED,
        "font trong PDF không khai bảng ánh xạ Unicode (ToUnicode) nên không đọc được chữ — dùng ảnh/OCR hoặc nhập tay",
      );
    }
    const compressed = /\/ObjStm\b|\/Type\s*\/XRef/.test(raw);
    throw new EinvoiceError(
      compressed ? PDF_CODES.COMPRESSED_OBJECTS : PDF_CODES.NO_TEXT,
      compressed
        ? "PDF lưu đối tượng trong object stream nén (ObjStm) — chưa đọc được lớp chữ; dùng ảnh/OCR hoặc nhập tay"
        : "PDF không có lớp chữ đọc được (bản scan/ảnh) — dùng nút camera để đọc hoá đơn, hoặc nhập tay",
    );
  }
  return { lines, text, pages: pages.length, fontsMapped, unmappedChars };
}

/* ─────────────────────────────────────────────────────────────────────────────
 * LAYER 2 — visual lines → header + lines + problems
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Length-preserving, CASE- and diacritic-insensitive form of a line, for LABEL
 * matching only: a provider prints "Người bán", "Nguoi ban" or a decomposed
 * "Người ba\u0301n", and the label list must not care which.
 *
 * Two properties are load-bearing:
 *  - length-preserving, so a value can be taken from the ORIGINAL line by the
 *    index the label matched at — this function never adds an accent or a letter
 *    back into a name, it only ever produces a SEPARATE string for searching;
 *  - lower-casing is part of the fold (not a flag on each regex) because the
 *    label list is written in plain lower-case words: a regex list that has to
 *    remember `/i` per entry is a list that will one day forget it, and the
 *    failure mode is a MISSING invoice number, silently.
 */
export function foldVietnamese(value) {
  const src = String(value ?? "");
  let out = "";
  for (const ch of src) {
    if (ch === "đ" || ch === "Đ") {
      out += "d";
      continue;
    }
    out += ch.normalize("NFD")[0].toLowerCase();
  }
  // A character whose fold is longer than itself (a rare multi-mark letter) would
  // break index alignment, so that line is left unfolded — matching then simply
  // behaves as it did before folding, which is the safe direction.
  return out.length === src.length ? out : src;
}

/**
 * A number AS PRINTED on a Vietnamese invoice. Returns EVERY reading the string
 * admits — `[295000, 295]` for "295.000" — because only the caller (which knows
 * the row's arithmetic) can settle which one the document meant.
 *
 * @param {unknown} raw
 * @returns {number[]} [] when the token is not a number at all
 */
export function pdfNumberReadings(raw) {
  let text = String(raw ?? "").trim();
  if (text === "") return [];
  // Trailing punctuation is the document's, not the number's: a label that ends
  // the line prints "4.200.000:" / "4.200.000." and a currency prints "…đ".
  text = text
    .replace(/^\(|\)$/g, "")
    .replace(/[%đĐ:;,.]+$/, "")
    .replace(/vnd|vnđ/i, "")
    .trim();
  if (text === "") return [];
  const negative = /^-/.test(text);
  text = text.replace(/^-/, "");
  const readings = [];
  if (/^\d+$/.test(text)) {
    readings.push(Number(text));
  } else if (/^\d{1,3}(\.\d{3})+$/.test(text)) {
    readings.push(Number(text.replace(/\./g, ""))); // groups of three ⇒ thousands
    readings.push(Number(text)); // or a plain decimal (".000" is a legal fraction)
  } else if (/^\d+,\d{1,4}$/.test(text)) {
    readings.push(Number(text.replace(",", ".")));
  } else if (/^\d+\.\d{1,4}$/.test(text)) {
    readings.push(Number(text));
  } else {
    return [];
  }
  // Non-finite readings are DROPPED, not returned: the decimal reading of
  // "4.200.000" is `Number("4.200.000")` = NaN (two dots), and a NaN candidate
  // would poison the arithmetic that is supposed to SETTLE the ambiguity.
  const finite = readings.filter((n) => Number.isFinite(n));
  return negative ? finite.map((n) => -n) : finite;
}

/** The one reading a DISPLAY-ONLY money field should use (see the header note). */
function preferredMoneyReading(raw, reference = null) {
  const readings = pdfNumberReadings(raw);
  if (readings.length === 0) return null;
  if (readings.length === 1) return readings[0];
  if (reference != null && Number.isFinite(reference)) {
    const closest = [...readings].sort((a, b) => Math.abs(a - reference) - Math.abs(b - reference))[0];
    if (Math.abs(closest - reference) < Math.abs(readings[0] - reference)) return closest;
  }
  return readings[0];
}

/**
 * `dd/mm/yyyy` (the Vietnamese printed convention), `ngày X tháng Y năm Z`, or an
 * ISO date → `YYYY-MM-DD`, or null.
 *
 * The rule when both components are ≤ 12: dd/mm wins, because that is the order
 * this document type is printed in and the one the tax authority's own form uses.
 * A date that is invalid in that order (e.g. "20/31/2026") is NOT reinterpreted as
 * mm/dd — it becomes a problem, because a silently swapped day and month is a
 * different document to the dedupe key.
 */
export function pdfDateToIso(raw) {
  const text = String(raw ?? "").trim();
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (iso) return calendarOrNull(Number(iso[1]), Number(iso[2]), Number(iso[3]));
  const dmy = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(text);
  if (dmy) return calendarOrNull(Number(dmy[3]), Number(dmy[2]), Number(dmy[1]));
  return null;
}

/** Round-trip through Date so "2026-02-30" cannot pass as a date. */
function calendarOrNull(y, m, d) {
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  const iso = `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  const parsed = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString().slice(0, 10) === iso ? iso : null;
}

const LABELS = Object.freeze({
  seller: /\b(nguoi ban|don vi ban hang|nguoi ban hang|ben ban|seller)\b/,
  buyer: /\b(nguoi mua|don vi mua hang|nguoi mua hang|ho ten nguoi mua|ben mua|buyer)\b/,
  taxId: /\b(ma so thue|mst)\b\s*[:.]?\s*/,
  // `so` ALONE is not a label: on a real invoice "mã số thuế" and "in số bản" both
  // contain it. Measured with the bare alternative in this pattern: the trap line
  // "Mã số thuế: 0300000002" standing above "Số: 0000049" answered
  // `invoice_no = "thu"` (the token cut mid-diacritic) while `complete` stayed
  // true — a garbage identity reaching the document AND the duplicate key of
  // workstream B. Specific labels stay specific; the bare one is gated in
  // `readInvoiceNo` and cannot reach a value from the next line.
  invoiceNo: /\b(so hoa don|so hd)\b\s*[:.]?\s*/g,
  invoiceNoBare: /\bso\b\s*[:.]?\s*/g,
  date: /\b(ngay|date)\b/,
  series: /\b(ky hieu|kieu so|khdon)\b\s*[:.]?\s*/,
  form: /\b(mau so)\b\s*[:.]?\s*/,
  net: /\b(cong tien hang|tien hang|cong hang)\b/,
  gross: /\b(tong tien thanh toan|tong thanh toan|tong cong|tong tien)\b/,
  tax: /\b(tien thue gtgt|thue gtgt|tong thue)\b/,
  currency: /\b(don vi tien te|loai tien)\b\s*[:.]?\s*/,
});

/** A value token: stops at the first character that cannot be part of an id. */
function valueToken(rest) {
  const m = /^([0-9A-Za-z][0-9A-Za-z._/-]*)/.exec(String(rest ?? "").trim());
  return m ? m[1] : null;
}

/**
 * The token of a line that IS a value and nothing else — "0000049", "1C25TAA-0000049".
 * Used for the next-line fallback, where the provider printed the label on one row
 * and the value on the next: that next line is the value, not a sentence that
 * happens to start with something. Returns null when the line carries anything
 * else (a table row, another label) or holds no digit at all.
 */
function wholeLineToken(line) {
  const text = String(line ?? "").trim();
  const token = valueToken(text);
  return token && token === text && /\d/.test(token) ? token : null;
}

/** The remainder of a line after `label`, with any leading separator removed. */
function afterLabel(line, folded, re) {
  const m = re.exec(folded);
  if (!m) return null;
  const rest = line.slice(m.index + m[0].length).replace(/^[\s:.\-–]+/, "");
  return rest.trim() === "" ? null : rest.trim();
}

/**
 * Lines whose `so` belongs to some OTHER quantity. "Mã số thuế" is the one that
 * bit us; the rest are the same family (a count, an account, a phone number) and
 * a bare-`so` value taken from them is a wrong identity, not a missing one.
 *
 * Honest note on which of these actually DECIDE: the digit requirement right of
 * the label already refuses most of them ("Số lượng: 10" yields "luong", "In số
 * bản: 2" yields "ban"). This list is what catches the compact forms where a
 * NUMBER follows `số` immediately — "Mẫu số: 01/1P", "Mã số: 0300000002" — so the
 * guard that carries the load is the digit rule, and the falsify harness pins
 * THAT (cases C and J). Keeping an entry here that never decides costs nothing
 * and reads as intent; a case in the harness that never goes red costs the
 * harness its credibility, which is why that one was removed instead.
 */
const NON_INVOICE_NO_CONTEXT = /\b(ma so|mau so|so thue|so ban|so luong|so dien thoai|so tai khoan|so tien|so hieu|so ghe|so xe|so du|so dong)\b/;

/**
 * Read an invoice number that is never a guess, in TWO passes:
 *
 *  1. a SPECIFIC label (`Số hoá đơn`, `Số HĐ`) — same visual line (a two-column
 *     header) or the NEXT line when the provider prints label and value apart;
 *  2. a BARE `Số` — same line ONLY, never on a line that is another quantity, and
 *     only when the value carries a digit.
 *
 * The asymmetry is the fix for the measured bug: with "Mã số thuế:\n0300000002"
 * the line BELOW a bare `Số` is a tax id, and the old single pass took it as the
 * invoice number. Pass 1 keeps the next-line fallback because a specific label
 * cannot be confused with anything else.
 *
 * Two rules hold for EVERY candidate, in both passes: it must carry a digit (a
 * value read from a line about something else is an abbreviation — "thu" from "mã
 * số thuế", "b" from "in số bản", "M" from a tax id below a label — never an
 * invoice number), and its line must not be about another quantity. Measured with
 * the next-line fallback unguarded: `["Số hoá đơn:", "Mã số thuế: 0300000002"]`
 * answered `invoice_no = "M"` and `["Số hoá đơn:", "Số lượng: 2"]` answered "S".
 *
 * The next-line fallback demands MORE than the same-line one (the whole next line
 * must be the value), because a digit requirement alone still let a TABLE ROW
 * answer: `["Số hoá đơn:", "1 Cám heo tăng trọng 25kg …"]` returned "1" — the
 * row's first column read as the document's identity. A value printed apart from
 * its label is a short token on a line of its own; anything else is another line
 * of the document that we are not qualified to interpret.
 *
 * Finally: a token that begins with the printed series ("1C25TAA-0000049"). A bare
 * number with no label is NOT an invoice number, and the parse reports it as
 * missing instead of picking the most invoice-looking number in the document.
 */
function readInvoiceNo(lines, folded, series) {
  for (const [index, line] of lines.entries()) {
    const candidates = [...folded[index].matchAll(LABELS.invoiceNo)];
    for (const candidate of [...candidates].reverse()) {
      const same = valueToken(line.slice(candidate.index + candidate[0].length));
      if (same && /\d/.test(same)) return same;
      const next = lines[index + 1];
      if (next && !LABELS.seller.test(folded[index + 1]) && !LABELS.buyer.test(folded[index + 1])) {
        const below = wholeLineToken(next);
        if (below) return below;
      }
    }
  }
  for (const [index, line] of lines.entries()) {
    if (NON_INVOICE_NO_CONTEXT.test(folded[index])) continue;
    const bare = [...folded[index].matchAll(LABELS.invoiceNoBare)];
    for (const candidate of [...bare].reverse()) {
      const same = valueToken(line.slice(candidate.index + candidate[0].length));
      // A digit is required: "In số bản: 2" yields "b", and "Mã số thuế: …" yields
      // "thu" — neither is an invoice number, and both used to be returned.
      if (same && /\d/.test(same)) return same;
    }
  }
  if (series) {
    for (const line of lines) {
      const hit = new RegExp(`${series.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[.-]?([0-9]{1,12})`).exec(line);
      if (hit) return hit[1];
    }
  }
  return null;
}

/**
 * Lines whose date is some OTHER date — never the invoice's own. Blocking the
 * LINE (not just the label) is what keeps a footer-only "In ngày 30/09/2026" from
 * becoming the duplicate key: the old reader took the first date-shaped number
 * anywhere, so "Ngày đặt hàng: 01/09/2026" above "Ngày lập: 20/09/2026" won, and a
 * wrong `invoice_date` is a missed or wrong `business_doc_key`.
 */
const NON_INVOICE_DATE_CONTEXT = /\b(dat hang|giao hang|giao nhan|hen|den han|het han|in)\b/;

/**
 * The invoice's own date, read only where the document SAYS it is a date:
 *
 *  1. the printed Vietnamese form ("ngày 20 tháng 09 năm 2026") — it states the
 *     order of its own parts, so it cannot be misread;
 *  2. a numeric date on a line that carries a date label ("Ngày lập: 20/09/2026");
 *  3. a numeric date with NO label — accepted only when the document gives exactly
 *     ONE. Two unlabelled dates are a coin flip, and a coin flip here is a wrong
 *     duplicate key, so the parse reports the date as missing and the request is
 *     refused instead of guessed.
 *
 * Lines matching `NON_INVOICE_DATE_CONTEXT` are skipped by every pass.
 */
function readDate(lines, folded) {
  const usable = [];
  for (const [index, line] of folded.entries()) {
    if (!NON_INVOICE_DATE_CONTEXT.test(line)) usable.push(index);
  }
  for (const index of usable) {
    const named = /ngay\s+(\d{1,2})\s+thang\s+(\d{1,2})\s+nam\s+(\d{4})/.exec(folded[index]);
    if (!named) continue;
    const printed = /(\d{1,2})\D+(\d{1,2})\D+(\d{4})/.exec(lines[index]);
    return printed ? calendarOrNull(Number(printed[3]), Number(printed[2]), Number(printed[1])) : null;
  }
  const labelled = [];
  const unlabelled = [];
  for (const index of usable) {
    const line = lines[index];
    const hit =
      /(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})/.exec(line) ?? /(\d{4})-(\d{2})-(\d{2})/.exec(line);
    if (!hit) continue;
    (LABELS.date.test(folded[index]) ? labelled : unlabelled).push(hit[0]);
  }
  if (labelled.length > 0) return pdfDateToIso(labelled[0]);
  if (unlabelled.length === 1) return pdfDateToIso(unlabelled[0]);
  return null;
}

/** A Vietnamese tax id as printed (10 or 13 digits, separators ignored). */
function taxIdToken(text) {
  const m = /(\d{10}(?:[-.]?\d{3})?)/.exec(String(text ?? ""));
  return m ? m[1].replace(/[^0-9]/g, "") : null;
}

/**
 * The SELLER's tax id, attributed by LABEL — never by being the first MST in the
 * document, because the buyer (the shop itself) has one too and confusing the two
 * would resolve the wrong supplier.
 *
 * With no party labels at all: exactly ONE MST in the text is accepted, WITH a
 * warning so the user checks it on the form; zero or two+ MSTs become a missing
 * seller (refused upstream), because there is nothing to attribute it to.
 */
function readSeller(lines, folded) {
  const sellerAt = folded.findIndex((l) => LABELS.seller.test(l));
  const buyerAt = folded.findIndex((l, i) => LABELS.buyer.test(l) && (sellerAt === -1 || i > sellerAt));
  const warnings = [];

  let name = null;
  let taxId = null;
  if (sellerAt !== -1) {
    const same = afterLabel(lines[sellerAt], folded[sellerAt], LABELS.seller);
    name = same ? same.replace(/[.:\-–]+$/, "").trim() : null;
    if (!name) {
      const below = lines[sellerAt + 1];
      if (below && taxIdToken(below) === null && !LABELS.seller.test(folded[sellerAt + 1] ?? "")) name = below.trim();
    }
    const scope = folded.slice(sellerAt + 1, buyerAt === -1 ? folded.length : buyerAt);
    const rawScope = lines.slice(sellerAt + 1, buyerAt === -1 ? lines.length : buyerAt);
    for (const [i, line] of scope.entries()) {
      if (!LABELS.taxId.test(line)) continue;
      taxId = taxIdToken(rawScope[i]);
      break;
    }
  }
  if (!taxId) {
    // Only LABELLED lines count here — never "any 10-digit run in the document":
    // a phone number ("Điện thoại: 0909123456") is 10 digits too, and a tax id
    // read off a phone number would resolve the WRONG supplier. So when the party
    // labels are missing, the fallback is the document's OWN "MST:" lines, and it
    // still has to be unambiguous (one line, one value) to be used at all.
    const labelled = folded
      .map((line, i) => (LABELS.taxId.test(line) ? taxIdToken(lines[i]) : null))
      .filter(Boolean);
    const distinct = [...new Set(labelled)];
    if (distinct.length === 1) {
      taxId = distinct[0];
      warnings.push({
        code: PDF_WARNING_CODES.MST_UNLABELLED,
        reason: `file không ghi rõ khối "Người bán" — đang hiểu MST ${taxId} (dòng có nhãn MST duy nhất trong file) là của người bán; kiểm lại người bán trước khi xác nhận`,
      });
    }
  }
  return { name, tax_id: taxId, warnings };
}

/** The buyer block, read for display only (the pipeline never resolves a buyer on a purchase). */
function readBuyer(lines, folded) {
  const buyerAt = folded.findIndex((l) => LABELS.buyer.test(l));
  if (buyerAt === -1) return { name: null, tax_id: null };
  const name = afterLabel(lines[buyerAt], folded[buyerAt], LABELS.buyer);
  for (let i = buyerAt + 1; i < lines.length; i++) {
    if (LABELS.seller.test(folded[i])) break;
    if (LABELS.taxId.test(folded[i])) return { name: name ? name.replace(/[.:\-–]+$/, "").trim() : null, tax_id: taxIdToken(lines[i]) };
  }
  return { name: name ? name.replace(/[.:\-–]+$/, "").trim() : null, tax_id: null };
}

/**
 * One table row: `STT | tên hàng | ĐVT | SL | đơn giá | thành tiền`.
 *
 * The row is accepted ONLY when its own arithmetic closes (qty × rate ≈ amount) —
 * that invariant is what makes it safe to read a table whose column ORDER can vary
 * and whose numbers can be ambiguous ("1.234"): the combination of readings that
 * satisfies the document's own multiplication is the reading the document meant,
 * and if none or more than one does, this row is NOT read.
 *
 * @returns {{row:object}|{problem:string}|null} null = "this line is not a row"
 */
function parseRowLine(line, index, warnings) {
  const tokens = line.split(/\s+/).filter(Boolean);
  if (tokens.length < 4) return null;
  const numeric = [];
  for (let i = tokens.length - 1; i >= 0; i--) {
    const readings = pdfNumberReadings(tokens[i]);
    if (readings.length === 0) break;
    numeric.unshift({ token: tokens[i], readings });
    if (numeric.length === 3) break;
  }
  if (numeric.length < 3) return null;
  const [qtyT, rateT, amountT] = numeric;
  const beforeNumbers = tokens.slice(0, tokens.length - 3);
  // A leading order number ("1") is not part of the goods name.
  if (/^\d{1,3}$/.test(beforeNumbers[0] ?? "")) beforeNumbers.shift();
  let description = beforeNumbers.join(" ").trim();
  let uom = null;
  // A trailing SHORT all-letter token is the unit column ("Bao", "Thùng", "Tấn") —
  // it is peeled into the unit field rather than left inside the goods name, and
  // the FORM shows the result, so a wrong peel is correctable before confirming.
  const lastToken = beforeNumbers[beforeNumbers.length - 1] ?? "";
  if (/^[A-Za-zÀ-ỹ]{1,6}$/.test(lastToken) && beforeNumbers.length > 1) {
    uom = lastToken;
    description = beforeNumbers.slice(0, -1).join(" ").trim();
    warnings.push({
      code: PDF_WARNING_CODES.UNIT_GUESSED_FROM_TEXT,
      reason: `dòng ${index}: đơn vị "${uom}" lấy theo cột in trên file — kiểm lại đơn vị trước khi xác nhận`,
    });
  }
  if (description === "" || description.length < 3) return null;

  const combos = [];
  for (const qty of qtyT.readings) {
    for (const rate of rateT.readings) {
      for (const amount of amountT.readings) {
        if (qty <= 0 || rate <= 0 || amount <= 0) continue;
        const computed = qty * rate;
        const tolerance = Math.max(1, Math.abs(amount) * 0.005);
        if (Math.abs(computed - amount) <= tolerance) combos.push({ qty, rate, amount });
      }
    }
  }
  if (combos.length === 0) {
    return {
      problem: `dòng ${index}: đọc được số nhưng KHÔNG khớp (${qtyT.token} × ${rateT.token} ≠ ${amountT.token}) — sửa tay ở form hoặc nhập lại`,
    };
  }
  const distinct = [...new Map(combos.map((c) => [`${c.qty}|${c.rate}|${c.amount}`, c])).values()];
  if (distinct.length > 1) {
    return {
      problem: `dòng ${index}: có nhiều cách hiểu số lượng/đơn giá/thành tiền (${distinct
        .map((c) => `${c.qty}×${c.rate}`)
        .join(" / ")}) — không tự chọn; sửa tay ở form`,
    };
  }
  const picked = distinct[0];
  return {
    row: {
      index,
      description,
      qty: picked.qty,
      uom,
      unit_price: picked.rate,
      amount: picked.amount,
      tax_rate: null,
    },
  };
}

/**
 * Visual lines → the SAME `parsed` shape `parseEinvoiceXml` returns.
 *
 * Pure and synchronous (the static guard in `test/a1-einvoice-parser.test.mjs`
 * enforces that for this whole directory), so golden TEXT can be tested without a
 * PDF, and the PDF bytes can be tested without ERPNext.
 *
 * @param {string[]} lines
 * @param {{policy?:object}} [opts]
 * @returns {object} parsed (source: "einvoice_pdf")
 */
export function extractEinvoiceFields(lines, { policy = null } = {}) {
  const limits = pdfLimits(policy);
  const rows = (Array.isArray(lines) ? lines : []).map((l) => String(l ?? "")).filter((l) => l.trim() !== "");
  const folded = rows.map((l) => foldVietnamese(l));
  const problems = [];
  const warnings = [];
  const bad = (code, reason) => problems.push({ code, reason });

  const series = (() => {
    for (const [i, line] of folded.entries()) {
      const rest = afterLabel(rows[i], line, LABELS.series);
      if (rest) return valueToken(rest);
    }
    return null;
  })();
  const invoiceNo = readInvoiceNo(rows, folded, series);
  const invoiceDate = readDate(rows, folded);
  const seller = readSeller(rows, folded);
  warnings.push(...seller.warnings);
  const buyer = readBuyer(rows, folded);
  const form = rows.map((l, i) => afterLabel(l, folded[i], LABELS.form)).find(Boolean) ?? null;
  const currency = rows.map((l, i) => afterLabel(l, folded[i], LABELS.currency)).find(Boolean) ?? null;

  if (!invoiceNo) {
    bad(EINVOICE_CODES.MISSING_INVOICE_NO, "file không có số hoá đơn đọc được (ô \"Số:\" / số in cạnh ký hiệu)");
  }
  if (!invoiceDate) {
    bad(EINVOICE_CODES.MISSING_INVOICE_DATE, "file không có ngày lập hoá đơn đọc được (dạng ngày/tháng/năm)");
  }
  if (!seller.name) {
    bad(EINVOICE_CODES.MISSING_SELLER, "file không có tên người bán (dòng \"Người bán\") — bắt buộc để đối chiếu nhà cung cấp");
  }
  if (!seller.tax_id) {
    bad(
      EINVOICE_CODES.MISSING_SELLER,
      "file không có MST người bán rõ ràng — hệ thống đối chiếu nhà cung cấp theo MST nên cần đủ thông tin này",
    );
  }

  const tableRows = [];
  let rowIndex = 0;
  for (const [i, line] of rows.entries()) {
    const foldedLine = folded[i];
    if (LABELS.net.test(foldedLine) || LABELS.gross.test(foldedLine) || LABELS.tax.test(foldedLine)) continue;
    const parsedRow = parseRowLine(line, rowIndex + 1, warnings);
    if (!parsedRow) continue;
    rowIndex += 1;
    if (parsedRow.problem) {
      bad(EINVOICE_CODES.LINE_UNUSABLE, parsedRow.problem);
      continue;
    }
    tableRows.push({ ...parsedRow.row, index: rowIndex });
    if (tableRows.length > limits.maxLines) {
      bad(EINVOICE_CODES.LINE_LIMIT, `hoá đơn có hơn ${limits.maxLines} dòng — vượt trần của einvoice_policy`);
      tableRows.pop();
      break;
    }
  }
  if (tableRows.length === 0) {
    bad(EINVOICE_CODES.NO_LINES, "file không có dòng hàng hoá nào đọc được — nhập tay giúp tôi");
  }

  // Totals: display-only, read with the thousands convention, and settled against
  // the sum of the rows the document itself gave us whenever that is possible.
  const rowSum = tableRows.reduce((sum, r) => sum + (r.amount ?? 0), 0);
  const moneyOf = (re) => {
    const line = rows.find((l, i) => re.test(folded[i]));
    if (!line) return null;
    const tokens = line.split(/\s+/).reverse();
    for (const token of tokens) {
      const readings = pdfNumberReadings(token);
      if (readings.length > 0) return readings.length === 1 ? readings[0] : preferredMoneyReading(token, rowSum || null);
    }
    return null;
  };

  const parsed = {
    source: "einvoice_pdf",
    header: {
      invoice_no: invoiceNo,
      invoice_form: form,
      invoice_series: series,
      invoice_date: invoiceDate,
      currency,
      seller: { tax_id: seller.tax_id, name: seller.name },
      buyer: { tax_id: buyer.tax_id, name: buyer.name },
      net_total_vnd: moneyOf(LABELS.net),
      tax_total_vnd: moneyOf(LABELS.tax),
      total_vnd: moneyOf(LABELS.gross),
    },
    lines: tableRows,
    problems,
    warnings,
    complete: problems.length === 0,
    instruction_pattern_found: /\[đã lọc chỉ dẫn\]/.test(
      JSON.stringify({ header: null, lines: tableRows, warnings }),
    ),
  };
  return parsed;
}

/**
 * The whole channel in one call: base64/bytes → `parsed`, exactly like
 * `parseEinvoiceXml`. Kept thin so the route reads the same on both branches.
 *
 * @param {string|Uint8Array} input
 * @param {{policy?:object}} [opts]
 */
export function parseEinvoicePdf(input, { policy = null } = {}) {
  const { lines } = extractPdfText(input, { policy });
  return extractEinvoiceFields(lines, { policy });
}
