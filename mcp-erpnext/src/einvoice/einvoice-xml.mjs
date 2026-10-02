/**
 * A1 (`.plan/next3/implementation.md` workstream A) — HÓA ĐƠN ĐIỆN TỬ XML → the
 * structured reading an input channel needs, and nothing more.
 *
 * WHAT THIS IS FOR, IN ONE MEASURED FACT: the shop receives XML invoices from
 * its suppliers (TT78/2021 + NĐ123/2020), and today the only way those become a
 * purchase document is a human retyping them. This module turns the file into
 * the SAME "what does this document appear to say" object the camera channel
 * produces (`src/ocr/ocr-slots.mjs`), so the e-invoice file can travel the ONE
 * existing pipeline: form (user corrects) → composed sentence → `/ask` →
 * capability from the contract → proposal → confirm → Safety Gateway → DRAFT.
 * There is deliberately no second write path here.
 *
 * WHY A HAND-ROLLED PARSER AND NO DEPENDENCY: adding an npm package is a
 * user decision in this project (operating_rules §13), and the whole Node side
 * is deliberately dependency-free apart from the pinned ERPNext MCP. The XML
 * subset an e-invoice actually uses (elements, attributes, text, entities,
 * namespaces, CDATA, comments) is small and the parser below is bounded by the
 * policy's byte cap before it runs at all.
 *
 * THE ONE RULE THAT MATTERS: *nothing in the output is authoritative*.
 *  - No ERPNext id is ever produced here (the contract declares
 *    `einvoice_policy.authoritative_identifiers = false`, checked at load time).
 *    The seller is identified by BUSINESS key (tax id / name) and the caller
 *    must resolve it against the site's own master list — a tax id found in a
 *    file is a claim, not an identity.
 *  - Every text value is run through `sanitizeUntrustedText` (the same helper
 *    OCR uses): an invoice can print "ignore previous instructions".
 *  - Numbers are parsed STRICTLY (spec: '.' is the decimal separator). A number
 *    that does not parse becomes a problem, never a guess.
 *
 * `parseEinvoiceXml` is PURE: no ERPNext, no NLP, no network, no fs, no
 * `/execute`. The static guard in `test/a1-einvoice-parser.test.mjs` keeps it
 * that way.
 */

import { sanitizeUntrustedText } from "../untrusted-data.mjs";

/** Refusal / problem codes. Every one has a Vietnamese reason for the user. */
export const EINVOICE_CODES = Object.freeze({
  XML_EMPTY: "EINVOICE_XML_EMPTY",
  XML_TOO_LARGE: "EINVOICE_XML_TOO_LARGE",
  XML_MALFORMED: "EINVOICE_XML_MALFORMED",
  XML_NOT_INVOICE: "EINVOICE_XML_NOT_INVOICE",
  MISSING_INVOICE_NO: "EINVOICE_MISSING_INVOICE_NO",
  MISSING_INVOICE_DATE: "EINVOICE_MISSING_INVOICE_DATE",
  MISSING_SELLER: "EINVOICE_MISSING_SELLER",
  NO_LINES: "EINVOICE_NO_LINES",
  LINE_UNUSABLE: "EINVOICE_LINE_UNUSABLE",
  LINE_LIMIT: "EINVOICE_LINE_LIMIT",
  BAD_NUMBER: "EINVOICE_BAD_NUMBER",
  BAD_DATE: "EINVOICE_BAD_DATE",
});

export class EinvoiceError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = "EinvoiceError";
    this.code = code;
  }
}

/**
 * The policy the parser obeys, handed in rather than imported, so this module
 * stays pure and the contract remains the single source of truth.
 *
 * @returns {{maxXmlBytes:number, maxLines:number}}
 */
export function einvoiceLimits(policy = null) {
  return {
    maxXmlBytes: Number.isInteger(policy?.max_xml_bytes) ? policy.max_xml_bytes : 2_000_000,
    maxLines: Number.isInteger(policy?.max_lines) ? policy.max_lines : 200,
  };
}

