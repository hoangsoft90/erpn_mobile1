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
];

const STOCK = [
  { item_code: "CAM-HEO-25KG", warehouse: "Kho chính", actual_qty: 120, reserved_qty: 5, projected_qty: 115, valuation_rate: 8_200, stock_value: 984_000 },
  { item_code: "CAM-GA-10KG", warehouse: "Kho chính", actual_qty: 40, reserved_qty: 0, projected_qty: 40, valuation_rate: 9_500, stock_value: 380_000 },
];

const PAYMENTS = [
  { name: "PE-0001", party: "CUST-00001", posting_date: "2026-09-06", paid_amount: 8_000_000, received_amount: 8_000_000, docstatus: 1 },
];

/** result9: the copilot inventory filter needs item_name — mirror the real tool's shape. */
const ITEMS = [
  { name: "CAM-HEO-25KG", item_code: "CAM-HEO-25KG", item_name: "Cám heo tăng trọng 25kg" },
  { name: "CAM-GA-10KG", item_code: "CAM-GA-10KG", item_name: "Cám gà thịt 10kg" },
];

/** Handlers mirror the real 3.0.4 handlers' return shapes. */
const TOOLS = {
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
      (i) => (!args?.customer || i.customer === args.customer) && (args?.outstanding_only === false || i.outstanding_amount > 0),
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
