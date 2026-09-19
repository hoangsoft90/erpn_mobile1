#!/usr/bin/env node
/**
 * DSH remote runner — `.plan/dsh_prompt_check.md` §2 (Mac ↔ backend topology).
 *
 * The gateway (Cloud Shell / VPS) does NOT need a local dsh install when the
 * runtime lives on the Mac behind a tunnel. This process runs ON the machine
 * that owns the install and exposes exactly two routes to the gateway:
 *
 *   GET  /health  → {ok:true, runtime, entry, version}
 *   POST /run     → {ok:true, stdout, stderr, code} | {ok:false, error}
 *      Authorization: Bearer <DSH_REMOTE_TOKEN>   body {prompt, timeoutMs}
 *
 * Deliberate non-features (the gateway owns them, and two owners would drift):
 *   - NO answer parsing — stdout/stderr go back raw and the gateway applies the
 *     same parsers it uses locally, so both modes share one output contract.
 *   - NO session store — conversation carry-over is the gateway's job (the
 *     prompt it sends already contains the prior turns).
 *   - NO routing to /ask, no ERPNext call of its own: the spawned dsh child
 *     reaches ERPNext only through the copilot skill layer, exactly like local.
 *   - NO fallback of any kind. A missing token, a bad token, or a bad body is a
 *     refusal; nothing here ever answers a request it was not asked to run.
 *
 * The child env is built by the SAME `buildDshChildEnv()` the local path uses
 * (secret stripping + the two opt-in markers), so running remotely cannot
 * accidentally hand dsh a credential the local path would have withheld.
 *
 * Usage (on the Mac):
 *   DSH_REMOTE_TOKEN=<random> node scripts/dsh-remote-runner.mjs --port 8799
 *   then expose it:  lt -s dsh8799 --port 8799
 * and on the gateway:
 *   DSH_MODE=remote DSH_REMOTE_URL=https://dsh8799.loca.lt \
 *   DSH_REMOTE_TOKEN=<same random> ...
 */

import http from "node:http";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { timingSafeEqual } from "node:crypto";

import { buildDshChildEnv, dshRuntimeInfo, scrubDiagnostics } from "../mcp-erpnext/src/dsh-gateway.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..");

const MAX_BODY_BYTES = 64 * 1024; // one utterance + chat history, bounded
const MAX_PROMPT_CHARS = 20_000;
const DEFAULT_TIMEOUT_MS = 180_000;