/* ─────────────────────────────────────────────────────────────────────────────
 * 1. A small, tolerant XML reader
 *
 * Tolerant in the ways real provider files require (default namespace, prefixed
 * namespace, attribute order, self-closing tags, CDATA, comments, an XML
 * declaration and a DOCTYPE), STRICT about the things that would make a parse
 * silently wrong: an unterminated tag, an unbalanced tree, and an unparseable
 * number each raise instead of yielding a plausible-looking value.
 * ──────────────────────────────────────────────────────────────────────────── */

const ENTITIES = Object.freeze({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " });

function decodeEntities(text) {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[body.toLowerCase()] ?? whole;
  });
}

/** Strip a namespace prefix (and any stray whitespace) from a tag name. */
function localName(raw) {
  const name = String(raw ?? "").trim();
  const colon = name.lastIndexOf(":");
  return colon === -1 ? name : name.slice(colon + 1);
}

/** Index of the '>' that closes a tag opened at `lt`, ignoring quoted '>'. */
function tagEnd(xml, lt) {
  let quote = null;
  for (let i = lt + 1; i < xml.length; i++) {
    const ch = xml[i];
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === ">") {
      return i;
    }
  }
  return -1;
}

function parseAttributes(body) {
  const attrs = {};
  const re = /([A-Za-z_][\w:.-]*)\s*=\s*("([^"]*)"|'([^']*)')/g;
  let m;
  while ((m = re.exec(body)) !== null) {
    attrs[localName(m[1])] = decodeEntities(m[3] ?? m[4] ?? "");
  }
  return attrs;
}

/**
 * Parse XML into a tree of `{name, attrs, children, text}` where `name` is the
 * LOCAL name (namespace stripped) — provider files disagree about namespaces,
 * never about the tag's meaning.
 *
 * @param {string} xml
 * @returns {{name:string, attrs:object, children:object[], text:string}} root
 */
export function parseXml(xml) {
  const root = { name: "#root", attrs: {}, children: [], text: "" };
  const stack = [root];
  let i = 0;
  let sawElement = false;
  const top = () => stack[stack.length - 1];
  const addText = (raw) => {
    const text = decodeEntities(raw);
    if (text.trim() === "") return;
    const node = top();
    node.text = node.text ? `${node.text} ${text}` : text;
  };

  while (i < xml.length) {
    const lt = xml.indexOf("<", i);
    if (lt === -1) {
      addText(xml.slice(i));
      break;
    }
    if (lt > i) addText(xml.slice(i, lt));

    if (xml.startsWith("<!--", lt)) {
      const end = xml.indexOf("-->", lt + 4);
      if (end === -1) throw new EinvoiceError(EINVOICE_CODES.XML_MALFORMED, "chú thích XML không đóng");
      i = end + 3;
      continue;
    }
    if (xml.startsWith("<![CDATA[", lt)) {
      const end = xml.indexOf("]]>", lt + 9);
      if (end === -1) throw new EinvoiceError(EINVOICE_CODES.XML_MALFORMED, "CDATA không đóng");
      addText(xml.slice(lt + 9, end));
      i = end + 3;
      continue;
    }
    if (xml.startsWith("<?", lt)) {
      const end = xml.indexOf("?>", lt + 2);
      if (end === -1) throw new EinvoiceError(EINVOICE_CODES.XML_MALFORMED, "khai báo XML không đóng");
      i = end + 2;
      continue;
    }
    if (xml.startsWith("<!", lt)) {
      const end = tagEnd(xml, lt);
      if (end === -1) throw new EinvoiceError(EINVOICE_CODES.XML_MALFORMED, "DOCTYPE không đóng");
      i = end + 1;
      continue;
    }

    const gt = tagEnd(xml, lt);
    if (gt === -1) throw new EinvoiceError(EINVOICE_CODES.XML_MALFORMED, "thẻ XML không đóng");
    const inner = xml.slice(lt + 1, gt).trim();
    if (inner === "") throw new EinvoiceError(EINVOICE_CODES.XML_MALFORMED, "thẻ XML rỗng");

    if (inner.startsWith("/")) {
      const name = localName(inner.slice(1));
      // Close the nearest matching ancestor. A close tag with no matching open
      // tag is corruption, not something to shrug off.
      let found = -1;
      for (let s = stack.length - 1; s >= 1; s--) {
        if (stack[s].name === name) {
          found = s;
          break;
        }
      }
      if (found === -1) {
        throw new EinvoiceError(EINVOICE_CODES.XML_MALFORMED, `thẻ đóng </${name}> không có thẻ mở tương ứng`);
      }
      stack.length = found;
      i = gt + 1;
      continue;
    }

    const selfClosing = inner.endsWith("/");
    const body = selfClosing ? inner.slice(0, -1).trim() : inner;
    const name = localName(body.split(/[\s/]/)[0]);
    if (name === "") throw new EinvoiceError(EINVOICE_CODES.XML_MALFORMED, "thẻ XML không có tên");
    const node = { name, attrs: parseAttributes(body), children: [], text: "" };
    top().children.push(node);
    if (!selfClosing) {
      stack.push(node);
      sawElement = true;
    }
    i = gt + 1;
  }

  if (stack.length !== 1) {
    throw new EinvoiceError(
      EINVOICE_CODES.XML_MALFORMED,
      `thẻ <${top().name}> chưa được đóng — file XML không hợp lệ`,
    );
  }
  if (!sawElement) throw new EinvoiceError(EINVOICE_CODES.XML_MALFORMED, "file không chứa phần tử XML nào");
  return root;
}

