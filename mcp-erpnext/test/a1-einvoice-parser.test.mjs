/**
 * A1 — HĐĐT XML → structured reading (`.plan/next3/implementation.md` A0/A1).
 *
 * What this file is for: the parser is the only place a supplier's XML is turned
 * into numbers, so every claim it makes is pinned here against four fixtures:
 *
 *   1. a canonical TT78 file whose seller MST and goods really exist on the
 *      shop's site (so A2 can prove an end-to-end run on real data);
 *   2. a provider file with a PREFIXED NAMESPACE, an XML declaration, a comment,
 *      CDATA, a timestamp date and no seller MST — the shape a single-provider
 *      parser breaks on;
 *   3. a tax-message wrapper (`TDiep/DLieu/HDon`), a seller with a name but no
 *      MST, a goods line that is NOT in the item master, and an injected
 *      instruction inside the buyer's name;
 *   4. numbers written with thousand separators — OUTSIDE the spec's number
 *      format, and exactly the case where a lenient parser silently multiplies
 *      by 1000.
 *
 * The load-bearing assertions are therefore about REFUSALS: an unreadable number
 * is null (not a guess), an incomplete file says so, and a file that is not an
 * invoice at all is refused rather than half-read.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const FIXTURES = path.join(HERE, "fixtures", "einvoice");

const {
  EINVOICE_CODES,
  EinvoiceError,
  parseEinvoiceXml,
  strictDate,
  strictNumber,
  einvoiceLimits,
} = await import("../src/einvoice/einvoice-xml.mjs");

const fixture = (name) => readFileSync(path.join(FIXTURES, name), "utf8");

test("A1: the canonical TT78 file reads its header and both goods lines", () => {
  const parsed = parseEinvoiceXml(fixture("tt78-basic.xml"));
  assert.equal(parsed.source, "einvoice_xml");
  assert.equal(parsed.header.invoice_no, "0000123");
  assert.equal(parsed.header.invoice_form, "1");
  assert.equal(parsed.header.invoice_series, "C26TYY");
  assert.equal(parsed.header.invoice_date, "2026-09-20");
  assert.equal(parsed.header.currency, "VND");
  assert.equal(parsed.header.seller.tax_id, "0300000002");
  assert.equal(parsed.header.seller.name, "Đại lý Cám Bình Dương");
  // The entity decodes: the buyer's name really carries an ampersand.
  assert.equal(parsed.header.buyer.name, "Minh Phát Cám & VLXD");
  assert.equal(parsed.header.net_total_vnd, 4_025_000);
  assert.equal(parsed.header.tax_total_vnd, 402_500);
  assert.equal(parsed.header.total_vnd, 4_427_500);
  assert.equal(parsed.lines.length, 2);
  assert.deepEqual(
    parsed.lines.map((l) => [l.description, l.qty, l.uom, l.unit_price, l.amount]),
    [
      ["Cám gà thịt 25kg", 10, "Bao", 270_000, 2_700_000],
      ["Cám heo tăng trọng 25kg", 5, "Bao", 265_000, 1_325_000],
    ],
  );
  assert.equal(parsed.complete, true, JSON.stringify(parsed.problems));
  assert.equal(parsed.instruction_pattern_found, false);
});

test("A1: a provider file with a namespace prefix, CDATA and a timestamp still reads", () => {
  const parsed = parseEinvoiceXml(fixture("provider-namespace.xml"));
  assert.equal(parsed.header.invoice_no, "0000456");
  assert.equal(parsed.header.invoice_series, "C26MPH");
  // A dateTime is truncated to its date part (the spec's own two forms).
  assert.equal(parsed.header.invoice_date, "2026-09-21");
  assert.equal(parsed.header.seller.name, "Nhà máy Cám Đại Thành");
  assert.equal(parsed.lines.length, 1);
  assert.equal(parsed.lines[0].description, "Xi măng PCB40");
  assert.equal(parsed.lines[0].qty, 20);
  // The seller carries NO MST (real provider files vary) — that makes the file
  // INCOMPLETE (QĐ 1450 lists NBan/MST as bắt buộc), reported as a problem, but
  // everything else still reads.
  assert.equal(parsed.header.seller.tax_id, null);
  assert.equal(parsed.complete, false);
  assert.ok(parsed.problems.some((p) => /MST người bán/.test(p.reason)), JSON.stringify(parsed.problems));
});

test("A1: a tax-message wrapper is unwrapped, and injected text is neutralised", () => {
  const parsed = parseEinvoiceXml(fixture("edge-unmatched-item.xml"));
  assert.equal(parsed.header.invoice_no, "0000999");
  assert.equal(parsed.header.invoice_date, "2026-09-22");
  assert.equal(parsed.header.seller.name, "Cửa hàng Bao bì Tân Phú");
  assert.equal(parsed.header.seller.tax_id, "0300000009");
  assert.equal(parsed.lines[0].description, "Bao bì nilon loại 50kg");
  assert.equal(parsed.lines[0].qty, 500);
  // The buyer's name is a field of an UNTRUSTED document: an instruction printed
  // in it is neutralised, and the neutralisation is reported.
  assert.doesNotMatch(parsed.header.buyer.name, /ignore previous instructions/i);
  assert.match(parsed.header.buyer.name, /đã lọc chỉ dẫn/);
  assert.equal(parsed.instruction_pattern_found, true);
  // The seller HAS a name and MST and the line is complete: nothing is wrong
  // with the FILE. That a good item is missing from the shop's master list is a
  // SLOTS-level (A2) warning, not a parse failure.
  assert.equal(parsed.complete, true, JSON.stringify(parsed.problems));
});

test("A1: a number outside the spec format is REFUSED, never rescaled", () => {
  const parsed = parseEinvoiceXml(fixture("edge-bad-number.xml"));
  const line = parsed.lines[0];
  // "1.234.567" is not a number in this spec (':' is the decimal separator, and
  // no thousands separator exists) — so it must NOT become 1234.567 or 1234567.
  assert.equal(line.qty, null);
  assert.equal(line.unit_price, null);
  assert.equal(parsed.complete, false);
  const codes = parsed.problems.map((p) => p.code);
  assert.ok(codes.includes(EINVOICE_CODES.BAD_NUMBER), JSON.stringify(codes));
  assert.ok(codes.includes(EINVOICE_CODES.LINE_UNUSABLE), JSON.stringify(codes));
});

test("A1: strictNumber accepts the spec's form and nothing else", () => {
  assert.equal(strictNumber("10"), 10);
  assert.equal(strictNumber("0.5"), 0.5);
  assert.equal(strictNumber(" 270000 \n"), 270_000);
  assert.equal(strictNumber("0.0001"), 0.0001);
  for (const bad of ["1.234.567", "1,234", "10 000", "abc", "", null, undefined, "1e3", "10%", "-", "0.00001"]) {
    assert.equal(strictNumber(bad), null, `strictNumber(${JSON.stringify(bad)})`);
  }
});

test("A1: strictDate takes the spec's forms and refuses impossible ones", () => {
  assert.equal(strictDate("2026-09-20"), "2026-09-20");
  assert.equal(strictDate("2026-09-21T09:15:02"), "2026-09-21");
  for (const bad of ["21/09/2026", "2026-13-01", "2026-09-32", "20260921", "", null]) {
    assert.equal(strictDate(bad), null, `strictDate(${JSON.stringify(bad)})`);
  }
});

test("A1: malformed, empty, oversized and non-invoice files are each refused by code", () => {
  const cases = [
    ["", EINVOICE_CODES.XML_EMPTY],
    ["   ", EINVOICE_CODES.XML_EMPTY],
    ["<HDon><DLHDon><TTChung>", EINVOICE_CODES.XML_MALFORMED],
    ["<HDon></NotHDon>", EINVOICE_CODES.XML_MALFORMED],
    ["<HDon><DLHDon><TTChung><SHDon>1</SHDon>", EINVOICE_CODES.XML_MALFORMED],
    ["not xml at all", EINVOICE_CODES.XML_MALFORMED],
    ["<?xml version='1.0'?><DanhSachKhachHang><Khach><Ten>Lan</Ten></Khach></DanhSachKhachHang>", EINVOICE_CODES.XML_NOT_INVOICE],
  ];
  for (const [xml, code] of cases) {
    assert.throws(
      () => parseEinvoiceXml(xml),
      (err) => err instanceof EinvoiceError && err.code === code,
      `${JSON.stringify(xml).slice(0, 40)} → ${code}`,
    );
  }
});

test("A1: well-formed XML that is not a usable invoice comes back as PROBLEMS, not as a throw", () => {
  // A valid tree with an empty invoice body is not corruption — it is an
  // invoice whose required fields are absent. That difference matters: the route
  // answers 400 (the caller's file is unreadable) for the first case and 422
  // (an invoice we could not take enough from) for this one.
  const parsed = parseEinvoiceXml("<HDon><DLHDon/></HDon>");
  assert.equal(parsed.complete, false);
  const codes = parsed.problems.map((p) => p.code);
  assert.ok(codes.includes(EINVOICE_CODES.MISSING_INVOICE_NO), JSON.stringify(codes));
  assert.ok(codes.includes(EINVOICE_CODES.MISSING_INVOICE_DATE), JSON.stringify(codes));
  assert.ok(codes.includes(EINVOICE_CODES.MISSING_SELLER), JSON.stringify(codes));
  assert.ok(codes.includes(EINVOICE_CODES.NO_LINES), JSON.stringify(codes));
});

test("A1: the size cap is enforced before parsing, and comes from the contract policy", () => {
  const big = `<HDon><DLHDon><TTChung><SHDon>${"9".repeat(300)}</SHDon></TTChung></DLHDon></HDon>`;
  assert.throws(
    () => parseEinvoiceXml(big, { policy: { max_xml_bytes: 100, max_lines: 10 } }),
    (err) => err.code === EINVOICE_CODES.XML_TOO_LARGE,
  );
  // Defaults are the documented ones; the contract value wins when supplied.
  assert.deepEqual(einvoiceLimits(null), { maxXmlBytes: 2_000_000, maxLines: 200 });
  assert.deepEqual(einvoiceLimits({ max_xml_bytes: 4096, max_lines: 3 }), { maxXmlBytes: 4096, maxLines: 3 });
});

test("A1: a file whose seller lacks ONLY the MST is incomplete (NBan/MST is bắt buộc)", () => {
  const xml = `<?xml version="1.0"?><HDon><DLHDon><TTChung><SHDon>1</SHDon><NLap>2026-09-20</NLap></TTChung><NDHDon><NBan><Ten>Cửa hàng A</Ten></NBan><DSHHDVu><HHDVu><THHDVu>Thép D10</THHDVu><DVTinh>Kg</DVTinh><SLuong>2</SLuong></HHDVu></DSHHDVu><TToan><TgTTTBSo>2</TgTTTBSo></TToan></NDHDon></DLHDon></HDon>`;
  const parsed = parseEinvoiceXml(xml);
  assert.equal(parsed.complete, false);
  assert.ok(parsed.problems.some((p) => /MST người bán/.test(p.reason)), JSON.stringify(parsed.problems));
});

test("A1: an over-long invoice reports the line limit instead of truncating silently", () => {
  const row = (i) => `<HHDVu><STT>${i}</STT><THHDVu>Thép D10</THHDVu><DVTinh>Kg</DVTinh><SLuong>1</SLuong></HHDVu>`;
  const xml = `<?xml version="1.0"?><HDon><DLHDon><TTChung><SHDon>1</SHDon><NLap>2026-09-20</NLap></TTChung><NDHDon><NBan><Ten>A</Ten><MST>1</MST></NBan><DSHHDVu>${row(1)}${row(2)}${row(3)}</DSHHDVu><TToan><TgTTTBSo>3</TgTTTBSo></TToan></NDHDon></DLHDon></HDon>`;
  const parsed = parseEinvoiceXml(xml, { policy: { max_xml_bytes: 100_000, max_lines: 2 } });
  assert.ok(parsed.problems.some((p) => p.code === EINVOICE_CODES.LINE_LIMIT), JSON.stringify(parsed.problems));
});

test("A1: the output carries NO authoritative identifier — only the document's own words and numbers", () => {
  // `.xml` only: the directory also holds the A3 PDF fixtures, and handing a PDF
  // to the XML reader is a different test (it must refuse it, and does).
  for (const name of readdirSync(FIXTURES).filter((f) => f.endsWith(".xml"))) {
    const parsed = parseEinvoiceXml(fixture(name));
    // No site id may appear anywhere: the parser never sees the site.
    for (const line of parsed.lines) {
      assert.deepEqual(
        Object.keys(line).sort(),
        ["amount", "description", "index", "qty", "tax_rate", "unit_price", "uom"],
        `${name}: a parsed line may not carry an ERPNext field`,
      );
    }
    assert.deepEqual(
      Object.keys(parsed.header).sort(),
      [
        "buyer",
        "currency",
        "invoice_date",
        "invoice_form",
        "invoice_no",
        "invoice_series",
        "net_total_vnd",
        "seller",
        "tax_total_vnd",
        "total_vnd",
      ],
      `${name}: unexpected header field`,
    );
  }
});

/* ─────────────────────────────────────────────────────────────────────────────
 * The static guard: this layer may never grow a write surface.
 * ──────────────────────────────────────────────────────────────────────────── */

