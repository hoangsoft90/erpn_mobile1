/**
 * Skill: sales WRITE (Phase 6 — Sales vertical, plan1_final_v2 §12 + phase-06).
 *
 * The shop's own sale: a customer, a warehouse, SEVERAL item lines (qty/uom/
 * price/line discount), an ORDER-level discount, and — optionally — collecting
 * money right away. Everything number-shaped is the server's:
 *
 *  - line prices come from ERPNext (Item Price for the resolved price list) —
 *    a line the site has no price for is a QUESTION, never a zero (`no_price:
 *    "ask"`, and `Item.standard_rate` is 0 for the shop's real goods);
 *  - the two discount layers are computed SEPARATELY (plan §12.2): the line
 *    discount folds into `line_net`, the order discount is applied once on the
 *    subtotal. ERPNext models them on two different tables (measured in
 *    `.plan/next8/phase6-audit.md` §2), so no function here may merge them;
 *  - `credit = grand_total − actual_paid` is a BALANCE, never a payment method
 *    (plan §7.2/§12/§14 — there is no `credit` channel anywhere below);
 *  - the write is a DRAFT Sales Invoice (`docstatus 0`), created ONLY through
 *    the Safety Gateway's `/execute`; submitting is a later, separate decision;
 *  - money taken at sale time goes out as a SEPARATE advance Payment Entry for
 *    the same party (owner decision (A) + S1, 2026-09-30): ERPNext refuses to
 *    allocate a PE against a DRAFT invoice (`payment_entry.py:
 *    "… must be submitted"` — measured), so the receipt carries NO allocation
 *    row at all and the copy must never claim the invoice was settled.
 *
 * Reuse discipline: price resolution is `priceForLine` (the same function the
 * order/quotation paths use), company resolution is `resolveSalesCompany`, the
 * draft primitives are `transaction-draft.mjs`, the advance payload builder is
 * `payment-write.mjs`'s own. Nothing here re-derives a money rule a second time.
 */

import { randomUUID } from "node:crypto";

import { assertReadOnly } from "../readonly-guard.mjs";
import { buildProposal } from "../action-proposal.mjs";
import { getCapability } from "../capability-contract.mjs";
import { priceForLine, refuse, resolveSalesCompany, rowsOf, docOf } from "./sales-order-write.mjs";
import {
  buildPaymentEntryData,
  channelOfMode,
  resolveAdvanceAccounts,
  shopDay,
} from "./payment-write.mjs";
import { listMoneyAccounts } from "./accounts.mjs";
import {
  MAX_METHODS_PER_TRANSACTION,
  validatePaymentMethods,
} from "../transaction-draft.mjs";

/** The ONE doctype this skill may create (fail-closed everywhere else). */
export const WRITE_DOCTYPE = "Sales Invoice";

/** The capability that owns this skill — policy is read THROUGH the contract. */
export const CAPABILITY_ID = "sales.create";

/** `act_<uuid>` — a unique id for one logical action. */
export function newActionId() {
  return `act_${randomUUID()}`;
}

/** Contract policy block, read once per call (a missing block is a hard bug). */
function policy() {
  const cap = getCapability(CAPABILITY_ID);
  if (!cap) throw new Error("SALES_CONTRACT_MISSING: sales.create is not in the capability contract");
  return cap;
}

/**
 * The shop's arithmetic — the PURE half (no I/O), so tests can pin it without
 * a server. Both layers stay separate values in the result; `total` is the
 * only place they ever meet, by subtraction.
 *
 * @param {Array<{qty:number, unit_price:number, line_discount?:number}>} items
 * @param {number} orderDiscount
 */
export function computeSalesTotals(items, orderDiscount = 0) {
  const lineDiscount = items.reduce((sum, it) => sum + Math.round(Number(it.line_discount) || 0), 0);
  const subtotal = items.reduce(
    (sum, it) => sum + Math.round(Number(it.qty) * Number(it.unit_price)) - Math.round(Number(it.line_discount) || 0),
    0,
  );
  const total = subtotal - Math.round(Number(orderDiscount) || 0);
  return { subtotal, line_discount: lineDiscount, order_discount: Math.round(Number(orderDiscount) || 0), total };
}

/**
 * Which price list governs this sale. ONE order (measured in the audit §3):
 * the customer's own default, else `Selling Settings.selling_price_list`.
 * Neither read may invent a list.
 *
 * @returns {Promise<string|null>}
 */
export async function resolvePriceList(mcp, customer) {
  if (customer?.default_price_list) return String(customer.default_price_list);
  // MEASURED on the real site (2026-09-30): `Selling Settings` is a SINGLE doc.
  // The LIST tool answers HTTP 500 for it —
  //   MySQLdb.ProgrammingError: ('DocType', 'Selling Settings')
  // — while `erpnext_doc_get` answers 200 with `{data:{selling_price_list}}`.
  // Reading it as a list therefore ALWAYS returned null on a live site, which
  // left the price list unresolved and let `priceForLine` fall back to the first
  // Item Price row it saw — a Standard BUYING row (the cost). Same access path
  // `readSessionCompany` uses for `Global Defaults` (also a Single).
  try {
    assertReadOnly("erpnext_doc_get");
    const doc = docOf(
      await mcp.callTool("erpnext_doc_get", { doctype: "Selling Settings", name: "Selling Settings" }),
    );
    const fromSingle = typeof doc?.selling_price_list === "string" ? doc.selling_price_list.trim() : "";
    if (fromSingle) return fromSingle;
  } catch {
    // A site that does not expose the Single read falls through to the list
    // shape below (kept for sites/mocks that DO answer it).
  }
  try {
    assertReadOnly("erpnext_doc_list");
    const res = await mcp.callTool("erpnext_doc_list", {
      doctype: "Selling Settings",
      fields: ["name", "selling_price_list"],
      limit: 1,
    });
    return String(rowsOf(res)[0]?.selling_price_list ?? "") || null;
  } catch {
    return null; // unreadable settings ⇒ the caller's price check will ask
  }
}

