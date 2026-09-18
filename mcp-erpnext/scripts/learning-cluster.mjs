#!/usr/bin/env node
/**
 * P4 — Learning cluster report (phases2/p4-learning-loop.md deliverable 2).
 *
 * Reads the JSONL observations written by learning-log.mjs, groups the
 * refusals that matter (UNKNOWN_INTENT + KNOWN_INTENT_UNIMPLEMENTED first —
 * the plan2_final §12 product signals) and prints a HUMAN-REVIEW report:
 * the exact phrases, counts, and a ready-to-edit trigger suggestion block.
 *
 * This script is READ-ONLY over the log. It never edits the Capability
 * Contract — the human decides, edits capabilities.json + golden cases, runs
 * the tests (the workflow in docs/learning-loop-workflow.md), and merges.
 *
 * Usage: node scripts/learning-cluster.mjs [--dir <log-dir>] [--min <count>]
 * Exit codes: 0 = report printed, 1 = log missing/empty (nothing to cluster).
 */

import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { learningLogConfig } from "../src/learning-log.mjs";

function parseArgs(argv) {
  // env-number law (lesson 451cd8f): finite AND positive or the default —
  // `--min garbage` must not become NaN (would make every filter false).
  const args = { dir: null, min: 2 };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--dir") args.dir = argv[++i];
    else if (argv[i] === "--min") {
      const n = Number(argv[++i]);
      if (Number.isFinite(n) && n > 0) args.min = n;
    }
  }
  return args;
}

/**
 * Lightweight normalizer for clustering: lowercase, strip punctuation, numbers
 * → placeholder, then drop ALL single-character tokens (stray letters like
 * names "A"/"B" AND the bare-number placeholder "#" alike — one uniform rule).
 * Deliberately coarse: the report is for a HUMAN who reads the example phrases
 * and decides — over-grouping is safe (examples stay verbatim), under-grouping
 * hides the signal.
 */
function clusterKey(text) {
  return String(text ?? "")
    .toLowerCase()
    .normalize("NFC")
    .replace(/[.,!?;:()"'+]/g, " ")
    .replace(/\b\d+\b/g, "#") // bare numbers → placeholder ("thu tiền 500" ≈ "thu tiền 200")
    .split(/\s+/)
    .filter((w) => w.length > 1) // uniform: any 1-char token is clustering noise
    .join(" ")
    .trim();
}

/** Pull a short, useful head word-window from the phrase for display. */
function displayPhrase(text) {
  const words = String(text ?? "").trim().split(/\s+/).slice(0, 8);
  return words.join(" ");
}

const config = learningLogConfig();
const { dir, min } = parseArgs(process.argv.slice(2));
const logDir = dir ?? config.dir;
const logPath = path.join(logDir, config.file);

if (!existsSync(logPath)) {
  process.stderr.write(`No learning log at ${logPath} — nothing to cluster yet.\n`);
  process.exit(1);
}

const lines = readFileSync(logPath, "utf8").split("\n").filter((l) => l.trim().length > 0);
const obs = [];
for (const line of lines) {
  try { obs.push(JSON.parse(line)); } catch { /* skip corrupt line, count below */ }
}
const corrupt = lines.length - obs.length;

if (obs.length === 0) {
  process.stderr.write(`Log exists but has 0 valid observations (corrupt lines: ${corrupt}).\n`);
  process.exit(1);
}

// ── Outcome summary ─────────────────────────────────────────────────────────
const byOutcome = {};
for (const o of obs) byOutcome[o.outcome] = (byOutcome[o.outcome] ?? 0) + 1;

// ── Clusters for the two §12 signals (+ low-confidence, also human-worthy) ──
const SIGNAL_OUTCOMES = new Set(["unknown_intent", "known_intent_unimplemented", "low_confidence"]);
const clusters = new Map();
for (const o of obs) {
  if (!SIGNAL_OUTCOMES.has(o.outcome)) continue;
  const key = clusterKey(o.text);
  if (!key) continue;
  if (!clusters.has(key)) {
    clusters.set(key, { key, count: 0, examples: [], codes: new Set(), last: o.ts });
  }
  const c = clusters.get(key);
  c.count += 1;
  c.codes.add(o.error_code ?? o.outcome);
  if (o.ts > c.last) c.last = o.ts;
  if (c.examples.length < 3) c.examples.push(displayPhrase(o.text));
}

const ranked = [...clusters.values()].filter((c) => c.count >= min).sort((a, b) => b.count - a.count);

// ── Report ──────────────────────────────────────────────────────────────────
const fmt = new Intl.DateTimeFormat("sv-SE", { timeZone: "UTC", dateStyle: "short", timeStyle: "short" });
console.log(`Learning cluster report — ${fmt.format(new Date())} (UTC)`);
console.log(`Log: ${logPath} (${obs.length} observations, ${corrupt} corrupt lines skipped)`);
console.log("");
console.log("Outcome summary:");
for (const [k, v] of Object.entries(byOutcome).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(v).padStart(4)}  ${k}`);
}
console.log("");
if (ranked.length === 0) {
  console.log(`No cluster reached the minimum of ${min} occurrences. Nothing to review yet.`);
} else {
  console.log(`Clusters needing HUMAN REVIEW (min ${min} occurrences, ranked by frequency):`);
  console.log("");
  for (const c of ranked) {
    console.log(`  [${c.count}x] (${[...c.codes].join(", ")}) last seen ${c.last}`);
    for (const ex of c.examples) console.log(`        "${ex}"`);
  }
  console.log("");
  console.log("Next step (docs/learning-loop-workflow.md): a HUMAN decides whether any");
  console.log("phrase group is a real capability trigger; then edit capabilities.json +");
  console.log("golden cases, run the regression suite, and merge. The pipeline NEVER");
  console.log("writes contract changes itself.");
}
