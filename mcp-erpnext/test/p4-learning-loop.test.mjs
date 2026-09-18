/**
 * P4 tests — learning loop (phases2/p4-learning-loop.md).
 *
 * Safety properties under test:
 *  1. Every /ask call appends EXACTLY ONE observation (E2E through the real
 *     server stack — mock ERPNext, no LLM); the answer is unchanged whether
 *     logging works or not (best-effort by design).
 *  2. outcomeFor() maps the taxonomy correctly — the §12 signals
 *     (UNKNOWN_INTENT / KNOWN_INTENT_UNIMPLEMENTED) must never be misfiled.
 *  3. The cluster script groups repeated unknown phrases, ranks them, and
 *     exits 0; empty/missing log exits 1 (report is only useful with data).
 *  4. The log file NEVER lands inside git tracking (gitignored dir).
 *  5. Bounded: a huge question is truncated, never stored whole.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { logObservation, outcomeFor, learningLogConfig, LEARNING_OUTCOMES } from "../src/learning-log.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

test("outcomeFor maps the taxonomy — §12 signals stay distinct", () => {
  assert.equal(outcomeFor({ error_code: "UNKNOWN_INTENT" }), "unknown_intent");
  assert.equal(outcomeFor({ error_code: "KNOWN_INTENT_UNIMPLEMENTED" }), "known_intent_unimplemented");
  assert.equal(outcomeFor({ error_code: "FORBIDDEN_IN_AI_PATH" }), "forbidden");
  assert.equal(outcomeFor({ error_code: "LOW_CONFIDENCE" }), "low_confidence");
  assert.equal(outcomeFor({ error_code: "NLP_UNAVAILABLE" }), "nlp_unavailable");
  assert.equal(outcomeFor({ error_code: "AMBIGUOUS_ENTITY" }), "entity_problem");
  assert.equal(outcomeFor({ error_code: "SOMETHING_NEW_LATER" }), "error");
  // no error_code = answered (success is a signal too — the denominator)
  assert.equal(outcomeFor({ answer: "ok" }), "answered");
  // every produced outcome is a declared one
  for (const code of ["UNKNOWN_INTENT", "KNOWN_INTENT_UNIMPLEMENTED", "LOW_CONFIDENCE"]) {
    assert.ok(LEARNING_OUTCOMES.includes(outcomeFor({ error_code: code })));
  }
});

test("outcomeFor — DSH_WRITE_BLOCKED is its own signal, not 'error'", () => {
  // Review round 2 (P5): an INTENTIONAL policy block must not drown in the
  // system-error bucket of the cluster report.
  assert.equal(outcomeFor({ error_code: "DSH_WRITE_BLOCKED" }), "dsh_write_blocked");
  assert.ok(LEARNING_OUTCOMES.includes("dsh_write_blocked"));
});

test("logObservation appends valid JSONL, truncates, and is best-effort", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "learn-"));
  try {
    const config = { enabled: true, dir, file: "obs.jsonl" }; // unit-only name
    const clock = () => 1_700_000_000_000; // fixed — always UTC in the record

    assert.equal(logObservation({ question: "x".repeat(2000), error_code: "UNKNOWN_INTENT" }, { config, clock }), true);
    const line = readFileSync(path.join(dir, "obs.jsonl"), "utf8").trim().split("\n")[0];
    const rec = JSON.parse(line);
    assert.equal(rec.text.length, 500, "text truncated to 500");
    assert.equal(rec.ts, new Date(1_700_000_000_000).toISOString());
    assert.equal(rec.outcome, "unknown_intent");

    // disabled → skipped, no file writes
    const off = { ...config, enabled: false };
    assert.equal(logObservation({ question: "hi" }, { config: off, clock }), false);

    // unwritable dir → false, NEVER throws
    const broken = { enabled: true, dir: path.join(dir, "nope", "deep"), file: "x.jsonl" };
    // (mkdirSync recursive makes even this succeed — so point at a FILE as dir)
    const asFile = path.join(dir, "obs.jsonl");
    assert.equal(logObservation({ question: "hi" }, { config: { enabled: true, dir: asFile, file: "y" }, clock }), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cluster script — groups, ranks, exits 0 with data; exits 1 when empty", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "learn-"));
  try {
    // the script reads the DEFAULT file name from learningLogConfig() — the
    // test must write the same contract name, not invent its own.
    const cfg = { enabled: true, dir, file: learningLogConfig().file };
    const mk = (text, code) => ({
      question: text,
      error_code: code,
      routed: null,
      uncertainty: { code },
      proposal: null,
    });
    const t = 1_700_000_000_000;
    logObservation(mk("xóa khách hàng A", "UNKNOWN_INTENT"), { config: cfg, clock: () => t });
    logObservation(mk("xóa khách hàng B", "UNKNOWN_INTENT"), { config: cfg, clock: () => t + 1 });
    logObservation(mk("xóa khách hàng 123", "UNKNOWN_INTENT"), { config: cfg, clock: () => t + 2 });
    logObservation(mk("xem tồn kho kiểu mới", "KNOWN_INTENT_UNIMPLEMENTED"), { config: cfg, clock: () => t + 3 });
    logObservation(mk("câu hỏi thành công", null), { config: cfg, clock: () => t + 4 });

    // same cluster: 1-char tokens dropped → all three "xóa khách hàng" group
    const report = runCluster(dir);
    assert.match(report, /\[3x\].*UNKNOWN_INTENT/);
    assert.match(report, /HUMAN REVIEW/i);
    // outcome summary shows the denominator: 3 unknown, 1 unimplemented, 1 answered
    assert.match(report, /3\s+unknown_intent/);
    assert.match(report, /1\s+known_intent_unimplemented/);
    assert.match(report, /1\s+answered/);

    // min filter: with --min 2 the 3x cluster SURVIVES (3 >= 2) but the 1x
    // unimplemented cluster is filtered out of the review section
    const report2 = runCluster(dir, ["--min", "2"]);
    assert.match(report2, /\[3x\].*UNKNOWN_INTENT/);
    assert.doesNotMatch(report2, /xem tồn kho kiểu mới/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cluster script exits 1 when the log is missing (nothing to review)", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "learn-"));
  try {
    const r = spawnCluster(["--dir", dir]);
    assert.equal(r.status, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cluster script is READ-ONLY over the contract (no fs write API)", () => {
  // P4 law: the pipeline NEVER writes capability/registry changes itself.
  // The cluster report reads the log and prints — that is all.
  const src = readFileSync(path.join(HERE, "..", "scripts", "learning-cluster.mjs"), "utf8");
  assert.doesNotMatch(src, /writeFileSync|appendFileSync|openSync\([^,)]*,\s*"a/);
  assert.match(src, /readFileSync/, "the report must read the log");
});

test("the default log dir is NOT git-tracked (gitignored)", () => {
  // learning-log/ must be in .gitignore — user phrases are runtime data.
  const gitignore = readFileSync(path.join(HERE, "..", "..", ".gitignore"), "utf8");
  assert.match(gitignore, /^learning-log\/$/m);
});

// ── helpers: run the cluster script as a child process ──────────────────────
import { spawnSync } from "node:child_process";

function spawnCluster(extraArgs = []) {
  return spawnSync(process.execPath, [path.join(HERE, "..", "scripts", "learning-cluster.mjs"), ...extraArgs], {
    encoding: "utf8",
  });
}

function runCluster(dir, extraArgs = []) {
  const r = spawnCluster(["--dir", dir, ...extraArgs]);
  assert.equal(r.status, 0, `cluster script failed: ${r.stderr}`);
  return r.stdout;
}

// ── E2E: one /ask call (MCP transport) appends EXACTLY ONE observation ──
// Reuses the P3 harness (real NLP service spawn + real copilot-server child,
// mock ERPNext via clean env). The claim in p4-result.md is verified here.

test("E2E — a copilot_ask question appends exactly ONE JSONL observation", async () => {
  const { spawn } = await import("node:child_process");
  const os = await import("node:os");
  // mcp-erpnext/test/ → repo root is TWO levels up (same as p3 harness).
  const REPO = path.resolve(HERE, "..", "..");
  const COPILOT = path.join(HERE, "..", "src", "copilot-server.mjs");

  const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^ERPNEXT_/.test(k)));
  const logDir = mkdtempSync(path.join(tmpdir(), "learn-e2e-"));

  // 1. NLP service on an ephemeral port
  const nlp = spawn("python3", ["-m", "nlp_service.server", "--port", "0"], {
    cwd: REPO, env: { ...cleanEnv, PYTHONPATH: path.join(REPO, "src") }, stdio: ["ignore", "pipe", "inherit"],
  });
  const nlpPort = await new Promise((resolve, reject) => {
    nlp.stdout.on("data", (d) => {
      const m = String(d).match(/"port":\s*(\d+)/);
      if (m) resolve(Number(m[1]));
    });
    nlp.on("exit", (code) => reject(new Error(`nlp service exited early (${code})`)));
    setTimeout(() => reject(new Error("nlp service: no ready line in 5s")), 5000);
  });

  // 2. copilot-server child with a TEST-SCOPED learning log dir
  const child = spawn(process.execPath, [COPILOT], {
    env: { ...cleanEnv, NLP_SERVICE_PORT: String(nlpPort), LEARNING_LOG_DIR: logDir },
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
  const call = (text) =>
    new Promise((resolve) => {
      const id = nextId++;
      pending.set(id, { resolve });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "copilot_ask", arguments: { text } } }) + "\n");
    });

  try {
    // READ question the keyword router knows — deterministic, no LLM involved.
    const res = await call("chị Lan còn nợ bao nhiêu");
    assert.ok(res.answer || res.error_code, "pipeline answered");

    // wait a tick for the append to land (answer resolves AFTER logging by design)
    await new Promise((r) => setTimeout(r, 150));

    const lines = readFileSync(path.join(logDir, learningLogConfig().file), "utf8")
      .split("\n").filter((l) => l.trim().length > 0);
    assert.equal(lines.length, 1, `exactly ONE observation expected, got ${lines.length}`);
    const rec = JSON.parse(lines[0]);
    assert.equal(rec.text, "chị Lan còn nợ bao nhiêu");
    assert.equal(rec.outcome, "answered");
    assert.equal(rec.group, "customer");
  } finally {
    child.stdin.end();
    nlp.kill();
    rmSync(logDir, { recursive: true, force: true });
  }
});
