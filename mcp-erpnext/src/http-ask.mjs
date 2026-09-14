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
 * Bind: 127.0.0.1 by default (same stance as nlp_service). For phone testing
 * on the LAN run with --host 0.0.0.0 explicitly — that is an operator
 * decision, not a default (the endpoint is read-only but still our backend).
 *
 * Run: node src/http-ask.mjs [--port 8788] [--host 127.0.0.1]
 * Ready line on stdout: {"ready":true,"port":N}
 */

import http from "node:http";
import { answerQuestion } from "./copilot-server.mjs";

const MAX_BODY = 1_000_000; // one utterance is ~200 chars; 1MB is generous

function parseArgs(argv) {
  const args = { port: Number(process.env.ASK_PORT || 8788), host: process.env.ASK_HOST || "127.0.0.1" };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--port") args.port = Number(argv[++i]);
    if (argv[i] === "--host") args.host = argv[++i];
  }
  return args;
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

export function createAskServer({ port = 8788, host = "127.0.0.1" } = {}) {
  const server = http.createServer(async (req, res) => {
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
      try {
        const result = await answerQuestion(text);
        sendJson(res, 200, { ok: true, result });
      } catch (err) {
        // message only — never a stack trace, never env contents
        sendJson(res, 500, { ok: false, error: `ask failed: ${err?.message ?? err}` });
      }
      return;
    }
    sendJson(res, 404, { ok: false, error: `no such path: ${req.method} ${path}` });
  });
  return server;
}

export async function main(argv = process.argv.slice(2)) {
  const { port, host } = parseArgs(argv);
  const server = createAskServer({ port, host });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  process.stdout.write(JSON.stringify({ ready: true, port: server.address().port }) + "\n");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    process.stderr.write(`[http-ask] fatal: ${err?.message ?? err}\n`);
    process.exit(1);
  });
}
