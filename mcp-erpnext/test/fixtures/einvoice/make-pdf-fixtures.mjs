#!/usr/bin/env node
/**
 * A3 (`.plan/next3/implementation.md` workstream A) — the PDF fixtures.
 *
 * WHY GENERATED RATHER THAN "A REAL FILE FROM A SUPPLIER": none is available in
 * this repo, and a scanner-dump would be both huge and unreviewable. So the
 * fixtures are BUILT here, byte by byte, out of the PDF constructs a provider's
 * export actually uses — and each construct is named in the fixture it lives in,
 * so a reader can see what is being proven instead of trusting a filename.
 *
 * What each file exercises (the whole point of the set):
 *
 *   hd-pdf-tounicode.pdf   THE REALISTIC VIETNAMESE PATH. A Type0/CID font whose
 *                          text is written as 2-byte glyph codes, so the only way
 *                          to read it is the font's ToUnicode CMap — which is
 *                          also what makes the diacritics come out right. Content
 *                          stream is FlateDecode-compressed, lines are placed with
 *                          absolute `Tm`, columns with a relative `Td` between two
 *                          `Tj` on the same line.
 *   hd-pdf-winansi.pdf     THE OTHER COMMON PATH: a simple font with
 *                          `/Encoding /WinAnsiEncoding`, an UNCOMPRESSED content
 *                          stream, `TJ` arrays with kerning numbers, column moves
 *                          by `Td`, new lines by `T*` and one by `'`. Its text is
 *                          ASCII (no diacritics at all) on purpose: the labels have
 *                          to be recognised without them, and the parser must NOT
 *                          invent accents back.
 *   hd-pdf-no-textlayer.pdf  a page whose content is graphics only (a scan's shape
 *                          without the image): no text to extract ⇒ the caller must
 *                          send the user to the camera instead of guessing numbers.
 *   hd-pdf-encrypted.pdf   the same document with `/Encrypt` in the trailer — a
 *                          protected invoice is a normal thing to receive, and it
 *                          must refuse by name, not by producing mojibake.
 *   hd-pdf-objstm.pdf      a PDF 1.5+ file whose objects live in a compressed
 *                          object stream: readable objects are absent ⇒ the refusal
 *                          has to say THAT, not "scanned image".
 *
 * NOT here: the over-cap file. Padding a committed fixture to 700 KB to test a
 * length check is waste; the test pads a loaded fixture in memory.
 *
 * Run: node test/fixtures/einvoice/make-pdf-fixtures.mjs   (idempotent, rewrites)
 */

import { deflateSync } from "node:zlib";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/* ───────────────────────────── a minimal PDF writer ───────────────────────── */

/**
 * Assemble objects into a file with a real xref table and trailer. The reader
 * under test does not NEED a correct xref (it scans objects), but writing one
 * keeps the fixtures honest PDFs that any viewer/pdfminer would also accept.
 *
 * @param {Buffer[]} objects object number i+1 = objects[i]
 * @param {string} [trailerExtra] e.g. `/Encrypt 9 0 R`
 */
function buildPdf(objects, trailerExtra = "") {
  const parts = [];
  let offset = 0;
  const push = (buf) => {
    parts.push(buf);
    offset += buf.length;
  };
  // The binary comment on line 2 is the conventional marker that this is not a text file.
  push(Buffer.from("%PDF-1.7\n%\xe2\xe3\xcf\xd3\n", "latin1"));

  const offsets = [];
  objects.forEach((body, i) => {
    offsets.push(offset);
    push(Buffer.from(`${i + 1} 0 obj\n`, "latin1"));
    push(body);
    push(Buffer.from("\nendobj\n", "latin1"));
  });

  const xrefStart = offset;
  const size = objects.length + 1;
  let xref = `xref\n0 ${size}\n0000000000 65535 f \n`;
  for (const off of offsets) xref += `${String(off).padStart(10, "0")} 00000 n \n`;
  push(Buffer.from(xref, "latin1"));
  push(Buffer.from(`trailer\n<</Size ${size}/Root 1 0 R${trailerExtra}>>\nstartxref\n${xrefStart}\n%%EOF\n`, "latin1"));
  return Buffer.concat(parts);
}

