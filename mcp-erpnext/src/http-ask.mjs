/**
 * HTTP wrapper `/ask` — the phone-facing endpoint of the copilot pipeline.
 *
 * The Flutter chat client (Phase 3, apps/mobile) speaks plain HTTP; the
 * copilot pipeline (normalize -> route -> skill -> ERPNext) lives behind
 * answerQuestion() in copilot-server.mjs. This wrapper ONLY translates
 * HTTP <-> that function — no routing logic, no money logic, no new guard
 * surface (answerQuestion keeps every Phase 2 fail-safe).
 *
 * P0 (plan2_final §7, §26): the WRITE endpoint `/execute` no longer holds any
 * policy. It delegates to the Safety Gateway (safety-gateway.mjs), which is the
 * single boundary every ERPNext WRITE must pass. This file only parses the
 * request and maps the gateway's {status, body} back to HTTP.
 *
 * Endpoints:
 *   GET  /health -> {ok:true, service:"copilot-ask", port}
 *   POST /ask    -> body {"text": "..."} -> {ok:true, result:{answer...}}
 *                   missing/invalid text -> 400 {ok:false,error}
 *                   internal failure    -> 500 {ok:false,error} (no stack)
 *                   optional `source_document` (next3/B): the IDENTITY of the
 *                   paper document the sentence came from (số HĐ + ngày +
 *                   MST/party + loại). Validated fail-closed and carried into the
 *                   proposal so the same invoice cannot be written twice. A
 *                   malformed identity is a 400 — dropping it silently would
 *                   leave the user believing the duplicate guard was on.
 *                   Inert for every capability that does not declare
 *                   `business_doc_key` (today: everything except the purchase path).
 *   POST /execute        -> Safety Gateway (confirm + execute one WRITE)
 *   POST /execute/cancel -> release a zombie PENDING command (reconcile-verified)
 *   GET  /jobs           -> pending + recent terminal jobs (P7)
 *   POST /read/list      -> A1 UX-READ drill-down: a FRESH, bounded READ of the
 *                           screen a bubble offered ({screen, entity_id, limit})
 *                           -> {ok:true, result:{summary, rows, truncated…}}
 *                           READ only by construction: it composes READ skills,
 *                           never the Safety Gateway, and the screen id must be
 *                           declared in the contract (`ui_screens`). An unknown
 *                           screen/entity is refused — never guessed.
 *
 * P10 slice (plan2_final §17, §24.3):
 *   - Rate limiting per user (read/write_proposal/write_execute) and per
 *     capability, enforced from the contract's operational_controls. A
 *     throttled /execute is refused BEFORE the Safety Gateway, so the caller's
 *     command_id is never burned. `COPILOT_RATE_LIMIT=off` disables it;
 *     cancel is never throttled (it releases locks, it does not write).
 *   - Every /ask, /execute and job-runner event appends ONE correlation line
 *     (request_id / user_id / command_id / action_id / outcome / latency) to
 *     the learning log (§17: enough to investigate a duplicate, a timeout, or
 *     a wrong entity after the fact).
 *
 * Bind + auth policy (user decision 2026-09-14 — REAL customer debt data
 * must never be exposed to the public internet without auth):
 *   - Default stays 127.0.0.1 (same stance as nlp_service).
 *   - Non-loopback binds REQUIRE basic auth (ASK_USER + ASK_PASSWORD env)
 *     AND the server hard-refuses to start otherwise. Public-interface
 *     binds additionally require ASK_ALLOW_PUBLIC=1 — an explicit operator
 *     decision, not an accident of a wrong flag.
 *   - Intended safe path: bind the Tailscale interface (or any VPN IP) —
 *     encrypted WireGuard transport, no public exposure, auth still on.
 *
 * Run: node src/http-ask.mjs [--port 8788] [--host 127.0.0.1]
 *      ASK_USER=op ASK_PASSWORD=... node src/http-ask.mjs --host <tailscale-ip>
 * Ready line on stdout: {"ready":true,"port":N,"host":"...","auth":bool}
 */

import http from "node:http";
import { timingSafeEqual, createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { answerQuestion, answerQuestionLogged, erpTargetLabel, normalizeText, pickServerScript } from "./copilot-server.mjs";
import * as customerSkill from "./skills/customer.mjs";
import { findSupplier, listSuppliersWithTaxId } from "./skills/purchasing.mjs";
import { findItem } from "./skills/inventory.mjs";
import { logEvent, writeOutcomeFor } from "./learning-log.mjs";
import { AUTHZ_CODES, AUTHZ_MODES, authorize, checkPermissions, describeAuthorization, resolveCompanyScope, resolvePrincipal } from "./authorization.mjs";
import { assertReadOnly } from "./readonly-guard.mjs";
import { RateLimiter, rateLimitMessage, proposalBucketFor } from "./rate-limit.mjs";
// The action → capability mapping lives with the contract (single source).
import { capabilityForAction, declaredDocumentKinds, einvoicePolicy } from "./capability-contract.mjs";
import { validateSourceDocument } from "./business-doc-key.mjs";
import { IdempotencyStore, isValidCommandId } from "./idempotency.mjs";
import { DRILL_VIEW_CODES, readDrill, resolveDrillScreen } from "./drill-views.mjs";
import { reconcilePaymentEntry } from "./skills/payment-write.mjs";
import { createMcpClient } from "./client.mjs";
import { runExecute } from "./safety-gateway.mjs";
import { JobQueue } from "./job-queue.mjs";
// DSH gateway (plan .plan/dsh_end_to_end.md): the EXPLICIT opt-in agent path.
// Imported here (and ONLY here) so the /ask pipeline itself never touches dsh —
// p5-dsh-optin.test.mjs keeps the static "no dsh spawn in the /ask pipeline"
// assertion, and the gateway lives behind its own route below.
import { dshGatewayAsk, DSH_IN_FLIGHT, isValidConversationId } from "./dsh-gateway.mjs";
// NEXT6 §13.1: how many seconds a client should wait after a 429 when the one
// DSH slot is busy. Advisory and deliberately small — the global slot frees up
// within one session, and the client's "đang chờ" state should not over-promise.
const DSH_BUSY_RETRY_AFTER_S = 2;
// A1 (plan3 Trụ A): the READ drill-down behind the bubble button. This module
// composes READ skills only — no write surface, no Safety Gateway.
import { readScreen, resolveReadScreen } from "./read-views.mjs";
// P4 (plan4_final §4): the Daily Operations Cockpit aggregate. Server-side only
// (the Flutter client must never sum across APIs) and READ-only: the skill
// imports assertReadOnly, declares no write doctype and returns no command_id.
import { getDailySummary } from "./skills/ops-summary.mjs";
// C1 (plan3 Trụ C): the camera input channel. A photo becomes TEXT through the
// OCR seam, and that text is returned for the user to edit and send — this route
// never builds a proposal and never reaches the Safety Gateway (C2 is where a
// recognised document may, through the SAME gateway as every other write).
import { assertOcrInput, getOcrProvider, ocrLogLine, prepareOcrText } from "./ocr/ocr-provider.mjs";
// C2 — what a reading appears to say, for the user to correct BEFORE anything
// becomes a proposal. READ only by construction: it composes READ skills and the
// builder's own parse steps, and it holds no write surface.
import { OCR_SLOTS_CODES, assertSlotsProvenance, assertSlotsText, extractSlots, kindSpec } from "./ocr/ocr-slots.mjs";
// A1/A2 (`.plan/next3/implementation.md` workstream A): the SUPPLIER-FILE input
// channel. An e-invoice XML becomes the same SLOTS the camera produces, so the
// file travels the ONE existing pipeline (form → composed sentence → /ask →
// capability → proposal → confirm → Safety Gateway → DRAFT). Nothing here
// writes, builds a proposal, or reads a price — and the parser itself never sees
// ERPNext (it is handed the policy and the file's text only).
import { EINVOICE_CODES, parseEinvoiceXml } from "./einvoice/einvoice-xml.mjs";
import { PDF_CODES, parseEinvoicePdf } from "./einvoice/einvoice-pdf.mjs";
import {
  EINVOICE_SLOTS_CODES,
  assertParsedComplete,
  buildEinvoiceSlots,
  kindSpec as einvoiceKindSpec,
} from "./einvoice/einvoice-slots.mjs";

const MAX_BODY = 1_000_000; // one utterance is ~200 chars; 1MB is generous

function parseArgs(argv) {
  const args = { port: Number(process.env.ASK_PORT || 8788), host: process.env.ASK_HOST || "127.0.0.1" };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--port") args.port = Number(argv[++i]);
    if (argv[i] === "--host") args.host = argv[++i];
  }
  return args;
}

/**
 * Non-loopback bind policy. Throws on unsafe config so the process never
 * comes up exposed by accident. Returns the parsed credential pair.
 */
export function resolveBindPolicy({ host, env = process.env }) {
  const loopback = /^(127\.|localhost$|::1$)/.test(host);
  if (loopback) {
    if (env.ASK_USER || env.ASK_PASSWORD) {
      throw new Error("ASK_USER/ASK_PASSWORD make no sense on a loopback bind — remove them");
    }
    return { loopback: true, user: null, password: null };
  }
  const user = env.ASK_USER;
  const password = env.ASK_PASSWORD;
  if (!user || !password) {
    throw new Error(
      `refusing to bind non-loopback host ${host} without auth: set ASK_USER and ASK_PASSWORD`,
    );
  }
  if (String(password).length < 8) {
    throw new Error("ASK_PASSWORD must be at least 8 characters");
  }
  const isPrivate =
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(host); // Tailscale CGNAT 100.64.0.0/10 ONLY
  // (100.0–100.63 and 100.128+ are PUBLIC address space — must not count as private)
  if (!isPrivate && env.ASK_ALLOW_PUBLIC !== "1") {
    throw new Error(
      `refusing to bind public interface ${host}: pass ASK_ALLOW_PUBLIC=1 only if you understand the exposure (prefer a VPN/Tailscale IP)`,
    );
  }
  return { loopback: false, public: !isPrivate, user: String(user), password: String(password) };
}

function sha256(buf) {
  return createHash("sha256").update(buf).digest();
}

function basicAuthOk(req, policy) {
  const header = req.headers.authorization ?? "";
  const m = /^Basic (.+)$/.exec(header);
  if (!m) return false;
  let decoded;
  try {
    decoded = Buffer.from(m[1], "base64").toString("utf8");
  } catch {
    return false;
  }
  const idx = decoded.indexOf(":");
  if (idx < 0) return false;
  // Hash both sides to a fixed 32-byte digest before comparing: no length
  // equality gate (which leaks credential length via timing), no
  // timingSafeEqual length-mismatch exception risk.
  const givenUser = sha256(Buffer.from(decoded.slice(0, idx)));
  const givenPass = sha256(Buffer.from(decoded.slice(idx + 1)));
  const wantUser = sha256(Buffer.from(policy.user));
  const wantPass = sha256(Buffer.from(policy.password));
  return timingSafeEqual(givenUser, wantUser) && timingSafeEqual(givenPass, wantPass);
}

function sendJson(res, status, payload, extraHeaders = null) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    ...(extraHeaders ?? {}),
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    // The future Flutter-web build and the phone app on the LAN both call this;
    // CORS stays permissive on purpose for the read-only MVP (Phase 5 gateway
    // will own real origin policy).
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  });
  res.end(body);
}

/**
 * P10 slice: the uniform refusal for a throttled request. 429 + Retry-After +
 * the SAME friendly sentence the user would get from the pipeline — never a
 * bare status code. The caller has already logged the event.
 */
function sendRateLimited(res, verdict, { write = false } = {}) {
  const retryAfterMs = Math.max(0, verdict?.retryAfterMs ?? 0);
  sendJson(
    res,
    429,
    {
      ok: false,
      code: "RATE_LIMITED",
      error: rateLimitMessage(verdict, { write }),
      retry_after_ms: retryAfterMs,
    },
    { "Retry-After": String(Math.max(1, Math.ceil(retryAfterMs / 1000))) },
  );
}

