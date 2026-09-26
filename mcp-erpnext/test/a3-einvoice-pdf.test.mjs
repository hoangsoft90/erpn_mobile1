/**
 * A3 — HÓA ĐƠN ĐIỆN TỬ **PDF** (`.plan/next3/implementation.md` workstream A).
 *
 * The one property this file exists to defend, stated as the shop would feel it:
 * a supplier's PDF becomes a DRAFT through the SAME pipeline as the XML file,
 * keyed on the SAME document identity — and every number in it was READ, never
 * filled in. So the tests below are about the refusals as much as the happy path:
 *
 *  1. THE CONTRACT owns the cap and the reader policy, and the cap is arithmetic
 *     (base64 +33% must still fit the gateway's body limit) rather than taste;
 *  2. LAYER 1 (bytes → text): a CID/Type0 file with a ToUnicode CMap and a
 *     WinAnsi file with literal strings, `TJ` kerning and column moves both come
 *     out as the SAME visual lines — one document, two renderings;
 *  3. LAYER 2 (text → fields): golden Vietnamese texts, including layouts that
 *     put the value BELOW its label and one that prints the BUYER's MST before
 *     the seller's (a \"first MST wins\" reader resolves the wrong supplier);
 *  4. NO INVENTED NUMBERS: a row whose arithmetic does not close is a problem, an
 *     ambiguous row is a problem, and digits that have two readings are settled by
 *     the row's own multiplication — `1.234` as a quantity is 1234 only when the
 *     document's own products agree;
 *  5. A SCAN IS NOT GUESSED: no text layer, an encrypted file, an unmappable font
 *     and a compressed-object PDF each refuse with their OWN sentence (the user is
 *     told to use the camera, not handed a reading nobody can check);
 *  6. THE ROUTE reuses `/input/einvoice` — same slots, same capability, no write
 *     surface, and PDF codes carry their own statuses.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { deflateSync } from "node:zlib";
import { fileURLToPath } from "node:url";

// Hermetic: a shell that sourced .env would otherwise point createAskServer() at
// the REAL ERPNext target. Same rule as a2-einvoice-input.test.mjs.
for (const k of Object.keys(process.env)) {
  if (/^(ERPNEXT_|ASK_)/.test(k)) delete process.env[k];
}
process.env.LEARNING_LOG_DIR = mkdtempSync(path.join(tmpdir(), "a3-learning-"));
process.env.COPILOT_MOCK_OK = "1";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const FIXTURES = path.join(HERE, "fixtures", "einvoice");
const fixtureBytes = (name) => readFileSync(path.join(FIXTURES, name));

const { einvoicePolicy } = await import("../src/capability-contract.mjs");
const { PDF_CODES, extractEinvoiceFields, extractPdfText, parseEinvoicePdf, pdfNumberReadings } =
  await import("../src/einvoice/einvoice-pdf.mjs");
const { EINVOICE_CODES } = await import("../src/einvoice/einvoice-xml.mjs");
const { RateLimiter } = await import("../src/rate-limit.mjs");

const POLICY = einvoicePolicy();
const CID = "hd-pdf-tounicode.pdf";
const WINANSI = "hd-pdf-winansi.pdf";

/**
 * A PDF that passes every FILE-level check and blows up on DECOMPRESSION: the
 * whole file is smaller than the byte cap, while the stream inside inflates far
 * past the policy's output cap. Measured before the output cap existed: 106.884
 * compressed bytes → 31.457.284 bytes (294×), 4,3 s, +541 MB of RSS.
 */
function inflatedBombPdf(payloadBytes = 20_000_000) {
  const payload = Buffer.alloc(payloadBytes, 0x41);
  const deflated = deflateSync(payload);
  return {
    bytes: Buffer.concat([
      Buffer.from(`%PDF-1.4\n1 0 obj\n<< /Length ${deflated.length} /Filter /FlateDecode >>\nstream\n`, "latin1"),
      deflated,
      Buffer.from("\nendstream\nendobj\n%%EOF\n", "latin1"),
    ]),
    inflatedBytes: payload.length,
  };
}

/** The same lines both renderings must produce (CID text, verbatim from the file). */
const CID_LINES = [
  "HÓA ĐƠN GIÁ TRỊ GIA TĂNG",
  "Ký hiệu: 1C25TAA Số: 0000049",
  "Ngày 20 tháng 09 năm 2026",
  "Người bán: Đại lý Cám Bình Dương",
  "MST: 0300000002",
  "Người mua: Cửa hàng Cám Minh Phát",
  "MST: 0300000009",
  "1 Cám heo tăng trọng 25kg Bao 10 295.000 2.950.000",
  "2 Cám gà thịt 10kg Bao 5 250.000 1.250.000",
  "Cộng tiền hàng: 4.200.000",
  "Tổng tiền thanh toán: 4.200.000",
];

/** …and the WinAnsi rendering: identical, minus the diacritics the file never had. */
const WINANSI_LINES = CID_LINES.map((l) =>
  l
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D"),
);

/* ───────────────────────── 1. the contract owns the boundary ──────────────── */

