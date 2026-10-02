#!/usr/bin/env node
/**
 * _probe_06_audit.mjs — BƯỚC 0.2 của Phase 6: ĐO site thật (CHỈ ĐỌC) cho 6 mục §4.
 *
 * Chỉ dùng REST đọc (`/api/resource/...` + `/api/method/...` với token trong `.env`).
 * KHÔNG ghi: không POST/PUT/DELETE, không `/execute`, không đụng ERPNext.
 *
 * Dùng: `node scripts/_probe_06_audit.mjs <phần>` với phần ∈
 *   meta | custom | pricing | tax | stock | payment | all
 *
 * File tạm (untracked, tiền tố `_probe_`): KHÔNG stage, KHÔNG commit.
 */

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");

function loadEnv(file) {
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    const [, key, raw] = m;
    if (!/^(ERPNEXT_|COPILOT_)/.test(key)) continue;
    const value = raw.trim().replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1");
    if (value && process.env[key] === undefined) process.env[key] = value;
  }
}
loadEnv(path.join(ROOT, ".env"));

const BASE = String(process.env.ERPNEXT_URL ?? "").replace(/\/+$/, "");
const AUTH = `token ${process.env.ERPNEXT_API_KEY}:${process.env.ERPNEXT_API_SECRET}`;
const COMPANY = process.env.COPILOT_COMPANY;

async function get(pathname, params = {}) {
  const url = new URL(`${BASE}${pathname}`);
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) url.searchParams.set(k, v);
  const res = await fetch(url, { headers: { Authorization: AUTH, Accept: "application/json" } });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = { _raw: text.slice(0, 400) };
  }
  return { status: res.status, body };
}

/** Danh sách bản ghi của 1 doctype (đọc thuần). */
const list = (doctype, params) => get(`/api/resource/${encodeURIComponent(doctype)}`, params);

const out = {};
const args = process.argv.slice(2).flat();
const want = (k) => args.includes("all") || args.includes(k);

if (want("meta")) {
  // (1) SI required fields + naming_series + hành vi thuế
  const si = await list("DocType/Sales Invoice");
  const fields = si.body?.data?.fields ?? [];
  out.sales_invoice_meta = {
    status: si.status,
    naming_series: fields.find((f) => f.fieldname === "naming_series")?.options ?? null,
    required: fields
      .filter((f) => Number(f.reqd) === 1)
      .map((f) => ({ fieldname: f.fieldname, fieldtype: f.fieldtype, options: f.options ?? null })),
    candidates: fields
      .filter((f) =>
        [
          "debit_to",
          "cost_center",
          "taxes_and_charges",
          "selling_price_list",
          "additional_discount_percentage",
          "additional_discount_account",
          "discount_amount",
          "apply_discount_on",
          "paid_amount",
          "outstanding_amount",
          "update_stock",
          "set_warehouse",
          "warehouse",
          "is_pos",
          "is_return",
          "company",
          "customer",
          "posting_date",
          "due_date",
          "currency",
          "conversion_rate",
        ].includes(f.fieldname),
      )
      .map((f) => ({
        fieldname: f.fieldname,
        reqd: Number(f.reqd) === 1,
        fieldtype: f.fieldtype,
        options: f.options ?? null,
        default: f.default ?? null,
      })),
  };

  const sii = await list("DocType/Sales Invoice Item");
  const lf = sii.body?.data?.fields ?? [];
  out.sales_invoice_item_fields = lf
    .filter((f) =>
      [
        "item_code",
        "item_name",
        "uom",
        "stock_uom",
        "qty",
        "rate",
        "price_list_rate",
        "discount_percentage",
        "discount_amount",
        "amount",
        "net_rate",
        "net_amount",
        "warehouse",
        "cost_center",
        "item_tax_template",
        "income_account",
        "margin_rate_or_amount",
      ].includes(f.fieldname),
    )
    .map((f) => ({
      fieldname: f.fieldname,
      reqd: Number(f.reqd) === 1,
      fieldtype: f.fieldtype,
      options: f.options ?? null,
      hidden: Number(f.hidden) === 1,
      read_only: Number(f.read_only) === 1,
      depends_on: f.depends_on ?? null,
    }));
  out.sales_invoice_item_required = lf
    .filter((f) => Number(f.reqd) === 1)
    .map((f) => f.fieldname);
}

