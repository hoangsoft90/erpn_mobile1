/**
 * next7 / C3 — the DAY a chat revenue question names.
 *
 * WHY THIS FILE EXISTS: C1 shipped `sales.summary` answering the SHOP'S TODAY
 * only. C2's REAL probe (2026-09-27) made the gap explicit: the chat path never
 * handed a day to the skill, so "doanh thu ngày 15/9" would have answered with
 * today's number inside a sentence naming today. A wrong day is a wrong money
 * figure — this file pins the rules that decide the day, and the pipeline that
 * carries it.
 *
 *   A. UNIT     — `readDayPhrase` at its own boundaries: understood forms,
 *                 refused forms, and the day arithmetic across month/year ends.
 *                 `today` is INJECTED, so no rule here depends on the clock.
 *   B. TAXONOMY — every code this layer can emit maps onto the taxonomy and
 *                 carries Vietnamese copy (the P8 lesson: a new server code with
 *                 no copy reaches the screen as a bare code with no words).
 *   C. E2E      — the real Python NLP + the real copilot process + the mock ERP:
 *                 a dated question reads the RIGHT day end-to-end, and the
 *                 refusal cases refuse instead of answering today.
 *
 * TIME SAFETY: the pure-function tests inject a fixed `today`; the E2E fixture is
 * built from `vnDay()` (never a hard-coded date), so this file cannot rot when
 * the calendar moves.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { readDayPhrase, addDays, DAY_PHRASE_CODES } from "../src/day-phrase.mjs";
import { UNCERTAINTY_CODES, uncertaintyCopy, toUncertaintyCode } from "../src/uncertainty.mjs";
import { createMcpClient, MOCK_SERVER } from "../src/client.mjs";
import { getDailySummary, vnDay } from "../src/skills/ops-summary.mjs";

/* ─────────────────────────────── A. UNIT ─────────────────────────────── */

// Injected clock for the pure rules — NOT the machine's day (a hard-coded day
// compared against a live clock is the time-bomb the P5-1 lesson names).
const T = "2026-09-27";

test("C3 unit: the days a shopkeeper writes are read as those days", () => {
  const cases = [
    ["báo cáo doanh thu hôm nay", T],
    ["doanh thu hôm qua", "2026-09-26"],
    ["doanh thu ngày hôm kia", "2026-09-25"],
    ["doanh thu hom qua", "2026-09-26"], // unaccented keyboard (routing ships these too)
    ["doanh thu ngày 15/9", "2026-09-15"],
    ["doanh thu ngày 15/9/2026", "2026-09-15"],
    ["doanh thu 15-9-2026", "2026-09-15"],
    ["doanh thu 15.9.2026", "2026-09-15"],
    ["doanh thu 2026-09-15", "2026-09-15"],
    ["doanh thu ngày 15 tháng 9", "2026-09-15"],
    ["doanh thu ngày 15 tháng 9 năm 2026", "2026-09-15"],
    ["doanh thu 15/9 năm 2026", "2026-09-15"],
    ["doanh thu ngay 15 thang 9", "2026-09-15"],
    ["doanh thu 15 thang 9", "2026-09-15"],
  ];
  for (const [text, expected] of cases) {
    const r = readDayPhrase(text, { today: T });
    assert.equal(r.ok, true, `"${text}" must be understood`);
    assert.equal(r.date, expected, `"${text}" -> ${r.date} (expected ${expected})`);
  }
});

test("C3 unit: a question that names NO day stays 'today' (the C1 shape is untouched)", () => {
  for (const text of ["doanh thu", "doanh thu bán được bao nhiêu", "doanh thu tìm khách Nguyễn Văn Nam"]) {
    const r = readDayPhrase(text, { today: T });
    assert.equal(r.ok, true);
    assert.equal(r.date, null, `"${text}" names no day`);
  }
  // A number followed by a money word is MONEY, not a date: "1/5 triệu" must not
  // become 1 May.
  assert.equal(readDayPhrase("doanh thu 1/5 triệu", { today: T }).date, null);
  // A person is not a period: "chị Năm" / "anh Nam" name nobody's calendar.
  for (const text of ["doanh thu của chị Năm", "doanh thu của anh Nam"]) {
    assert.equal(readDayPhrase(text, { today: T }).date, null, `"${text}" is a person, not a period`);
  }
});

