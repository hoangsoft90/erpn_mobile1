/**
 * Skill: money accounts (READ-ONLY) — the accounts a collection may receive into.
 *
 * Why this exists (next8 owner lock §6.2): the collect screen must offer "tiền
 * mặt" or "chuyển khoản" and let the user pick the account the money lands in. It
 * had NOTHING to offer: no route, no capability, no read — the only account logic
 * in the system lived inside the server-side payment builder. A screen without a
 * source would have to hardcode 1110, which is exactly the bug the lock names
 * ("Chuyển khoản" posting into the cash account).
 *
 * The rules, all of them §6.2's:
 *  - the account MUST belong to the resolved company (the site is multi-company);
 *  - ONLY leaves (`is_group = 0`) — a group node is not a place money can sit;
 *  - the type is the method's own type: Cash for cash, Bank for bank transfer;
 *  - a missing default is `null`, NEVER the other type's account, and a default
 *    the company declares is only honoured when it is genuinely one of that type's
 *    leaves.
 *
 * READ-only by construction: it lists what the site declares. It does not choose,
 * does not validate a submission, and cannot reach a write tool. The §6.2 BLOCK
 * (refusing a wrong-typed account at confirm time) is Phase 3.
 */

import { assertReadOnly, markUntrusted } from "../readonly-guard.mjs";

/** The two money channels a collection can use (lock §6.1). */
export const MONEY_ACCOUNT_TYPES = Object.freeze({ cash: "Cash", bank_transfer: "Bank" });

/** How many accounts one read may hold (a shop has tens, not thousands). */
export const MONEY_ACCOUNT_READ_LIMIT = 200;

/** Refusal codes this skill raises. */
export const ACCOUNT_READ_CODES = Object.freeze({
  COMPANY_REQUIRED: "COMPANY_REQUIRED",
});

function rowsOf(res) {
  return res?.data?.data ?? res?.data ?? [];
}

/**
 * Read the company's money accounts, grouped by account type.
 *
 * @param {object} mcp
 * @param {object} p
 * @param {string|null} p.company resolved company — REQUIRED. An unresolvable
 *   company is refused instead of listing every tenant's accounts (the same
 *   "no silent widening" rule the invoice read follows).
 * @returns {Promise<object|{ok:false, code:string}>} markUntrusted payload, or a
 *   refusal object when the company is not known
 */
export async function listMoneyAccounts(mcp, { company = null } = {}) {
  if (typeof company !== "string" || company.trim() === "") {
    return {
      ok: false,
      code: ACCOUNT_READ_CODES.COMPANY_REQUIRED,
      error: "chưa xác định được company để đọc danh sách tài khoản tiền",
    };
  }

  assertReadOnly("erpnext_account_list");
  const res = await mcp.callTool("erpnext_account_list", {
    company,
    root_type: "Asset",
    limit: MONEY_ACCOUNT_READ_LIMIT,
  });
  const leaves = rowsOf(res).filter((a) => !a?.is_group);

  const pick = (type) =>
    leaves
      .filter((a) => String(a?.account_type ?? "") === type)
      .map((a) => ({
        account: String(a?.name ?? ""),
        label: String(a?.account_name ?? a?.name ?? ""),
        account_type: type,
        company: String(a?.company ?? company),
      }));

  const cash = pick(MONEY_ACCOUNT_TYPES.cash);
  const bank = pick(MONEY_ACCOUNT_TYPES.bank_transfer);

  // The company's own defaults, read from the site (Phase 0 §2.6: this site
  // declares all four). Unreadable ⇒ nulls; a default is only honoured when it is
  // genuinely one of that type's leaves, so a mis-configured default can never
  // hand the cash account to a bank transfer.
  let defaults = { cash: null, bank: null };
  try {
    assertReadOnly("erpnext_doc_get");
    const companyRes = await mcp.callTool("erpnext_doc_get", { doctype: "Company", name: company });
    const doc = companyRes?.data?.data ?? companyRes?.data ?? null;
    const asIn = (declared, rows) =>
      typeof declared === "string" && rows.some((r) => r.account === declared) ? declared : null;
    defaults = {
      cash: asIn(doc?.default_cash_account, cash),
      bank: asIn(doc?.default_bank_account, bank),
    };
  } catch {
    defaults = { cash: null, bank: null };
  }

  return markUntrusted("erpnext:erpnext_account_list", {
    company,
    cash,
    bank,
    defaults,
    // Which types actually resolved. The screen needs this to block a method it
    // cannot honour ("chuyển khoản" with no bank account) instead of quietly
    // using whatever account type it did find.
    resolved: { Cash: cash.length > 0, Bank: bank.length > 0 },
  });
}