/**
 * The two correlation ids cross the CLIENT boundary and end up as ERPNext
 * filter values (`[[custom_ai_action_id, "=", actionId]]`), which the pinned
 * tool only accepts as STRINGS. Missing/null stays the gateway's business (it
 * reports absence with its own codes); anything PRESENT but not a non-empty
 * string is refused at the boundary.
 *
 * Why not leave it to the query: measured 2026-09-21 — a numeric value makes
 * the tool answer `Property /filters/0/2 must be string`, reconcile() then sets
 * `correlation_field_unavailable`, and the executor refuses a legitimate write
 * while blaming the SITE ("ERPNext chưa có field — chạy migration"). Fail-closed
 * but misdiagnosed: the client's typing error becomes an infrastructure hunt.
 */
function correlationIdProblem(body) {
  const ids = [
    ["command_id", body?.command_id],
    ["proposal.action_id", body?.proposal?.action_id],
  ];
  for (const [name, value] of ids) {
    if (value === undefined || value === null) continue;
    if (typeof value !== "string" || value.trim() === "") {
      return `${name} phải là chuỗi không rỗng (nhận ${JSON.stringify(value)})`;
    }
  }
  return null;
}

/**
 * P4-2 (plan4_final §4.2): which calendar day the drawer is asking about, in
 * the shop's timezone.
 *
 * The contract pins Asia/Ho_Chi_Minh as the day boundary (`posting_date` in
 * ERPNext is a DATE — §3: the question is "which calendar day is it at the
 * shop"), and that is NOT the host's day: a host on UTC asked at 00:30 VN must
 * still report the VN date. `en-CA` formats as YYYY-MM-DD, so no manual padding
 * (and no month/day swap) is possible.
 */