test("A3: the PDF reader is a declared, unrelaxable policy of the same channel", () => {
  assert.equal(POLICY.pdf_reader, "text_layer_only");
  assert.ok(Number.isInteger(POLICY.max_pdf_bytes), "max_pdf_bytes must be declared");
  // The arithmetic, not a preference: base64 inflates by 4/3, and the gateway's
  // body cap is 1 MB (MAX_BODY in http-ask.mjs) — so the policy's own refusal must
  // fire first, with a Vietnamese reason, instead of an opaque transport error.
  assert.ok(
    Math.ceil((POLICY.max_pdf_bytes * 4) / 3) < 1_000_000,
    `max_pdf_bytes=${POLICY.max_pdf_bytes} in base64 would exceed the 1 MB body cap`,
  );
  // Same stance as the XML channel: untrusted, non-authoritative, one kind table.
  assert.equal(POLICY.authoritative_identifiers, false);
  assert.equal(POLICY.require_untrusted_sanitize, true);
  assert.deepEqual(POLICY.document_kinds, ["purchase"]);
  // M1 (2026-09-25): a cap on the bytes the user SENT is not a cap on the bytes
  // zlib PRODUCES, so the output cap is its own contract number. Measured bomb:
  // a 106.884-byte stream inflated to 31.457.284 bytes (294×) with +541 MB RSS,
  // because `inflateSync` had no output limit at all.
  assert.ok(
    Number.isInteger(POLICY.max_inflated_bytes) && POLICY.max_inflated_bytes > 0,
    "max_inflated_bytes must be declared — compressed-input cap does NOT bound the output",
  );
  assert.ok(
    POLICY.max_inflated_bytes < 40_000_000,
    `max_inflated_bytes=${POLICY.max_inflated_bytes} would not stop the measured bomb (31.457.284 bytes)`,
  );
});

test("A3: the generated fixtures are real PDFs (signature + a self-consistent xref)", () => {
  for (const name of [CID, WINANSI, "hd-pdf-tounicode-nomap.pdf", "hd-pdf-no-textlayer.pdf", "hd-pdf-encrypted.pdf", "hd-pdf-objstm.pdf"]) {
    const buf = fixtureBytes(name);
    assert.equal(buf.subarray(0, 5).toString("latin1"), "%PDF-", `${name} must start with the PDF signature`);
    const text = buf.toString("latin1");
    // The xref table must point at real object headers. This is what makes these
    // fixtures readable by any viewer/pdfminer, not only by the reader under test.
    const startxref = Number(/startxref\s+(\d+)/.exec(text)?.[1]);
    assert.ok(Number.isInteger(startxref), `${name}: no startxref`);
    const table = text.slice(startxref);
    assert.match(table, /^xref/, `${name}: startxref must point at the xref table`);
    const offsets = [...table.matchAll(/^(\d{10}) 00000 n $/gm)].map((m) => Number(m[1]));
    // (the ObjStm fixture is a 2-object file on purpose, hence >= 2)
    assert.ok(offsets.length >= 2, `${name}: expected object offsets`);
    for (const off of offsets) {
      assert.match(
        text.slice(off, off + 40),
        /^\d+\s+\d+\s+obj/,
        `${name}: xref offset ${off} does not point at an object header`,
      );
    }
  }
});

/* ─────────────────────── 2. layer 1: bytes → visual lines ─────────────────── */

test("A3 reader: a CID/Type0 file is read through its ToUnicode CMap (diacritics intact)", () => {
  const out = extractPdfText(fixtureBytes(CID), { policy: POLICY });
  assert.deepEqual(out.lines, CID_LINES);
  assert.equal(out.pages, 1);
  assert.equal(out.fontsMapped, 1, "the CMap is what turns 2-byte codes into characters");
  assert.equal(out.unmappedChars, 0);
  // Two `Tj` calls on one visual line are ONE line (two columns), not two lines.
  assert.match(out.lines[1], /^Ký hiệu: 1C25TAA Số: 0000049$/);
});

test("A3 reader: a WinAnsi file with TJ kerning and column moves reads the same document", () => {
  const out = extractPdfText(fixtureBytes(WINANSI), { policy: POLICY });
  assert.deepEqual(out.lines, WINANSI_LINES);
  // No CMap here: the bytes ARE the characters, which is the other half of reality.
  assert.equal(out.fontsMapped, 0);
  assert.equal(out.unmappedChars, 0);
  // A space-sized TJ gap joins with exactly ONE space (a kerning-sized one would
  // split the word — that case is pinned separately, below).
  assert.match(out.lines[3], /^Nguoi ban: Dai ly Cam Binh Duong$/);
  assert.match(out.lines[4], /^MST: 0300000002$/);
});

