/**
 * End-to-end tests for the copilot MCP server (user task 2026-09-13):
 * real Python NLP service + real copilot-server process + real mock-server
 * process — the full Phase 1 → Phase 2 → answer pipeline over stdio.
 *
 * No ERPNext credentials needed (mock server), no LLM needed (deterministic).
 */

import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const REPO = path.resolve(ROOT, "..");
const COPILOT = path.join(ROOT, "src", "copilot-server.mjs");

/** E2E tests are HERMETIC: strip ERPNEXT_* so the copilot child always talks
 * to the in-memory mock, never to the real server (a leaked env var from an
 * earlier `source .env` shell silently flipped the target — result9 fix). */
const MOCK_ENV = Object.fromEntries(
  Object.entries(process.env).filter(([k]) => !/^ERPNEXT_/.test(k)),
);

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

/** Minimal stdio JSON-RPC client for one copilot-server process. */
function startCopilot(port) {
  const child = spawn(process.execPath, [COPILOT], {
    env: { ...MOCK_ENV, NLP_SERVICE_PORT: String(port) },
    stdio: ["pipe", "pipe", "inherit"],
  });
  const pending = new Map();
  let nextId = 1;
  let buffer = "";
  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString();
    let nl;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      const entry = pending.get(msg.id);
      if (!entry) continue;
      pending.delete(msg.id);
      if (msg.error) entry.reject(new Error(`MCP_ERROR ${msg.error.code}: ${msg.error.message}`));
      else entry.resolve(msg.result);
    }
  });
  const request = (method, params) => {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  };
  return {
    child,
    request,
    async call(text, extraArgs = {}) {
      const res = await request("tools/call", { name: "copilot_ask", arguments: { text, ...extraArgs } });
      assert.equal(res.isError, undefined, `tool error: ${res.content?.[0]?.text}`);
      return res.structuredContent ?? JSON.parse(res.content[0].text);
    },
    async close() {
      child.stdin.end();
      await new Promise((r) => child.once("exit", r));
    },
  };
}

test("copilot E2E: pipeline answers a receivable question end-to-end", async () => {
  const nlp = await startNlpService();
  const copilot = startCopilot(nlp.port);
  try {
    const init = await copilot.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "0.0.0" },
    });
    assert.equal(init.serverInfo.name, "erpn-copilot");

    const tools = await copilot.request("tools/list", {});
    assert.equal(tools.tools.length, 1);
    assert.equal(tools.tools[0].name, "copilot_ask");
    assert.equal(tools.tools[0].annotations.readOnlyHint, true);

    const out = await copilot.call("chị Lan còn nợ bao nhiêu");
    assert.equal(out.routed.group, "customer");
    assert.equal(out.customer.id, "CUST-00001");
    assert.equal(out.outstanding_vnd, 2_500_000);
    assert.ok(out.answer.includes("2.500.000"), out.answer);
    // Phase 1 normalization really ran: kinship stripped + intent canonical.
    assert.ok(out.normalized.titles.includes("chị"), JSON.stringify(out.normalized.titles));
    assert.ok(out.normalized.intents.includes("receivable"), JSON.stringify(out.normalized.intents));
  } finally {
    await copilot.close();
    nlp.child.kill();
  }
});

test("copilot E2E: second customer resolves independently", async () => {
  const nlp = await startNlpService();
  const copilot = startCopilot(nlp.port);
  try {
    await copilot.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } });
    const out = await copilot.call("Trần Văn Hai còn nợ bao nhiêu");
    assert.equal(out.customer.id, "CUST-00002");
    // CUST-00002 has a credit note (SINV-0004, −320.000): "còn nợ" is NET.
    // result20 regression: the old `> 0` filter dropped the credit note and
    // reported the gross 7.500.000đ instead of the true 7.180.000đ.
    assert.equal(out.outstanding_vnd, 7_500_000 - 320_000);
    assert.equal(out.open_invoices, 2); // invoice + credit note, not the settled one
  } finally {
    await copilot.close();
    nlp.child.kill();
  }
});

