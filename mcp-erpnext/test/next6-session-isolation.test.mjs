/**
 * NEXT 6 — Session / identity isolation tests (spec §9).
 *
 * These prove, with executable evidence, the two properties NEXT 6 exists for:
 *   1. a session is scoped by (principal, conversation) — one principal can
 *      never read, resume, or clear another's context; and
 *   2. a WRITE is bound to the principal it was built for — a command_id or a
 *      proposal from A cannot be replayed/confirmed by B.
 *
 * They are hermetic (no ERPNext, no real DSH runtime): the DSH session tests
 * use a fake dsh entry (the same seam the existing dsh-gateway tests use) and
 * the store/context tests are pure.
 *
 * NOTE: the memory session store is a MODULE-LEVEL Map shared by every
 * `DshSessionStore.memory()` instance (by design), so each test uses its own
 * unique principal/conversation names — that is the isolation property under
 * test, and it keeps the tests independent.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { DshSessionStore, SESSION_LIMIT_EXCEEDED, DSH_IN_FLIGHT, runDshAsk, dshGatewayAsk, dshInFlight } from "../src/dsh-gateway.mjs";
import { IdempotencyStore, fingerprintProposal } from "../src/idempotency.mjs";
import { SessionContext, CONTEXT_PROVENANCE } from "../src/session-context.mjs";

// Hermetic: a leaked shell env must never flip the target/switch on us.
for (const k of Object.keys(process.env)) {
  if (/^(ERPNEXT_|ASK_)/.test(k)) delete process.env[k];
}

function writeSafePatch(file) {
  writeFileSync(
    file,
    "- insert:\n    - id: erpn-copilot-mcp\n      config:\n        env:\n          COPILOT_DSH_CONTEXT: '1'\n",
  );
  return file;
}

// ─────────────────────────────────────────────────────────────────────────────
// §9.1 / §9.3 / §9.4 — session key isolation
// ─────────────────────────────────────────────────────────────────────────────

test("§9.1 session isolation — A/C-A and B/C-B keep their own context (and B cannot read A's)", () => {
  const store = DshSessionStore.memory();
  store.touch("isoA", "cA", { question: "A hỏi 1", answer: "A đáp 1" });
  store.touch("isoB", "cB", { question: "B hỏi 1", answer: "B đáp 1" });

  assert.equal(store.get("isoA", "cA")[0].question, "A hỏi 1", "A resumes A's context");
  assert.equal(store.get("isoB", "cB")[0].question, "B hỏi 1", "B resumes B's context");

  // The core invariant: B sending A's conversation id gets NOTHING of A's.
  assert.deepEqual(store.get("isoB", "cA"), [], "B must never read A's context via A's conversation id");
  assert.deepEqual(store.get("isoA", "cB"), [], "A must never read B's context via B's conversation id");

  store.touch("isoA", "cA", { question: "A hỏi 2", answer: "A đáp 2" });
  assert.deepEqual(store.get("isoA", "cA").map((t) => t.question), ["A hỏi 1", "A hỏi 2"]);
});

test("§9.4 same conversation id, DIFFERENT principals ⇒ two independent sessions", () => {
  const store = DshSessionStore.memory();
  store.touch("sharedP1", "sharedConv", { question: "câu của P1", answer: "đáp P1" });

  assert.deepEqual(store.get("sharedP2", "sharedConv"), [], "P2 shares the id but is a different principal");
  assert.equal(store.get("sharedP1", "sharedConv")[0].question, "câu của P1", "P1's own context is intact");

  store.touch("sharedP2", "sharedConv", { question: "câu của P2", answer: "đáp P2" });
  assert.equal(store.get("sharedP2", "sharedConv")[0].question, "câu của P2");
  assert.equal(store.get("sharedP1", "sharedConv").length, 1, "writing P2's own session did not touch P1's");
});

test("§9.3 same principal, two conversations stay separate", () => {
  const store = DshSessionStore.memory();
  store.touch("twoConvP", "k1", { question: "k1 q", answer: "a" });
  store.touch("twoConvP", "k2", { question: "k2 q", answer: "a" });
  assert.equal(store.get("twoConvP", "k1")[0].question, "k1 q");
  assert.equal(store.get("twoConvP", "k2")[0].question, "k2 q");
});

// ─────────────────────────────────────────────────────────────────────────────
// §3.1 — clear is scoped to the caller
// ─────────────────────────────────────────────────────────────────────────────

test("§3.1 clear removes ONLY the caller's namespace — another principal survives", () => {
  const store = DshSessionStore.memory();
  store.touch("CLEAR-A", "c1", { question: "a", answer: "a" });
  store.touch("CLEAR-A", "c2", { question: "a", answer: "a" });
  store.touch("CLEAR-B", "c1", { question: "b", answer: "b" });

  assert.equal(store.clear("CLEAR-A"), 2, "cleared exactly the caller's two sessions");
  assert.deepEqual(store.get("CLEAR-A", "c1"), []);
  assert.deepEqual(store.get("CLEAR-A", "c2"), []);
  assert.equal(store.get("CLEAR-B", "c1")[0].question, "b", "the other principal's context was NOT deleted");
});

test("§3.1 delete removes ONE principal's session and leaves the other's same-id session", () => {
  const store = DshSessionStore.memory();
  store.touch("DEL-A", "shared", { question: "a", answer: "a" });
  store.touch("DEL-B", "shared", { question: "b", answer: "b" });
  assert.equal(store.delete("DEL-A", "shared"), true);
  assert.deepEqual(store.get("DEL-A", "shared"), []);
  assert.equal(store.get("DEL-B", "shared")[0].question, "b");
});

// ─────────────────────────────────────────────────────────────────────────────
// §3.0 — deterministic lifecycle: LRU + active protection + hard cap
// ─────────────────────────────────────────────────────────────────────────────

test("§3.0 eviction is LRU and never evicts an actively-processing session", () => {
  const store = DshSessionStore.memory({ maxSessions: 2 });
  store.touch("lifeP", "lc1", { question: "q1", answer: "a", ttlMs: 10 * 60_000 });
  store.touch("lifeP", "lc2", { question: "q2", answer: "a", ttlMs: 10 * 60_000 });
  // Touch lc1 so lc2 becomes the least-recently-used session.
  store.touch("lifeP", "lc1", { question: "q1b", answer: "a" });
  // lc2 is now the LRU — protect it as "actively processing".
  store.markActive("lifeP", "lc2");

  store.touch("lifeP", "lc3", { question: "q3", answer: "a" }); // forces one eviction

  assert.equal(store.has("lifeP", "lc2"), true, "the active session was protected");
  assert.equal(store.has("lifeP", "lc3"), true, "the new session was admitted");
  assert.equal(store.has("lifeP", "lc1"), false, "the LRU non-active session was evicted");
  store.unmarkActive("lifeP", "lc2");
});

test("§3.0 a full cap with every session active refuses deterministically (SESSION_LIMIT_EXCEEDED)", () => {
  const store = DshSessionStore.memory({ maxSessions: 1 });
  store.touch("capP", "cc1", { question: "q", answer: "a" });
  store.markActive("capP", "cc1");

  assert.throws(
    () => store.touch("capP", "cc2", { question: "q", answer: "a" }),
    (err) => err.code === SESSION_LIMIT_EXCEEDED,
    "no random eviction of the active session — a NAMED refusal instead",
  );
  assert.equal(store.has("capP", "cc1"), true, "the only (active) session is still there");
  assert.equal(store.has("capP", "cc2"), false, "the refused session was not admitted");
  store.unmarkActive("capP", "cc1");
});

test("§3.2 session metadata names the principal + conversation", () => {
  const store = DshSessionStore.memory();
  store.touch("metaP", "metaC", { question: "q", answer: "a" });
  const rec = store.set("metaP", "metaC", {}); // read-back of the stored record
  assert.equal(rec.principal_id, "metaP");
  assert.equal(rec.conversation_id, "metaC");
  assert.equal(typeof rec.created_at, "number");
  assert.equal(typeof rec.last_used_at, "number");
});

// ─────────────────────────────────────────────────────────────────────────────
// §4 — same-conversation serialization (no lost update / no interleaving)
// ─────────────────────────────────────────────────────────────────────────────

test("§9.2 same-conversation requests serialize — the two sessions never overlap", async () => {
  const dir = mkdtempSync(join(tmpdir(), "next6-lock-"));
  const traceFile = join(dir, "trace.txt");
  const bin = join(dir, "fake-dsh.mjs");
  // The fake records start/end around a short busy-wait: if the lock works the
  // trace is start,end,start,end; if two sessions overlapped it would be
  // start,start,end,end (a lost-update shape).
  writeFileSync(
    bin,
    'import { appendFileSync } from "node:fs";\n' +
      'const f = process.env.FAKE_DSH_TRACE;\n' +
      'appendFileSync(f, "start\\n");\n' +
      'const until = Date.now() + 80;\n' +
      'while (Date.now() < until) {}\n' +
      'appendFileSync(f, "end\\n");\n' +
      'console.log(JSON.stringify({ content: "ok" }));\n',
  );
  const patch = writeSafePatch(join(dir, "p.yml"));
  const opts = {
    conversationId: "conv-lock",
    principalId: "lockP",
    maxConcurrent: 0, // no global cap; the per-conversation lock is what we test
    env: { FAKE_DSH_TRACE: traceFile },
    store: DshSessionStore.memory(),
    overrides: { dshEntry: bin, patch, cwd: dir, timeoutMs: 15_000, dshHomeBase: join(dir, "home") },
  };
  try {
    await Promise.all([runDshAsk("câu một", opts), runDshAsk("câu hai", opts)]);
    const trace = readFileSync(traceFile, "utf8").trim().split("\n");
    assert.deepEqual(trace, ["start", "end", "start", "end"], "sessions ran one after the other, never overlapping");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// §9.6 — WRITE isolation (command_id + proposal ownership)
// ─────────────────────────────────────────────────────────────────────────────

test("§9.6 idempotency — B cannot replay a COMPLETED command_id of A", () => {
  const dir = mkdtempSync(join(tmpdir(), "next6-idem-"));
  try {
    const store = new IdempotencyStore(dir);
    const cid = randomUUID();
    const fp = "fp-static";
    store.begin(cid, { action: "create_payment_entry", fingerprint: fp, user_id: "A" });
    store.complete(cid, { erpnext_doc: "PE-A-1" });

    assert.throws(
      () => store.begin(cid, { action: "create_payment_entry", fingerprint: fp, user_id: "B" }),
      (err) => err.code === "COMMAND_ID_FOREIGN",
      "B must be refused, not handed A's result",
    );

    // A itself still gets the once-only replay — the guarantee is per-principal.
    const replay = store.begin(cid, { action: "create_payment_entry", fingerprint: fp, user_id: "A" });
    assert.equal(replay.replay, true);
    assert.equal(replay.result.erpnext_doc, "PE-A-1");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("§9.6 safety gateway — a proposal stamped for another principal is refused", async () => {
  const { runExecute } = await import("../src/safety-gateway.mjs");
  const dir = mkdtempSync(join(tmpdir(), "next6-prop-"));
  try {
    const store = new IdempotencyStore(dir);
    const commandId = randomUUID();
    const proposal = {
      schema: "erpn.proposal/v1",
      proposal_id: "prp_next6-mismatch",
      version: 1,
      action: "create_payment_entry",
      risk: "HIGH",
      created_at: new Date().toISOString(),
      action_id: "act_next6",
      entity: { kind: "customer", id: "CUST-00001", name: "Khách" },
      params: { amount_vnd: 1_000_000, invoice: "SINV-0001", outstanding_vnd: 1_000_000, mode: "Tiền mặt" },
      summary: "test",
      principal_user_id: "A", // built for A
    };
    const verdict = await runExecute({
      command_id: commandId,
      proposal,
      store,
      principal: { user_id: "B", permissions: ["Accounts User"], mode: "single_tenant" },
      env: {},
    });
    assert.equal(verdict.status, 403, JSON.stringify(verdict.body));
    assert.equal(verdict.body.code, "PROPOSAL_PRINCIPAL_MISMATCH");
    // The refusal must not have burned the command_id for anyone.
    assert.equal(store.status(commandId), null, "a cross-principal refusal writes no command record");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// §2.2 / G3 — sessionContext scoped by principal
// ─────────────────────────────────────────────────────────────────────────────

test("G3 sessionContext — one principal's selected customer cannot seed another's WRITE", () => {
  const ctx = new SessionContext();
  ctx.set("customer", { id: "C-A", provenance: CONTEXT_PROVENANCE.USER_SELECTED }, { scope: "ctxA\u0000c1" });

  const aCtx = ctx.writeEligible("customer", { scope: "ctxA\u0000c1" });
  assert.equal(aCtx.eligible, true);
  assert.equal(aCtx.context.value, "C-A");

  const bCtx = ctx.writeEligible("customer", { scope: "ctxB\u0000c1" });
  assert.equal(bCtx.eligible, false, "B never sees A's selected customer");

  ctx.set("customer", { id: "C-B", provenance: CONTEXT_PROVENANCE.USER_SELECTED }, { scope: "ctxB\u0000c1" });
  ctx.clear("ctxA\u0000c1"); // A clears A
  assert.equal(ctx.get("customer", { scope: "ctxA\u0000c1" }), null, "A's namespace is gone");
  assert.equal(ctx.get("customer", { scope: "ctxB\u0000c1" }).value, "C-B", "B's namespace survives A's clear");
});

test("G3 sessionContext — same principal, different conversation stays separate", () => {
  const ctx = new SessionContext();
  ctx.set("customer", { id: "C-1", provenance: CONTEXT_PROVENANCE.USER_SELECTED }, { scope: "ctxSame\u0000c1" });
  assert.equal(ctx.writeEligible("customer", { scope: "ctxSame\u0000c2" }).eligible, false);
});

// ─────────────────────────────────────────────────────────────────────────────
// Prompt 3 — §B: timeout kill + scratch DSH_HOME cleanup; cleanup never touches
// another session; the timed-out run commits nothing.
// ─────────────────────────────────────────────────────────────────────────────

test("Prompt3 timeout — hung child is killed, scratch DSH_HOME is cleaned, other sessions survive, nothing committed", { concurrency: false }, async () => {
  const outer = mkdtempSync(join(tmpdir(), "next6-cleanup-"));
  const traceFile = join(outer, "trace.txt");
  const bin = join(outer, "fake-dsh-hang.mjs");
  writeFileSync(
    bin,
    'import { appendFileSync } from "node:fs";\n' +
      'appendFileSync(process.env.FAKE_DSH_TRACE, "start\\n");\n' +
      // A forever-pending promise with NO handles makes node EXIT (13, unfinished
      // top-level await) instead of hanging — the child must hold a live timer
      // so it really hangs and the gateway's timeout is what stops it.
      'await new Promise(() => setInterval(() => {}, 60_000));\n',
  );
  const patch = writeSafePatch(join(outer, "p.yml"));
  const store = DshSessionStore.memory();
  store.touch("cleanP", "conv-keep", { question: "giữ tôi", answer: "x" }); // must survive the cleanup below

  const previousTmp = process.env.TMPDIR;
  process.env.TMPDIR = outer; // os.tmpdir() re-reads TMPDIR per call ⇒ the runner's per-call scratch lands in `outer`
  try {
    const out = await runDshAsk("câu hỏi treo", {
      conversationId: "conv-clean",
      principalId: "cleanP",
      maxConcurrent: 0,
      env: { FAKE_DSH_TRACE: traceFile },
      store,
      overrides: { dshEntry: bin, patch, cwd: outer, timeoutMs: 200, dshHomeBase: join(outer, "home") },
    });
    assert.equal(out.ok, false);
    assert.equal(out.code, "DSH_TIMEOUT");
    assert.deepEqual(
      readFileSync(traceFile, "utf8").trim().split("\n"),
      ["start"],
      "the child was killed mid-run (never got to finish its answer)",
    );
    const leftovers = readdirSync(outer).filter((n) => n.startsWith("dsh-ask-"));
    assert.equal(leftovers.length, 0, "the per-call scratch DSH_HOME was removed — no orphaned process resources");
    assert.equal(store.get("cleanP", "conv-keep")[0].question, "giữ tôi", "cleanup never touches another session");
    assert.equal(store.has("cleanP", "conv-clean"), false, "the timed-out (unverified) run committed no context");
  } finally {
    if (previousTmp === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previousTmp;
    rmSync(outer, { recursive: true, force: true });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Prompt 3 — §5: global DSH concurrency stays 1. Two DIFFERENT conversations of
// one principal must not overlap (the second meets the global cap and is told
// busy — the contract — not silently queued), and each keeps strictly its own
// context turns.
// ─────────────────────────────────────────────────────────────────────────────

test("Prompt3 global=1 — second conversation gets DSH_IN_FLIGHT, retries cleanly, never sees the other conversation's turns", { concurrency: false }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "next6-g1-"));
  const traceFile = join(dir, "trace.txt");
  const argvFile = join(dir, "argv.jsonl");
  const bin = join(dir, "fake-dsh.mjs");
  writeFileSync(
    bin,
    'import { appendFileSync } from "node:fs";\n' +
      'if (process.env.FAKE_DSH_ARGV) appendFileSync(process.env.FAKE_DSH_ARGV, JSON.stringify(process.argv) + "\\n");\n' +
      'appendFileSync(process.env.FAKE_DSH_TRACE, "start\\n");\n' +
      'const until = Date.now() < 60 ? 0 : Date.now() + 60;\nwhile (Date.now() < until) {}\n' +
      'appendFileSync(process.env.FAKE_DSH_TRACE, "end\\n");\n' +
      'console.log(JSON.stringify({ content: "ok" }));\n',
  );
  const patch = writeSafePatch(join(dir, "p.yml"));
  const store = DshSessionStore.memory();
  // A's committed context — must NEVER reach B's prompt.
  store.touch("g1P", "conv-g1-a", { question: "câu C1 cũ", answer: "đáp cũ" });
  const opts = (conversationId) => ({
    conversationId,
    principalId: "g1P",
    // Pin the REAL global cap (the config default is separately asserted as 1
    // in dsh-gateway.test.mjs); here we prove the behavioral consequence.
    env: { DSH_MAX_CONCURRENT: "1", FAKE_DSH_TRACE: traceFile, FAKE_DSH_ARGV: argvFile },
    store,
    overrides: { dshEntry: bin, patch, cwd: dir, timeoutMs: 15_000, dshHomeBase: join(dir, "home") },
  });
  try {
    const [ra, rb] = await Promise.all([
      runDshAsk("câu C1", opts("conv-g1-a")),
      runDshAsk("câu C2", opts("conv-g1-b")),
    ]);
    const winner = ra.ok ? ra : rb;
    const refused = ra.ok ? rb : ra;
    assert.equal(winner.ok, true, JSON.stringify(winner));
    assert.equal(refused.code, DSH_IN_FLIGHT, "the other conversation meets the GLOBAL cap — busy per contract, not queued");
    assert.deepEqual(
      readFileSync(traceFile, "utf8").trim().split("\n"),
      ["start", "end"],
      "global=1: the two conversations never ran at the same time",
    );

    // The busy conversation retries once the slot frees — and succeeds.
    const retry = await runDshAsk("câu C2", opts("conv-g1-b"));
    assert.equal(retry.ok, true);
    assert.deepEqual(readFileSync(traceFile, "utf8").trim().split("\n"), ["start", "end", "start", "end"]);

    // Prompt isolation: B's retry prompt carries ONLY its own conversation's
    // turns. B was refused before running, so C2 has no prior turns yet — the
    // prompt is the bare question; A's committed turn must not leak in.
    const argvLines = readFileSync(argvFile, "utf8").trim().split("\n");
    const prompt = JSON.parse(argvLines[argvLines.length - 1])[6];
    assert.equal(prompt, "câu C2", "no prior turns for C2 yet — and A's committed context must not leak into B's prompt");

    // A resumes: its OWN seeded context reaches its prompt, still without B's.
    // (runDshAsk reads prior turns but does not commit them — the commit step
    // belongs to dshGatewayAsk, proven separately in dsh-gateway.test.mjs.)
    const again = await runDshAsk("câu C1", opts("conv-g1-a"));
    assert.equal(again.ok, true);
    const argvLines2 = readFileSync(argvFile, "utf8").trim().split("\n");
    const prompt2 = JSON.parse(argvLines2[argvLines2.length - 1])[6];
    assert.match(prompt2, /Câu hỏi trước: câu C1 cũ/);
    assert.doesNotMatch(prompt2, /câu C2/, "B's questions never leak into A's prompt");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Guard so a broken import path is caught even if the file is trimmed.
test("next6 test module imports are wired", () => {
  assert.equal(typeof fingerprintProposal, "function");
});

// ─────────────────────────────────────────────────────────────────────────────
// Prompt-5 — observability correlation on dsh_ask audit lines
// ─────────────────────────────────────────────────────────────────────────────

/** Read the learning-log JSONL the test wrote into (same seam as dsh-gateway.test.mjs). */
function readNext6Log(logPath) {
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

const SECRET_PATTERN = /password|token|secret|api[_-]?key/i;

/** Mirror the REAL NLP /normalize shape (same seam as dsh-gateway.test.mjs):
 * the write pre-screen classifies through this — a "còn nợ" intent means READ,
 * a "thu tiền" intent means WRITE (refused). */
function normalizeLikeRealNlp(body) {
  const text = String(body?.text ?? "");
  const intents = [];
  if (/thu tiền|nhận tiền|thu hộ/.test(text)) intents.push("payment");
  if (/còn nợ|nợ bao nhiêu|công nợ/.test(text)) intents.push("receivable");
  let cleaned = text.replace(/thu tiền/g, "payment").replace(/còn nợ/g, "receivable");
  const m = /([0-9]+[.,]?[0-9]*)\s*(nghìn|ngàn|k|triệu|tr)?/i.exec(cleaned);
  const amount = m
    ? Number(String(m[1]).replace(/[.,]/g, "")) * (/nghìn|ngàn|k/i.test(m[2] ?? "") ? 1000 : /triệu|tr/i.test(m[2] ?? "") ? 1_000_000 : 1)
    : null;
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

/** Start a fake NLP on an ephemeral port, point the IN-PROCESS seam at it
 * (the pipeline reads NLP_SERVICE_PORT at module load), and guarantee teardown.
 * Without the seam call the gateway would try the REAL :8787 and fail closed
 * with DSH_GATEWAY_NLP_UNAVAILABLE — the exact bug this helper prevents. */
async function withFakeNlpObs(handlers, fn) {
  const { createServer } = await import("node:http");
  const { __setNlpServicePortForTest } = await import("../src/copilot-server.mjs");
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const handler = handlers ? (handlers[req.url ?? "/"] ?? handlers.default) : null;
      const payload = handler ? handler(JSON.parse(body || "{}")) : normalizeLikeRealNlp(JSON.parse(body || "{}"));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(payload));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  const previous = process.env.NLP_SERVICE_PORT;
  __setNlpServicePortForTest(port);
  try {
    return await fn(port);
  } finally {
    __setNlpServicePortForTest(previous ?? "8787");
    await new Promise((r) => server.close(r));
  }
}

test("Prompt5 observability — dsh_ask log line carries request_id, user_id, conversation_id, dsh_in_flight, outcome, latency (no secret)", { concurrency: false }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "next6-obs-"));
  const bin = join(dir, "fake-dsh.mjs");
  writeFileSync(
    bin,
    'import { appendFileSync } from "node:fs";\n' +
      'if (process.env.FAKE_DSH_ARGV) appendFileSync(process.env.FAKE_DSH_ARGV, JSON.stringify(process.argv) + "\\n");\n' +
      'console.log(JSON.stringify({ content: "Trả lời observability" }));\n',
  );
  const patch = writeSafePatch(join(dir, "p.yml"));
  const logDir = mkdtempSync(join(tmpdir(), "next6-obs-log-"));
  const store = DshSessionStore.memory();
  try {
    await withFakeNlpObs(null, async () => {
      const out = await dshGatewayAsk("chị Lan còn nợ bao nhiêu", {
        env: { NLP_SERVICE_PORT: "1", LEARNING_LOG_DIR: logDir },
        requestId: "req-obs-1",
        conversationId: "conv-obs-1",
        principalId: "obsPrincipal",
        maxConcurrent: 0,
        store,
        overrides: { dshEntry: bin, patch, cwd: dir, timeoutMs: 15_000, dshHomeBase: join(dir, "home") },
      });
      assert.equal(out.ok, true, JSON.stringify(out));
    });

    const lines = readNext6Log(join(logDir, "observations.jsonl"));
    assert.equal(lines.length, 1, "exactly ONE audit line per turn");
    const line = lines[0];
    assert.equal(line.phase, "dsh_ask");
    assert.equal(line.outcome, "answered");
    // The Prompt-5 correlation set — the fields an operator needs to trace
    // request → conversation → outcome without opening any other system.
    assert.equal(line.request_id, "req-obs-1");
    assert.equal(line.user_id, "obsPrincipal", "the audit line names the server-resolved principal");
    assert.equal(line.conversation_id, "conv-obs-1");
    assert.equal(typeof line.dsh_in_flight, "number", "DSH concurrency state is on the line");
    assert.equal(line.dsh_in_flight, 0, "the meter reads 0 again after the slot was released");
    assert.equal(typeof line.latency_ms, "number");
    // Secret law: the RAW line carries no credential material. text is bounded
    // to 200 chars elsewhere; here we prove no env/secret leaks via the new
    // fields either.
    const raw = JSON.stringify(line);
    assert.doesNotMatch(raw, SECRET_PATTERN, "no password/token/secret/api-key material on the log line");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(logDir, { recursive: true, force: true });
  }
});