function einvoiceSources() {
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const p = path.join(dir, entry);
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith(".mjs")) files.push([p, readFileSync(p, "utf8")]);
    }
  };
  walk(path.join(REPO, "src", "einvoice"));
  return files;
}

test("A1 (static): src/einvoice has no write surface, no routing and no ERPNext access", () => {
  const sources = einvoiceSources();
  assert.ok(sources.length >= 2, "expected the parser and the slots module");
  for (const [file, src] of sources) {
    for (const forbidden of [
      /safety-gateway/,
      /executeProposal/,
      /erpnext_doc_create/,
      /erpnext_doc_submit/,
      /callWriteTool/,
      /callTool/,
      /skills\//,
      /docstatus/,
      /writeFile|appendFile|createWriteStream/,
      /routeIntent\(/,
      /idempotency/,
    ]) {
      assert.doesNotMatch(src, forbidden, `${path.relative(REPO, file)} must not reference ${forbidden}`);
    }
  }
  // The parsers are PURE: they do not know about the pipeline, the policy object
  // is handed to them, and they never read a file (the caller reads the upload).
  //
  // L3 (2026-09-25): this guard used to name ONE file (`einvoice-xml.mjs`) while
  // the loop above already walked the whole directory — so `einvoice-pdf.mjs` was
  // covered by the write-surface checks and NOT by the sync/pure one, even though
  // it is sync today (grep: 0 hits). A guard that covers "the file I was editing"
  // stops covering the module added next, which is exactly how a parser grows an
  // `await` (and with it an I/O surface) without anyone noticing.
  assert.ok(sources.length >= 2, "expected every module of the channel");
  for (const [file, src] of sources) {
    assert.doesNotMatch(src, /await |async /, `${path.relative(REPO, file)} must stay synchronous and pure`);
  }
});