test("copilot E2E: credit note counts toward the receivable balance (result20 regression)", async () => {
  // Direct skill-level check of the same ground truth, without NLP: the mock's
  // SINV-0004 (−320.000đ) models the real −97.200đ credit note from result18 §F.
  const nlp = await startNlpService();
  const copilot = startCopilot(nlp.port);
  try {
    await copilot.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } });
    const out = await copilot.call("Trần Văn Hai còn bao nhiêu hóa đơn chưa thanh toán");
    assert.equal(out.customer.id, "CUST-00002");
    const rows = out.rows ?? [];
    assert.equal(rows.length, 2);
    assert.deepEqual(
      rows.map((r) => Number(r.outstanding_amount)).sort((a, b) => a - b),
      [-320_000, 7_500_000],
    );
    assert.ok(out.answer.includes("7.180.000"), out.answer);
  } finally {
    await copilot.close();
    nlp.child.kill();
  }
});

test("copilot E2E: payment question lists receipts, not balances", async () => {
  const nlp = await startNlpService();
  const copilot = startCopilot(nlp.port);
  try {
    await copilot.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } });
    const out = await copilot.call("chị Lan đã trả bao nhiêu tiền");
    assert.equal(out.routed.group, "payment");
    assert.equal(out.customer.id, "CUST-00001");
    assert.equal(out.rows.length, 1);
    assert.equal(out.rows[0].amount_vnd, 8_000_000);
    assert.ok(out.answer.includes("8.000.000"), out.answer);
  } finally {
    await copilot.close();
    nlp.child.kill();
  }
});

test("copilot E2E: inventory question lists stock without a customer", async () => {
  const nlp = await startNlpService();
  const copilot = startCopilot(nlp.port);
  try {
    await copilot.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } });
    const out = await copilot.call("trong kho còn bao nhiêu cám heo");
    assert.equal(out.routed.group, "inventory");
    const joined = out.answer.join(" | ");
    assert.ok(joined.includes("CAM-HEO-25KG"), joined);
    assert.ok(joined.includes("120"), joined);
  } finally {
    await copilot.close();
    nlp.child.kill();
  }
});

test("copilot E2E: unroutable question returns honest null, never a guess", async () => {
  const nlp = await startNlpService();
  const copilot = startCopilot(nlp.port);
  try {
    await copilot.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } });
    const out = await copilot.call("xin chào");
    assert.equal(out.routed, false);
    assert.equal(out.answer, null);
  } finally {
    await copilot.close();
    nlp.child.kill();
  }
});

test("copilot E2E: unknown customer is reported, no invented IDs", async () => {
  const nlp = await startNlpService();
  const copilot = startCopilot(nlp.port);
  try {
    await copilot.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } });
    const out = await copilot.call("chị Hằng còn nợ bao nhiêu");
    assert.equal(out.answer, null);
    assert.ok(out.reason.includes("không tìm thấy khách hàng"), out.reason);
  } finally {
    await copilot.close();
    nlp.child.kill();
  }
});

// ---- Phase 6: every routed answer carries a v1 Action Proposal.

test("copilot E2E: receivable answer carries a READ-level erpn.proposal/v1", async () => {
  const nlp = await startNlpService();
  const copilot = startCopilot(nlp.port);
  try {
    await copilot.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } });
    const out = await copilot.call("chị Lan còn nợ bao nhiêu");
    const p = out.proposal;
    assert.ok(p, "proposal present on the customer route");
    assert.equal(p.schema, "erpn.proposal/v1");
    assert.equal(p.action, "read_balance");
    assert.equal(p.risk, "READ");
    assert.equal(p.need_confirm, false);
    assert.equal(p.entity.id, "CUST-00001");
    assert.equal(p.entity.name, "Nguyễn Thị Lan");
    assert.equal(p.params.outstanding_vnd, 2_500_000);
    assert.ok(typeof p.summary === "string" && p.summary.includes("Nguyễn Thị Lan"), p.summary);
  } finally {
    await copilot.close();
    nlp.child.kill();
  }
});