/**
 * The selling Item Price rows for ONE line's item — scoped to the item so the
 * read stays bounded, using the same guarded read the order path uses.
 */
async function itemPriceRows(mcp, itemCode) {
  assertReadOnly("erpnext_doc_list");
  const res = await mcp.callTool("erpnext_doc_list", {
    doctype: "Item Price",
    fields: ["name", "item_code", "price_list", "price_list_rate", "uom", "selling"],
    // `selling = 1` is a SELLING-side guard, measured necessary (2026-09-30):
    // the site keeps the buying rate on the same table (CAM-HEO-25KG: 295.000
    // Standard Buying vs 320.000 Standard Selling), and `priceForLine` falls back
    // to `pool[0]` when no price list matches — so without this filter a sale
    // could be priced at the shop's COST. A sale must never consume a buying row.
    // Values are STRINGS: ERPNext's filter API only accepts string values (the
    // repo's static tripwire enforces it), even though the field is an Int.
    filters: [["item_code", "=", String(itemCode)], ["selling", "=", "1"]],
    limit: 200,
  });
  return rowsOf(res);
}

/**
 * Current stock of one item in one warehouse — a WARNING input only. A missing
 * Bin row means "no stock record" (still a warning, still no block).
 */
export async function stockFor(mcp, itemCode, warehouse) {
  assertReadOnly("erpnext_stock_balance");
  const res = await mcp.callTool("erpnext_stock_balance", { item_code: String(itemCode), warehouse: String(warehouse) });
  const row = rowsOf(res)[0];
  return row ? Math.round(Number(row.actual_qty) || 0) : null;
}

/**
 * The site's default Sales Taxes and Charges Template for the company (audit
 * §4: `is_default = 1`). The server only ever NAMES a template — it never
 * computes tax amounts; ERPNext owns the totals.
 *
 * @returns {Promise<string|null>} template name or null (site has none ⇒ send none)
 */
export async function defaultTaxTemplate(mcp, company) {
  assertReadOnly("erpnext_doc_list");
  const res = await mcp.callTool("erpnext_doc_list", {
    doctype: "Sales Taxes and Charges Template",
    fields: ["name", "company", "is_default", "disabled"],
    filters: [["company", "=", String(company)]],
    limit: 20,
  });
  const rows = rowsOf(res).filter((r) => Number(r.disabled) !== 1);
  return (rows.find((r) => Number(r.is_default) === 1) ?? rows[0])?.name ?? null;
}

/**
 * Stage A — build the sales proposal from the SCREEN's draft.
 *
 * @param {object} mcp MCP client (mock or real); every read is guarded
 * @param {object} args
 * @param {object} args.customer    the RESOLVED customer row (from a tool result)
 * @param {string|null} [args.warehouse] chosen leaf warehouse (already validated by the picker)
 * @param {Array<{item_id:string, uom:string, qty:number, unit_price?:number|null, line_discount?:number}>} args.items
 * @param {number} [args.orderDiscount]
 * @param {Array<{mode:string, amount:number, account_id?:string|null}>} [args.paymentMethods]
 *        ≤ 1 (lock §6.1); absent ⇒ no collection is part of this proposal
 * @param {string|null} [args.company] authorization-resolved company hint
 * @param {string|null} [args.handoffId]
 * @returns {Promise<{proposal:object, lines:object[], totals:object, warnings:string[], action_id:string, company:string}>}
 */
