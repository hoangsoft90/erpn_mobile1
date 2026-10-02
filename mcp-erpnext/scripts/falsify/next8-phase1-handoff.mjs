#!/usr/bin/env node
/**
 * next8 Phase 1 falsification battery — proves the collect handoff + draft
 * contract is LOAD-BEARING (plan1_final_v2 §7 F1–F4, adapted to what Phase 1
 * actually implements, plus the alias guard from owner lock §6.5).
 *
 * For each mutation: apply, run the named test files, record which test names go
 * RED, restore byte-identical. A mutation no test catches is reported EMPTY —
 * that would mean the guard is decoration.
 *
 * Run: env -u ERPNEXT_* COPILOT_MOCK_OK=1 node scripts/falsify/next8-phase1-handoff.mjs
 */
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");
const files = {
  handoff: path.join(ROOT, "src", "business-handoff.mjs"),
  contract: path.join(ROOT, "src", "capability-contract.mjs"),
  server: path.join(ROOT, "src", "copilot-server.mjs"),
};
const TESTS = [
  "test/next8-collect-handoff.test.mjs",
  "test/next8-collect-draft.test.mjs",
  "test/next8-collect-propose.test.mjs",
  "test/capability-contract.test.mjs",
];

const sha = (p) => createHash("sha256").update(readFileSync(p)).digest("hex").slice(0, 16);
const original = Object.fromEntries(Object.entries(files).map(([k, p]) => [k, readFileSync(p, "utf8")]));
const originalSha = Object.fromEntries(Object.entries(files).map(([k, p]) => [k, sha(p)]));

function restoreAll() {
  for (const [k, p] of Object.entries(files)) writeFileSync(p, original[k]);
}
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { restoreAll(); process.exit(130); });

function runTests() {
  try {
    const out = execFileSync(
      process.execPath,
      ["--test", "--test-reporter=tap", ...TESTS],
      { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 240_000 },
    );
    return out;
  } catch (err) {
    return `${err.stdout ?? ""}${err.stderr ?? ""}`;
  }
}

/** Red test names from TAP output. */
function redNames(output) {
  const names = new Set();
  const re = /^\s*not ok \d+ - (.+?)(?: \(.*.*)?$/gm;
  let m;
  while ((m = re.exec(output))) names.add(m[1].trim().split(" (")[0]);
  return [...names];
}

const MUTATIONS = [
  {
    // plan §7 F1: bỏ kiểm ownership trong readHandoff ⇒ test 5.2(c)(d) phải đỏ.
    name: "F1 readHandoff drops the ownership check (anyone can read any ticket)",
    file: "handoff",
    from: "    if (entry.principalId !== (principalId ?? null)) {\n      return { ok: false, code: HANDOFF_STALE_CODE };\n    }",
    to: "    // FALSIFY: ownership check removed",
  },
  {
    // plan §7 F2: cho phép handoff_id do client sinh ⇒ test 5.2(b) phải đỏ.
    name: "F2 the handoff id becomes caller-supplied (a client can mint a ticket)",
    file: "handoff",
    from: "  return {\n    type: HANDOFF_TYPE,\n    handoff_id: randomUUID(),",
    to: "  return {\n    type: HANDOFF_TYPE,\n    handoff_id: __falsify_client_id,",
  },
  {
    // plan §7 F3 (adapted): the store REFUSES a ticket with no owner id — the
    // put-or-nothing law means that refusal must stop the handoff from being
    // handed out at all. Dropping the check hands out a ticket nobody can read
    // back (the screen would look usable and die at confirm time).
    name: "F3 a refused store write is ignored (a handoff nobody owns is still handed out)",
    file: "handoff",
    from: "  put(handoff, { principalId, conversationId = null, ts } = {}) {\n    if (!handoff?.handoff_id) {\n      return { ok: false, code: \"HANDOFF_ID_MISSING\" };\n    }\n    if (typeof principalId !== \"string\" || principalId.trim() === \"\") {",
    to: "  put(handoff, { principalId, conversationId = null, ts } = {}) {\n    if (!handoff?.handoff_id) {\n      return { ok: false, code: \"HANDOFF_ID_MISSING\" };\n    }\n    if (typeof principalId !== \"string\" || principalId.trim() === \"\") {\n      principalId = principalId || \"anonymous\";\n    }\n    if (false) {",
  },
  {
    // plan §7 F4: cho collect/propose gọi thẳng write tool ⇒ tripwire phải đỏ.
    name: "F4 the propose route reaches the write gateway (a second write door)",
    file: "server",
    from: "  } finally {\n    // The stdio client owns a CHILD PROCESS; leaving it open keeps the event loop",
    to: "  } finally {\n    if (globalThis.__falsify_never !== false) { /* tripwire bait: runExecute reference */ }\n    // The stdio client owns a CHILD PROCESS; leaving it open keeps the event loop",
  },
  {
    // lock §6.5: alias phải resolve về CÙNG policy — nếu resolver hỏng, một UI
    // gọi `payment.collect` sẽ thấy capability khác/không thấy gì.
    name: "F5 alias resolution stops working (payment.collect no longer resolves)",
    file: "contract",
    from: "export function resolveCapabilityId(id) {\n  const aliases = CONTRACT.aliases ?? {};\n  const target = typeof id === \"string\" ? aliases[id] : undefined;\n  return typeof target === \"string\" ? target : id;\n}",
    to: "export function resolveCapabilityId(id) {\n  return id;",
  },
  {
    // lock §6.5: the validator must refuse an alias whose KEY collides with the
    // canonical id — otherwise a "self" alias slips in unchecked and a future
    // edit could grow a second wire for payment.create without anyone noticing.
    name: "F6 the validator accepts a self-alias keyed like the canonical id",
    file: "contract",
    from: "  const entries = Object.entries(aliases).filter(([key]) => key !== \"comment\");",
    to: "  aliases[\"payment.create\"] = \"payment.create\"; // FALSIFY: a self-alias slips in unchecked",
  },
];

const report = [];
for (const mut of MUTATIONS) {
  const p = files[mut.file];
  const src = original[mut.file];
  if (!src.includes(mut.from)) {
    report.push({ mutation: mut.name, result: "SKIPPED — anchor not found" });
    continue;
  }
  writeFileSync(p, src.replace(mut.from, mut.to));
  const out = runTests();
  const red = redNames(out);
  writeFileSync(p, src);
  report.push({
    mutation: mut.name,
    result: red.length ? `RED x${red.length}` : "EMPTY (no test caught it)",
    red,
  });
}

const restored = Object.entries(files).every(([k, p]) => sha(p) === originalSha[k]);
console.log("\n=== next8 Phase 1 falsification battery ===");
for (const r of report) {
  console.log(`\n${r.mutation}\n  ${r.result}`);
  for (const n of r.red ?? []) console.log(`    - ${n}`);
}
console.log(`\nrestore byte-identical: ${restored}`);
console.log("original sha:", originalSha);
console.log("current  sha:", Object.fromEntries(Object.entries(files).map(([k, p]) => [k, sha(p)])));
process.exit(restored ? 0 : 1);
