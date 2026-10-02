/**
 * probe-next8-real.mjs — READ-ONLY proof of next8 (entity selection loop)
 * against the REAL ERPNext (no mock, no LLM, no write).
 *
 * Why it exists: `.plan/next8/next8-final-result.md` §G records the REAL probe as
 * the ONE acceptance item still open — the mock suites prove the contract, only
 * real data proves the shop's own master list behaves the same way. This script
 * closes that gap with one command, and it is deliberately incapable of writing:
 *
 *   the only endpoint this file calls is `/ask`; it never POSTs a confirmation
 *   (grep this file for the exe-cute path: zero hits), so no proposal can be
 *   confirmed and no document can be created by it.
 *
 * What it proves, in order:
 *   T0  the process really talks to REAL ERPNext (`erp_target === "REAL"`)
 *   D   discovery: an ambiguous supplier fragment EXISTING IN THE REAL MASTER
 *       (searched, not guessed — if the data has no ambiguity the probe says so
 *       and exits 3 rather than inventing a scenario)
 *   T1  that fragment ⇒ AMBIGUOUS picker, `picker_total` ≥ shown, ≤ 10 chips
 *   T2  same sentence + `entity_id` = a shown chip ⇒ that supplier RESOLVES and
 *       the picker does NOT come back (the D0 loop, byte-for-byte the incident)
 *   T3  a bogus `entity_id` ⇒ ENTITY_PICK_STALE (hint-not-authority), no bind
 *
 * Env: reads `.env` in the repo root for the THREE ERPNEXT_* keys. Values are
 * never printed — only the key names and whether they are set.
 *
 * Usage:  node scripts/probe-next8-real.mjs            (from mcp-erpnext/)
 * Exit:   0 = T1+T2 pass · 1 = a case failed · 2 = not configured/target not
 *         REAL · 3 = the real data offers no ambiguous fragment to test with.
 */

process.chdir(new URL("..", import.meta.url).pathname);

const { readFileSync, existsSync } = await import("node:fs");
const { spawn } = await import("node:child_process");
const path = await import("node:path");

// ── 1. load .env (names only ever printed) ──────────────────────────────────
const ENV_KEYS = ["ERPNEXT_URL", "ERPNEXT_API_KEY", "ERPNEXT_API_SECRET", "COPILOT_COMPANY"];
const envPath = path.resolve("..", ".env");
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    const [, key, raw] = m;
    if (!ENV_KEYS.includes(key)) continue;
    if (process.env[key] !== undefined) continue; // an explicit shell value wins
    process.env[key] = raw.replace(/^["']|["']$/g, "");
  }
}
// A mock run must be impossible by accident: this probe is REAL or nothing.
delete process.env.COPILOT_MOCK_OK;

const present = ENV_KEYS.filter((k) => process.env[k]);
console.log(`env: ${present.map((k) => `${k}=set`).join(" · ") || "(none)"}`);
const missing = ["ERPNEXT_URL", "ERPNEXT_API_KEY", "ERPNEXT_API_SECRET"].filter(
  (k) => !process.env[k],
);
if (missing.length > 0) {
  console.error(`ABORT: REAL probe needs all three — missing: ${missing.join(", ")}`);
  process.exit(2);
}

// ── 2. the Python NLP bridge (real, ephemeral port) ─────────────────────────
const nlp = spawn("python3", ["-m", "nlp_service.server", "--port", "0"], {
  cwd: path.resolve(".."),
  stdio: ["ignore", "pipe", "inherit"],
});
const nlpPort = await new Promise((resolve, reject) => {
  nlp.stdout.on("data", (d) => {
    const m = String(d).match(/"port":\s*(\d+)/);
    if (m) resolve(Number(m[1]));
  });
  nlp.on("exit", (c) => reject(new Error(`nlp exited early (${c})`)));
  setTimeout(() => reject(new Error("nlp: no ready line in 8s")), 8000);
});

const { __setNlpServicePortForTest } = await import("../src/copilot-server.mjs");
__setNlpServicePortForTest(nlpPort);
const { createAskServer } = await import("../src/http-ask.mjs");
const server = createAskServer({ port: 0, host: "127.0.0.1" });
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;