test("A3 reader: base64 (the transport form) and bytes agree, and junk is refused", () => {
  const buf = fixtureBytes(CID);
  const viaBase64 = extractPdfText(buf.toString("base64"), { policy: POLICY });
  assert.deepEqual(viaBase64.lines, CID_LINES);
  // A data: URL prefix is tolerated (clients paste them); whitespace in base64 too.
  const viaDataUrl = extractPdfText(`data:application/pdf;base64,${buf.toString("base64")}`, { policy: POLICY });
  assert.deepEqual(viaDataUrl.lines, CID_LINES);

  assert.throws(() => extractPdfText("not base64 at all!!", { policy: POLICY }), (e) => e.code === PDF_CODES.NOT_A_PDF);
  assert.throws(
    () => extractPdfText(Buffer.from("PK\x03\x04 this is a zip", "latin1"), { policy: POLICY }),
    (e) => e.code === PDF_CODES.NOT_A_PDF,
  );
  // Over the cap: refused by the POLICY, before any parsing, with a sized message.
  const padded = Buffer.concat([fixtureBytes(CID), Buffer.alloc(POLICY.max_pdf_bytes, 0x20)]);
  assert.throws(
    () => extractPdfText(padded, { policy: POLICY }),
    (e) => e.code === PDF_CODES.TOO_LARGE && e.message.includes(String(POLICY.max_pdf_bytes)),
  );
});

test("A3 reader: an unmappable font, a scan, an encrypted file and a compressed-object file each refuse BY NAME", () => {
  const cases = [
    ["hd-pdf-tounicode-nomap.pdf", PDF_CODES.TEXT_UNMAPPED, /ToUnicode/],
    ["hd-pdf-no-textlayer.pdf", PDF_CODES.NO_TEXT, /scan|camera/i],
    ["hd-pdf-encrypted.pdf", PDF_CODES.ENCRYPTED, /mã hoá/],
    ["hd-pdf-objstm.pdf", PDF_CODES.COMPRESSED_OBJECTS, /ObjStm/],
  ];
  for (const [name, code, messageRe] of cases) {
    assert.throws(
      () => extractPdfText(fixtureBytes(name), { policy: POLICY }),
      (e) => e.code === code && messageRe.test(e.message),
      `${name} must refuse with ${code}`,
    );
  }
});

/* ───────────────────────── 3. layer 2: text → fields ──────────────────────── */

test("A3 fields: a label whose value sits on the NEXT line still yields the number", () => {
  const parsed = extractEinvoiceFields([
    "HÓA ĐƠN GIÁ TRỊ GIA TĂNG",
    "Số hóa đơn",
    "0000049",
    "Ký hiệu: 1C25TAA",
    "Ngày lập: 20/09/2026",
    "Đơn vị bán hàng: Đại lý Cám Bình Dương",
    "Mã số thuế: 0300000002",
    "Đơn vị mua hàng: Cửa hàng Cám Minh Phát",
    "Mã số thuế: 0300000009",
    "1 Cám heo tăng trọng 25kg Bao 10 295.000 2.950.000",
    "2 Cám gà thịt 10kg Bao 5 250.000 1.250.000",
    "Tổng cộng: 4.200.000",
  ]);
  assert.equal(parsed.complete, true, JSON.stringify(parsed.problems));
  assert.equal(parsed.header.invoice_no, "0000049");
  assert.equal(parsed.header.invoice_series, "1C25TAA");
  assert.equal(parsed.header.invoice_date, "2026-09-20");
  assert.deepEqual(parsed.header.seller, { tax_id: "0300000002", name: "Đại lý Cám Bình Dương" });
  assert.deepEqual(parsed.header.buyer, { tax_id: "0300000009", name: "Cửa hàng Cám Minh Phát" });
  assert.equal(parsed.header.total_vnd, 4200000);
});

test("A3 fields H1: a bare `Số` never takes its value from a tax-id line or the footer", () => {
  // Measured with the bare alternative inside the label pattern: this exact layout
  // answered `invoice_no = "thu"` (the token cut mid-diacritic out of "Mã số thuế")
  // while `complete` stayed TRUE — a garbage identity that also becomes the
  // duplicate key of workstream B, so the same paper could be billed twice.
  const parsed = extractEinvoiceFields([
    "HÓA ĐƠN GIÁ TRỊ GIA TĂNG",
    "Mã số thuế: 0300000002",
    "Số: 0000049",
    "Ký hiệu: 1C25TAA",
    "Ngày lập: 20/09/2026",
    "Người bán: Đại lý Cám Bình Dương",
    "MST: 0300000002",
    "Người mua: Cửa hàng Cám Minh Phát",
    "MST: 0300000009",
    "1 Cám heo tăng trọng 25kg Bao 10 295.000 2.950.000",
    "2 Cám gà thịt 10kg Bao 5 250.000 1.250.000",
    "Tổng cộng: 4.200.000",
    "In số bản: 2",
  ]);
  assert.equal(parsed.complete, true, JSON.stringify(parsed.problems));
  assert.equal(parsed.header.invoice_no, "0000049");
  assert.equal(parsed.header.invoice_date, "2026-09-20");
});

