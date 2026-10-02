/**
 * Skill: purchase INVOICE WRITE (Phase 7 — Purchase vertical, plan1_final_v2 §14
 * + phase-07).
 *
 * The shop's own purchase: a SUPPLIER, a warehouse, SEVERAL item lines
 * (qty/uom/unit price) and — optionally — paying right away. The mirror of
 * `sales-write.mjs`, with the money direction flipped to PAY.
 *
 * Everything number-shaped is the server's:
 *  - line prices come from ERPNext (`Item Price`, BUYING side, price list from
 *    the supplier's own default else the SINGLE `Buying Settings.buying_price_list`)
 *    — a line the site has no buying price for is a QUESTION, never a zero;
 *  - the document is a DRAFT **Purchase Invoice** (`docstatus 0`), created ONLY
 *    through the Safety Gateway's `/execute`. PI carries `update_stock = 1`
 *    (measured: the site's own PIs receive stock on submit), so one draft PI is
 *    both the payable and the goods receipt;
 *  - `credit = purchase_total − actual_paid` is a BALANCE, never a payment
 *    method (plan §14): there is NO `credit` channel below;
 *  - NO discount fields: plan §14's PurchaseTransactionDraft has none, and the
 *    site's PIs carry none. `rate = price_list_rate = the buying price`.
 *  - money paid at purchase time goes out as a SEPARATE **advance** Payment
 *    Entry for the same supplier (owner decision 2026-10-01, mode (b)): ERPNext
 *    refuses PE→DRAFT-invoice allocation (the same rule measured for Sales
 *    Invoice in Phase 6), so the payment carries NO reference row and the copy
 *    must never claim the invoice was paid.
 *
 * CẤM: partial allocation by supplier invoice (plan §14 / phase-07 §3) — there
 * is deliberately NO allocation code path here. Direction/party_type come from
 * the capability (`payment.create`'s Pay spec), never from a name.
 *
 * Reuse discipline: `priceForLine` is the same resolver the order/app paths use;
 * company resolution is `resolveSalesCompany` (a generic Company resolver);
 * account resolution is `resolveAdvanceAccounts`/`channelOfMode`/`shopDay` from
 * `payment-write.mjs`; the PE payload builder is `buildPaymentEntryData`.
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
export const WRITE_DOCTYPE = "Purchase Invoice";

/** The capability that owns this skill — policy is read THROUGH the contract. */
export const CAPABILITY_ID = "purchase_invoice.create";

/** `act_<uuid>` — a unique id for one logical action. */
export function newActionId() {
  return `act_${randomUUID()}`;
}

/** Contract policy block, read once per call (a missing block is a hard bug). */
function policy() {
  const cap = getCapability(CAPABILITY_ID);
  if (!cap) throw new Error("PURCHASE_CONTRACT_MISSING: purchase_invoice.create is not in the capability contract");
  return cap;
}

/**
 * The shop's purchase arithmetic — PURE (no I/O). plan §14 has no discount, so
 * `purchase_total` is simply Σ(qty × unit_price); the payable left over is
 * `purchase_total − actual_paid` (a BALANCE, computed by the caller).
 *
 * @param {Array<{qty:number, unit_price:number}>} items
 */
export function computePurchaseTotals(items) {
  const subtotal = items.reduce((sum, it) => sum + Math.round(Number(it.qty) * Number(it.unit_price)), 0);
  return { subtotal, total: subtotal };
}

/**
 * Which price list governs this purchase. ONE order (measured 2026-10-01): the
 * supplier's own default, else `Buying Settings.buying_price_list` (a SINGLE).
 * Neither read may invent a list.
 *
 * @returns {Promise<string|null>}
 */
