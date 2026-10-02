/**
 * A2 — the e-invoice FILE channel end-to-end on the mock (`.plan/next3/implementation.md`
 * workstream A). The real-site loop lives in `.plan/next3/loop-a2-einvoice-real.mjs`.
 *
 * What this file proves, in the order the safety argument runs:
 *  1. the CONTRACT: `einvoice_policy` is validated fail-closed — weakening any
 *     boundary (sanitize off, authoritative ids on, a kind the photo table does
 *     not declare) makes the whole contract invalid;
 *  2. the SLOTS: parsed invoice → the same slot shape the camera produces, with
 *     the seller resolved by tax id FIRST (the document's business key), by name
 *     second, and an unknown MST reported — never auto-created, never auto-picked;
 *  3. the ROUTE: throttle → kind → parse/completeness → authorize → master data;
 *     refusals carry their own status codes and the success carries NO write
 *     surface (no proposal, no command, no price);
 *  4. the LOG: metadata only — the file's text is never echoed.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, readdirSync } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import path from "node:path";

// Hermetic: a shell that sourced .env would otherwise make createAskServer()
// resolve the REAL ERPNext target. Same rule as http-ask.test.mjs.
for (const k of Object.keys(process.env)) {
  if (/^(ERPNEXT_|ASK_)/.test(k)) delete process.env[k];
}
const LOG_DIR = mkdtempSync(path.join(tmpdir(), "a2-learning-"));
process.env.LEARNING_LOG_DIR = LOG_DIR;
// Same convention `npm test` uses (package.json): the mock is EXPLICIT in tests,
// never a silent fallback.
process.env.COPILOT_MOCK_OK = "1";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const REPO = path.resolve(ROOT, "..");
const FIXTURES = path.join(HERE, "fixtures", "einvoice");
const fixture = (name) => readFileSync(path.join(FIXTURES, name), "utf8");

const { validateContract, __contract, einvoicePolicy, einvoiceDocumentKinds } = await import(
  "../src/capability-contract.mjs"
);
const { parseEinvoiceXml, EINVOICE_CODES } = await import("../src/einvoice/einvoice-xml.mjs");
const {
  EINVOICE_SLOTS_CODES,
  assertParsedComplete,
  buildEinvoiceSlots,
  kindSpec,
} = await import("../src/einvoice/einvoice-slots.mjs");
const { RateLimiter } = await import("../src/rate-limit.mjs");

// ─────────────────────────────────────────────────────────────────────────────
// 1. the contract owns the boundary
// ─────────────────────────────────────────────────────────────────────────────

test("A2: the contract declares the file channel with unrelaxable boundaries", () => {
  const p = einvoicePolicy();
  assert.equal(p.authoritative_identifiers, false);
  assert.equal(p.require_untrusted_sanitize, true);
  assert.equal(p.source, "einvoice_xml");
  assert.ok(p.max_xml_bytes > 0 && p.max_xml_bytes < 1_000_000, "below the gateway's 1MB body cap");
  assert.ok(p.max_lines > 0);
  // M1: the OUTPUT cap is a separate number from the input cap, and it must be
  // declared (not left to the reader's default) so a reviewer sees it here.
  assert.ok(Number.isInteger(p.max_inflated_bytes) && p.max_inflated_bytes > p.max_pdf_bytes);
  // Offered kinds must be a SUBSET of the one kind table.
  const known = Object.keys(__contract.ocr_policy.document_kinds).filter((k) => k !== "comment");
  for (const kind of p.document_kinds) assert.ok(known.includes(kind));
  // Resolving them yields full contract entries.
  const resolved = einvoiceDocumentKinds();
  assert.equal(resolved.purchase.capability, "purchase_order.create");
  assert.equal(resolved.purchase.party, "supplier");
});

test("A2: weakening the einvoice_policy boundary invalidates the whole contract", () => {
  const clone = () => JSON.parse(JSON.stringify(__contract));
  const cases = [
    ["sanitize off", (c) => (c.einvoice_policy.require_untrusted_sanitize = false), /require_untrusted_sanitize/],
    ["authoritative ids on", (c) => (c.einvoice_policy.authoritative_identifiers = true), /authoritative_identifiers/],
    ["wrong source", (c) => (c.einvoice_policy.source = "einvoice_pdf"), /source/],
    ["zero byte cap", (c) => (c.einvoice_policy.max_xml_bytes = 0), /max_xml_bytes/],
    ["an offered kind the photo table does not declare", (c) => (c.einvoice_policy.document_kinds.push("delivery")), /document_kinds/],
    // M1 (2026-09-25): the two PDF caps are a boundary too, so weakening either
    // is refused at load time rather than silently overridden by a code default.
    ["zero pdf file cap", (c) => (c.einvoice_policy.max_pdf_bytes = 0), /max_pdf_bytes/],
    ["non-integer pdf file cap", (c) => (c.einvoice_policy.max_pdf_bytes = "650000"), /max_pdf_bytes/],
    ["zero inflated-output cap", (c) => (c.einvoice_policy.max_inflated_bytes = 0), /max_inflated_bytes/],
    ["non-integer inflated-output cap", (c) => (c.einvoice_policy.max_inflated_bytes = "8MB"), /max_inflated_bytes/],
  ];
  for (const [name, mutate, expected] of cases) {
    const c = clone();
    mutate(c);
    assert.throws(() => validateContract(c), expected, name);
  }
  // Control: the untouched contract still validates.
  assert.equal(validateContract(clone()), true);
  // The byte cap of the SHIPPED contract is deliberately below the gateway's
  // 1 MB body limit (MAX_BODY in http-ask.mjs) — pin the shipped VALUE so a
  // raised cap cannot silently hand the refusal to the transport layer.
  assert.ok(einvoicePolicy().max_xml_bytes < 1_000_000, JSON.stringify(einvoicePolicy().max_xml_bytes));
  // M1: pin the SHIPPED decompression cap too. It must be a real multiple of the
  // file cap (a stream that inflates 30x its own compressed size is a bomb, not
  // an invoice) and must never be absent — the reader would fall back to a code
  // default, which is exactly how a boundary stops being visible in review.
  const pdfCap = einvoicePolicy().max_inflated_bytes;
  assert.ok(Number.isInteger(pdfCap) && pdfCap > 0, `max_inflated_bytes must be declared, got ${pdfCap}`);
  assert.ok(pdfCap < 32_000_000, `max_inflated_bytes ${pdfCap} is too close to the measured bomb (31.457.284 bytes)`);
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. the slots (tax id first, name second, unknown reported)
// ─────────────────────────────────────────────────────────────────────────────

const ITEMS = [
  { name: "CAM-GA-25KG", item_name: "Cám gà thịt 25kg", stock_uom: "Bao" },
  { name: "CAM-HEO-25KG", item_name: "Cám heo tăng trọng 25kg", stock_uom: "Bao" },
  { name: "XM-PCB40", item_name: "Xi măng PCB40", stock_uom: "Bao" },
];
const SUPPLIERS = [
  { name: "SUP-HATIEN", supplier_name: "Hà Tiên", tax_id: null },
  // The tax-id twin the fixture resolves by (mock mirrors the real site's MST).
  { name: "SUP-BINH-DUONG", supplier_name: "Đại lý Cám Bình Dương", tax_id: "0300000002" },
  // A supplier whose MST is stored — proving name fallback only fires when the
  // claimed MST really is unknown, not when the master row carries one.
  { name: "SUP-THIEN-NAM", supplier_name: "Cửa hàng Bao bì Tân Phú", tax_id: "0300000019" },
];

test("A2: the seller resolves by TAX ID first — the document's own business key", () => {
  const parsed = parseEinvoiceXml(fixture("tt78-basic.xml"));
  const spec = kindSpec("purchase");
  const slots = buildEinvoiceSlots({ parsed, spec, items: ITEMS, parties: SUPPLIERS });
  assert.equal(slots.party.role, "supplier");
  assert.deepEqual(slots.party.resolved, { id: "SUP-BINH-DUONG", name: "Đại lý Cám Bình Dương" });
  assert.equal(slots.party.matched_by, "tax_id");
  assert.equal(slots.party.claimed_tax_id, "0300000002");
  // Lines matched the item master through the builder's OWN matcher.
  assert.equal(slots.lines.length, 2);
  assert.equal(slots.lines[0].item_code, "CAM-GA-25KG");
  assert.equal(slots.lines[0].qty, 10);
  assert.equal(slots.lines[0].uom, "Bao");
  assert.equal(slots.lines[1].item_code, "CAM-HEO-25KG");
  // No price anywhere on the slots — the file's own prices stay in the
  // source_document block, display only.
  for (const line of slots.lines) {
    assert.equal("price" in line, false);
    assert.equal("rate" in line, false);
    assert.equal("unit_price" in line, false);
  }
  assert.equal(slots.warnings.length, 0, JSON.stringify(slots.warnings));
  assert.equal(slots.empty, undefined, "no empty flag: a complete file cannot yield nothing");
  // The document's identity travels so the UI can show what was read.
  assert.equal(slots.source_document.invoice_no, "0000123");
  assert.equal(slots.source_document.total_vnd, 4_427_500);
});

test("A2: a seller WITHOUT an MST on the site falls back to the NAME, and says so", () => {
  // provider-namespace.xml: seller "Nhà máy Cám Đại Thành" with no MST in file;
  // master row would also have tax_id null on a site that never stored it.
  const parsed = parseEinvoiceXml(fixture("provider-namespace.xml"));
  const spec = kindSpec("purchase");
  const parties = [
    { name: "SUP-DAI-THANH", supplier_name: "Nhà máy Cám Đại Thành", tax_id: null },
    ...SUPPLIERS,
  ];
  const slots = buildEinvoiceSlots({ parsed, spec, items: ITEMS, parties });
  assert.deepEqual(slots.party.resolved, { id: "SUP-DAI-THANH", name: "Nhà máy Cám Đại Thành" });
  assert.equal(slots.party.matched_by, "name");
});

test("A2: an unknown MST is a WARNING naming the MST — never a supplier pick, never a creation", () => {
  const parsed = parseEinvoiceXml(fixture("edge-unmatched-item.xml"));
  const claimTax = parsed.header.seller.tax_id;
  assert.ok(claimTax, "fixture must claim an MST for this test");
  const spec = kindSpec("purchase");
  // A list that does NOT carry the claimed MST under ANY row — the tax-id
  // fallthrough then tries the name, which matches nothing either.
  const nobody = SUPPLIERS.filter((s) => s.name !== "SUP-THIEN-NAM");
  const slots = buildEinvoiceSlots({ parsed, spec, items: ITEMS, parties: nobody });
  assert.equal(slots.party.resolved, null);
  assert.ok(slots.warnings.some((w) => w.code === "SUPPLIER_NOT_FOUND" && w.reason.includes(String(claimTax))), JSON.stringify(slots.warnings));
  // The unmatched goods line keeps the DOCUMENT's words and NO item id.
  assert.equal(slots.lines[0].item_code, null);
  assert.equal(slots.lines[0].item_name, "Bao bì nilon loại 50kg");
  assert.ok(slots.warnings.some((w) => w.code === "PO_ITEM_UNRESOLVED"), JSON.stringify(slots.warnings));
});

test("A2: an incomplete file is refused BEFORE a form exists", () => {
  const parsed = parseEinvoiceXml(fixture("edge-bad-number.xml"));
  assert.throws(
    () => assertParsedComplete(parsed),
    (err) => err.code === EINVOICE_SLOTS_CODES.INVOICE_INCOMPLETE,
  );
  // And the thrown reason quotes the parser's own problem list.
  try {
    assertParsedComplete(parsed);
  } catch (err) {
    assert.match(err.message, /không đọc được thành số/);
  }
});

test("A2: a known MST resolves even when the NAME differs from the stored supplier_name", () => {
  // Identity comes from the business key, not a string resemblance: the fixture
  // claims MST 0300000009, and the master row "SUP-THIEN-NAM" carries exactly
  // that MST under a different name — the tax id wins, the name is noise.
  const xml = `<?xml version="1.0"?><HDon><DLHDon><TTChung><SHDon>1</SHDon><NLap>2026-09-20</NLap></TTChung><NDHDon><NBan><Ten>Bao bì Tân Phú (tên in sai)</Ten><MST>0300000019</MST></NBan><DSHHDVu><HHDVu><THHDVu>Thép D10</THHDVu><DVTinh>Kg</DVTinh><SLuong>2</SLuong></HHDVu></DSHHDVu><TToan><TgTTTBSo>2</TgTTTBSo></TToan></NDHDon></DLHDon></HDon>`;
  const parsed = parseEinvoiceXml(xml);
  const slots = buildEinvoiceSlots({ parsed, spec: kindSpec("purchase"), items: ITEMS, parties: SUPPLIERS });
  assert.deepEqual(slots.party.resolved, { id: "SUP-THIEN-NAM", name: "Cửa hàng Bao bì Tân Phú" });
  assert.equal(slots.party.matched_by, "tax_id");
});

test("A2: the file channel only offers the kinds its policy lists", () => {
  // `sales` exists in the PHOTO table but is deliberately not offered to the
  // FILE channel (einvoice_policy.document_kinds) — a second channel must not
  // grow a second mapping by accident.
  assert.throws(() => kindSpec("sales"), (err) => err.code === EINVOICE_SLOTS_CODES.KIND_UNKNOWN);
  assert.equal(kindSpec("purchase").capability, "purchase_order.create");
});

test("A2: a capability id is not a KIND — even for the file channel", () => {
  for (const wrong of ["purchase_order.create", "", null, undefined, "Purchase", "delivery"]) {
    assert.throws(() => kindSpec(wrong), (err) => err.code === EINVOICE_SLOTS_CODES.KIND_UNKNOWN, String(wrong));
  }
});

/* ─────────────────────────────────────────────────────────────────────────────
 * 3. the route over HTTP (mock ERPNext)
 * ──────────────────────────────────────────────────────────────────────────── */