export async function buildSalesProposal(
  mcp,
  { customer, warehouse = null, items = [], orderDiscount = 0, paymentMethods = null, company = null, handoffId = null },
) {
  if (!customer?.name) {
    throw refuse("SALES_CUSTOMER_UNRESOLVED", "chưa chọn khách hàng — không lập được hoá đơn bán");
  }
  const maxLines = Number(policy().line_policy?.max_lines ?? 20);
  const list = Array.isArray(items) ? items : [];
  if (list.length === 0) {
    throw refuse("SALES_ITEM_UNRESOLVED", "hoá đơn chưa có dòng hàng nào — thêm mặt hàng trước khi lập");
  }
  if (list.length > maxLines) {
    throw refuse("SALES_LINE_LIMIT", `hoá đơn có ${list.length} dòng, vượt giới hạn ${maxLines} dòng — tách thành nhiều hoá đơn`);
  }

  // Methods: the SAME validator Collect uses (one place for the §6.1 rule).
  // An absent/empty list is legal here — a sale may be entirely on credit.
  let methods = [];
  if (paymentMethods !== null && paymentMethods !== undefined) {
    const validated = validatePaymentMethods(paymentMethods);
    if (!validated.ok) throw refuse(validated.code, validated.reason);
    methods = validated.methods;
  }

  const resolvedCompany = await resolveSalesCompany(mcp, {
    authzCompany: company,
    code: "SALES_COMPANY_UNRESOLVED",
    noun: "hoá đơn bán",
  });

  // §6.2 at PROPOSE time — the SAME rule the collect route enforces through
  // listMoneyAccounts: an account the user named must EXIST, belong to the
  // company, and carry the channel's `account_type`. A cash ledger offered for
  // a bank intent is a REFUSAL (never a substitution, never a 1110 fallback).
  if (methods.length > 0) {
    const accounts = await listMoneyAccounts(mcp, { company: resolvedCompany });
    if (accounts?.ok === false) throw refuse(accounts.code, accounts.error);
    const channel = channelOfMode(methods[0].mode);
    if (!channel) {
      throw refuse("PAYMENT_METHOD_INVALID", `hình thức "${methods[0].mode}" không xác định được là tiền mặt hay chuyển khoản`);
    }
    const want = channel === "cash" ? accounts.data.cash : accounts.data.bank;
    const other = channel === "cash" ? accounts.data.bank : accounts.data.cash;
    const chosen = methods[0].account_id ?? null;
    if (chosen) {
      if (!want.some((a) => a.account === chosen)) {
        const wrongType = other.some((a) => a.account === chosen);
        throw refuse(
          wrongType ? "ACCOUNT_TYPE_MISMATCH" : "PAYMENT_ACCOUNT_UNRESOLVED",
          wrongType
            ? `tài khoản ${chosen} không khớp hình thức ${methods[0].mode} — chọn tài khoản đúng loại`
            : `tài khoản ${chosen} không thuộc công ty ${resolvedCompany}`,
        );
      }
    } else {
      const declared = channel === "cash" ? accounts.data.defaults?.cash : accounts.data.defaults?.bank;
      if (!declared) {
        throw refuse(
          "PAYMENT_ACCOUNT_UNRESOLVED",
          `chưa xác định được tài khoản ${channel === "cash" ? "tiền mặt" : "ngân hàng"} cho công ty ${resolvedCompany} — chọn tài khoản hoặc khai báo default trên ERPNext`,
        );
      }
      // The default is what the executor will resolve; pin it into the proposal
      // so the confirm screen shows WHERE the money would land.
      methods = [{ ...methods[0], account_id: declared }];
    }
  }
  const priceList = await resolvePriceList(mcp, customer);

  // ONE pass over the lines: resolve uom membership (the uom the picker chose
  // must EXIST — the exact-token rule, no conversion here: the screen sells in
  // declared units and ERPNext carries the factor), then resolve the price.
  const uomRows = await mcp.callTool("erpnext_doc_list", { doctype: "UOM", fields: ["name"], limit: 0 });
  const uomNames = new Set(rowsOf(uomRows).map((r) => String(r.name)));
  const warnings = [];
  const lines = [];
  for (const raw of list) {
    const itemCode = String(raw?.item_id ?? "").trim();
    if (!itemCode) throw refuse("SALES_ITEM_UNRESOLVED", "một dòng hàng thiếu mã mặt hàng — chọn lại mặt hàng");
    const qty = Number(raw?.qty);
    if (!Number.isFinite(qty) || qty <= 0) {
      throw refuse("SALES_QTY_INVALID", `số lượng của ${itemCode} phải là số dương (đang ${JSON.stringify(raw?.qty)})`);
    }
    const uom = String(raw?.uom ?? "").trim();
    if (!uom || !uomNames.has(uom)) {
      throw refuse(
        "SALES_UOM_UNRESOLVED",
        `đơn vị "${uom || "(trống)"}" của ${itemCode} không có trên ERPNext — chọn lại đơn vị của dòng`,
      );
    }
    // Price: ERPNext's, never the client's. A client-sent unit_price is only
    // something to COMPARE against (drift ⇒ re-confirm at execute time).
    const priceRows = await itemPriceRows(mcp, itemCode);
    const price = priceForLine(priceRows, { itemCode, uom, priceList });
    if (!price) {
      throw refuse(
        "SALES_PRICE_MISSING",
        `ERPNext chưa có giá bán cho ${itemCode} theo đơn vị ${uom} (bảng giá ${priceList ?? "?"}) — không tự đặt giá, hãy khai giá trong ERPNext`,
      );
    }
    const unitPrice = Math.round(price.rate);
    const lineDiscount = Math.round(Number(raw?.line_discount) || 0);
    if (lineDiscount < 0) {
      throw refuse("SALES_DISCOUNT_INVALID", `chiết khấu dòng của ${itemCode} không được âm`);
    }
    const lineNet = Math.round(qty * unitPrice) - lineDiscount;
    if (lineDiscount > 0 && lineDiscount > Math.round(qty * unitPrice)) {
      throw refuse("SALES_DISCOUNT_INVALID", `chiết khấu dòng của ${itemCode} (${lineDiscount}) vượt tiền dòng (${Math.round(qty * unitPrice)})`);
    }
    if (lineNet < 0) {
      throw refuse("SALES_DISCOUNT_INVALID", `dòng ${itemCode} ra số âm sau chiết khấu — kiểm tra lại giá/chiết khấu`);
    }
    lines.push({
      item_code: itemCode,
      uom,
      qty,
      unit_price: unitPrice,
      line_discount: lineDiscount,
      line_net: lineNet,
      price_list: price.price_list,
    });
  }

  const orderDiscountValue = Math.round(Number(orderDiscount) || 0);
  if (orderDiscountValue < 0) throw refuse("SALES_DISCOUNT_INVALID", "chiết khấu toàn đơn không được âm");
  const totals = computeSalesTotals(lines, orderDiscountValue);
  if (orderDiscountValue > totals.subtotal) {
    throw refuse(
      "SALES_DISCOUNT_INVALID",
      `chiết khấu toàn đơn (${orderDiscountValue}) vượt subtotal (${totals.subtotal}) — kiểm tra lại`,
    );
  }
  const paidVnd = methods.reduce((sum, m) => sum + m.amount, 0);
  // The credit remainder is a NUMBER (plan §12): grand_total − actual_paid.
  const credit = totals.total - paidVnd;
  if (credit < 0) {
    throw refuse(
      "SALES_OVERPAID",
      `tiền thu (${paidVnd}) vượt tổng hoá đơn (${totals.total}) — thu đúng phần còn lại hoặc tách lần thu`,
    );
  }
  if (methods.length > 0 && paidVnd > 0 && methods[0].amount > totals.total) {
    // validatePaymentMethods already enforces amount > 0; this is the
    // sale-specific ceiling (never collect more than the document).
    throw refuse("SALES_OVERPAID", `lần thu đầu tiên (${methods[0].amount}) vượt tổng hoá đơn (${totals.total})`);
  }

  // Stock: a WARNING, never a gate (audit §5; the owner has not asked for a
  // hard constraint). Only consulted for a chosen/defaulted warehouse.
  let warehouseUsed = warehouse ? String(warehouse) : null;
  if (!warehouseUsed) {
    warehouseUsed = process.env.COPILOT_DEFAULT_WAREHOUSE || null;
    if (warehouseUsed) warnings.push(`chưa chọn kho — dùng kho mặc định ${warehouseUsed} (đổi trên ERPNext nếu sai)`);
  }
  if (warehouseUsed) {
    const seen = new Set();
    for (const line of lines) {
      if (seen.has(line.item_code)) continue;
      seen.add(line.item_code);
      const qtyOnHand = await stockFor(mcp, line.item_code, warehouseUsed);
      if (qtyOnHand !== null && qtyOnHand < line.qty) {
        warnings.push(`tồn ${line.item_code} tại ${warehouseUsed} chỉ còn ${qtyOnHand} (cần ${line.qty}) — hoá đơn NHÁP chưa trừ kho, kiểm tra trước khi giao`);
      }
    }
  }

  const actionId = newActionId();
  const partyName = customer.customer_name ?? customer.name;
  const proposal = buildProposal({
    action: "create_sales_invoice_draft",
    risk: "HIGH",
    entity: { kind: "customer", id: customer.name, name: partyName },
    params: {
      warehouse: warehouseUsed,
      // The DRAFT the screen approved: items + both discount layers, kept apart.
      items: lines.map((l) => ({
        item_id: l.item_code,
        uom: l.uom,
        qty: l.qty,
        unit_price: l.unit_price,
        line_discount: l.line_discount,
      })),
      order_discount_vnd: totals.order_discount,
      line_discount_vnd: totals.line_discount,
      subtotal_vnd: totals.subtotal,
      // Server arithmetic for DISPLAY; the verified number is what ERPNext
      // computes on the write (taxes are ERPNext's business).
      estimated_total_vnd: totals.total,
      credit_vnd: credit,
      payment_methods: methods.map((m) => ({ mode: m.mode, amount: m.amount, account_id: m.account_id ?? null })),
      collected_vnd: paidVnd,
      submit_now: false,
      posting_date: shopDay(),
    },
    summary:
      `Tạo hoá đơn NHÁP cho ${partyName}: ${lines.map((l) => `${l.qty} ${l.uom} ${l.item_code}`).join(" + ")}` +
      ` — tổng tạm tính ${totals.total}đ` +
      (paidVnd > 0 ? `, thu ngay ${paidVnd}đ, còn lại ${credit}đ` : ", chưa thu tiền"),
    extra: {
      warnings,
      action_id: actionId,
      handoff_id: handoffId,
      schema_note:
        "params.items/unit_price là ĐỀ XUẤT — execute đọc lại giá từ ERPNext, lệch thì TỪ CHỐI (không tự re-price)",
    },
  });

  return { proposal, lines, totals, warnings, action_id: actionId, company: resolvedCompany, price_list: priceList };
}

