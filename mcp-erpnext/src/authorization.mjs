/**
 * P8 — Authorization Boundary (plan2_final §5, §24.2, §19 P8).
 *
 * Authorization is a SERVER-SIDE layer, separate from the model: an LLM that
 * understands a sentence perfectly still cannot widen what the account may do.
 * The contract declares, per capability:
 *
 *   authorization: { permissions: ["Accounts User"], scope: { company: "required" } }
 *
 * ...and this module is the only place that turns that into a yes/no. Nothing
 * here reads a prompt. Nothing here writes to ERPNext.
 *
 * TWO MODES
 *
 *  - `multi_user` — `COPILOT_USERS` is set (JSON). Every principal is declared
 *    explicitly; nothing is implicit. A capability whose contract requires a
 *    permission the principal does not hold is refused with
 *    `AUTHORIZATION_DENIED`, and a company outside the principal's allow-list is
 *    refused too. This is the mode production should run in.
 *
 *  - `single_tenant` (default, `COPILOT_USERS` unset) — one operator: the
 *    authenticated user, else `local`. Their permissions come from
 *    `COPILOT_DEFAULT_PERMISSIONS`. When that variable is ABSENT they hold
 *    exactly the permissions the contract declares for non-forbidden
 *    capabilities — that is today's behaviour, kept so a running single-operator
 *    deployment is not broken by this phase, and logged once. Set the variable
 *    to narrow it, or to the empty string (`COPILOT_DEFAULT_PERMISSIONS=`) to
 *    require every permission to be granted explicitly.
 *
 * The check itself always runs in BOTH modes — a capability that requires a
 * permission the principal lacks is refused even in single-tenant mode when the
 * operator has narrowed the grant.
 */

import { getCapability, isForbidden, listCapabilities } from "./capability-contract.mjs";

export const AUTHZ_MODES = Object.freeze({
  MULTI_USER: "multi_user",
  SINGLE_TENANT: "single_tenant",
});

/** Refusal codes. AUTHORIZATION_DENIED already has Vietnamese copy in P2. */
export const AUTHZ_CODES = Object.freeze({
  DENIED: "AUTHORIZATION_DENIED",
  COMPANY_REQUIRED: "COMPANY_SCOPE_REQUIRED",
  CONFIG_INVALID: "AUTHORIZATION_CONFIG_INVALID",
});

/**
 * Permissions and company names contain spaces ("Accounts User"), so the
 * separator is a COMMA only — never whitespace.
 */
function splitList(raw) {
  if (typeof raw !== "string") return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function asStringList(value, field, user) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw Object.assign(
      new Error(`COPILOT_USERS["${user}"].${field} phải là mảng chuỗi`),
      { code: AUTHZ_CODES.CONFIG_INVALID },
    );
  }
  return value.map((v) => String(v).trim()).filter(Boolean);
}

/**
 * Parse `COPILOT_USERS`. Returns null when unset/empty (⇒ single-tenant mode).
 *
 *   COPILOT_USERS='{"op":{"permissions":["Accounts User"],"company":"Công ty A"}}'
 *
 * A malformed value THROWS rather than silently falling back to single-tenant:
 * a typo that quietly restores "everyone is allowed" is exactly the failure this
 * phase exists to prevent.
 *
 * @returns {Map<string, {permissions: string[], companies: string[], company: string|null}>|null}
 */
export function parseUsers(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === "") return null;

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw Object.assign(
      new Error(`COPILOT_USERS không phải JSON hợp lệ: ${err.message}`),
      { code: AUTHZ_CODES.CONFIG_INVALID },
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw Object.assign(
      new Error("COPILOT_USERS phải là object JSON: {\"<username>\": {...}}"),
      { code: AUTHZ_CODES.CONFIG_INVALID },
    );
  }

  const users = new Map();
  for (const [user, cfg] of Object.entries(parsed)) {
    const id = String(user).trim();
    if (!id) continue;
    if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) {
      throw Object.assign(
        new Error(`COPILOT_USERS["${id}"] phải là object`),
        { code: AUTHZ_CODES.CONFIG_INVALID },
      );
    }
    const company = typeof cfg.company === "string" && cfg.company.trim()
      ? cfg.company.trim()
      : null;
    const companies = asStringList(cfg.companies, "companies", id);
    users.set(id, {
      permissions: asStringList(cfg.permissions, "permissions", id),
      companies: companies.length ? companies : (company ? [company] : []),
      company,
    });
  }
  return users;
}