async function startNlp() {
  const child = spawn("python3", ["-m", "nlp_service.server", "--port", "0"], {
    cwd: REPO,
    stdio: ["ignore", "pipe", "inherit"],
  });
  const port = await new Promise((resolve, reject) => {
    child.stdout.on("data", (d) => {
      const m = String(d).match(/"port":\s*(\d+)/);
      if (m) resolve(Number(m[1]));
    });
    child.on("exit", (c) => reject(new Error(`nlp exited ${c}`)));
    setTimeout(() => reject(new Error("nlp did not report a port")), 5000);
  });
  const { __setNlpServicePortForTest } = await import("../src/copilot-server.mjs");
  __setNlpServicePortForTest(port);
  return child;
}

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

test("A2 /input/einvoice: a good TT78 file becomes slots over HTTP — and writes nothing", async () => {
  const nlpChild = await startNlp();
  const srv = await startGateway();
  try {
    const res = await srv.post("/input/einvoice", { xml: fixture("tt78-basic.xml"), kind: "purchase" });
    const payload = await res.json();
    assert.equal(res.status, 200, JSON.stringify(payload).slice(0, 400));
    const { result } = payload;
    assert.equal(result.capability, "purchase_order.create");
    assert.equal(result.party.resolved.id, "SUP-BINH-DUONG");
    assert.equal(result.party.matched_by, "tax_id");
    assert.equal(result.lines.length, 2);
    assert.equal(result.provenance.from_file, true);
    assert.equal(result.provenance.invoice_no, "0000123");
    // No write surface on this channel: no card, no command, no price.
    for (const key of ["proposal", "action", "command_id", "params", "risk", "price", "rate"]) {
      assert.equal(key in result, false, `${key} must not appear on einvoice slots`);
    }
  } finally {
    await srv.stop();
    nlpChild.kill();
  }
});