const ask = async (text, entityId) => {
  const body = { text };
  if (entityId) body.entity_id = entityId;
  const r = await fetch(`${base}/ask`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await r.json();
  return { status: r.status, erpTarget: json.erp_target, r: json.result ?? {} };
};

// ── 3. T0 — is this really REAL? ────────────────────────────────────────────
const t0 = await ask("tồn kho cám");
console.log(`T0 erp_target = ${t0.erpTarget} (status ${t0.status})`);
if (t0.erpTarget !== "REAL") {
  console.error(`ABORT: erp_target is ${t0.erpTarget} — this is not a REAL run`);
  server.close();
  nlp.kill();
  process.exit(2);
}

// ── 4. discovery: find an ambiguous fragment in the REAL supplier master ────
const { createMcpClient } = await import("../src/client.mjs");
const { pickServerScript } = await import("../src/copilot-server.mjs");
const { findSupplier } = await import("../src/skills/purchasing.mjs");
const mcp = createMcpClient({ serverScript: pickServerScript() });
await mcp.initialize();
const rows = (await findSupplier(mcp, {}, null))?.data?.data ?? [];
await mcp.close();
console.log(`D  read ${rows.length} suppliers from REAL ERPNext`);

/** Fragments to try, derived from the data: tokens shared by 2+ names first. */
const fragments = [];
const byToken = new Map();
for (const row of rows) {
  const name = String(row.supplier_name ?? row.name ?? "");
  for (const tok of name.toLowerCase().split(/\s+/)) {
    if (tok.length < 3) continue;
    if (!byToken.has(tok)) byToken.set(tok, new Set());
    byToken.get(tok).add(row.name);
  }
}
for (const [tok, set] of [...byToken.entries()].sort((a, b) => b[1].size - a[1].size)) {
  if (set.size >= 2 && set.size <= 8) fragments.push(tok);
  if (fragments.length >= 5) break;
}

let t1 = null;
let usedFragment = null;
for (const frag of fragments) {
  const res = await ask(`nhà cung cấp ${frag}`);
  const chips = res.r.candidates ?? [];
  if (chips.length >= 2) {
    t1 = res;
    usedFragment = frag;
    break;
  }
}
if (!t1) {
  console.log(
    "D  RESULT: no ambiguous supplier fragment found in the real master " +
      `(tried: ${fragments.join(", ") || "(none — no shared token)"})`,
  );
  console.log("   ⇒ T1/T2/T3 SKIPPED — real data offers no ambiguity to test with.");
  console.log("   (next8's picker path cannot be exercised on this dataset; the mock");
  console.log("    suites in test/next8-*.test.mjs remain the only evidence for it.)");
  server.close();
  nlp.kill();
  process.exit(3);
}

// ── 5. T1 — the picker is offered, bounded, with a TRUE total ───────────────
const chips = t1.r.candidates ?? [];
const t1ok =
  chips.length >= 2 &&
  chips.length <= 10 &&
  (t1.r.picker_total ?? chips.length) >= chips.length &&
  Boolean(t1.r.error_code);
console.log(
  `T1 "${usedFragment}" → ${t1.r.error_code} · chips=${chips.length} · ` +
    `picker_total=${t1.r.picker_total} · picker_more=${t1.r.picker_more ?? 0} → ${t1ok ? "PASS" : "FAIL"}`,
);
console.log(`   chip[0] = ${chips[0]?.id} (${chips[0]?.label ?? chips[0]?.name})`);

// ── 6. T2 — the pick resolves THAT supplier and never re-offers the picker ──
const pickedId = chips[0]?.id;
const t2 = await ask(`nhà cung cấp ${usedFragment}`, pickedId);
const t2ok = t2.r.supplier?.id === pickedId && (t2.r.candidates ?? []).length === 0;
console.log(
  `T2 pick ${pickedId} → supplier=${t2.r.supplier?.id ?? "(none)"} · ` +
    `candidates=${(t2.r.candidates ?? []).length} · error_code=${t2.r.error_code ?? "none"} → ${t2ok ? "PASS" : "FAIL"}`,
);
if (t2.r.answer) console.log(`   answer: ${String(t2.r.answer).slice(0, 140)}`);

// ── 7. T3 — an id the fresh list does not hold is REFUSED, not guessed ──────
const t3 = await ask(`nhà cung cấp ${usedFragment}`, "SUP-PROBE-GONE-9999");
const t3ok =
  t3.r.error_code === "ENTITY_PICK_STALE" &&
  !t3.r.supplier &&
  (t3.r.candidates ?? []).length >= 2;
console.log(
  `T3 bogus id → ${t3.r.error_code} · supplier=${t3.r.supplier?.id ?? "(none)"} · ` +
    `fresh chips=${(t3.r.candidates ?? []).length} → ${t3ok ? "PASS" : "FAIL"}`,
);

server.close();
nlp.kill();

const allOk = t1ok && t2ok;
console.log("\n=== VERDICT ===");
console.log(`T1 picker      : ${t1ok ? "PASS" : "FAIL"}`);
console.log(`T2 no loop     : ${t2ok ? "PASS" : "FAIL"}`);
console.log(`T3 stale refuse: ${t3ok ? "PASS" : "FAIL"} (guard, not required for the loop verdict)`);
console.log(allOk ? "REAL-SERVER PROBE: PASS (next8 loop does not exist on real data)" : "REAL-SERVER PROBE: FAIL — xem chi tiết ở trên");
process.exit(allOk ? 0 : 1);