/**
 * Union of the permissions the contract declares for capabilities the AI path
 * may actually run. Used ONLY as the single-tenant implicit grant; forbidden
 * capabilities (document.delete) are excluded so their permissions are never
 * handed out by default.
 * @returns {string[]}
 */
export function contractDeclaredPermissions() {
  const out = new Set();
  for (const id of listCapabilities()) {
    if (isForbidden(id)) continue;
    for (const p of getCapability(id)?.authorization?.permissions ?? []) out.add(p);
  }
  return [...out];
}

/**
 * Resolve the principal behind a request.
 *
 * @param {object} args
 * @param {string} [args.user] authenticated user at the HTTP edge (else "local")
 * @param {object} [args.env]
 * @returns {{user_id:string, permissions:string[], companies:string[], company:string|null,
 *            mode:string, known:boolean, implicit_permissions:boolean}}
 */
export function resolvePrincipal({ user, env = process.env } = {}) {
  const userId = typeof user === "string" && user.trim() ? user.trim() : "local";

  const users = parseUsers(env?.COPILOT_USERS);
  if (users) {
    const cfg = users.get(userId);
    // An UNKNOWN user is not an error the app should crash on — they simply
    // hold nothing. READ capabilities declare no permissions, so a typo in the
    // username degrades to read-only instead of locking the shop out entirely.
    return {
      user_id: userId,
      permissions: cfg?.permissions ?? [],
      companies: cfg?.companies ?? [],
      company: cfg?.company ?? null,
      mode: AUTHZ_MODES.MULTI_USER,
      known: Boolean(cfg),
      implicit_permissions: false,
    };
  }

  const declared = env?.COPILOT_DEFAULT_PERMISSIONS;
  const implicit = declared === undefined || declared === null;
  return {
    user_id: userId,
    permissions: implicit ? contractDeclaredPermissions() : splitList(declared),
    companies: [],
    company: typeof env?.COPILOT_COMPANY === "string" && env.COPILOT_COMPANY.trim()
      ? env.COPILOT_COMPANY.trim()
      : null,
    mode: AUTHZ_MODES.SINGLE_TENANT,
    known: true,
    implicit_permissions: implicit,
  };
}

/**
 * Contract-driven permission check.
 * @returns {{ok:true} | {ok:false, code:string, error:string}}
 */
export function checkPermissions(capabilityId, principal) {
  const required = getCapability(capabilityId)?.authorization?.permissions ?? [];
  if (required.length === 0) return { ok: true };

  const held = new Set(principal?.permissions ?? []);
  const missing = required.filter((p) => !held.has(p));
  if (missing.length === 0) return { ok: true };

  return {
    ok: false,
    code: AUTHZ_CODES.DENIED,
    error:
      `tài khoản "${principal?.user_id ?? "?"}" không có quyền cho "${capabilityId}"` +
      ` (thiếu: ${missing.join(", ")}) — không thực hiện thao tác`,
  };
}

/**
 * Contract-driven company scope.
 *
 * Precedence is deliberately SERVER-FIRST: principal profile, then
 * `COPILOT_COMPANY`, and only then a company supplied by the request. A client
 * must not be able to widen or redirect scope on a deployment that has already
 * pinned its company; a request-supplied value is still checked against the
 * principal's allow-list, so it can never reach a company the account does not
 * own.
 *
 * @returns {{ok:true, company:string|null, enforced:boolean, source:string}
 *           | {ok:false, code:string, error:string}}
 */