test("A3 fields H1: when every `Số` belongs to another quantity, the number is MISSING — never \"luong\"", () => {
  const parsed = extractEinvoiceFields([
    "HÓA ĐƠN GTGT",
    "Mã số thuế: 0300000002",
    "Số lượng: 10",
    "Số điện thoại: 0901234567",
    "Ngày lập: 20/09/2026",
    "Người bán: Đại lý Cám Bình Dương",
    "1 Cám heo tăng trọng 25kg Bao 10 295.000 2.950.000",
  ]);
  assert.equal(parsed.complete, false);
  assert.equal(parsed.header.invoice_no, null);
  assert.ok(parsed.problems.some((p) => p.code === EINVOICE_CODES.MISSING_INVOICE_NO));
});

test("A3 fields H1: a bare `Số` does not take the line BELOW it — that is where a tax id lives", () => {
  // The next-line fallback is for a SPECIFIC label ("Số hoá đơn"), where nothing
  // else can be meant. A bare `Số` with an empty value followed by "0300000002"
  // is a document telling us it does not have a readable number — the number
  // below it belongs to whatever the NEXT label says, and here that is a tax id.
  const parsed = extractEinvoiceFields([
    "HÓA ĐƠN GTGT",
    "Số:",
    "0300000002",
    "Ngày lập: 20/09/2026",
    "Người bán: Đại lý Cám Bình Dương",
    "1 Cám heo tăng trọng 25kg Bao 10 295.000 2.950.000",
  ]);
  assert.equal(parsed.header.invoice_no, null);
  assert.ok(parsed.problems.some((p) => p.code === EINVOICE_CODES.MISSING_INVOICE_NO));
});

test("A3 fields H1: a bare `Số` with a LETTER value is not an invoice number", () => {
  // The context block cannot anticipate every label a provider invents, so the
  // digit requirement is the backstop: without it this line answers `seri` — the
  // same class of garbage as the measured `thu` (from "mã số thuế") and `b` (from
  // "in số bản"), and garbage here is a document identity nothing can verify.
  const parsed = extractEinvoiceFields([
    "HÓA ĐƠN GTGT",
    "Số seri: AA",
    "Ngày lập: 20/09/2026",
    "Người bán: Đại lý Cám Bình Dương",
    "MST: 0300000002",
    "1 Cám heo tăng trọng 25kg Bao 10 295.000 2.950.000",
  ]);
  assert.equal(parsed.header.invoice_no, null);
  assert.ok(parsed.problems.some((p) => p.code === EINVOICE_CODES.MISSING_INVOICE_NO));
});

test("A3 fields H1: even a SPECIFIC label does not take a tax id / a quantity from the line below", () => {
  // Found by probing the FIRST fix instead of trusting it: the next-line fallback
  // is correct for a specific label (the provider prints "Số hoá đơn:" and the
  // value on the next row), but it was reading OTHER labels' values through it.
  // Measured before this guard: ["Số hoá đơn:", "Mã số thuế: 0300000002"] answered
  // `invoice_no = "M"` and ["Số hoá đơn:", "Số lượng: 2"] answered "S" — a garbage
  // identity reaching the form AND workstream B's duplicate key, which is the
  // exact defect H1 was raised for, one branch over.
  for (const [name, below, mustBe] of [
    ["a tax id", "Mã số thuế: 0300000002", null],
    ["a quantity", "Số lượng: 2", null],
    // The one a digit requirement alone does NOT catch: a table row starts with
    // its own column value, so `valueToken` happily returns "1" and the row number
    // becomes the document's identity. Hence the whole-line rule.
    ["a TABLE ROW", "1 Cám heo tăng trọng 25kg Bao 10 295.000 2.950.000", null],
    ["another label", "Ngày lập: 20/09/2026", null],
  ]) {
    const parsed = extractEinvoiceFields([
      "HÓA ĐƠN GTGT",
      "Số hoá đơn:",
      below,
      "Ngày lập: 20/09/2026",
      "Người bán: Đại lý Cám Bình Dương",
      "MST: 0300000002",
      "1 Cám heo tăng trọng 25kg Bao 10 295.000 2.950.000",
    ]);
    assert.equal(parsed.header.invoice_no, mustBe, `${name} below a specific label must not become the number`);
    assert.ok(
      parsed.problems.some((p) => p.code === EINVOICE_CODES.MISSING_INVOICE_NO),
      `${name}: the document must report the number as MISSING, not guess one`,
    );
  }
  // Control: the SAME shape with a real value below still reads it — the guard
  // must not have turned the whole next-line fallback off.
  const good = extractEinvoiceFields([
    "HÓA ĐƠN GTGT",
    "Số hoá đơn:",
    "0000049",
    "Ngày lập: 20/09/2026",
    "Người bán: Đại lý Cám Bình Dương",
    "MST: 0300000002",
    "1 Cám heo tăng trọng 25kg Bao 10 295.000 2.950.000",
  ]);
  assert.equal(good.header.invoice_no, "0000049");
});

