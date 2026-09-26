#!/usr/bin/env node
/**
 * Falsification harness for P4-2 — `GET|POST /read/daily-summary`
 * (plan4_final §4.2/§4.3, 2026-09-21).
 *
 * Break ONE guard at a time, prove the NAMED test turns RED, restore the file,
 * verify the restore is byte-identical. A guard whose removal turns nothing red
 * is decoration — this file is how that claim gets checked.
 *
 * Two lessons from the previous rounds are built in:
 *  - `--test-name-pattern` + "the failing test is the expected one" (LESSONS
 *    group 20 / result-p4-1 §6): a red suite where some OTHER test failed proves
 *    nothing, so each case names the test it must break.
 *  - `only`-style scoping keeps every case bounded (a mutation no longer drags
 *    the whole suite along), and the restore happens in `finally`.
 *
 * Run: node scripts/falsify/p42-read-daily-summary.mjs
 */
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..", ".."); // mcp-erpnext/

const HTTP_SUITE = "test/p42-read-daily-summary.test.mjs";
const AUTHZ_SUITE = "test/p42-read-daily-summary-authz.test.mjs";
const CLIENT_SUITE = "test/client.test.mjs";

const CASES = [
  {
    name: "A. vnToday uses the HOST's day instead of the shop's timezone",
    suite: HTTP_SUITE,
    expect: "23:59 vs 00:00 VN",
    file: "src/http-ask.mjs",
    find: '    timeZone: "Asia/Ho_Chi_Minh",',
    replace: '    timeZone: "UTC",',
  },
  {
    name: "B. the calendar round-trip is dropped (a regex passes 2026-02-30)",
    suite: HTTP_SUITE,
    expect: "dates that do not exist on the calendar",
    file: "src/http-ask.mjs",
    find: "  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== m - 1 || probe.getUTCDate() !== d) {",
    replace: "  if (false) {",
  },
  {
    name: "C. an absent date no longer defaults to today (the day itself is required)",
    suite: HTTP_SUITE,
    expect: "TODAY AT THE SHOP",
    file: "src/http-ask.mjs",
    find: "      const date = typeof rawDate === \"string\" && rawDate ? rawDate : vnToday();",
    replace: "      const date = typeof rawDate === \"string\" && rawDate ? rawDate : rawDate;",
  },
  {
    name: "D. the route stops accepting GET (query shape dropped)",
    suite: HTTP_SUITE,
    expect: "GET with ?date=",
    file: "src/http-ask.mjs",
    find: '    if ((req.method === "GET" || req.method === "POST") && path === "/read/daily-summary") {',
    replace: '    if (req.method === "POST" && path === "/read/daily-summary") {',
  },
  {
    name: "E. a client-supplied company is no longer checked against the resolved one",
    suite: HTTP_SUITE,
    expect: "DISAGREES",
    file: "src/http-ask.mjs",
    find: "        if (claimedCompany && claimedCompany !== company) {",
    replace: "        if (false) {",
  },
  {
    name: "F. an unresolved company is no longer refused (the skill's own throw is the only guard left)",
    suite: HTTP_SUITE,
    expect: "no company to read",
    // NOTE (2026-09-21, P4-4): the guard moved into the shared
    // resolveReadCompany() helper when /read/drill started reusing it. The
    // anchor has to follow the code — and this harness reports `anchor missing`
    // instead of silently skipping, which is the only reason the drift was
    // noticed at all (P4-7).
    file: "src/http-ask.mjs",
    find: '  if (!company) {\n    return {\n      ok: false,\n      status: 503,\n      code: "COMPANY_UNRESOLVED",',
    replace: '  if (false) {\n    return {\n      ok: false,\n      status: 503,\n      code: "COMPANY_UNRESOLVED",',
  },
  {
    name: "G. the route re-writes the aggregate (partial flag/errors stripped before sending)",
    suite: HTTP_SUITE,
    expect: "NULL block",
    file: "src/http-ask.mjs",
    find: "        sendJson(res, 200, summary);",
    replace: "        sendJson(res, 200, { ...summary, meta: { ...summary.meta, partial: false, errors: [] } });",
  },
  {
    name: "H. the READ bucket is no longer charged",
    suite: HTTP_SUITE,
    expect: "READ bucket is charged before any ERP read",
    file: "src/http-ask.mjs",
    find: '      const dayVerdict = rateLimiter.chargeUser("read", userId);',
    replace: "      const dayVerdict = { ok: true };",
  },
  {
    name: "I. authorization is skipped (the read runs for an account that may not run the capability)",
    suite: AUTHZ_SUITE,
    expect: "denied account gets 403",
    file: "src/http-ask.mjs",
    find: '        dayAuthz = authorize("ops.daily_summary", { principal, env });',
    replace: "        dayAuthz = { ok: true, company: null };",
  },
  {
    name: "J. the MCP layer's own vocabulary is handed to the client verbatim",
    suite: AUTHZ_SUITE,
    expect: "allowed one is the control",
    file: "src/http-ask.mjs",
    find: '  return SUMMARY_CLIENT_CODES.has(raw) ? raw : "ERP_UNAVAILABLE";',
    replace: "  return raw;",
  },
  {
    name: "K. the static tripwire can actually see the route block",
    suite: HTTP_SUITE,
    expect: "no write surface",
    file: "src/http-ask.mjs",
    find: "      let body = {};\n      try {\n        if (req.method === \"POST\") {",
    replace: "      let body = {};\n      const classifierProbe = routeIntent;\n      try {\n        if (req.method === \"POST\") {",
  },
  {
    name: "L. the mock's \"site has no default company\" knob is vacuous (it falls back to a company)",
    suite: HTTP_SUITE,
    expect: "no company to read",
    file: "src/mock-server.mjs",
    find: "      const value = configured === undefined ? fallback : configured.trim() || null;",
    replace: "      const value = configured === undefined ? fallback : configured.trim() || fallback;",
  },
  {
    // This one fails by taking the PROCESS down (the async listener rejects →
    // unhandled rejection → Node exits), so the red is not a normal assertion
    // failure. It still lands on the named test, which is what attribution
    // checks — measured once by hand before adding it here.
    name: "M. the ERP client is built OUTSIDE the handler's try (a config throw kills the service)",
    suite: HTTP_SUITE,
    expect: "unconfigured ERP target",
    file: "src/http-ask.mjs",
    find: "      let dayMcp = null;\n      try {\n        dayMcp = createMcpClient({ serverScript: pickServerScript() });\n        await dayMcp.initialize();",
    replace: "      const dayMcp = createMcpClient({ serverScript: pickServerScript() });\n      try {\n        await dayMcp.initialize();",
  },
  {
    name: "N. close() waits on an `exit` event that already fired (the route's finally hangs forever)",
    suite: CLIENT_SUITE,
    expect: "IDEMPOTENT",
    file: "src/client.mjs",
    find: "      if (child.exitCode !== null || child.signalCode !== null) return;",
    replace: "      if (false) return;",
  },
  {
    // The FIXTURE branch of the mock used to skip this check, so "the site has
    // no custom_ai_action_id" (the state this site was really in until
    // 2026-09-21) silently became "0 drafts" and no test could reproduce it.
    // The anchor is the fixture-specific condition — the ledger branch below
    // phrases the same check differently (`needsCorrelation && !available`),
    // which is why this mutation cannot hit the wrong one.
    name: "O. the fixture branch stops modelling a missing correlation column (a missing field silently becomes 0)",
    suite: HTTP_SUITE,
    expect: "ONE doctype without the correlation field",
    file: "src/mock-server.mjs",
    find: '      if (filters.some(([field]) => field === "custom_ai_action_id") && !corrAvail) {',
    replace: "      if (false) {",
  },
];

