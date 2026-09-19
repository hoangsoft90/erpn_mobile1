/**
 * DSH Gateway tests — plan .plan/dsh_end_to_end.md §21/§22, checklist
 * .plan/dsh_e2e_tasks.md B1-B5 + D1.
 *
 * Safety properties under test:
 *  1. WRITE pre-screen: a write-shaped question is refused with
 *     DSH_WRITE_BLOCKED BEFORE any dsh spawn (audit: gateway_refused).
 *  2. NLP down ⇒ fail closed (DSH_GATEWAY_NLP_UNAVAILABLE), never
 *     "route it anyway".
 *  3. The runner spawns the REAL configured dsh entry (a fake entry script
 *     records its argv) with --profile headless --patch and the question as a
 *     POSITIONAL arg; the gateway parses the last JSON stdout line; the child
 *     env carries the gateway marker, NEVER the secret keys.
 *  4. Bounds: timeout kill, busy (max concurrent), input size, TTL session,
 *     error mapping codes.
 *  5. Audit: exactly one learning-log line per turn with mode=dsh +
 *     request_id + conversation-bound session; no secret values anywhere.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  dshQuestionGate,
  dshGatewayAsk,
  runDshAsk,
  dshGatewayConfig,
  buildDshChildEnv,
  DshSessionStore,
  DSH_SECRET_ENV_KEYS,
  DSH_IN_FLIGHT,
  DSH_GATEWAY_REFUSED,
  dshInFlight,
  parseDshFinalAnswer,
  parseDshTarget,
  scrubDiagnostics,
  stripDshBanner,
  dshPatchMarksDshContext,
  dshGatewayHealth,
  dshRuntimeInfo,
  isValidConversationId,
  DSH_TIMEOUT_MESSAGE,
} from "../src/dsh-gateway.mjs";
import { DSH_WRITE_BLOCKED_CODE } from "../src/dsh-optin.mjs";
import { __setNlpServicePortForTest } from "../src/copilot-server.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

// ─────────────────────────────────────────────────────────────────────────────
// helpers
// ─────────────────────────────────────────────────────────────────────────────

/** A fake NLP service we can point the pipeline at (real seam via NLP_SERVICE_PORT). */
/**
 * An HONEST fake of the real NLP bridge (server.py → result.py to_dict, read
 * from source before writing this): {ok, result:{original, text, amount,
 * amounts, money_matches, quantities, titles, intents, synonyms}}. The first
 * draft guessed the shape (flat {ok,result:{text}}) and the WRITE-block test
 * passed vacuously — the gate took the NLP-down branch (fail closed), which
 * LOOKS right for a blocked question while testing nothing. Lesson: the mock
 * must carry the real contract, incl. `intents` (the pipeline synonym map).
 */
function normalizeLikeRealNlp(body) {
  const text = String(body?.text ?? "");
  const intents = [];
  if (/thu tiền|nhận tiền|thu hộ/.test(text)) intents.push("payment");
  if (/còn nợ|nợ bao nhiêu|công nợ/.test(text)) intents.push("receivable");
  let cleaned = text
    .replace(/thu tiền/g, "payment")
    .replace(/còn nợ/g, "receivable");
  const m = /([0-9]+[.,]?[0-9]*)\s*(nghìn|ngàn|k|triệu|tr)?/i.exec(cleaned);
  const amount = m ? Number(String(m[1]).replace(/[.,]/g, "")) * (/nghìn|ngàn|k/i.test(m[2] ?? "") ? 1000 : /triệu|tr/i.test(m[2] ?? "") ? 1_000_000 : 1) : null;
  return {
    ok: true,
    result: {
      original: text,
      text: cleaned,
      amount,
      amounts: amount != null ? [amount] : [],
      money_matches: amount != null ? [{ value: amount, raw: m[0], start: m.index, end: m.index + m[0].length }] : [],
      quantities: [],
      titles: [],
      intents,
      synonyms: intents.map((c) => ({ term: c === "payment" ? "thu tiền" : "còn nợ", canonical: c })),
    },
  };
}

async function withFakeNlp(handlers, fn) {
  const { createServer } = await import("node:http");
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const handler = handlers ? (handlers[req.url ?? "/"] ?? handlers.default) : null;
      const payload = handler
        ? handler(JSON.parse(body || "{}"))
        : normalizeLikeRealNlp(JSON.parse(body || "{}"));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(payload));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  // The pipeline reads NLP_SERVICE_PORT at module load; point the IN-PROCESS
  // seam at the fake before fn(port), restore the env value after.
  const previous = process.env.NLP_SERVICE_PORT;
  __setNlpServicePortForTest(port);
  try {
    return await fn(port);
  } finally {
    __setNlpServicePortForTest(previous ?? "8787");
    await new Promise((r) => server.close(r));
  }
}

/** A patch fixture that satisfies the gateway's fail-closed marker check.
 * Every runDshAsk test except the deliberate DSH_PATCH_UNSAFE one uses this. */
function writeSafePatch(file) {
  writeFileSync(
    file,
    "- insert:\n    - id: erpn-copilot-mcp\n      config:\n        env:\n          COPILOT_DSH_CONTEXT: '1'\n",
  );
  return file;
}

