/**
 * HTTP wrapper `/ask` — the phone-facing endpoint of the copilot pipeline.
 *
 * The Flutter chat client (Phase 3, apps/mobile) speaks plain HTTP; the
 * copilot pipeline (normalize -> route -> skill -> ERPNext) lives behind
 * answerQuestion() in copilot-server.mjs. This wrapper ONLY translates
 * HTTP <-> that function — no routing logic, no money logic, no new guard
 * surface (answerQuestion keeps every Phase 2 fail-safe).
 *
 * Endpoints:
 *   GET  /health -> {ok:true, service:"copilot-ask", port}
 *   POST /ask    -> body {"text": "..."} -> {ok:true, result:{answer...}}
 *                   missing/invalid text -> 400 {ok:false,error}
 *                   internal failure    -> 500 {ok:false,error} (no stack)
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
import { timingSafeEqual, createHash } from "node:crypto";
import { answerQuestion, pickServerScript } from "./copilot-server.mjs";
import { IdempotencyStore, fingerprintProposal, isValidCommandId, EXECUTABLE_ACTIONS } from "./idempotency.mjs";
import { executePaymentProposal } from "./skills/payment-write.mjs";
import { createMcpClient } from "./client.mjs";

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

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
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

export function createAskServer({ port = 8788, host = "127.0.0.1", policy = null, idemStore = null } = {}) {
  const bindPolicy = policy ?? resolveBindPolicy({ host });
  const store = idemStore ?? new IdempotencyStore();
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
    if (req.method === "POST" && path === "/execute") {
      // Phase 7 Stage A: the confirm-execute endpoint. MOCK ONLY today — the
      // mock MCP client accepts create_payment_entry; the REAL server run is
      // Stage B and user-gated. Same auth/bind policy as /ask.
      let body;
      try {
        const raw = await readBody(req);
        body = raw ? JSON.parse(raw) : {};
      } catch (err) {
        sendJson(res, 400, { ok: false, error: `invalid request body: ${err.message}` });
        return;
      }
      const { command_id, proposal } = body ?? {};
      if (!isValidCommandId(command_id)) {
        sendJson(res, 400, { ok: false, error: "command_id must be a client-generated UUID" });
        return;
      }
      if (!proposal || typeof proposal !== "object" || proposal.action !== "create_payment_entry") {
        sendJson(res, 400, { ok: false, error: "only create_payment_entry proposals are executable in Phase 7" });
        return;
      }
      if (!EXECUTABLE_ACTIONS.includes(proposal.action)) {
        sendJson(res, 403, { ok: false, error: "action not executable" });
        return;
      }
      if (!proposal.entity?.id) {
        sendJson(res, 400, { ok: false, error: "proposal entity has no resolved ERPNext id — resolve the customer first" });
        return;
      }
      const fp = fingerprintProposal(proposal);
      let gate;
      try {
        gate = store.begin(command_id, { action: proposal.action, fingerprint: fp });
      } catch (err) {
        sendJson(res, 409, { ok: false, error: err.message });
        return;
      }
      if (gate.replay) {
        // once-only guarantee: the FIRST execution's result is returned again
        sendJson(res, 200, { ok: true, replay: true, result: gate.result });
        return;
      }
      // PENDING (fresh or crash-recovered): reconcile before any new write.
      const existing = store.status(command_id);
      if (existing?.status === "PENDING" && existing.reference_no) {
        // A previous attempt may have died mid-write. ERPNext lookup by
        // reference_no decides: found ⇒ completed (no second write).
        // Stage A note: the mock client doesn't expose a lookup tool yet —
        // the Flutter/mock flow treats PENDING+reference as "verify first".
        // Stage B (real ERPNext) MUST implement the reference lookup here.
        sendJson(res, 409, {
          ok: false,
          error: "command PENDING with server reference — reconcile required before retry",
          command_id,
          reference_no: existing.reference_no,
        });
        return;
      }
      let mcp;
      try {
        mcp = createMcpClient({ serverScript: pickServerScript() });
        await mcp.initialize();
        const result = await executePaymentProposal(mcp, proposal, command_id, store);
        sendJson(res, 200, { ok: true, replay: false, result });
      } catch (err) {
        store.fail(command_id, err?.message ?? String(err));
        sendJson(res, 500, { ok: false, error: `execute failed: ${err?.message ?? err}` });
      } finally {
        if (mcp) await mcp.close().catch(() => {});
      }
      return;
    }
    if (req.method === "POST" && path === "/ask") {
      let text;
      try {
        const raw = await readBody(req);
        const parsed = raw ? JSON.parse(raw) : {};
        text = parsed?.text;
      } catch (err) {
        sendJson(res, 400, { ok: false, error: `invalid request body: ${err.message}` });
        return;
      }
      if (typeof text !== "string" || text.trim().length === 0) {
        sendJson(res, 400, { ok: false, error: "missing required field: text" });
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
          answerQuestion(text),
          new Promise((_, reject) => {
            deadlineTimer = setTimeout(
              () => reject(new Error("ask deadline exceeded (120s)")),
              120_000,
            );
          }),
        ]);
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

export async function main(argv = process.argv.slice(2)) {
  const { port, host } = parseArgs(argv);
  const policy = resolveBindPolicy({ host }); // throws before listen on unsafe config
  const server = createAskServer({ port, host, policy });
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