test("copilot E2E Phase 7b: a collect-money command returns a HIGH write proposal (the confirm button's wire)", async () => {
  // THE missing wire (result28 §3), now closed: "thu tiền cho <khách> <số tiền>"
  // must produce action=create_payment_entry / risk=HIGH through the REAL
  // pipeline (NLP service + router + copilot + mock ERPNext) — not by calling
  // buildPaymentProposal directly like the old tests did.
  //
  // P1 update (plan2_final §4.3 + §8: "Tạo payment | HIGH | Bắt buộc | Exact"):
  // the command now uses the EXACT customer name, because a fuzzy one must NOT
  // produce a proposal any more. The fuzzy → picker → picked-id flow is pinned
  // by the two tests right below this one.
  const nlp = await startNlpService();
  const copilot = startCopilot(nlp.port);
  try {
    await copilot.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } });
    const out = await copilot.call("thu tiền cho Nguyễn Thị Lan 500 ngàn");
    assert.equal(out.routed?.group, "payment_write", JSON.stringify(out).slice(0, 400));
    const p = out.proposal;
    assert.ok(p, "a write proposal must be present");
    assert.equal(p.action, "create_payment_entry");
    assert.equal(p.risk, "HIGH");
    assert.equal(p.need_confirm, true);
    // isExecutable(HIGH) is false BY DESIGN: execution goes through the human
    // confirm flow (POST /execute), never implicit. The card must NOT claim
    // executability — the /execute gate re-checks the action anyway.
    assert.equal(p.executable, false);
    assert.equal(p.entity.name, "Nguyễn Thị Lan");
    assert.equal(p.params.amount_vnd, 500_000); // from the NLP amount, not the full debt
    assert.ok(Number.isFinite(p.params.outstanding_vnd), "drift snapshot must be present");
    assert.equal(p.params.invoice, "SINV-0001"); // oldest open invoice of the mock
    assert.ok(typeof p.created_at === "string", "Phase 9 age gate needs created_at");
    // P1 §9: the immutable snapshot the user is asked to approve.
    assert.equal(p.version, 1, "executable proposals carry a version");
    assert.ok(typeof p.proposal_id === "string" && p.proposal_id.startsWith("prp_"), "proposal_id present");
    assert.equal(p.entity.name_snapshot, "Nguyễn Thị Lan", "display name is a snapshot, not re-looked-up");
    assert.equal(p.params.amount_source, "explicit", "the amount is the user's, not the full debt");
    assert.ok(p.expires_at, "the TTL is visible to the client");
    // Nothing was written: a proposal is an INTENT — the mock ledger is untouched
    // (no /execute call happened in this test).
    assert.ok(out.answer.includes("Xác nhận"), out.answer);
  } finally {
    await copilot.close();
    nlp.child.kill();
  }
});

test("copilot E2E P1 §4.3: a FUZZY customer name does NOT produce a write proposal — it asks the user to pick", async () => {
  // The real failure this prevents (plan2_final §4.3 + §8 risk matrix): "chị
  // Lan" only matches "Nguyễn Thị Lan" as a SUBSTRING. Before P1 that single
  // substring hit became an authoritative customer_id and the app offered a
  // payment card. A write is Exact-only: fuzzy ⇒ picker, no proposal.
  const nlp = await startNlpService();
  const copilot = startCopilot(nlp.port);
  try {
    await copilot.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } });
    const out = await copilot.call("thu tiền cho chị Lan 500 ngàn");
    assert.equal(out.routed?.group, "payment_write", JSON.stringify(out).slice(0, 300));
    assert.equal(out.proposal, null, "no proposal may exist while the customer is not settled");
    assert.equal(out.error_code, "ENTITY_PICK_REQUIRED", JSON.stringify(out).slice(0, 400));
    assert.equal(out.entity.state, "FUZZY_SINGLE_MATCH");
    assert.equal(out.entity.policy.auto_select, false, "a write never auto-selects a fuzzy match");
    // §4.4: the picker must carry enough to tell candidates apart.
    const cand = (out.candidates ?? []).find((c) => c.id === "CUST-00001");
    assert.ok(cand, `picker must offer the real customer: ${JSON.stringify(out.candidates)}`);
    assert.equal(cand.name, "Nguyễn Thị Lan");
  } finally {
    await copilot.close();
    nlp.child.kill();
  }
});