export function resolveCompanyScope(capabilityId, { principal, requested, env = process.env } = {}) {
  const scope = getCapability(capabilityId)?.authorization?.scope?.company ?? "n/a";
  if (scope !== "required") {
    return { ok: true, company: null, enforced: false, source: "not_required" };
  }

  const requestedCompany =
    typeof requested === "string" && requested.trim() ? requested.trim() : null;
  const envCompany =
    typeof env?.COPILOT_COMPANY === "string" && env.COPILOT_COMPANY.trim()
      ? env.COPILOT_COMPANY.trim()
      : null;

  const pinned = principal?.company ?? envCompany ?? null;

  // A request that names a DIFFERENT company than the one this deployment has
  // pinned is refused rather than silently rewritten to the pinned value: it is
  // a client bug or an attempt to reach another tenant, and the phase's exit
  // criterion is explicit — “sai company scope → block”.
  if (pinned && requestedCompany && requestedCompany !== pinned) {
    return {
      ok: false,
      code: AUTHZ_CODES.DENIED,
      error:
        `yêu cầu ghi cho company "${requestedCompany}" nhưng tài khoản ` +
        `"${principal?.user_id ?? "?"}" chỉ được phép trên "${pinned}" — không thực hiện`,
    };
  }

  const company = pinned ?? requestedCompany;
  const source = principal?.company
    ? "principal"
    : envCompany
      ? "env"
      : requestedCompany
        ? "request"
        : "none";

  if (!company) {
    // MULTI-TENANT is where tenants must be separated, so an unresolvable
    // company is a hard refusal there. In SINGLE-TENANT mode the deployment has
    // exactly one company by construction and older installs have no company
    // concept at all — refusing would break every write on upgrade, so this is
    // reported (see describeAuthorization) instead of blocked. `required` in the
    // contract still means "must be pinned the moment more than one tenant
    // exists", which is exactly what multi_user mode enforces.
    if (principal?.mode !== AUTHZ_MODES.MULTI_USER) {
      return { ok: true, company: null, enforced: false, source: "unset_single_tenant" };
    }
    return {
      ok: false,
      code: AUTHZ_CODES.COMPANY_REQUIRED,
      error:
        `"${capabilityId}" bắt buộc phải xác định company — đặt COPILOT_COMPANY ` +
        `(hoặc company trong COPILOT_USERS) trước khi thực hiện thao tác ghi`,
    };
  }

  const allowed = principal?.companies ?? [];
  if (allowed.length > 0 && !allowed.includes(company)) {
    return {
      ok: false,
      code: AUTHZ_CODES.DENIED,
      error:
        `tài khoản "${principal?.user_id ?? "?"}" không được phép thao tác trên company ` +
        `"${company}" (chỉ: ${allowed.join(", ")})`,
    };
  }

  return { ok: true, company, enforced: true, source };
}

/**
 * One call for the pipeline: permission first (cheapest, most fundamental),
 * then company scope. Returns the resolved company on success so the caller can
 * carry it into the execution record.
 *
 * @returns {{ok:true, company:string|null} | {ok:false, code:string, error:string}}
 */
export function authorize(capabilityId, { principal, company, env = process.env } = {}) {
  const permission = checkPermissions(capabilityId, principal);
  if (!permission.ok) return permission;

  const scope = resolveCompanyScope(capabilityId, { principal, requested: company, env });
  if (!scope.ok) return scope;

  return { ok: true, company: scope.company };
}

/**
 * Startup summary. Authorization that silently falls back is worse than no
 * authorization, so the operator is told which mode is active and what to set.
 * Never throws — it runs while the server boots.
 */
export function describeAuthorization(env = process.env) {
  const warnings = [];
  let mode = AUTHZ_MODES.SINGLE_TENANT;
  let users = [];

  try {
    const parsed = parseUsers(env?.COPILOT_USERS);
    if (parsed) {
      mode = AUTHZ_MODES.MULTI_USER;
      users = [...parsed.keys()];
    } else {
      if (env?.COPILOT_DEFAULT_PERMISSIONS === undefined) {
        const granted = contractDeclaredPermissions();
        warnings.push(
          `đang ở chế độ single-tenant: người dùng đã xác thực được cấp quyền theo contract ` +
            `[${granted.join(", ")}]. Đặt COPILOT_USERS (đa người dùng) hoặc COPILOT_DEFAULT_PERMISSIONS để thu hẹp.`,
        );
      }
      const needsCompany = listCapabilities()
        .filter((id) => !isForbidden(id))
        .filter((id) => getCapability(id)?.authorization?.scope?.company === "required");
      const configured = typeof env?.COPILOT_COMPANY === "string" && env.COPILOT_COMPANY.trim();
      if (needsCompany.length > 0 && !configured) {
        warnings.push(
          `single-tenant chưa pin company: [${needsCompany.join(", ")}] khai báo scope.company="required" ` +
            `nhưng COPILOT_COMPANY trống — hiện KHÔNG chặn (một company duy nhất), nhưng phải đặt trước khi ` +
            `có tenant thứ hai (chế độ đa người dùng sẽ TỪ CHỐI nếu thiếu company).`,
        );
      }
    }
  } catch (err) {
    mode = "invalid";
    warnings.push(`cấu hình phân quyền KHÔNG hợp lệ: ${err?.message ?? err}`);
  }

  return { mode, users, warnings };
}