test("A2 /input/einvoice: refusals keep their own status codes", async () => {
  const srv = await startGateway();
  try {
    const cases = [
      ["not an invoice", { xml: "<List><Row>hello</Row></List>", kind: "purchase" }, 400, EINVOICE_CODES.XML_NOT_INVOICE],
      ["malformed XML", { xml: "<HDon><DLHDon><TTChung>", kind: "purchase" }, 400, EINVOICE_CODES.XML_MALFORMED],
      ["empty body", { kind: "purchase" }, 400, EINVOICE_CODES.XML_EMPTY],
      ["unknown kind", { xml: fixture("tt78-basic.xml"), kind: "sales_order.create" }, 400, EINVOICE_SLOTS_CODES.KIND_UNKNOWN],
      ["a kind the file channel does not offer", { xml: fixture("tt78-basic.xml"), kind: "sales" }, 400, EINVOICE_SLOTS_CODES.KIND_UNKNOWN],
      ["incomplete invoice", { xml: fixture("edge-bad-number.xml"), kind: "purchase" }, 422, EINVOICE_SLOTS_CODES.INVOICE_INCOMPLETE],
    ];
    for (const [name, body, status, code] of cases) {
      const res = await srv.post("/input/einvoice", body);
      assert.equal(res.status, status, name);
      const payload = await res.json();
      assert.equal(payload.code, code, name);
      assert.equal(payload.ok, false, name);
    }
  } finally {
    await srv.stop();
  }
});

