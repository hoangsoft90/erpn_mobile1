/**
 * issue1_fix1 — the fixture server is EXPLICIT OPT-IN only.
 *
 * Why this file exists: `mock-server.mjs` hard-codes `CUST-00001 =
 * "Nguyễn Thị Lan"` with invoices and a balance. Before this fix,
 * `pickServerScript()` treated a MISSING config as consent to serve that
 * fixture, so a `dsh` run whose launcher forgot to export ERPNEXT_* answered
 * "Nguyễn Thị Lan còn nợ …" — a customer that does not exist in the real
 * ERPNext — and the agent runtime reported it as fact (issue1).
 *
 * What is pinned here:
 *   1. STRUCTURE — no file in src/ or scripts/ may reach the fixture except
 *      through `pickServerScript()`'s explicit opt-in branch.
 *   2. DECISION  — the fixture is returned only when the config is COMPLETELY
 *      absent AND `COPILOT_MOCK_OK === "1"`; any configured host (even an
 *      unreachable one) can never be answered from fixtures.
 *   3. END-TO-END (the original bug, reproduced) — a copilot child with the
 *      exact env a misconfigured dsh launcher produces refuses to start and
 *      emits no amount at all, while the opt-in control below shows the
 *      fixture WOULD have answered — i.e. the gate is what stops it.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { pickServerScript } from "../src/copilot-server.mjs";
import { MOCK_SERVER } from "../src/client.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const REPO = path.resolve(ROOT, "..");
const COPILOT = path.join(ROOT, "src", "copilot-server.mjs");
const HTTP_ASK = path.join(ROOT, "src", "http-ask.mjs");

/** `npm test` sets COPILOT_MOCK_OK=1; a launcher that forgets ERPNEXT_* does not. */
const MOCK_ENV = Object.fromEntries(
  Object.entries(process.env).filter(([k]) => !/^ERPNEXT_/.test(k)),
);
/** The exact env a misconfigured launcher produces: no ERPNEXT_*, no opt-in. */
const UNCONFIGURED_ENV = Object.fromEntries(
  Object.entries(MOCK_ENV).filter(([k]) => k !== "COPILOT_MOCK_OK"),
);

// ───────────────────────────── 1. STRUCTURE ─────────────────────────────

function findJsFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...findJsFiles(full));
    else if (entry.name.endsWith(".mjs")) out.push(full);
  }
  return out;
}

test("structure: the fixture constant is reachable only from the three known files", () => {
  // A tripwire, not documentation: if a future change introduces a second path
  // to the fixture (a new default, a helper that falls back), this test fails
  // and names the file. Every runtime target decision must go through
  // pickServerScript().
  const allowed = new Set([
    path.join(ROOT, "src", "client.mjs"), // definition + low-level default (tests)
    path.join(ROOT, "src", "index.mjs"), // re-export of the constant
    path.join(ROOT, "src", "copilot-server.mjs"), // pickServerScript's opt-in branch
  ]);
  for (const dir of [path.join(ROOT, "src"), path.join(ROOT, "scripts")]) {
    for (const file of findJsFiles(dir)) {
      const src = readFileSync(file, "utf8");
      if (!src.includes("MOCK_SERVER")) continue;
      assert.ok(
        allowed.has(file),
        `${path.relative(ROOT, file)} references MOCK_SERVER directly — route the ` +
          `target decision through pickServerScript() (and add it here only if the ` +
          `fixture genuinely must be named in that file)`,
      );
    }
  }
});

// ───────────────────────────── 2. DECISION ─────────────────────────────

test("decision: a configured host is NEVER answered from fixtures, reachable or not", () => {
  // 6b-2: "missing config" and "configured but unreachable" are different
  // faults. The switch decides on PRESENCE of config only — so a dead port, a
  // nonexistent domain or a 500 response all resolve to REAL, and the failure
  // surfaces as a real ERPNext error at call time instead of silently
  // switching data source. Determined without network calls (pure function).
  const hosts = [
    "http://127.0.0.1:1",
    "https://erpnext.invalid",
    "https://erp.invalid:9999",
  ];
  for (const ERPNEXT_URL of hosts) {
    for (const COPILOT_MOCK_OK of [undefined, "1"]) {
      const env = { ERPNEXT_URL, ERPNEXT_API_KEY: "k", ERPNEXT_API_SECRET: "s" };
      if (COPILOT_MOCK_OK !== undefined) env.COPILOT_MOCK_OK = COPILOT_MOCK_OK;
      const picked = pickServerScript(env);
      assert.notEqual(picked, MOCK_SERVER, `fixture leaked for ${ERPNEXT_URL}`);
    }
  }
});

test("decision: the fixture requires BOTH absent config AND the exact opt-in", () => {
  assert.equal(pickServerScript({ COPILOT_MOCK_OK: "1" }), MOCK_SERVER);
  // Absent config WITHOUT the opt-in is a refusal, not a fixture answer.
  assert.throws(() => pickServerScript({}), /ERPNEXT_NOT_CONFIGURED/);
  // The opt-in cannot rescue a half-configured deployment either.
  assert.throws(
    () => pickServerScript({ COPILOT_MOCK_OK: "1", ERPNEXT_URL: "https://x.dev" }),
    /PARTIAL_ERPNEXT_CONFIG/,
  );
});

// ───────────────────── 3. END-TO-END (original bug) ─────────────────────

