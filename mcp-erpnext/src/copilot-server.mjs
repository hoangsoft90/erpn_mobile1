/**
 * Copilot MCP server — the tool dsh registers and calls (user task 2026-09-13).
 *
 * Flow per question (all stages already built in Phases 1-2, this file only
 * WIRES them):
 *
 *   text → HTTP 127.0.0.1:8787/normalize (Python vietnamese_nlp, locked bridge)
 *        → routeIntent()               (Phase 2 keyword router, no embeddings)
 *        → skill factory(mcp, knownIds)(Phase 2 skills, read-only guard)
 *        → client.callTool()           (Phase 2 client → mock or real ERPNext)
 *        → deterministic Vietnamese answer (NO LLM inside this pipeline leg)
 *
 * The LLM (dsh) sits ABOVE this: it decides to call `copilot_ask`, then phrases
 * the returned structured payload. Numbers shown to the user are copied
 * verbatim from ERPNext data — nothing recomputes money.
 *
 * Transport: MCP stdio (line-delimited JSON-RPC 2.0), the format dsh's
 * dsh-mcp-client registers (transport: stdio, command, args, env).
 */

import { createMcpClient, MOCK_SERVER } from "./client.mjs";
import { routeIntent } from "./router.mjs";
import { realServerScript } from "./index.mjs";

/**
 * ERPNext target selection (user decision 2026-09-14: "khi tôi cung cấp
 * ERPNEXT_URL/API_KEY/API_SECRET thật, chỉ cần đổi endpoint, không phải
 * viết lại logic").
 *
 * - All three ERPNEXT_* env vars present -> spawn the PINNED real server.
 * - Otherwise -> mock (no credentials needed; tests default here).
 * - A malformed ERPNEXT_URL throws instead of silently falling back to mock
 *   (a wrong-target answer is worse than a refused start).
 *
 * Secrets stay in the environment (.env, gitignored) — never in cordis patch
 * files or anything committed.
 */
export function pickServerScript(env = process.env) {
  const { ERPNEXT_URL: url, ERPNEXT_API_KEY: key, ERPNEXT_API_SECRET: secret } = env;
  if (!url && !key && !secret) return MOCK_SERVER;
  const missing = ["ERPNEXT_URL", "ERPNEXT_API_KEY", "ERPNEXT_API_SECRET"].filter((k) => !env[k]);
  if (missing.length > 0) {
    throw new Error(`PARTIAL_ERPNEXT_CONFIG: set all three or none — missing: ${missing.join(", ")}`);
  }
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`INVALID_ERPNEXT_URL: ${url}`);
  }
  if (!/^https?:$/.test(parsed.protocol)) {
    throw new Error(`INVALID_ERPNEXT_URL: protocol must be http(s), got ${parsed.protocol}`);
  }
  return realServerScript();
}

const NLP_PORT = process.env.NLP_SERVICE_PORT || "8787";
const NLP_URL = `http://127.0.0.1:${NLP_PORT}/normalize`;

