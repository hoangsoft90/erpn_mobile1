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
 *   POST /execute        -> Safety Gateway (confirm + execute one WRITE)
 *   POST /execute/cancel -> release a zombie PENDING command (reconcile-verified)
 *   GET  /jobs           -> pending + recent terminal jobs (P7)
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
import { answerQuestion, answerQuestionLogged, pickServerScript } from "./copilot-server.mjs";
import { logEvent, writeOutcomeFor } from "./learning-log.mjs";
import { AUTHZ_CODES, AUTHZ_MODES, checkPermissions, describeAuthorization, resolvePrincipal } from "./authorization.mjs";
import { RateLimiter, rateLimitMessage, proposalBucketFor } from "./rate-limit.mjs";
// The action → capability mapping lives with the contract (single source).
import { capabilityForAction } from "./capability-contract.mjs";
import { IdempotencyStore, isValidCommandId } from "./idempotency.mjs";
import { reconcilePaymentEntry } from "./skills/payment-write.mjs";
import { createMcpClient } from "./client.mjs";
import { runExecute } from "./safety-gateway.mjs";
import { JobQueue } from "./job-queue.mjs";
// DSH gateway (plan .plan/dsh_end_to_end.md): the EXPLICIT opt-in agent path.
// Imported here (and ONLY here) so the /ask pipeline itself never touches dsh —
// p5-dsh-optin.test.mjs keeps the static "no dsh spawn in the /ask pipeline"
// assertion, and the gateway lives behind its own route below.
import { dshGatewayAsk, DSH_IN_FLIGHT, isValidConversationId } from "./dsh-gateway.mjs";

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
          };
          if (outcome.code === DSH_IN_FLIGHT) {
            sendJson(res, 429, { ...payload, error: payload.error, retryable: true });
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
    if (req.method === "POST" && path === "/ask") {
      let text;
      let pickedEntityId = null;
      let submitNow = false;
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
            // P8: the ask path refuses a capability the account may not run,
            // BEFORE any skill/ERPNext work — so a card that could never be
            // confirmed is never built in the first place.
            principal,
            company: requestedCompany,
            env,
            // P10 §17: correlation columns for this question's log line
            // (command_id / action_id / risk come from the proposal).
            correlation: { request_id: requestId, user_id: userId, latency_ms: Date.now() - askStartedAt },
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