/** A stream object. `length` is the length AFTER compression — the real rule. */
function streamObj(dict, data, compress = false) {
  const body = compress ? deflateSync(data) : data;
  return Buffer.concat([
    Buffer.from(`<<${dict}${compress ? "/Filter/FlateDecode" : ""}/Length ${body.length}>>\nstream\n`, "latin1"),
    body,
    Buffer.from("\nendstream", "latin1"),
  ]);
}

/** The 4 shared objects (catalog, pages, page, resource dict) of a 1-page file. */
function pageObjects(fontDictRefs, contentsRef) {
  const font = Object.entries(fontDictRefs)
    .map(([name, ref]) => `/${name} ${ref} 0 R`)
    .join("");
  return [
    Buffer.from("<</Type/Catalog/Pages 2 0 R>>", "latin1"),
    Buffer.from("<</Type/Pages/Kids[3 0 R]/Count 1>>", "latin1"),
    Buffer.from(
      `<</Type/Page/Parent 2 0 R/MediaBox[0 0 595 842]/Resources<</Font<<${font}>>>>/Contents ${contentsRef} 0 R>>`,
      "latin1",
    ),
  ];
}

/* ──────────────────── the document both text fixtures describe ─────────────── */

/**
 * ONE invoice, two renderings. Keeping the numbers identical is what lets the
 * test assert that a CID font and a WinAnsi font produce the SAME identity —
 * the property that matters, and the one a per-fixture expectation would hide.
 *
 * `qty × rate = amount` holds on both lines because the parser REFUSES a row
 * whose arithmetic does not close (see einvoice-pdf.mjs): a fixture that only
 * looked like a table would test nothing.
 */
const DOC = {
  // { label, value } pairs are laid out as two columns on one visual line.
  header: [
    { left: "HÓA ĐƠN GIÁ TRỊ GIA TĂNG", right: null },
    { left: "Ký hiệu: 1C25TAA", right: "Số: 0000049" },
    { left: "Ngày 20 tháng 09 năm 2026", right: null },
    { left: "Người bán: Đại lý Cám Bình Dương", right: null },
    { left: "MST: 0300000002", right: null },
    { left: "Người mua: Cửa hàng Cám Minh Phát", right: null },
    { left: "MST: 0300000009", right: null },
  ],
  rows: [
    "1 Cám heo tăng trọng 25kg Bao 10 295.000 2.950.000",
    "2 Cám gà thịt 10kg Bao 5 250.000 1.250.000",
  ],
  footer: ["Cộng tiền hàng: 4.200.000", "Tổng tiền thanh toán: 4.200.000"],
};

/** The same document with NO diacritics, and no accents to be invented back. */
const DOC_ASCII = {
  header: [
    { left: "HOA DON GIA TRI GIA TANG", right: null },
    { left: "Ky hieu: 1C25TAA", right: "So: 0000049" },
    { left: "Ngay 20 thang 09 nam 2026", right: null },
    { left: "Nguoi ban: Dai ly Cam Binh Duong", right: null },
    { left: "MST: 0300000002", right: null },
    { left: "Nguoi mua: Cua hang Cam Minh Phat", right: null },
    { left: "MST: 0300000009", right: null },
  ],
  rows: [
    "1 Cam heo tang trong 25kg Bao 10 295.000 2.950.000",
    "2 Cam ga thit 10kg Bao 5 250.000 1.250.000",
  ],
  footer: ["Cong tien hang: 4.200.000", "Tong tien thanh toan: 4.200.000"],
};

/* ─────────────────────── fixture 1: Type0 + ToUnicode ─────────────────────── */

const hex2 = (n) => n.toString(16).toUpperCase().padStart(4, "0");

/**
 * Build the CMap that maps the 2-byte codes in this file back to Unicode. The
 * `beginbfchar` blocks are capped at 50 entries each (>1 block) because the
 * format allows at most 100 per block and a reader that only ever sees one block
 * is a reader that breaks on a real 90-line invoice.
 */