/**
 * The rate ERPNext will store for a line AFTER its own (line-level) discount.
 *
 * MEASURED on the real site (2026-09-30): the child `discount_amount` is a
 * DERIVED field, not an input — ERPNext recomputes
 *   `discount_amount = flt(price_list_rate × qty) − flt(rate × qty)`
 * so sending `discount_amount` directly came back **0** while `rate` was kept
 * exactly as sent (a live draft priced 320.000/Bao stored `rate =
 * price_list_rate = 295.000`, `discount_amount = 0`). The design's own mapping
 * says the same thing: `rate` is “giá thực ghi”, `price_list_rate` exists “để CK
 * dòng có nghĩa”. So the line discount is expressed as the pair
 * (price_list_rate = the LIST rate, rate = the NET rate).
 *
 * @param {number} qty
 * @param {number} unitPrice  the LIST rate resolved from ERPNext
 * @param {number} [lineDiscount] VND off this line
 * @returns {number} the net rate, rounded like ERPNext stores it
 */
export function netLineRate(qty, unitPrice, lineDiscount = 0) {
  const q = Number(qty);
  const list = Number(unitPrice);
  if (!Number.isFinite(q) || q <= 0) return Math.round(list);
  const net = Math.round(q * list) - Math.round(Number(lineDiscount) || 0);
  return Math.round((net / q) * 100) / 100;
}