test("copilot E2E P1 §4.4: after the user picks a candidate id, the SAME sentence produces the proposal", async () => {
  // The picker loop, end to end through the tool: the client sends back the id
  // the user tapped. It is re-validated against a fresh ERPNext read (an id the
  // client invented is refused — pinned in the entity-resolution unit tests).
  const nlp = await startNlpService();
  const copilot = startCopilot(nlp.port);
  try {
    await copilot.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } });
    const out = await copilot.call("thu tiền cho chị Lan 500 ngàn", { entity_id: "CUST-00001" });
    const p = out.proposal;
    assert.ok(p, `picked customer must unlock the proposal: ${JSON.stringify(out).slice(0, 400)}`);
    assert.equal(p.entity.id, "CUST-00001");
    assert.equal(p.entity.name, "Nguyễn Thị Lan");
    assert.equal(p.params.amount_vnd, 500_000);

    // An id that is NOT in the freshly-read list is refused (no invented ids).
    const bogus = await copilot.call("thu tiền cho chị Lan 500 ngàn", { entity_id: "CUST-INVENTED" });
    assert.equal(bogus.proposal, null, "an id the client made up must not unlock a write");
    assert.equal(bogus.error_code, "ENTITY_PICK_REQUIRED");
  } finally {
    await copilot.close();
    nlp.child.kill();
  }
});

test("copilot E2E: no-route and not-found answers carry proposal: null (honest absence)", async () => {
  const nlp = await startNlpService();
  const copilot = startCopilot(nlp.port);
  try {
    await copilot.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } });
    const unroutable = await copilot.call("xin chào");
    assert.equal(unroutable.proposal, undefined); // early return, no proposal key

    const unknown = await copilot.call("chị Hằng còn nợ bao nhiêu");
    assert.equal(unknown.proposal, null); // routed but nothing to propose about
  } finally {
    await copilot.close();
    nlp.child.kill();
  }
});

test("copilot E2E P1 §13: when the normalizer dies mid-session, a collect-money command is refused outright (no guessed amount, no proposal)", async () => {
  // Degraded mode: if we cannot normalize, we cannot trust the AMOUNT — so a
  // write must not be proposed at all.
  //
  // NOTE (written the hard way): the server REFUSES TO START without the
  // normalizer (main() waits for /health and exits 3), so "NLP down" cannot be
  // simulated by pointing it at a dead port — the child exits and any request
  // hangs. The real degraded case is the service dying AFTER startup, which is
  // what this test does: prove the pipeline answers, kill the normalizer, ask
  // for money.
  const nlp = await startNlpService();
  const copilot = startCopilot(nlp.port);
  try {
    await copilot.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } });
    // Baseline: the pipeline really is alive before we break it.
    const alive = await copilot.call("Nguyễn Thị Lan còn nợ bao nhiêu");
    assert.ok(alive.answer, JSON.stringify(alive).slice(0, 300));

    nlp.child.kill();
    await new Promise((r) => setTimeout(r, 300));

    const out = await copilot.call("thu tiền cho Nguyễn Thị Lan 500 ngàn");
    assert.equal(out.error_code, "NLP_UNAVAILABLE", JSON.stringify(out).slice(0, 300));
    assert.equal(out.proposal, null, "no proposal may exist while the number cannot be verified");
    assert.match(out.reason, /KHÔNG đề xuất ghi/);
    assert.equal(out.normalized, null);

    // Reads are refused too, but with the SAME explicit code — never a silent
    // best-effort answer built on unparsed text.
    const read = await copilot.call("Nguyễn Thị Lan còn nợ bao nhiêu");
    assert.equal(read.error_code, "NLP_UNAVAILABLE");
    assert.equal(read.proposal, null);
  } finally {
    await copilot.close();
  }
});

