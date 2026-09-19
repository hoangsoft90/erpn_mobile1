/**
 * DSH Gateway — the server-side runner behind "Phân tích bằng DSH" (user task
 * `.plan/dsh_end_to_end.md`, 2026-09-19).
 *
 * WHY THIS EXISTS: dsh (DeepSeek Harness) could only ever be started BY HAND
 * (`dsh web --patch mcp-erpnext/dsh.cordis.patch.yml`, docs/dsh-optin.md) —
 * there was no code path a server could call, so the Flutter user had no way
 * to reach the opt-in agent runtime. This module is that one path.
 *
 * LAWS (plan2_final §2 + dsh_end_to_end.md, all verbatim-tested):
 *  - D2: this module is NEVER a fallback of /ask. Nothing in the /ask
 *    pipeline imports it; the ONLY caller is the explicit `POST /dsh/ask`
 *    route (http-ask.mjs) and the tests. p5-dsh-optin.test.mjs keeps the
 *    static assertion that /ask never spawns dsh.
 *  - D3: dsh reaches ERPNext ONLY through copilot_ask (the patch files
 *    register exactly that MCP tool) — never raw MCP, never direct REST.
 *  - D8: this runner is itself the explicit opt-in. The copilot child's dsh
 *    context is created by the patch's COPILOT_DSH_CONTEXT=1, and the child
 *    reads ONLY that variable (review F4 2026-09-19: an earlier draft also set
 *    a COPILOT_GATEWAY_DSH marker and claimed "both must be present", but
 *    nothing ever read the marker — the claim was false and the marker is gone).
 *    What makes it real defence in depth is that the gateway REFUSES TO SPAWN
 *    unless the patch file actually contains that flag
 *    (dshPatchMarksDshContext), so a patch that lost the flag cannot silently
 *    disable the child's write gate.
 *  - Topology (§2 of .plan/dsh_prompt_check.md): the runtime may be LOCAL
 *    (spawn here) or REMOTE (the Mac only reachable through a tunnel) — see
 *    DSH_MODE below. The gateway itself never claims which, and never says
 *    "remote verified" from a local run.
 *  - WRITE SAFETY (plan §10): a write-shaped question is refused HERE, at the
 *    gateway, BEFORE the dsh runtime costs anything — same NLP+routeIntent
 *    pipeline the copilot child will run anyway (one seam: normalizeText +
 *    routeIntent, exported from copilot-server.mjs/router.mjs). The in-child
 *    gate (dsh-optin.mjs via COPILOT_DSH_CONTEXT) stays as the second layer —
 *    the gateway can only make dsh MORE restricted, never less.
 *
 * Runtime model (plan §6/§17/§18): dsh is an EXTERNAL runtime, deliberately
 * NOT a repo dependency. The gateway spawns the pinned entry script per
 * request (headless profile, fresh DSH_HOME per the erpn-dsh-setup skill —
 * stale settings/patch state in DSH_HOME once produced a ghost-success),
 * streams nothing, parses the final JSON answer line, and tears the child
 * down. Every request is bounded by a hard timeout; concurrency is capped.
 */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { DSH_CONTEXT_ENV } from "./dsh-optin.mjs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { routeIntent } from "./router.mjs";
import { normalizeText } from "./copilot-server.mjs";
import { DSH_WRITE_BLOCKED_CODE } from "./dsh-optin.mjs";
import { logEvent, learningLogConfig } from "./learning-log.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..");
const DEFAULT_PATCH = path.join(HERE, "..", "dsh-e2e.patch.yml"); // MOCK target by default (safety, plan §15)
// Legacy sandbox location — LAST in the priority list and only when the file
// actually exists (`.plan/dsh_prompt_fix1.md`): it was one machine's setup, and
// treating it as the primary answer is what made "DSH khả dụng" untrue
// everywhere else. The default runtime is the PINNED npx package.
const DSH_ENTRY_FALLBACK = "/tmp/dsh-run/node_modules/@deepseek-ai/dsh/lib/bin.js";

/**
 * The dsh version PIN from the ROOT package.json, read at call time (deploy
 * can bump the pin without touching this file). null when undeclared — and a
 * null pin means the npx runtime is UNAVAILABLE, never "run whatever npx
 * finds": an unpinned agent would drift without any code change here.
 */