function argValue(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const port = Number(argValue("--port", process.env.DSH_REMOTE_PORT ?? 8799));
const token = String(process.env.DSH_REMOTE_TOKEN ?? "").trim();
// Resolved exactly as the gateway resolves it — one implementation, so the
// runner cannot disagree with the caller about which binary is "the" dsh.
const runtime = dshRuntimeInfo(process.env);
const entry = runtime.entry;
const patch = runtime.patch;
const cwd = String(process.env.DSH_CWD ?? REPO_ROOT);
const maxTimeoutMs = Number(process.env.DSH_TIMEOUT_MAX_MS ?? 600_000);

if (!token || token.length < 16) {
  // Refuse to run unprotected: an open runner on a public tunnel is a remote
  // code path into the copilot, and the tunnel URL is guessable.
  console.error("[dsh-runner] FATAL: DSH_REMOTE_TOKEN must be set (>=16 chars). Refusing to start.");
  process.exit(2);
}
if (!runtime.entryExists) {
  console.error(`[dsh-runner] FATAL: dsh entry not found (${entry || "unset"}). Set DSH_ENTRY.`);
  process.exit(2);
}
if (!runtime.patchExists) {
  console.error(`[dsh-runner] FATAL: patch not found (${patch}). Set DSH_PATCH.`);
  process.exit(2);
}
if (!runtime.patchMarksDshContext) {
  // Same fail-closed law as the gateway: without the marker the in-child WRITE
  // gate never fires, so this runtime must not be advertised as usable.
  console.error(`[dsh-runner] FATAL: ${path.basename(patch)} is missing COPILOT_DSH_CONTEXT=1. Refusing to start.`);
  process.exit(2);
}

function tokenMatches(given) {
  const a = Buffer.from(String(given ?? ""));
  const b = Buffer.from(token);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
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

/** Run ONE headless dsh session and hand the raw streams back to the gateway. */
function runDsh(prompt, timeoutMs) {
  return new Promise((resolve) => {
    const scratch = mkdtempSync(path.join(tmpdir(), "dsh-runner-"));
    const dshHome = path.join(scratch, "home");
    mkdirSync(dshHome, { recursive: true });

    // Never reuse the operator's DSH_HOME: stale settings once made a session
    // answer from a leftover route (erpn-dsh-setup SKILL.md).
    const childEnv = buildDshChildEnv(process.env);
    childEnv.DSH_HOME = dshHome;
    childEnv.DSH_TELEMETRY_MODE = "DISABLED";

    const child = spawn(process.execPath, [entry, "--profile", "headless", "--patch", patch, prompt], {
      cwd,
      env: childEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    // Bounded like the gateway's local spawn: a runaway session must not be able
    // to exhaust this machine's memory. The final answer is printed LAST, so the
    // cap keeps the TAIL — which is also why the answer survives an oversized
    // transcript. Review found the runner was the only unbounded accumulator.
    child.stdout.on("data", (d) => {
      stdout += d.toString();
      if (stdout.length > 400_000) stdout = stdout.slice(-200_000);
    });
    child.stderr.on("data", (d) => {
      stderr += d.toString();
      if (stderr.length > 100_000) stderr = stderr.slice(-50_000);
      process.stderr.write(d); // operator visibility; the response carries the scrubbed copy
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      rmSync(scratch, { recursive: true, force: true });
      resolve({ ok: false, error: `spawn failed: ${err?.message ?? err}` });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      rmSync(scratch, { recursive: true, force: true });
      if (timedOut) {
        resolve({ ok: false, error: `dsh session exceeded ${timeoutMs}ms` });
        return;
      }
      resolve({ ok: true, code, stdout, stderr: scrubDiagnostics(stderr) });
    });
  });
}

const server = http.createServer(async (req, res) => {
  const url = (req.url ?? "/").split("?")[0];

  if (req.method === "GET" && url === "/health") {
    if (!tokenMatches((req.headers.authorization ?? "").replace(/^Bearer\s+/i, ""))) {
      sendJson(res, 401, { ok: false, error: "unauthorized" });
      return;
    }
    sendJson(res, 200, { ok: true, runtime: "dsh-remote-runner", entry, version: runtime.version ?? "unknown" });
    return;
  }

  if (req.method !== "POST" || url !== "/run") {
    sendJson(res, 404, { ok: false, error: "not found" });
    return;
  }
  if (!tokenMatches((req.headers.authorization ?? "").replace(/^Bearer\s+/i, ""))) {
    sendJson(res, 401, { ok: false, error: "unauthorized" });
    return;
  }

  let body;
  try {
    body = JSON.parse((await readBody(req)) || "{}");
  } catch (err) {
    sendJson(res, 400, { ok: false, error: `invalid body: ${err?.message ?? err}` });
    return;
  }
  const prompt = typeof body?.prompt === "string" ? body.prompt.trim() : "";
  if (!prompt) {
    sendJson(res, 400, { ok: false, error: "missing required field: prompt" });
    return;
  }
  if (prompt.length > MAX_PROMPT_CHARS) {
    sendJson(res, 400, { ok: false, error: `prompt exceeds ${MAX_PROMPT_CHARS} characters` });
    return;
  }
  const requested = Number(body?.timeoutMs);
  const timeoutMs = Number.isFinite(requested) && requested > 0 ? Math.min(requested, maxTimeoutMs) : DEFAULT_TIMEOUT_MS;

  const started = Date.now();
  const outcome = await runDsh(prompt, timeoutMs);
  console.log(`[dsh-runner] run ${outcome.ok ? "ok" : "failed"} in ${Date.now() - started}ms (prompt ${prompt.length} chars)`);
  sendJson(res, outcome.ok ? 200 : 502, outcome);
});

server.listen(port, "127.0.0.1", () => {
  console.log(`[dsh-runner] listening on 127.0.0.1:${port} (entry=${entry}, version=${runtime.version ?? "unknown"})`);
  console.log(`[dsh-runner] expose it: lt -s dsh${port} --port ${port}`);
  console.log(`[dsh-runner] never log the token: it is read from DSH_REMOTE_TOKEN and never printed`);
});