test("C3 unit: a day we cannot pin is a REFUSAL — never today's number", () => {
  const cases = [
    ["doanh thu tháng này", DAY_PHRASE_CODES.DAY_PHRASE_PERIOD],
    ["doanh thu tháng 9", DAY_PHRASE_CODES.DAY_PHRASE_PERIOD],
    ["doanh thu quý này", DAY_PHRASE_CODES.DAY_PHRASE_PERIOD],
    ["doanh thu quý 3", DAY_PHRASE_CODES.DAY_PHRASE_PERIOD],
    ["doanh thu tuần này", DAY_PHRASE_CODES.DAY_PHRASE_PERIOD],
    ["doanh thu năm nay", DAY_PHRASE_CODES.DAY_PHRASE_PERIOD],
    ["doanh thu năm 2026", DAY_PHRASE_CODES.DAY_PHRASE_PERIOD],
    ["doanh thu cuối tháng", DAY_PHRASE_CODES.DAY_PHRASE_PERIOD],
    ["doanh thu 3 ngày qua", DAY_PHRASE_CODES.DAY_PHRASE_PERIOD],
    ["doanh thu mấy ngày nay", DAY_PHRASE_CODES.DAY_PHRASE_PERIOD],
    ["doanh thu tuan nay", DAY_PHRASE_CODES.DAY_PHRASE_PERIOD],
    ["doanh thu hôm trước", DAY_PHRASE_CODES.DAY_PHRASE_INVALID],
    ["doanh thu bữa nọ", DAY_PHRASE_CODES.DAY_PHRASE_INVALID],
    ["doanh thu ngày mai", DAY_PHRASE_CODES.DAY_PHRASE_INVALID],
    ["doanh thu ngày 31/2", DAY_PHRASE_CODES.DAY_PHRASE_INVALID],
    ["doanh thu ngày 30/2/2026", DAY_PHRASE_CODES.DAY_PHRASE_INVALID],
    ["doanh thu 29/2/2025", DAY_PHRASE_CODES.DAY_PHRASE_INVALID],
    ["doanh thu 0/5", DAY_PHRASE_CODES.DAY_PHRASE_INVALID],
    ["doanh thu 15/13", DAY_PHRASE_CODES.DAY_PHRASE_INVALID],
    ["doanh thu ngày 15/9/26", DAY_PHRASE_CODES.DAY_PHRASE_INVALID],
    ["doanh thu 31/12/2099", DAY_PHRASE_CODES.DAY_PHRASE_INVALID],
    ["doanh thu ngày 15/9 và 16/9", DAY_PHRASE_CODES.DAY_PHRASE_INVALID],
  ];
  for (const [text, code] of cases) {
    const r = readDayPhrase(text, { today: T });
    assert.equal(r.ok, false, `"${text}" must be refused (got date ${r.date})`);
    assert.equal(r.code, code, `"${text}" -> ${r.code}`);
    assert.ok(r.reason.trim().length > 10, `"${text}" refusal must say something`);
  }
});

test("C3 unit: a year-less day still to come this year asks for the year instead of guessing", () => {
  // 30/9 asked on 27/9: the year is NOT inferable (this year is in the future,
  // last year was never said) — so it is refused, and the reason says why.
  const r = readDayPhrase("doanh thu 30/9", { today: T });
  assert.equal(r.ok, false);
  assert.equal(r.code, DAY_PHRASE_CODES.DAY_PHRASE_INVALID);
  assert.match(r.reason, /4 chữ số/);
  // With the year, the same day is a real day.
  const withYear = readDayPhrase("doanh thu 30/9/2025", { today: T });
  assert.equal(withYear.ok, true);
  assert.equal(withYear.date, "2025-09-30");
});

test("C3 unit: relative days cross month/year boundaries by real calendar arithmetic", () => {
  assert.equal(readDayPhrase("hôm qua", { today: "2026-01-01" }).date, "2025-12-31");
  assert.equal(readDayPhrase("hôm kia", { today: "2026-01-01" }).date, "2025-12-30");
  assert.equal(readDayPhrase("hôm kia", { today: "2026-03-01" }).date, "2026-02-27");
  // A leap day is a real date in a leap year and NOT in another one.
  assert.equal(readDayPhrase("doanh thu 29/2/2024", { today: T }).date, "2024-02-29");
});

test("C3 unit: the caller's clock is required — this module owns none", () => {
  assert.throws(() => readDayPhrase("doanh thu", {}), /DAY_PHRASE_TODAY_REQUIRED/);
  assert.throws(() => readDayPhrase("doanh thu", { today: "27/09/2026" }), /DAY_PHRASE_TODAY_REQUIRED/);
});

/* ───────────────────────────── B. TAXONOMY ───────────────────────────── */