export function pinnedDshVersion() {
  try {
    const pkg = JSON.parse(readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"));
    const pin = pkg?.dependencies?.["@deepseek-ai/dsh"];
    return typeof pin === "string" && pin.trim() !== "" ? pin.trim() : null;
  } catch {
    return null;
  }
}

/**
 * The runtime the gateway would spawn, resolved ONCE and represented honestly
 * (`​.plan/dsh_prompt_fix1.md`): an agent can be a FILE this host runs through
 * node, or a COMMAND (npx) — collapsing `npx @deepseek-ai/dsh` into one
 * executable string is exactly the wrong shape, so the resolver keeps them
 * apart. Priority (first wins):
 *
 *   1. DSH_ENTRY                 — operator-pinned file (absolute path)
 *   2. DSH_COMMAND [+ DSH_ARGS]  — operator-pinned command
 *   3. local @deepseek-ai/dsh    — resolvable from this file upward
 *   4. npx --yes @deepseek-ai/dsh@<PIN> — the DEFAULT: the pin comes from the
 *      root package.json (never bare, never hardcoded here)
 *   5. legacy /tmp/dsh-run       — only when that file actually exists
 *   6. unavailable               — reported as unavailable, never guessed
 *
 * @returns {{mode: "entry"|"command"|"unavailable", source: string,
 *            entry: string|null, command: string|null, args: string[],
 *            version: string|null}}
 */
export function resolveDshRuntime(env = process.env) {
  const entryMode = (entry, source, version) => ({
    mode: "entry",
    source,
    entry,
    command: null,
    args: [],
    version: version ?? null,
  });
  const commandMode = (command, args, source, version) => ({
    mode: "command",
    source,
    entry: null,
    command,
    args,
    version: version ?? null,
  });

  // 1. DSH_ENTRY always wins, so an operator can always point at an explicit file.
  if (env.DSH_ENTRY) return entryMode(String(env.DSH_ENTRY), "DSH_ENTRY");

  // 2. DSH_COMMAND + DSH_ARGS — a command the operator controls. DSH_ARGS is a
  // JSON array (recommended — no splitting surprises) or, as a convenience,
  // whitespace-split; it is operator config, never user input, and it is never
  // passed through a shell.
  if (env.DSH_COMMAND) {
    return commandMode(String(env.DSH_COMMAND), parseDshCommandArgs(env.DSH_ARGS), "DSH_COMMAND");
  }

  // 3. The package ACTUALLY installed, the same way node itself would resolve it.
  try {
    const require_ = createRequire(import.meta.url);
    const pkgJson = require_.resolve("@deepseek-ai/dsh/package.json");
    const dir = path.dirname(pkgJson);
    const pkg = JSON.parse(readFileSync(pkgJson, "utf8"));
    const bin = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.dsh;
    if (bin) {
      return entryMode(path.resolve(dir, bin), "local-package", pkg.version ?? null);
    }
  } catch {
    /* not installed on this machine — fall through */
  }

  // 4. The pinned npx runtime — the DEFAULT when nothing is installed. Bare
  // `@deepseek-ai/dsh` is deliberately impossible here: no pin, no runtime.
  const pin = pinnedDshVersion();
  if (pin) {
    return commandMode("npx", ["--yes", `@deepseek-ai/dsh@${pin}`], "npx-pinned", pin);
  }

  // 5. Legacy sandbox — only when the file really is there (never reported as
  // the runtime when npx is available, per the fix prompt).
  if (existsSync(DSH_ENTRY_FALLBACK)) {
    return entryMode(DSH_ENTRY_FALLBACK, "legacy-tmp");
  }

  // 6. Truthful unavailable.
  return { mode: "unavailable", source: "unavailable", entry: null, command: null, args: [], version: null };
}

/** DSH_ARGS → argv array (JSON array first, whitespace-split as fallback). */
function parseDshCommandArgs(raw) {
  const s = String(raw ?? "").trim();
  if (s === "") return [];
  try {
    const parsed = JSON.parse(s);
    if (Array.isArray(parsed) && parsed.every((x) => typeof x === "string")) return parsed;
  } catch {
    /* not JSON — whitespace fallback below */
  }
  return s.split(/\s+/).filter(Boolean);
}

/**
 * Back-compat shim over resolveDshRuntime(): the FILE this host would run
 * through node, or null for command-based/unavailable runtimes. Callers want
 * the full shape — use resolveDshRuntime().
 */
export function resolveDshEntry(env = process.env) {
  return resolveDshRuntime(env).entry;
}

/**
 * PROOF, not guessing (`.plan/dsh_prompt_fix1.md` §4): run the resolved runtime
 * with `--version` and report what actually came back. This is how health and
 * `dsh:check` can say "usable" without a real question — the command itself
 * demonstrates it runs. Bounded (kill + failure) like every other spawn.
 *
 * @returns {Promise<{ran: boolean, version: string|null, detail: string}>}
 */
export async function verifyDshRuntime(env = process.env, opts = {}) {
  const rt = resolveDshRuntime(env);
  if (rt.mode === "unavailable") {
    return { ran: false, version: null, detail: "no dsh runtime: set DSH_ENTRY / DSH_COMMAND, or declare @deepseek-ai/dsh in package.json" };
  }
  const plan = dshSpawnPlan({ ...rt });
  const timeoutMs = envMs(env, "DSH_VERIFY_TIMEOUT_MS", 30_000);
  return await new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const child = spawn(plan.file, [...plan.args, "--version"], {
      cwd: REPO_ROOT,
      env: buildDshChildEnv(env),
      // npx resolves through PATH — the exact lookup PATH gives is wanted, so
      // NO shell: a POSIX shell would wrap the command and change what "runs".
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout.on("data", (d) => {
      stdout += d.toString();
    });
    child.stderr.on("data", (d) => {
      stderr += d.toString();
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ ran: false, version: null, detail: `spawn failed: ${err?.message ?? err}` });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const out = (stdout || "").split("\n").map((l) => l.trim()).filter(Boolean).pop() ?? null;
      if (timedOut) {
        resolve({ ran: false, version: null, detail: `--version timed out after ${timeoutMs}ms` });
      } else if (code !== 0) {
        resolve({ ran: false, version: null, detail: `--version exited ${code}: ${(stderr || stdout).trim().slice(0, 200)}` });
      } else {
        resolve({ ran: true, version: out, detail: `--version -> ${out}` });
      }
    });
  });
}

/**
 * What this machine can actually run, for ops/health (`.plan/dsh_prompt_check.md`
 * §3 + `.plan/dsh_prompt_fix1.md` §4): the resolved runtime shape, the patch, and
 * the version — for an entry runtime the version comes from the installed
 * package.json; for an npx runtime it IS the pin; otherwise null. Nothing here
 * is hardcoded, and nothing claims to run — PROOF is verifyDshRuntime().
 *
 * @returns {{mode: "entry"|"command"|"unavailable", source: string,
 *            entry: string|null, command: string|null, args: string[],
 *            runtime: string, version: string|null,
 *            entryExists: boolean, patch: string, patchExists: boolean,
 *            patchMarksDshContext: boolean}}
 */
export function dshRuntimeInfo(env = process.env) {
  const rt = resolveDshRuntime(env);
  const patch = String(env.DSH_PATCH ?? DEFAULT_PATCH);
  // "Exists" is a FILE question — it has an honest answer only for an entry
  // (or an explicit path command). A PATH command like `npx` is NOT knowable
  // from stat alone (existsSync("npx") would just stat the CWD), so it stays
  // null here; verifyDshRuntime() is the proof that a command runs.
  let entryExists = null;
  if (rt.mode === "entry") {
    entryExists = existsSync(rt.entry);
  } else if (rt.mode === "command" && rt.command.includes("/")) {
    entryExists = existsSync(rt.command);
  }
  return {
    mode: rt.mode,
    source: rt.source,
    entry: rt.entry,
    command: rt.command,
    args: rt.args,
    // "npx" | "entry" | "unavailable" — the coarse shape ops output prints.
    runtime: rt.mode === "command" ? "npx" : rt.mode,
    version: rt.version,
    entryExists,
    patch,
    patchExists: existsSync(patch),
    patchMarksDshContext: existsSync(patch) && dshPatchMarksDshContext(patch),
  };
}