test("A3 fields H1: a specific label with a NON-numeric value is missing, not an abbreviation", () => {
  // "chưa có" tokenises to "ch"; the digit rule catches what the context list
  // cannot enumerate. Without it the number becomes "ch" and `complete` can still
  // be true, which is precisely the H1 shape.
  const parsed = extractEinvoiceFields([
    "HÓA ĐƠN GTGT",
    "Số hoá đơn: chưa có",
    "Ngày lập: 20/09/2026",
    "Người bán: Đại lý Cám Bình Dương",
    "MST: 0300000002",
    "1 Cám heo tăng trọng 25kg Bao 10 295.000 2.950.000",
  ]);
  assert.equal(parsed.header.invoice_no, null);
  assert.ok(parsed.problems.some((p) => p.code === EINVOICE_CODES.MISSING_INVOICE_NO));
});

test("A3 fields H1: `Mẫu số: 01/1P` is the FORM's number, not the invoice's", () => {
  // The digit guard alone would accept "01/1P" here (it carries digits). It is the
  // context block that keeps a form/blanks number from becoming the document id.
  const parsed = extractEinvoiceFields([
    "HÓA ĐƠN GTGT",
    "Mẫu số: 01/1P",
    "Số: 0000049",
    "Ngày lập: 20/09/2026",
    "Người bán: Đại lý Cám Bình Dương",
    "MST: 0300000002",
    "1 Cám heo tăng trọng 25kg Bao 10 295.000 2.950.000",
  ]);
  assert.equal(parsed.header.invoice_no, "0000049");
});

test("A3 fields M2: the invoice date comes from the invoice's own line, not the first date printed", () => {
  // Measured: "Ngày đặt hàng: 01/09/2026" standing ABOVE the invoice date won the
  // old first-date-anywhere scan ⇒ wrong `invoice_date` ⇒ wrong document key.
  const parsed = extractEinvoiceFields([
    "HÓA ĐƠN GTGT",
    "Số: 0000049",
    "Ngày đặt hàng: 01/09/2026",
    "Ngày lập: 20/09/2026",
    "Người bán: Đại lý Cám Bình Dương",
    "MST: 0300000002",
    "1 Cám heo tăng trọng 25kg Bao 10 295.000 2.950.000",
  ]);
  assert.equal(parsed.complete, true, JSON.stringify(parsed.problems));
  assert.equal(parsed.header.invoice_date, "2026-09-20");
  assert.equal(parsed.header.invoice_no, "0000049");
});

test("A3 fields M2: a date printed only in the footer is not the invoice date", () => {
  const parsed = extractEinvoiceFields([
    "HÓA ĐƠN GTGT",
    "Số: 0000049",
    "Người bán: Đại lý Cám Bình Dương",
    "MST: 0300000002",
    "1 Cám heo tăng trọng 25kg Bao 10 295.000 2.950.000",
    "In ngày 30/09/2026",
  ]);
  assert.equal(parsed.header.invoice_date, null);
  assert.ok(parsed.problems.some((p) => p.code === EINVOICE_CODES.MISSING_INVOICE_DATE));
});

test("A3 fields M2: two unlabelled dates are a refusal, not a coin flip", () => {
  const parsed = extractEinvoiceFields([
    "HÓA ĐƠN GTGT",
    "Số: 0000049",
    "20/09/2026",
    "01/09/2026",
    "Người bán: Đại lý Cám Bình Dương",
    "MST: 0300000002",
    "1 Cám heo tăng trọng 25kg Bao 10 295.000 2.950.000",
  ]);
  assert.equal(parsed.header.invoice_date, null);
  assert.ok(parsed.problems.some((p) => p.code === EINVOICE_CODES.MISSING_INVOICE_DATE));
});

test("A3 fields M2: exactly ONE unlabelled date is still accepted (the reader did not just get stricter)", () => {
  const parsed = extractEinvoiceFields([
    "HÓA ĐƠN GTGT",
    "Số: 0000049",
    "20/09/2026",
    "Người bán: Đại lý Cám Bình Dương",
    "MST: 0300000002",
    "1 Cám heo tăng trọng 25kg Bao 10 295.000 2.950.000",
  ]);
  assert.equal(parsed.header.invoice_date, "2026-09-20");
});

test("A3 fields M2: a LABELLED date wins over an unlabelled one printed earlier", () => {
  const parsed = extractEinvoiceFields([
    "HÓA ĐƠN GTGT",
    "Số: 0000049",
    "20/09/2026",
    "Ngày lập: 25/09/2026",
    "Người bán: Đại lý Cám Bình Dương",
    "MST: 0300000002",
    "1 Cám heo tăng trọng 25kg Bao 10 295.000 2.950.000",
  ]);
  assert.equal(parsed.header.invoice_date, "2026-09-25");
});

test("A3 fields: the seller's MST is attributed by BLOCK — a buyer printed first does not steal it", () => {
  // A \"first MST in the document wins\" reader answers 0300000009 here: the WRONG
  // supplier, and a purchase order raised against the shop's own customer record.
  const parsed = extractEinvoiceFields([
    "HÓA ĐƠN GTGT",
    "Ký hiệu: 1C25TAA Số: 0000051",
    "Ngày 21 tháng 09 năm 2026",
    "Người mua: Cửa hàng Cám Minh Phát",
    "MST: 0300000009",
    "Người bán: Đại lý Cám Bình Dương",
    "MST: 0300000002",
    "1 Cám heo tăng trọng 25kg Bao 10 295.000 2.950.000",
  ]);
  assert.equal(parsed.complete, true, JSON.stringify(parsed.problems));
  assert.equal(parsed.header.seller.tax_id, "0300000002");
  assert.equal(parsed.header.buyer.tax_id, "0300000009");
});