/** Wait for the Python bridge (dsh may start us before the service is up). */
async function waitForNlpService(timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${NLP_PORT}/health`);
      if (res.ok) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

/** Call the Python normalize bridge; throws when the service is unreachable. */
async function normalizeText(text) {
  const res = await fetch(NLP_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`NLP_SERVICE_ERROR ${res.status}: ${body.slice(0, 200)}`);
  }
  const json = await res.json();
  if (!json.ok) throw new Error(`NLP_SERVICE_ERROR: ${json.error}`);
  return json.result;
}

/** 2500000 -> "2.500.000" (fixed-point, no ICU dependency). */
export function formatVnd(n) {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ".");
}

/**
 * Customer-name candidates from cleaned text — every token-prefix, longest
 * first. Fuzzy matching stays a Phase 6 concern; this is deliberately crude
 * and honest.
 */
export function nameCandidates(cleanedText) {
  const tokens = cleanedText.split(/\s+/).filter(Boolean);
  const cands = [];
  for (let len = tokens.length; len >= 1; len--) {
    cands.push(tokens.slice(0, len).join(" "));
  }
  return [...new Set(cands)];
}

/**
 * Resolve the customer WITHOUT guessing between homonyms: prefer the first
 * candidate that matches EXACTLY ONE customer; only if no candidate is
 * unambiguous, fall back to the first candidate that matched at all (and say
 * so via `ambiguous: true`). Asking beats answering for the wrong "Khách smoke".
 */
export async function resolveCustomer(skills, cleanedText) {
  let fallback = null;
  for (const cand of nameCandidates(cleanedText)) {
    const found = await skills.findCustomer(cand);
    const rows = found.data?.data ?? [];
    if (rows.length === 1) return { customer: rows[0], ambiguous: false };
    if (rows.length > 1 && !fallback) fallback = rows[0];
  }
  return fallback ? { customer: fallback, ambiguous: true } : { customer: null, ambiguous: false };
}

function reply(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
}
function replyError(id, code, message) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }) + "\n");
}

/** Core pipeline — exported for tests; the MCP handler is a thin shell over it. */
export async function answerQuestion(rawText) {
  const nlp = await normalizeText(rawText);
  const mcp = createMcpClient({ serverScript: pickServerScript() }); // real when ERPNEXT_* set, mock otherwise
  try {
    await mcp.initialize();
    const knownIds = new Set();
    const route = routeIntent(nlp.text);

    if (!route) {
      return {
        question: rawText,
        normalized: nlp,
        routed: false,
        answer: null,
        reason: "no skill route matched — Phase 2 router covers customer/sales/payment/inventory only",
      };
    }

    const skills = route.factory(mcp, knownIds);

    // Inventory needs no customer.
    if (route.group === "inventory") {
      const inv = await skills.listInventory({});
      const rows = inv.data?.data ?? [];
      return {
        question: rawText,
        normalized: nlp,
        routed: { group: route.group, matched: route.matched },
        answer: rows.map((r) => `${r.item_code}: ${r.actual_qty} (kho ${r.warehouse})`),
        rows,
      };
    }

    // Customer-bound intents: resolve the name first — IDs only ever come from
    // a tool result (the guard refuses invented ones).
    const { customer, ambiguous } = await resolveCustomer(skills, nlp.text);
    if (!customer) {
      return {
        question: rawText,
        normalized: nlp,
        routed: { group: route.group, matched: route.matched },
        answer: null,
        reason: `không tìm thấy khách hàng trong "${nlp.text}" (fuzzy matching đầy đủ là Phase 6)`,
      };
    }

    const ambNote = ambiguous ? " (⚠️ tên khách trùng nhiều kết quả — đã lấy kết quả đầu tiên, entity resolution đúng là Phase 6)" : "";

    if (route.group === "payment") {
      const pays = await skills.listPaymentEntries(customer.name, knownIds);
      const rows = (pays.data?.data ?? []).map((p) => ({
        id: p.name,
        date: p.posting_date,
        amount_vnd: Number(p.paid_amount) || 0,
      }));
      const total = rows.reduce((s, r) => s + r.amount_vnd, 0);
      const answer =
        rows.length > 0
          ? `${customer.customer_name} đã có ${rows.length} phiếu thu, tổng ${formatVnd(total)}đ (mới nhất: ${rows[0].id} ngày ${rows[0].date}). Ghi nhận phiếu thu mới là Phase 7 — Phase 2 chỉ đọc.${ambNote}`
          : `${customer.customer_name} chưa có phiếu thu nào trong hệ thống. Ghi nhận phiếu thu mới là Phase 7 — Phase 2 chỉ đọc.${ambNote}`;
      return { question: rawText, normalized: nlp, routed: { group: route.group, matched: route.matched }, customer: { id: customer.name, name: customer.customer_name }, rows, answer };
    }

    if (route.group === "sales") {
      const inv = await skills.listUnpaidInvoices(customer.name, knownIds);
      const rows = inv.data?.data ?? [];
      const total = rows.reduce((s, r) => s + (Number(r.outstanding_amount) || 0), 0);
      const answer =
        rows.length > 0
          ? `${customer.customer_name} còn ${rows.length} hóa đơn chưa trả, tổng ${formatVnd(total)}đ (${rows.map((r) => `${r.name}: ${formatVnd(Number(r.outstanding_amount))}đ`).join(", ")}).${ambNote}`
          : `${customer.customer_name} không còn hóa đơn nào chưa trả.${ambNote}`;
      return { question: rawText, normalized: nlp, routed: { group: route.group, matched: route.matched }, customer: { id: customer.name, name: customer.customer_name }, rows, answer };
    }

    // group === "customer": the receivable-balance question.
    const balance = await skills.getCustomerBalance(customer.name, knownIds);
    const b = balance.data;
    const answer =
      b.outstanding_vnd > 0
        ? `${customer.customer_name} còn nợ ${formatVnd(b.outstanding_vnd)}đ (${b.open_invoices} hóa đơn chưa trả).${ambNote}`
        : `${customer.customer_name} không còn nợ gì.${ambNote}`;
    return {
      question: rawText,
      normalized: nlp,
      routed: { group: route.group, matched: route.matched },
      customer: { id: customer.name, name: customer.customer_name },
      outstanding_vnd: b.outstanding_vnd,
      open_invoices: b.open_invoices,
      answer,
    };
  } finally {
    await mcp.close();
  }
}

/** The one tool dsh sees. */
async function copilotAsk(args) {
  const rawText = args?.text;
  if (typeof rawText !== "string" || rawText.trim().length === 0) {
    return { isError: true, content: [{ type: "text", text: "copilot_ask requires non-empty `text`" }] };
  }
  const structured = await answerQuestion(rawText.trim());
  return {
    content: [{ type: "text", text: JSON.stringify(structured, null, 2) }],
    structuredContent: structured,
  };
}

/** MCP stdio main loop — same protocol shape as the pinned 3.0.4 server. */
export async function main() {
  const up = await waitForNlpService();
  if (!up) {
    process.stderr.write(`[copilot] NLP bridge not reachable at ${NLP_URL} — start it: python3 -m nlp_service.server\n`);
    process.exit(3);
  }
  // Target transparency: host only — never log keys or secrets.
  try {
    const target = pickServerScript();
    const isReal = target === realServerScript();
    const host = isReal ? new URL(process.env.ERPNEXT_URL).host : "mock (in-memory)";
    process.stderr.write(`[copilot] ERPNext target: ${isReal ? "REAL" : "mock"} -> ${host}\n`);
  } catch (err) {
    process.stderr.write(`[copilot] fatal: ${err?.message ?? err}\n`);
    process.exit(2);
  }
  const rl = (await import("node:readline")).createInterface({ input: process.stdin, terminal: false });
  rl.on("line", (line) => {
    if (!line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      replyError(null, -32700, "Parse error");
      return;
    }
    const { id, method, params } = msg;
    switch (method) {
      case "initialize":
        reply(id, {
          protocolVersion: params?.protocolVersion ?? "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "erpn-copilot", version: "0.1.0" },
        });
        break;
      case "tools/list":
        reply(id, {
          tools: [{
            name: "copilot_ask",
            description: "Trả lời câu hỏi tiếng Việt về khách hàng/công nợ/tồn kho bằng pipeline Phase 1+2 (normalize → route → ERPNext, không LLM bên trong).",
            annotations: { readOnlyHint: true },
            inputSchema: {
              type: "object",
              properties: { text: { type: "string", description: "Câu hỏi tiếng Việt thô (đã qua STT hoặc gõ)" } },
              required: ["text"],
            },
          }],
        });
        break;
      case "tools/call":
        if (params?.name !== "copilot_ask") {
          replyError(id, -32602, `Unknown tool: ${params?.name}`);
          break;
        }
        copilotAsk(params?.arguments)
          .then((result) => reply(id, result))
          .catch((err) => reply(id, { content: [{ type: "text", text: String(err?.message ?? err) }], isError: true }));
        break;
      default:
        if (id !== undefined && id !== null) replyError(id, -32601, `Method not found: ${method}`);
        // notifications (no id) are silently ignored — as the protocol requires
    }
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    process.stderr.write(`[copilot] fatal: ${err?.message ?? err}\n`);
    process.exit(1);
  });
}
