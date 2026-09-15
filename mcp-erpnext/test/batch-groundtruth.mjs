/**
 * Ground-truth dump from the REAL ERPNext server (via the pinned 3.0.4 MCP
 * server, same env contract as copilot-server). Read-only.
 *
 * Usage:  set -a; source .env; set +a; node mcp-erpnext/test/batch-groundtruth.mjs
 * Output: compact JSON on stdout (consumed by the batch-accuracy report).
 */

import { fileURLToPath } from "node:url";
import path from "node:path";
import { createMcpClient } from "../src/client.mjs";
import { pickServerScript } from "../src/copilot-server.mjs";

// Guard (result21): see batch-accuracy.mjs — `node --test` discovers everything
// under test/. Unattended this dumps REAL customer names, invoices and amounts
// to stdout mid-`npm test` whenever ERPNEXT_* happens to be exported.
if (process.env.NODE_TEST_CONTEXT || path.resolve(process.argv[1] ?? "") !== fileURLToPath(import.meta.url)) {
  console.error(
    "[batch-groundtruth] discovered by the test runner — skipped. Run: node test/batch-groundtruth.mjs (after sourcing .env)",
  );
  process.exit(0);
}

const mcp = createMcpClient({ serverScript: pickServerScript() });
await mcp.initialize();

const wrap = (r) => r.data?.data ?? r.data ?? [];

/** One tool failing (e.g. field-whitelist 417 on this site) must not kill the dump. */
async function safe(tool, args) {
  try {
    return { rows: wrap(await mcp.callTool(tool, args)), error: null };
  } catch (e) {
    return { rows: [], error: String(e.message ?? e).slice(0, 300) };
  }
}

const customers = await safe("erpnext_customer_list", { limit: 100 });
const invoices = await safe("erpnext_sales_invoice_list", { limit: 100 });
const payments = await safe("erpnext_payment_entry_list", { limit: 100 });
const stock = await safe("erpnext_stock_balance", {});
const items = await safe("erpnext_item_list", { limit: 100 });

// Per-customer outstanding (outstanding_amount > 0), matching the copilot
// sales skill's definition of "còn nợ".
const outstanding = {};
for (const inv of invoices.rows) {
  const cust = inv.customer;
  const amt = Number(inv.outstanding_amount) || 0;
  if (!outstanding[cust]) outstanding[cust] = { total: 0, count: 0, ids: [] };
  if (amt > 0) {
    outstanding[cust].total += amt;
    outstanding[cust].count += 1;
    outstanding[cust].ids.push(inv.name);
  }
}

const paid = {};
for (const p of payments.rows) {
  const cust = p.party;
  if (!paid[cust]) paid[cust] = { total: 0, count: 0 };
  paid[cust].total += Number(p.paid_amount) || 0;
  paid[cust].count += 1;
}

console.log(
  JSON.stringify(
    {
      counts: {
        customers: customers.rows.length,
        invoices: invoices.rows.length,
        payments: payments.rows.length,
        stock_rows: stock.rows.length,
        items: items.rows.length,
      },
      errors: {
        customers: customers.error,
        invoices: invoices.error,
        payments: payments.error,
        stock: stock.error,
        items: items.error,
      },
      customers: customers.rows.map((c) => ({ name: c.name, customer_name: c.customer_name })),
      outstanding,
      paid,
      stock: stock.rows.map((s) => ({ item: s.item_code, qty: s.actual_qty, warehouse: s.warehouse })),
    },
    null,
    2
  )
);

await mcp.close();