function toUnicodeCMap(charCodes) {
  const entries = [...charCodes.entries()].map(([ch, code]) => ({ code, ch }));
  const blocks = [];
  for (let i = 0; i < entries.length; i += 50) blocks.push(entries.slice(i, i + 50));
  const body = blocks
    .map((block) => {
      const lines = block.map(({ code, ch }) => `<${hex2(code)}> <${hex2(ch.codePointAt(0))}>`);
      return `${block.length} beginbfchar\n${lines.join("\n")}\nendbfchar`;
    })
    .join("\n");
  return Buffer.from(
    [
      "/CIDInit /ProcSet findresource begin",
      "12 dict begin",
      "begincmap",
      "/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def",
      "/CMapName /HD-UCS def",
      "/CMapType 2 def",
      "1 begincodespacerange",
      "<0000> <FFFF>",
      "endcodespacerange",
      body,
      "endcmap",
      "CMapName currentdict /CMap defineresource pop",
      "end",
      "end",
      "",
    ].join("\n"),
    "latin1",
  );
}

function buildToUnicodePdf({ withCMap = true } = {}) {
  // Every distinct character gets its own code (which is what a subset font does).
  const charCodes = new Map();
  const lines = [
    ...DOC.header.map((h) => [h.left, h.right]),
    ...DOC.rows.map((r) => [r]),
    ...DOC.footer.map((f) => [f]),
  ];
  for (const line of lines) {
    for (const piece of line) {
      for (const ch of piece ?? "") if (!charCodes.has(ch)) charCodes.set(ch, charCodes.size + 1);
    }
  }
  const encode = (text) => `<${[...text].map((ch) => hex2(charCodes.get(ch))).join("")}>`;

  const ops = ["BT", "/F1 9 Tf", "1 0 0 1 40 800 Tm"];
  // Without a ToUnicode CMap there is no object 7 to reference, and the fixture is
  // the "glyph ids, no mapping" case: the reader must refuse it by name instead of
  // rendering the codes as letters.
  let y = 800;
  for (const [i, line] of lines.entries()) {
    if (i > 0) {
      y -= 16;
      ops.push(`1 0 0 1 40 ${y} Tm`);
    }
    ops.push(`${encode(line[0])} Tj`);
    if (line[1]) {
      // A column move on the SAME visual line — the shape a two-column header has.
      ops.push("260 0 Td");
      ops.push(`${encode(line[1])} Tj`);
      ops.push("-260 0 Td");
    }
  }
  ops.push("ET");

  const content = Buffer.from(ops.join("\n"), "latin1");
  const objects = [
    ...pageObjects({ F1: 4 }, 6),
    // Type0 → the text is 2-byte glyph codes; ToUnicode is the ONLY way back to Unicode.
    Buffer.from(
      `<</Type/Font/Subtype/Type0/BaseFont/HD-Subset/Encoding/Identity-H/DescendantFonts[5 0 R]${
        withCMap ? "/ToUnicode 7 0 R" : ""
      }>>`,
      "latin1",
    ),
    Buffer.from(
      "<</Type/Font/Subtype/CIDFontType2/BaseFont/HD-Subset/CIDSystemInfo<</Registry(Adobe)/Ordering(Identity)/Supplement 0>>/DW 500/W[0[500]]>>",
      "latin1",
    ),
    streamObj("", content, true),
    ...(withCMap ? [streamObj("", toUnicodeCMap(charCodes), false)] : []),
  ];
  return buildPdf(objects);
}

/* ───────────────────────────── fixture 2: WinAnsi ─────────────────────────── */

/**
 * A simple font file: bytes ARE the characters (WinAnsi ≈ Latin-1 for everything
 * we read), which is the other half of the real world. Built with an
 * UNCOMPRESSED stream, `TJ` arrays carrying kerning numbers, `Td` column moves,
 * `T*` new lines and a final `'` (next-line-and-show) — every operator a provider
 * export uses, and the ones a naive "only understands Tj" reader drops silently.
 */