if (want("custom")) {
  // Custom field + property setter (site dùng chung với app camvlxd)
  const cf = await list("Custom Field", {
    filters: JSON.stringify([["dt", "=", "Sales Invoice"]]),
    fields: JSON.stringify(["fieldname", "reqd", "fieldtype", "options", "label"]),
    limit_page_length: 100,
  });
  out.custom_field_sales_invoice = { status: cf.status, count: cf.body?.data?.length ?? 0, rows: cf.body?.data ?? [] };

  const cfItem = await list("Custom Field", {
    filters: JSON.stringify([["dt", "=", "Sales Invoice Item"]]),
    fields: JSON.stringify(["fieldname", "reqd", "fieldtype", "options", "label"]),
    limit_page_length: 100,
  });
  out.custom_field_sii = { status: cfItem.status, rows: cfItem.body?.data ?? [] };

  const ps = await list("Property Setter", {
    filters: JSON.stringify([["doc_type", "=", "Sales Invoice"]]),
    fields: JSON.stringify(["field_name", "property", "value"]),
    limit_page_length: 200,
  });
  out.property_setter_si = { status: ps.status, rows: ps.body?.data ?? [] };

  const ws = await list("DocType", {
    filters: JSON.stringify([["name", "like", "%Sales Invoice%"]]),
    fields: JSON.stringify(["name", "module", "custom"]),
    limit_page_length: 50,
  });
  out.sales_invoice_related_doctypes = ws.body?.data ?? [];
}

if (want("pricing")) {
  const ip = await list("Item Price", {
    fields: JSON.stringify(["name", "item_code", "price_list", "price_list_rate", "uom", "selling", "valid_from"]),
    limit_page_length: 5,
    order_by: "modified desc",
  });
  out.item_price_sample = { status: ip.status, count: ip.body?.data?.length ?? 0, rows: ip.body?.data ?? [] };

  const pl = await list("Price List", { fields: JSON.stringify(["name", "enabled", "selling", "currency"]), limit_page_length: 20 });
  out.price_lists = { status: pl.status, rows: pl.body?.data ?? [] };

  const pr = await list("Pricing Rule", {
    filters: JSON.stringify([["disable", "=", 0]]),
    fields: JSON.stringify(["name", "title", "apply_on", "selling", "buying", "valid_upto", "company"]),
    limit_page_length: 20,
  });
  out.pricing_rules_enabled = { status: pr.status, count: pr.body?.data?.length ?? 0, rows: pr.body?.data ?? [] };

  const item = await list("Item", {
    filters: JSON.stringify([["disabled", "=", 0]]),
    fields: JSON.stringify(["name", "item_name", "stock_uom", "standard_rate", "is_stock_item"]),
    limit_page_length: 5,
    order_by: "modified desc",
  });
  out.item_sample = { status: item.status, rows: item.body?.data ?? [] };
}

if (want("tax")) {
  const t = await list("Sales Taxes and Charges Template", {
    filters: JSON.stringify([["company", "=", COMPANY]]),
    fields: JSON.stringify(["name", "company", "is_default", "disabled"]),
    limit_page_length: 20,
  });
  out.sales_taxes_template = { status: t.status, company: COMPANY, rows: t.body?.data ?? [] };

  const it = await list("Item Tax Template", {
    fields: JSON.stringify(["name", "company", "title", "disabled"]),
    limit_page_length: 20,
  });
  out.item_tax_template = { status: it.status, rows: it.body?.data ?? [] };

  const acc = await list("Account", {
    filters: JSON.stringify([
      ["company", "=", COMPANY],
      ["account_type", "in", ["Tax", "Chargeable", "Income Account"]],
    ]),
    fields: JSON.stringify(["name", "account_type", "is_group", "root_type"]),
    limit_page_length: 30,
  });
  out.tax_and_income_accounts = { status: acc.status, count: acc.body?.data?.length ?? 0, rows: acc.body?.data ?? [] };
}

