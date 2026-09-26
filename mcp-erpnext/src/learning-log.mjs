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
  "dsh_write_blocked",
  "low_confidence",
  "entity_problem",
  "nlp_unavailable",
  // P10 slice: a throttled request is a DELIBERATE refusal, not a system
  // error — it gets its own bucket so the cluster report stays honest (same
  // reasoning as dsh_write_blocked in result49).
  "rate_limited",
  // P10 slice §17: the WRITE path (execute + job runner) reports its own
  // vocabulary. "verify rate" is a first-class metric, so a verified write
  // must never be lumped in with "answered".
  "write_verified",
  "write_replayed",
  "write_retryable",
  "write_refused",
  // A1 UX-READ drill-down: opening a screen is a READ, and reporting it as
  // "answered" would hide how much of the traffic is drill-down vs question.
  "read_served",
  // C1 camera channel: text read off a PHOTO is its own input path, so it gets
  // its own bucket instead of hiding inside "answered" — a cluster report must
  // be able to show how much of the traffic arrived by camera, and whether the
  // photos we are handed are readable at all. `ocr_unreadable` is specifically
  // "the picture produced no text" (a product signal about capture, not about
  // language), while a low-confidence read uses the existing "low_confidence".
  "ocr_served",
  "ocr_unreadable",
  // C2 camera → proposal: opening the slot form for a photo is neither an
  // answer nor a read of ERPNext data — it is the step where a picture is
  // turned into EDITABLE slots, and a cluster report must be able to tell how
  // often a photo got that far (and what the reader got wrong).
  "slots_served",
  "error",
]);

/**
 * Outcome vocabulary for a Safety Gateway verdict (P10 §17). Kept here next to
 * the taxonomy so the /execute endpoint and the job runner cannot drift apart.
 * @param {{status?: number, body?: object}} verdict
 */
export function writeOutcomeFor(verdict) {
  const body = verdict?.body ?? {};
  if (verdict?.status === 200) return body.replay === true ? "write_replayed" : "write_verified";
  if (verdict?.status === 429 || body.code === "RATE_LIMITED") return "rate_limited";
  if (verdict?.status === 503) return "write_retryable";
  return "write_refused";
}

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
    case "DSH_WRITE_BLOCKED": return "dsh_write_blocked";
    case "LOW_CONFIDENCE": return "low_confidence";
    case "NLP_UNAVAILABLE": return "nlp_unavailable";
    case "RATE_LIMITED": return "rate_limited";
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
 * @param {{config?: object, clock?: () => number, correlation?: object}} [opts]
 *        `correlation` carries the P10 §17 columns from the HTTP layer
 *        (request_id / user_id / command_id / action_id / latency_ms …).
 */
export function logObservation(result, opts = {}) {
  const now = (opts.clock ?? Date.now)();
  const text = typeof result?.question === "string" ? result.question : "";
  return logEvent(
    {
      phase: "ask",
      text: text.slice(0, MAX_TEXT_LEN),
      outcome: outcomeFor(result),
      error_code: result?.error_code ?? null,
      matched: result?.routed?.matched ?? null,
      group: result?.routed?.group ?? null,
      capability: result?.routed?.capability ?? null,
      uncertainty_code: result?.uncertainty?.code ?? null,
      has_proposal: result?.proposal != null,
      ...correlationFields(result, opts.correlation),
    },
    { ...opts, now },
  );
}

/**
 * Correlation columns (plan2_final §17) present on EVERY event kind. Only
 * non-empty values are written: a line saying `command_id: null` is noise when
 * the route never had one.
 */
const CORRELATION_KEYS = [
  "request_id",
  "user_id",
  "command_id",
  "action_id",
  "latency_ms",
  "erp_document_id",
  "capability",
  "risk",
];

function correlationFields(result, correlation) {
  const src = {
    command_id: correlation?.command_id ?? result?.proposal?.command_id ?? null,
    action_id: correlation?.action_id ?? result?.proposal?.action_id ?? null,
    erp_document_id: correlation?.erp_document_id ?? result?.erpnext_doc ?? null,
    risk: correlation?.risk ?? result?.proposal?.risk ?? null,
    ...(correlation ?? {}),
  };
  const out = {};
  for (const key of CORRELATION_KEYS) {
    const value = src[key];
    if (value !== undefined && value !== null && value !== "") out[key] = value;
  }
  return out;
}

/**
 * Append ONE structured event of any kind (ask / execute / job). /execute and
 * the job runner do not produce an answerQuestion() result shape, so they hand
 * their fields in directly instead of pretending to be an answer.
 *
 * Same contract as logObservation: NEVER throws into a request path, returns
 * false when skipped/failed, and the caller must not branch on the return
 * value.
 *
 * @param {object} fields event fields; `ts` is always set here (UTC)
 * @param {{config?: object, clock?: () => number, now?: number}} [opts]
 */
export function logEvent(fields, opts = {}) {
  const config = opts.config ?? learningLogConfig();
  if (!config.enabled) return false;
  const now = opts.now ?? (opts.clock ?? Date.now)();
  const rec = { ts: new Date(now).toISOString(), ...fields }; // always UTC (audit lesson: compare in UTC)
  try {
    mkdirSync(config.dir, { recursive: true });
    appendFileSync(path.join(config.dir, config.file), JSON.stringify(rec) + "\n", { encoding: "utf8" });
    return true;
  } catch (err) {
    try { process.stderr.write(`[learning-log] skipped: ${err?.message ?? err}\n`); } catch { /* stderr gone */ }
    return false;
  }
}