/**
 * Run one NAMED test under the tap reporter.
 *
 * The pattern is a REGEX (node's --test-name-pattern), so a plain expectation
 * containing `?` either matches nothing or matches the wrong test — and a
 * pattern that matches nothing runs ZERO tests and exits 0, i.e. "green". That
 * silent success is exactly the failure mode this helper refuses to accept:
 * `ran` counts the tests the pattern actually executed.
 */
function runCase(c) {
  const pattern = c.expect.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  try {
    const out = execFileSync(
      process.execPath,
      ["--test", "--test-reporter=tap", "--test-name-pattern", pattern, c.suite],
      {
        cwd: ROOT,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 120_000,
        env: { ...process.env, COPILOT_MOCK_OK: "1" },
      },
    );
    return { red: false, out };
  } catch (err) {
    return { red: true, out: String(err?.stdout ?? "") };
  }
}

function testsRan(out) {
  const m = /^# tests (\d+)$/m.exec(out);
  return m ? Number(m[1]) : 0;
}

let failures = 0;
for (const c of CASES) {
  const full = path.join(ROOT, c.file);
  const original = readFileSync(full, "utf8");
  if (!original.includes(c.find)) {
    console.log(`PROBLEM  anchor missing: ${c.name}`);
    failures += 1;
    continue;
  }

  // Control FIRST: the named test must exist and pass before the mutation.
  // Otherwise a red afterwards could just be a test that was already broken.
  const before = runCase(c);
  if (before.red || testsRan(before.out) < 1) {
    failures += 1;
    console.log(
      `PROBLEM  ${c.name}  → the named test did not pass beforehand (ran ${testsRan(before.out)}, red=${before.red})`,
    );
    continue;
  }

  writeFileSync(full, original.replace(c.find, c.replace), "utf8");
  const after = runCase(c);
  writeFileSync(full, original, "utf8");

  const red = after.red;
  const output = after.out;
  const identical = readFileSync(full, "utf8") === original;
  // Attribution: the red must come from THIS test. Without it, "the suite went
  // red" can be a different test failing for a different reason.
  const failing = output
    .split("\n")
    .filter((l) => l.startsWith("not ok"))
    .join("\n");
  const attributed = failing.includes(c.expect);
  const ok = red && identical && attributed;
  if (!ok) failures += 1;
  const why = !red
    ? "NOT RED (the guard is decoration — or the test never ran)"
    : !identical
      ? "RESTORE NOT BYTE-IDENTICAL"
      : !attributed
        ? `RED BUT NOT THIS TEST (failing: ${failing.slice(0, 120) || "none"})`
        : "";
  console.log(`${ok ? "RED" : "PROBLEM"}  ${c.name}${why ? `  → ${why}` : ""}`);
}

console.log(
  failures === 0
    ? "\nALL GUARDS ALIVE (every mutation turns the NAMED test red, restore byte-identical)"
    : `\n${failures} PROBLEM(S)`,
);
process.exit(failures === 0 ? 0 : 1);