export function vnToday(now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Ho_Chi_Minh",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

/**
 * Why a `date` parameter is unusable, or null when it is fine (or absent).
 *
 * A shape regex alone accepts 2026-02-30 and 2026-13-01, and `Date` silently
 * rolls those over — so the round-trip is the check. A day that quietly means
 * another day is a wrong MONEY report, which is worse than a refusal here.
 */
function summaryDateProblem(raw) {
  if (raw === null || raw === undefined || raw === "") return null; // → today VN
  if (typeof raw !== "string") {
    return `date phải là chuỗi YYYY-MM-DD (nhận ${JSON.stringify(raw)})`;
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    return `date phải có dạng YYYY-MM-DD (nhận "${raw}")`;
  }
  const [y, m, d] = raw.split("-").map(Number);
  const probe = new Date(Date.UTC(y, m - 1, d));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== m - 1 || probe.getUTCDate() !== d) {
    return `date "${raw}" không tồn tại trên lịch`;
  }
  return null;
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
async function resolveReadCompany({ mcp, principal, env, capabilityId, authorizedCompany }) {
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

/**
 * The day's own error code for the CLIENT.
 *
 * Skill failures arrive as `<CODE>: detail` message prefixes (readonly-guard
 * and the write skills use the same convention). Codes the caller can act on
 * keep their identity; anything else means one thing to the drawer — ERPNext
 * could not be read (a tool/transport failure surfaces as TOOL_ERROR, and
 * wrapping the MCP layer's own vocabulary would leak internals without
 * helping anyone decide. The real message travels in `error` and the log).
 */
const SUMMARY_CLIENT_CODES = new Set([
  "OPS_DATE_REQUIRED",
  "INVALID_DATE",
  "COMPANY_UNRESOLVED",
  "ERP_UNAVAILABLE",
  "PARTIAL_DATA",
  // D2 (§3.3): an UNPINNED default warehouse is a CONFIGURATION error the
  // operator fixes in .env/Desk — it must arrive as its own code (the app
  // shows the [Hướng dẫn] copy), never folded into "ERPNext unreachable":
  // ERPNext is fine, the deployment is incomplete. (§5: config error ⇒
  // guidance, not silence.)
  "STOCK_WAREHOUSE_UNPINNED",
]);

function dailySummaryErrorCode(err) {
  if (typeof err?.code === "string" && err.code) {
    return SUMMARY_CLIENT_CODES.has(err.code) ? err.code : "ERP_UNAVAILABLE";
  }
  const m = /^([A-Z][A-Z0-9_]*):/.exec(String(err?.message ?? err ?? ""));
  const raw = m ? m[1] : null;
  return SUMMARY_CLIENT_CODES.has(raw) ? raw : "ERP_UNAVAILABLE";
}

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
async function readSessionCompany(mcp) {
  assertReadOnly("erpnext_doc_get");
  const res = await mcp.callTool("erpnext_doc_get", {
    doctype: "Global Defaults",
    name: "Global Defaults",
  });
  const doc = res?.data?.data ?? null;
  const name = typeof doc?.default_company === "string" ? doc.default_company.trim() : "";
  return name || null;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/** Authorization boot line is written once per process (see createAskServer). */
let authzAnnounced = false;

export function createAskServer({
  port = 8788,
  host = "127.0.0.1",
  policy = null,
  idemStore = null,
  jobs = null,
  limiter = null,
  // P8: test seams. `principal` pins the actor directly; `env` is the config
  // surface for resolvePrincipal (COPILOT_USERS / COPILOT_DEFAULT_PERMISSIONS /
  // COPILOT_COMPANY). Both default to the process environment.
  principal: principalOverride = null,
  env = process.env,
} = {}) {
  const bindPolicy = policy ?? resolveBindPolicy({ host });
  const store = idemStore ?? new IdempotencyStore();
  const jobQueue = jobs ?? new JobQueue();
  // P10 slice: rate limiting is ON by default (COPILOT_RATE_LIMIT=off is the
  // operator's explicit opt-out). Tests inject `limiter` to control the clock
  // or to exercise the unlimited path.
  const rateLimiter = limiter ?? new RateLimiter();
  // P8 (plan2_final §5): identity is resolved ONCE per process — permissions and
  // company scope are configuration, not per-request state. `principal` is an
  // explicit seam so tests can drive multi-user behaviour without env juggling.
  const principal = principalOverride ?? resolvePrincipal({ user: bindPolicy.user, env });
  /**
   * Identity for the per-user rate bucket, the audit lines and the job report.
   * Derived FROM the principal, not from the credential, so there is exactly one
   * notion of "who" in this process: whatever the log says is also what was
   * authorized. (They coincide in production, where the credential names the
   * account; deriving one from the other removes the chance of them drifting.)
   */
  const userId = principal.user_id;
  // Announce ONCE per process: this is boot information about a deployment, not
  // per-request state, and the test suite constructs hundreds of servers.
  if (!authzAnnounced) {
    authzAnnounced = true;
    const authzSummary = describeAuthorization(env);
    for (const warning of authzSummary.warnings) {
      process.stderr.write(`[authz] ${warning}\n`);
    }
    process.stderr.write(
      `[authz] mode=${authzSummary.mode} user=${principal.user_id} permissions=[${principal.permissions.join(", ")}]\n`,
    );
  }
  const server = http.createServer(async (req, res) => {
    // Non-loopback: every route (including /health) requires basic auth.
    if (!bindPolicy.loopback && !basicAuthOk(req, bindPolicy)) {
      res.writeHead(401, {
        "WWW-Authenticate": "Basic realm=erpn-copilot, charset=UTF-8",
        "Content-Type": "application/json; charset=utf-8",
      });
      res.end(JSON.stringify({ ok: false, error: "unauthorized" }));
      return;
    }
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      });
      res.end();
      return;
    }
    const path = (req.url ?? "/").split("?")[0];
    if (req.method === "GET" && path === "/health") {
      sendJson(res, 200, { ok: true, service: "copilot-ask", port });
      return;
    }
    if (req.method === "GET" && path === "/dsh/health") {
      // DSH opt-in health: separate from /health so the client can offer the
      // mode selector state ("DSH hiện không khả dụng") without probing the
      // deterministic pipeline. Reveals availability ONLY — no paths, no env.
      //
      // REPORTED TRUTHFULLY (review F5): the check now mirrors what a real run
      // requires — the local mode must also have the write-gate marker in its
      // patch, and the remote mode must actually reach the Mac runner. The old
      // "two files exist" answer could report available=true on a topology that
      // cannot serve a single question.
      //
      // Same last-resort law as /execute and /dsh/ask (review 2026-09-19): an
      // unexpected throw inside an async listener is an UNHANDLED REJECTION and
      // Node exits — the process dies (result44 §3 killed the gateway exactly
      // this way, from a config error). A health probe must be the LEAST
      // dangerous route in the service; unwrapped, it was the only one that
      // could take the whole thing down.
      try {
        const { dshGatewayHealth } = await import("./dsh-gateway.mjs");
        const health = await dshGatewayHealth({ env });
        sendJson(res, 200, {
          ok: true,
          service: "dsh-gateway",
          available: health.available,
          runtime: health.mode,
          // HOW it runs (npx-pinned / legacy-tmp / DSH_ENTRY …) — separate from
          // `runtime` (topology). A runtime resolved from a machine-local path
          // is the exact failure mode that did not travel to another host, so
          // the answer must not be invisible.
          source: health.source ?? null,
          version: health.version ?? null,
          detail: health.detail,
          mode: "dsh",
        });
      } catch (err) {
        // 503 = the probe itself is broken; "unavailable" is the honest answer
        // and monitoring can tell it apart from a healthy-but-disabled runtime.
        sendJson(res, 503, {
          ok: false,
          service: "dsh-gateway",
          available: false,
          runtime: null,
          source: null,
          version: null,
          detail: `health probe failed: ${err?.message ?? err}`,
          mode: "dsh",
        });
      }
      return;
    }
    if (req.method === "POST" && path === "/dsh/ask") {
      // Explicit DSH opt-in (plan §1/§4): a SEPARATE route — /ask never gains a
      // dsh branch (D2), and this route never routes to the deterministic
      // answerQuestion. Same security boundary as every other route here: the
      // basic-auth gate above already applied, the principal is the same one,
      // and the write_proposal-style per-user READ bucket is charged first so
      // an agent session cannot be cheaper than a normal question.
      let message;
      let conversationId = null;
      try {
        const raw = await readBody(req);
        const parsed = raw ? JSON.parse(raw) : {};
        message = parsed?.message;
        conversationId = typeof parsed?.conversation_id === "string" && parsed.conversation_id.trim()
          ? parsed.conversation_id.trim()
          : null;
        // Review F3: a client-supplied id becomes a Map key and a log field.
        // Shape-check it at the boundary (uuid-ish, bounded) instead of trusting
        // it — the gateway is not the place to discover a malformed id later.
        if (conversationId && !isValidConversationId(conversationId)) {
          sendJson(res, 400, { ok: false, code: "DSH_GATEWAY_BAD_REQUEST", error: "conversation_id không hợp lệ" });
          return;
        }
      } catch (err) {
        sendJson(res, 400, { ok: false, error: `invalid request body: ${err.message}` });
        return;
      }
      const dshRequestId = randomUUID();
      const dshStartedAt = Date.now();
      const dshVerdict = rateLimiter.chargeUser("read", userId);
      if (!dshVerdict.ok) {
        logEvent({
          phase: "dsh_ask",
          outcome: "rate_limited",
          error_code: "RATE_LIMITED",
          request_id: dshRequestId,
          user_id: userId,
          mode: "dsh",
          text: String(message ?? "").slice(0, 200),
          latency_ms: Date.now() - dshStartedAt,
        });
        sendRateLimited(res, dshVerdict);
        return;
      }
      try {
        const outcome = await dshGatewayAsk(message, {
          env,
          conversationId,
          requestId: dshRequestId,
          // NEXT6 §2.2/§2.1: the principal comes from auth/bind-policy, NEVER
          // from the body, and scopes the session store (principal+conversation).
          principalId: userId,
        });
        if (!outcome.ok) {
          const payload = {
            ok: false,
            error: outcome.reason,
            code: outcome.code,
            mode: "dsh",
            // A FAILED session must still say WHERE it ran: "DSH failed" is not
            // evidence, and a remote failure has a different remedy than a
            // local one (restart the tunnel vs. install the runtime).
            runtime: outcome.runtime ?? null,
            conversation_id: outcome.conversationId,
            request_id: outcome.requestId,
            // The scrubbed diagnostic the gateway already computed (child's last
            // stderr, parse failure, spawn error). Without it, "lỗi phiên" was
            // the whole story and the real cause of the first npx session
            // failure lived only in the router audit. Same boundary as every
            // other field here: scrubbed, bounded, no path to a secret.
            log_tail: outcome.logTail ?? null,
          };
          if (outcome.code === DSH_IN_FLIGHT) {
            // §13.1: a busy slot is normal — tell the client how long to wait so
            // its "đang chờ" state is honest and it does not hammer the gateway.
            sendJson(res, 429, { ...payload, error: payload.error, retryable: true }, { "Retry-After": String(DSH_BUSY_RETRY_AFTER_S) });
            return;
          }
          if (outcome.httpStatus === 400) {
            sendJson(res, 400, payload);
            return;
          }
          // A GATE refusal (WRITE pre-screen, or NLP unavailable so safety could
          // not be judged) is a deliberate ANSWER about the question — the
          // gateway never touched the runtime. `dshGatewayAsk` declares 200 for
          // exactly this case; mapping it to 502 would tell monitoring and any
          // retry logic that the infrastructure broke, and would make a safety
          // refusal indistinguishable from a dead tunnel.
          if (outcome.httpStatus === 200) {
            sendJson(res, 200, { ...payload, refused: true });
            return;
          }
          // 502: dsh ran (or failed to start) — the client shows the actionable
          // message verbatim; the code carries the machine-readable cause.
          sendJson(res, 502, payload);
          return;
        }
        // Response envelope (plan §5): mode/conversation_id/request_id are
        // first-class so the Flutter client can render the DSH state truthfully.
        sendJson(res, 200, {
          ok: true,
          mode: "dsh",
          // Which machine actually ran the session (local | remote). A remote
          // result must never be indistinguishable from a local one — the E2E
          // script asserts this field exists on success AND failure.
          runtime: outcome.runtime ?? null,
          conversation_id: outcome.conversationId,
          request_id: outcome.requestId,
          dsh_session_id: outcome.dsh_session_id,
          // Audit evidence (plan §23/§24): the copilot child reported which
          // ERPNext target the session could reach — REAL vs mock. No host, no key.
          erpnext_target: outcome.erpnext_target ?? null,
          result: {
            question: message,
            answer: outcome.answer?.content ?? outcome.answer?.text ?? null,
            answer_structured: outcome.answer,
            mode: "dsh",
            runtime: outcome.runtime ?? null,
            erpnext_target: outcome.erpnext_target ?? null,
            conversation_id: outcome.conversationId,
            request_id: outcome.requestId,
          },
        });
      } catch (err) {
        // Same last-resort law as /execute: an unexpected throw inside the async
        // handler is an unhandled rejection and kills the gateway. Never leak a
        // stack — message only.
        sendJson(res, 500, {
          ok: false,
          error: `dsh gateway failed: ${err?.message ?? err}`,
          code: "DSH_GATEWAY_UNEXPECTED_ERROR",
          mode: "dsh",
          request_id: dshRequestId,
        });
      }
      return;
    }
    if (req.method === "POST" && path === "/execute/cancel") {
      // Phase 9 (user decision 2026-09-16, resolves result29 §10-F2): a PENDING
      // command whose (customer, invoice) intent is locked can now be CANCELLED
      // — but only after ERPNext itself proves the write never landed.
      // reconcile finds 0 documents with this reference_no ⇒ nothing was
      // written ⇒ the record is terminal-safe to mark CANCELLED, releasing the
      // intent lock. If reconcile finds a document (or errors), we NEVER cancel:
      // the money may exist — the human resolves that on ERPNext.
      //
      // Cancel is a LOCK RELEASE, not an ERPNext write, so the kill switch does
      // not block it: refusing cancel during maintenance would freeze intents.
      let body;
      try {
        const raw = await readBody(req);
        body = raw ? JSON.parse(raw) : {};
      } catch (err) {
        sendJson(res, 400, { ok: false, error: `invalid request body: ${err.message}` });
        return;
      }
      const { command_id } = body ?? {};
      if (!isValidCommandId(command_id)) {
        sendJson(res, 400, { ok: false, error: "command_id must be a client-generated UUID" });
        return;
      }
      const rec = store.status(command_id);
      if (!rec) {
        sendJson(res, 404, { ok: false, error: `không có lệnh nào với command_id này` });
        return;
      }
      // P8: cancel RELEASES someone's intent lock. Now that the record names the
      // actor who created it, honour that: an account may only release a command
      // IT created, unless it holds the capability's permission (an operator
      // clearing the shop's queue). Without this, any authenticated client could
      // drop another user's confirmed intent — and releasing a lock is what lets
      // the same debt be proposed again. Checked before the state checks so the
      // reply does not reveal whether a stranger's command completed.
      // Older records predate the actor field; they are treated as ownerless, so
      // only a permission-holder can release them (fail closed, never stranded).
      const isOwner = Boolean(rec.user_id) && rec.user_id === principal.user_id;
      if (!isOwner) {
        const mayRelease = checkPermissions("payment.create", principal);
        if (!mayRelease.ok) {
          sendJson(res, 403, {
            ok: false,
            code: AUTHZ_CODES.DENIED,
            error:
              `tài khoản "${principal.user_id}" không tạo ra lệnh này và không có quyền ` +
              `huỷ lệnh của người khác — không thực hiện`,
            command_id,
          });
          return;
        }
      }
      if (rec.status === "COMPLETED") {
        sendJson(res, 409, {
          ok: false,
          error: "lệnh đã COMPLETED — tiền đã ghi; không thể huỷ bằng API này (kiểm tra ERPNext nếu cần hoàn tác)",
          result: rec.result ?? null,
        });
        return;
      }
      if (rec.status === "CANCELLED") {
        sendJson(res, 200, { ok: true, cancelled: true, replay: true });
        return;
      }
      if (rec.status === "FAILED") {
        sendJson(res, 409, { ok: false, error: "lệnh đã FAILED (terminal) — không cần huỷ; hãy tạo command_id mới cho ý định đã sửa" });
        return;
      }
      // PENDING: the ONLY safe cancel is after ERPNext proves 0 documents.
      if (!rec.reference_no) {
        sendJson(res, 409, {
          ok: false,
          error: "lệnh PENDING nhưng chưa có reference_no — không thể đối soát, KHÔNG huỷ từ xa; cần người kiểm tra ERPNext",
          command_id,
        });
        return;
      }
      let mcpC;
      try {
        mcpC = createMcpClient({ serverScript: pickServerScript() });
        await mcpC.initialize();
        const rec2 = await reconcilePaymentEntry(mcpC, rec.reference_no);
        if (rec2.found) {
          // The write DID land. Cancel is refused; surface the document so the
          // caller can complete the command instead (retry /execute replays it).
          sendJson(res, 409, {
            ok: false,
            error: `ERPNext CÓ chứng từ ${rec2.doc?.name ?? "?"} mang reference_no này — KHÔNG huỷ; gửi lại /execute với cùng command_id để hoàn tất lệnh`,
            erpnext_doc: rec2.doc?.name ?? null,
            duplicate_documents: rec2.duplicates ? rec2.count : 0,
            command_id,
          });
          return;
        }
      } catch (err) {
        // Reconcile itself failed (ERPNext down): refuse rather than guess.
        sendJson(res, 503, {
          ok: false,
          error: `không đối soát được với ERPNext — KHÔNG huỷ để tránh trạng thái sai: ${err?.message ?? err}`,
          command_id,
        });
        return;
      } finally {
        if (mcpC) await mcpC.close().catch(() => {});
      }
      // Review 2026-09-16: a concurrent /execute (same command_id, e.g. a
      // double-tap on the card) can COMPLETE the command between the status
      // read above and this call — store.cancel() then refuses. Left uncaught
      // it would escape the async handler as an unhandled rejection and CRASH
      // the whole process (Node ≥15 default). Map it to a 409 instead.
      try {
        store.cancel(command_id);
      } catch (err) {
        sendJson(res, 409, {
          ok: false,
          error: `không thể huỷ: ${err?.message ?? err}`,
          command_id,
          status: store.status(command_id)?.status ?? null,
        });
        return;
      }
      // Review finding F-D: if the cancelled intent was parked in the job
      // queue (retryable 503 earlier), releasing it here stops the runner from
      // replaying it later — landing as a surprising FAILED instead of just
      // going away. The reconcile proof above is what makes this safe.
      const rel = jobQueue.release(command_id);
      if (rel.ok) {
        process.stderr.write(`[jobs] released queued job ${command_id} after verified-safe cancel\n`);
      }
      // P8 §17: who released the lock. Cancel writes nothing to ERPNext, but it
      // is a state change on a confirmed money intent, so the audit line names
      // the actor for the same reason /execute does.
      logEvent({
        phase: "cancel",
        outcome: "cancelled",
        request_id: randomUUID(),
        user_id: principal.user_id,
        command_id,
        reference_no: rec.reference_no ?? null,
        released_by: isOwner ? "owner" : "permission",
      });
      sendJson(res, 200, {
        ok: true,
        cancelled: true,
        command_id,
        note: "lệnh đã huỷ sau khi ERPNext xác nhận chưa ghi chứng từ nào — có thể tạo ý định mới",
      });
      return;
    }
    if (req.method === "POST" && path === "/execute") {
      // P0: EVERY ERPNext write goes through the Safety Gateway. This endpoint
      // owns no policy — it parses the request, calls the gateway, and maps the
      // verdict back to HTTP (plan2_final §7 invariant: no bypass).
      let body;
      try {
        const raw = await readBody(req);
        body = raw ? JSON.parse(raw) : {};
      } catch (err) {
        sendJson(res, 400, { ok: false, error: `invalid request body: ${err.message}` });
        return;
      }
      const idProblem = correlationIdProblem(body);
      if (idProblem) {
        sendJson(res, 400, { ok: false, code: "INVALID_CORRELATION_ID", error: idProblem });
        return;
      }
      // P10 slice (plan2_final §24.3): throttle BEFORE the Safety Gateway. That
      // ordering is the point — runExecute would begin an idempotency record for
      // this command_id, so rate limiting afterwards would burn the caller's
      // command_id for a request we never even attempted. A throttled execute
      // must leave the store untouched.
      const execStartedAt = Date.now();
      const commandId = body?.command_id ?? null;
      const capabilityId = capabilityForAction(body?.proposal?.action);
      const userVerdict = rateLimiter.chargeUser("write_execute", userId);
      const capVerdict = userVerdict.ok
        ? rateLimiter.chargeCapability(capabilityId, userId)
        : { ok: true, skipped: true };
      if (!userVerdict.ok || !capVerdict.ok) {
        const verdict = userVerdict.ok ? capVerdict : userVerdict;
        logEvent({
          phase: "execute",
          outcome: "rate_limited",
          error_code: "RATE_LIMITED",
          request_id: randomUUID(),
          user_id: userId,
          command_id: commandId,
          action_id: body?.proposal?.action_id ?? null,
          capability: capabilityId,
          scope: userVerdict.ok ? "per_capability" : "per_user",
          latency_ms: Date.now() - execStartedAt,
        });
        sendRateLimited(res, verdict, { write: true });
        return;
      }
      // Last-resort guard: the gateway returns verdicts rather than throwing,
      // but ANY unexpected throw inside an async handler becomes an unhandled
      // rejection and kills the whole gateway (Node ≥15). Refuse loudly instead
      // — a dead process takes /ask and /execute down with it.
      let verdict;
      try {
        verdict = await runExecute({
          command_id: body?.command_id,
          proposal: body?.proposal,
          store,
          // P1 §10.5: the extra acknowledgement for a business-level duplicate.
          // Absent/false ⇒ the gateway refuses with BUSINESS_DEDUP_CONFIRM_REQUIRED.
          dedup_ack: body?.dedup_ack === true,
          // P8: the actor and the company the request claims. Neither widens
          // what the account may do — the gateway re-checks both against the
          // contract, and company precedence is server-first.
          principal,
          company: body?.company,
          env,
        });
      } catch (err) {
        sendJson(res, 500, {
          ok: false,
          code: "EXECUTE_UNEXPECTED_ERROR",
          error: `lỗi không mong đợi trong Safety Gateway: ${err?.message ?? err}`,
          command_id: body?.command_id ?? null,
        });
        logEvent({
          phase: "execute",
          outcome: "error",
          error_code: "EXECUTE_UNEXPECTED_ERROR",
          request_id: randomUUID(),
          user_id: userId,
          command_id: commandId,
          latency_ms: Date.now() - execStartedAt,
        });
        return;
      }
      sendJson(res, verdict.status, verdict.body);
      // P10 slice §17: one correlation line per WRITE attempt — the record an
      // operator needs to investigate a duplicate / timeout / wrong entity.
      logEvent({
        phase: "execute",
        outcome: writeOutcomeFor(verdict),
        error_code: verdict.body?.code ?? null,
        request_id: randomUUID(),
        user_id: userId,
        command_id: commandId,
        action_id: body?.proposal?.action_id ?? null,
        capability: capabilityId,
        risk: body?.proposal?.risk?.level ?? body?.proposal?.risk ?? null,
        erp_document_id: verdict.body?.erpnext_doc ?? null,
        latency_ms: Date.now() - execStartedAt,
      });
      // ── P7: a RETRYABLE refusal (ERP unreachable / write unverified) is the
      // moment the confirmed intent can be parked for automatic retry. The
      // verdict body itself says retry_same_command_id — anything else is NOT
      // queueable (a stale proposal must be re-asked, not retried). Best
      // effort: a broken queue dir must not change the HTTP answer.
      if (verdict.status === 503 && verdict.body?.retry_same_command_id === true) {
        const enq = jobQueue.enqueue({
          command_id: body?.command_id,
          proposal: body?.proposal,
          dedup_ack: body?.dedup_ack === true,
          reason: verdict.body?.error ?? null,
          // P8: the runner replays later with no request context — the job must
          // remember which account asked, or the retry would be authorized and
          // audited as somebody else.
          user_id: principal.user_id,
          company: verdict.body?.company ?? body?.company ?? null,
        });
        if (enq.ok && !enq.duplicate) {
          process.stderr.write(`[jobs] queued ${body?.command_id} — will retry via the Safety Gateway\n`);
        }
      }
      return;
    }
    if (req.method === "GET" && path === "/jobs") {
      // P7: the client polls this instead of push notifications. Only the
      // caller's own jobs are ever interesting; the report is read-only.
      // Review finding F-C: a poller that only ever saw "pending" could never
      // observe VERIFIED/FAILED — include recent terminal jobs (newest first).
      //
      // P8 §24.2 (row level): a job carries the customer, amount and result of
      // somebody's payment, so in MULTI-USER mode the report is scoped to the
      // account that asked — otherwise any authenticated client could read
      // another user's payment queue. Single-tenant has exactly one principal,
      // so nothing is filtered there. Jobs queued before P8 carry no owner and
      // are therefore shown only to a permission holder (fail closed).
      const maySeeAllJobs =
        principal.mode !== AUTHZ_MODES.MULTI_USER ||
        checkPermissions("payment.create", principal).ok;
      const visible = (j) => maySeeAllJobs || j.user_id === principal.user_id;
      const pending = jobQueue.pending().filter(visible);
      const completed = jobQueue.completed().filter(visible);
      const hidden = jobQueue.pending().length + jobQueue.completed().length - pending.length - completed.length;
      sendJson(res, 200, {
        ok: true,
        pending: pending.map((j) => ({
          command_id: j.command_id,
          state: j.state,
          attempts: j.attempts,
          next_attempt_at: j.next_attempt_at,
          last_error: j.last_error,
        })),
        completed: completed.map((j) => ({
          command_id: j.command_id,
          state: j.state,
          attempts: j.attempts,
          erpnext_doc: j.proposal?.result?.erpnext_doc ?? null,
          last_error: j.last_error,
        })),
        // Never hide the fact that something was filtered: an operator staring
        // at an empty queue must not conclude the jobs vanished.
        hidden,
      });
      return;
    }
    if (req.method === "POST" && path === "/read/list") {
      // A1 deliverable 2 — the fresh READ behind the drill-down. Ordering is the
      // point: throttle, then resolve the screen against the CONTRACT (fail
      // closed), then authorize server-side, and only then touch ERPNext.
      let body;
      try {
        const raw = await readBody(req);
        body = raw ? JSON.parse(raw) : {};
      } catch (err) {
        sendJson(res, 400, { ok: false, code: "BAD_REQUEST", error: `invalid request body: ${err?.message ?? err}` });
        return;
      }
      const listStartedAt = Date.now();
      const listRequestId = randomUUID();
      // Same READ bucket as /ask: the expensive part is the ERPNext read, which
      // is exactly what a burst of screen opens would exhaust.
      const listVerdict = rateLimiter.chargeUser("read", userId);
      if (!listVerdict.ok) {
        logEvent({
          phase: "read_list",
          outcome: "rate_limited",
          error_code: "RATE_LIMITED",
          request_id: listRequestId,
          user_id: userId,
          scope: "read",
          latency_ms: Date.now() - listStartedAt,
        });
        sendRateLimited(res, listVerdict);
        return;
      }
      let screenRef;
      try {
        screenRef = resolveReadScreen(body?.screen);
      } catch (err) {
        sendJson(res, 400, { ok: false, code: err?.code ?? "UNKNOWN_READ_SCREEN", error: err?.message ?? String(err) });
        return;
      }
      // P8: the same authorization boundary the /ask pipeline uses, checked
      // against the capability the SCREEN declares it composes. READ
      // capabilities declare no permission requirement today, so this is a
      // pass-through now — but the day an operator pins one (or a screen is
      // added over a scoped capability), the drill-down is already behind the
      // gate instead of being a second, unguarded read path.
      // The SAME rule /execute learned the hard way: an unexpected throw inside
      // an async handler becomes an unhandled rejection and takes the whole
      // gateway down (during A1 a missing import did exactly that). Refuse
      // loudly instead — a dead process also kills /ask.
      let listAuthz;
      try {
        listAuthz = authorize(screenRef.screen.capability, {
          principal,
          company: body?.company,
          env,
        });
      } catch (err) {
        sendJson(res, 500, {
          ok: false,
          code: "READ_LIST_UNEXPECTED_ERROR",
          error: `lỗi không mong đợi khi kiểm tra quyền: ${err?.message ?? err}`,
        });
        return;
      }
      if (!listAuthz.ok) {
        logEvent({
          phase: "read_list",
          outcome: "error",
          error_code: listAuthz.code,
          request_id: listRequestId,
          user_id: userId,
          capability: screenRef.screen.capability,
          screen: screenRef.id,
          latency_ms: Date.now() - listStartedAt,
        });
        sendJson(res, 403, { ok: false, code: listAuthz.code, error: listAuthz.error });
        return;
      }
      // Client lifecycle is owned here (the view module holds no process), same
      // shape the /ask pipeline uses, and the child is closed on every path.
      const listMcp = createMcpClient({ serverScript: pickServerScript() });
      try {
        await listMcp.initialize();
        const view = await readScreen({
          mcp: listMcp,
          screenId: screenRef.id,
          entityId: body?.entity_id,
          limit: body?.limit,
          erpTarget: erpTargetLabel(process.env),
        });
        sendJson(res, 200, { ok: true, result: view });
        logEvent({
          phase: "read_list",
          outcome: "read_served",
          request_id: listRequestId,
          user_id: userId,
          capability: screenRef.screen.capability,
          screen: screenRef.id,
          rows: view.rows.length,
          truncated: view.truncated,
          latency_ms: Date.now() - listStartedAt,
        });
      } catch (err) {
        const code = err?.code ?? "READ_LIST_FAILED";
        // A refusal the caller can act on is a 4xx; anything else (ERPNext
        // unreachable through the tunnel) is a 503 and says so.
        const status =
          code === "UNKNOWN_READ_SCREEN" || code === "MISSING_ENTITY_ID"
            ? 400
            : code === "CUSTOMER_NOT_FOUND"
              ? 404
              : 503;
        sendJson(res, status, { ok: false, code, error: err?.message ?? String(err) });
        logEvent({
          phase: "read_list",
          outcome: "error",
          error_code: code,
          request_id: listRequestId,
          user_id: userId,
          capability: screenRef.screen.capability,
          screen: screenRef.id,
          latency_ms: Date.now() - listStartedAt,
        });
      } finally {
        await listMcp.close();
      }
      return;
    }
    if ((req.method === "GET" || req.method === "POST") && path === "/read/daily-summary") {
      // P4-2 (plan4_final §4.2): the drawer's OWN read route — the capability id
      // is GIVEN, never inferred. This route never calls the NLP service or the
      // /ask pipeline (asserted by a static tripwire), so no phrase that merely
      // sounds like "tổng hợp hôm nay" can talk its way into another company's
      // books, and the drawer costs one ERP aggregate instead of a full pipeline.
      //
      // Ordering, same as /read/list: parse (a malformed request must not spend
      // a token) → throttle → authorize → only then touch ERPNext.
      let body = {};
      try {
        if (req.method === "POST") {
          const raw = await readBody(req);
          body = raw ? JSON.parse(raw) : {};
        }
      } catch (err) {
        sendJson(res, 400, { ok: false, code: "BAD_REQUEST", error: `invalid request body: ${err?.message ?? err}` });
        return;
      }
      const params = new URL(req.url ?? "/", "http://localhost").searchParams;
      // date: optional in BOTH shapes (§4.2 "body/query"); body wins when a POST
      // carries both. Absent/empty = today at the shop (not the host's today).
      const rawDate = body?.date ?? params.get("date") ?? null;
      const dateProblem = summaryDateProblem(rawDate);
      if (dateProblem) {
        sendJson(res, 400, { ok: false, code: "INVALID_DATE", error: dateProblem });
        return;
      }
      const date = typeof rawDate === "string" && rawDate ? rawDate : vnToday();
      // company: NOT an input (plan4_final §4.1). A claim is still checked below
      // rather than silently ignored — answering from another company's books
      // while the caller believes it asked for a specific one is a money
      // surprise, not a convenience.
      const claimedCompany = body?.company ?? params.get("company") ?? null;
      if (claimedCompany !== null && typeof claimedCompany !== "string") {
        sendJson(res, 400, {
          ok: false,
          code: "INVALID_COMPANY",
          error: `company phải là chuỗi (nhận ${JSON.stringify(claimedCompany)})`,
        });
        return;
      }
      const dayStartedAt = Date.now();
      const dayRequestId = randomUUID();
      // P10 slice: the READ bucket — the expensive part is one ERP aggregate,
      // which is exactly what a drawer on pull-to-refresh would exhaust.
      const dayVerdict = rateLimiter.chargeUser("read", userId);
      if (!dayVerdict.ok) {
        logEvent({
          phase: "read_daily_summary",
          outcome: "rate_limited",
          error_code: "RATE_LIMITED",
          request_id: dayRequestId,
          user_id: userId,
          scope: "read",
          latency_ms: Date.now() - dayStartedAt,
        });
        sendRateLimited(res, dayVerdict);
        return;
      }
      // Authorization BEFORE any ERPNext read: a denied account must trigger
      // zero ERP calls (the same rule /read/list follows). `company` is NOT
      // passed here on purpose — configuration only, so the client's word can
      // never widen scope on a deployment that pinned its company.
      let dayAuthz;
      try {
        dayAuthz = authorize("ops.daily_summary", { principal, env });
      } catch (err) {
        sendJson(res, 500, {
          ok: false,
          code: "READ_DAILY_SUMMARY_UNEXPECTED_ERROR",
          error: `lỗi không mong đợi khi kiểm tra quyền: ${err?.message ?? err}`,
        });
        return;
      }
      if (!dayAuthz.ok) {
        logEvent({
          phase: "read_daily_summary",
          outcome: "error",
          error_code: dayAuthz.code,
          request_id: dayRequestId,
          user_id: userId,
          latency_ms: Date.now() - dayStartedAt,
        });
        sendJson(res, 403, { ok: false, code: dayAuthz.code, error: dayAuthz.error });
        return;
      }
      // `pickServerScript()` and the spawn live INSIDE the try on purpose: an
      // throw here (ERPNEXT_NOT_CONFIGURED after a broken deploy, a spawn
      // failure) would otherwise reject the async listener itself, and Node
      // exits on an unhandled rejection — one bad drawer request would take
      // /ask down with it. This route can refuse; it may not kill the service.
      let dayMcp = null;
      try {
        dayMcp = createMcpClient({ serverScript: pickServerScript() });
        await dayMcp.initialize();
        // Config pin → ERPNext session default → refusal. Shared with
        // /read/drill so both routes answer "whose books am I reading?" the same
        // way (this is a trust boundary, see resolveReadCompany).
        const resolved = await resolveReadCompany({
          mcp: dayMcp,
          principal,
          env,
          capabilityId: "ops.daily_summary",
          authorizedCompany: dayAuthz.company,
        });
        if (!resolved.ok) {
          if (resolved.status === 503) {
            logEvent({
              phase: "read_daily_summary",
              outcome: "error",
              error_code: resolved.code,
              request_id: dayRequestId,
              user_id: userId,
              latency_ms: Date.now() - dayStartedAt,
            });
          }
          sendJson(res, resolved.status, { ok: false, code: resolved.code, error: resolved.error });
          return;
        }
        const company = resolved.company;
        const companySource = resolved.source;
        if (claimedCompany && claimedCompany !== company) {
          logEvent({
            phase: "read_daily_summary",
            outcome: "error",
            error_code: "COMPANY_SCOPE_MISMATCH",
            request_id: dayRequestId,
            user_id: userId,
            latency_ms: Date.now() - dayStartedAt,
          });
          sendJson(res, 403, {
            ok: false,
            code: "COMPANY_SCOPE_MISMATCH",
            error:
              `client xin company "${claimedCompany}" nhưng server chỉ đọc "${company}" — ` +
              "client không đặt được company (plan4_final §4.1)",
          });
          return;
        }
        // The §4.3 object goes back VERBATIM — including `meta.partial` + each
        // null block with its error. Rewriting it here would be a second
        // aggregate, and the Flutter side is required to show per-block errors.
        // The ERP target travels with the numbers (meta.erp_target). Read from
        // the SAME expression the startup line uses — process.env, i.e. exactly
        // what `pickServerScript()` above just decided on — so a footer that
        // says REAL can never contradict the log an operator is looking at.
        const summary = await getDailySummary(dayMcp, {
          date,
          company,
          erpTarget: erpTargetLabel(process.env),
        });
        sendJson(res, 200, summary);
        logEvent({
          phase: "read_daily_summary",
          outcome: "read_served",
          request_id: dayRequestId,
          user_id: userId,
          date,
          company_source: companySource,
          partial: summary?.meta?.partial === true,
          errors: (summary?.meta?.errors ?? []).map((e) => e.block).join(","),
          latency_ms: Date.now() - dayStartedAt,
        });
      } catch (err) {
        const code = dailySummaryErrorCode(err);
        // A refusal the caller can act on is a 4xx; a config gap or an
        // unreachable ERPNext is a 503 and says so. Partial days do NOT land
        // here — they are a 200 with `meta.partial` (the skill's contract).
        const status = code === "OPS_DATE_REQUIRED" || code === "INVALID_DATE" ? 400 : 503;
        sendJson(res, status, { ok: false, code, error: err?.message ?? String(err) });
        logEvent({
          phase: "read_daily_summary",
          outcome: "error",
          error_code: code,
          // The honest detail stays in the trail even when the client code is
          // generic: an operator debugging a 503 needs TOOL_ERROR vs
          // COMPANY_UNRESOLVED, not the vocabulary the drawer renders.
          detail: String(err?.message ?? err).slice(0, 200),
          request_id: dayRequestId,
          user_id: userId,
          date,
          latency_ms: Date.now() - dayStartedAt,
        });
      } finally {
        // Closing a client that never spawned must not mask the refusal above
        // (its own error is the one the caller has to see).
        await dayMcp?.close?.().catch(() => {});
      }
      return;
    }
    // D3 (drawer-plan-final §3.4) — `/read/app-drafts` is the SAME aggregate the
    // `app_drafts_today` drill serves, under the name the plan itself uses. It
    // is an ALIAS, not a second implementation: one code path means the two can
    // never disagree (the drift this project already paid for once). The id is
    // PINNED here — a client sending `?drill_id=…` on this route still gets the
    // drafts aggregate, because this route IS the id (§4.4: the client never
    // picks a screen by text, and it cannot pick one here either).
    const isAppDraftsAlias = path === "/read/app-drafts";
    if ((req.method === "GET" || req.method === "POST") && (path === "/read/drill" || isAppDraftsAlias)) {
      // P4-4 — the day drill behind tapping a metric on the summary screen.
      //
      // The input is an ID FROM A CLOSED SET, never a phrase: §4.4 forbids the
      // default path of "inject free text → classifier → guess the capability",
      // and this route has no classifier in it at all (static tripwire). The id
      // is matched literally against `drill_screens` in the contract.
      //
      // Ordering, same as the routes above: parse + validate the input (a
      // malformed request must not spend a token), throttle, authorize against
      // the capability the contract names for THIS drill, then touch ERPNext.
      let body = {};
      try {
        if (req.method === "POST") {
          const raw = await readBody(req);
          body = raw ? JSON.parse(raw) : {};
        }
      } catch (err) {
        sendJson(res, 400, { ok: false, code: "BAD_REQUEST", error: `invalid request body: ${err?.message ?? err}` });
        return;
      }
      const drillParams = new URL(req.url ?? "/", "http://localhost").searchParams;
      const rawDrillId = isAppDraftsAlias
        ? "app_drafts_today"
        : body?.drill_id ?? drillParams.get("drill_id") ?? null;
      if (typeof rawDrillId !== "string" || rawDrillId.trim() === "") {
        sendJson(res, 400, {
          ok: false,
          code: "MISSING_DRILL_ID",
          error: "thiếu drill_id — màn này mở từ một chỉ số trên Tóm tắt ngày, không nhận câu chữ",
        });
        return;
      }
      // Resolve BEFORE charging the bucket: an id nobody declared is a
      // malformed request, not a read the shop paid for.
      let drillRef;
      try {
        drillRef = resolveDrillScreen(rawDrillId);
      } catch (err) {
        sendJson(res, 400, {
          ok: false,
          code: err?.code ?? DRILL_VIEW_CODES.UNKNOWN_DRILL,
          error: err?.message ?? String(err),
        });
        return;
      }
      const rawDrillDate = body?.date ?? drillParams.get("date") ?? null;
      const drillDateProblem = summaryDateProblem(rawDrillDate);
      if (drillDateProblem) {
        sendJson(res, 400, { ok: false, code: "INVALID_DATE", error: drillDateProblem });
        return;
      }
      const drillDate = typeof rawDrillDate === "string" && rawDrillDate ? rawDrillDate : vnToday();
      const drillClaimedCompany = body?.company ?? drillParams.get("company") ?? null;
      if (drillClaimedCompany !== null && typeof drillClaimedCompany !== "string") {
        sendJson(res, 400, {
          ok: false,
          code: "INVALID_COMPANY",
          error: `company phải là chuỗi (nhận ${JSON.stringify(drillClaimedCompany)})`,
        });
        return;
      }
      const drillStartedAt = Date.now();
      const drillRequestId = randomUUID();
      const drillVerdict = rateLimiter.chargeUser("read", userId);
      if (!drillVerdict.ok) {
        logEvent({
          phase: "read_drill",
          outcome: "rate_limited",
          error_code: "RATE_LIMITED",
          request_id: drillRequestId,
          user_id: userId,
          drill: drillRef.id,
          scope: "read",
          latency_ms: Date.now() - drillStartedAt,
        });
        sendRateLimited(res, drillVerdict);
        return;
      }
      // Authorization BEFORE any ERPNext read, against the capability the
      // CONTRACT names for this drill — never against the id as if it were a
      // capability, and never against whatever the client says it is.
      let drillAuthz;
      try {
        drillAuthz = authorize(drillRef.drill.capability, { principal, env });
      } catch (err) {
        sendJson(res, 500, {
          ok: false,
          code: "READ_DRILL_UNEXPECTED_ERROR",
          error: `lỗi không mong đợi khi kiểm tra quyền: ${err?.message ?? err}`,
        });
        return;
      }
      if (!drillAuthz.ok) {
        logEvent({
          phase: "read_drill",
          outcome: "error",
          error_code: drillAuthz.code,
          request_id: drillRequestId,
          user_id: userId,
          drill: drillRef.id,
          latency_ms: Date.now() - drillStartedAt,
        });
        sendJson(res, 403, { ok: false, code: drillAuthz.code, error: drillAuthz.error });
        return;
      }
      // Same rule as /read/daily-summary: the client's spawn/config problems may
      // refuse a request, they may never kill the service.
      let drillMcp = null;
      try {
        drillMcp = createMcpClient({ serverScript: pickServerScript() });
        await drillMcp.initialize();
        const resolved = await resolveReadCompany({
          mcp: drillMcp,
          principal,
          env,
          capabilityId: drillRef.drill.capability,
          authorizedCompany: drillAuthz.company,
        });
        if (!resolved.ok) {
          if (resolved.status === 503) {
            logEvent({
              phase: "read_drill",
              outcome: "error",
              error_code: resolved.code,
              request_id: drillRequestId,
              user_id: userId,
              drill: drillRef.id,
              latency_ms: Date.now() - drillStartedAt,
            });
          }
          sendJson(res, resolved.status, { ok: false, code: resolved.code, error: resolved.error });
          return;
        }
        if (drillClaimedCompany && drillClaimedCompany !== resolved.company) {
          logEvent({
            phase: "read_drill",
            outcome: "error",
            error_code: "COMPANY_SCOPE_MISMATCH",
            request_id: drillRequestId,
            user_id: userId,
            drill: drillRef.id,
            latency_ms: Date.now() - drillStartedAt,
          });
          sendJson(res, 403, {
            ok: false,
            code: "COMPANY_SCOPE_MISMATCH",
            error:
              `client xin company "${drillClaimedCompany}" nhưng server chỉ đọc "${resolved.company}" — ` +
              "client không đặt được company (plan4_final §4.1)",
          });
          return;
        }
        const payload = await readDrill({
          // `env` (the server's config surface — the same object `principal`
          // resolution and COPILOT_COMPANY pinning read) is what D2's
          // COPILOT_DEFAULT_WAREHOUSE pin must come from: a per-request `env`
          // in tests would otherwise be invisible to the drill and the pin
          // would read as missing (the exact failure mode "config silently
          // absent" §5 forbids).
          env,
          mcp: drillMcp,
          drillId: drillRef.id,
          date: drillDate,
          // D4 — the SHOP's today, so a day-scoped drill's title can say "hôm
          // nay"/"hôm qua" from the server's own clock. It names nothing the
          // read depends on: the rows come from `date` alone.
          today: vnToday(),
          company: resolved.company,
          limit: body?.limit ?? drillParams.get("limit"),
          // Same expression the startup line and /read/daily-summary use, so a
          // screen that refuses to render cannot disagree with the log.
          erpTarget: erpTargetLabel(process.env),
        });
        sendJson(res, 200, payload);
        logEvent({
          phase: "read_drill",
          outcome: "read_served",
          request_id: drillRequestId,
          user_id: userId,
          drill: drillRef.id,
          date: drillDate,
          company_source: resolved.source,
          total_documents: payload.total_documents,
          truncated: payload.truncated,
          latency_ms: Date.now() - drillStartedAt,
        });
      } catch (err) {
        // An undeclared drill (contract changed under a running process) is a
        // 400 the caller can act on; anything else is the same vocabulary the
        // day summary uses (a config gap or an unreachable ERPNext is a 503).
        const code = err?.code === DRILL_VIEW_CODES.UNKNOWN_DRILL ? DRILL_VIEW_CODES.UNKNOWN_DRILL : dailySummaryErrorCode(err);
        const status = code === DRILL_VIEW_CODES.UNKNOWN_DRILL || code === "INVALID_DATE" ? 400 : 503;
        sendJson(res, status, { ok: false, code, error: err?.message ?? String(err) });
        logEvent({
          phase: "read_drill",
          outcome: "error",
          error_code: code,
          detail: String(err?.message ?? err).slice(0, 200),
          request_id: drillRequestId,
          user_id: userId,
          drill: drillRef.id,
          latency_ms: Date.now() - drillStartedAt,
        });
      } finally {
        await drillMcp?.close?.().catch(() => {});
      }
      return;
    }
    if (req.method === "POST" && path === "/ocr") {
      // C1 — the camera channel (plan3 §6.3): "Camera → OCR → slots → CÙNG
      // pipeline capability/Safety". What this route returns is TEXT plus how
      // trustworthy the read was; deciding what to DO with it stays with the
      // user (they edit it in the chat) and later with the normal pipeline.
      //
      // Ordering is the point, as on every other route: throttle, then read the
      // provider configuration (fail LOUD on a broken one), then run the seam,
      // which sanitises + bounds the text BEFORE anything downstream sees it.
      //
      // There is no capability to authorize against here: a photo the caller
      // just took is not ERPNext data, and no capability id is trusted from it
      // (contract: ocr_policy.authoritative_identifiers = false).
      let body;
      try {
        const raw = await readBody(req);
        body = raw ? JSON.parse(raw) : {};
      } catch (err) {
        sendJson(res, 400, { ok: false, code: "BAD_REQUEST", error: `invalid request body: ${err?.message ?? err}` });
        return;
      }
      const ocrStartedAt = Date.now();
      const ocrRequestId = randomUUID();
      // The READ bucket, deliberately: OCR is ONE expensive external call per
      // request, and a burst of photos would exhaust the budget the same way a
      // burst of screens does. (A dedicated bucket would mean extending the
      // limiter's frozen USER_BUCKETS + its tests; the contract can declare one
      // when OCR traffic needs its own budget.)
      const ocrVerdict = rateLimiter.chargeUser("read", userId);
      if (!ocrVerdict.ok) {
        logEvent({
          phase: "ocr",
          outcome: "rate_limited",
          error_code: "RATE_LIMITED",
          request_id: ocrRequestId,
          user_id: userId,
          scope: "read",
          latency_ms: Date.now() - ocrStartedAt,
        });
        sendRateLimited(res, ocrVerdict);
        return;
      }
      // The INPUT contract is checked here, before a provider is even chosen:
      // the mock deliberately ignores its input (so CI is deterministic), and a
      // route that only validated inside the real provider would answer a
      // request with no image at all with a canned "reading". An image is
      // required on every provider — that belongs to the route, not the vendor.
      try {
        assertOcrInput({ image: body?.image, mimeType: body?.mime_type });
      } catch (err) {
        sendJson(res, err?.code === "OCR_INPUT_TOO_LARGE" ? 413 : 400, {
          ok: false,
          code: err?.code ?? "OCR_INPUT_INVALID",
          error: err?.message ?? String(err),
        });
        logEvent({
          phase: "ocr",
          outcome: "error",
          error_code: err?.code ?? "OCR_INPUT_INVALID",
          request_id: ocrRequestId,
          user_id: userId,
          latency_ms: Date.now() - ocrStartedAt,
        });
        return;
      }
      let ocrProvider;
      try {
        ocrProvider = getOcrProvider(env);
      } catch (err) {
        // An operator error must be LOUD: falling back to the mock here would
        // look exactly like "the photo had no text" to the person holding the
        // phone. Same stance as PARTIAL_ERPNEXT_CONFIG on the MCP client.
        sendJson(res, 500, {
          ok: false,
          code: err?.code ?? "OCR_PROVIDER_MISCONFIGURED",
          error: err?.message ?? String(err),
        });
        logEvent({
          phase: "ocr",
          outcome: "error",
          error_code: err?.code ?? "OCR_PROVIDER_MISCONFIGURED",
          request_id: ocrRequestId,
          user_id: userId,
          latency_ms: Date.now() - ocrStartedAt,
        });
        return;
      }
      // The same last-resort law as every other async route here: an unexpected
      // throw inside an async handler is an unhandled rejection and Node exits,
      // which would take /ask and /execute down with it.
      try {
        const result = await ocrProvider.recognize({
          image: body?.image,
          mimeType: body?.mime_type,
          hint: body?.hint,
        });
        const prepared = prepareOcrText(result);
        // Metadata ONLY — never the image, never the recognised text body.
        process.stderr.write(`${ocrLogLine({ result, prepared, image: body?.image, ms: prepared ? Date.now() - ocrStartedAt : null })}\n`);
        const outcome = prepared.status === "OK" ? "ocr_served" : prepared.status === "LOW_CONFIDENCE" ? "low_confidence" : "ocr_unreadable";
        logEvent({
          phase: "ocr",
          outcome,
          request_id: ocrRequestId,
          user_id: userId,
          provider: prepared.provider ?? null,
          model: prepared.model ?? null,
          status: prepared.status,
          confidence: prepared.confidence,
          chars: prepared.text.length,
          instruction_pattern: prepared.instruction_pattern_found,
          latency_ms: Date.now() - ocrStartedAt,
        });
        // `wrapped` is deliberately NOT returned: it exists for building a model
        // prompt server-side, and the client has no reason to hold it.
        sendJson(res, 200, {
          ok: true,
          result: {
            status: prepared.status,
            text: prepared.text,
            usable: prepared.usable,
            confidence: prepared.confidence,
            min_confidence: prepared.min_confidence,
            instruction_pattern_found: prepared.instruction_pattern_found,
            provider: prepared.provider,
            model: prepared.model,
            // Said out loud so the client (and C2, before it ever builds a
            // proposal) can refuse to treat a SIMULATED reading as a real one:
            // the mock is the default provider, and its text is a fixture, not
            // the user's document.
            mock: prepared.provider === "mock",
          },
        });
      } catch (err) {
        const code = err?.code ?? "OCR_FAILED";
        // 400 = the CALLER's input is wrong (type/size/missing image),
        // 502 = the provider answered with something unusable,
        // 503 = the provider could not be reached (retryable).
        const status =
          code === "OCR_INPUT_INVALID" ? 400 : code === "OCR_INPUT_TOO_LARGE" ? 413 : code === "OCR_RESULT_INVALID" ? 502 : 503;
        sendJson(res, status, { ok: false, code, error: err?.message ?? String(err) });
        logEvent({
          phase: "ocr",
          outcome: "error",
          error_code: code,
          request_id: ocrRequestId,
          user_id: userId,
          latency_ms: Date.now() - ocrStartedAt,
        });
      }
      return;
    }
    if (req.method === "POST" && path === "/ocr/slots") {
      // C2 (`plan3` Trụ C §6.1/§6.3) — the missing half of the camera flow.
      //
      // A photo carries no verb (measured: an invoice reading routes to
      // `invoice.lookup` on the real path), so the user picks the DOCUMENT KIND
      // on the sheet and this route turns the reading into SLOTS — what the
      // photo appears to say, in the same shape the builder parses. The user
      // corrects them, and the corrected sentence then travels the ONE existing
      // pipeline. Nothing here builds a proposal, reads a price, or writes.
      //
      // Ordering is the safety argument, again: throttle → validate the KIND
      // against the contract → refuse an unverifiable reading (BEFORE any
      // ERPNext read) → authorize the capability the kind maps to → only then
      // read master data.
      let body;
      try {
        const raw = await readBody(req);
        body = raw ? JSON.parse(raw) : {};
      } catch (err) {
        sendJson(res, 400, { ok: false, code: "BAD_REQUEST", error: `invalid request body: ${err?.message ?? err}` });
        return;
      }
      const slotsStartedAt = Date.now();
      const slotsRequestId = randomUUID();
      const slotsVerdict = rateLimiter.chargeUser("read", userId);
      if (!slotsVerdict.ok) {
        logEvent({
          phase: "ocr_slots",
          outcome: "rate_limited",
          error_code: "RATE_LIMITED",
          request_id: slotsRequestId,
          user_id: userId,
          scope: "read",
          latency_ms: Date.now() - slotsStartedAt,
        });
        sendRateLimited(res, slotsVerdict);
        return;
      }
      // The kind is a WORD from a fixed contract list — never a capability id.
      let slotsSpec;
      try {
        slotsSpec = kindSpec(body?.kind);
      } catch (err) {
        sendJson(res, 400, { ok: false, code: err?.code ?? OCR_SLOTS_CODES.KIND_UNKNOWN, error: err?.message ?? String(err) });
        return;
      }
      // The text travelled VIA THE CLIENT, so the C0 bound is re-enforced HERE:
      // nothing on the client trip guarantees `ocr_policy.max_text_length`, and
      // an oversized reading would push NLP, the item matcher and the party
      // resolver (quadratic in words) through a heavy request for free.
      try {
        assertSlotsText(body?.text);
      } catch (err) {
        sendJson(res, 400, { ok: false, code: err?.code ?? OCR_SLOTS_CODES.READ_TOO_LONG, error: err?.message ?? String(err) });
        return;
      }
      // The reading must be CONFIDENT and REAL before a whole form is offered.
      // This is the false-write guard of C2: a mock reading (the default
      // provider!) or a low-confidence one can never become a draft document.
      let slotsProvenance;
      try {
        slotsProvenance = assertSlotsProvenance(body?.ocr);
      } catch (err) {
        const code = err?.code ?? OCR_SLOTS_CODES.READ_UNVERIFIED;
        sendJson(res, code === OCR_SLOTS_CODES.READ_UNVERIFIED ? 400 : 409, {
          ok: false,
          code,
          error: err?.message ?? String(err),
        });
        logEvent({
          phase: "ocr_slots",
          outcome: "error",
          error_code: code,
          request_id: slotsRequestId,
          user_id: userId,
          capability: slotsSpec.capability,
          latency_ms: Date.now() - slotsStartedAt,
        });
        return;
      }
      let slotsAuthz;
      try {
        slotsAuthz = authorize(slotsSpec.capability, {
          principal,
          company: body?.company,
          env,
        });
      } catch (err) {
        sendJson(res, 500, {
          ok: false,
          code: "OCR_SLOTS_UNEXPECTED_ERROR",
          error: `lỗi không mong đợi khi kiểm tra quyền: ${err?.message ?? err}`,
        });
        return;
      }
      if (!slotsAuthz.ok) {
        logEvent({
          phase: "ocr_slots",
          outcome: "error",
          error_code: slotsAuthz.code,
          request_id: slotsRequestId,
          user_id: userId,
          capability: slotsSpec.capability,
          latency_ms: Date.now() - slotsStartedAt,
        });
        sendJson(res, 403, { ok: false, code: slotsAuthz.code, error: slotsAuthz.error });
        return;
      }
      const slotsMcp = createMcpClient({ serverScript: pickServerScript() });
      try {
        await slotsMcp.initialize();
        // The reading itself is the only text input: already sanitised and
        // bounded by the C0 seam before it ever reached the client.
        const rawText = typeof body?.text === "string" ? body.text : "";
        const nlp = await normalizeText(rawText);
        const rowsOf = (res) => res?.data?.data ?? [];
        const items = rowsOf(await findItem(slotsMcp, ""));
        const parties = slotsSpec.party === "supplier"
          ? rowsOf(await findSupplier(slotsMcp))
          : rowsOf(await customerSkill.findCustomer(slotsMcp, "", new Set()));
        const slots = extractSlots({ text: rawText, spec: slotsSpec, nlp, items, parties });
        if (slots.empty) {
          logEvent({
            phase: "ocr_slots",
            outcome: "error",
            error_code: OCR_SLOTS_CODES.SLOTS_EMPTY,
            request_id: slotsRequestId,
            user_id: userId,
            capability: slotsSpec.capability,
            latency_ms: Date.now() - slotsStartedAt,
          });
          sendJson(res, 422, {
            ok: false,
            code: OCR_SLOTS_CODES.SLOTS_EMPTY,
            error: "ảnh không cho ra người nhận và dòng hàng nào — nhập tay giúp tôi",
          });
          return;
        }
        sendJson(res, 200, {
          ok: true,
          result: {
            ...slots,
            provenance: {
              from_photo: true,
              provider: body?.ocr?.provider ?? null,
              model: body?.ocr?.model ?? null,
              confidence: slotsProvenance.confidence,
              min_confidence: slotsProvenance.min_confidence,
            },
          },
        });
        logEvent({
          phase: "ocr_slots",
          outcome: "slots_served",
          request_id: slotsRequestId,
          user_id: userId,
          capability: slotsSpec.capability,
          kind: body?.kind,
          lines: slots.lines.length,
          party_resolved: slots.party.resolved != null,
          ambiguous: slots.party.ambiguous,
          warnings: slots.warnings.map((w) => w.code),
          latency_ms: Date.now() - slotsStartedAt,
        });
      } catch (err) {
        const code = err?.code ?? "OCR_SLOTS_FAILED";
        // A refusal the caller can act on is a 4xx; anything else (NLP service
        // or ERPNext unreachable) is a 503 and says so.
        const status =
          code === OCR_SLOTS_CODES.KIND_UNKNOWN
            ? 400
            : code.startsWith("OCR_READ_")
              ? 409
              : 503;
        sendJson(res, status, { ok: false, code, error: err?.message ?? String(err) });
        logEvent({
          phase: "ocr_slots",
          outcome: "error",
          error_code: code,
          request_id: slotsRequestId,
          user_id: userId,
          capability: slotsSpec.capability,
          latency_ms: Date.now() - slotsStartedAt,
        });
      } finally {
        await slotsMcp.close();
      }
      return;
    }
    if (req.method === "POST" && path === "/input/einvoice") {
      // A2 (`.plan/next3/implementation.md` workstream A) — the SUPPLIER-FILE
      // channel: a HÓA ĐƠN ĐIỆN TỬ XML the shop received becomes SLOTS the user
      // corrects, exactly like a photo (C2).
      //
      // Two things are deliberately NOT here, and both are the point:
      //  * no proposal and no price — a rate only ever comes from ERPNext, so the
      //    file's own price is display-only;
      //  * no master data creation — an unknown supplier MST is a WARNING and a
      //    candidate list, never a `Supplier` insert (phases3 Cấm: no auto-create
      //    master).
      //
      // Ordering is the safety argument, same as every route: throttle → validate
      // the KIND against the contract → parse fail-closed → authorize the
      // capability → only then read master data.
      let body;
      try {
        const raw = await readBody(req);
        body = raw ? JSON.parse(raw) : {};
      } catch (err) {
        const tooLarge = /too large/i.test(String(err?.message ?? ""));
        sendJson(res, tooLarge ? 413 : 400, {
          ok: false,
          code: tooLarge ? EINVOICE_CODES.XML_TOO_LARGE : "BAD_REQUEST",
          error: tooLarge
            ? "file XML vượt trần dung lượng của gateway — gửi đúng file hóa đơn, không gửi kèm phụ lục/ảnh"
            : `invalid request body: ${err?.message ?? err}`,
        });
        return;
      }
      const einvoiceStartedAt = Date.now();
      const einvoiceRequestId = randomUUID();
      // The READ bucket: this route reads ERPNext master data (items + parties)
      // on every request, exactly like the camera's slot form.
      const einvoiceVerdict = rateLimiter.chargeUser("read", userId);
      if (!einvoiceVerdict.ok) {
        logEvent({
          phase: "einvoice_input",
          outcome: "rate_limited",
          error_code: "RATE_LIMITED",
          request_id: einvoiceRequestId,
          user_id: userId,
          scope: "read",
          latency_ms: Date.now() - einvoiceStartedAt,
        });
        sendRateLimited(res, einvoiceVerdict);
        return;
      }
      // A WORD from the contract's own list for THIS channel — never a
      // capability id, and never a kind the file channel does not offer.
      let einvoiceSpec;
      try {
        einvoiceSpec = einvoiceKindSpec(body?.kind);
      } catch (err) {
        sendJson(res, 400, {
          ok: false,
          code: err?.code ?? EINVOICE_SLOTS_CODES.KIND_UNKNOWN,
          error: err?.message ?? String(err),
        });
        return;
      }
      // A3: which READER does this request need? The body carries either `xml`
      // (the file's own text) or `pdf_base64` (the file's bytes), never both — and
      // the choice is refused rather than guessed when both arrive, because the two
      // are two readings of ONE document: picking silently means the user confirms
      // a document that is not the file they attached. No new route, no second
      // pipeline: both readers return the SAME `parsed` shape and everything below
      // (slots → form → composed sentence → /ask → proposal → confirm → gateway)
      // is untouched.
      const hasXml = typeof body?.xml === "string" && body.xml.trim() !== "";
      const hasPdf = typeof body?.pdf_base64 === "string" && body.pdf_base64.trim() !== "";
      if (hasXml && hasPdf) {
        const code = EINVOICE_SLOTS_CODES.INPUT_AMBIGUOUS;
        sendJson(res, 400, {
          ok: false,
          code,
          error:
            "yêu cầu gửi CẢ xml và pdf_base64 — chỉ gửi một file; hệ thống không tự chọn giúp bạn",
        });
        logEvent({
          phase: "einvoice_input",
          outcome: "error",
          error_code: code,
          request_id: einvoiceRequestId,
          user_id: userId,
          capability: einvoiceSpec.capability,
          latency_ms: Date.now() - einvoiceStartedAt,
        });
        return;
      }

      // Parse + completeness in ONE gate: the parser reports what it could not
      // read, and an incomplete file is refused BEFORE any ERPNext read instead
      // of becoming a form with invisible gaps.
      let parsed;
      try {
        parsed = hasPdf
          ? parseEinvoicePdf(body.pdf_base64, { policy: einvoicePolicy() })
          : parseEinvoiceXml(body?.xml, { policy: einvoicePolicy() });
        assertParsedComplete(parsed);
      } catch (err) {
        const code = err?.code ?? EINVOICE_CODES.XML_MALFORMED;
        // 400 = the CALLER's file/request is not readable (not XML / not a PDF /
        //       not an invoice at all / over the size cap);
        // 413 = readable format, over the cap (the policy's own code, not a
        //       transport error);
        // 422 = it IS a document, but not enough of one to build a form from — a
        //       scanned PDF, an encrypted one, an incomplete reading. The user is
        //       pointed at the camera/manual path and NOTHING is guessed.
        const status =
          code === EINVOICE_CODES.XML_TOO_LARGE ||
          code === PDF_CODES.TOO_LARGE ||
          // M1 (2026-09-25): 413 is about SIZE, and this refusal is a size refusal
          // too — the file was small enough to send and too big to decompress.
          code === PDF_CODES.INFLATED_TOO_LARGE ||
          // L1: same family — a text layer this long is a resource refusal, not a
          // "your scan needs OCR" 422.
          code === PDF_CODES.TOO_MANY_LINES
            ? 413
            : code === EINVOICE_SLOTS_CODES.INVOICE_INCOMPLETE ||
                code === PDF_CODES.NO_TEXT ||
                code === PDF_CODES.ENCRYPTED ||
                code === PDF_CODES.COMPRESSED_OBJECTS ||
                code === PDF_CODES.TEXT_UNMAPPED ||
                code === PDF_CODES.UNSUPPORTED_FILTER ||
                code === PDF_CODES.BROKEN
              ? 422
              : 400;
        sendJson(res, status, { ok: false, code, error: err?.message ?? String(err) });
        logEvent({
          phase: "einvoice_input",
          outcome: "error",
          error_code: code,
          request_id: einvoiceRequestId,
          user_id: userId,
          capability: einvoiceSpec.capability,
          lines_parsed: Array.isArray(parsed?.lines) ? parsed.lines.length : 0,
          problems: Array.isArray(parsed?.problems) ? parsed.problems.map((p) => p.code) : [],
          latency_ms: Date.now() - einvoiceStartedAt,
        });
        return;
      }
      let einvoiceAuthz;
      try {
        einvoiceAuthz = authorize(einvoiceSpec.capability, {
          principal,
          company: body?.company,
          env,
        });
      } catch (err) {
        sendJson(res, 500, {
          ok: false,
          code: "EINVOICE_UNEXPECTED_ERROR",
          error: `lỗi không mong đợi khi kiểm tra quyền: ${err?.message ?? err}`,
        });
        return;
      }
      if (!einvoiceAuthz.ok) {
        logEvent({
          phase: "einvoice_input",
          outcome: "error",
          error_code: einvoiceAuthz.code,
          request_id: einvoiceRequestId,
          user_id: userId,
          capability: einvoiceSpec.capability,
          latency_ms: Date.now() - einvoiceStartedAt,
        });
        sendJson(res, 403, { ok: false, code: einvoiceAuthz.code, error: einvoiceAuthz.error });
        return;
      }
      const einvoiceMcp = createMcpClient({ serverScript: pickServerScript() });
      try {
        await einvoiceMcp.initialize();
        const rowsOf = (result) => result?.data?.data ?? [];
        const items = rowsOf(await findItem(einvoiceMcp, ""));
        // A2: the party list for an e-invoice MUST carry each row's `tax_id` —
        // the document's own business key. Measured 2026-09-23: the plain
        // supplier list tool drops that field, so this channel reads through
        // `erpnext_doc_list` (whitelisted, READ-only) instead. A supplier
        // whose master row has no MST simply falls back to name matching — the
        // resolver treats a null tax_id as "no claim to compare", never as a hit.
        const parties = einvoiceSpec.party === "supplier"
          ? rowsOf(await listSuppliersWithTaxId(einvoiceMcp))
          : rowsOf(await customerSkill.findCustomer(einvoiceMcp, "", new Set()));
        const slots = buildEinvoiceSlots({ parsed, spec: einvoiceSpec, items, parties });
        sendJson(res, 200, {
          ok: true,
          result: {
            ...slots,
            provenance: {
              from_file: true,
              // "einvoice_xml" or "einvoice_pdf" — which READER answered. It is
              // the same document identity on both, which is why the two channels
              // dedupe against each other (next3/B `business_doc_key`).
              source: parsed.source,
              invoice_no: parsed.header?.invoice_no ?? null,
              invoice_date: parsed.header?.invoice_date ?? null,
              // Metadata ONLY — the file's text is never echoed into the log, and
              // these two flags are how a reviewer sees what the parse found.
              instruction_pattern_found: parsed.instruction_pattern_found === true,
              parsed_lines: parsed.lines.length,
            },
          },
        });
        logEvent({
          phase: "einvoice_input",
          outcome: "slots_served",
          request_id: einvoiceRequestId,
          user_id: userId,
          capability: einvoiceSpec.capability,
          kind: body?.kind,
          source: parsed.source,
          invoice_no: parsed.header?.invoice_no ?? null,
          lines: slots.lines.length,
          party_resolved: slots.party.resolved != null,
          party_matched_by: slots.party.matched_by,
          ambiguous: slots.party.ambiguous,
          warnings: slots.warnings.map((w) => w.code),
          instruction_pattern_found: parsed.instruction_pattern_found === true,
          latency_ms: Date.now() - einvoiceStartedAt,
        });
      } catch (err) {
        // Anything that is not the caller's own bad file (a refusal handled
        // above) is an environment problem: NLP or ERPNext unreachable ⇒ 503.
        const code = err?.code ?? "EINVOICE_INPUT_FAILED";
        sendJson(res, 503, { ok: false, code, error: err?.message ?? String(err) });
        logEvent({
          phase: "einvoice_input",
          outcome: "error",
          error_code: code,
          request_id: einvoiceRequestId,
          user_id: userId,
          capability: einvoiceSpec.capability,
          latency_ms: Date.now() - einvoiceStartedAt,
        });
      } finally {
        await einvoiceMcp.close();
      }
      return;
    }
    if (req.method === "POST" && path === "/ask") {
      let text;
      let pickedEntityId = null;
      let submitNow = false;
      let sourceDocument = null;
      // NEXT6 §7/§8: optional, additive conversation correlation. Absent ⇒ no
      // change in behaviour (client cũ vẫn chạy); malformed ⇒ refused like
      // /dsh/ask refuses it. Never used as identity.
      let conversationId = null;
      // P8: the company the request claims, if any. Server configuration wins
      // over this (see authorization.resolveCompanyScope) — it can only fill a
      // gap on a deployment that has not pinned a company itself.
      let requestedCompany = null;
      try {
        const raw = await readBody(req);
        const parsed = raw ? JSON.parse(raw) : {};
        text = parsed?.text;
        requestedCompany = typeof parsed?.company === "string" && parsed.company.trim()
          ? parsed.company.trim()
          : null;
        conversationId = typeof parsed?.conversation_id === "string" && parsed.conversation_id.trim()
          ? parsed.conversation_id.trim()
          : null;
        if (conversationId && !isValidConversationId(conversationId)) {
          sendJson(res, 400, { ok: false, code: "DSH_GATEWAY_BAD_REQUEST", error: "conversation_id không hợp lệ" });
          return;
        }
        // P1 §4.2/§4.4: the client may send back the id the USER picked in the
        // candidate picker. It is validated server-side against a fresh ERPNext
        // read before it can become authoritative (never trusted as-is).
        pickedEntityId = typeof parsed?.entity_id === "string" && parsed.entity_id.trim() !== ""
          ? parsed.entity_id.trim()
          : null;
        // Submit-now setting as the app held it WHEN THIS QUESTION WAS ASKED —
        // the server freezes the value into the proposal snapshot (payment-write
        // executor treats a submit failure as PARTIAL, not FAILED).
        submitNow = parsed?.submit_now === true;
        // next3/B: the document identity, when the sentence came from a file or
        // a photo. Validated HERE (not trusted, not "best effort"): the whole
        // value of it is that the invoice is known exactly.
        if (parsed?.source_document != null) {
          const verdict = validateSourceDocument(parsed.source_document, {
            allowedKinds: declaredDocumentKinds(),
          });
          if (!verdict.ok) {
            sendJson(res, 400, { ok: false, code: verdict.code, reason: verdict.reason, error: verdict.error });
            return;
          }
          sourceDocument = verdict.value;
        }
      } catch (err) {
        sendJson(res, 400, { ok: false, error: `invalid request body: ${err.message}` });
        return;
      }
      if (typeof text !== "string" || text.trim().length === 0) {
        sendJson(res, 400, { ok: false, error: "missing required field: text" });
        return;
      }
      // P10 slice (§24.3): the per-user READ bucket is charged before any
      // pipeline work — the expensive part (NLP + ERPNext reads) is exactly
      // what a burst would exhaust.
      const askStartedAt = Date.now();
      const requestId = randomUUID();
      const readVerdict = rateLimiter.chargeUser("read", userId);
      if (!readVerdict.ok) {
        logEvent({
          phase: "ask",
          outcome: "rate_limited",
          error_code: "RATE_LIMITED",
          request_id: requestId,
          user_id: userId,
          text: text.slice(0, 200),
          scope: "read",
          latency_ms: Date.now() - askStartedAt,
        });
        sendRateLimited(res, readVerdict);
        return;
      }
      let deadlineTimer;
      try {
        // Server-side deadline: a slow/hung pipeline (ERPNext via tunnel can
        // stall) must not hold the socket open forever. The Flutter client
        // times out at 15s and shows "Hết thời gian chờ", but without this
        // the server-side request would linger indefinitely, piling up
        // connections. 120s = generous multiple of the client timeout.
        // The losing timer is cleared in finally: Promise.race does NOT
        // cancel it, and an uncleared timer keeps the event loop alive for
        // the full 120s per request (broke node --test + clean shutdown).
        const result = await Promise.race([
          answerQuestionLogged(text, {
            pickedEntityId,
            submitNow, // frozen into the proposal snapshot at proposal time
            // next3/B: travels OUT OF BAND on purpose. The invoice number must
            // never go back into the sentence: `A-result.md` measured the NLP
            // reading "00049" as amount 49.
            sourceDocument,
            // P8: the ask path refuses a capability the account may not run,
            // BEFORE any skill/ERPNext work — so a card that could never be
            // confirmed is never built in the first place.
            principal,
            company: requestedCompany,
            env,
            // P10 §17: correlation columns for this question's log line
            // (command_id / action_id / risk come from the proposal).
            correlation: { request_id: requestId, user_id: userId, conversation_id: conversationId, latency_ms: Date.now() - askStartedAt },
          }),
          new Promise((_, reject) => {
            deadlineTimer = setTimeout(
              () => reject(new Error("ask deadline exceeded (120s)")),
              120_000,
            );
          }),
        ]);
        // A WRITE proposal is the entry point to the write path, so it is
        // metered too. Refusing HERE (before the card reaches the user) is what
        // keeps a throttled client from ever obtaining a command_id to
        // execute. NB: READ routes return a proposal object as well —
        // proposalBucketFor() keeps answering a question from spending the
        // user's write budget.
        const metered = proposalBucketFor(result?.proposal);
        if (metered) {
          const proposalVerdict = rateLimiter.chargeUser(metered, userId);
          if (!proposalVerdict.ok) {
            logEvent({
              phase: "ask",
              outcome: "rate_limited",
              error_code: "RATE_LIMITED",
              request_id: requestId,
              user_id: userId,
              text: text.slice(0, 200),
              scope: "write_proposal",
              latency_ms: Date.now() - askStartedAt,
            });
            sendRateLimited(res, proposalVerdict, { write: true });
            return;
          }
        }
        sendJson(res, 200, { ok: true, result });
      } catch (err) {
        // message only — never a stack trace, never env contents
        sendJson(res, 500, { ok: false, error: `ask failed: ${err?.message ?? err}` });
      } finally {
        if (deadlineTimer) clearTimeout(deadlineTimer);
      }
      return;
    }
    sendJson(res, 404, { ok: false, error: `no such path: ${req.method} ${path}` });
  });
  return server;
}

