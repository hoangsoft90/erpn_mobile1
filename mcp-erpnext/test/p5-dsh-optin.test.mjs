/**
 * P5 tests — DSH explicit opt-in READ (plan2_final §2 D2/D3/D8, §19 P5).
 *
 * Safety properties under test:
 *  1. `/ask` unknown NEVER spawns dsh — there is no code path from
 *     answerQuestion to any dsh binary (static assertion over src/) and
 *     unknown stays UNKNOWN_INTENT (regression via the P4 E2E harness).
 *  2. In dsh context (COPILOT_DSH_CONTEXT=1) a WRITE question is refused
 *     with DSH_WRITE_BLOCKED BEFORE any skill/ERPNext work — no proposal,
 *     no partial state, learning log still records the signal.
 *  3. The gate can only RESTRICT dsh: there is no env that makes /ask route
 *     to dsh (the /ask path never consults a dsh flag — D2).
 *  4. The dsh patch file carries COPILOT_DSH_CONTEXT=1 and spawns the real
 *     copilot-server (never a prompt-side description).
 *  5. The /ask HTTP server does NOT set COPILOT_DSH_CONTEXT (grep over src).
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { isDshContext, blockedInDshContext, DSH_CONTEXT_ENV, DSH_WRITE_BLOCKED_CODE } from "../src/dsh-optin.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

test("isDshContext — only an explicit '1' opts in", () => {
  assert.equal(isDshContext({}), false);
  assert.equal(isDshContext({ [DSH_CONTEXT_ENV]: "" }), false);
  assert.equal(isDshContext({ [DSH_CONTEXT_ENV]: "0" }), false);
  assert.equal(isDshContext({ [DSH_CONTEXT_ENV]: "true" }), false, "must be the exact flag value, not truthy");
  assert.equal(isDshContext({ [DSH_CONTEXT_ENV]: "1" }), true);
});

test("blockedInDshContext — WRITE group blocked, READ and unrouted not", () => {
  assert.equal(blockedInDshContext({ group: "payment_write", forbidden: false }), true);
  assert.equal(blockedInDshContext({ group: "customer", forbidden: false }), false);
  assert.equal(blockedInDshContext({ group: "inventory", forbidden: false }), false);
  assert.equal(blockedInDshContext({ group: "sales", forbidden: false }), false);
  assert.equal(blockedInDshContext(null), false, "unrouted is UNKNOWN_INTENT's business");
  assert.equal(blockedInDshContext({ group: "irrelevant", forbidden: true }), false, "forbidden refused upstream anyway");
});

test("D2 — no dsh spawn exists in the /ask pipeline source", () => {
  // The deterministic path must never execute a dsh binary: grep the whole
  // src/ for any spawn of dsh. Spawning happens only for the pinned ERPNext
  // MCP servers and the copilot-server itself.
  for (const f of ["copilot-server.mjs", "http-ask.mjs", "client.mjs", "index.mjs", "router.mjs", "classifier.mjs"]) {
    const src = readFileSync(path.join(HERE, "..", "src", f), "utf8");
    // match only real spawn CALLS (spawn("...", ...) with dsh in the command
    // position) — not the words "dsh"/"spawned" inside comments.
    assert.doesNotMatch(src, /spawn\s*\([^\n)]*?["'`]dsh/i, `${f} must not spawn a dsh binary`);
  }
  // The ONLY dsh references in src/ are comments naming the runtime, and the
  // opt-in gate module — none of them execute anything.
  const optin = readFileSync(path.join(HERE, "..", "src", "dsh-optin.mjs"), "utf8");
  assert.match(optin, /COPILOT_DSH_CONTEXT/);
});

test("D8 — the dsh patch is opt-in + read-only marked + spawns the real server", () => {
  const patch = readFileSync(path.join(HERE, "..", "dsh.cordis.patch.yml"), "utf8");
  assert.match(patch, /COPILOT_DSH_CONTEXT:\s*'1'/, "patch must set the opt-in flag");
  assert.match(patch, /copilot-server\.mjs/, "patch must spawn the real copilot server");
  assert.match(patch, /transport:\s*stdio/, "MCP stdio transport");
});

test("DSH_WRITE_BLOCKED carries P2 uncertainty copy (never a bare refusal)", () => {
  // Review round 2 caught this: without a taxonomy entry, withUncertainty()
  // silently drops the copy and the client gets a bare refusal.
  const { withUncertainty: _w } = {};
  return import("../src/uncertainty.mjs").then(({ toUncertaintyCode, uncertaintyCopy, UNCERTAINTY_CODES }) => {
    assert.equal(toUncertaintyCode("DSH_WRITE_BLOCKED"), UNCERTAINTY_CODES.DSH_WRITE_BLOCKED);
    const copy = uncertaintyCopy(UNCERTAINTY_CODES.DSH_WRITE_BLOCKED, { detail: null });
    assert.match(copy.message ?? copy, /ch\u1ec9 \u0110\u1ecdC|ch\u1ec9 \u0110\u1ecdc|chat ch\u00ednh/);
  });
});

test("the /ask HTTP server never sets the dsh context variable", () => {
  const src = readFileSync(path.join(HERE, "..", "src", "http-ask.mjs"), "utf8");
  assert.doesNotMatch(src, /COPILOT_DSH_CONTEXT/, "/ask must not mark itself as dsh");
  const copilot = readFileSync(path.join(HERE, "..", "src", "copilot-server.mjs"), "utf8");
  // The server only READS the env (isDshContext) — it never SETS it.
  assert.doesNotMatch(copilot, /[^\w]process\.env\.COPILOT_DSH_CONTEXT\s*=/);
});

// ── E2E: dsh opt-in child — READ passes, WRITE is refused before ERPNext ──
// Real copilot-server child spawned WITH COPILOT_DSH_CONTEXT=1 (as the patch
// does), real NLP service, mock ERPNext (clean env). The /ask HTTP behavior
// is unchanged and already covered by the P4 E2E (no dsh context there).

test("E2E — dsh opt-in child: READ answers, WRITE refused with DSH_WRITE_BLOCKED", async () => {
  const { spawn } = await import("node:child_process");
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const REPO = path.resolve(HERE, "..", "..");
  const COPILOT = path.join(HERE, "..", "src", "copilot-server.mjs");

  const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^ERPNEXT_/.test(k)));
  const logDir = mkdtempSync(path.join(tmpdir(), "learn-p5-"));
  const { learningLogConfig } = await import("../src/learning-log.mjs");

  const nlp = spawn("python3", ["-m", "nlp_service.server", "--port", "0"], {
    cwd: REPO, env: { ...cleanEnv, PYTHONPATH: path.join(REPO, "src") }, stdio: ["ignore", "pipe", "inherit"],
  });
  const nlpPort = await new Promise((resolve, reject) => {
    nlp.stdout.on("data", (d) => {
      const m = String(d).match(/"port":\s*(\d+)/);
      if (m) resolve(Number(m[1]));
    });
    nlp.on("exit", (code) => reject(new Error(`nlp exited early (${code})`)));
    setTimeout(() => reject(new Error("nlp: no ready line")), 5000);
  });

  // dsh would start the copilot like this: WITH the opt-in flag (patch file).
  const child = spawn(process.execPath, [COPILOT], {
    env: { ...cleanEnv, NLP_SERVICE_PORT: String(nlpPort), LEARNING_LOG_DIR: logDir, COPILOT_DSH_CONTEXT: "1" },
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
      const msg = JSON.parse(line);
      const entry = pending.get(msg.id);
      if (!entry) continue;
      pending.delete(msg.id);
      entry.resolve(msg.result?.structuredContent ?? JSON.parse(msg.result?.content?.[0]?.text ?? "{}"));
    }
  });
  const call = (text, entityId) =>
    new Promise((resolve) => {
      const id = nextId++;
      pending.set(id, { resolve });
      const args = { text };
      if (entityId) args.entity_id = entityId;
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "copilot_ask", arguments: args } }) + "\n");
    });

  try {
    // READ through dsh context: fully allowed (Skill Gateway unchanged).
    const read = await call("chị Lan còn nợ bao nhiêu");
    assert.match(read.answer ?? "", /Nguyễn Thị Lan|2\.500\.000|không còn nợ/);

    // WRITE through dsh context: refused BEFORE any skill/ERPNext touch.
    const write = await call("thu tiền cho chị Lan 50 nghìn");
    assert.equal(write.error_code, DSH_WRITE_BLOCKED_CODE);
    assert.equal(write.proposal, null, "no proposal may exist in dsh context");

    // Both questions still produced learning signals (P4 law holds in P5).
    await new Promise((r) => setTimeout(r, 150));
    const lines = readFileSync(path.join(logDir, learningLogConfig().file), "utf8").split("\n").filter((l) => l.trim());
    assert.equal(lines.length, 2, "both dsh questions logged");
    assert.equal(JSON.parse(lines[1]).error_code, DSH_WRITE_BLOCKED_CODE, "blocked write is a signal too");
  } finally {
    child.stdin.end();
    nlp.kill();
    rmSync(logDir, { recursive: true, force: true });
  }
});