test("Prompt5 observability — a WRITE refusal line ALSO carries principal + conversation correlation", { concurrency: false }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "next6-obs-ref-"));
  const bin = join(dir, "fake-dsh.mjs"); // never reached — the gate refuses first
  writeFileSync(bin, 'console.log(JSON.stringify({ content: "không nên chạy tới đây" }));\n');
  const patch = writeSafePatch(join(dir, "p.yml"));
  const logDir = mkdtempSync(join(tmpdir(), "next6-obs-ref-log-"));
  const store = DshSessionStore.memory();
  try {
    await withFakeNlpObs(null, async () => {
      // The fake NLP mirrors the real shape and classifies "thu tiền …" as a
      // payment intent ⇒ the WRITE pre-screen refuses BEFORE the runtime runs.
      const out = await dshGatewayAsk("thu tiền cho chị Lan 10000", {
        env: { NLP_SERVICE_PORT: "1", LEARNING_LOG_DIR: logDir },
        requestId: "req-obs-ref-1",
        conversationId: "conv-obs-ref-1",
        principalId: "refusedPrincipal",
        maxConcurrent: 0,
        store,
        overrides: { dshEntry: bin, patch, cwd: dir, timeoutMs: 15_000, dshHomeBase: join(dir, "home") },
      });
      assert.equal(out.ok, false, JSON.stringify(out));
    });

    const lines = readNext6Log(join(logDir, "observations.jsonl"));
    assert.equal(lines.length, 1);
    const line = lines[0];
    assert.equal(line.phase, "dsh_ask");
    assert.notEqual(line.outcome, "answered", "a write pre-screen refusal is not an answered line");
    assert.equal(line.user_id, "refusedPrincipal", "correlation survives the refusal branch");
    assert.equal(line.conversation_id, "conv-obs-ref-1");
    assert.equal(typeof line.dsh_in_flight, "number");
    assert.doesNotMatch(JSON.stringify(line), SECRET_PATTERN);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(logDir, { recursive: true, force: true });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Prompt-5 — API contract: user_id in the body is NEVER the authority
// ─────────────────────────────────────────────────────────────────────────────

test("Prompt5 contract — a body user_id cannot cross into another principal's session namespace", () => {
  // The route passes principalId from AUTH (http-ask.mjs passes `userId` from
  // resolvePrincipal), never from the body. The store-level proof: two
  // "clients" that both CLAIM to be user C-privileged land in THEIR OWN
  // namespaces — the id the caller passes is the only scoping key, and it
  // comes from auth upstream of any body parsing.
  const store = DshSessionStore.memory();
  store.touch("authP", "shared-c", { question: "câu của authP", answer: "đáp authP" });

  // A second "principal" (what an attacker claims in the body) must see NONE
  // of authP's context — there is no code path where a body string becomes
  // the principal id the store keys on.
  assert.deepEqual(store.get("bodyClaimedUser", "shared-c"), [], "a body-claimed identity is just another namespace — it cannot read authP's context");
  assert.equal(store.get("authP", "shared-c")[0].question, "câu của authP");

  // And the in-flight meter stays truthful regardless of what a body claims.
  assert.equal(typeof dshInFlight(), "number");
});
