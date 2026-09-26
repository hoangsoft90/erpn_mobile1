#!/usr/bin/env node
/**
 * Verbatim-transcript driver for the copilot MCP server.
 *
 * Speaks the REAL stdio protocol (spawn → initialize → tools/call) — exactly
 * what dsh does after registering mcp-erpnext/dsh.cordis.patch.yml — and prints
 * the raw JSON-RPC exchange so result5.txt can quote it verbatim.
 *
 * Usage:
 *   python3 -m nlp_service.server &                    # or NLP_SERVICE_PORT=...
 *   node scripts/ask-copilot.mjs "chị Lan còn nợ bao nhiêu"
 *   node scripts/ask-copilot.mjs --raw "..."           # include raw JSON-RPC lines
 */

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import readline from "node:readline";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.resolve(HERE, "../mcp-erpnext/src/copilot-server.mjs");

const args = process.argv.slice(2);
const showRaw = args.includes("--raw");
const question = args.filter((a) => !a.startsWith("--")).join(" ").trim();
if (!question) {
  console.error('usage: node scripts/ask-copilot.mjs [--raw] "câu hỏi tiếng Việt"');
  process.exit(1);
}

const child = spawn(process.execPath, [SERVER], {
  env: process.env,
  stdio: ["pipe", "pipe", "inherit"],
});

const pending = new Map();
let nextId = 1;
let buffer = "";
child.stdout.on("data", (chunk) => {
  buffer += chunk.toString();
  let nl;
  while ((nl = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (!line) continue;
    if (showRaw) console.log(`<< ${line}`);
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    const entry = pending.get(msg.id);
    if (!entry) continue;
    pending.delete(msg.id);
    if (msg.error) entry.reject(new Error(`MCP_ERROR ${msg.error.code}: ${msg.error.message}`));
    else entry.resolve(msg.result);
  }
});

function request(method, params) {
  const id = nextId++;
  const req = JSON.stringify({ jsonrpc: "2.0", id, method, params });
  if (showRaw) console.log(`>> ${req}`);
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    child.stdin.write(req + "\n");
  });
}

const timeout = setTimeout(() => {
  console.error("TIMEOUT: copilot server did not answer in 20s");
  child.kill();
  process.exit(1);
}, 20000);

try {
  const init = await request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "ask-copilot-cli", version: "0.1.0" },
  });
  console.error(`[driver] server: ${init.serverInfo?.name} v${init.serverInfo?.version}`);

  const res = await request("tools/call", { name: "copilot_ask", arguments: { text: question } });
  if (res.isError) {
    console.error(`[driver] tool error: ${res.content?.[0]?.text}`);
    process.exitCode = 1;
  } else {
    const structured = res.structuredContent ?? JSON.parse(res.content?.[0]?.text ?? "{}");
    console.log(`QUESTION: ${question}`);
    console.log(`ANSWER:   ${structured.answer ?? `(no answer — ${structured.reason ?? "?"})`}`);
  }
} finally {
  clearTimeout(timeout);
  child.stdin.end();
  await new Promise((r) => child.once("exit", r));
}