export async function resolveBuyingPriceList(mcp, supplier) {
  if (supplier?.default_price_list) return String(supplier.default_price_list);
  try {
    assertReadOnly("erpnext_doc_get");
    const doc = docOf(
      await mcp.callTool("erpnext_doc_get", { doctype: "Buying Settings", name: "Buying Settings" }),
    );
    const fromSingle = typeof doc?.buying_price_list === "string" ? doc.buying_price_list.trim() : "";
    if (fromSingle) return fromSingle;
  } catch {
    // A site that does not expose the Single read falls through to the list shape.
  }
  try {
    assertReadOnly("erpnext_doc_list");
    const res = await mcp.callTool("erpnext_doc_list", {
      doctype: "Buying Settings",
      fields: ["name", "buying_price_list"],
      limit: 1,
    });
    return String(rowsOf(res)[0]?.buying_price_list ?? "") || null;
  } catch {
    return null; // unreadable settings ⇒ the caller's price check will ask
  }
}

/**
 * The BUYING Item Price rows for ONE line's item. `buying = 1` is the BUYING-side
 * guard (mirror of the sales path): the site keeps both sides on the same table
 * (CAM-HEO-25KG: 295.000 Standard Buying vs 320.000 Standard Selling), and
 * `priceForLine` falls back to `pool[0]` when no price list matches — so without
 * this filter a purchase could be priced at the shop's SELLING price. Values are
 * STRINGS (the repo's filter-literal tripwire).
 */
async function itemPriceRows(mcp, itemCode) {
  assertReadOnly("erpnext_doc_list");
  const res = await mcp.callTool("erpnext_doc_list", {
    doctype: "Item Price",
    fields: ["name", "item_code", "price_list", "price_list_rate", "uom", "buying"],
    filters: [["item_code", "=", String(itemCode)], ["buying", "=", "1"]],
    limit: 200,
  });
  return rowsOf(res);
}

/**
 * Current stock of one item in one warehouse — a WARNING input only (phase-07
 * §4.4). A missing Bin row is still a warning, never a block.
 */
export async function stockFor(mcp, itemCode, warehouse) {
  assertReadOnly("erpnext_stock_balance");
  const res = await mcp.callTool("erpnext_stock_balance", { item_code: String(itemCode), warehouse: String(warehouse) });
  const row = rowsOf(res)[0];
  return row ? Math.round(Number(row.actual_qty) || 0) : null;
}

/**
 * Stage A — build the purchase proposal from the SCREEN's draft.
 *
 * @param {object} mcp MCP client (mock or real); every read is guarded
 * @param {object} args
 * @param {object} args.supplier the RESOLVED supplier row
 * @param {string|null} [args.warehouse]
 * @param {Array<{item_id:string,uom:string,qty:number}>} args.items  unit_price is NOT taken from here
 * @param {Array<{mode:string, amount:number, account_id?:string|null}>} [args.paymentMethods] ≤ 1 (§6.1)
 * @param {string|null} [args.company]
 * @param {string|null} [args.handoffId]
 */