/** Direct children whose LOCAL name matches (case-insensitive). */
function childrenNamed(node, names) {
  const wanted = new Set(names.map((n) => n.toLowerCase()));
  return (node?.children ?? []).filter((c) => wanted.has(c.name.toLowerCase()));
}

/**
 * Depth-first search for the FIRST descendant with one of these local names.
 * Bounded by `maxDepth` so a pathological file cannot turn a lookup into a full
 * traversal of a deeply nested tree.
 */
function findDeep(node, names, { maxDepth = 6 } = {}) {
  const wanted = new Set(names.map((n) => n.toLowerCase()));
  const walk = (n, depth) => {
    if (depth > maxDepth) return null;
    for (const c of n.children ?? []) {
      if (wanted.has(c.name.toLowerCase())) return c;
    }
    for (const c of n.children ?? []) {
      const hit = walk(c, depth + 1);
      if (hit) return hit;
    }
    return null;
  };
  return walk(node, 0);
}

/** Text of a descendant by local name, sanitized (untrusted by construction). */
function textField(node, names, { maxLength = 300 } = {}) {
  const found = findDeep(node, names);
  if (!found) return null;
  const value = sanitizeUntrustedText(found.text, { maxLength });
  return value === "" ? null : value;
}

/** All descendants with one of these local names (for repeated line rows). */
function allDeep(node, names, { maxDepth = 8 } = {}) {
  const wanted = new Set(names.map((n) => n.toLowerCase()));
  const out = [];
  const walk = (n, depth) => {
    if (depth > maxDepth) return;
    for (const c of n.children ?? []) {
      if (wanted.has(c.name.toLowerCase())) out.push(c);
      walk(c, depth + 1);
    }
  };
  walk(node, 0);
  return out;
}

/* ─────────────────────────────────────────────────────────────────────────────
 * 2. Numbers and dates — strict, because a guessed amount is worse than none
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Spec (`QĐ 1450/QĐ-TCT`, "Định dạng số"): at most 19 digits, up to 4 decimals,
 * '.' separates the fraction, and there is NO thousands separator. So
 * "1.234.567" is not a number at all here and "15 500"/"15,500" are refused:
 * translating them is exactly the silent ×1000 error a money-carrying system
 * must not make. Unparseable ⇒ null (the caller records a problem), never a
 * guess — and whitespace is only trimmed at the ENDS, never inside the digits,
 * so "1 234" cannot slip through as 1234.
 *
 * @param {unknown} raw
 * @returns {number|null}
 */