if (want("stock")) {
  const bin = await list("Bin", {
    filters: JSON.stringify([["actual_qty", "!=", 0]]),
    fields: JSON.stringify(["item_code", "warehouse", "actual_qty", "projected_qty", "stock_value"]),
    limit_page_length: 5,
    order_by: "modified desc",
  });
  out.bin_sample = { status: bin.status, count: bin.body?.data?.length ?? 0, rows: bin.body?.data ?? [] };

  const wh = await list("Warehouse", {
    filters: JSON.stringify([["company", "=", COMPANY], ["is_group", "=", 0]]),
    fields: JSON.stringify(["name", "warehouse_name", "company"]),
    limit_page_length: 20,
  });
  out.warehouses = { status: wh.status, pinned: process.env.COPILOT_DEFAULT_WAREHOUSE ?? null, rows: wh.body?.data ?? [] };

  const binCount = await list("Bin", {
    filters: JSON.stringify([["warehouse", "=", process.env.COPILOT_DEFAULT_WAREHOUSE]]),
    fields: JSON.stringify(["item_code", "actual_qty"]),
    limit_page_length: 3,
  });
  out.bin_in_pinned_warehouse = { status: binCount.status, count: binCount.body?.data?.length ?? 0, rows: binCount.body?.data ?? [] };
}

if (want("payment")) {
  const si = await list("Sales Invoice", {
    filters: JSON.stringify([["company", "=", COMPANY], ["docstatus", "=", 1]]),
    fields: JSON.stringify([
      "name",
      "customer",
      "grand_total",
      "total",
      "discount_amount",
      "additional_discount_percentage",
      "apply_discount_on",
      "paid_amount",
      "outstanding_amount",
      "status",
      "posting_date",
      "selling_price_list",
      "taxes_and_charges",
      "update_stock",
      "set_warehouse",
      "debit_to",
      "cost_center",
    ]),
    limit_page_length: 5,
    order_by: "modified desc",
  });
  out.sales_invoice_sample = { status: si.status, rows: si.body?.data ?? [] };

  const withDiscount = await list("Sales Invoice", {
    filters: JSON.stringify([["company", "=", COMPANY], ["discount_amount", ">", 0]]),
    fields: JSON.stringify(["name", "discount_amount", "additional_discount_percentage", "apply_discount_on", "total", "grand_total", "docstatus"]),
    limit_page_length: 5,
  });
  out.si_with_order_discount = { status: withDiscount.status, count: withDiscount.body?.data?.length ?? 0, rows: withDiscount.body?.data ?? [] };

  const draft = await list("Sales Invoice", {
    filters: JSON.stringify([["company", "=", COMPANY], ["docstatus", "=", 0]]),
    fields: JSON.stringify(["name", "customer", "grand_total", "paid_amount", "outstanding_amount", "status", "set_warehouse"]),
    limit_page_length: 10,
  });
  out.si_drafts = { status: draft.status, count: draft.body?.data?.length ?? 0, rows: draft.body?.data ?? [] };

  // SI có line discount thật?
  const siiDisc = await list("Sales Invoice Item", {
    fields: JSON.stringify(["parent", "item_code", "qty", "rate", "discount_percentage", "discount_amount", "amount", "net_amount", "price_list_rate"]),
    filters: JSON.stringify([["discount_percentage", ">", 0]]),
    limit_page_length: 5,
  });
  out.sii_with_line_discount = { status: siiDisc.status, count: siiDisc.body?.data?.length ?? 0, rows: siiDisc.body?.data ?? [] };

  const siiAny = await list("Sales Invoice Item", {
    fields: JSON.stringify(["parent", "item_code", "uom", "qty", "rate", "amount", "warehouse", "cost_center", "item_tax_template"]),
    limit_page_length: 5,
    order_by: "modified desc",
  });
  out.sii_sample = { status: siiAny.status, rows: siiAny.body?.data ?? [] };

  // PE có gắn SI không (đường thu tiền hiện hữu của site)
  const pe = await list("Payment Entry", {
    filters: JSON.stringify([["company", "=", COMPANY], ["docstatus", "=", 1]]),
    fields: JSON.stringify(["name", "payment_type", "party", "paid_amount", "mode_of_payment", "reference_no", "posting_date"]),
    limit_page_length: 5,
    order_by: "modified desc",
  });
  out.pe_sample = { status: pe.status, rows: pe.body?.data ?? [] };

  const peRef = await list("Payment Entry Reference", {
    fields: JSON.stringify(["parent", "reference_name", "reference_doctype", "allocated_amount", "outstanding_amount"]),
    filters: JSON.stringify([["reference_doctype", "=", "Sales Invoice"]]),
    limit_page_length: 5,
    order_by: "modified desc",
  });
  out.pe_reference_si_sample = { status: peRef.status, rows: peRef.body?.data ?? [] };
}