/**
 * THE spawn plan — one implementation for local gateway, remote runner and the
 * runtime check, so no caller can drift into `spawn("npx arg arg", ...)` as a
 * single executable string (that shape never launches). An entry runtime runs
 * through `process.execPath` (node); a command runtime runs the command with
 * its argv. Never a shell string.
 *
 * @returns {{file: string, args: string[]}}
 */
export function dshSpawnPlan(rt) {
  if (rt.mode === "command") {
    return { file: rt.command, args: [...rt.args] };
  }
  return { file: process.execPath, args: [rt.entry] };
}

/** The gateway refused the question ITSELF (never reached the dsh runtime). */
export const DSH_GATEWAY_REFUSED = "gateway_refused";
/** The dsh child produced no parsable answer (or timed out / was killed). */
export const DSH_GATEWAY_FAILED = "gateway_failed";

/** Secrets NEVER passed into the dsh child, even indirectly (plan §13/§16). */
export const DSH_SECRET_ENV_KEYS = Object.freeze([
  "ASK_PASSWORD", // gateway HTTP basic auth (the child never answers HTTP)
  "GH_TOKEN",
  "GEMINI_API_KEY", // router reads keys from ITS OWN process env (llm-router.mjs), not from dsh
  "MAC_LLM_API_KEY",
  "ZEN_API_KEY",
]);

/** Env-number law (451cd8f / result47 §6): finite AND positive or the default. */
function envMs(env, key, fallbackMs) {
  const raw = Number(env?.[key]);
  return Number.isFinite(raw) && raw > 0 ? raw : fallbackMs;
}

function envInt(env, key, fallbackInt) {
  const raw = Number(env?.[key]);
  return Number.isFinite(raw) && Number.isInteger(raw) && raw > 0 ? raw : fallbackInt;
}

/**
 * The remote runner's bearer token, read at CALL time from the env var NAMED in
 * the config (never stored on the config object, which is passed around and
 * could be logged). Empty ⇒ the remote path refuses (see runRemoteDsh).
 */
function remoteToken(env, cfg) {
  const raw = env?.[cfg.remoteTokenEnv];
  return typeof raw === "string" ? raw.trim() : "";
}

/**
 * Redact the runner token out of egress diagnostics. We HOLD the literal value
 * at this point, so removing it exactly is strictly better than hoping a pattern
 * catches an unknown format — a fetch error can quote the URL it tried, and that
 * URL may carry the credential (`?token=…`). Found by review: the generic
 * scrubber only knew `key=value` / `Authorization` / `sk-` shapes.
 */
function redactToken(text, token) {
  const s = String(text ?? "");
  if (!token) return s;
  return s.split(token).join("<redacted>");
}

/**
 * Conversation ids become Map keys and (in the file-backed store) part of a
 * FILENAME, so they are a trust boundary: the id arrives in the HTTP body
 * (review F3). Anything that is not a short opaque token is ignored — never
 * joined into a path, never used as a key. Mirrors `isValidCommandId` in
 * http-ask.mjs: same shape, same "client-generated id" contract.
 */
export function isValidConversationId(value) {
  return typeof value === "string" && /^[A-Za-z0-9_.:-]{1,64}$/.test(value.trim());
}

/**
 * Gateway configuration from env, with built-in defaults (fail-safe: a broken
 * value falls back, it never disables a bound — same class of law as
 * rate-limit.mjs and proposal-freshness.mjs).
 *
 * DSH_MODE selects WHERE the runtime lives (`.plan/dsh_prompt_check.md` §2):
 * `local` (default — spawn the pinned entry in this process's machine) or
 * `remote` (POST to a runner on the Mac through its tunnel). The two are never
 * mixed and never silently upgraded: a local run can never be reported as a
 * remote/Mac verification.
 */
export function dshGatewayConfig(env = process.env) {
  const rt = resolveDshRuntime(env);
  return {
    // The FULL runtime shape (mode/source/entry/command/args) — the spawn site
    // needs more than a file path, and collapsing it back to a string is what
    // broke runtime discovery in the first place.
    runtime: rt,
    dshEntry: rt.entry,
    patch: String(env.DSH_PATCH ?? DEFAULT_PATCH),
    // WHERE the runtime lives (see the header): 'local' spawns here, 'remote'
    // calls the Mac runner. Anything that is not exactly 'remote' means local,
    // so a typo can never leave the mode undefined.
    mode: String(env.DSH_MODE ?? "local").trim().toLowerCase() === "remote" ? "remote" : "local",
    remoteUrl: String(env.DSH_REMOTE_URL ?? "").trim().replace(/\/+$/, ""),
    remoteTokenEnv: String(env.DSH_REMOTE_TOKEN_ENV ?? "DSH_REMOTE_TOKEN").trim() || "DSH_REMOTE_TOKEN",
    timeoutMs: envMs(env, "DSH_TIMEOUT_MS", 180_000), // dsh multi-turn needs more than /ask's 120s
    maxConcurrent: envInt(env, "DSH_MAX_CONCURRENT", 1),
    maxTextLength: envInt(env, "DSH_MAX_TEXT", 2000), // one utterance; 1MB /ask cap does not fit an agent
    sessionTtlMs: envMs(env, "DSH_SESSION_TTL_MS", 30 * 60_000),
    maxSessions: envInt(env, "DSH_MAX_SESSIONS", 200), // bounded store (review F2)
    dshHomeBase: String(env.DSH_HOME_BASE ?? path.join(tmpdir(), "dsh-gw-home")),
    // MOCK is the default target: the e2e patch resolves ERPNEXT_* to '' unless
    // E2E_TARGET=real (verbatim from dsh-e2e.patch.yml) — real data is opt-in.
    cwd: String(env.DSH_CWD ?? REPO_ROOT),
  };
}

/**
 * Env for the dsh child: the parent's env MINUS the secret keys. Never mutates
 * the parent env, and adds nothing — the dsh context comes from the patch file,
 * which the caller verifies before spawning (dshPatchMarksDshContext).
 */
export function buildDshChildEnv(env = process.env) {
  const child = { ...env };
  for (const key of DSH_SECRET_ENV_KEYS) delete child[key];
  return child;
}

// ─────────────────────────────────────────────────────────────────────────────
// WRITE PRE-SCREEN (plan §10) — same seam the copilot child will run.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Classify the question through the REAL pipeline (NLP normalize + routeIntent)
 * and refuse a WRITE BEFORE spawning dsh. The child's own gate (dsh-optin.mjs)
 * remains as layer 2 — this is layer 1, at the money boundary of the gateway.
 *
 * NLP down is NOT a guess-and-continue: the gateway fails closed with
 * DSH_GATEWAY_NLP_UNAVAILABLE (amount-dependent routing cannot be trusted).
 *
 * @returns {Promise<{ok: true, normalizedText: string} |
 *                   {ok: false, code: string, reason: string, matched?: string}>}
 */