export function strictNumber(raw) {
  if (raw === null || raw === undefined) return null;
  const text = String(raw).trim();
  if (text === "") return null;
  if (!/^-?\d+(\.\d{1,4})?$/.test(text)) return null;
  const value = Number(text);
  return Number.isFinite(value) ? value : null;
}

/**
 * The spec's date form is `YYYY-MM-DD` (and `YYYY-MM-DDThh:mm:ss` for a
 * timestamp). Only the date part is kept, and an unparseable date is null.
 *
 * @param {unknown} raw
 * @returns {string|null} ISO `YYYY-MM-DD`
 */
export function strictDate(raw) {
  if (raw === null || raw === undefined) return null;
  const text = String(raw).trim();
  const m = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  const [, y, mo, d] = m;
  const month = Number(mo);
  const day = Number(d);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return `${y}-${mo}-${d}`;
}

/* ─────────────────────────────────────────────────────────────────────────────
 * 3. Field map — Vietnamese e-invoice tag abbreviations
 *
 * Tag names follow the abbreviation rule of `QĐ 1450/QĐ-TCT` (verified in the
 * published tables, not invented): DLHDon = dữ liệu hóa đơn, NBan/NMua = người
 * bán/người mua, DSHHDVu/HHDVu = danh sách hàng hóa dịch vụ, SLuong = số
 * lượng, ThTien = thành tiền, TgTTTBSo = tổng tiền thanh toán bằng số, MST =
 * mã số thuế, SHDon = số hóa đơn, NLap/TDLap = ngày/thời điểm lập, DVTTe = đơn
 * vị tiền tệ, TGia = tỷ giá. Aliases are kept SHORT on purpose: an alias list
 * that guesses at variants is how the wrong number gets read.
 * ──────────────────────────────────────────────────────────────────────────── */

const TAGS = Object.freeze({
  invoice: ["HDon"],
  message: ["TDiep", "DLieu"],
  data: ["DLHDon"],
  seller: ["NBan"],
  buyer: ["NMua"],
  linesList: ["DSHHDVu"],
  line: ["HHDVu"],
  totals: ["TToan"],
  invoiceNo: ["SHDon"],
  invoiceForm: ["KHMSHDon"],
  invoiceSeries: ["KHHDon"],
  invoiceDate: ["NLap", "TDLap"],
  currency: ["DVTTe"],
  taxId: ["MST"],
  partyName: ["Ten"],
  lineName: ["THHDVu", "Ten"],
  lineUnit: ["DVTinh"],
  lineQty: ["SLuong"],
  linePrice: ["DGia"],
  lineAmount: ["ThTien"],
  lineTaxRate: ["TSuat"],
  lineTaxAmount: ["TThue"],
  totalNet: ["TgTCThue"],
  totalTax: ["TgTThue"],
  totalGross: ["TgTTTBSo", "TgTien"],
});

/**
 * Locate the invoice data subtree.
 *
 * Providers wrap the invoice differently: `<HDon><DLHDon>…`, or inside a tax
 * message `<TDiep><DLieu><HDon>…`. Both are accepted; anything else is not an
 * e-invoice and is refused rather than half-read.
 *
 * @param {object} root parsed tree
 * @returns {object|null} the `DLHDon` node
 */
function findInvoiceData(root) {
  const direct = findDeep(root, TAGS.data, { maxDepth: 4 });
  if (direct) return direct;
  const hdon = findDeep(root, TAGS.invoice, { maxDepth: 4 });
  if (hdon) return findDeep(hdon, TAGS.data, { maxDepth: 3 }) ?? hdon;
  return null;
}