if (want("money")) {
  // (6) Đường thu tiền: SI có cho ghi paid_amount trực tiếp không? PE nháp có tham chiếu được SI nháp không?
  const si = await list("DocType/Sales Invoice");
  const fl = (si.body?.data?.fields ?? []).filter((f) =>
    ["paid_amount", "outstanding_amount", "total_advance", "update_stock", "is_pos", "payments"].includes(f.fieldname),
  );
  out.si_money_field_flags = fl.map((f) => ({
    fieldname: f.fieldname,
    fieldtype: f.fieldtype,
    read_only: Number(f.read_only) === 1,
    hidden: Number(f.hidden) === 1,
    allow_on_submit: Number(f.allow_on_submit) === 1,
    no_copy: Number(f.no_copy) === 1,
  }));

  // PE NHÁP: chúng tham chiếu cái gì? (SI nháp hay SI đã submit)
  const draftPe = await list("Payment Entry", {
    filters: JSON.stringify([["company", "=", COMPANY], ["docstatus", "=", 0]]),
    fields: JSON.stringify(["name", "payment_type", "party", "paid_amount", "mode_of_payment", "reference_no", "unallocated_amount"]),
    limit_page_length: 25,
  });
  out.draft_pe = { status: draftPe.status, count: draftPe.body?.data?.length ?? 0, rows: draftPe.body?.data ?? [] };

  const draftPeRefs = await list("Payment Entry Reference", {
    filters: JSON.stringify([["reference_doctype", "=", "Sales Invoice"]]),
    fields: JSON.stringify(["parent", "reference_name", "allocated_amount", "outstanding_amount"]),
    limit_page_length: 30,
    order_by: "modified desc",
  });
  out.pe_reference_rows_si = { status: draftPeRefs.status, count: draftPeRefs.body?.data?.length ?? 0, rows: draftPeRefs.body?.data ?? [] };

  // PE Reference con: đọc lại bằng fields=* (bản fields tường minh bị bỏ qua ở child doctype này)
  const refAll = await list("Payment Entry Reference", { fields: JSON.stringify(["*"]), limit_page_length: 20, order_by: "modified desc" });
  out.pe_reference_raw = { status: refAll.status, rows: refAll.body?.data ?? [] };

  // SI NHÁP hiện có: có PE nào tham chiếu chúng không? (bằng chứng: PE ↔ SI nháp)
  const draftSis = await list("Sales Invoice", {
    filters: JSON.stringify([["docstatus", "=", 0]]),
    fields: JSON.stringify([
      "name",
      "customer",
      "grand_total",
      "outstanding_amount",
      "update_stock",
      "set_warehouse",
      "is_pos",
      "camvlxd_transfer_state",
      "camvlxd_payment_entry",
      "company",
    ]),
    limit_page_length: 10,
  });
  out.draft_si_rows = { status: draftSis.status, count: draftSis.body?.data?.length ?? 0, rows: draftSis.body?.data ?? [] };

  const peOfDrafts = [];
  for (const si of out.draft_si_rows.rows) {
    const r = await list("Payment Entry", {
      filters: JSON.stringify([["name", "=", si.camvlxd_payment_entry ?? "__none__"]]),
      fields: JSON.stringify(["name", "docstatus", "payment_type", "mode_of_payment", "paid_amount", "unallocated_amount", "reference_no"]),
      limit_page_length: 1,
    });
    peOfDrafts.push({ si: si.name, pe_row: r.body?.data?.[0] ?? null });
  }
  out.draft_si_linked_pe = peOfDrafts;

  // SI có dùng child Sales Invoice Payment không (đường POS) + bao nhiêu SI nháp tồn tại
  const siPay = await list("Sales Invoice Payment", { fields: JSON.stringify(["parent", "mode_of_payment", "amount"]), limit_page_length: 5 });
  out.si_payment_child_rows = { status: siPay.status, count: siPay.body?.data?.length ?? 0, rows: siPay.body?.data ?? [] };

  const siDraftTotal = await get("/api/method/frappe.client.get_count", { doctype: "Sales Invoice", filters: JSON.stringify([["docstatus", "=", 0]]) });
  out.si_draft_total = { status: siDraftTotal.status, message: siDraftTotal.body?.message ?? null };
}