export async function buildPurchaseProposal(
  mcp,
  { supplier, warehouse = null, items = [], paymentMethods = null, company = null, handoffId = null },
) {
  if (!supplier?.name) {
    throw refuse("PURCHASE_SUPPLIER_UNRESOLVED", "chưa chọn nhà cung cấp — không lập được phiếu nhập");
  }
  const maxLines = Number(policy().line_policy?.max_lines ?? 20);
  const list = Array.isArray(items) ? items : [];
  if (list.length === 0) {
    throw refuse("PURCHASE_ITEM_UNRESOLVED", "phiếu nhập chưa có dòng hàng nào — thêm mặt hàng trước khi lập");
  }
  if (list.length > maxLines) {
    throw refuse("PURCHASE_LINE_LIMIT", `phiếu nhập có ${list.length} dòng, vượt giới hạn ${maxLines} dòng — tách thành nhiều phiếu`);
  }

  let methods = [];
  if (paymentMethods !== null && paymentMethods !== undefined) {
    const validated = validatePaymentMethods(paymentMethods);
    if (!validated.ok) throw refuse(validated.code, validated.reason);
    methods = validated.methods;
  }

  const resolvedCompany = await resolveSalesCompany(mcp, {
    authzCompany: company,
    code: "PURCHASE_COMPANY_UNRESOLVED",
    noun: "phiếu nhập",
  });

  // §6.2 at PROPOSE time — an account the user named must EXIST, belong to the
  // company and carry the channel's `account_type` (never a substitution).
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
      methods = [{ ...methods[0], account_id: declared }];
    }
  }

  const priceList = await resolveBuyingPriceList(mcp, supplier);
  const uomRows = await mcp.callTool("erpnext_doc_list", { doctype: "UOM", fields: ["name"], limit: 0 });
  const uomNames = new Set(rowsOf(uomRows).map((r) => String(r.name)));
  const warnings = [];
  const lines = [];
  for (const raw of list) {
    const itemCode = String(raw?.item_id ?? "").trim();
    if (!itemCode) throw refuse("PURCHASE_ITEM_UNRESOLVED", "một dòng hàng thiếu mã mặt hàng — chọn lại mặt hàng");
    const qty = Number(raw?.qty);
    if (!Number.isFinite(qty) || qty <= 0) {
      throw refuse("PURCHASE_QTY_INVALID", `số lượng của ${itemCode} phải là số dương (đang ${JSON.stringify(raw?.qty)})`);
    }
    const uom = String(raw?.uom ?? "").trim();
    if (!uom || !uomNames.has(uom)) {
      throw refuse(
        "PURCHASE_UOM_UNRESOLVED",
        `đơn vị "${uom || "(trống)"}" của ${itemCode} không có trên ERPNext — chọn lại đơn vị của dòng`,
      );
    }
    const priceRows = await itemPriceRows(mcp, itemCode);
    const price = priceForLine(priceRows, { itemCode, uom, priceList });
    if (!price) {
      throw refuse(
        "PURCHASE_PRICE_MISSING",
        `ERPNext chưa có giá MUA cho ${itemCode} theo đơn vị ${uom} (bảng giá ${priceList ?? "?"}) — không tự đặt giá, hãy khai giá trong ERPNext`,
      );
    }
    const unitPrice = Math.round(price.rate);
    lines.push({
      item_code: itemCode,
      uom,
      qty,
      unit_price: unitPrice,
      line_net: Math.round(qty * unitPrice),
      price_list: price.price_list,
    });
  }

  const totals = computePurchaseTotals(lines);
  const paidVnd = methods.reduce((sum, m) => sum + m.amount, 0);
  // The payable remainder is a NUMBER (plan §14): purchase_total − actual_paid.
  const credit = totals.total - paidVnd;
  if (credit < 0) {
    throw refuse(
      "PURCHASE_OVERPAID",
      `tiền trả (${paidVnd}) vượt tổng phiếu nhập (${totals.total}) — trả đúng phần còn lại hoặc tách lần trả`,
    );
  }
  if (methods.length > 0 && methods[0].amount > totals.total) {
    throw refuse("PURCHASE_OVERPAID", `lần trả đầu tiên (${methods[0].amount}) vượt tổng phiếu nhập (${totals.total})`);
  }

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
      // For a purchase the stock warning is informational (nhập vào thì TĂNG tồn).
      if (qtyOnHand !== null && qtyOnHand <= 0) {
        warnings.push(`tồn ${line.item_code} tại ${warehouseUsed} hiện ${qtyOnHand} — phiếu nhập NHÁP chưa cộng kho, kiểm tra trước khi nhập`);
      }
    }
  }

  const actionId = newActionId();
  const partyName = supplier.supplier_name ?? supplier.name;
  const proposal = buildProposal({
    action: "create_purchase_invoice_draft",
    risk: "HIGH",
    entity: { kind: "supplier", id: supplier.name, name: partyName },
    params: {
      warehouse: warehouseUsed,
      items: lines.map((l) => ({ item_id: l.item_code, uom: l.uom, qty: l.qty, unit_price: l.unit_price })),
      subtotal_vnd: totals.subtotal,
      estimated_total_vnd: totals.total,
      credit_vnd: credit,
      payment_methods: methods.map((m) => ({ mode: m.mode, amount: m.amount, account_id: m.account_id ?? null })),
      paid_vnd: paidVnd,
      submit_now: false,
      posting_date: shopDay(),
    },
    summary:
      `Tạo phiếu nhập NHÁP từ ${partyName}: ${lines.map((l) => `${l.qty} ${l.uom} ${l.item_code}`).join(" + ")}` +
      ` — tổng tạm tính ${totals.total}đ` +
      (paidVnd > 0 ? `, trả ngay ${paidVnd}đ, còn nợ NCC ${credit}đ` : ", chưa trả tiền (ghi công nợ)"),
    extra: {
      warnings,
      action_id: actionId,
      handoff_id: handoffId,
      schema_note:
        "params.items/unit_price là ĐỀ XUẤT — execute đọc lại giá MUA từ ERPNext, lệch thì TỪ CHỐI (không tự re-price)",
    },
  });

  return { proposal, lines, totals, warnings, action_id: actionId, company: resolvedCompany, price_list: priceList };
}

