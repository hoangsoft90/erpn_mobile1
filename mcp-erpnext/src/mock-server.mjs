/**
 * Mock MCP ERPNext server — line-delimited JSON-RPC 2.0 over stdio.
 *
 * Purpose (user decision 2026-09-13): complete the JSON-RPC request/response
 * correlation in createMcpClient WITHOUT real ERPNext credentials, using the
 * SAME response shapes the pinned @casys/mcp-erpnext 3.0.4 produces (verified
 * by reading its bundled source, see result4.txt §3):
 *
 *   tools/call result:
 *     { content: [{ type: "text", text: "<json>" }],
 *       structuredContent: {...}, isError?: false }
 *   handler payloads: erpnext_customer_list -> { doctype, count, data }
 *                     erpnext_customer_get  -> { data: {...} }
 *
 * Supports the 4 whitelisted Phase 2 read tools. Any other tool name gets a
 * JSON-RPC error response (method not found), exactly like a real server.
 * When REAL credentials arrive, the client only changes which binary it
 * spawns — this file is not imported by production code.
 */

import readline from "node:readline";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

/**
 * Optional persistence. The client spawns a FRESH mock process per request, so
 * without this every request would see an empty ledger — and a reconcile query
 * would answer "nothing was written" even after a real write. A real ERPNext
 * keeps its data, so the mock must too when a test needs that (reconcile /
 * crash-recovery paths): set MOCK_ERP_STATE=<file> to opt in.
 */
const STATE_FILE = process.env.MOCK_ERP_STATE;

/** Fake ERPNext data — shape mirrors real handler payloads. */
const DB = {
  "CUST-00001": {
    doctype: "Customer",
    name: "CUST-00001",
    customer_name: "Nguyễn Thị Lan",
    customer_group: "Múa",
    territory: "Miền Nam",
    disabled: 0,
  },
  "CUST-00002": {
    doctype: "Customer",
    name: "CUST-00002",
    customer_name: "Trần Văn Hai",
    customer_group: "Múa",
    territory: "Miền Tây",
    disabled: 0,
  },
};

const INVOICES = [
  { name: "SINV-0001", customer: "CUST-00001", posting_date: "2026-09-01", grand_total: 10_500_000, outstanding_amount: 2_500_000, docstatus: 1 },
  { name: "SINV-0002", customer: "CUST-00001", posting_date: "2026-09-05", grand_total: 320_000, outstanding_amount: 0, docstatus: 1 },
  { name: "SINV-0003", customer: "CUST-00002", posting_date: "2026-09-08", grand_total: 7_500_000, outstanding_amount: 7_500_000, docstatus: 1 },
  // Credit note (is_return): outstanding is NEGATIVE. It must count toward
  // "còn nợ" (net receivable) — result20: the `> 0` filter dropped it and
  // overstated CUST-00002's balance by 320.000đ. Ground truth for the
  // regression test: CUST-00002 = 7.500.000 − 320.000 = 7.180.000đ / 2 chứng từ.
  { name: "SINV-0004", customer: "CUST-00002", posting_date: "2026-09-09", grand_total: -320_000, outstanding_amount: -320_000, docstatus: 1, is_return: 1 },
];

const STOCK = [
  { item_code: "CAM-HEO-25KG", warehouse: "Kho chính", actual_qty: 120, reserved_qty: 5, projected_qty: 115, valuation_rate: 8_200, stock_value: 984_000 },
  { item_code: "CAM-GA-10KG", warehouse: "Kho chính", actual_qty: 40, reserved_qty: 0, projected_qty: 40, valuation_rate: 9_500, stock_value: 380_000 },
];

const PAYMENTS = [
  { name: "PE-0001", party: "CUST-00001", posting_date: "2026-09-06", paid_amount: 8_000_000, received_amount: 8_000_000, docstatus: 1 },
];

