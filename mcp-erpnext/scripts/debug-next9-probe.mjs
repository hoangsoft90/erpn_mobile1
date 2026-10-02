/**
 * next9 DEBUG probe — cross-turn state contamination (plan-debug.md).
 *
 * Simulates the incident against ONE server instance (the same in-memory state
 * a real deployment keeps) and lets us isolate each hypothesis:
 *
 *   Turn 0  an EARLIER read of a customer (seeds the session context)
 *   Turn 1  "thêm khách Lê Lợi" → /ask (proposal) → /execute (CUST-M001 created)
 *   Turn 2  "thu tiền Lê lợi 10000"            ← THE INCIDENT
 *
 * Modes (argv[2]):
 *   same-process  Turn0 → Turn1 → Turn2           (default; the repro)
 *   reset         ... then clear the session store and run Turn2 (simulates the
 *                 gateway process restarting)
 *   fresh         no Turn0 at all; Turn1 → Turn2  (a session that never talked
 *                 about the other customer)
 *
 * argv[1] is Turn 0's sentence; "-" skips Turn 0.
 * Reports what Turn 2 resolved vs what it BOUND. NO app code is changed here.
 * Run: node scripts/debug-next9-probe.mjs ["<turn0>"|-] [mode]
 */
process.env.COPILOT_MOCK_OK = process.env.COPILOT_MOCK_OK ?? "1";

const REPO = new URL("..", import.meta.url).pathname;
process.chdir(REPO);

const { spawn } = await import("node:child_process");
const { mkdtempSync, rmSync } = await import("node:fs");
const { tmpdir } = await import("node:os");
const path = await import("node:path");
const { randomUUID } = await import("node:crypto");

const turn0Text = process.argv[2] ?? "công nợ của Nguyễn Thị Lan";
const mode = process.argv[3] ?? "same-process";

// Real Python NLP (port 0 = ephemeral, prints the port as JSON).
const child = spawn("python3", ["-m", "nlp_service.server", "--port", "0"], {
  cwd: path.resolve(REPO, ".."),
  stdio: ["ignore", "pipe", "inherit"],
});
const nlpPort = await new Promise((resolve, reject) => {
  child.stdout.on("data", (d) => {
    const m = String(d).match(/"port":\s*(\d+)/);
    if (m) resolve(Number(m[1]));
  });
  setTimeout(() => reject(new Error("nlp: no ready line in 5s")), 5000);
});

const { __setNlpServicePortForTest, __sessionContext, __resetSessionContext } =
  await import("../src/copilot-server.mjs");
__setNlpServicePortForTest(nlpPort);

const stateDir = mkdtempSync(path.join(tmpdir(), "next9-debug-"));
process.env.MOCK_ERP_STATE = path.join(stateDir, "mock-erp.json");

const { createAskServer } = await import("../src/http-ask.mjs");
const { IdempotencyStore } = await import("../src/idempotency.mjs");
const store = new IdempotencyStore(stateDir);
const server = createAskServer({ port: 0, host: "127.0.0.1", idemStore: store });
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;

// NOTE: the app's classic /ask NEVER sends conversation_id (copilot_api_client
// .ask has no such parameter), so the gateway scopes context to
// `<user>\u0000default` — one namespace for the whole process. We mirror that.
const ask = async (text, extra = {}) => {
  const r = await fetch(`${base}/ask`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text, ...extra }),
  });
  return { status: r.status, body: await r.json() };
};

const showCtx = (label) => {
  const entries = [...__sessionContext().entries.entries()].map(([k, v]) => ({
    key: k.replace("\u0000", " | "),
    value: v.value,
    name: v.name,
    provenance: v.provenance,
  }));
  console.log(`--- session context ${label}: ${JSON.stringify(entries)}`);
};

console.log(`=== mode=${mode} turn0=${JSON.stringify(turn0Text)} ===`);

if (mode !== "fresh" && turn0Text !== "-") {
  const t0 = await ask(turn0Text);
  const r0 = t0.body?.result ?? {};
  console.log(
    "Turn 0 →",
    JSON.stringify({
      status: t0.status,
      error_code: r0.error_code ?? null,
      customer: r0.customer ?? null,
    }),
  );
  showCtx("after Turn 0");
}

const t1 = await ask("thêm khách Lê Lợi");
const proposal1 = t1.body?.result?.proposal ?? null;
console.log(
  "Turn 1 →",
  JSON.stringify({
    status: t1.status,
    has_proposal: Boolean(proposal1),
    action: proposal1?.action ?? null,
    entity: proposal1?.entity ?? null,
  }),
);
showCtx("after Turn 1");

const e1 = await fetch(`${base}/execute`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ command_id: randomUUID(), proposal: proposal1 }),
}).then((r) => r.json());
const leLoiDoc = e1?.result?.erpnext_doc ?? null;
console.log("Turn 1 confirm →", JSON.stringify({ ok: e1.ok ?? null, doc: leLoiDoc }));

if (mode === "reset") {
  __resetSessionContext();
  showCtx("after simulated gateway restart");
}

const turn2Text = process.env.TURN2 ?? "thu tiền Lê lợi 10000";
const t2 = await ask(turn2Text);
const r2 = t2.body?.result ?? {};
const p2 = r2.proposal ?? null;
console.log(
  "Turn 2 →",
  JSON.stringify(
    {
      status: t2.status,
      error_code: r2.error_code ?? null,
      resolved_customer: r2.customer ?? null,
      proposal_entity: p2?.entity ?? null,
      answer: String(r2.answer ?? "").slice(0, 120),
      reason: String(r2.reason ?? "").slice(0, 120),
    },
    null,
    1,
  ),
);

const bound = p2?.entity?.id ?? r2.customer?.id ?? null;
const resolved = r2.customer?.id ?? null;
console.log("=== VERDICT ===");
console.log(`created customer doc : ${leLoiDoc}`);
console.log(`turn-2 RESOLVED party: ${resolved}`);
console.log(`turn-2 BOUND party   : ${bound}`);
console.log(
  bound && bound === resolved && bound === leLoiDoc
    ? "✔ TURN 2 USED THE CUSTOMER THE SENTENCE NAMED"
    : bound && bound !== resolved
      ? `✘ CONTAMINATION: the sentence named ${resolved} but the WRITE bound ${bound}`
      : "? inconclusive — read the JSON above",
);

server.close();
child.kill();
rmSync(stateDir, { recursive: true, force: true });