export async function dshQuestionGate(rawText, { env = process.env } = {}) {
  let normalized;
  try {
    normalized = await normalizeText(rawText);
  } catch (err) {
    return {
      ok: false,
      code: "DSH_GATEWAY_NLP_UNAVAILABLE",
      reason: `dịch vụ chuẩn hoá tiếng Việt (:8787) không trả lời (${err?.message ?? err}) — không thể đánh giá an toàn câu hỏi, DSH từ chối.`,
    };
  }
  const route = routeIntent(normalized.text);
  if (route && !route.forbidden && route.group === "payment_write") {
    return {
      ok: false,
      code: DSH_WRITE_BLOCKED_CODE,
      reason:
        "chế độ Phân tích bằng AI chỉ ĐỌC — ghi phiếu thu phải qua mục chat chính và cần bạn bấm Xác nhận",
      matched: route.matched,
    };
  }
  return { ok: true, normalizedText: normalized.text };
}

// ─────────────────────────────────────────────────────────────────────────────
// CONVERSATION SESSIONS (plan §6) — bounded, honest, TTL'd.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * conversation_id → DSH context. dsh headless is one-shot, so "session" here
 * is deliberately an HONEST carry-over of the question thread, not a fake
 * claim that the harness keeps state: each call sends the prior questions
 * (bounded) as preceding user turns inside the prompt so the agent answers
 * "còn bao nhiêu TIẾP?" in context. The store enforces the plan's bounds:
 * max turns kept, TTL expiry.
 */
const DSH_SESSION_MEMORY = new Map(); // module-level: static private fields are not syntax in Node 24

/**
 * Memory hygiene (review F2): the store used to grow FOREVER. Every request
 * without a `conversation_id` gets a fresh random one, so each such request
 * added a permanent entry holding up to 6 question/answer texts — an unbounded
 * leak in a long-running gateway, on top of which the TTL was only checked on
 * READ (an expired entry stayed in memory until someone asked for it again).
 * Pruning now happens where entries are CREATED, and the store is capped.
 */
const DSH_SESSION_LIMIT = 200;

export class DshSessionStore {
  /** memory-backed (tests, default) */
  static memory() {
    return new DshSessionStore(null);
  }

  /** file-backed (survives gateway restarts within the TTL) */
  static file(dir, { clock = Date.now } = {}) {
    return new DshSessionStore(dir, { clock });
  }

  constructor(dir, { clock = Date.now } = {}) {
    this.dir = dir;
    this.clock = clock;
    if (dir) mkdirSync(dir, { recursive: true });
  }