function buildWinAnsiPdf() {
  const esc = (s) => s.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
  const ops = ["BT", "/F1 9 Tf", "14 TL", "1 0 0 1 40 800 Tm"];
  for (const [i, line] of DOC_ASCII.header.entries()) {
    // `TJ` with a SPACE-SIZED gap (-278/1000 ≈ one space in Helvetica) between two
    // pieces split at a word boundary: the reader must join them with exactly ONE
    // space. Splitting mid-word here would instead test that a kerning pair is NOT
    // a space — that case lives in the unit test, not in this layout.
    const [first, ...rest] = line.left.split(" ");
    ops.push(`[(${esc(first)}) -278 (${esc(rest.join(" "))})] TJ`);
    if (line.right) {
      ops.push("240 0 Td");
      ops.push(`(${esc(line.right)}) Tj`);
      ops.push("-240 0 Td");
    }
    if (i < DOC_ASCII.header.length - 1) ops.push("T*");
  }
  ops.push("0 -18 Td");
  for (const row of DOC_ASCII.rows) {
    const [idx, rest] = [row.slice(0, 1), row.slice(2)];
    const cells = rest.split(" ");
    // Columns as separate `Td` moves: this is how a table renders, and it is why
    // the reader tracks x/y instead of trusting the order of `Tj` calls.
    ops.push(`(${esc(idx)}) Tj 20 0 Td`);
    ops.push(`(${esc(cells.slice(0, 4).join(" "))}) Tj 150 0 Td`);
    ops.push(`(${esc(cells.slice(4).join(" "))}) Tj -170 0 Td 0 -14 Td`);
  }
  for (const foot of DOC_ASCII.footer) ops.push(`(${esc(foot)}) '`);
  ops.push("ET");

  const objects = [
    ...pageObjects({ F1: 4 }, 5),
    Buffer.from("<</Type/Font/Subtype/Type1/BaseFont/Helvetica/Encoding/WinAnsiEncoding>>", "latin1"),
    streamObj("", Buffer.from(ops.join("\n"), "latin1"), false),
  ];
  return buildPdf(objects);
}

/* ───────────────────────── fixtures 3–5: the refusals ─────────────────────── */

/** A real page whose content has no text at all (the shape of a scan). */
function buildNoTextPdf() {
  const content = Buffer.from("q\n1 0 0 1 40 700 cm\n0.5 g\n100 100 m\n300 300 l\nS\nQ\n", "latin1");
  return buildPdf([
    ...pageObjects({ F1: 4 }, 5),
    Buffer.from("<</Type/Font/Subtype/Type1/BaseFont/Helvetica/Encoding/WinAnsiEncoding>>", "latin1"),
    streamObj("", content, false),
  ]);
}

/** The readable document, plus `/Encrypt` in the trailer. */
function buildEncryptedPdf() {
  const objects = [
    ...pageObjects({ F1: 4 }, 5),
    Buffer.from("<</Type/Font/Subtype/Type1/BaseFont/Helvetica/Encoding/WinAnsiEncoding>>", "latin1"),
    streamObj("", Buffer.from("BT /F1 9 Tf (So: 0000049) Tj ET\n", "latin1"), false),
  ];
  // An `/Encrypt` entry only has to be PRESENT for the reader to refuse: it may
  // not decrypt, and reading the bytes anyway would produce exactly the mojibake
  // this refusal exists to prevent.
  return buildPdf(objects, "/Encrypt 9 0 R");
}

/** A PDF 1.5+ file: the catalog/pages live inside a compressed object stream. */
function buildObjStmPdf() {
  const objStmPayload = Buffer.from("1 0 2 20 <</Type/Catalog/Pages 2 0 R>> <</Type/Pages/Kids[]/Count 0>>", "latin1");
  const objects = [
    streamObj("/Type/ObjStm/N 2/First 10", objStmPayload, true),
    Buffer.from("<</Type/XRef/Size 2/W[1 2 1]/Root 1 0 R>>", "latin1"),
  ];
  return buildPdf(objects);
}

/* ─────────────────────────────────── write ────────────────────────────────── */

const FILES = {
  "hd-pdf-tounicode.pdf": buildToUnicodePdf(),
  "hd-pdf-winansi.pdf": buildWinAnsiPdf(),
  "hd-pdf-tounicode-nomap.pdf": buildToUnicodePdf({ withCMap: false }),
  "hd-pdf-no-textlayer.pdf": buildNoTextPdf(),
  "hd-pdf-encrypted.pdf": buildEncryptedPdf(),
  "hd-pdf-objstm.pdf": buildObjStmPdf(),
};

for (const [name, buf] of Object.entries(FILES)) {
  writeFileSync(path.join(HERE, name), buf);
  process.stdout.write(`${name.padEnd(28)} ${String(buf.length).padStart(6)} byte\n`);
}
process.stdout.write("(fixtures are GENERATED — never hand-edit; edit this generator)\n");