/** Spawn the Python bridge on an ephemeral port, return {child, port}. */
async function startNlpService() {
  const child = spawn("python3", ["-m", "nlp_service.server", "--port", "0"], {
    cwd: REPO,
    stdio: ["ignore", "pipe", "inherit"],
  });
  const port = await new Promise((resolve, reject) => {
    child.stdout.on("data", (d) => {
      const m = String(d).match(/"port":\s*(\d+)/);
      if (m) resolve(Number(m[1]));
    });
    child.on("exit", (code) => reject(new Error(`nlp service exited early (${code})`)));
    setTimeout(() => reject(new Error("nlp service: no ready line in 5s")), 5000);
  });
  return { child, port };
}

/** Spawn one copilot-server child; collect stdout/stderr and its exit code. */
function runCopilotOnce(port, env) {
  const child = spawn(process.execPath, [COPILOT], {
    env: { ...env, NLP_SERVICE_PORT: String(port) },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => (stdout += d));
  child.stderr.on("data", (d) => (stderr += d));
  const exited = new Promise((resolve) => child.once("exit", (code) => resolve(code)));
  return { child, exited, out: () => ({ stdout, stderr }) };
}

test("E2E: an unconfigured copilot refuses to start and emits NO customer data (issue1)", async () => {
  // First prove the bug was real: the fixture this path used to fall back to
  // really does contain the customer and balance that issue1 reported.
  const fixture = readFileSync(path.join(ROOT, "src", "mock-server.mjs"), "utf8");
  assert.ok(fixture.includes("Nguyễn Thị Lan"), "fixture no longer contains the issue1 customer");

  const nlp = await startNlpService();
  const { child, exited, out } = runCopilotOnce(nlp.port, UNCONFIGURED_ENV);
  try {
    // BOUNDED on purpose: if the gate is broken the child keeps SERVING instead
    // of exiting, and an unbounded `await exited` would hang the test (and any
    // falsify harness mutating this guard) forever. A timeout is a FAILURE of
    // this assertion (the server should have refused), reported as such.
    const code = await Promise.race([
      exited,
      new Promise((resolve) => setTimeout(() => resolve("NO-EXIT"), 15_000).unref()),
    ]);
    assert.equal(
      code,
      2,
      `expected a fatal config exit, got ${code} — a running server here means ` +
        `absent config was silently accepted. stderr: ${out().stderr}`,
    );
    assert.match(out().stderr, /ERPNEXT_NOT_CONFIGURED/);
    // Nothing may reach the client: no answer, and definitely no fabricated
    // customer name or amount (the pre-fix failure mode).
    assert.equal(out().stdout, "", `no protocol output expected, got: ${out().stdout}`);
    assert.doesNotMatch(out().stdout, /2\.500\.000|171\.800|Nguyễn Thị Lan|CUST-00001/);
  } finally {
    child.kill();
    nlp.child.kill();
  }
});

/** Spawn the HTTP server and capture its early output/exit. */
function runHttpAskOnce(env) {
  const child = spawn(process.execPath, [HTTP_ASK, "--port", "0"], {
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => (stdout += d));
  child.stderr.on("data", (d) => (stderr += d));
  return { child, out: () => ({ stdout, stderr }) };
}

test("boot: http-ask refuses to START when the config is missing (no fixture fallback)", async () => {
  const { child, out } = runHttpAskOnce(UNCONFIGURED_ENV);
  const code = await Promise.race([
    new Promise((r) => child.once("exit", r)),
    new Promise((resolve) => setTimeout(() => resolve("NO-EXIT"), 15_000).unref()),
  ]);
  child.kill();
  assert.equal(code, 1, `expected a boot refusal, got ${code} — stderr: ${out().stderr}`);
  assert.match(out().stderr, /ERPNEXT_NOT_CONFIGURED/);
  // It must not have announced itself as ready to serve.
  assert.doesNotMatch(out().stdout, /"ready":true/);
});

test("boot control: WITH the opt-in the server boots and says the target is the fixture", async () => {
  const { child, out } = runHttpAskOnce(MOCK_ENV);
  try {
    const ready = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`never became ready: ${out().stderr}`)), 15_000);
      child.stdout.on("data", (d) => {
        if (String(d).includes('"ready":true')) {
          clearTimeout(timer);
          resolve(String(d));
        }
      });
    });
    assert.match(ready, /"ready":true/);
    assert.match(out().stderr, /fixture \(COPILOT_MOCK_OK=1\)/);
  } finally {
    child.kill();
  }
});

test("E2E control: WITH the explicit opt-in the same env answers from the fixture", async () => {
  // This is what makes the test above meaningful: identical setup, one variable
  // changed. The fixture answers (so the refusal above is caused by the gate),
  // and the answer it produces is exactly the fabricated data issue1 saw.
  const nlp = await startNlpService();
  const { child, exited, out } = runCopilotOnce(nlp.port, MOCK_ENV);
  try {
    await child.stdin.write(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "copilot_ask", arguments: { text: "Nguyễn Thị Lan còn nợ bao nhiêu" } },
      }) + "\n",
    );
    const answered = await new Promise((resolve, reject) => {
      let buf = "";
      const timer = setTimeout(() => reject(new Error(`no answer in 20s: ${out().stderr}`)), 20_000);
      child.stdout.on("data", (d) => {
        buf += d;
        if (buf.includes("\n")) {
          clearTimeout(timer);
          resolve(buf);
        }
      });
    });
    const line = answered.split("\n").find((l) => l.trim());
    const parsed = JSON.parse(line);
    const structured = parsed.result?.structuredContent ?? {};
    assert.equal(structured.customer?.id, "CUST-00001");
    assert.match(String(structured.answer), /2\.500\.000/);
    assert.equal(out().stderr.includes("COPILOT_MOCK_OK"), true);
  } finally {
    child.kill();
    nlp.child.kill();
    void exited;
  }
});