test("A3 fields: a phone number is never mistaken for a tax id, and one MST without a party block is a WARNING", () => {
  const parsed = extractEinvoiceFields([
    "HÓA ĐƠN GTGT",
    "Ký hiệu: 1C25TAA Số: 0000052",
    "Ngày 22 tháng 09 năm 2026",
    "Đại lý Cám Bình Dương",
    "Điện thoại: 0909123456",
    "MST: 0300000002",
    "1 Cám heo tăng trọng 25kg Bao 10 295.000 2.950.000",
  ]);
  assert.equal(parsed.header.seller.tax_id, "0300000002");
  assert.ok(
    parsed.warnings.some((w) => w.code === "PDF_MST_UNLABELLED"),
    "an unlabelled seller block must SAY so, not claim certainty",
  );
});

test("A3 fields: a row's own arithmetic settles an ambiguous number — and an unclear row is a problem", () => {
  // \"1.234\" is either 1234 or 1.234. Only 1234 makes the document's own
  // multiplication close, so that is the reading — no preference is applied.
  const settled = extractEinvoiceFields([
    "Ký hiệu: 1C25TAA Số: 0000053",
    "Ngày 23 tháng 09 năm 2026",
    "Người bán: Đại lý Cám Bình Dương",
    "MST: 0300000002",
    "1 Bột đá 1.234 1.000 1.234.000",
    "2 Cám heo tăng trọng 25kg Bao 10 295.000 2.950.000",
  ]);
  assert.equal(settled.complete, true, JSON.stringify(settled.problems));
  assert.equal(settled.lines[0].qty, 1234);
  assert.equal(settled.lines[0].amount, 1_234_000);
  // A decimal-comma quantity is a real thing on a printed invoice.
  const decimals = extractEinvoiceFields([
    "Ký hiệu: 1C25TAA Số: 0000054",
    "Ngày 23 tháng 09 năm 2026",
    "Người bán: Đại lý Cám Bình Dương",
    "MST: 0300000002",
    "1 Cám heo tăng trọng 25kg Bao 10,5 100.000 1.050.000",
  ]);
  assert.equal(decimals.lines[0].qty, 10.5);

  // The multiplication does NOT close ⇒ nothing is invented: the row is a problem
  // (and therefore an incomplete document), never a plausible-looking line.
  const broken = extractEinvoiceFields([
    "Ký hiệu: 1C25TAA Số: 0000055",
    "Ngày 23 tháng 09 năm 2026",
    "Người bán: Đại lý Cám Bình Dương",
    "MST: 0300000002",
    "1 Cám heo tăng trọng 25kg Bao 10 295.000 9.999.999",
  ]);
  assert.equal(broken.complete, false);
  assert.equal(broken.lines.length, 0);
  assert.match(broken.problems.map((p) => p.reason).join(" "), /KHÔNG khớp/);
});

test("A3 fields: the parser refuses to read a document with no readable identity or no rows", () => {
  const parsed = extractEinvoiceFields(["Chỉ là mấy dòng chữ", "không có gì liên quan"]);
  assert.equal(parsed.complete, false);
  const codes = parsed.problems.map((p) => p.code);
  assert.ok(codes.includes(EINVOICE_CODES.MISSING_INVOICE_NO));
  assert.ok(codes.includes(EINVOICE_CODES.MISSING_INVOICE_DATE));
  assert.ok(codes.includes(EINVOICE_CODES.MISSING_SELLER));
  assert.ok(codes.includes(EINVOICE_CODES.NO_LINES));
});

test("A3 numbers: every reading is returned, and non-numbers are not numbers", () => {
  assert.deepEqual(pdfNumberReadings("295.000"), [295000, 295]);
  // Two groups have exactly ONE reading: the decimal reading of "4.200.000" is
  // `Number("4.200.000")` = NaN (two dots), and a NaN candidate would poison the
  // arithmetic that is supposed to settle an ambiguity — so it is dropped.
  assert.deepEqual(pdfNumberReadings("4.200.000"), [4200000]);
  assert.deepEqual(pdfNumberReadings("10"), [10]);
  assert.deepEqual(pdfNumberReadings("10,5"), [10.5]);
  assert.deepEqual(pdfNumberReadings("1.234.000đ"), [1234000]);
  assert.deepEqual(pdfNumberReadings("4.200.000:"), [4200000]);
  // One group of three is genuinely two numbers: "295.000" is 295000 (printed
  // thousands) or 295 (a decimal) — and only the ROW's arithmetic may choose.
  assert.equal(pdfNumberReadings("12/09/2026").length, 0, "a date is not a number");
  assert.equal(pdfNumberReadings("Cám").length, 0);
});

