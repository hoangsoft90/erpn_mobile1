/**
 * P0 §15 + §24.5 — Golden Dataset v1 regression runner.
 *
 * Runs the DETERMINISTIC core (vietnamese_nlp over the locked HTTP bridge +
 * capability contract + entity resolver) against 200 version-controlled
 * Vietnamese cases, bucket by bucket, and enforces the plan's targets:
 *
 *   READ ≥ 95% · WRITE ≥ 90% · kinship ≥ 90% · money ≥ 95%
 *   ambiguous ≥ 85% · adversarial = 100% must not reach a WRITE
 *
 * No LLM, no ERPNext credentials, no network: the Python service is spawned on
 * an ephemeral port and ERPNext is replaced by a fixture catalog, so this runs
 * anywhere and means the same thing every time.
 *
 * Exit code is the verdict — a bucket below target FAILS the suite.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { routeIntent } from "../src/router.mjs";
import { getCapability, isForbidden } from "../src/capability-contract.mjs";
import { resolveCustomer } from "../src/copilot-server.mjs";
import { containsInstructionPattern, sanitizeUntrustedText } from "../src/untrusted-data.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");
const DATASET = JSON.parse(readFileSync(path.join(HERE, "golden", "golden-dataset.json"), "utf8"));

/** Spawn the Python NLP bridge on an ephemeral port -> {child, port}. */
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

async function normalize(port, text) {
  const res = await fetch(`http://127.0.0.1:${port}/normalize`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
  const body = await res.json();
  if (!body.ok) throw new Error(`normalize failed for "${text}": ${body.error}`);
  return body.result;
}

/** resolveCustomer() → the P0 three-state proxy for the spec's four-state enum. */
function entityState({ customer, ambiguous }) {
  if (customer && !ambiguous) return "MATCH";
  if (ambiguous) return "AMBIGUOUS_MATCH";
  return "NO_MATCH";
}

test("golden dataset v1 — buckets meet the plan2_final §24.5 targets", async (t) => {
  // 0. The dataset itself must satisfy the minimums before it can certify code.
  const counts = {};
  for (const c of DATASET.cases) counts[c.bucket] = (counts[c.bucket] ?? 0) + 1;
  for (const [bucket, min] of Object.entries(DATASET.minimums)) {
    assert.ok(
      (counts[bucket] ?? 0) >= min,
      `bucket ${bucket}: ${counts[bucket] ?? 0} cases < required ${min}`,
    );
  }
  const total = DATASET.cases.length;
  assert.ok(total >= 200, `dataset must hold ≥200 cases, has ${total}`);

  const nlp = await startNlpService();
  process.env.NLP_SERVICE_PORT = String(nlp.port);
  try {
    const buckets = ["read", "write", "kinship", "money", "ambiguous", "adversarial"];
    const catalogSkills = { findCustomer: async () => ({ data: { data: DATASET.ambiguous_catalog } }) };
    const report = [];

    for (const bucket of buckets) {
      await t.test(`bucket: ${bucket} (${counts[bucket]} cases)`, async () => {
        const cases = DATASET.cases.filter((c) => c.bucket === bucket);
        const failures = [];
        for (const c of cases) {
          const nlpResult = await normalize(nlp.port, c.text);
          let ok = false;
          let got = null;

          if (bucket === "read" || bucket === "write") {
            const hit = routeIntent(nlpResult.text);
            got = hit?.capability ?? "NONE";
            ok = got === c.expect.capability;
          } else if (bucket === "money") {
            got = nlpResult.amount;
            ok = got === c.expect.amount;
          } else if (bucket === "kinship") {
            const titles = [...nlpResult.titles].map((x) => x.toLowerCase()).sort();
            const wantTitles = [...c.expect.titles].sort();
            const hasText = (c.expect.text_contains ?? []).every((s) => nlpResult.text.includes(s));
            got = { titles, text: nlpResult.text };
            ok = JSON.stringify(titles) === JSON.stringify(wantTitles) && hasText;
          } else if (bucket === "ambiguous") {
            const resolved = await resolveCustomer(catalogSkills, nlpResult.text);
            got = entityState(resolved);
            ok = got === c.expect.entity;
          } else if (bucket === "adversarial") {
            const hit = routeIntent(nlpResult.text);
            const cap = hit ? getCapability(hit.capability) : null;
            const reachesWrite = Boolean(cap) && cap.type === "WRITE" && !isForbidden(hit.capability);
            let sanitizedOk = true;
            if (c.expect.inject) {
              sanitizedOk = !containsInstructionPattern(sanitizeUntrustedText(c.text));
            }
            got = { capability: hit?.capability ?? "NONE", reachesWrite, sanitizedOk };
            ok = c.expect.block === true && reachesWrite === false && sanitizedOk;
          }

          if (!ok) failures.push({ id: c.id, text: c.text, want: c.expect, got });
        }

        const passed = cases.length - failures.length;
        const accuracy = passed / cases.length;
        const target = DATASET.thresholds[bucket];
        report.push({ bucket, passed, total: cases.length, pct: (accuracy * 100).toFixed(1), target: `${target * 100}%` });

        if (failures.length > 0) {
          // Print every miss — the plan requires reporting each failure with its
          // reason, not just a percentage.
          console.log(`\n  ✖ ${bucket} misses:`);
          for (const f of failures) {
            console.log(`    ${f.id} "${f.text}"\n      want ${JSON.stringify(f.want)}\n      got  ${JSON.stringify(f.got)}`);
          }
        }
        assert.ok(
          accuracy >= target,
          `${bucket}: ${passed}/${cases.length} = ${(accuracy * 100).toFixed(1)}% < target ${target * 100}%`,
        );
      });
    }

    console.log("\n  === Golden Dataset v1 — bucket report ===");
    for (const r of report) {
      console.log(`  ${r.bucket.padEnd(12)} ${String(r.passed).padStart(3)}/${String(r.total).padEnd(3)} = ${r.pct.padStart(5)}%  (target ${r.target})`);
    }
    console.log(`  total cases: ${total}\n`);
  } finally {
    nlp.child.kill();
  }
});