function saveState() {
  if (!STATE_FILE) return;
  try {
    writeFileSync(STATE_FILE, JSON.stringify({ payments: PAYMENTS }), "utf8");
  } catch {
    // A mock that cannot persist must not crash the request.
  }
}

if (STATE_FILE && existsSync(STATE_FILE)) {
  try {
    const saved = JSON.parse(readFileSync(STATE_FILE, "utf8"));
    if (Array.isArray(saved.payments)) PAYMENTS.push(...saved.payments);
  } catch {
    // ignore a torn/invalid state file — start from the fixtures
  }
}

/**
 * Accounting fixtures for the REAL Payment Entry payload (Stage B).
 * Values mirror what the real ERPNext returns for `erpnext_doc_get` on a
 * Sales Invoice / Mode of Payment — the write path reads these at execute
 * time instead of hardcoding account names.
 */
const COMPANY = "Demo Feed Co";
const RECEIVABLE_ACCOUNT = "1310 - Debtors - DFC";
/**
 * Deliberately mirrors the real site: the Vietnamese label "Tiền mặt" is NOT
 * a stored Mode of Payment — only "Cash" / "Chuyển khoản" are. Anything that
 * hardcodes the label instead of resolving it fails here, exactly like ERPNext
 * rejected the write with LinkValidationError on 2026-09-16.
 */
const MODES = [
  { name: "Chuyển khoản", enabled: 1, type: "Cash" },
  { name: "Cash", enabled: 1, type: "Cash" },
  { name: "Wire Transfer", enabled: 1, type: "Bank" },
];
const MODE_ACCOUNTS = {
  Cash: "1110 - Cash - DFC",
  "Chuyển khoản": "1120 - Bank - DFC",
  "Wire Transfer": "1120 - Bank - DFC",
};

/** result9: the copilot inventory filter needs item_name — mirror the real tool's shape. */
const ITEMS = [
  { name: "CAM-HEO-25KG", item_code: "CAM-HEO-25KG", item_name: "Cám heo tăng trọng 25kg" },
  { name: "CAM-GA-10KG", item_code: "CAM-GA-10KG", item_name: "Cám gà thịt 10kg" },
];

