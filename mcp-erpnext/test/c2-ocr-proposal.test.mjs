/**
 * C2 — camera → proposal (`plan3` Trụ C §6.1/§6.3, `.plan/phases3/C2-camera-to-proposal.md`).
 *
 * C1 proved a photo becomes TEXT. This file proves the step that follows, and it
 * starts from a MEASURED fact (2026-09-20, real path): an invoice-shaped reading
 * has no imperative verb, so "HÓA ĐƠN …" routes to `invoice.lookup` and
 * "PHIẾU THU …" to `payment.history`. Hence:
 *
 *  1. the DOCUMENT KIND is the user's tap, and the kind → capability mapping
 *     lives in the contract, validated fail-closed (a kind may not point at a
 *     stub, at a submit-capable write, or at a capability that does not exist);
 *  2. only a CONFIDENT, REAL reading may produce slots at all — the mock is the
 *     default provider, so "the reading is a fixture" is the ordinary case;
 *  3. the slots come from the builder's OWN parse steps, so the form shows what
 *     the proposal would actually contain;
 *  4. the client's composed sentence must route to the capability the contract
 *     declares for that kind — checked here by parsing the CLIENT's own template
 *     file, so the two sides cannot drift apart silently;
 *  5. nothing on this path writes: the route is READ-only by construction, and
 *     the only thing that leaves it is editable text.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, readdirSync } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import path from "node:path";

// Hermetic: a shell that sourced .env would otherwise make createAskServer()
// resolve the REAL ERPNext target. Same rule as http-ask.test.mjs.
for (const k of Object.keys(process.env)) {
  if (/^(ERPNEXT_|ASK_)/.test(k)) delete process.env[k];
}
const LOG_DIR = mkdtempSync(path.join(tmpdir(), "c2-learning-"));
process.env.LEARNING_LOG_DIR = LOG_DIR;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const REPO = path.resolve(ROOT, "..");

const { validateContract, __contract, ocrDocumentKinds } = await import("../src/capability-contract.mjs");
const {
  OCR_SLOTS_CODES,
  assertSlotsProvenance,
  assertSlotsText,
  extractSlots,
  kindSpec,
} = await import("../src/ocr/ocr-slots.mjs");
const { RateLimiter } = await import("../src/rate-limit.mjs");
const { routeIntent } = await import("../src/router.mjs");

// ─────────────────────────────────────────────────────────────────────────────
// 1. the contract owns the kind → capability mapping
// ─────────────────────────────────────────────────────────────────────────────

test("C2: the contract declares the document kinds and both are draft-only writes with executors", () => {
  const kinds = ocrDocumentKinds();
  assert.deepEqual(Object.keys(kinds).sort(), ["purchase", "sales"]);
  assert.equal(kinds.sales.capability, "sales_order.create");
  assert.equal(kinds.sales.party, "customer");
  assert.equal(kinds.purchase.capability, "purchase_order.create");
  assert.equal(kinds.purchase.party, "supplier");
  // The button the user taps comes from here, so it cannot be blank.
  for (const kind of Object.values(kinds)) assert.ok(kind.label.trim().length > 0);
});

test("C2: the contract REFUSES a kind that could submit, points at a stub, or does not exist", () => {
  const clone = () => JSON.parse(JSON.stringify(__contract));
  const cases = [
    [
      // P9-B made purchase_receipt.create a REAL write (draft-only), so the
      // stub-refusal case is pinned on a capability that does not exist at all.
      "points at a STUB-like capability (stock_entry) — a form for a capability that cannot be written",
      (c) => (c.ocr_policy.document_kinds.purchase.capability = "stock_entry.create"),
      /unknown capability|no registered executor/,
    ],
    [
      "points at an unknown capability",
      (c) => (c.ocr_policy.document_kinds.sales.capability = "nope.nope"),
      /unknown capability/,
    ],
    [
      "points at a capability that may SUBMIT (payment.create with allow_submit)",
      (c) => (c.ocr_policy.document_kinds.sales.capability = "payment.create"),
      /not draft_only/,
    ],
    [
      "an empty label (a button with no words)",
      (c) => (c.ocr_policy.document_kinds.sales.label = "  "),
      /label must be a non-empty string/,
    ],
    [
      "a party that is neither customer nor supplier",
      (c) => (c.ocr_policy.document_kinds.sales.party = "anyone"),
      /party must be/,
    ],
  ];
  for (const [name, mutate, expected] of cases) {
    const c = clone();
    mutate(c);
    assert.throws(() => validateContract(c), expected, name);
  }
  // Control: the untouched contract still validates.
  assert.equal(validateContract(clone()), true);
});

test("C2: the real contract's kinds really are draft_only (not just asserted above)", () => {
  // A single source of truth check: the mapping is only safe because B2/B4
  // declared draft_only on those capabilities, so this reads it back.
  for (const [kind, spec] of Object.entries(ocrDocumentKinds())) {
    const cap = __contract.capabilities[spec.capability];
    assert.equal(cap.execution.draft_only, true, `${kind} → ${spec.capability}`);
    assert.equal(cap.execution.allow_submit, false, `${kind} → ${spec.capability}`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. the provenance gate (false-write guard)
// ─────────────────────────────────────────────────────────────────────────────

test("C2: only a confident, non-mock, recognised reading may produce slots", () => {
  assert.deepEqual(assertSlotsProvenance({ status: "OK", confidence: 0.93 }), {
    status: "OK",
    confidence: 0.93,
    min_confidence: 0.6,
  });
  const refusals = [
    ["a status this build does not know", { status: "PARTIAL_V2", confidence: 0.9 }, OCR_SLOTS_CODES.READ_UNVERIFIED],
    ["no status at all", {}, OCR_SLOTS_CODES.READ_UNVERIFIED],
    ["NO_TEXT (the photo produced nothing)", { status: "NO_TEXT", confidence: 0.9 }, OCR_SLOTS_CODES.READ_UNUSABLE],
    ["LOW_CONFIDENCE", { status: "LOW_CONFIDENCE", confidence: 0.2 }, OCR_SLOTS_CODES.READ_UNUSABLE],
    ["a MOCK reading (a fixture, not the user's document)", { status: "OK", confidence: 0.93, mock: true }, OCR_SLOTS_CODES.READ_IS_MOCK],
    ["a confidence the reader could not state", { status: "OK", confidence: null }, OCR_SLOTS_CODES.READ_LOW_CONFIDENCE],
    ["a confidence under the policy floor", { status: "OK", confidence: 0.59 }, OCR_SLOTS_CODES.READ_LOW_CONFIDENCE],
  ];
  for (const [name, provenance, code] of refusals) {
    assert.throws(() => assertSlotsProvenance(provenance), (err) => err.code === code, name);
  }
});

test("C2: a KIND is a word from the contract — a capability id is not one", () => {
  assert.equal(kindSpec("sales").capability, "sales_order.create");
  assert.equal(kindSpec("purchase").party, "supplier");
  for (const wrong of ["sales_order.create", "create_sales_order", "", null, undefined, "Sales"]) {
    assert.throws(() => kindSpec(wrong), (err) => err.code === OCR_SLOTS_CODES.KIND_UNKNOWN, String(wrong));
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. the slots themselves (the builder's own parse steps)
// ─────────────────────────────────────────────────────────────────────────────

const ITEMS = [
  { name: "CAM-HEO-25KG", item_name: "Cám heo tăng trọng 25kg", stock_uom: "Bao" },
  { name: "CAM-GA-10KG", item_name: "Cám gà thịt 10kg", stock_uom: "Bao" },
];
const CUSTOMERS = [{ name: "CUST-00001", customer_name: "Nguyễn Thị Lan" }];
const SUPPLIERS = [
  { name: "SUP-HATIEN", supplier_name: "Hà Tiên" },
  { name: "SUP-HATIEN-2", supplier_name: "Hà Tiên 2" },
];

function nlpOf(text, quantities, amount = null) {
  return { text, quantities, amount };
}

test("C2: the quantity inside an ITEM NAME is packaging, not an order — and the real one is paired", () => {
  // This is the B1 lesson (\"Cám heo tăng trọng 25kg\") surviving in the camera
  // path for free: the slots reuse pairLines instead of re-deriving anything.
  const text = "HÓA ĐƠN Khách hàng: Nguyễn Thị Lan Cám heo tăng trọng 25kg 10 Bao";
  const nlp = nlpOf(text, [
    { value: 25, canonical_unit: "Kg", raw: "25kg", start: text.indexOf("25kg"), end: text.indexOf("25kg") + 4 },
    { value: 10, canonical_unit: "Bao", raw: "10 Bao", start: text.indexOf("10 Bao"), end: text.indexOf("10 Bao") + 6 },
  ]);
  const slots = extractSlots({ text, spec: kindSpec("sales"), nlp, items: ITEMS, parties: CUSTOMERS });
  assert.equal(slots.lines.length, 1);
  assert.equal(slots.lines[0].qty, 10, "the 25kg is part of the item's name");
  assert.equal(slots.lines[0].uom, "Bao");
  assert.equal(slots.lines[0].raw_quantity, "10 Bao");
  assert.equal(slots.lines[0].item_code, "CAM-HEO-25KG");
  assert.deepEqual(slots.party.resolved, { id: "CUST-00001", name: "Nguyễn Thị Lan" });
  assert.equal(slots.empty, false);
  // No price anywhere: a rate never comes from a photo.
  assert.equal("price" in slots || "rate" in slots, false);
});

test("C2: an unmatched name is OFFERED as candidates, never auto-picked", () => {
  const text = "PHIẾU GIAO HÀNG Khách: Lan";
  const slots = extractSlots({ text, spec: kindSpec("sales"), nlp: nlpOf(text, []), items: ITEMS, parties: CUSTOMERS });
  assert.equal(slots.party.resolved, null);
  assert.ok(slots.party.candidates.length >= 1);
  assert.ok(slots.warnings.some((w) => w.code === "CUSTOMER_NOT_FOUND"));
  // Nothing readable at all is a REFUSAL the UI acts on (manual entry), not an
  // empty form that looks like a bug.
  assert.equal(slots.empty, true);
});

test("C2: a purchase reading resolves against SUPPLIERS, not customers", () => {
  const text = "PHIẾU MUA Hà Tiên 20 Bao Cám heo tăng trọng 25kg";
  const nlp = nlpOf(text, [
    { value: 20, canonical_unit: "Bao", raw: "20 Bao", start: text.indexOf("20 Bao"), end: text.indexOf("20 Bao") + 6 },
  ]);
  const slots = extractSlots({ text, spec: kindSpec("purchase"), nlp, items: ITEMS, parties: SUPPLIERS });
  assert.equal(slots.kind, "purchase");
  assert.equal(slots.party.role, "supplier");
  assert.equal(slots.party.resolved.name, "Hà Tiên");
  assert.equal(slots.lines[0].qty, 20);
});

test("C2: the slots module holds no write surface at all", () => {
  const src = readFileSync(new URL("../src/ocr/ocr-slots.mjs", import.meta.url), "utf8");
  for (const forbidden of [
    "callWriteTool",
    "erpnext_doc_create",
    "erpnext_doc_submit",
    "docstatus",
    "safety-gateway",
    "idempotency",
    "runExecute",
  ]) {
    assert.equal(src.includes(forbidden), false, `src/ocr/ocr-slots.mjs must not mention ${forbidden}`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. the client's composed sentence must reach the capability the contract says
// ─────────────────────────────────────────────────────────────────────────────

/** Start the real Python normalizer (the same bridge production uses). */
async function startNlp() {
  const child = spawn("python3", ["-m", "nlp_service.server", "--port", "0"], {
    cwd: REPO,
    stdio: ["ignore", "pipe", "inherit"],
  });
  const port = await new Promise((resolve, reject) => {
    child.stdout.on("data", (d) => {
      const m = String(d).match(/"port":\s*(\d+)/);
      if (m) resolve(Number(m[1]));
    });
    child.on("exit", (c) => reject(new Error(`nlp exited ${c}`)));
    setTimeout(() => reject(new Error("nlp did not report a port")), 5000);
  });
  const { __setNlpServicePortForTest } = await import("../src/copilot-server.mjs");
  __setNlpServicePortForTest(port);
  return child;
}

