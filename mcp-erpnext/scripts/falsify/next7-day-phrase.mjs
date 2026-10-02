#!/usr/bin/env node
/**
 * next7 / C3 falsification harness — the DAY a chat revenue question names.
 *
 * Break ONE guard at a time, prove the NAMED test turns RED, restore the file,
 * verify the restore is byte-identical. The guards chosen here are the ones that
 * fail SILENTLY if they rot: a day phrase that stops being read, a refusal that
 * becomes an answer about today, a day that stops reaching the skill, and the
 * two Vietnamese-specific traps this module hit while being written (an ASCII
 * `\b` around a diacritic, and a number that is money rather than a date).
 *
 * Run: node scripts/falsify/next7-day-phrase.mjs
 */
import { runCases } from "./lib/harness.mjs";

const NODE_FILES = { day: "test/next7-c3-day-phrase.test.mjs" };

const SERVER = "src/copilot-server.mjs";
const PHRASE = "src/day-phrase.mjs";
const TAXONOMY = "src/uncertainty.mjs";

const ONLY = {
  reads: "C3 unit: the days a shopkeeper writes",
  none: "C3 unit: a question that names NO day",
  refuses: "C3 unit: a day we cannot pin is a REFUSAL",
  taxonomy: "C3 taxonomy: every code the day phrase",
  e2e: "C3 E2E: 'hôm qua' and an explicit date",
  e2eRefuse: "C3 E2E: an unpinnable day REFUSES",
};

const CASES = [
  // ── the refusal must stay a refusal ──────────────────────────────────────
  {
    name: "an unusable day stops refusing (the guard is bypassed — today's number would ship instead)",
    suite: "node",
    file: SERVER,
    nodeFile: "day",
    only: ONLY.e2eRefuse,
    old: "      if (!day.ok) {\n        return withUncertainty({",
    new: "      if (false) {\n        return withUncertainty({",
  },
  {
    name: "the period rule is dropped (\"doanh thu tháng này\" answers today's number)",
    suite: "node",
    file: PHRASE,
    nodeFile: "day",
    only: ONLY.refuses,
    old: "  if (PERIOD_RE.test(restNoRel)) {",
    new: "  if (false) {",
  },
  {
    name: "a future day is accepted (revenue reported for a day that has not happened)",
    suite: "node",
    file: PHRASE,
    nodeFile: "day",
    only: ONLY.refuses,
    old: "  if (date > today) {",
    new: "  if (false) {",
  },
  {
    name: "two different days in one sentence are allowed (the sentence picks one at random)",
    suite: "node",
    file: PHRASE,
    nodeFile: "day",
    only: ONLY.refuses,
    old: "  if (distinct.length > 1) {",
    new: "  if (false) {",
  },
  // ── the day must actually reach the read ─────────────────────────────────
  {
    name: "the parsed day is ignored when the skill is called (every date collapses to today)",
    suite: "node",
    file: SERVER,
    nodeFile: "day",
    only: ONLY.e2e,
    old: "          date: day.date ?? today,\n          company: authzCompany,",
    new: "          date: today,\n          company: authzCompany,",
  },
  {
    name: "the answer stops naming a past day (a day-old figure reads as today's)",
    suite: "node",
    file: SERVER,
    nodeFile: "day",
    only: ONLY.e2e,
    old: '          s.date === today ? "" : s.date === addDays(today, -1) ? " (hôm qua)"',
    new: '          s.date === today ? "" : s.date === addDays(today, -1) ? ""',
  },
  // ── the two Vietnamese traps, each measured while this module was written ─
  {
    name: "word boundaries go back to ASCII \\b (a diacritic word silently stops matching)",
    suite: "node",
    file: PHRASE,
    nodeFile: "day",
    only: ONLY.refuses,
    old: 'const NOT_AFTER = `(?<![${LETTER}])`;\nconst NOT_BEFORE = `(?![${LETTER}])`;',
    new: 'const NOT_AFTER = "\\\\b";\nconst NOT_BEFORE = "\\\\b";',
  },
  {
    name: "a number followed by a money word is read as a date again (\"1/5 triệu\" becomes 1 May)",
    suite: "node",
    file: PHRASE,
    nodeFile: "day",
    only: ONLY.none,
    old: "      if (MONEY_AFTER_RE.test(text.slice(to, to + 12))) continue;",
    new: "      if (false) continue;",
  },
  {
    name: "every relative day collapses to the same offset (\"hôm qua\" answers for hôm kia)",
    suite: "node",
    file: PHRASE,
    nodeFile: "day",
    only: ONLY.reads,
    old: '    const unaccented = word.replace(/ô/g, "o").replace(/à/g, "a");',
    new: "    const unaccented = word;",
  },
  // ── a refusal with no words is a dead end (the P8 lesson) ────────────────
  {
    name: "the new refusal code is dropped from the taxonomy (the screen would show a bare code)",
    suite: "node",
    file: TAXONOMY,
    nodeFile: "day",
    only: ONLY.taxonomy,
    old: '  DAY_PHRASE_INVALID: "DAY_PHRASE_INVALID",\n',
    new: "",
  },
];

process.exit(runCases(CASES, { title: "next7 C3 day phrase", nodeFiles: NODE_FILES }) === 0 ? 0 : 1);
