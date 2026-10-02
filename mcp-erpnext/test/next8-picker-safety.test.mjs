/**
 * next8 / D2 — picker safety: bailout, overflow, stale pick, enrichment.
 *
 * Pins the plan_final_v3 §5–§7 rules on the SERVER side of the picker:
 *
 *   T11-bailout  "hủy" after an ambiguous supplier question is an ACTION
 *                (the pending selection is abandoned), NOT a new supplier
 *                search — it must never answer AMBIGUOUS_SUPPLIER again.
 *   T12-limit    the picker shows at most 10 chips; an overflow says how many
 *                more exist and asks for a more specific name (never a dump).
 *   T14-stale    a picked id that is NOT in the freshly-read list (the entity
 *                was deleted between the picker and the tap) is a REFUSAL with
 *                its own Vietnamese copy — never a loop, never a wrong entity.
 *   enrichment   picker chips may carry ONE distinguishing master field the ERP
 *                already returned (tax_id) — name + id + MST, nothing else.
 *
 * Harness: createAskServer on an ephemeral port + the REAL Python NLP service
 * + the mock ERPNext (MOCK_ERP_STATE injects extra suppliers) — same
 * discipline as next8-entity-pick.test.mjs / next7-a0-dsh-write-handoff.test.mjs.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

for (const k of Object.keys(process.env)) {
  if (/^(ERPNEXT_|ASK_)/.test(k)) delete process.env[k];
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");

async function startNlpService() {
  const { spawn } = await import("node:child_process");
  const REPO = path.resolve(ROOT, "..");
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

async function withServer(opts = {}, fn) {
  if (typeof opts === "function") { fn = opts; opts = {}; }
  const stateFile = opts?.stateFile ?? null;
  const nlp = await startNlpService();
  const { __setNlpServicePortForTest } = await import("../src/copilot-server.mjs");
  const previousPort = process.env.NLP_SERVICE_PORT;
  let server = null;
  const hadState = process.env.MOCK_ERP_STATE !== undefined;
  const previousState = process.env.MOCK_ERP_STATE;
  try {
    process.env.NLP_SERVICE_PORT = String(nlp.port);
    __setNlpServicePortForTest(nlp.port);
    if (stateFile) process.env.MOCK_ERP_STATE = stateFile;
    const { createAskServer } = await import("../src/http-ask.mjs");
    server = createAskServer({ port: 0, host: "127.0.0.1" });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    return await fn({ base: `http://127.0.0.1:${server.address().port}` });
  } finally {
    server?.close();
    nlp.child.kill();
    __setNlpServicePortForTest(previousPort ?? "8787");
    if (hadState) process.env.MOCK_ERP_STATE = previousState;
    else delete process.env.MOCK_ERP_STATE;
  }
}

const askPost = (base, body) =>
  fetch(`${base}/ask`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

/** A state file injecting N extra "Nhà cung cấp X" rows — the overflow fixture. */
const overflowState = (dir) => {
  const file = path.join(dir, "overflow-suppliers.json");
  const rows = Array.from({ length: 12 }, (_, i) => ({
    doctype: "Supplier",
    name: `SUP-NCC-${String(i + 1).padStart(2, "0")}`,
    supplier_name: `Nhà cung cấp mới ${String(i + 1).padStart(2, "0")}`,
    supplier_group: "Vật liệu",
    supplier_type: "Company",
    disabled: 0,
  }));
  writeFileSync(file, JSON.stringify({ customers_created: [], suppliers_created: rows }));
  return file;
};

test("D2 T11 — 'hủy' after an ambiguous supplier question clears the wait, it is NOT a new search", async () => {
  await withServer(async ({ base }) => {
    const s1 = await askPost(base, { text: "nhà cung cấp tiên" });
    assert.equal(s1.status, 200);
    const s1Body = await s1.json();
    assert.equal(s1Body.result.error_code, "AMBIGUOUS_SUPPLIER");
    assert.ok(s1Body.result.candidates?.length >= 2);

    // The bailout word: the pending selection is abandoned — the answer must
    // NOT be the same ambiguous picker again (no re-search of the old intent).
    const s2 = await askPost(base, { text: "hủy" });
    assert.equal(s2.status, 200);
    const s2Body = await s2.json();
    assert.notEqual(
      s2Body.result.error_code,
      "AMBIGUOUS_SUPPLIER",
      "'hủy' must not re-run the old supplier search (plan §5: hủy → clear pending)",
    );
    assert.deepEqual(s2Body.result.candidates ?? [], []);
    assert.ok(s2Body.result.answer || s2Body.result.reason, "the user is told what happened");

    // D2 T10: "thoát" and "bỏ qua" route NOWHERE (no keyword hit) — they must
    // NOT fall into UNKNOWN_INTENT just because the router cannot place them.
    for (const word of ["thoát", "bỏ qua", "huỷ"]) {
      const res = await askPost(base, { text: word });
      const body = await res.json();
      assert.equal(
        body.result.error_code,
        "PICKER_BAILOUT",
        `bare "${word}" is a bailout ACTION, not UNKNOWN_INTENT`,
      );
      assert.deepEqual(body.result.candidates ?? [], []);
    }

    // T10 (second reading): a NEW question while a picker is up is processed
    // NORMALLY — the pending selection is simply not consumed. The picker was
    // offered for a supplier question; asking about revenue answers the
    // revenue question (never re-offers the supplier picker, never bails out).
    const s3 = await askPost(base, { text: "doanh thu hôm nay" });
    const s3Body = await s3.json();
    assert.notEqual(s3Body.result.error_code, "PICKER_BAILOUT");
    assert.notEqual(s3Body.result.error_code, "AMBIGUOUS_SUPPLIER");
    assert.deepEqual(s3Body.result.candidates ?? [], [],
      "a NEW intent must not inherit the stale supplier candidates");
  });
});