  /** Only ever called with an id that already passed [isValidConversationId]. */
  #fileFor(conversationId) {
    return path.join(this.dir, `dsh-session-${conversationId}.json`);
  }

  /**
   * Drops expired entries (memory mode) so the Map cannot outlive its TTL, then
   * enforces the cap by evicting the least-recently-updated sessions.
   */
  #prune(now) {
    for (const [id, rec] of DSH_SESSION_MEMORY) {
      if (now - (rec?.updated_at ?? 0) > (rec?.ttlMs ?? 30 * 60_000)) {
        DSH_SESSION_MEMORY.delete(id);
      }
    }
    while (DSH_SESSION_MEMORY.size >= DSH_SESSION_LIMIT) {
      let oldestId = null;
      let oldestAt = Infinity;
      for (const [id, rec] of DSH_SESSION_MEMORY) {
        const at = rec?.updated_at ?? 0;
        if (at < oldestAt) {
          oldestAt = at;
          oldestId = id;
        }
      }
      if (oldestId === null) break;
      DSH_SESSION_MEMORY.delete(oldestId);
    }
  }

  /** Test seam: how many sessions the memory store is holding (file mode: 0). */
  size() {
    return this.dir ? 0 : DSH_SESSION_MEMORY.size;
  }

  /** Returns prior turns (oldest→newest) and TOUCHES the session. TTL-expired ⇒ []. */
  get(conversationId, { maxTurns = 6 } = {}) {
    // A malformed id is not a session key and must never reach the filesystem
    // (review F3: `../../x` would have been joined onto the store directory).
    if (!isValidConversationId(conversationId)) return [];
    const now = this.clock();
    let rec = null;
    if (this.dir) {
      try {
        rec = JSON.parse(readFileSync(this.#fileFor(conversationId), "utf8"));
      } catch {
        rec = null;
      }
    } else {
      rec = DSH_SESSION_MEMORY.get(conversationId) ?? null;
    }
    if (!rec || !Array.isArray(rec.turns)) return [];
    if (now - (rec.updated_at ?? 0) > (rec.ttlMs ?? 30 * 60_000)) return []; // expired ⇒ start fresh
    return rec.turns.slice(-maxTurns);
  }

  touch(conversationId, { question, answer, ttlMs = 30 * 60_000, maxTurns = 6 } = {}) {
    // Same guard as get(): an invalid id is ignored, the request still answers.
    if (!isValidConversationId(conversationId)) return [];
    const now = this.clock();
    const prior = this.get(conversationId, { maxTurns });
    const turns = [...prior, { question, answer, at: now }].slice(-maxTurns);
    const rec = { turns, updated_at: now, ttlMs };
    if (this.dir) {
      writeFileSync(this.#fileFor(conversationId), JSON.stringify(rec), "utf8");
    } else {
      this.#prune(now);
      DSH_SESSION_MEMORY.set(conversationId, rec);
    }
    return turns;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// CONCURRENCY (plan §20)
// ─────────────────────────────────────────────────────────────────────────────

let inFlight = 0;
export function dshInFlight() {
  return inFlight;
}
/** Semantic error code the route maps to 429 (never a naked busy message). */
export const DSH_IN_FLIGHT = "DSH_GATEWAY_IN_FLIGHT";
export const DSH_BUSY_MESSAGE =
  "Đang có một phiên DSH chạy — chờ phiên hiện tại xong rồi thử lại.";
/** One copy for both runtimes: a local and a remote timeout must read alike. */
export const DSH_TIMEOUT_MESSAGE = "Phiên DSH quá thời gian cho phép và đã bị dừng.";

// ─────────────────────────────────────────────────────────────────────────────
// OUTPUT PARSING (headless transcript format — erpn-dsh-setup SKILL.md §2)
// ─────────────────────────────────────────────────────────────────────────────

const WEB_PREFIXES = [
  "All commands must be run on the user machine.",
  "The local server is running on the user's machine.",
];

/** ANSI colours would corrupt the answer text if a terminal profile emits them. */
const ANSI_RE = /\u001B\[[0-9;]*[A-Za-z]/g;

/** Strip the `dsh web` banner the CLI prepends to headless transcripts. */
export function stripDshBanner(raw) {
  const lines = String(raw).replace(ANSI_RE, "").split("\n");
  while (lines.length > 0 && WEB_PREFIXES.some((p) => lines[0].startsWith(p))) lines.shift();
  return lines.join("\n").trim();
}

/**
 * The FINAL answer from a headless transcript.
 *
 * VERIFIED SHAPE (probe 2026-09-19, real dsh 0.1.5-rc.1 + mock LLM): stdout is
 * ONE plain-prose line — the assistant's final message — and exit code 0:
 *   `Trả lời từ ERPNext (mock LLM chỉ đọc lại kết quả, không tự tính): …`
 * It is NOT JSON. An earlier draft of this parser demanded a JSON line and
 * therefore reported DSH_BAD_OUTPUT for a perfectly good answer — hence the
 * two-shape contract below.
 *
 * Shape A (preferred): a line that parses as a JSON object (structured
 *   output / future `--output-format`).
 *
 * Shape B: the printed final answer — the WHOLE stripped transcript, NOT its
 * last line (review F1). Evidence: dsh's own README documents the profile as
 * "Run one fresh persisted session, **print the final answer**, and exit" — so
 * whatever is printed IS the answer, and a multi-paragraph answer prints
 * verbatim. Keeping only the last line would silently discard the earlier ones
 * (a list of invoice amounts whose last line is a total — or nothing). Trading a
 * possible extra line for never losing money numbers is the right way round.
 *
 * @returns {object|null} `{content}` — `answer` stays an OBJECT so callers keep
 *   one shape for both A and B (an existing {content}/{text} is passed through).
 */
export function parseDshFinalAnswer(stdout) {
  const text = stripDshBanner(stdout);
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line.startsWith("{")) continue;
    try {
      const obj = JSON.parse(line);
      if (obj && typeof obj === "object") {
        if (typeof obj.content === "string" || typeof obj.text === "string") return obj;
        return { content: JSON.stringify(obj) };
      }
    } catch {
      /* not JSON — keep scanning */
    }
  }
  // Shape B: plain prose — the printed final answer, in full (see the doc above).
  return text.length > 0 ? { content: text } : null;
}

/**
 * The ERPNext target the copilot child reported on stderr (`[copilot] ERPNext
 * target: REAL|mock -> host`). Audit evidence for plan §23/§24: proves whether a
 * session could ever write to real data — WITHOUT the host or any key.
 * @returns {"REAL"|"mock"|null}
 */
export function parseDshTarget(stderr) {
  const m = /ERPNext target:\s*(REAL|mock)/i.exec(String(stderr ?? ""));
  if (!m) return null;
  return m[1].toLowerCase() === "real" ? "REAL" : "mock";
}

/**
 * Defensive scrub of a child's stderr BEFORE it is stored/returned: an auth
 * header or a `key=value` line must never reach a log (plan §16).
 */
export function scrubDiagnostics(text) {
  return String(text ?? "")
    // Redact the WHOLE remainder of any line naming a credential: a first-token
    // rule left `Authorization: Bearer abc123` → `Authorization=<redacted> abc123`
    // (the secret survived). Caught by the scrub test, fixed here.
    .replace(/^.*?(authorization|api[-_]?key|secret|password|token)\s*[:=].*$/gim, "$1=<redacted>")
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, "sk-<redacted>");
}

/** Last non-JSON prose line — the error tail for a failed run (bounded). */
export function parseDshErrorTail(stdout) {
  const text = stripDshBanner(stdout);
  const lines = text.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (line.startsWith("{") || line.startsWith("[")) continue;
    return scrubDiagnostics(line).slice(0, 300);
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// THE RUNNER — one dsh session per question. THE only dsh spawn in the repo.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Run ONE dsh headless session for `question` and return the final answer.
 * Fresh DSH_HOME per call (skill law: stale settings produce ghost state),
 * hard kill at timeoutMs, bounded concurrency, no secret in the child env.
 *
 * @returns {Promise<{ok: true, answer: object, raw: string, conversationId: string,
 *                    sessionId: string, elapsedMs: number} |
 *                   {ok: false, code: string, reason: string, conversationId: string,
 *                    sessionId: string|null, logTail: string|null, elapsedMs: number}>}
 */
export async function runDshAsk(question, opts = {}) {
  const cfg = { ...dshGatewayConfig(opts.env ?? process.env), ...(opts.overrides ?? {}) };
  // Overrides may pin a specific entry (tests inject a recording fake; an
  // operator trick is not possible here — overrides never come from the wire).
  // The runtime shape must FOLLOW the override, or the spawn would use the
  // resolver's npx command while the guards check the override file.
  if (cfg.dshEntry && cfg.runtime?.entry !== cfg.dshEntry) {
    cfg.runtime = { mode: "entry", source: "override", entry: cfg.dshEntry, command: null, args: [], version: null };
  }
  const conversationId = opts.conversationId ?? randomUUID();
  const sessionId = randomUUID();
  const startedAt = Date.now();

  // metering is ALWAYS on (dshInFlight() must be truthful); only the CAP can be
  // turned off — opts.maxConcurrent === 0 means "no cap" (tests drive their own
  // scenarios), never "uncounted". A 0 that disabled counting would let
  // unbounded concurrent sessions through unnoticed.
  if (opts.maxConcurrent === 0) {
    return runDshAskInner(question, cfg, conversationId, sessionId, startedAt, opts);
  }
  if (inFlight >= cfg.maxConcurrent) {
    return {
      ok: false,
      code: DSH_IN_FLIGHT,
      reason: DSH_BUSY_MESSAGE,
      conversationId,
      sessionId: null,
      logTail: null,
      elapsedMs: 0,
    };
  }
  inFlight += 1;
  try {
    return await runDshAskInner(question, cfg, conversationId, sessionId, startedAt, opts);
  } finally {
    inFlight -= 1;
  }
}

/**
 * Run ONE session on the REMOTE runtime (the Mac) through its runner —
 * `.plan/dsh_prompt_check.md` §2. The runner lives on the machine that owns the
 * dsh install and must satisfy this contract (scripts/dsh-remote-runner.mjs):
 *
 *   POST {remoteUrl}/run   Authorization: Bearer <token>
 *   body {prompt, timeoutMs} → 200 {ok:true, stdout, stderr} | {ok:false, error}
 *   GET  {remoteUrl}/health → 200 {ok:true, runtime, entry, version}
 *
 * The response body is fed through the SAME parsers as a local run, so both
 * modes produce identical answers — there is no second output format drifting
 * out of sync, and no format the test suite cannot exercise.
 *
 * FAIL CLOSED: missing config, a bad token, a dead tunnel or a timeout all
 * return a refusal. Nothing here falls back to the local spawn.
 */
async function runRemoteDsh(prompt, cfg, conversationId, sessionId, startedAt, opts) {
  const env = opts.env ?? process.env;
  const elapsed = () => Date.now() - startedAt;
  const token = remoteToken(env, cfg);

  if (!cfg.remoteUrl || !token) {
    return {
      ok: false,
      code: "DSH_UNAVAILABLE",
      reason:
        "DSH Agent từ xa chưa được cấu hình đầy đủ (thiếu DSH_REMOTE_URL hoặc token) — không chạy cục bộ thay thế. Vui lòng kiểm tra lại cấu hình.",
      conversationId,
      sessionId: null,
      logTail: `remote mode requires DSH_REMOTE_URL and env ${cfg.remoteTokenEnv}`,
      elapsedMs: elapsed(),
      runtime: "remote",
    };
  }

  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  try {
    const res = await fetchImpl(`${cfg.remoteUrl}/run`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ prompt, timeoutMs: cfg.timeoutMs }),
      signal: AbortSignal.timeout(cfg.timeoutMs),
    });

    if (res.status === 401 || res.status === 403) {
      return {
        ok: false,
        code: "DSH_REMOTE_UNAUTHORIZED",
        reason: "Máy DSH từ xa từ chối xác thực (token sai hoặc đã hết hạn). Vui lòng kiểm tra lại token cấu hình.",
        conversationId,
        sessionId: null,
        logTail: `remote runner returned HTTP ${res.status}`,
        elapsedMs: elapsed(),
        runtime: "remote",
      };
    }

    const body = await res.json().catch(() => null);
    if (!res.ok || body?.ok !== true) {
      return {
        ok: false,
        code: "DSH_REMOTE_ERROR",
        reason: `Máy DSH từ xa trả lỗi (HTTP ${res.status}). Vui lòng thử lại sau.`,
        conversationId,
        sessionId: null,
        logTail: scrubDiagnostics(redactToken(String(body?.error ?? `HTTP ${res.status}`), token)).slice(0, 300),
        elapsedMs: elapsed(),
        runtime: "remote",
      };
    }

    const stdout = String(body.stdout ?? "");
    const stderr = String(body.stderr ?? "");
    const answer = parseDshFinalAnswer(stdout);
    if (!answer) {
      return {
        ok: false,
        code: "DSH_BAD_OUTPUT",
        reason: "DSH Agent không trả về câu trả lời đọc được. Vui lòng thử lại.",
        conversationId,
        sessionId: null,
        target: parseDshTarget(String(stderr)),
        logTail: parseDshErrorTail(stdout) ?? "empty stdout from remote runner",
        elapsedMs: elapsed(),
        runtime: "remote",
      };
    }

    return {
      ok: true,
      answer,
      raw: stripDshBanner(stdout),
      target: parseDshTarget(stderr),
      conversationId,
      sessionId,
      elapsedMs: elapsed(),
      runtime: "remote",
    };
  } catch (err) {
    const timedOut = err?.name === "TimeoutError" || err?.name === "AbortError";
    return {
      ok: false,
      code: timedOut ? "DSH_TIMEOUT" : "DSH_REMOTE_ERROR",
      reason: timedOut
        ? DSH_TIMEOUT_MESSAGE
        : "Không kết nối được tới máy DSH từ xa. Vui lòng kiểm tra tunnel rồi thử lại.",
      conversationId,
      sessionId: null,
      logTail: scrubDiagnostics(redactToken(String(err?.message ?? err), token)).slice(0, 300),
      elapsedMs: elapsed(),
      runtime: "remote",
    };
  }
}