/**
 * The REAL Sales Invoice payload (pure — unit-testable without network).
 *
 * Field mapping is the AUDIT's (`.plan/next8/phase6-audit.md` §1/§2): the two
 * discount layers land on two different tables exactly as ERPNext models them,
 * the server fills every required field the site declares, and `update_stock`
 * is sent EXPLICITLY 0 (a chat-made invoice must never move stock).
 *
 * @param {object} args
 * @param {object[]} args.lines   re-verified lines (execute-time prices)
 * @param {string} args.company
 * @param {string} args.debitTo     Company.default_receivable_account
 * @param {string} args.incomeAccount Company.default_income_account
 * @param {string} args.costCenter  Company.cost_center
 * @param {string|null} args.taxTemplate the company's default template (name only)
 * @param {string|null} args.transferState "pending" for a bank collection, else null
 */
export function buildSalesInvoiceData({
  customerId,
  lines,
  company,
  warehouse,
  orderDiscount,
  debitTo,
  incomeAccount,
  costCenter,
  taxTemplate,
  postingDate,
  actionId,
  correlationField = "custom_ai_action_id",
  transferState = null,
  transferAmount = null,
  transferAccount = null,
}) {
  return {
    doctype: WRITE_DOCTYPE,
    customer: customerId,
    company,
    posting_date: postingDate,
    set_warehouse: warehouse ?? undefined,
    // The company's own defaults (audit §1/§7) — never client input.
    debit_to: debitTo,
    selling_price_list: undefined, // left to ERPNext's own default chain
    ...(taxTemplate ? { taxes_and_charges: taxTemplate } : {}),
    // ── Order discount — the SECOND layer, on the PARENT table only. ──
    ...(orderDiscount > 0
      ? { discount_amount: orderDiscount, apply_discount_on: "Grand Total" }
      : {}),
    update_stock: 0,
    is_pos: 0,
    // ── Bank-transfer lifecycle (plan §13 / owner decision): "waiting for the
    // money" is a real state on this site; the receipt is NOT "money received".
    ...(transferState ? { camvlxd_transfer_state: transferState } : {}),
    ...(transferAmount != null ? { camvlxd_transfer_amount: transferAmount } : {}),
    ...(transferAccount ? { camvlxd_transfer_account: transferAccount } : {}),
    // P0 §10.4 — the correlation field; a site without it drops the key.
    [correlationField]: actionId ?? null,
    remarks: "ERPNext Voice Copilot · xác nhận bởi người dùng · hoá đơn NHÁP, chưa submit",
    items: lines.map((l) => ({
      item_code: l.item_code,
      uom: l.uom,
      qty: l.qty,
      // ── Line discount — the FIRST layer, on the CHILD row only, expressed the
      // only way the site honours: list rate + NET rate. `discount_amount` is
      // DERIVED by ERPNext from the two (see `netLineRate`), never sent.
      price_list_rate: l.unit_price,
      rate: netLineRate(l.qty, l.unit_price, l.line_discount),
      warehouse: warehouse ?? undefined,
      income_account: incomeAccount ?? undefined,
      cost_center: costCenter ?? undefined,
    })),
  };
}

/**
 * Reconcile an interrupted attempt against ERPNext — READ ONLY.
 *
 * The correlation field is the once-only half a draft invoice has (the same
 * P0 §10.4 rule every write here follows): a lost response after the write is
 * reconciled by ACTION ID, never by document name (F-P5-4: the site reuses
 * names of deleted documents).
 *
 * @returns {Promise<{found:boolean, count:number, doc:object|null, duplicates:boolean,
 *                     correlation_field:string, correlation_field_unavailable:boolean}>}
 */
export async function reconcileSalesDraft(mcp, reference, { actionId = null } = {}) {
  assertReadOnly("erpnext_doc_list");
  const value = actionId ?? reference;
  try {
    const res = await mcp.callTool("erpnext_doc_list", {
      doctype: WRITE_DOCTYPE,
      fields: ["name", "docstatus", "customer", "grand_total", "custom_ai_action_id"],
      filters: [["custom_ai_action_id", "=", String(value)]],
      limit: 5,
    });
    const rows = rowsOf(res);
    return {
      found: rows.length > 0,
      count: rows.length,
      doc: rows[0] ?? null,
      duplicates: rows.length > 1,
      correlation_field: "custom_ai_action_id",
      correlation_field_unavailable: false,
    };
  } catch (err) {
    return {
      found: false,
      count: 0,
      doc: null,
      duplicates: false,
      correlation_field: "custom_ai_action_id",
      correlation_field_unavailable: true,
      error: err?.message ?? String(err),
    };
  }
}

/**
 * Stage B — execute a CONFIRMED sales proposal. Runs ONLY behind the Safety
 * Gateway (idempotency + authorization already gated this command).
 *
 * One command may write at most ONE Sales Invoice draft; when the proposal
 * carries a payment method, the SAME command ALSO writes ONE advance Payment
 * Entry for the same party (owner decision (A) + S1): no allocation rows, no
 * touching the draft invoice's `paid_amount` (read-only — audit §6), no claim
 * that the invoice was settled.
 *
 * @returns {Promise<object>} the result the card renders
 */
