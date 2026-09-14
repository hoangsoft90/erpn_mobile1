/**
 * Phase 2 batch accuracy — REAL ERPNext (phase-02 exit criteria: measure on
 * the real server, report % correct + every miss with its reason).
 *
 * Expected values are taken from batch-groundtruth.mjs output on 2026-09-14
 * (same day, same server) — not invented. Scoring is per-case with explicit
 * predicates so the report can quote actual answers verbatim.
 *
 * Usage:  set -a; source .env; set +a   (NLP service must be up on :8787)
 *         node mcp-erpnext/test/batch-accuracy.mjs
 */

import { answerQuestion } from "../src/copilot-server.mjs";

const fmt = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ".");
const has = (hay, needle) => hay.includes(needle);

/**
 * Every case: id, question, why (what facet it exercises), expect() receives
 * the structured result of answerQuestion() and returns [ok, note].
 */
const CASES = [
  // --- receivable (customer group) ---
  {
    id: "b01", q: "Khách smoke 2026-09-13-p1done còn nợ bao nhiêu",
    why: "baseline công nợ (câu smoke đã verify ở result6)",
    expect: (r) => [has(r.answer ?? "", "269.000") && has(r.answer ?? "", "(3 hóa đơn"), `outstanding 269000/count 3`],
  },
  {
    id: "b02", q: "Anh Nam ơi cho hỏi khách smoke 2026-09-13-p1done còn nợ bao nhiêu tiền",
    why: "kinship 'Anh Nam ơi' + lời vòng — không được làm hỏng nhận diện tên khách",
    expect: (r) => [has(r.answer ?? "", "269.000") && has(r.answer ?? "", "(3 hóa đơn"), `kinship không phá tên khách`],
  },
  {
    id: "b03", q: "bác Hai hỏi công nợ của khách smoke 2026-09-13-postfix",
    why: "kinship 'bác Hai' + từ khóa 'công nợ' → route customer",
    expect: (r) => [has(r.answer ?? "", "1.049.000") && has(r.answer ?? "", "(3 hóa đơn"), `outstanding 1049000`],
  },
  {
    id: "b04", q: "Công ty xây dựng ABC còn nợ bao nhiêu",
    why: "khách doanh nghiệp tên dài (2 hóa đơn: 179.205.000)",
    expect: (r) => [has(r.answer ?? "", "179.205.000") && has(r.answer ?? "", "(2 hóa đơn"), `outstanding 179205000`],
  },
  {
    id: "b05", q: "cho biết nợ của Trang trại Minh Anh",
    why: "khách tên không phải 'Khách …' (30.500.000, 1 hóa đơn)",
    expect: (r) => [has(r.answer ?? "", "30.500.000") && has(r.answer ?? "", "(1 hóa đơn"), `outstanding 30500000`],
  },
  {
    id: "b06", q: "Khách lẻ Minh Phát còn nợ không",
    why: "khách nợ 0 — phải trả 'không còn nợ gì', không bịa số",
    expect: (r) => [has(r.answer ?? "", "không còn nợ gì"), `zero-outstanding wording`],
  },
  {
    id: "b07", q: "khách Nguyễn Văn A còn nợ mấy tiền",
    why: "chỉ fragment 1 từ ('khách') khớp — 19 khách; fail-safe: KHÔNG được chọn hộ khách nào cả (result9: trước fix trả nhầm 457.875đ của khách khác)",
    expect: (r) => [r.answer === null && has(r.reason ?? "", "không tìm thấy khách"), `null, không chọn hộ`],
  },
  // --- unpaid invoices (sales group) ---
  {
    id: "b08", q: "hóa đơn chưa trả của Khách làm tròn 2026-09-14-p1fixwhole còn lại bao nhiêu",
    why: "route sales ('hóa đơn chưa trả', 'còn lại') — 1 hóa đơn 457.875",
    expect: (r) => [has(r.answer ?? "", "457.875") && (r.routed?.group === "sales"), `sales route + 457875`],
  },
  {
    id: "b09", q: "liệt kê hóa đơn chưa thanh toán của Khách smoke 2026-09-13-p1final",
    why: "'thanh toán' trong CÂU HỎI HÓA ĐƠN — không được lọt sang route payment (customer ưu tiên trước)",
    expect: (r) => [has(r.answer ?? "", "914.000") && (r.routed?.group === "sales"), `sales (không nhảy payment) + 914000`],
  },
  {
    id: "b10", q: "đơn hàng nào của Khách đo lại 309110 chưa trả tiền",
    why: "'đơn hàng' + 'chưa trả tiền' — vẫn phải là sales vì có 'đơn hàng' (sales đứng trước payment)",
    expect: (r) => [has(r.answer ?? "", "485.625") && (r.routed?.group === "sales"), `sales route + 485625`],
  },
  // --- payments (payment group) ---
  {
    id: "b11", q: "Khách smoke 2026-09-14-p1fixwhole đã trả tiền chưa",
    why: "payment qua REAL server (417 → doc_list fallback + party_type): ground-truth = 2 phiếu, 91.000đ",
    expect: (r) => [has(r.answer ?? "", "2 phiếu thu") && has(r.answer ?? "", "91.000"), `2 phiếu, 91.000đ`],
  },
  {
    id: "b12", q: "xem phiếu thu của Công trình nhà ông An",
    why: "payment, khách CHƯA có phiếu thu nào (ground-truth REST) — phải trả 'chưa có phiếu thu', không bịa",
    expect: (r) => [has(r.answer ?? "", "chưa có phiếu thu"), `0 phiếu thu wording`],
  },
  // --- inventory ---
  {
    id: "b13", q: "cám gà còn tồn kho bao nhiêu",
    why: "tồn kho LỌC đúng item 'Cám gà thịt 25kg' (CAM-GA-25KG): đúng 3 kho, KHÔNG dính item khác",
    expect: (r) => [
      Array.isArray(r.answer) && r.answer.every((s) => s.includes("CAM-GA-25KG")) && r.answer.length === 3,
      `3 kho CAM-GA-25KG, không lệch item`,
    ],
  },
  {
    id: "b14", q: "tồn kho của cám heo là bao nhiêu",
    why: "lọc đúng CAM-HEO-25KG — 1 kho, 778",
    expect: (r) => [
      Array.isArray(r.answer) && r.answer.length === 1 && r.answer[0].includes("CAM-HEO-25KG") && r.answer[0].includes("778"),
      `CAM-HEO-25KG 778 duy nhất`,
    ],
  },
  {
    id: "b15", q: "trong kho còn bao nhiêu gạch đỏ",
    why: "tên thương mại 'gạch đỏ' → GACH-DO-2L 15000 (findItem + listInventory)",
    expect: (r) => [
      Array.isArray(r.answer) && r.answer.length === 1 && r.answer[0].includes("GACH-DO-2L") && r.answer[0].includes("15000"),
      `GACH-DO-2L 15000 duy nhất`,
    ],
  },
  {
    id: "b16", q: "thép D16 còn lại trong kho mấy",
    why: "THEP-D16 1500 (item_code D16 phải thắng prefix 'thép' của THEP-D10)",
    expect: (r) => [
      Array.isArray(r.answer) && r.answer.length === 1 && r.answer[0].includes("THEP-D16") && r.answer[0].includes("1500"),
      `THEP-D16 1500 duy nhất`,
    ],
  },
  // --- routing / NLP edge cases ---
  {
    id: "b17", q: "chị Lan còn nợ bao nhiêu",
    why: "kinship 'chị' strip 'Lan' — DB thật không có 'Lan' → fail-safe (đã từng thấy với smoke data cũ)",
    expect: (r) => [r.answer === null && has(r.reason ?? "", "không tìm thấy khách"), `fail-safe đúng`],
  },
  {
    id: "b18", q: "hôm nay trời đẹp quá",
    why: "câu ngoài phạm vi — không route, answer null, không bịa",
    expect: (r) => [r.answer === null && r.routed === false && has(r.reason ?? "", "no skill route"), `no route`],
  },
];

const results = [];
for (const c of CASES) {
  let row;
  try {
    const r = await answerQuestion(c.q);
    const [ok, note] = c.expect(r);
    row = { id: c.id, q: c.q, ok, note, answer: r.answer ?? null, reason: r.reason ?? null, route: r.routed?.group ?? null };
  } catch (e) {
    row = { id: c.id, q: c.q, ok: false, note: "EXCEPTION", answer: null, reason: String(e.message ?? e).slice(0, 200), route: null };
  }
  results.push(row);
  console.error(`  ${ok2(row)} ${c.id} ${row.route ?? "-"} :: ${c.q}`);
}

function ok2(r) { return r.ok ? "PASS" : "FAIL"; }

const passed = results.filter((r) => r.ok).length;
console.log(JSON.stringify({
  total: results.length,
  passed,
  failed: results.length - passed,
  accuracy_pct: Math.round((passed / results.length) * 1000) / 10,
  results,
}, null, 2));