/**
 * Truthful capability probe for ops/health endpoints — NEVER guesses. In local
 * mode it checks the two files it would actually need; in remote mode it asks
 * the runner. A remote probe that cannot reach the Mac reports unavailable
 * rather than claiming readiness, so /dsh/health can never be green on a Mac
 * topology that is not actually wired up.
 *
 * @returns {Promise<{available: boolean, mode: string, detail: string, target?: string|null}>}
 */
export async function dshGatewayHealth(opts = {}) {
  const env = opts.env ?? process.env;
  const cfg = dshGatewayConfig(env);

  if (cfg.mode === "local") {
    const info = dshRuntimeInfo(env);
    if (info.mode === "unavailable") {
      return { available: false, mode: "local", version: null, detail: "no dsh runtime resolved (DSH_ENTRY / DSH_COMMAND / pinned package)" };
    }
    if (info.mode === "entry" && !info.entryExists) {
      return { available: false, mode: "local", version: info.version, detail: `missing dsh entry: ${info.entry}` };
    }
    if (!info.patchExists) {
      return { available: false, mode: "local", version: info.version, detail: `missing patch: ${info.patch}` };
    }
    if (!info.patchMarksDshContext) {
      return {
        available: false,
        mode: "local",
        version: info.version,
        detail: `patch is missing ${DSH_CONTEXT_ENV}=1 (write gate would not fire)`,
      };
    }
    // PROOF over inference: a command runtime has no file to stat, so the only
    // honest "available" is running `--version` through the exact spawn plan a
    // question would take. (Bounded; failure ⇒ unavailable, never a shrug.)
    const verified = await verifyDshRuntime(env, opts);
    if (!verified.ran) {
      return { available: false, mode: "local", version: info.version, detail: `runtime does not run: ${verified.detail}` };
    }
    return {
      available: true,
      mode: "local",
      runtime: info.runtime,
      source: info.source,
      version: verified.version ?? info.version,
      detail: `runtime=${info.runtime}(${info.source}) patch=${path.basename(info.patch)} ${verified.detail}`,
    };
  }

  const token = remoteToken(env, cfg);
  if (!cfg.remoteUrl || !token) {
    return { available: false, mode: "remote", detail: `remote mode requires DSH_REMOTE_URL and env ${cfg.remoteTokenEnv}` };
  }
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  try {
    const res = await fetchImpl(`${cfg.remoteUrl}/health`, {
      method: "GET",
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(opts.healthTimeoutMs ?? 5000),
    });
    const body = await res.json().catch(() => null);
    if (!res.ok || body?.ok !== true) {
      return { available: false, mode: "remote", detail: `remote runner unhealthy (HTTP ${res.status})` };
    }
    return {
      available: true,
      mode: "remote",
      version: body.version ?? null,
      detail: `runner=${cfg.remoteUrl} entry=${body.entry ?? "?"} version=${body.version ?? "?"}`,
    };
  } catch (err) {
    return {
      available: false,
      mode: "remote",
      detail: scrubDiagnostics(String(err?.message ?? err)).slice(0, 200),
    };
  }
}