/**
 * Review finding F-A: enqueued jobs were never drained — nothing in the real
 * server called drain(), so a retryable 503 parked an intent FOREVER and the
 * P7 exit criterion (queued → VERIFIED/FAILED) only ever held inside tests.
 * This loop drains due jobs on a timer through the SAME Safety Gateway
 * (runExecute) — still exactly one write path. drain() never throws (runner
 * bugs become retryable verdicts), but the loop itself must survive anyway:
 * a failed tick is logged, not fatal.
 */
export function startJobRunner({ jobQueue, execute = runExecute, clock = Date.now } = {}) {
  if (!jobQueue.config.enabled) return null; // JOB_QUEUE=off: no queue, no runner
  // env-number law (451cd8f): finite AND positive or the default — a NaN
  // interval would degrade setInterval to 1ms and hammer the gateway.
  const raw = Number(process.env.JOB_QUEUE_POLL_MS);
  const intervalMs = Number.isFinite(raw) && raw > 0 ? raw : 15_000;
  let draining = false; // one drain at a time, no overlap
  const tick = () => {
    if (draining) return;
    draining = true;
    jobQueue.drain({ runExecute: execute })
      .then((outcomes) => {
        for (const o of outcomes) {
          process.stderr.write(`[jobs] ${o.command_id} → ${o.state}${o.error ? ` (${o.error})` : ""}\n`);
          // P10 slice §17: a retried WRITE is part of the money trail — it gets
          // the same correlation line as the original /execute attempt.
          const job = jobQueue.status(o.command_id);
          logEvent({
            phase: "job",
            outcome: jobOutcomeFor(o.state),
            error_code: o.error ? "JOB_RETRY_ERROR" : null,
            request_id: randomUUID(),
            user_id: "job-runner",
            command_id: o.command_id,
            action_id: job?.proposal?.action_id ?? null,
            erp_document_id: job?.proposal?.result?.erpnext_doc ?? null,
            job_state: o.state,
            attempts: job?.attempts ?? null,
            at_ms: clock(),
          });
        }
      })
      .catch((err) => process.stderr.write(`[jobs] drain failed: ${err?.message ?? err}\n`))
      .finally(() => { draining = false; });
  };
  const timer = setInterval(tick, intervalMs);
  timer.unref?.(); // the HTTP server owns the process lifetime, not the runner
  tick(); // crash-recovery: RETRYING jobs loaded from disk are due immediately
  return timer;
}