/** Handlers mirror the real 3.0.4 handlers' return shapes. */
const TOOLS = {
  /**
   * Phase 7 write — the REAL shape (verified in @casys 3.0.4 source: there is
   * no `erpnext_create_payment_entry`; the create tool is `erpnext_doc_create`
   * with {doctype, data}). One code path for mock and real server: the mock
   * must accept exactly what ERPNext accepts, or the tests prove nothing.
   */
  erpnext_doc_create: (args) => {
    // Fault injection for the "lost response / transient failure" path: the
    // real client cannot tell whether ERPNext wrote the document, which is the
    // exact ambiguity the resume+reconcile flow exists for. Opt-in only.
    if (process.env.MOCK_ERP_FAIL_WRITE) {
      throw new Error(`simulated ERPNext failure (MOCK_ERP_FAIL_WRITE=${process.env.MOCK_ERP_FAIL_WRITE})`);
    }
    if (args?.doctype !== "Payment Entry") {
      throw new Error(`mock only creates Payment Entry (got ${args?.doctype})`);
    }
    const data = args?.data ?? {};
    const reference = String(data.reference_no ?? "");
    if (!reference) throw new Error("reference_no is required (idempotency key)");
    // NO reference_no dedupe here on purpose: real ERPNext has no unique
    // constraint on reference_no, so a mock that dedupes would hide exactly
    // the double-write bug this phase exists to prevent (hit for real on
    // 2026-09-16 — two Payment Entries, one command_id).
    for (const required of ["party", "paid_from", "paid_to", "company"]) {
      if (!data[required]) throw new Error(`${required} is mandatory`);
    }
    const paid = Number(data.paid_amount);
    if (!Number.isFinite(paid) || paid <= 0) throw new Error("paid_amount must be positive");
    const doc = {
      doctype: "Payment Entry",
      name: `PE-M${String(PAYMENTS.length + 1).padStart(3, "0")}`,
      payment_type: data.payment_type ?? "Receive",
      party_type: data.party_type ?? "Customer",
      party: data.party,
      posting_date: data.posting_date ?? new Date().toISOString().slice(0, 10),
      paid_amount: paid,
      received_amount: Number(data.received_amount ?? paid),
      paid_from: data.paid_from,
      paid_to: data.paid_to,
      company: data.company,
      mode_of_payment: data.mode_of_payment ?? "Tiền mặt",
      reference_no: reference,
      reference_date: data.reference_date,
      // P0 §10.4 — the correlation field is stored exactly like the real site
      // stores it once the Custom Field exists. A real ERPNext WITHOUT the
      // field simply drops the key, so the mock must be able to represent that
      // absence too (it is what the executor reports as correlation_field_missing).
      ...(data.custom_ai_action_id !== undefined && data.custom_ai_action_id !== null
        ? { custom_ai_action_id: data.custom_ai_action_id }
        : {}),
      references: data.references ?? [],
      docstatus: 0, // created as DRAFT — submitting is a separate decision
    };
    PAYMENTS.push(doc);
    saveState();
    // "ERPNext committed, the response never arrived" — the single most
    // dangerous real-world case, because the caller cannot tell whether the
    // write landed. The document IS in the ledger; only the reply is lost.
    if (process.env.MOCK_ERP_FAIL_AFTER_WRITE) {
      throw new Error(
        "simulated LOST RESPONSE after the document was committed (MOCK_ERP_FAIL_AFTER_WRITE)",
      );
    }
    return { data: doc, message: `Payment Entry ${doc.name} created successfully` };
  },
  /**
   * Generic submit — mirrors the REAL 3.0.4 handler (source line ~53741):
   * `erpnext_doc_submit` {doctype, name} → frappe.client.submit. A draft is
   * submitted (docstatus 0 → 1); submitting an already-submitted doc fails,
   * exactly like the real server. Optional fault injection for the
   * "draft written, submit failed" mid-transaction case (F7-2 policy).
   */
  erpnext_doc_submit: (args) => {
    if (process.env.MOCK_ERP_FAIL_SUBMIT) {
      throw new Error(
        `simulated submit failure (MOCK_ERP_FAIL_SUBMIT=${process.env.MOCK_ERP_FAIL_SUBMIT})`,
      );
    }
    if (args?.doctype !== "Payment Entry") {
      throw new Error(`mock doc_submit does not support doctype ${args?.doctype}`);
    }
    const pe = PAYMENTS.find((p) => p.name === String(args?.name ?? ""));
    if (!pe) throw new Error(`Payment Entry ${args?.name} not found`);
    if (pe.docstatus !== 0) {
      throw new Error(`Payment Entry ${pe.name} is not submittable (docstatus ${pe.docstatus})`);
    }
    pe.docstatus = 1;
    saveState();
    return { data: pe, message: `Payment Entry ${pe.name} submitted successfully` };
  },
  /**
   * Real-server list path: Payment Entry by reference_no (reconcile) and Mode
   * of Payment (the write path resolves the real mode document name).
   */
  erpnext_doc_list: (args) => {
    // ERPNext unreachable exactly when we need it to reconcile.
    if (process.env.MOCK_ERP_FAIL_LIST) {
      throw new Error("simulated ERPNext read failure (MOCK_ERP_FAIL_LIST)");
    }
    const source =
      args?.doctype === "Payment Entry" ? PAYMENTS : args?.doctype === "Mode of Payment" ? MODES : null;
    if (!source) throw new Error(`mock doc_list does not support doctype ${args?.doctype}`);
    const filters = args?.filters ?? [];
    const rows = source
      .filter((row) =>
        filters.every(([field, op, value]) => {
          const actual = row[field];
          if (op === "=") return String(actual ?? "") === String(value ?? "");
          if (op === "!=") return String(actual ?? "") !== String(value ?? "");
          throw new Error(`mock supports only = and != (got ${op})`);
        }),
      )
      .slice(0, args?.limit ?? 20);
    return { doctype: args?.doctype, count: rows.length, data: rows };
  },
  /** Generic get: the write path resolves company/accounts from live data. */
  erpnext_doc_get: (args) => {
    const name = String(args?.name ?? "");
    if (args?.doctype === "Sales Invoice") {
      const inv = INVOICES.find((i) => i.name === name);
      if (!inv) throw new Error(`Sales Invoice ${name} not found`);
      return { data: { ...inv, company: COMPANY, debit_to: RECEIVABLE_ACCOUNT } };
    }
    if (args?.doctype === "Mode of Payment") {
      const account = MODE_ACCOUNTS[name];
      if (!account) throw new Error(`Mode of Payment ${name} not found`);
      return { data: { name, accounts: [{ company: COMPANY, default_account: account }] } };
    }
    if (args?.doctype === "Payment Entry") {
      const pe = PAYMENTS.find((p) => p.name === name);
      if (!pe) throw new Error(`Payment Entry ${name} not found`);
      return { data: pe };
    }
    throw new Error(`mock doc_get does not support doctype ${args?.doctype}`);
  },
  erpnext_customer_list: (args) => {
    const docs = Object.values(DB).filter((c) => !args?.customer_group || c.customer_group === args.customer_group);
    return { doctype: "Customer", count: docs.length, data: docs };
  },
  erpnext_customer_get: (args) => {
    const doc = DB[args?.name];
    if (!doc) throw new Error(`Customer ${args?.name} not found`);
    return { data: doc };
  },
  erpnext_stock_balance: (args) => {
    const rows = STOCK.filter(
      (s) => (!args?.item_code || s.item_code === args.item_code) && (!args?.warehouse || s.warehouse === args.warehouse),
    );
    return { doctype: "Bin", count: rows.length, data: rows };
  },
  erpnext_sales_invoice_list: (args) => {
    const rows = INVOICES.filter(
      (i) => (!args?.customer || i.customer === args.customer) && (args?.outstanding_only === false || i.outstanding_amount !== 0),
    );
    return { doctype: "Sales Invoice", count: rows.length, data: rows };
  },
  erpnext_payment_entry_list: (args) => {
    const rows = PAYMENTS.filter((p) => !args?.party || p.party === args.party);
    return { doctype: "Payment Entry", count: rows.length, data: rows };
  },
  erpnext_item_list: () => {
    // No server-side name filtering (the real 3.0.4 tool has no txt param either):
    // the skill layer filters client-side on item_name/item_code.
    return { doctype: "Item", count: ITEMS.length, data: ITEMS };
  },
};

function reply(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
}

function replyError(id, code, message) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }) + "\n");
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });

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
        serverInfo: { name: "mock-mcp-erpnext", version: "3.0.4-mock" },
      });
      break;
    case "tools/list":
      reply(id, {
        tools: Object.entries(TOOLS).map(([name, handler]) => ({
          name,
          annotations: { readOnlyHint: true },
          description: `Mock of ${name} (shape identical to @casys/mcp-erpnext 3.0.4)`,
          inputSchema: { type: "object" },
        })),
      });
      break;
    case "tools/call": {
      const handler = TOOLS[params?.name];
      if (!handler) {
        replyError(id, -32602, `Unknown tool: ${params?.name}`);
        break;
      }
      try {
        const payload = handler(params?.arguments ?? {});
        reply(id, {
          content: [{ type: "text", text: JSON.stringify(payload) }],
          structuredContent: payload,
          isError: false,
        });
      } catch (err) {
        reply(id, {
          content: [{ type: "text", text: String(err.message) }],
          isError: true,
        });
      }
      break;
    }
    default:
      if (id !== undefined && id !== null) replyError(id, -32601, `Method not found: ${method}`);
  }
});