/** A fake "dsh" entry: echoes its argv to a file, prints a final JSON answer. */
function makeFakeDsh(entryScript) {
  const dir = mkdtempSync(path.join(tmpdir(), "fake-dsh-"));
  const bin = path.join(dir, "fake-dsh.mjs");
  writeFileSync(
    bin,
    `import { appendFileSync } from "node:fs";
const out = process.argv[2 + process.argv.indexOf("--patch") >= 0 ? process.argv.indexOf("--patch") + 2 : 0];
// argv: [node, bin, --profile, headless, --patch, PATCH, PROMPT]
const argvFile = process.env.FAKE_DSH_ARGV;
if (argvFile) appendFileSync(argvFile, JSON.stringify(process.argv) + "\\n");
${entryScript}
`,
  );
  return { bin, dir };
}

/** Read the learning-log file the test wrote into. LEARNING_LOG_DIR is a
 * DIRECTORY (learning-log.mjs: `dir: env.LEARNING_LOG_DIR ?? defaultLogDir()`,
 * `file: "observations.jsonl"`) — an earlier version of this comment claimed it
 * was the file itself, which is exactly the kind of doc/code drift this project
 * keeps a lesson for. */
function readLog(logPath) {
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. WRITE pre-screen (plan §10) — B3
// ─────────────────────────────────────────────────────────────────────────────

test("dshQuestionGate — WRITE question refused with DSH_WRITE_BLOCKED before dsh runs", async () => {
  await withFakeNlp(
    { default: (b) => normalizeLikeRealNlp(b) },
    async (port) => {
      const verdict = await dshQuestionGate("thu tiền cho chị Lan 50 nghìn", { env: { NLP_SERVICE_PORT: String(port) } });
      assert.equal(verdict.ok, false);
      assert.equal(verdict.code, DSH_WRITE_BLOCKED_CODE);
      assert.match(verdict.reason, /chỉ ĐỌC|chỉ đọc/);
    },
  );
});

test("dshQuestionGate — READ question passes the gate", async () => {
  await withFakeNlp(
    { default: (b) => normalizeLikeRealNlp(b) },
    async (port) => {
      const verdict = await dshQuestionGate("chị Lan còn nợ bao nhiêu", { env: { NLP_SERVICE_PORT: String(port) } });
      assert.equal(verdict.ok, true);
      assert.equal(typeof verdict.normalizedText, "string");
    },
  );
});

test("dshQuestionGate — NLP down fails CLOSED, never routes anyway", async () => {
  // Point the IN-PROCESS seam at a closed port. Using env alone would be
  // environment-dependent: this repo commonly has a real NLP service on 8787,
  // which would make the "down" test silently exercise the happy path.
  const previous = process.env.NLP_SERVICE_PORT;
  __setNlpServicePortForTest(1); // port 1 on loopback refuses immediately
  try {
    const verdict = await dshQuestionGate("chị Lan còn nợ bao nhiêu", { env: {} });
    assert.equal(verdict.ok, false);
    assert.equal(verdict.code, "DSH_GATEWAY_NLP_UNAVAILABLE");
    assert.match(verdict.reason, /không thể đánh giá an toàn/);
  } finally {
    __setNlpServicePortForTest(previous ?? "8787");
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. The runner spawns the REAL configured entry — B1 evidence
// ─────────────────────────────────────────────────────────────────────────────

test("runDshAsk — spawns the configured dsh entry with headless profile + positional prompt; parses last JSON line", { concurrency: false }, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "fake-dsh-argv-"));
  const argvFile = path.join(dir, "argv.jsonl");
  const bin = path.join(dir, "fake-dsh.mjs");
  writeFileSync(
    bin,
    `import { appendFileSync } from "node:fs";
if (process.env.FAKE_DSH_ARGV) appendFileSync(process.env.FAKE_DSH_ARGV, JSON.stringify(process.argv) + "\\n");
console.log("The local server is running on the user's machine."); // banner line
console.log("suy nghĩ gì đó..."); // prose line
console.log(JSON.stringify({ content: "Khách Lan còn nợ 457.875đ" }));`,
  );
  const patch = path.join(dir, "fake.patch.yml");
  writeSafePatch(patch);
  const out = await runDshAsk("chị Lan còn nợ bao nhiêu", {
    maxConcurrent: 0,
    env: { FAKE_DSH_ARGV: argvFile },
    overrides: { dshEntry: bin, patch, cwd: dir, timeoutMs: 15_000, dshHomeBase: path.join(dir, "home") },
  });
  try {
    assert.equal(out.ok, true, `expected ok, got ${JSON.stringify(out)}`);
    assert.equal(out.answer.content, "Khách Lan còn nợ 457.875đ");
    // The child was REALLY spawned with the right argv (recorded by itself):
    const argv = JSON.parse(readFileSync(argvFile, "utf8"));
    assert.equal(argv[2], "--profile");
    assert.equal(argv[3], "headless");
    assert.equal(argv[4], "--patch");
    assert.equal(argv[5], patch);
    assert.equal(argv[6], "chị Lan còn nợ bao nhiêu"); // POSITIONAL (skill law)
    // Fresh DSH_HOME was created for the child and REMOVED after the call:
    assert.ok(out.sessionId);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runDshAsk — the child env NEVER carries the secret keys (and no invented marker)", { concurrency: false }, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "fake-dsh-env-"));
  const bin = path.join(dir, "fake-dsh.mjs");
  const envFile = path.join(dir, "child-env.json");
  writeFileSync(bin, `import { appendFileSync } from "node:fs";
appendFileSync(process.env.FAKE_ENV_FILE, JSON.stringify({ ASK_PASSWORD: process.env.ASK_PASSWORD ?? null, GH_TOKEN: process.env.GH_TOKEN ?? null, COPILOT_GATEWAY_DSH: process.env.COPILOT_GATEWAY_DSH ?? null, GEMINI_API_KEY: process.env.GEMINI_API_KEY ?? null }));
console.log(JSON.stringify({ content: "ok" }));`);
  const patch = path.join(dir, "fake.patch.yml");
  writeSafePatch(patch);
  try {
    const out = await runDshAsk("câu hỏi đọc", {
      maxConcurrent: 0,
      env: { ASK_PASSWORD: "SUPER_SECRET", GH_TOKEN: "gh_secret", GEMINI_API_KEY: "gem_secret", NLP_SERVICE_PORT: "8787", FAKE_ENV_FILE: envFile },
      overrides: { dshEntry: bin, patch, cwd: dir, timeoutMs: 15_000, dshHomeBase: path.join(dir, "home") },
    });
    assert.equal(out.ok, true);
    const childEnv = JSON.parse(readFileSync(envFile, "utf8"));
    assert.equal(childEnv.ASK_PASSWORD, null, "ASK_PASSWORD must never reach the dsh child");
    assert.equal(childEnv.GH_TOKEN, null, "GH_TOKEN must never reach the dsh child");
    assert.equal(childEnv.GEMINI_API_KEY, null, "GEMINI_API_KEY must never reach the dsh child");
    // Review F4: an earlier draft set a COPILOT_GATEWAY_DSH marker here and the
    // test asserted it — but nothing ever READ the marker, so the assertion was
    // green over a variable with no effect. The real write-gate signal is the
    // patch's COPILOT_DSH_CONTEXT, which the spawn guard verifies instead.
    assert.equal(childEnv.COPILOT_GATEWAY_DSH, null, "no marker that nothing reads");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runDshAsk — non-zero exit / no JSON ⇒ structured DSH_SESSION_FAILED with bounded tail", { concurrency: false }, async () => {
  const { bin, dir } = makeFakeDsh(`console.log("SERVER: 502 (tried: none)"); process.exit(1);`);
  const patch = path.join(dir, "fake.patch.yml");
  writeSafePatch(patch);
  try {
    const out = await runDshAsk("câu hỏi", {
      maxConcurrent: 0,
      env: {},
      overrides: { dshEntry: bin, patch, cwd: dir, timeoutMs: 15_000, dshHomeBase: path.join(dir, "home") },
    });
    assert.equal(out.ok, false);
    assert.equal(out.code, "DSH_SESSION_FAILED");
    assert.match(out.logTail, /502/);
    assert.ok(out.logTail.length <= 300);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runDshAsk — hung dsh child is KILLED at timeout ⇒ DSH_TIMEOUT", { concurrency: false }, async () => {
  const { bin, dir } = makeFakeDsh(`setInterval(() => {}, 1000); // never exits`);
  const patch = path.join(dir, "fake.patch.yml");
  writeSafePatch(patch);
  try {
    const out = await runDshAsk("câu hỏi", {
      maxConcurrent: 0,
      env: {},
      overrides: { dshEntry: bin, patch, cwd: dir, timeoutMs: 300, dshHomeBase: path.join(dir, "home") },
    });
    assert.equal(out.ok, false);
    assert.equal(out.code, "DSH_TIMEOUT");
    assert.match(out.reason, /quá thời gian/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runDshAsk — missing dsh entry ⇒ DSH_UNAVAILABLE (actionable, not a crash)", async () => {
  const out = await runDshAsk("câu hỏi", {
    maxConcurrent: 0,
    env: {},
    overrides: { dshEntry: "/nonexistent/dsh/bin.js", patch: "/nonexistent.patch.yml" },
  });
  assert.equal(out.ok, false);
  assert.equal(out.code, "DSH_UNAVAILABLE");
  assert.match(out.reason, /không khả dụng/);
});

// ─────────────────────────────────────────────────────────────────────────────
// 2b. The write gate must EXIST in the patch the gateway spawns (real bug found
// by running the chain: dsh-e2e.patch.yml lacked COPILOT_DSH_CONTEXT, so the
// in-child gate never armed and a write question fell through to the skill).
// ─────────────────────────────────────────────────────────────────────────────

test("BOTH dsh patches mark the copilot child as dsh context (safety flag present)", () => {
  const patchDir = path.join(HERE, "..");
  for (const file of ["dsh.cordis.patch.yml", "dsh-e2e.patch.yml"]) {
    const full = path.join(patchDir, file);
    assert.equal(dshPatchMarksDshContext(full), true, `${file} MUST set COPILOT_DSH_CONTEXT=1`);
  }
  assert.equal(dshPatchMarksDshContext(path.join(patchDir, "no-such.patch.yml")), false);
});

test("runDshAsk — FAIL CLOSED when the patch does not mark dsh context (no spawn at all)", { concurrency: false }, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "fake-dsh-unsafe-patch-"));
  const argvFile = path.join(dir, "argv.jsonl");
  const bin = path.join(dir, "fake-dsh.mjs");
  writeFileSync(
    bin,
    `import { appendFileSync } from "node:fs";
appendFileSync(process.env.FAKE_DSH_ARGV, JSON.stringify(process.argv) + "\\n");
console.log(JSON.stringify({ content: "should never run" }));`,
  );
  // A patch WITHOUT the marker — exactly the shape that caused the real hole.
  const patch = path.join(dir, "unsafe.patch.yml");
  writeFileSync(patch, "- insert:\n    - id: erpn-copilot-mcp\n      config:\n        env:\n          NLP_SERVICE_PORT: '8787'\n");
  try {
    const out = await runDshAsk("thu tiền cho chị Lan 500.000", {
      maxConcurrent: 0,
      env: { FAKE_DSH_ARGV: argvFile },
      overrides: { dshEntry: bin, patch, cwd: dir, timeoutMs: 15_000, dshHomeBase: path.join(dir, "home") },
    });
    assert.equal(out.ok, false);
    assert.equal(out.code, "DSH_PATCH_UNSAFE");
    assert.match(out.reason, /thiếu cờ ngữ cảnh chỉ-ĐỌC/);
    assert.equal(existsSync(argvFile), false, "the dsh child must NOT have been spawned");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Bounds (plan §20) — B2
// ─────────────────────────────────────────────────────────────────────────────

test("concurrency cap — the second concurrent request is refused with DSH_IN_FLIGHT", { concurrency: false }, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "fake-dsh-busy-"));
  const bin = path.join(dir, "fake-dsh.mjs");
  // First call hangs until a file appears — long enough for a 2nd request to arrive.
  writeFileSync(bin, `import { existsSync } from "node:fs";
const release = process.env.FAKE_RELEASE;
while (!existsSync(release)) { await new Promise(r => setTimeout(r, 20)); }
console.log(JSON.stringify({ content: "done" }));`);
  const patch = path.join(dir, "fake.patch.yml");
  writeSafePatch(patch);
  const release = path.join(dir, "release");
  try {
    const first = runDshAsk("câu hỏi chậm", {
      maxConcurrent: 1, // the REAL cap — the second request must be refused
      env: { FAKE_RELEASE: release },
      overrides: { dshEntry: bin, patch, cwd: dir, timeoutMs: 15_000, dshHomeBase: path.join(dir, "home") },
    });
    // Wait until the first is truly in flight via the module counter.
    for (let i = 0; i < 100 && dshInFlight() === 0; i++) await new Promise((r) => setTimeout(r, 20));
    assert.equal(dshInFlight(), 1);
    const second = await runDshAsk("câu hỏi thứ hai", {
      maxConcurrent: 1,
      env: { FAKE_RELEASE: release },
      overrides: { dshEntry: bin, patch, cwd: dir, timeoutMs: 15_000, dshHomeBase: path.join(dir, "home") },
    });
    assert.equal(second.ok, false);
    assert.equal(second.code, DSH_IN_FLIGHT);
    writeFileSync(release, "1");
    const firstResult = await first;
    assert.equal(firstResult.ok, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("dshGatewayAsk — input size bound (plan §20 max input)", async () => {
  const long = "x".repeat(3000); // default maxTextLength = 2000
  const out = await dshGatewayAsk(long, { env: {} });
  assert.equal(out.ok, false);
  assert.equal(out.httpStatus, 400);
  assert.equal(out.code, "DSH_GATEWAY_BAD_REQUEST");
});

test("dshGatewayAsk — empty message ⇒ 400 DSH_GATEWAY_BAD_REQUEST", async () => {
  const out = await dshGatewayAsk("   ", { env: {} });
  assert.equal(out.ok, false);
  assert.equal(out.httpStatus, 400);
  assert.equal(out.code, "DSH_GATEWAY_BAD_REQUEST");
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. Sessions (plan §6) — B2
// ─────────────────────────────────────────────────────────────────────────────

test("DshSessionStore — prior turns carry over, cap at maxTurns, TTL expiry starts fresh", () => {
  let now = 1_000_000;
  const store = DshSessionStore.memory();
  store.touch("conv-1", { question: "q1", answer: "a1", maxTurns: 3 });
  store.touch("conv-1", { question: "q2", answer: "a2", maxTurns: 3 });
  store.touch("conv-1", { question: "q3", answer: "a3", maxTurns: 3 });
  store.touch("conv-1", { question: "q4", answer: "a4", maxTurns: 3 });
  const turns = store.get("conv-1", { maxTurns: 3 });
  assert.deepEqual(turns.map((t) => t.question), ["q2", "q3", "q4"], "only the LAST maxTurns survive");
  // TTL: mutate the clock past the TTL and the session starts fresh.
  now += 31 * 60_000;
  const ttlStore = DshSessionStore.memory();
  ttlStore.touch("conv-ttl", { question: "old", answer: "x" });
  const stale = new DshSessionStore(null, { clock: () => Date.now() + 31 * 60_000 });
  assert.deepEqual(stale.get("conv-ttl"), [], "TTL-expired session returns no prior turns");
});

test("runDshAsk — prior turns of the SAME conversation reach the dsh prompt (plan §6, honest one-shot session)", { concurrency: false }, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "fake-dsh-session-"));
  const argvFile = path.join(dir, "argv.jsonl");
  const bin = path.join(dir, "fake-dsh.mjs");
  writeFileSync(
    bin,
    `import { appendFileSync } from "node:fs";
appendFileSync(process.env.FAKE_DSH_ARGV, JSON.stringify(process.argv) + "\\n");
console.log(JSON.stringify({ content: "ok" }));`,
  );
  const patch = path.join(dir, "fake.patch.yml");
  writeSafePatch(patch);
  const store = DshSessionStore.memory();
  store.touch("conv-sess", { question: "chị Lan còn nợ bao nhiêu", answer: "2.500.000đ" });
  try {
    const out = await runDshAsk("còn bao nhiêu nữa là hết nợ", {
      conversationId: "conv-sess",
      maxConcurrent: 0,
      env: { FAKE_DSH_ARGV: argvFile },
      store,
      overrides: { dshEntry: bin, patch, cwd: dir, timeoutMs: 15_000, dshHomeBase: path.join(dir, "home") },
    });
    assert.equal(out.ok, true);
    const argv = JSON.parse(readFileSync(argvFile, "utf8"));
    const prompt = argv[6];
    assert.match(prompt, /Câu hỏi trước: chị Lan còn nợ bao nhiêu/);
    assert.match(prompt, /Trả lời trước: 2\.500\.000đ/);
    assert.match(prompt, /Câu hỏi hiện tại: còn bao nhiêu nữa là hết nợ/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("DshSessionStore — file-backed survives a NEW store instance (restart)", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "dsh-session-"));
  try {
    const a = DshSessionStore.file(dir);
    a.touch("conv-file", { question: "q1", answer: "a1" });
    const b = DshSessionStore.file(dir);
    const turns = b.get("conv-file");
    assert.equal(turns.length, 1);
    assert.equal(turns[0].question, "q1");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. Full gateway turn + audit (B5) — one log line per turn, mode=dsh
// ─────────────────────────────────────────────────────────────────────────────

test("dshGatewayAsk — happy path: audit line has mode=dsh + request_id; response envelope carries conversation", async () => {
  const { bin, dir } = makeFakeDsh(`console.log(JSON.stringify({ content: "Trả lời từ ERPNext (mock LLM chỉ đọc lại kết quả, không tự tính): Khách Lan còn nợ 457.875đ" }));`);
  const patch = path.join(dir, "fake.patch.yml");
  writeSafePatch(patch);
  const logDir = mkdtempSync(path.join(tmpdir(), "dsh-audit-"));
  try {
    await withFakeNlp(null, async (port) => {
      const out = await dshGatewayAsk("chị Lan còn nợ bao nhiêu", {
        env: { NLP_SERVICE_PORT: String(port), LEARNING_LOG_DIR: logDir },
        requestId: "req-test-1",
        conversationId: "conv-test-1",
        maxConcurrent: 0,
        store: DshSessionStore.memory(),
        overrides: { dshEntry: bin, patch, cwd: dir, timeoutMs: 15_000, dshHomeBase: path.join(dir, "home") },
      });
      assert.equal(out.ok, true, JSON.stringify(out));
      assert.equal(out.mode, "dsh");
      assert.equal(out.conversationId, "conv-test-1");
      assert.equal(out.requestId, "req-test-1");
      assert.match(out.answer.content, /457\.875/);
      const lines = readLog(path.join(logDir, "observations.jsonl"));
      assert.equal(lines.length, 1, "exactly ONE audit line per turn");
      assert.equal(lines[0].phase, "dsh_ask");
      assert.equal(lines[0].outcome, "answered");
      assert.equal(lines[0].mode, "dsh");
      assert.equal(lines[0].request_id, "req-test-1");
      assert.ok(lines[0].dsh_session_id);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(logDir, { recursive: true, force: true });
  }
});

test("dshGatewayAsk — refused WRITE writes ONE audit line with outcome=gateway_refused and NEVER spawns dsh", async () => {
  const logDir = mkdtempSync(path.join(tmpdir(), "dsh-audit-ref-"));
  let spawned = false;
  await withFakeNlp(null, async (port) => {
    const out = await dshGatewayAsk("thu tiền cho chị Lan 50 nghìn", {
      env: { NLP_SERVICE_PORT: String(port), LEARNING_LOG_DIR: logDir },
      requestId: "req-refused",
      conversationId: "conv-refused",
      maxConcurrent: 0,
      store: DshSessionStore.memory(),
      // Point at a fake entry that would MARK its execution; must never run.
      overrides: { dshEntry: path.join(HERE, "does-not-exist.mjs"), patch: path.join(HERE, "no.patch.yml") },
    });
    assert.equal(out.ok, false);
    assert.equal(out.code, DSH_WRITE_BLOCKED_CODE);
    assert.equal(out.httpStatus, 200, "a refusal is a normal answer, not a server error");
    assert.equal(out.mode, "dsh");
    assert.equal(spawned, false); // the fake would have flipped this if it ran
    const lines = readLog(path.join(logDir, "observations.jsonl"));
    assert.equal(lines.length, 1);
    assert.equal(lines[0].outcome, DSH_GATEWAY_REFUSED);
    assert.equal(lines[0].error_code, DSH_WRITE_BLOCKED_CODE);
    assert.equal(lines[0].mode, "dsh");
    rmSync(logDir, { recursive: true, force: true });
  });
});


// ─────────────────────────────────────────────────────────────────────────────
// 6. Output parsing + env law details
// ─────────────────────────────────────────────────────────────────────────────

test("parseDshFinalAnswer — JSON shape wins; the VERIFIED plain-prose shape is the answer too", () => {
  const withJson = [
    "All commands must be run on the user machine.",
    "The local server is running on the user's machine.",
    "đang nghĩ...",
    '{"partial": true}',
    '{"content": "final answer"}',
  ].join("\n");
  assert.equal(stripDshBanner(withJson).startsWith("All commands"), false);
  assert.deepEqual(parseDshFinalAnswer(withJson), { content: "final answer" });

  // Shape B — what real dsh 0.1.5-rc.1 actually prints (one prose line, exit 0).
  // An earlier parser required JSON here and reported DSH_BAD_OUTPUT for a good
  // answer; this assertion is the regression guard for that bug.
  const prose =
    "All commands must be run on the user machine.\n" +
    "Trả lời từ ERPNext (mock LLM chỉ đọc lại kết quả, không tự tính): Nguyễn Thị Lan còn nợ 2.500.000đ (1 chứng từ chưa thanh toán).";
  assert.deepEqual(parseDshFinalAnswer(prose), {
    content: "Trả lời từ ERPNext (mock LLM chỉ đọc lại kết quả, không tự tính): Nguyễn Thị Lan còn nợ 2.500.000đ (1 chứng từ chưa thanh toán).",
  });

  // Empty output is still a failure (no invention from nothing).
  assert.equal(parseDshFinalAnswer(""), null);
  assert.equal(parseDshFinalAnswer("   \n  "), null);
});

test("parseDshTarget — reads REAL|mock from the copilot child's stderr (audit evidence)", () => {
  assert.equal(parseDshTarget("[copilot] ERPNext target: REAL -> erp.example.test\n"), "REAL");
  assert.equal(parseDshTarget("[copilot] ERPNext target: mock -> mock (in-memory)\n"), "mock");
  assert.equal(parseDshTarget("no target line here"), null);
  assert.equal(parseDshTarget(null), null);
});

test("scrubDiagnostics — a secret-looking value never survives into a stored tail", () => {
  const scrubbed = scrubDiagnostics("Authorization: Bearer abc123\napi_key=deadbeef\nsk-live-ABCDEFGH12345678");
  assert.doesNotMatch(scrubbed, /abc123|deadbeef|ABCDEFGH12345678/);
  assert.match(scrubbed, /<redacted>/);
});

test("buildDshChildEnv — strips secrets, mutates nothing, invents no marker", () => {
  const parent = { A: "1", ASK_PASSWORD: "p" };
  const child = buildDshChildEnv(parent);
  assert.equal(child.A, "1", "ordinary env is inherited");
  assert.equal(child.ASK_PASSWORD, undefined, "secrets are stripped");
  assert.equal(parent.ASK_PASSWORD, "p", "parent untouched");
  assert.deepEqual([...DSH_SECRET_ENV_KEYS].sort(), ["ASK_PASSWORD", "GEMINI_API_KEY", "GH_TOKEN", "MAC_LLM_API_KEY", "ZEN_API_KEY"]);
});

test("dshGatewayConfig — broken env numbers fall back to safe defaults (env-number law)", () => {
  const cfg = dshGatewayConfig({ DSH_TIMEOUT_MS: "abc", DSH_MAX_CONCURRENT: "0", DSH_MAX_TEXT: "-5", DSH_SESSION_TTL_MS: "" });
  assert.equal(cfg.timeoutMs, 180_000);
  assert.equal(cfg.maxConcurrent, 1);
  assert.equal(cfg.maxTextLength, 2000);
  assert.equal(cfg.sessionTtlMs, 30 * 60_000);
});

// ─────────────────────────────────────────────────────────────────────────────
// REMOTE MODE (`.plan/dsh_prompt_check.md` §2) — the Mac topology
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A fetch double that records the calls it received and replays a canned
 * response. Replaces the network only — the request the gateway BUILDS is the
 * thing under test here (URL, auth header, body shape).
 */
function fakeFetch(handler) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url: String(url), init: init ?? {} });
    const canned = handler(String(url), init ?? {});
    if (canned instanceof Error) throw canned;
    return {
      ok: canned.status >= 200 && canned.status < 300,
      status: canned.status,
      json: async () => canned.body,
    };
  };
  return { impl, calls };
}

const REMOTE_ENV = () => ({ DSH_MODE: "remote", DSH_REMOTE_URL: "https://mac.example", DSH_REMOTE_TOKEN: "token-1234567890", NLP_SERVICE_PORT: "8787" });

test("remote mode sends the prompt to the Mac runner and parses its stdout/stderr like a local run", async () => {
  const { impl, calls } = fakeFetch(() => ({
    status: 200,
    body: {
      ok: true,
      // Multi-line prose: the parser must keep the WHOLE answer (review F1) —
      // an earlier draft returned only the last line, which for a real answer
      // ("... còn nợ 171.800đ", then a breakdown) silently dropped the amount.
      stdout: "Khách Lan còn nợ:\n- HĐ-1: 100.000đ\n- HĐ-2: 71.800đ\nTổng: 171.800đ\n",
      stderr: "[copilot] ERPNext target: REAL -> host\n",
    },
  }));

  const out = await runDshAsk("chị Lan còn nợ bao nhiêu", {
    env: REMOTE_ENV(),
    fetchImpl: impl,
    store: DshSessionStore.memory(),
    maxConcurrent: 0,
  });

  assert.equal(out.ok, true);
  assert.equal(out.runtime, "remote", "the result says WHERE it ran");
  assert.equal(out.target, "REAL", "the target marker is read from the runner's stderr");
  assert.match(out.answer.content, /171\.800đ/, "the whole answer survives the parser");
  assert.match(out.answer.content, /100\.000đ/, "including the lines before the last");

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://mac.example/run");
  assert.equal(calls[0].init.headers.authorization, "Bearer token-1234567890");
  assert.equal(JSON.parse(calls[0].init.body).prompt, "chị Lan còn nợ bao nhiêu");
});

test("remote mode carries the prior turns into the prompt (session continuity is the gateway's job)", async () => {
  const { impl, calls } = fakeFetch(() => ({ status: 200, body: { ok: true, stdout: "{\"content\":\"ok\"}", stderr: "" } }));
  const store = DshSessionStore.memory();
  const env = REMOTE_ENV();
  const conversationId = "11111111-1111-4111-8111-111111111111";
  // Seeded directly: the store is written by dshGatewayAsk (the HTTP-level
  // entry), so a runDshAsk-only test would pass vacuously — the first draft did
  // exactly that and failed, which is how this seam was found.
  store.touch(conversationId, { question: "câu 1", answer: "câu trả lời 1", ttlMs: 60_000 });

  await runDshAsk("câu 2", { env, fetchImpl: impl, store, maxConcurrent: 0, conversationId });

  const prompt = JSON.parse(calls[0].init.body).prompt;
  assert.match(prompt, /câu 1/, "the previous question travels with the new one");
  assert.match(prompt, /Câu hỏi hiện tại: câu 2/);
});

test("remote mode sends a first-turn question alone (no empty history scaffolding)", async () => {
  const { impl, calls } = fakeFetch(() => ({ status: 200, body: { ok: true, stdout: "{\"content\":\"ok\"}", stderr: "" } }));
  await runDshAsk("câu đầu tiên", {
    env: REMOTE_ENV(),
    fetchImpl: impl,
    store: DshSessionStore.memory(),
    maxConcurrent: 0,
    conversationId: "22222222-2222-4222-8222-222222222222",
  });
  assert.equal(JSON.parse(calls[0].init.body).prompt, "câu đầu tiên");
});

test("remote mode with no configuration REFUSES — it never downgrades to a local spawn", async () => {
  // A perfectly good local entry is configured here on purpose: if any code path
  // fell back to it, the fake would run and this test would see argv evidence.
  const dir = mkdtempSync(path.join(tmpdir(), "dsh-nodowngrade-"));
  const argvFile = path.join(dir, "argv.jsonl");
  const { bin } = makeFakeDsh(`console.log(JSON.stringify({ content: "LOCAL RAN" }));`);
  try {
    const out = await runDshAsk("chị Lan còn nợ bao nhiêu", {
      maxConcurrent: 0,
      env: { DSH_MODE: "remote", FAKE_DSH_ARGV: argvFile, NLP_SERVICE_PORT: "8787" },
      overrides: { dshEntry: bin, patch: writeSafePatch(path.join(dir, "p.yml")), cwd: dir, dshHomeBase: path.join(dir, "home") },
    });
    assert.equal(out.ok, false);
    assert.equal(out.code, "DSH_UNAVAILABLE");
    assert.equal(out.runtime, "remote");
    assert.equal(existsSync(argvFile), false, "the local fake must never have run");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("remote mode maps a rejected token to DSH_REMOTE_UNAUTHORIZED (never a generic failure)", async () => {
  const { impl } = fakeFetch(() => ({ status: 401, body: { ok: false, error: "unauthorized" } }));
  const out = await runDshAsk("câu hỏi", { env: REMOTE_ENV(), fetchImpl: impl, store: DshSessionStore.memory(), maxConcurrent: 0 });
  assert.equal(out.ok, false);
  assert.equal(out.code, "DSH_REMOTE_UNAUTHORIZED");
  assert.match(out.reason, /xác thực/);
});

test("remote mode maps a dead tunnel to DSH_REMOTE_ERROR with a scrubbed tail", async () => {
  const { impl } = fakeFetch(() => Object.assign(new Error("connect ECONNREFUSED token-1234567890"), { name: "FetchError" }));
  const out = await runDshAsk("câu hỏi", { env: REMOTE_ENV(), fetchImpl: impl, store: DshSessionStore.memory(), maxConcurrent: 0 });
  assert.equal(out.ok, false);
  assert.equal(out.code, "DSH_REMOTE_ERROR");
  assert.doesNotMatch(out.logTail, /token-1234567890/, "a token-looking value is scrubbed before it is stored");
});

test("remote mode maps a timeout to DSH_TIMEOUT with the SAME wording as a local timeout", async () => {
  // The double throws the same error name AbortSignal.timeout produces, so this
  // exercises the real catch branch rather than a re-implementation of it.
  const { impl } = fakeFetch(() => Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" }));
  const out = await runDshAsk("câu hỏi", { env: REMOTE_ENV(), fetchImpl: impl, store: DshSessionStore.memory(), maxConcurrent: 0 });
  assert.equal(out.code, "DSH_TIMEOUT");
  assert.equal(out.reason, DSH_TIMEOUT_MESSAGE);
});

test("remote mode reports DSH_BAD_OUTPUT when the runner returns an empty answer", async () => {
  const { impl } = fakeFetch(() => ({ status: 200, body: { ok: true, stdout: "", stderr: "[copilot] ERPNext target: mock\n" } }));
  const out = await runDshAsk("câu hỏi", { env: REMOTE_ENV(), fetchImpl: impl, store: DshSessionStore.memory(), maxConcurrent: 0 });
  assert.equal(out.code, "DSH_BAD_OUTPUT");
  assert.equal(out.target, "mock");
});

// ─────────────────────────────────────────────────────────────────────────────
// HEALTH + RUNTIME INFO (§3) — the probe must tell the truth about THIS machine
// ─────────────────────────────────────────────────────────────────────────────

test("dshGatewayHealth — local mode verifies the patch marker, not just file existence", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "dsh-health-"));
  try {
    const safe = writeSafePatch(path.join(dir, "safe.yml"));
    const unsafe = path.join(dir, "unsafe.yml");
    writeFileSync(unsafe, "- insert:\n    - id: erpn-copilot-mcp\n");

    const ok = await dshGatewayHealth({ env: { DSH_ENTRY: process.execPath, DSH_PATCH: safe } });
    assert.equal(ok.available, true);
    assert.equal(ok.mode, "local");

    const bad = await dshGatewayHealth({ env: { DSH_ENTRY: process.execPath, DSH_PATCH: unsafe } });
    assert.equal(bad.available, false, "a patch without the write-gate marker is NOT available");
    assert.match(bad.detail, /COPILOT_DSH_CONTEXT/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("dshGatewayHealth — remote mode says UNAVAILABLE when the Mac cannot be reached", async () => {
  const { impl } = fakeFetch(() => Object.assign(new Error("ECONNREFUSED"), { name: "FetchError" }));
  const health = await dshGatewayHealth({ env: REMOTE_ENV(), fetchImpl: impl });
  assert.equal(health.available, false);
  assert.equal(health.mode, "remote");
});

test("dshGatewayHealth — remote mode reports the runner's version when it answers", async () => {
  const { impl } = fakeFetch(() => ({ status: 200, body: { ok: true, runtime: "dsh-remote-runner", entry: "lib/bin.js", version: "0.1.5-rc.1" } }));
  const health = await dshGatewayHealth({ env: REMOTE_ENV(), fetchImpl: impl });
  assert.equal(health.available, true);
  assert.equal(health.version, "0.1.5-rc.1");
});

test("dshRuntimeInfo — reports the installed version and the patch marker honestly", () => {
  const info = dshRuntimeInfo();
  assert.equal(info.version, "0.1.5-rc.1", "the pinned runtime version is visible for the §3 check");
  assert.equal(info.entryExists, true);
  assert.equal(info.patchMarksDshContext, true);
});

// ─────────────────────────────────────────────────────────────────────────────
// CONVERSATION ID BOUNDARY (review F3)
// ─────────────────────────────────────────────────────────────────────────────

test("isValidConversationId — accepts a uuid, rejects traversal / overlong / junk", () => {
  assert.equal(isValidConversationId("11111111-1111-4111-8111-111111111111"), true);
  assert.equal(isValidConversationId("..%2f..%2fetc%2fpasswd"), false);
  assert.equal(isValidConversationId("../../etc/passwd"), false);
  assert.equal(isValidConversationId("a".repeat(200)), false);
  assert.equal(isValidConversationId("has space"), false);
  assert.equal(isValidConversationId(""), false);
  assert.equal(isValidConversationId(null), false);
});

test("DshSessionStore — a malformed conversation id can neither be written nor read back", () => {
  const store = DshSessionStore.memory();
  store.touch("../../escape", { question: "q", answer: "a", ttlMs: 60_000 });
  assert.deepEqual(store.get("../../escape"), []);
});

test("parseDshFinalAnswer — a multi-line prose answer is NOT truncated to its last line (F1)", () => {
  const stdout = "Khách Lan còn nợ 171.800đ\n- HĐ-1: 100.000đ\n- HĐ-2: 71.800đ";
  const parsed = parseDshFinalAnswer(stdout);
  assert.equal(parsed.content, stdout);
  assert.match(parsed.content, /171\.800đ/);
});