/* ───────────────────────────── 4. whole-channel ───────────────────────────── */

test("A3 bytes M1: a stream that inflates past the OUTPUT cap refuses BY NAME, and zlib aborts first", () => {
  // The measured bomb was 106.884 compressed bytes → 31.457.284 bytes (294×) and
  // +541 MB RSS. This one keeps the FILE tiny (the whole point: it passes the byte
  // cap) while its DECOMPRESSED size is far past the policy's output cap. Without
  // `maxOutputLength` this test cannot pass: inflation would succeed and the file
  // would fail later with some other code.
  const bomb = inflatedBombPdf();
  assert.ok(bomb.bytes.length < POLICY.max_pdf_bytes, "the bomb must pass the FILE cap — that is what makes it a bomb");
  assert.ok(bomb.inflatedBytes > POLICY.max_inflated_bytes, "…while its output must exceed the OUTPUT cap");
  const started = Date.now();
  assert.throws(
    () => extractPdfText(bomb.bytes, { policy: POLICY }),
    (err) => err.code === PDF_CODES.INFLATED_TOO_LARGE,
  );
  assert.ok(
    Date.now() - started < 2000,
    "the refusal must come from zlib aborting mid-inflation, not from inflating 20 MB and then checking",
  );
});

test("A3 bytes L1: a text layer with more lines than any invoice refuses DURING construction, not after", () => {
  // L1 — the other face of M1. `max_lines` is checked in layer 2, i.e. after the
  // whole `lines` array exists; the measured case built 341.927 lines and only
  // then popped back to 200, so the array (not the row count) was the memory. The
  // cap this test pins is on CONSTRUCTION, and it must fire on a file that passes
  // every other limit: small compressed, small inflated, real text.
  const lines = 20_100; // > max_lines(200) x 100
  let content = "BT /F1 10 Tf 12 TL 40 700 Td\n";
  for (let i = 0; i < lines; i += 1) content += `(Dong ${i}) Tj T*\n`;
  const stream = Buffer.from(content, "latin1");
  const bytes = Buffer.concat([
    Buffer.from(
      `%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n3 0 obj\n<< /Type /Page /Parent 2 0 R /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>\nendobj\n4 0 obj\n<< /Length ${stream.length} >>\nstream\n`,
      "latin1",
    ),
    stream,
    Buffer.from(
      "\nendstream\nendobj\n5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n",
      "latin1",
    ),
  ]);
  // Not a size refusal: the file is well under the byte cap, which is what makes
  // the line cap the only thing standing between us and the array.
  assert.ok(bytes.length < POLICY.max_pdf_bytes, `the fixture must pass the file cap (${bytes.length})`);
  assert.throws(
    () => extractPdfText(bytes, { policy: POLICY }),
    (err) => err.code === PDF_CODES.TOO_MANY_LINES,
  );
  // Control: the same SHAPE with a normal number of lines still reads — the cap
  // must not have turned ordinary multi-page invoices into refusals.
  const small = Buffer.from(
    `%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n3 0 obj\n<< /Type /Page /Parent 2 0 R /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>\nendobj\n4 0 obj\n<< /Length ${Buffer.byteLength("BT /F1 10 Tf 12 TL 40 700 Td\n(Chi mot dong) Tj T*\n")} >>\nstream\nBT /F1 10 Tf 12 TL 40 700 Td\n(Chi mot dong) Tj T*\n\nendstream\nendobj\n5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n`,
    "latin1",
  );
  assert.deepEqual(extractPdfText(small, { policy: POLICY }).lines, ["Chi mot dong"]);
});

test("A3: the two renderings of ONE invoice produce the SAME identity (nothing is invented)", () => {
  const cid = parseEinvoicePdf(fixtureBytes(CID), { policy: POLICY });
  const win = parseEinvoicePdf(fixtureBytes(WINANSI), { policy: POLICY });
  assert.equal(cid.source, "einvoice_pdf");
  assert.equal(win.source, "einvoice_pdf");
  for (const field of ["invoice_no", "invoice_series", "invoice_date", "net_total_vnd", "total_vnd"]) {
    assert.deepEqual(win.header[field], cid.header[field], `${field} must be identical across renderings`);
  }
  assert.equal(win.header.seller.tax_id, cid.header.seller.tax_id, "the MST is the identity on both");
  // The TABLE is the same table: every NUMBER is identical (a quantity read
  // differently from the other rendering would be a read, not a rendering).
  assert.equal(win.lines.length, cid.lines.length);
  for (const [i, line] of cid.lines.entries()) {
    for (const field of ["index", "qty", "uom", "unit_price", "amount"]) {
      assert.deepEqual(win.lines[i][field], line[field], `line ${i + 1}.${field}`);
    }
    // …while the DESCRIPTION is whatever the file printed, accents and all: the
    // two differ ONLY by the diacritics the ASCII file never had. Guessing them
    // back would put a name on the document that the document does not say.
    assert.equal(
      win.lines[i].description.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/đ/g, "d"),
      line.description.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/đ/g, "d"),
    );
  }
  assert.equal(cid.header.seller.name, "Đại lý Cám Bình Dương");
  assert.equal(win.header.seller.name, "Dai ly Cam Binh Duong");
});