/**
 * The REAL Purchase Invoice payload (pure).
 *
 * Field mapping is the site audit's (`.plan/next8/phase7-audit.md` §2): the site's
 * own PIs carry `credit_to = 2110`, `update_stock = 1`, `set_warehouse`, and item
 * rows with `price_list_rate` + `rate` + `warehouse` + `expense_account`
 * (`1410 - Hàng tồn kho`) + `cost_center`. `rate = price_list_rate` (no discount
 * in plan §14).
 */
export function buildPurchaseInvoiceData({
  supplierId,
  lines,
  company,
  warehouse,
  creditTo,
  inventoryAccount,
  costCenter,
  postingDate,
  actionId,
  correlationField = "custom_ai_action_id",
}) {
  return {
    doctype: WRITE_DOCTYPE,
    supplier: supplierId,
    company,
    posting_date: postingDate,
    set_warehouse: warehouse ?? undefined,
    // The company's own payable default (audit §2/§3) — never client input.
    credit_to: creditTo,
    cost_center: costCenter ?? undefined,
    update_stock: 1,
    [correlationField]: actionId ?? null,
    remarks: "ERPNext Voice Copilot · xác nhận bởi người dùng · phiếu nhập NHÁP, chưa submit",
    items: lines.map((l) => ({
      item_code: l.item_code,
      uom: l.uom,
      qty: l.qty,
      price_list_rate: l.unit_price,
      rate: l.unit_price,
      warehouse: warehouse ?? undefined,
      expense_account: inventoryAccount ?? undefined,
      cost_center: costCenter ?? undefined,
    })),
  };
}

/**
 * Reconcile an interrupted attempt against ERPNext — READ ONLY, by ACTION ID
 * (never by name: F-P5-4 reuses document names after deletion).
 */