/**
 * Parse one e-invoice XML file into a structured reading.
 *
 * @param {string} xml the file's text
 * @param {{policy?: object}} [opts] `einvoice_policy` from the contract
 * @returns {{
 *   source: "einvoice_xml",
 *   header: {invoice_no:string|null, invoice_form:string|null, invoice_series:string|null,
 *            invoice_date:string|null, currency:string|null,
 *            seller:{tax_id:string|null, name:string|null}, buyer:{tax_id:string|null, name:string|null},
 *            net_total_vnd:number|null, tax_total_vnd:number|null, total_vnd:number|null},
 *   lines: {index:number, description:string|null, qty:number|null, uom:string|null,
 *           unit_price:number|null, amount:number|null, tax_rate:string|null}[],
 *   problems: {code:string, reason:string}[],
 *   complete: boolean,
 *   instruction_pattern_found: boolean
 * }}
 */
export function parseEinvoiceXml(xml, { policy = null } = {}) {
  const limits = einvoiceLimits(policy);
  if (typeof xml !== "string" || xml.trim() === "") {
    throw new EinvoiceError(EINVOICE_CODES.XML_EMPTY, "chưa có nội dung file XML");
  }
  // Bounded BEFORE parsing: the reader below is linear, but the policy cap is
  // what keeps a hostile 200 MB "invoice" from being read at all.
  if (Buffer.byteLength(xml, "utf8") > limits.maxXmlBytes) {
    throw new EinvoiceError(
      EINVOICE_CODES.XML_TOO_LARGE,
      `file ${Buffer.byteLength(xml, "utf8")} byte vượt trần ${limits.maxXmlBytes} của einvoice_policy`,
    );
  }

  const root = parseXml(xml);
  const data = findInvoiceData(root);
  if (!data) {
    throw new EinvoiceError(
      EINVOICE_CODES.XML_NOT_INVOICE,
      "file XML không có phần dữ liệu hóa đơn (DLHDon) — không phải hóa đơn điện tử",
    );
  }

  const problems = [];
  const bad = (code, reason) => problems.push({ code, reason });

  const headerNode = findDeep(data, ["TTChung", "DLHDon"], { maxDepth: 2 }) ?? data;
  const contentNode = findDeep(data, ["NDHDon"], { maxDepth: 2 }) ?? data;

  const invoiceNo = textField(headerNode, TAGS.invoiceNo, { maxLength: 64 });
  const rawDate = findDeep(headerNode, TAGS.invoiceDate)?.text ?? null;
  const invoiceDate = strictDate(rawDate);

  const sellerNode = findDeep(contentNode, TAGS.seller, { maxDepth: 3 });
  const buyerNode = findDeep(contentNode, TAGS.buyer, { maxDepth: 3 });
  const partyOf = (node) => ({
    tax_id: node ? textField(node, TAGS.taxId, { maxLength: 32 }) : null,
    name: node ? textField(node, TAGS.partyName, { maxLength: 300 }) : null,
  });
  const seller = partyOf(sellerNode);
  const buyer = partyOf(buyerNode);

  if (!invoiceNo) bad(EINVOICE_CODES.MISSING_INVOICE_NO, "file không có số hóa đơn (SHDon)");
  if (!invoiceDate) {
    bad(
      EINVOICE_CODES.MISSING_INVOICE_DATE,
      rawDate
        ? `ngày lập "${sanitizeUntrustedText(rawDate, { maxLength: 40 })}" không đúng dạng YYYY-MM-DD`
        : "file không có ngày lập hóa đơn (NLap/TDLap)",
    );
  }
  // QĐ 1450/QĐ-TCT (sửa bởi 1510/QĐ-TCT): within NBan, BOTH `Ten` and `MST` are
  // BẮT BUỘC. A file missing either is not a complete invoice — and the MST is
  // exactly what the pipeline would resolve the seller by. Reported as a
  // problem (422, editable by hand), never filled with a guess.
  if (!seller.name) {
    bad(EINVOICE_CODES.MISSING_SELLER, "file không có tên người bán (NBan/Ten) — bắt buộc theo QĐ 1450/QĐ-TCT");
  }
  if (!seller.tax_id) {
    bad(EINVOICE_CODES.MISSING_SELLER, "file không có MST người bán (NBan/MST) — bắt buộc theo QĐ 1450/QĐ-TCT; hệ thống đối chiếu NCC theo MST nên cần đủ thông tin này");
  }

  // Lines: the first list of HHDVu rows found in the content block. Each row is
  // read on its own; a row without a description or a positive quantity is a
  // problem for THAT row (the user can see which line is unusable), not a
  // silent drop.
  const rows = childrenNamed(findDeep(contentNode, TAGS.linesList, { maxDepth: 3 }) ?? contentNode, TAGS.line);
  const lineNodes = rows.length > 0 ? rows : allDeep(contentNode, TAGS.line, { maxDepth: 4 });
  const lines = [];
  for (const [index, row] of lineNodes.entries()) {
    const description = textField(row, TAGS.lineName, { maxLength: 300 });
    const rawQty = findDeep(row, TAGS.lineQty, { maxDepth: 2 })?.text ?? null;
    const qty = strictNumber(rawQty);
    const rawPrice = findDeep(row, TAGS.linePrice, { maxDepth: 2 })?.text ?? null;
    const rawAmount = findDeep(row, TAGS.lineAmount, { maxDepth: 2 })?.text ?? null;
    const unitPrice = strictNumber(rawPrice);
    const amount = strictNumber(rawAmount);
    if (rawQty != null && qty === null) {
      bad(EINVOICE_CODES.BAD_NUMBER, `dòng ${index + 1}: số lượng "${sanitizeUntrustedText(rawQty, { maxLength: 40 })}" không đọc được thành số`);
    }
    if (rawPrice != null && unitPrice === null) {
      bad(EINVOICE_CODES.BAD_NUMBER, `dòng ${index + 1}: đơn giá "${sanitizeUntrustedText(rawPrice, { maxLength: 40 })}" không đọc được thành số`);
    }
    if (!description || qty === null || qty <= 0) {
      bad(
        EINVOICE_CODES.LINE_UNUSABLE,
        `dòng ${index + 1}: ${!description ? "thiếu tên hàng hóa (THHDVu)" : "thiếu/không hợp lệ số lượng (SLuong)"} — sửa tay ở form`,
      );
    }
    lines.push({
      index: index + 1,
      description,
      qty,
      uom: textField(row, TAGS.lineUnit, { maxLength: 40 }),
      unit_price: unitPrice,
      amount,
      tax_rate: textField(row, TAGS.lineTaxRate, { maxLength: 16 }),
    });
    if (lines.length > limits.maxLines) {
      bad(EINVOICE_CODES.LINE_LIMIT, `hóa đơn có hơn ${limits.maxLines} dòng — vượt trần của einvoice_policy`);
      break;
    }
  }
  if (lines.length === 0) {
    bad(EINVOICE_CODES.NO_LINES, "file không có dòng hàng hóa nào (DSHHDVu) — nhập tay giúp tôi");
  }

  const totalsNode = findDeep(contentNode, TAGS.totals, { maxDepth: 3 }) ?? data;
  const numOf = (node, names) => strictNumber(findDeep(node, names, { maxDepth: 2 })?.text ?? null);

  const header = {
    invoice_no: invoiceNo,
    invoice_form: textField(headerNode, TAGS.invoiceForm, { maxLength: 8 }),
    invoice_series: textField(headerNode, TAGS.invoiceSeries, { maxLength: 24 }),
    invoice_date: invoiceDate,
    currency: textField(headerNode, TAGS.currency, { maxLength: 8 }),
    seller,
    buyer,
    net_total_vnd: numOf(totalsNode, TAGS.totalNet),
    tax_total_vnd: numOf(totalsNode, TAGS.totalTax),
    total_vnd: numOf(totalsNode, TAGS.totalGross),
  };

  return {
    source: "einvoice_xml",
    header,
    lines,
    problems,
    // `complete` is what the route gates on: an incomplete reading must not seed
    // a form whose gaps the user cannot see.
    complete: problems.length === 0,
    // Said out loud so the caller can log it: this file tried to look like an
    // instruction. (The sanitizer already neutralised it.)
    instruction_pattern_found: /\[đã lọc chỉ dẫn\]/.test(JSON.stringify({ header, lines })),
  };
}
