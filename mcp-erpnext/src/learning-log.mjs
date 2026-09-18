/**
 * P4 — Learning log (plan2_final §12, §19 P4; phases2/p4-learning-loop.md).
 *
 * PURPOSE: turn UNKNOWN_INTENT / KNOWN_INTENT_UNIMPLEMENTED (and every other
 * refusal/success) into a STRUCTURED product signal on disk, so a human can
 * review clusters and decide whether a Capability Contract trigger should be
 * added. The loop is HUMAN-APPROVED: nothing here ever writes to the contract,
 * the registry, or ERPNext — it only APPENDS observations to a JSONL file.
 *
 * Safety properties:
 *  - NEVER THROWS into the answer path: a broken log dir must not take down a
 *    user question. Every failure is swallowed after a one-line stderr note.
 *  - No secrets, no PII beyond what the user typed into their own copilot:
 *    the raw text IS the signal (it is needed to cluster phrases). The file
 *    lives in a GIT-IGNORED directory (never committed) — see .gitignore.
 *  - Bounded per line: text is truncated to 500 chars so one weird request
 *    cannot bloat the file.
 *  - One JSON object per line (JSONL) — crash-safe to append, easy to grep,
 *    easy for the cluster script (scripts/learning-cluster.mjs) to consume.
 *  - env-configurable dir via LEARNING_LOG_DIR, defaulting NEXT TO THE REPO
 *    ROOT (not /tmp — the audit-cleanup lesson from result31: /tmp is wiped
 *    by systemd/tmpfiles and the evidence disappears).
 */

import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";

/** Max chars of raw text stored per observation. */
const MAX_TEXT_LEN = 500;

/**
 * The full outcome taxonomy we track. Successes are logged too so cluster
 * reports can show WHAT WORKS vs what does not (denominator matters).
 */
export const LEARNING_OUTCOMES = Object.freeze([
  "answered",
  "unknown_intent",
  "known_intent_unimplemented",
  "forbidden",
  "low_confidence",
  "entity_problem",
  "nlp_unavailable",
  "error",
]);

/** Default dir: <repo>/learning-log/ — git-ignored, survives /tmp cleanups. */
export function defaultLogDir() {
  // This file lives in mcp-erpnext/src/ → repo root is two levels up.
  return path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..", "learning-log");
}

export function learningLogConfig(env = process.env) {
  return {
    enabled: String(env.LEARNING_LOG ?? "on").toLowerCase() !== "off",
    dir: env.LEARNING_LOG_DIR ?? defaultLogDir(),
    file: "observations.jsonl",
  };
}

/**
 * Map an answerQuestion() result to a learning outcome. One place, tested —
 * the pipeline must not re-derive this per call site.
 */
export function outcomeFor(result) {
  const code = result?.error_code ?? null;
  if (!code) return "answered";
  switch (code) {
    case "UNKNOWN_INTENT": return "unknown_intent";
    case "KNOWN_INTENT_UNIMPLEMENTED": return "known_intent_unimplemented";
    case "FORBIDDEN_IN_AI_PATH": return "forbidden";
    case "LOW_CONFIDENCE": return "low_confidence";
    case "NLP_UNAVAILABLE": return "nlp_unavailable";
    case "AMBIGUOUS_ENTITY":
    case "MISSING_ENTITY":
    case "ENTITY_PICK_REQUIRED":
    case "ENTITY_NOT_FOUND_BLOCKED":
    case "ENTITY_CHANGED":
      return "entity_problem";
    default: return "error";
  }
}

/**
 * Append ONE observation line. Returns true on success, false when logging
 * was skipped/failed — the CALLER must not branch on this (log is best-effort
 * by design; the answer is what matters).
 *
 * @param {object} result the full answerQuestion() result object
 * @param {{config?: object, clock?: () => number}} [opts] clock injectable for tests
 */
export function logObservation(result, opts = {}) {
  const config = opts.config ?? learningLogConfig();
  if (!config.enabled) return false;
  const now = (opts.clock ?? Date.now)();
  const text = typeof result?.question === "string" ? result.question : "";
  const rec = {
    ts: new Date(now).toISOString(), // always UTC (audit lesson: compare in UTC)
    text: text.slice(0, MAX_TEXT_LEN),
    outcome: outcomeFor(result),
    error_code: result?.error_code ?? null,
    matched: result?.routed?.matched ?? null,
    group: result?.routed?.group ?? null,
    capability: result?.routed?.capability ?? null,
    uncertainty_code: result?.uncertainty?.code ?? null,
    has_proposal: result?.proposal != null,
  };
  try {
    mkdirSync(config.dir, { recursive: true });
    appendFileSync(path.join(config.dir, config.file), JSON.stringify(rec) + "\n", { encoding: "utf8" });
    return true;
  } catch (err) {
    try { process.stderr.write(`[learning-log] skipped: ${err?.message ?? err}\n`); } catch { /* stderr gone */ }
    return false;
  }
}