const COMPOSE_DART = path.join(REPO, "apps/mobile/lib/features/chat/data/ocr_compose.dart");

/**
 * Read the CLIENT's own templates. Deliberately parsed, not copied: a copy in
 * this file would drift the moment someone edits the Dart wording, and the
 * failure it is guarding against (a sentence that no longer routes to the
 * capability the user chose) would go unnoticed until a shop owner hit it.
 */
function clientTemplates() {
  const dart = readFileSync(COMPOSE_DART, "utf8");
  const out = {};
  for (const kind of ["sales", "purchase"]) {
    const m = dart.match(new RegExp(`static const String ${kind}Template = '([^']+)'`));
    assert.ok(m, `ocr_compose.dart must still declare ${kind}Template as a single-quoted literal`);
    out[kind] = m[1];
  }
  return out;
}

test("C2: the client's own templates route to the capability the contract maps them to", async () => {
  const nlpChild = await startNlp();
  try {
    const templates = clientTemplates();
    const { normalizeText } = await import("../src/copilot-server.mjs");
    const fixtures = {
      sales: { party: "Nguyễn Thị Lan", goods: "10 Bao Cám heo tăng trọng 25kg" },
      purchase: { party: "Hà Tiên", goods: "20 Bao Cám heo tăng trọng 25kg" },
    };
    for (const [kind, template] of Object.entries(templates)) {
      const sentence = template
        .replace("{party}", fixtures[kind].party)
        .replace("{goods}", fixtures[kind].goods);
      const nlp = await normalizeText(sentence);
      const hit = routeIntent(nlp.text);
      assert.ok(hit, `${kind}: "${sentence}" must route somewhere`);
      assert.equal(
        hit.capability,
        ocrDocumentKinds()[kind].capability,
        `${kind}: "${sentence}" routed to ${hit.capability}`,
      );
    }
  } finally {
    nlpChild.kill();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. the route over HTTP
// ─────────────────────────────────────────────────────────────────────────────

async function startGateway() {
  const { createAskServer } = await import("../src/http-ask.mjs");
  const server = createAskServer({
    port: 0,
    host: "127.0.0.1",
    env: { ...process.env },
    limiter: RateLimiter.disabled(),
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    post: (p, body) =>
      fetch(`${base}${p}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
    stop: () => new Promise((r) => server.close(r)),
  };
}

const READ_TEXT = "HÓA ĐƠN Khách hàng: Nguyễn Thị Lan Cám heo tăng trọng 25kg 10 Bao";
const GOOD_READ = { status: "OK", confidence: 0.93, mock: false, provider: "router-vision", model: "vision-1" };

test("C2: /ocr/slots turns a reading into SLOTS — never a proposal, never a price", async () => {
  const nlpChild = await startNlp();
  const srv = await startGateway();
  try {
    const res = await srv.post("/ocr/slots", { text: READ_TEXT, kind: "sales", ocr: GOOD_READ });
    assert.equal(res.status, 200);
    const { result } = await res.json();
    assert.equal(result.kind, "sales");
    assert.equal(result.capability, "sales_order.create");
    assert.equal(result.party.resolved.id, "CUST-00001");
    assert.equal(result.lines.length, 1);
    assert.equal(result.lines[0].qty, 10);
    // The unit travels as the NLP service normalizes it (lowercase canonical
    // form) — the UOM the DOCUMENT gets is resolved from the site's own list by
    // the builder, never from this slot string. What is preserved verbatim is
    // the raw words the number came from.
    assert.match(result.lines[0].uom, /bao/i);
    assert.equal(result.lines[0].raw_quantity, "10 Bao");
    // The provenance travels with the slots so the UI (and C2's own review) can
    // see this came from a photo, and from which reader.
    assert.equal(result.provenance.from_photo, true);
    assert.equal(result.provenance.confidence, 0.93);
    // There is no write surface on this channel: no card, no command, no money.
    for (const key of ["proposal", "action", "command_id", "params", "risk", "price", "rate"]) {
      assert.equal(key in result, false, `${key} must not appear on slots`);
    }
  } finally {
    await srv.stop();
    nlpChild.kill();
  }
});

test("C2: the route refuses what the gate refuses, and refuses it over HTTP too", async () => {
  const srv = await startGateway();
  try {
    const cases = [
      ["an unknown KIND", { text: READ_TEXT, kind: "sales_order.create", ocr: GOOD_READ }, 400, OCR_SLOTS_CODES.KIND_UNKNOWN],
      ["a missing kind", { text: READ_TEXT, ocr: GOOD_READ }, 400, OCR_SLOTS_CODES.KIND_UNKNOWN],
      ["a MOCK reading", { text: READ_TEXT, kind: "sales", ocr: { ...GOOD_READ, mock: true } }, 409, OCR_SLOTS_CODES.READ_IS_MOCK],
      ["an unverified status", { text: READ_TEXT, kind: "sales", ocr: { ...GOOD_READ, status: "PARTIAL_V2" } }, 400, OCR_SLOTS_CODES.READ_UNVERIFIED],
      ["a LOW_CONFIDENCE reading", { text: READ_TEXT, kind: "sales", ocr: { ...GOOD_READ, status: "LOW_CONFIDENCE", confidence: 0.2 } }, 409, OCR_SLOTS_CODES.READ_UNUSABLE],
      ["no confidence stated", { text: READ_TEXT, kind: "sales", ocr: { ...GOOD_READ, confidence: null } }, 409, OCR_SLOTS_CODES.READ_LOW_CONFIDENCE],
      ["no provenance at all", { text: READ_TEXT, kind: "sales" }, 400, OCR_SLOTS_CODES.READ_UNVERIFIED],
    ];
    for (const [name, body, status, code] of cases) {
      const res = await srv.post("/ocr/slots", body);
      assert.equal(res.status, status, name);
      const payload = await res.json();
      assert.equal(payload.code, code, name);
      assert.equal(payload.ok, false, name);
    }
  } finally {
    await srv.stop();
  }
});

test("C2: the length bound travels WITH the reading — a client cannot post a 1 MB text (review 2026-09-20)", async () => {
  // The C0 bound (ocr_policy.max_text_length) is enforced where a reading is
  // PRODUCED; the slots route accepts text that travelled VIA THE CLIENT, so it
  // re-enforces it here — before NLP, before master data, before anything.
  assert.equal(assertSlotsText("x".repeat(5000)), "x".repeat(5000));
  assert.throws(() => assertSlotsText("x".repeat(5001)), (e) => e.code === OCR_SLOTS_CODES.READ_TOO_LONG);
  // Nothing readable is not the same as too long — empty text falls through to
  // the ordinary (empty → 422) path, unchanged.
  assert.equal(assertSlotsText(null), "");
  assert.equal(assertSlotsText(undefined), "");

  const srv = await startGateway();
  try {
    const res = await srv.post("/ocr/slots", {
      text: "x".repeat(6000),
      kind: "sales",
      ocr: GOOD_READ,
    });
    assert.equal(res.status, 400);
    const payload = await res.json();
    assert.equal(payload.code, OCR_SLOTS_CODES.READ_TOO_LONG);
    assert.equal(payload.ok, false);
  } finally {
    await srv.stop();
  }
});

test("C2: a reading that yields nothing is a 422 the UI can act on", async () => {
  const nlpChild = await startNlp();
  const srv = await startGateway();
  try {
    const res = await srv.post("/ocr/slots", {
      text: "qwerty zxcvb",
      kind: "sales",
      ocr: GOOD_READ,
    });
    assert.equal(res.status, 422);
    assert.equal((await res.json()).code, OCR_SLOTS_CODES.SLOTS_EMPTY);
  } finally {
    await srv.stop();
    nlpChild.kill();
  }
});

test("C2: nothing on the camera path writes — the log shows slots, never a write", async () => {
  const nlpChild = await startNlp();
  const srv = await startGateway();
  try {
    // A full walk of the path: a good reading, then the composed sentence the
    // form would send, straight through the ORDINARY /ask pipeline.
    const slotsRes = await srv.post("/ocr/slots", { text: READ_TEXT, kind: "sales", ocr: GOOD_READ });
    assert.equal(slotsRes.status, 200);
    const askRes = await srv.post("/ask", { text: "đặt hàng cho Nguyễn Thị Lan 10 Bao Cám heo tăng trọng 25kg" });
    assert.equal(askRes.status, 200);

    const lines = readdirSync(LOG_DIR)
      .flatMap((file) => readFileSync(path.join(LOG_DIR, file), "utf8").split("\n"))
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const phases = lines.map((l) => l.phase);
    assert.ok(phases.includes("ocr_slots"), "opening the slot form is its own event");
    assert.ok(
      lines.some((l) => l.phase === "ocr_slots" && l.outcome === "slots_served"),
      "the served slots are counted as such (not as an answer)",
    );
    // The ONLY way to a write is the confirm card + /execute, and no request here
    // went near it: no execute phase, no write_* verdict.
    assert.equal(phases.includes("execute"), false);
    assert.equal(lines.some((l) => String(l.outcome ?? "").startsWith("write_")), false);
  } finally {
    await srv.stop();
    nlpChild.kill();
  }
});