/* ─────────────────────────────── 5. the route ─────────────────────────────── */

async function startGateway() {
  const { createAskServer } = await import("../src/http-ask.mjs");
  const server = createAskServer({
    port: 0,
    host: "127.0.0.1",
    env: { ...process.env },
    limiter: RateLimiter.disabled(),
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    post: (p, body) =>
      fetch(`${base}${p}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
    stop: () => new Promise((r) => server.close(r)),
  };
}

test("A3 /input/einvoice: a PDF becomes the SAME slots as an XML file — and writes nothing", async () => {
  const srv = await startGateway();
  try {
    const res = await srv.post("/input/einvoice", {
      pdf_base64: fixtureBytes(CID).toString("base64"),
      kind: "purchase",
    });
    const payload = await res.json();
    assert.equal(res.status, 200, JSON.stringify(payload).slice(0, 400));
    const { result } = payload;
    assert.equal(result.capability, "purchase_order.create");
    assert.equal(result.kind, "purchase");
    // The reader is named, and it is NOT the XML one.
    assert.equal(result.provenance.source, "einvoice_pdf");
    assert.equal(result.provenance.from_file, true);
    assert.equal(result.source_document.source, "einvoice_pdf");
    // The party resolves by the document's own MST against the site's master list.
    assert.equal(result.party.resolved.id, "SUP-BINH-DUONG");
    assert.equal(result.party.matched_by, "tax_id");
    assert.equal(result.party.claimed_tax_id, "0300000002");
    // Lines carry ERPNext item ids ONLY where a row of the catalogue matched; no
    // price from the file ever appears, and no command/proposal exists here.
    assert.equal(result.lines.length, 2);
    assert.equal(result.lines[0].item_code, "CAM-HEO-25KG");
    assert.equal(result.lines[0].qty, 10);
    assert.equal(result.lines[0].uom, "Bao");
    for (const key of ["proposal", "action", "command_id", "params", "risk", "rate", "price"]) {
      assert.equal(key in result, false, `${key} must not appear on einvoice slots`);
    }
    // next3/B: the identity the PDF gave is the same shape the XML channel gives,
    // so the two channels dedupe against each other.
    assert.equal(result.source_document.invoice_no, "0000049");
    assert.equal(result.source_document.invoice_date, "2026-09-20");
    assert.equal(result.source_document.seller_tax_id, "0300000002");
  } finally {
    await srv.stop();
  }
});

test("A3 /input/einvoice: PDF refusals keep their own status codes, and both payloads at once is a 400", async () => {
  const srv = await startGateway();
  try {
    const cases = [
      ["a scan", { pdf_base64: fixtureBytes("hd-pdf-no-textlayer.pdf").toString("base64"), kind: "purchase" }, 422, PDF_CODES.NO_TEXT],
      ["an encrypted file", { pdf_base64: fixtureBytes("hd-pdf-encrypted.pdf").toString("base64"), kind: "purchase" }, 422, PDF_CODES.ENCRYPTED],
      ["an unmappable font", { pdf_base64: fixtureBytes("hd-pdf-tounicode-nomap.pdf").toString("base64"), kind: "purchase" }, 422, PDF_CODES.TEXT_UNMAPPED],
      ["not a PDF", { pdf_base64: Buffer.from("hello world, not a pdf").toString("base64"), kind: "purchase" }, 400, PDF_CODES.NOT_A_PDF],
      [
        "over the cap",
        { pdf_base64: Buffer.concat([fixtureBytes(CID), Buffer.alloc(POLICY.max_pdf_bytes, 0x20)]).toString("base64"), kind: "purchase" },
        413,
        PDF_CODES.TOO_LARGE,
      ],
      // M1: a size refusal of the SECOND kind — small enough to send, too big to
      // decompress — carries 413 as well, but its own code, because the advice
      // differs ("send a smaller file" vs "this is not an ordinary invoice").
      [
        "a compression bomb",
        { pdf_base64: inflatedBombPdf().bytes.toString("base64"), kind: "purchase" },
        413,
        PDF_CODES.INFLATED_TOO_LARGE,
      ],
      ["an unknown kind", { pdf_base64: fixtureBytes(CID).toString("base64"), kind: "sales" }, 400, "EINVOICE_KIND_UNKNOWN"],
      [
        "both payloads",
        { pdf_base64: fixtureBytes(CID).toString("base64"), xml: "<HDon/>", kind: "purchase" },
        400,
        "EINVOICE_INPUT_AMBIGUOUS",
      ],
    ];
    for (const [name, body, status, code] of cases) {
      const res = await srv.post("/input/einvoice", body);
      const payload = await res.json();
      assert.equal(res.status, status, `${name}: ${JSON.stringify(payload).slice(0, 200)}`);
      assert.equal(payload.code, code, name);
      assert.equal(payload.ok, false, name);
    }
  } finally {
    await srv.stop();
  }
});
