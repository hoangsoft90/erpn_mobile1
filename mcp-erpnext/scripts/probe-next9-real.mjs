/**
 * next9 — REAL-ERPNext verification (prompt-1 §17), READ-ONLY.
 *
 * What must hold on the real site (not the mock): a sentence that NAMES a
 * customer binds THAT customer's id, and one that names nobody / an absent name
 * binds nothing — remembered state must not leak a different party in.
 *
 * Read-only: only list/read tools and /ask. No /execute, no write, no test data
 * is created on the site. Exit codes: 0 = all checks pass, 2 = env/target
 * missing (run from mcp-erpnext/ with ../.env present), 3 = a check failed
 * (print the evidence), 4 = probe error.
 *
 * Run: cd mcp-erpnext && node scripts/probe-next9-real.mjs
 */
const REPO = new URL("..", import.meta.url).pathname;
process.chdir(REPO);

const { readFileSync } = await import("node:fs");
const { spawn } = await import("node:child_process");
const path = await import("node:path");

// ── 1. load ../.env into process.env (values never printed) ───────────────────
try {
  for (const line of readFileSync(path.resolve(REPO, "..", ".env"), "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
} catch {
  console.error("EXIT 2: no ../.env (need ERPNEXT_URL / ERPNEXT_API_KEY / ERPNEXT_API_SECRET)");
  process.exit(2);
}
for (const k of ["ERPNEXT_URL", "ERPNEXT_API_KEY", "ERPNEXT_API_SECRET"]) {
  if (!process.env[k]) {
    console.error(`EXIT 2: missing ${k}`);
    process.exit(2);
  }
}

// ── 2. the real Python NLP bridge on an ephemeral port ────────────────────────
const nlp = spawn("python3", ["-m", "nlp_service.server", "--port", "0"], {
  cwd: path.resolve(REPO, ".."),
  stdio: ["ignore", "pipe", "inherit"],
});
const nlpPort = await new Promise((resolve, reject) => {
  nlp.stdout.on("data", (d) => {
    const m = String(d).match(/"port":\s*(\d+)/);
    if (m) resolve(Number(m[1]));
  });
  setTimeout(() => reject(new Error("nlp: no ready line in 5s")), 5000);
});

const { __setNlpServicePortForTest, __sessionContext, __resetSessionContext } =
  await import("../src/copilot-server.mjs");
__setNlpServicePortForTest(nlpPort);
// .env carries ASK_USER/ASK_PASSWORD for the real tunnel bind; this probe binds
// loopback only, and the bind policy refuses credentials on loopback — drop
// them for THIS process (they are never used to reach ERPNext).
delete process.env.ASK_USER;
delete process.env.ASK_PASSWORD;
const { createAskServer } = await import("../src/http-ask.mjs");
const server = createAskServer({ port: 0, host: "127.0.0.1" });
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;

const ask = async (text) => {
  const r = await fetch(`${base}/ask`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
  const body = await r.json();
  return body.result ?? body;
};

// ── 3. discovery on the REAL master: one exact customer name + outstanding ────
const { createMcpClient } = await import("../src/client.mjs");
const { pickServerScript } = await import("../src/copilot-server.mjs");
const { findCustomer } = await import("../src/skills/customer.mjs");
const mcp = createMcpClient({ serverScript: pickServerScript() });
// registerIds mutates the `knownIds` set — a real Set, never null.
const all = (await findCustomer(mcp, "", new Set()))?.data?.data ?? [];
const named = all.filter((c) => (c.customer_name ?? c.name ?? "").trim().length >= 4 && c.disabled === 0);
if (named.length === 0) {
  console.error("EXIT 3: no readable customer on the real site to probe with");
  server.close();
  nlp.kill();
  process.exit(3);
}
// A SHORT fragment is not required here: we probe with the FULL display name
// (exact match), which is the realistic sentence an owner would say.
const target = named[0];
const targetName = target.customer_name ?? target.name;
const targetId = target.name;
// A name that matches nobody — built to be unlikely on any site.
const absent = "Khách Không Tồn Tại Next9";

console.log(`T0 erp_target = ${process.env.COPILOT_MOCK_OK ? "MOCK(forced)" : "REAL"} (${all.length} customers readable)`);
console.log(`   probe target: "${targetName}" (${targetId})`);

const checks = [];
const check = (id, ok, detail) => {
  checks.push({ id, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${id} — ${detail}`);
};

try {
  // T1 — a fresh process names a real customer: binds HER id.
  __resetSessionContext();
  const t1 = await ask(`công nợ của ${targetName}`);
  const bound1 = t1?.customer?.id ?? t1?.customer?.name ?? t1?.customer ?? null;
  check(
    "T1 exact read binds the named customer",
    bound1 === targetId,
    `bound=${JSON.stringify(bound1)} expected=${targetId} error_code=${t1?.error_code ?? "none"}`,
  );

  // T2 — an ABSENT name, while T1's memory is still warm: binds NOTHING.
  const t2 = await ask(`thu tiền ${absent} 10000`);
  const bound2 = t2?.proposal?.entity?.id ?? (t2?.customer && typeof t2?.customer === "object" ? t2.customer.id : t2?.customer) ?? null;
  check(
    "T2 absent name binds nothing (no context fallback)",
    t2?.proposal == null && bound2 == null && !!t2?.error_code,
    `proposal=${JSON.stringify(t2?.proposal ?? null)} bound=${JSON.stringify(bound2)} error_code=${t2?.error_code ?? "none"}`,
  );

  // T3 — the memory must never inject a DIFFERENT party into a supplier ask.
  const t3 = await ask("tồn kho cám");
  const leak = JSON.stringify(t3 ?? {}).includes("CUST-");
  check(
    "T3 unrelated read carries no customer binding",
    !leak,
    `customer fields in an inventory answer: ${leak ? "PRESENT (leak)" : "none"}`,
  );

  const failed = checks.filter((c) => !c.ok);
  console.log(`\nNEXT9 REAL PROBE: ${failed.length === 0 ? "PASS" : "FAIL"} (${checks.filter((c) => c.ok).length}/${checks.length})`);
  server.close();
  nlp.kill();
  process.exit(failed.length === 0 ? 0 : 3);
} catch (err) {
  console.error("EXIT 4: probe error:", err?.message ?? err);
  server.close();
  nlp.kill();
  process.exit(4);
}