async function runDshAskInner(question, cfg, conversationId, sessionId, startedAt, opts) {
  const store = opts.store ?? DshSessionStore.memory();
  const priorTurns = store.get(conversationId);
  const prompt =
    priorTurns.length > 0
      ? `${priorTurns.map((t) => `Câu hỏi trước: ${t.question}\nTrả lời trước: ${t.answer}`).join("\n")}\n\nCâu hỏi hiện tại: ${question}`
      : question;

  // REMOTE first (`.plan/dsh_prompt_check.md` §2). When the operator configured
  // the Mac runtime, a failure THERE is a failure: the local spawn below must
  // never run in its place. No silent downgrade — and therefore no chance of
  // reporting a local session as a "Mac topology" verification.
  if (cfg.mode === "remote") {
    return runRemoteDsh(prompt, cfg, conversationId, sessionId, startedAt, opts);
  }

  // Missing-runtime and missing-patch are different failures with different
  // fixes — and a command runtime (npx) has NO file to stat up front, so only
  // an entry runtime can be refused for entry existence.
  if (cfg.runtime.mode === "entry" && !existsSync(cfg.runtime.entry)) {
    return {
      ok: false,
      code: "DSH_UNAVAILABLE",
      reason:
        "DSH Agent hiện không khả dụng (runtime chưa cài). Vui lòng thử lại sau.",
      conversationId,
      sessionId: null,
      logTail: `missing dsh entry: ${cfg.runtime.entry}`,
      elapsedMs: Date.now() - startedAt,
    };
  }
  if (cfg.runtime.mode === "unavailable") {
    return {
      ok: false,
      code: "DSH_UNAVAILABLE",
      reason:
        "DSH Agent hiện không khả dụng (chưa cấu hình runtime). Vui lòng thử lại sau.",
      conversationId,
      sessionId: null,
      logTail: "no dsh runtime resolved (DSH_ENTRY / DSH_COMMAND / pinned package)",
      elapsedMs: Date.now() - startedAt,
    };
  }
  if (!existsSync(cfg.patch)) {
    return {
      ok: false,
      code: "DSH_UNAVAILABLE",
      reason: "DSH Agent hiện không khả dụng (patch cấu hình thiếu). Vui lòng thử lại sau.",
      conversationId,
      sessionId: null,
      logTail: `missing patch: ${cfg.patch}`,
      elapsedMs: Date.now() - startedAt,
    };
  }
  if (!dshPatchMarksDshContext(cfg.patch)) {
    return {
      ok: false,
      code: "DSH_PATCH_UNSAFE",
      reason:
        "Cấu hình DSH thiếu cờ ngữ cảnh chỉ-ĐỌC — từ chối chạy để không vô hiệu hoá cổng chặn ghi.",
      conversationId,
      sessionId: null,
      logTail: `patch ${path.basename(cfg.patch)} is missing ${DSH_CONTEXT_ENV}=1`,
      elapsedMs: Date.now() - startedAt,
    };
  }

  // Fresh, empty DSH_HOME EVERY call (erpn-dsh-setup SKILL.md: stale DSH_HOME
  // settings once made the mock "succeed" from a leftover route). Removing the
  // tempdir in `finally` guarantees no dsh settings survive the call.
  const scratch = mkdtempSync(path.join(tmpdir(), "dsh-ask-"));
  const dshHome = path.join(scratch, "home");
  mkdirSync(dshHome, { recursive: true });

  const childEnv = buildDshChildEnv(opts.env ?? process.env);
  childEnv.DSH_HOME = dshHome;
  childEnv.DSH_TELEMETRY_MODE = "DISABLED";

  let stdout = "";
  let stderr = "";
  try {
    const result = await new Promise((resolve) => {
      // ONE spawn shape for every runtime (dshSpawnPlan): node <entry> … or
      // npx --yes @deepseek-ai/dsh@<pin> … — never a shell string.
      const plan = dshSpawnPlan(cfg.runtime);
      const child = spawn(plan.file, [...plan.args, "--profile", "headless", "--patch", cfg.patch, prompt], {
        cwd: cfg.cwd,
        env: childEnv,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, cfg.timeoutMs);
      child.stdout.on("data", (d) => {
        stdout += d.toString();
        if (stdout.length > 400_000) stdout = stdout.slice(-200_000); // bounded
      });
      child.stderr.on("data", (d) => {
        stderr += d.toString();
        if (stderr.length > 100_000) stderr = stderr.slice(-50_000);
      });
      child.on("error", (err) => {
        clearTimeout(timer);
        resolve({ ok: false, kind: "spawn", detail: String(err?.message ?? err) });
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({ ok: !timedOut && code === 0, timedOut, code });
      });
    });

    const elapsedMs = Date.now() - startedAt;
    if (!result.ok) {
      const code = result.timedOut ? "DSH_TIMEOUT" : "DSH_SESSION_FAILED";
      const reason = result.timedOut
        ? DSH_TIMEOUT_MESSAGE
        : "DSH Agent không trả lời được (lỗi phiên). Vui lòng thử lại sau.";
      return {
        ok: false,
        code,
        reason,
        conversationId,
        sessionId,
        target: parseDshTarget(stderr),
        logTail: scrubDiagnostics(
          parseDshErrorTail(stdout) ?? stderr.split("\n").filter(Boolean).pop() ?? `exit=${result.code} ${result.detail ?? ""}`,
        ).slice(0, 300),
        elapsedMs,
      };
    }

    const answer = parseDshFinalAnswer(stdout);
    const target = parseDshTarget(stderr); // audit evidence: REAL vs mock (§23/§24)
    if (!answer) {
      return {
        ok: false,
        code: "DSH_BAD_OUTPUT",
        reason: "DSH Agent trả về kết quả không đọc được.",
        conversationId,
        sessionId,
        target,
        logTail: (parseDshErrorTail(stdout) ?? scrubDiagnostics(stderr).split("\n").filter(Boolean).pop() ?? "(no prose)").slice(0, 300),
        elapsedMs,
      };
    }
    return { ok: true, answer, raw: stripDshBanner(stdout), target, conversationId, sessionId, elapsedMs };
  } finally {
    try {
      rmSync(scratch, { recursive: true, force: true });
    } catch {
      /* scratch cleanup is best-effort; it never touches user data */
    }
  }
}

/**
 * FAIL-CLOSED patch check (found 2026-09-19 by running the REAL chain):
 * dsh-e2e.patch.yml did not set COPILOT_DSH_CONTEXT, so the copilot child was
 * NOT in dsh context and the in-child WRITE gate never fired — a write question
 * travelled into the skill layer and was stopped only by an ambiguous-customer
 * error. A patch without the marker must never be spawned: refusing is cheap,
 * silently running without the write gate is not.
 *
 * @returns {boolean} true when the patch file marks the child as dsh context
 */
export function dshPatchMarksDshContext(patchPath) {
  let text;
  try {
    text = readFileSync(patchPath, "utf8");
  } catch {
    return false;
  }
  return new RegExp(`${DSH_CONTEXT_ENV}\\s*:\\s*['"]?1['"]?`).test(text);
}

/**
 * Full gateway turn: pre-screen → run → session update → ONE audit line.
 * Never throws (every failure is a structured result) — the route maps them
 * to HTTP; it must not need its own try/except for runner bugs.
 */
export async function dshGatewayAsk(question, opts = {}) {
  const env = opts.env ?? process.env;
  const cfg = dshGatewayConfig(env);
  const conversationId = opts.conversationId ?? randomUUID();
  const requestId = opts.requestId ?? randomUUID();
  const startedAt = Date.now();

  const text = String(question ?? "").trim();
  if (text.length === 0) {
    return { ok: false, httpStatus: 400, code: "DSH_GATEWAY_BAD_REQUEST", reason: "missing required field: message", conversationId, requestId };
  }
  if (text.length > cfg.maxTextLength) {
    return { ok: false, httpStatus: 400, code: "DSH_GATEWAY_BAD_REQUEST", reason: `câu hỏi vượt quá giới hạn ${cfg.maxTextLength} ký tự`, conversationId, requestId };
  }

  const gate = await dshQuestionGate(text, { env });
  // The log config must follow the CALLER's env (LEARNING_LOG_DIR is a deploy-
  // level setting and tests point it at a scratch file) — logEvent's default
  // would otherwise write to the repo-root store regardless of `env`.
  const logConfig = learningLogConfig(env);
  if (!gate.ok) {
    logEvent({
      phase: "dsh_ask",
      outcome: DSH_GATEWAY_REFUSED,
      error_code: gate.code,
      request_id: requestId,
      mode: "dsh",
      text: text.slice(0, 200),
      latency_ms: Date.now() - startedAt,
    }, { config: logConfig });
    return { ok: false, httpStatus: 200, code: gate.code, reason: gate.reason, conversationId, requestId, mode: "dsh" };
  }

  const outcome = await runDshAsk(text, {
    env,
    conversationId,
    overrides: opts.overrides,
    store: opts.store,
    maxConcurrent: opts.maxConcurrent,
  });

  if (!outcome.ok) {
  logEvent({
    phase: "dsh_ask",
    outcome: DSH_GATEWAY_FAILED,
    error_code: outcome.code,
    request_id: requestId,
    mode: "dsh",
    runtime: outcome.runtime ?? cfg.mode,
    dsh_session_id: outcome.sessionId,
      text: text.slice(0, 200),
      latency_ms: outcome.elapsedMs,
    }, { config: logConfig });
    return {
      ok: false,
      httpStatus: outcome.code === DSH_IN_FLIGHT ? 429 : 502,
      code: outcome.code,
      reason: outcome.reason,
      conversationId,
      requestId,
      mode: "dsh",
      runtime: outcome.runtime ?? cfg.mode,
      dsh_session_id: outcome.sessionId,
      // WHY it failed, not just that it did. The failure branch knew the reason
      // (child's last stderr / parse error) and used to keep it server-side: the
      // first real npx session failed in 5.6s and the only way to learn why was
      // the router audit (a 408 from the Mac tunnel) — the client, and anyone
      // reading the response, saw "lỗi phiên". Already scrubbed by
      // scrubDiagnostics (no keys, no host, no token).
      erpnext_target: outcome.target ?? null,
      logTail: outcome.logTail ?? null,
    };
  }

  const answerText =
    typeof outcome.answer?.content === "string"
      ? outcome.answer.content
      : typeof outcome.answer?.text === "string"
        ? outcome.answer.text
        : null;
  const store = opts.store ?? DshSessionStore.memory();
  store.touch(conversationId, { question: text, answer: answerText ?? "", ttlMs: cfg.sessionTtlMs });

  logEvent({
    phase: "dsh_ask",
    outcome: "answered",
    request_id: requestId,
    mode: "dsh",
    runtime: outcome.runtime ?? cfg.mode,
    dsh_session_id: outcome.sessionId,
    erpnext_target: outcome.target ?? null,
    text: text.slice(0, 200),
    latency_ms: outcome.elapsedMs,
  }, { config: logConfig });

  return {
    ok: true,
    httpStatus: 200,
    mode: "dsh",
    runtime: outcome.runtime ?? cfg.mode,
    conversationId,
    requestId,
    dsh_session_id: outcome.sessionId,
    erpnext_target: outcome.target ?? null,
    answer: outcome.answer,
    elapsed_ms: outcome.elapsedMs,
  };
}