test("C3 taxonomy: every code the day phrase can emit reaches the screen with copy", () => {
  assert.ok(UNCERTAINTY_CODES.DAY_PHRASE_INVALID, "the new code lives in the taxonomy, not in a call site");
  for (const code of Object.values(DAY_PHRASE_CODES)) {
    const mapped = toUncertaintyCode(code);
    assert.equal(mapped, code, `${code} must map onto the taxonomy (an unmapped code has no copy)`);
    const copy = uncertaintyCopy(mapped);
    assert.ok(copy && copy.message.trim().length > 10, `${code} must carry a real Vietnamese sentence`);
  }
});

/* ─────────────────────────────── C. E2E ─────────────────────────────── */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const REPO = path.resolve(ROOT, "..");
const COPILOT = path.join(ROOT, "src", "copilot-server.mjs");

/** Hermetic: no ERPNEXT_* may leak in, or the child would talk to a real site. */
const MOCK_ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^ERPNEXT_/.test(k)));

// The fixture days are DERIVED from the shop's clock, never hard-coded: a fixed
// date compared against a live clock is the time bomb P5-1 recorded.
const COMPANY = "Minh Phát Cám & VLXD";
const TODAY = vnDay();
const YESTERDAY = addDays(TODAY, -1);
const OLDER = addDays(TODAY, -3);

const SI_ROWS = [
  // yesterday: two sales and a return (the return's grand_total is negative, as
  // C0 measured on the real site) — NET 7.000.000
  { name: "C3-N1", docstatus: 1, status: "Paid", grand_total: 5_000_000, outstanding_amount: 0, posting_date: YESTERDAY, company: COMPANY },
  { name: "C3-N2", docstatus: 1, status: "Unpaid", grand_total: 4_000_000, outstanding_amount: 4_000_000, posting_date: YESTERDAY, company: COMPANY },
  { name: "C3-R1", docstatus: 1, status: "Return", is_return: 1, grand_total: -2_000_000, outstanding_amount: 0, posting_date: YESTERDAY, company: COMPANY },
  // today and an older day: if a filter were ignored, these would leak into the
  // assertions below and the test would say so loudly.
  { name: "C3-T1", docstatus: 1, status: "Paid", grand_total: 9_000_000, outstanding_amount: 0, posting_date: TODAY, company: COMPANY },
  { name: "C3-O1", docstatus: 1, status: "Paid", grand_total: 1_000_000, outstanding_amount: 0, posting_date: OLDER, company: COMPANY },
];

function netOn(day) {
  return SI_ROWS.filter((r) => r.docstatus === 1 && r.status !== "Cancelled" && r.posting_date === day && r.company === COMPANY)
    .reduce((s, r) => s + r.grand_total, 0);
}

function fixture() {
  return {
    Company: [{ name: COMPANY, default_cash_account: "1110 - Tiền mặt - MP", default_bank_account: null, company: COMPANY }],
    Account: [{ name: "1110 - Tiền mặt - MP", account_type: "Cash", company: COMPANY }],
    "GL Entry": [],
    "Sales Order": [],
    "Sales Invoice": SI_ROWS,
    "Payment Entry": [],
  };
}

async function startNlpService() {
  const child = spawn("python3", ["-m", "nlp_service.server", "--port", "0"], { cwd: REPO, stdio: ["ignore", "pipe", "inherit"] });
  const port = await new Promise((resolve, reject) => {
    child.stdout.on("data", (d) => {
      const m = String(d).match(/"port":\s*(\d+)/);
      if (m) resolve(Number(m[1]));
    });
    child.on("exit", (code) => reject(new Error(`nlp service exited early (${code})`)));
    setTimeout(() => reject(new Error("nlp service: no ready line in 5s")), 5000);
  });
  return { child, port };
}

/** One copilot process, several questions (the answers are what is under test). */
function startCopilot(port) {
  const child = spawn(process.execPath, [COPILOT], {
    env: { ...MOCK_ENV, COPILOT_COMPANY: COMPANY, MOCK_ERP_P4_FIXTURE: JSON.stringify(fixture()), NLP_SERVICE_PORT: String(port) },
    stdio: ["pipe", "pipe", "inherit"],
  });
  const pending = new Map();
  let nextId = 1;
  let buffer = "";
  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString();
    let nl;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      const entry = pending.get(msg.id);
      if (!entry) continue;
      pending.delete(msg.id);
      if (msg.error) entry.reject(new Error(`MCP_ERROR ${msg.error.code}: ${msg.error.message}`));
      else entry.resolve(msg.result);
    }
  });
  const request = (method, params) => {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  };
  return {
    child,
    request,
    async call(text) {
      const res = await request("tools/call", { name: "copilot_ask", arguments: { text } });
      assert.equal(res.isError, undefined, `tool error: ${res.content?.[0]?.text}`);
      return res.structuredContent ?? JSON.parse(res.content[0].text);
    },
    async close() {
      child.stdin.end();
      await new Promise((r) => child.once("exit", r));
    },
  };
}