export async function reconcilePurchaseDraft(mcp, reference, { actionId = null } = {}) {
  assertReadOnly("erpnext_doc_list");
  const value = actionId ?? reference;
  try {
    const res = await mcp.callTool("erpnext_doc_list", {
      doctype: WRITE_DOCTYPE,
      fields: ["name", "docstatus", "supplier", "grand_total", "custom_ai_action_id"],
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
 * Stage B — execute a CONFIRMED purchase proposal (behind the Safety Gateway).
 *
 * One command writes at most ONE Purchase Invoice draft; when the proposal
 * carries a payment method, the SAME command ALSO writes ONE advance Payment
 * Entry for the same supplier (owner decision (b), 2026-10-01): Pay direction,
 * money out of the cash/bank account, payable parked on the company's 2110, NO
 * reference row — the copy never claims the invoice was settled, and there is
 * deliberately NO allocation path (plan §14).
 */
export async function executePurchaseProposal(mcp, proposal, commandId, store, { company = null } = {}) {
  const supplierId = proposal.entity?.id;
  const wantItems = Array.isArray(proposal.params?.items) ? proposal.params.items : [];
  if (!supplierId) throw refuse("PURCHASE_SUPPLIER_UNRESOLVED", "đề xuất không có nhà cung cấp — không ghi phiếu nhập");
  if (wantItems.length === 0) throw refuse("PURCHASE_ITEM_UNRESOLVED", "đề xuất không có dòng hàng nào — không ghi phiếu nhập");

  const field = "custom_ai_action_id";
  const actionId = proposal.action_id ?? null;

  // 1. Once-only (server half).
  assertReadOnly("erpnext_doc_list");
  const probe = await mcp.callTool("erpnext_doc_list", {
    doctype: WRITE_DOCTYPE,
    fields: ["name", "docstatus", "supplier", field],
    filters: [[field, "=", String(actionId ?? commandId)]],
    limit: 5,
  });
  const existing = rowsOf(probe);
  if (existing.length > 0) {
    throw refuse(
      "PURCHASE_DUPLICATE_ACTION",
      `phiếu nhập ${existing[0].name} đã tồn tại trên ERPNext với action id này — KHÔNG ghi lần nữa, kiểm tra ERPNext trước`,
      { existing_doc: existing[0].name },
    );
  }

  const resolvedCompany = await resolveSalesCompany(mcp, {
    authzCompany: company ?? proposal.params?.company ?? null,
    code: "PURCHASE_COMPANY_UNRESOLVED",
    noun: "phiếu nhập",
  });

  // 2. RE-READ every price (BUYING side) — drift ⇒ PROPOSAL_STALE.
  const priceList = await resolveBuyingPriceList(mcp, { default_price_list: null });
  const lines = [];
  for (const want of wantItems) {
    const itemCode = String(want?.item_id ?? "").trim();
    const uom = String(want?.uom ?? "").trim();
    const priceRows = await itemPriceRows(mcp, itemCode);
    const price = priceForLine(priceRows, { itemCode, uom, priceList });
    if (!price) {
      throw refuse(
        "PROPOSAL_STALE",
        `${itemCode}: giá MUA cho ${uom} không còn trong ERPNext — KHÔNG ghi, hãy lập lại`,
        { drift_code: "PROPOSAL_VERSION_STALE" },
      );
    }
    const rate = Math.round(price.rate);
    if (Number(want?.unit_price) !== rate) {
      throw refuse(
        "PROPOSAL_STALE",
        `${itemCode}: giá MUA đổi ${want.unit_price} → ${rate} — KHÔNG ghi, hãy xác nhận lại trên số mới`,
        { drift_code: "PROPOSAL_VERSION_STALE" },
      );
    }
    lines.push({ item_code: itemCode, uom, qty: Number(want.qty), unit_price: rate });
  }

  // 3. The company's own account defaults (audit §2) — never client input.
  assertReadOnly("erpnext_doc_get");
  const companyDoc = docOf(await mcp.callTool("erpnext_doc_get", { doctype: "Company", name: resolvedCompany }));
  const creditTo = companyDoc?.default_payable_account ?? null;
  const inventoryAccount = companyDoc?.default_inventory_account ?? null;
  const costCenter = companyDoc?.cost_center ?? null;
  if (!creditTo) {
    throw refuse(
      "PURCHASE_ACCOUNT_UNRESOLVED",
      `Company ${resolvedCompany} chưa khai default_payable_account — không biết ghi công nợ NCC vào đâu, TỪ CHỐI`,
    );
  }

  const warehouse = proposal.params?.warehouse ?? process.env.COPILOT_DEFAULT_WAREHOUSE ?? null;
  const methods = Array.isArray(proposal.params?.payment_methods) ? proposal.params.payment_methods : [];
  if (methods.length > MAX_METHODS_PER_TRANSACTION) {
    // §6.1 — re-checked HERE (execute takes the proposal from the body).
    throw refuse(
      "PAYMENT_METHOD_COUNT_INVALID",
      `một lần trả chỉ một hình thức thanh toán — nhận ${methods.length}, từ chối ghi`,
    );
  }
  const method = methods[0] ?? null;

  const totals = computePurchaseTotals(lines);
  if (Number.isFinite(Number(proposal.params?.estimated_total_vnd)) &&
      Math.round(Number(proposal.params.estimated_total_vnd)) !== totals.total) {
    throw refuse(
      "PROPOSAL_STALE",
      `tổng đề xuất (${proposal.params.estimated_total_vnd}) ≠ tổng tính lại trên giá hiện tại (${totals.total}) — KHÔNG ghi, hãy xác nhận lại`,
      { drift_code: "PROPOSAL_VERSION_STALE" },
    );
  }

  store.setReference(commandId, commandId);
  if (typeof mcp.callWriteTool !== "function") {
    throw refuse("EXECUTE_CLIENT_UNSUPPORTED", "this MCP client has no write method");
  }

  const data = buildPurchaseInvoiceData({
    supplierId,
    lines,
    company: resolvedCompany,
    warehouse,
    creditTo,
    inventoryAccount,
    costCenter,
    postingDate: shopDay(),
    actionId,
  });
  const res = await mcp.callWriteTool("erpnext_doc_create", { doctype: WRITE_DOCTYPE, data });
  const doc = docOf(res);
  const docName = doc?.name ?? null;
  if (!docName) {
    throw refuse("PURCHASE_WRITE_UNVERIFIED", "ERPNext không trả về document name — coi như chưa ghi xong, cần đối soát");
  }

  // 5. VERIFY by reading back — the write response is not evidence.
  assertReadOnly("erpnext_doc_get");
  const back = docOf(await mcp.callTool("erpnext_doc_get", { doctype: WRITE_DOCTYPE, name: docName }));
  const problems = [];
  if (String(back.supplier ?? "") !== String(supplierId)) problems.push(`supplier=${back.supplier}`);
  if (Number(back.docstatus) !== 0) problems.push(`docstatus=${back.docstatus} (phiếu nhập phải là NHÁP)`);
  if (Number(back.update_stock ?? 0) !== 1) problems.push(`update_stock=${back.update_stock} (phải là 1)`);
  if (String(back.credit_to ?? "") !== String(creditTo)) problems.push(`credit_to=${back.credit_to} (mong đợi ${creditTo})`);
  if (Array.isArray(back.items) ? back.items.length !== lines.length : true) {
    problems.push(`số dòng=${Array.isArray(back.items) ? back.items.length : 0} (mong đợi ${lines.length})`);
  }
  const backLines = Array.isArray(back.items) ? back.items : [];
  for (const want of lines) {
    const got = backLines.find((g) => String(g.item_code) === String(want.item_code));
    if (!got) {
      problems.push(`thiếu dòng ${want.item_code}`);
      continue;
    }
    if (Math.abs(Number(got.qty) - want.qty) > 1e-9) problems.push(`${want.item_code}: qty=${got.qty}`);
    if (Math.abs(Number(got.price_list_rate ?? 0) - want.unit_price) > 1) {
      problems.push(`${want.item_code}: price_list_rate=${got.price_list_rate} (mong đợi ${want.unit_price})`);
    }
    if (Math.abs(Number(got.rate) - want.unit_price) > 1) {
      problems.push(`${want.item_code}: rate=${got.rate} (mong đợi ${want.unit_price})`);
    }
  }
  if (problems.length > 0) {
    throw refuse(
      "PURCHASE_WRITE_UNVERIFIED",
      `đọc lại phiếu nhập ${docName} thấy sai lệch: ${problems.join(", ")} — cần đối soát thủ công`,
      { doc: back },
    );
  }

  const erpnextTotal = Number.isFinite(Number(back.grand_total)) ? Math.round(Number(back.grand_total)) : null;
  const result = {
    erpnext_doc: docName,
    supplier: supplierId,
    supplier_name: proposal.entity?.name ?? null,
    warehouse,
    lines: backLines.map((l) => ({
      item_code: l.item_code,
      item_name: l.item_name ?? l.item_code,
      qty: Number(l.qty),
      uom: l.uom,
      rate: Number(l.rate),
      price_list_rate: Number(l.price_list_rate ?? l.rate),
    })),
    line_count: backLines.length,
    subtotal_vnd: totals.subtotal,
    estimated_total_vnd: totals.total,
    erpnext_total_vnd: erpnextTotal,
    paid_vnd: 0,
    credit_vnd: totals.total,
    action_id: actionId,
    reference_no: commandId,
    docstatus: 0,
    company: resolvedCompany,
    direction: "pay",
  };
  if (erpnextTotal !== null && erpnextTotal !== totals.total) {
    result.total_note = `ERPNext tính ${erpnextTotal}đ (thuế/làm tròn) — số tạm tính chỉ để hiển thị trước khi ghi`;
    result.credit_vnd = Math.max(0, erpnextTotal);
  }
  if (back && !Object.prototype.hasOwnProperty.call(back, field)) {
    result.correlation_field_missing = field;
  }

  // 6. The OPTIONAL advance payment — owner decision (b). direction "pay":
  //    paid_from = the shop's cash/bank account, paid_to = 2110 (payable). NO
  //    reference row: ERPNext refuses PE→draft allocation, and partial
  //    allocation by supplier invoice is out of scope (plan §14).
  if (method) {
    const accounts = await resolveAdvanceAccounts(mcp, {
      direction: "pay",
      mode: method.mode,
      account: typeof method.account_id === "string" ? method.account_id : null,
      company: resolvedCompany,
    });
    const paid = Math.round(Number(method.amount));
    if (!Number.isInteger(paid) || paid <= 0) {
      throw refuse("INVALID_AMOUNT", `số tiền trả không hợp lệ (${method.amount}) — từ chối ghi phiếu chi`);
    }
    const peActionId = `act_${randomUUID()}`;
    const peData = buildPaymentEntryData({
      direction: "pay",
      partyId: supplierId,
      paid,
      commandId: `${commandId}:advance`,
      actionId: peActionId,
      mode: accounts.mode,
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
        "PURCHASE_WRITE_UNVERIFIED",
        "phiếu nhập đã ghi nhưng phiếu chi không trả về document name — đối soát thủ công trước khi trả lại",
        { purchase_invoice: docName },
      );
    }
    assertReadOnly("erpnext_doc_get");
    const peBack = docOf(await mcp.callTool("erpnext_doc_get", { doctype: "Payment Entry", name: peName }));
    const peProblems = [];
    if (String(peBack.payment_type ?? "") !== "Pay") peProblems.push(`payment_type=${peBack.payment_type} (phải là Pay)`);
    if (String(peBack.party_type ?? "") !== "Supplier") peProblems.push(`party_type=${peBack.party_type} (phải là Supplier)`);
    if (String(peBack.party ?? "") !== String(supplierId)) peProblems.push(`party=${peBack.party}`);
    if (String(peBack.paid_to ?? "") !== String(accounts.paidTo)) peProblems.push(`paid_to=${peBack.paid_to} (mong đợi ${accounts.paidTo})`);
    if (Math.round(Number(peBack.paid_amount) || 0) !== paid) peProblems.push(`paid_amount=${peBack.paid_amount}`);
    if (Math.round(Number(peBack.unallocated_amount) || 0) !== paid) {
      peProblems.push(`unallocated_amount=${peBack.unallocated_amount} (mong đợi ${paid} — KHÔNG được gạch vào phiếu nháp)`);
    }
    if (Array.isArray(peBack.references) ? peBack.references.length !== 0 : false) {
      peProblems.push(`references=${peBack.references.length} dòng (phải là 0 — trả trước)`);
    }
    if (Number(peBack.docstatus ?? 0) !== 0) peProblems.push(`docstatus=${peBack.docstatus}`);
    if (peProblems.length > 0) {
      throw refuse(
        "PURCHASE_WRITE_UNVERIFIED",
        `đọc lại phiếu chi ${peName} thấy sai lệch: ${peProblems.join(", ")} — cần đối soát thủ công`,
        { doc: peBack, purchase_invoice: docName },
      );
    }
    result.payment = {
      erpnext_doc: peName,
      paid_vnd: paid,
      mode_of_payment: accounts.mode,
      mode_requested: method.mode,
      paid_from: accounts.paidFrom,
      paid_to: accounts.paidTo,
      unallocated_vnd: paid,
      reference_no: `${commandId}:advance`,
      action_id: peActionId,
      docstatus: 0,
      direction: "pay",
      allocation_note: "không gạch nợ vào phiếu nhập nháp (ERPNext chỉ nhận gạch vào chứng từ đã submit)",
    };
    result.paid_vnd = paid;
    result.credit_vnd = Math.max(0, (erpnextTotal ?? totals.total) - paid);
    if (result.total_note === undefined && result.credit_vnd !== totals.total - paid) {
      result.total_note = `ERPNext tính tổng ${erpnextTotal}đ — công nợ tính trên số của ERPNext`;
    }
  }

  store.complete(commandId, result);
  return result;
}