test("A2 /input/einvoice: the log carries metadata only — never the file's text", async () => {
  const nlpChild = await startNlp();
  const srv = await startGateway();
  try {
    await srv.post("/input/einvoice", { xml: fixture("tt78-basic.xml"), kind: "purchase" });
    const lines = readdirSync(LOG_DIR)
      .flatMap((file) => readFileSync(path.join(LOG_DIR, file), "utf8").split("\n"))
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const served = lines.find((l) => l.phase === "einvoice_input" && l.outcome === "slots_served");
    assert.ok(served, "the served slots are their own event");
    assert.equal(served.invoice_no, "0000123");
    assert.equal(served.capability, "purchase_order.create");
    for (const line of lines.filter((l) => l.phase === "einvoice_input")) {
      const raw = JSON.stringify(line);
      assert.equal(raw.includes("Cám gà thịt"), false, "the goods text must not be logged");
      assert.equal(raw.includes("<HDon>"), false, "the XML must not be logged");
      assert.equal(raw.includes("0300000002"), false, "the seller's MST must not be logged");
    }
    // And nothing on this path went near the write gate.
    assert.equal(lines.some((l) => l.phase === "execute"), false);
    assert.equal(lines.some((l) => String(l.outcome ?? "").startsWith("write_")), false);
  } finally {
    await srv.stop();
    nlpChild.kill();
  }
});

