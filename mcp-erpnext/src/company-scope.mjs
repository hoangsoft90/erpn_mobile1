/**
 * Whose books is this deployment allowed to read — ONE rule, ONE home.
 *
 * Split out of `http-ask.mjs` (next8 / Phase 3 §5.4 row 7) because the collect
 * MONEY route needed the same resolution the sibling read route already used,
 * and a second copy of a trust boundary is how one route ends up honouring a
 * claim the other refuses. `http-ask` (reads) and `copilot-server` (the collect
 * proposal) both import from here now.
 */

import { assertReadOnly } from "./readonly-guard.mjs";
import { resolveCompanyScope } from "./authorization.mjs";

/**
 * The company this deployment reads, resolved SERVER-SIDE (plan4_final §4.1:
 * `scope.company` comes from the ERPNext session; the client never sets it).
 *
 * MEASURED on the real site (2026-09-21, read-only):
 *  - `Global Defaults` is a Single doc, so the LIST tool answers HTTP 500 —
 *    `erpnext_doc_get` is the only path that works (`default_company` =
 *    "Minh Phát Cám & VLXD").
 *  - `User.default_company` is HTTP 417 (not an allowed query field), so a
 *    per-user default cannot be read through this API. The site default is the
 *    honest answer; a deployment that wants another company pins its own.
 * Returns null when the site has no default — never a guessed first row, because
 * picking one of three companies' books is not a decision an error path may make.
 */
export async function readSessionCompany(mcp) {
  assertReadOnly("erpnext_doc_get");
  const res = await mcp.callTool("erpnext_doc_get", {
    doctype: "Global Defaults",
    name: "Global Defaults",
  });
  const doc = res?.data?.data ?? null;
  const name = typeof doc?.default_company === "string" ? doc.default_company.trim() : "";
  return name || null;
}

/**
 * Resolve the company a READ route is allowed to read, SERVER-SIDE (§4.1).
 *
 * Extracted so `/read/daily-summary` and `/read/drill` cannot drift apart: this
 * is a trust boundary (it decides whose books are shown), and a second copy is
 * how one route ends up honouring a claim the other refuses. The client's
 * `company` is never an input here — a caller-supplied value is only ever
 * CHECKED against the answer (see the routes).
 *
 * Order: a company already pinned by the contract (config / the account's own
 * entry) first; otherwise the ERPNext SESSION's default company, re-run through
 * the shared scope rule so an account may not be handed a company outside its
 * list. Multiple companies with no default is NOT resolved by picking a row —
 * that would be another tenant's books — it is a 503 that says what to
 * configure.
 *
 * @returns {Promise<{ok:true, company:string, source:string}|{ok:false, status:number, code:string, error:string}>}
 */
export async function resolveReadCompany({ mcp, principal, env, capabilityId, authorizedCompany }) {
  let company = authorizedCompany ?? null;
  let source = company ? "config" : null;
  if (!company) {
    const sessionCompany = await readSessionCompany(mcp);
    if (sessionCompany) {
      const scope = resolveCompanyScope(capabilityId, { principal, requested: sessionCompany, env });
      if (!scope.ok) return { ok: false, status: 403, code: scope.code, error: scope.error };
      company = scope.company ?? sessionCompany;
      source = "erpnext_session";
    }
  }
  if (!company) {
    return {
      ok: false,
      status: 503,
      code: "COMPANY_UNRESOLVED",
      error:
        "không xác định được company — đặt COPILOT_COMPANY (hoặc company trong " +
        "COPILOT_USERS), hoặc cấu hình Default Company trên ERPNext",
    };
  }
  return { ok: true, company, source };
}