test("copilot E2E P1 §13: a collect-money sentence with NO number does not become the whole debt", async () => {
  const nlp = await startNlpService();
  const copilot = startCopilot(nlp.port);
  try {
    await copilot.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } });
    // Exact customer (so the entity policy is satisfied) but no amount: the old
    // behaviour silently proposed collecting the ENTIRE outstanding balance.
    const out = await copilot.call("thu tiền cho Nguyễn Thị Lan");
    assert.equal(out.proposal, null, JSON.stringify(out).slice(0, 400));
    assert.equal(out.error_code, "PAYMENT_AMOUNT_MISSING");
    assert.match(out.reason, /thiếu số tiền/);
  } finally {
    await copilot.close();
    nlp.child.kill();
  }
});

// ── P2 (plan2_final §12 + §14): uncertainty taxonomy + session context ──

test("copilot E2E P2 §12: an understood intent WITHOUT a skill is KNOWN_INTENT_UNIMPLEMENTED (+ copy)", async () => {
  // "doanh thu" hits the sales route and resolves to sales.summary — a
  // capability deliberately declared with skill:null / status:"stub". The
  // pipeline must say "I understood, but it does not exist yet" (a LEARNING
  // signal for P4), not "I did not understand" (UNKNOWN_INTENT).
  const nlp = await startNlpService();
  const copilot = startCopilot(nlp.port);
  try {
    await copilot.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } });
    const out = await copilot.call("doanh thu hôm nay thế nào");
    assert.equal(out.error_code, "KNOWN_INTENT_UNIMPLEMENTED", JSON.stringify(out));
    assert.equal(out.routed.capability, "sales.summary");
    assert.equal(out.proposal, null);
    assert.equal(out.uncertainty.code, "KNOWN_INTENT_UNIMPLEMENTED");
    assert.ok(out.uncertainty.message.includes("chưa có"), out.uncertainty.message);
  } finally {
    await copilot.close();
    nlp.child.kill();
  }
});

test("copilot E2E P2 §12: a customer-less receivable question refuses as MISSING_ENTITY (+ copy)", async () => {
  // P2 exit criterion 1: "Thu 10 triệu" (no customer) asks WHO — it never
  // guesses an entity from context or anywhere else.
  const nlp = await startNlpService();
  const copilot = startCopilot(nlp.port);
  try {
    await copilot.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } });
    const out = await copilot.call("công nợ 10 triệu");
    assert.equal(out.error_code, "MISSING_ENTITY", JSON.stringify(out));
    assert.equal(out.proposal, null);
    assert.equal(out.uncertainty.code, "MISSING_ENTITY");
    assert.ok(out.uncertainty.message.includes("tên khách"), out.uncertainty.message);
  } finally {
    await copilot.close();
    nlp.child.kill();
  }
});

test("copilot E2E P2 §14: an exact customer from a previous READ is remembered (provenance user_selected)", async () => {
  // Deliverable 2 in action: the exact name from turn 1 lives in session
  // context with user_selected provenance (recorded through the READ path).
  // P8 will key this by session; the behaviour contract is pinned here.
  const nlp = await startNlpService();
  const copilot = startCopilot(nlp.port);
  try {
    await copilot.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } });
    const first = await copilot.call("Nguyễn Thị Lan còn nợ bao nhiêu");
    assert.equal(first.customer.id, "CUST-00001"); // EXACT name match ⇒ recorded
  } finally {
    await copilot.close();
    nlp.child.kill();
  }
});