export async function executeSalesProposal(mcp, proposal, commandId, store, { company = null } = {}) {
  const customerId = proposal.entity?.id;
  const wantItems = Array.isArray(proposal.params?.items) ? proposal.params.items : [];
  if (!customerId) throw refuse("SALES_CUSTOMER_UNRESOLVED", "đề xuất không có khách hàng — không ghi hoá đơn");
  if (wantItems.length === 0) throw refuse("SALES_ITEM_UNRESOLVED", "đề xuất không có dòng hàng nào — không ghi hoá đơn");

  const field = "custom_ai_action_id";
  const actionId = proposal.action_id ?? null;

  // 1. Once-only (server half): this action id must not already have an invoice.
  assertReadOnly("erpnext_doc_list");
  const probe = await mcp.callTool("erpnext_doc_list", {
    doctype: WRITE_DOCTYPE,
    fields: ["name", "docstatus", "customer", field],
    filters: [[field, "=", String(actionId ?? commandId)]],
    limit: 5,
  });
  const existing = rowsOf(probe);
  if (existing.length > 0) {
    throw refuse(
      "SALES_DUPLICATE_ACTION",
      `hoá đơn ${existing[0].name} đã tồn tại trên ERPNext với action id này — KHÔNG ghi lần nữa, kiểm tra ERPNext trước`,
      { existing_doc: existing[0].name },
    );
  }

  // 2. RE-READ every price from ERPNext — drift ⇒ PROPOSAL_STALE, never a
  //    silent re-price. Same discipline as the order executor.
  const resolvedCompany = await resolveSalesCompany(mcp, {
    authzCompany: company ?? proposal.params?.company ?? null,
    code: "SALES_COMPANY_UNRESOLVED",
    noun: "hoá đơn bán",
  });
  const priceList = await resolvePriceList(mcp, { default_price_list: null });
  const lines = [];
  for (const want of wantItems) {
    const itemCode = String(want?.item_id ?? "").trim();
    const uom = String(want?.uom ?? "").trim();
    const priceRows = await itemPriceRows(mcp, itemCode);
    const price = priceForLine(priceRows, { itemCode, uom, priceList });
    if (!price) {
      throw refuse(
        "PROPOSAL_STALE",
        `${itemCode}: giá bán cho ${uom} không còn trong ERPNext — KHÔNG ghi, hãy lập lại`,
        { drift_code: "PROPOSAL_VERSION_STALE" },
      );
    }
    const rate = Math.round(price.rate);
    if (Number(want?.unit_price) !== rate) {
      throw refuse(
        "PROPOSAL_STALE",
        `${itemCode}: giá đổi ${want.unit_price} → ${rate} — KHÔNG ghi, hãy xác nhận lại trên số mới`,
        { drift_code: "PROPOSAL_VERSION_STALE" },
      );
    }
    lines.push({
      item_code: itemCode,
      uom,
      qty: Number(want.qty),
      unit_price: rate,
      line_discount: Math.round(Number(want.line_discount) || 0),
    });
  }

  // 3. The company's own account defaults (audit §7) — never client input.
  assertReadOnly("erpnext_doc_get");
  const companyDoc = docOf(await mcp.callTool("erpnext_doc_get", { doctype: "Company", name: resolvedCompany }));
  const debitTo = companyDoc?.default_receivable_account ?? null;
  const incomeAccount = companyDoc?.default_income_account ?? null;
  const costCenter = companyDoc?.cost_center ?? null;
  if (!debitTo) {
    throw refuse(
      "SALES_ACCOUNT_UNRESOLVED",
      `Company ${resolvedCompany} chưa khai default_receivable_account — không biết ghi công nợ vào đâu, TỪ CHỐI`,
    );
  }
  const taxTemplate = await defaultTaxTemplate(mcp, resolvedCompany);
  if (taxTemplate) {
    // Name the template in the result so the seller sees which tax ERPNext applied.
  }

  const warehouse = proposal.params?.warehouse ?? process.env.COPILOT_DEFAULT_WAREHOUSE ?? null;
  const orderDiscount = Math.round(Number(proposal.params?.order_discount_vnd) || 0);
  const methods = Array.isArray(proposal.params?.payment_methods) ? proposal.params.payment_methods : [];
  if (methods.length > MAX_METHODS_PER_TRANSACTION) {
    // §6.1 — re-checked HERE because /execute takes the proposal from the body;
    // a crafted pair of methods must refuse, not silently narrow.
    throw refuse(
      "PAYMENT_METHOD_COUNT_INVALID",
      `một lần thu chỉ một hình thức thanh toán — nhận ${methods.length}, từ chối ghi`,
    );
  }
  const method = methods[0] ?? null;

  // The snapshot's credit must still match the re-read numbers: the client's
  // total is a claim to compare, never the number that gets written.
  const totals = computeSalesTotals(lines, orderDiscount);
  if (Number.isFinite(Number(proposal.params?.estimated_total_vnd)) &&
      Math.round(Number(proposal.params.estimated_total_vnd)) !== totals.total) {
    throw refuse(
      "PROPOSAL_STALE",
      `tổng đề xuất (${proposal.params.estimated_total_vnd}) ≠ tổng tính lại trên giá hiện tại (${totals.total}) — KHÔNG ghi, hãy xác nhận lại`,
      { drift_code: "PROPOSAL_VERSION_STALE" },
    );
  }

  // 4. Register the ERPNext-side reference BEFORE the write (crash safety).
  store.setReference(commandId, commandId);

  if (typeof mcp.callWriteTool !== "function") {
    throw refuse("EXECUTE_CLIENT_UNSUPPORTED", "this MCP client has no write method");
  }

  // §13 lifecycle: a BANK collection is "waiting for the money" — written on
  // the invoice itself (the site's own field), never claimed as received.
  const isBank = method?.mode === "bank_transfer";
  const data = buildSalesInvoiceData({
    customerId,
    lines,
    company: resolvedCompany,
    warehouse,
    orderDiscount,
    debitTo,
    incomeAccount,
    costCenter,
    taxTemplate,
    postingDate: shopDay(),
    actionId,
    transferState: isBank ? "pending" : null,
    transferAmount: isBank ? method.amount : null,
  });
  const res = await mcp.callWriteTool("erpnext_doc_create", { doctype: WRITE_DOCTYPE, data });
  const doc = docOf(res);
  const docName = doc?.name ?? null;
  if (!docName) {
    throw refuse("SALES_WRITE_UNVERIFIED", "ERPNext không trả về document name — coi như chưa ghi xong, cần đối soát");
  }

  // 5. VERIFY by reading back — the write response is not evidence.
  assertReadOnly("erpnext_doc_get");
  const back = docOf(await mcp.callTool("erpnext_doc_get", { doctype: WRITE_DOCTYPE, name: docName }));
  const problems = [];
  if (String(back.customer ?? "") !== String(customerId)) problems.push(`customer=${back.customer}`);
  if (Number(back.docstatus) !== 0) problems.push(`docstatus=${back.docstatus} (hoá đơn phải là NHÁP)`);
  if (Number(back.update_stock ?? 0) !== 0) problems.push(`update_stock=${back.update_stock} (phải là 0)`);
  if (Array.isArray(back.items) ? back.items.length !== lines.length : true) {
    problems.push(`số dòng=${Array.isArray(back.items) ? back.items.length : 0} (mong đợi ${lines.length})`);
  }
  // Both layers, verified SEPARATELY on the document that came back.
  const lineDiscountSum = lines.reduce((s, l) => s + l.line_discount, 0);
  if (orderDiscount > 0 && Math.round(Number(back.discount_amount) || 0) !== orderDiscount) {
    problems.push(`discount_amount=${back.discount_amount} (mong đợi ${orderDiscount})`);
  }
  const backLines = Array.isArray(back.items) ? back.items : [];
  for (const want of lines) {
    const got = backLines.find((g) => String(g.item_code) === String(want.item_code));
    if (!got) {
      problems.push(`thiếu dòng ${want.item_code}`);
      continue;
    }
    if (Math.abs(Number(got.qty) - want.qty) > 1e-9) problems.push(`${want.item_code}: qty=${got.qty}`);
    // `price_list_rate` is the LIST rate, `rate` the NET rate after the line
    // discount, and `discount_amount` ERPNext's DERIVED difference (measured
    // 2026-09-30). A 1đ-per-line tolerance absorbs the 2-decimal rate rounding.
    const wantNet = netLineRate(want.qty, want.unit_price, want.line_discount);
    if (Math.abs(Number(got.price_list_rate ?? 0) - want.unit_price) > 1) {
      problems.push(`${want.item_code}: price_list_rate=${got.price_list_rate} (mong đợi ${want.unit_price})`);
    }
    if (Math.abs(Number(got.rate) - wantNet) > 1) {
      problems.push(`${want.item_code}: rate=${got.rate} (mong đợi ${wantNet})`);
    }
    if (Math.abs(Math.round(Number(got.discount_amount) || 0) - want.line_discount) > 1) {
      problems.push(`${want.item_code}: discount_amount=${got.discount_amount} (mong đợi ${want.line_discount})`);
    }
  }
  if (isBank && String(back.camvlxd_transfer_state ?? "") !== "pending") {
    problems.push(`camvlxd_transfer_state=${back.camvlxd_transfer_state} (mong đợi pending)`);
  }
  if (problems.length > 0) {
    throw refuse(
      "SALES_WRITE_UNVERIFIED",
      `đọc lại hoá đơn ${docName} thấy sai lệch: ${problems.join(", ")} — cần đối soát thủ công`,
      { doc: back },
    );
  }

  const erpnextTotal = Number.isFinite(Number(back.grand_total)) ? Math.round(Number(back.grand_total)) : null;
  const result = {
    erpnext_doc: docName,
    customer: customerId,
    customer_name: proposal.entity?.name ?? null,
    warehouse,
    lines: backLines.map((l) => ({
      item_code: l.item_code,
      item_name: l.item_name ?? l.item_code,
      qty: Number(l.qty),
      uom: l.uom,
      // `rate` = what ERPNext stored (the NET rate); `price_list_rate` = the list
      // rate the screen showed. The line discount is their difference.
      rate: Number(l.rate),
      price_list_rate: Number(l.price_list_rate ?? l.rate),
      line_discount_vnd: Math.round(Number(l.discount_amount) || 0),
    })),
    line_count: backLines.length,
    // The two layers travel apart in the RESULT too (falsify F1 pins this).
    subtotal_vnd: totals.subtotal,
    line_discount_vnd: lineDiscountSum,
    order_discount_vnd: orderDiscount,
    estimated_total_vnd: totals.total,
    erpnext_total_vnd: erpnextTotal,
    taxes_and_charges: taxTemplate,
    collected_vnd: 0,
    credit_vnd: totals.total,
    action_id: actionId,
    reference_no: commandId,
    docstatus: 0,
    company: resolvedCompany,
    transfer_state: isBank ? "pending" : null,
  };
  if (erpnextTotal !== null && erpnextTotal !== totals.total) {
    // Taxes/rounding are ERPNext's business: the SITE's number is the truth and
    // the difference is NAMED, never hidden.
    result.total_note = `ERPNext tính ${erpnextTotal}đ (thuế/làm tròn) — số tạm tính chỉ để hiển thị trước khi ghi`;
    result.credit_vnd = Math.max(0, erpnextTotal);
  }
  if (back && !Object.prototype.hasOwnProperty.call(back, field)) {
    result.correlation_field_missing = field;
  }

  // 6. The OPTIONAL advance collection — owner decision (A) + S1. A SEPARATE
  //    Payment Entry (1 method = 1 PE, §6.1), NO allocation rows: ERPNext
  //    refuses PE→draft-SI allocation ("must be submitted", audit §6), so the
  //    money parks as an advance for this party. The copy NEVER says the
  //    invoice was paid — "tiền đặt trước, chưa gạch nợ".
  if (method) {
    const channel = method.mode;
    const accounts = await resolveAdvanceAccounts(mcp, {
      direction: "receive",
      mode: method.mode,
      account: typeof method.account_id === "string" ? method.account_id : null,
      company: resolvedCompany,
    });
    const paid = Math.round(Number(method.amount));
    if (!Number.isInteger(paid) || paid <= 0) {
      throw refuse("INVALID_AMOUNT", `số tiền thu không hợp lệ (${method.amount}) — từ chối ghi phiếu thu`);
    }
    const peActionId = `act_${randomUUID()}`;
    const peData = buildPaymentEntryData({
      direction: "receive",
      partyId: customerId,
      paid,
      commandId: `${commandId}:advance`,
      actionId: peActionId,
      mode: accounts.mode,
      // The ADVANCE shape: an EMPTY reference list is the real "no allocation".
      references: [],
      unallocated: paid,
      company: accounts.company,
      paidFrom: accounts.paidFrom,
      paidTo: accounts.paidTo,
      postingDate: shopDay(),
    });
    const peRes = await mcp.callWriteTool("erpnext_doc_create", { doctype: "Payment Entry", data: peData });
    const peDoc = docOf(peRes);
    const peName = peDoc?.name ?? null;
    if (!peName) {
      throw refuse(
        "SALES_WRITE_UNVERIFIED",
        "hoá đơn đã ghi nhưng phiếu thu không trả về document name — đối soát thủ công trước khi thu lại",
        { sales_invoice: docName },
      );
    }
    assertReadOnly("erpnext_doc_get");
    const peBack = docOf(await mcp.callTool("erpnext_doc_get", { doctype: "Payment Entry", name: peName }));
    const peProblems = [];
    if (String(peBack.party ?? "") !== String(customerId)) peProblems.push(`party=${peBack.party}`);
    if (Math.round(Number(peBack.paid_amount) || 0) !== paid) peProblems.push(`paid_amount=${peBack.paid_amount}`);
    if (Math.round(Number(peBack.unallocated_amount) || 0) !== paid) {
      peProblems.push(`unallocated_amount=${peBack.unallocated_amount} (mong đợi ${paid} — KHÔNG được gạch vào hoá đơn nháp)`);
    }
    if (Array.isArray(peBack.references) ? peBack.references.length !== 0 : false) {
      peProblems.push(`references=${peBack.references.length} dòng (phải là 0 — tiền đặt trước)`);
    }
    if (Number(peBack.docstatus ?? 0) !== 0) peProblems.push(`docstatus=${peBack.docstatus}`);
    if (peProblems.length > 0) {
      throw refuse(
        "SALES_WRITE_UNVERIFIED",
        `đọc lại phiếu thu ${peName} thấy sai lệch: ${peProblems.join(", ")} — cần đối soát thủ công`,
        { doc: peBack, sales_invoice: docName },
      );
    }
    result.payment = {
      erpnext_doc: peName,
      paid_vnd: paid,
      mode_of_payment: accounts.mode,
      mode_requested: method.mode,
      paid_to: accounts.paidTo,
      unallocated_vnd: paid,
      reference_no: `${commandId}:advance`,
      action_id: peActionId,
      docstatus: 0,
      allocation_note: "không gạch nợ vào hoá đơn nháp (ERPNext chỉ nhận gạch vào hoá đơn đã submit)",
    };
    result.collected_vnd = paid;
    result.credit_vnd = Math.max(0, (erpnextTotal ?? totals.total) - paid);
    if (result.total_note === undefined && result.credit_vnd !== totals.total - paid) {
      result.total_note = `ERPNext tính tổng ${erpnextTotal}đ — công nợ tính trên số của ERPNext`;
    }
  }

  store.complete(commandId, result);
  return result;
}