if (want("lifecycle")) {
  // §13 / §5.3 — vòng đời chuyển khoản: site CÓ trạng thái hay không?
  const anyState = await list("Sales Invoice", {
    fields: JSON.stringify([
      "name",
      "docstatus",
      "status",
      "camvlxd_transfer_state",
      "camvlxd_transfer_amount",
      "camvlxd_transfer_account",
      "camvlxd_payment_entry",
      "paid_amount",
      "outstanding_amount",
    ]),
    filters: JSON.stringify([["camvlxd_transfer_state", "!=", ""]]),
    limit_page_length: 10,
    order_by: "modified desc",
  });
  out.si_transfer_state_rows = { status: anyState.status, count: anyState.body?.data?.length ?? 0, rows: anyState.body?.data ?? [] };
  for (const st of ["pending", "confirmed"]) {
    const r = await list("Sales Invoice", {
      filters: JSON.stringify([["camvlxd_transfer_state", "=", st]]),
      fields: JSON.stringify(["name", "docstatus", "camvlxd_transfer_amount", "camvlxd_payment_entry"]),
      limit_page_length: 200,
    });
    out[`si_transfer_${st}`] = { status: r.status, count: r.body?.data?.length ?? 0, rows: r.body?.data ?? [] };
    const c = await get("/api/method/frappe.client.get_count", { doctype: "Sales Invoice", filters: JSON.stringify([["camvlxd_transfer_state", "=", st]]) });
    out[`si_transfer_${st}_count_api`] = { status: c.status, message: c.body?.message ?? c.body?._raw ?? null };
    const cAll = await get("/api/method/frappe.client.get_count", { doctype: "Sales Invoice" });
    out.si_total_count_api = { status: cAll.status, message: cAll.body?.message ?? cAll.body?._raw ?? null };
  }

  // Nguồn giá mặc định của site + của khách
  const setting = await get("/api/resource/Selling Settings/Selling Settings");
  out.selling_settings = {
    status: setting.status,
    selling_price_list: setting.body?.data?.selling_price_list ?? null,
    default_valid_till: setting.body?.data?.default_valid_till ?? null,
  };

  const cust = await list("Customer", {
    filters: JSON.stringify([["disabled", "=", 0]]),
    fields: JSON.stringify(["name", "default_price_list", "default_currency"]),
    limit_page_length: 8,
    order_by: "modified desc",
  });
  out.customer_price_list_sample = { status: cust.status, rows: cust.body?.data ?? [] };

  const company = await get(`/api/resource/Company/${encodeURIComponent(COMPANY)}`);
  const cd = company.body?.data ?? {};
  out.company_defaults = {
    status: company.status,
    default_income_account: cd.default_income_account ?? null,
    cost_center: cd.cost_center ?? null,
    default_receivable_account: cd.default_receivable_account ?? null,
    default_cash_account: cd.default_cash_account ?? null,
    default_bank_account: cd.default_bank_account ?? null,
    default_currency: cd.default_currency ?? null,
    country: cd.country ?? null,
  };
}

const dest = process.env.OUT_FILE;
if (dest) writeFileSync(dest, JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