test("C3 E2E: 'hôm qua' and an explicit date read THAT day — and match the drawer for it", async () => {
  const nlp = await startNlpService();
  const copilot = startCopilot(nlp.port);
  try {
    await copilot.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } });

    // 1. "hôm qua" — the day the sentence names, not the shop's today.
    const yesterday = await copilot.call("báo cáo doanh thu hôm qua");
    assert.equal(yesterday.routed.capability, "sales.summary", JSON.stringify(yesterday));
    assert.equal(yesterday.error_code, undefined, JSON.stringify(yesterday));
    assert.equal(yesterday.sales_summary.date, YESTERDAY, "the answer must be about hôm qua");
    assert.equal(yesterday.sales_summary.net_vnd, netOn(YESTERDAY), "the number is derived from the fixture rows");
    assert.equal(yesterday.sales_summary.net_vnd, 7_000_000);
    assert.equal(yesterday.sales_summary.documents, 3);
    // It is a PAST day and the sentence says so — the C2 caveat (a past number
    // read as today's) cannot be read that way here.
    assert.match(yesterday.answer, new RegExp(`Doanh thu ngày ${YESTERDAY} \\(hôm qua\\)`));
    assert.equal(yesterday.proposal.action, "read_sales_summary");
    assert.equal(yesterday.proposal.params.date, YESTERDAY, "the card carries the day it read");

    // 2. The same day written out: dd/mm/yyyy travels the same path.
    const [, mm, dd] = YESTERDAY.split("-");
    const written = await copilot.call(`doanh thu ngày ${Number(dd)}/${Number(mm)}/${YESTERDAY.slice(0, 4)}`);
    assert.equal(written.sales_summary.date, YESTERDAY, JSON.stringify(written));
    assert.equal(written.sales_summary.net_vnd, netOn(YESTERDAY));

    // 3. abs(chat − drawer) == 0 on THAT day (the C3 invariant, now for a past day).
    const mcp = createMcpClient({ serverScript: MOCK_SERVER, env: { ...process.env, MOCK_ERP_P4_FIXTURE: JSON.stringify(fixture()) } });
    try {
      await mcp.initialize();
      const drawer = await getDailySummary(mcp, { date: YESTERDAY, company: COMPANY, erpTarget: "MOCK" });
      assert.equal(Math.abs(written.sales_summary.net_vnd - drawer.sales_invoices.amount), 0);
      assert.equal(drawer.sales_invoices.count, 3);
    } finally {
      await mcp.close().catch(() => {});
    }

    // 4. Regression: the C1 question is unchanged, and says nothing about hôm qua.
    const today = await copilot.call("báo cáo doanh thu hôm nay");
    assert.equal(today.sales_summary.date, TODAY);
    assert.equal(today.sales_summary.net_vnd, netOn(TODAY));
    assert.doesNotMatch(today.answer, /hôm qua/);
  } finally {
    await copilot.close();
    nlp.child.kill();
  }
});

test("C3 E2E: an unpinnable day REFUSES with Vietnamese copy — it never answers today", async () => {
  const nlp = await startNlpService();
  const copilot = startCopilot(nlp.port);
  try {
    await copilot.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } });

    const expects = [
      ["doanh thu tháng này", "KNOWN_INTENT_UNIMPLEMENTED", /TỪNG NGÀY/],
      ["doanh thu ngày 31/2", "DAY_PHRASE_INVALID", /ngày có thật/],
      ["doanh thu ngày 31/12/2099", "DAY_PHRASE_INVALID", /chưa tới/],
      ["doanh thu ngày 15/9/26", "DAY_PHRASE_INVALID", /4 chữ số/],
      ["doanh thu ngày mai", "DAY_PHRASE_INVALID", /chưa tới/],
    ];
    for (const [text, code, reasonRe] of expects) {
      const out = await copilot.call(text);
      assert.equal(out.error_code, code, `"${text}" -> ${out.error_code} ${JSON.stringify(out).slice(0, 300)}`);
      assert.equal(out.proposal, null, `"${text}" must propose nothing`);
      // No number may leak through: the refusal is the whole answer.
      assert.equal(out.sales_summary, undefined, `"${text}" must not carry a day's figures`);
      assert.match(out.reason, reasonRe, `"${text}" reason: ${out.reason}`);
      assert.ok(out.uncertainty && out.uncertainty.message.trim().length > 0, `"${text}" needs screen copy`);
    }
  } finally {
    await copilot.close();
    nlp.child.kill();
  }
});