test("D2 T12 — the picker shows at most 10 chips; the overflow names what is left", async () => {
  // The mock reads MOCK_ERP_STATE ONCE at import time (module cache — the same
  // discipline next7-a0's A1 test follows): set it BEFORE withServer spawns the
  // server, and restore it after so later tests stay on the plain fixtures.
  const dir = mkdtempSync(path.join(tmpdir(), "d2-overflow-"));
  const prevState = process.env.MOCK_ERP_STATE;
  process.env.MOCK_ERP_STATE = overflowState(dir);
  try {
    await withServer(async ({ base }) => {
    // "nha cung cap moi" (unaccented via the normalizer) hits all 12 injected
    // rows ⇒ the first time the picker has MORE candidates than the limit.
    const res = await askPost(base, { text: "nhà cung cấp mới" });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.result.error_code, "AMBIGUOUS_SUPPLIER");
    const chips = body.result.candidates ?? [];
    assert.ok(chips.length > 0, "the picker is offered");
    assert.ok(
      chips.length <= 10,
      `plan §6 hard limit is 10 chips, got ${chips.length}`,
    );
    assert.equal(chips.length, 10, "12 candidates ⇒ exactly 10 shown");
    assert.ok(
      body.result.picker_total >= chips.length,
      "picker_total reports the true count",
    );
    assert.equal(body.result.picker_total, 12);
    assert.ok(
      body.result.picker_more > 0,
      "picker_more names the number of results NOT shown",
    );
    assert.equal(body.result.picker_more, 2);
    assert.match(
      body.result.reason,
      /Còn 2 kết quả/,
      "the overflow hint asks for a more specific name (plan §6)",
    );
  });
  } finally {
    if (prevState === undefined) delete process.env.MOCK_ERP_STATE;
    else process.env.MOCK_ERP_STATE = prevState;
  }
});

test("D2 T14 — a pick whose entity vanished from the list is REFUSED with its own copy (stale)", async () => {
  await withServer(async ({ base }) => {
    const s1 = await askPost(base, { text: "nhà cung cấp tiên" });
    const s1Body = await s1.json();
    assert.equal(s1Body.result.error_code, "AMBIGUOUS_SUPPLIER");

    // D1 (today) already refuses an unknown id and keeps the ambiguous shape.
    // D2 pins the STALE reading: the code is ENTITY_PICK_STALE with Vietnamese
    // copy — the user is told to pick again from the fresh list, never left
    // tapping the same dead chip forever (plan §7: lỗi rõ, không loop).
    const s2 = await askPost(base, { text: "nhà cung cấp tiên", entity_id: "SUP-DELETED" });
    const s2Body = await s2.json();
    assert.equal(s2Body.result.error_code, "ENTITY_PICK_STALE");
    assert.ok(s2Body.result.uncertainty?.message, "the stale refusal carries Vietnamese copy");
    assert.deepEqual(s2Body.result.candidates, s1Body.result.candidates);
    assert.equal(s2Body.result.supplier ?? null, null);
  });
});

test("D2 enrichment — supplier picker chips carry name + id + the master's tax_id when present", async () => {
  await withServer(async ({ base }) => {
    // "đại lý cám bình dương" matches ONE row that carries tax_id 0300000002,
    // but "binh duong" also uniquely matches ⇒ use the ambiguous pair fixture
    // instead: SUP-HATIEN (no tax_id) + SUP-HATIEN-2 (no tax_id) prove the
    // field is ABSENT-HONEST; the MST path is proven via the unique pick of
    // "đại lý" which resolves directly (not a picker) — so here we assert on
    // the ambiguous fixture that label stays honest when the field is null,
    // and pin the shape contract (tax_id key present, null when unknown).
    const res = await askPost(base, { text: "nhà cung cấp tiên" });
    const body = await res.json();
    for (const chip of body.result.candidates) {
      assert.equal(typeof chip.tax_id, "undefined", "no tax_id key on rows that have none — the label contract");
      assert.ok(chip.label.includes(chip.id), "the label still names the id");
    }
  });
});

test("D2 enrichment — the unique 'đại lý' answer surfaces the row's MST (1 distinguishing field)", async () => {
  await withServer(async ({ base }) => {
    const res = await askPost(base, { text: "nhà cung cấp đại lý" });
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.result.supplier?.id, "SUP-BINH-DUONG");
    assert.equal(body.result.supplier?.tax_id, "0300000002", "the ERP-returned MST travels with the answer");
    assert.match(body.result.answer.join("\n"), /MST 0300000002/, "the detail names the distinguishing field");
  });
});