/** Job state → the same WRITE vocabulary the /execute path uses. */
function jobOutcomeFor(state) {
  switch (state) {
    case "VERIFIED": return "write_verified";
    case "FAILED": return "write_refused";
    case "CANCELLED": return "write_refused";
    default: return "write_retryable";
  }
}

export async function main(argv = process.argv.slice(2)) {
  const { port, host } = parseArgs(argv);
  const policy = resolveBindPolicy({ host }); // throws before listen on unsafe config
  // ERPNext target: REFUSE TO START when the config is missing (issue1_fix1 +
  // user decision 2026-09-21). Same posture as resolveBindPolicy just above:
  // throw BEFORE listen, so a launcher that forgot to export ERPNEXT_* exits
  // with a clear reason instead of serving a process whose every request would
  // fail — and never falls back to the fixture (which is opt-in only).
  //
  // Deliberately NOT a connectivity/auth probe: an unreachable ERPNext must keep
  // surfacing per request (a tunnel comes and goes; the service should not refuse
  // to boot because of a blip). This validates CONFIGURATION only.
  pickServerScript(); // throws ERPNEXT_NOT_CONFIGURED / PARTIAL_ERPNEXT_CONFIG / INVALID_ERPNEXT_URL
  // Same helper the drawer footer reads (via /read/daily-summary meta.erp_target):
  // one rule, so the log and the app can never disagree about which ERPNext
  // these numbers came from.
  const erpTarget = erpTargetLabel(process.env);
  process.stderr.write(
    `[http-ask] ERPNext target: ${
      erpTarget === "REAL" ? `REAL -> ${new URL(process.env.ERPNEXT_URL).host}` : "fixture (COPILOT_MOCK_OK=1)"
    }\n`,
  );
  // One shared queue instance for the HTTP layer and the runner below.
  const jobQueue = new JobQueue();
  const server = createAskServer({ port, host, policy, jobQueue });
  startJobRunner({ jobQueue });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  process.stdout.write(
    JSON.stringify({ ready: true, port: server.address().port, host, auth: !policy.loopback }) + "\n",
  );
  if (policy.public) {
    process.stderr.write(
      "[http-ask] WARNING: bound to a PUBLIC interface without TLS — credentials and " +
        "answers (customer names, debt amounts) travel in plaintext. Prefer a " +
        "Tailscale/VPN bind; Phase 5 gateway will own real transport security.\n",
    );
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    process.stderr.write(`[http-ask] fatal: ${err?.message ?? err}\n`);
    process.exit(1);
  });
}