test("A2 /input/einvoice → composed sentence → /ask: the ONE pipeline closes end-to-end (mock)", async () => {
  const nlpChild = await startNlp();
  const srv = await startGateway();
  try {
    // 1. The file becomes slots.
    const slotsRes = await srv.post("/input/einvoice", { xml: fixture("tt78-basic.xml"), kind: "purchase" });
    assert.equal(slotsRes.status, 200);
    const { result: slots } = await slotsRes.json();

    // 2. The USER composes the sentence from the CORRECTED slots (the client's
    //    own template, as ocr_compose.dart does for a photo — same wording the
    //    C2 tripwire pins).
    const goods = slots.lines.map((l) => `${l.qty} ${l.uom} ${l.item_name}`).join(" + ");
    const sentence = `đặt mua ${goods} từ ${slots.party.resolved.name}`;
    // 3. The composed sentence travels the ORDINARY /ask pipeline.
    const askRes = await srv.post("/ask", { text: sentence });
    const askPayload = await askRes.json();
    assert.equal(askRes.status, 200, JSON.stringify(askPayload).slice(0, 400));
    const ask = askPayload.result;
    assert.equal(ask.proposal?.action, "create_purchase_order", JSON.stringify(ask).slice(0, 400));
    assert.equal(ask.proposal.risk, "HIGH");
    // The rate comes from ERPNext's own buying price (295.000 for CAM-HEO on the
    // mock), never from the file's number.
    const heo = ask.proposal.params.lines.find((l) => l.item_code === "CAM-HEO-25KG");
    assert.equal(heo.rate, 295_000);
    assert.equal(heo.qty, 5);
  } finally {
    await srv.stop();
    nlpChild.kill();
  }
});
