/**
 * A2 (`.plan/next3/implementation.md` workstream A) — the REAL-site loop found
 * two defects that the mock could never surface, because the mock validates
 * nothing and never exercises a builder's REFUSAL from a supplier party.
 *
 *  1. WIRE FORMAT: the pinned @casys/mcp-erpnext 3.0.4 server rejects a non-string
 *     filter value — measured:
 *       `Tool erpnext_doc_list returned business error: Invalid arguments for
 *        erpnext_doc_list: Property /filters/0/2 must be string`
 *     Two call sites passed the number `1` for the Item Price side flags
 *     (`inventory.listItemPrices`, used by every order builder; and the purchase
 *     order executor's drift re-read). On the real site that turned EVERY `/ask`
 *     for a purchase into a 500 before a card existed. Its sibling files
 *     (sales-order-write / quotation-write) already carried the string form and a
 *     comment saying exactly this, so the PO side had simply been missed.
 *
 *  2. SCOPE: `copilot-server.mjs` declared the party id/name INSIDE the write
 *     `try` while its `catch` also read them. A catch block is a separate scope,
 *     so every refusal from a SUPPLIER-party builder (purchase order / purchase
 *     receipt) came back as a bare 500 "ask failed: customerId is not defined"
 *     instead of the builder's own Vietnamese reason + error_code. Fail-closed
 *     held (nothing was written); the diagnosis the user needs was destroyed.
 *
 *  3. R5 — UNIT "Nos": a structured e-invoice line for a SERVICE carries the
 *     document's own UOM, and this site's service items are `Nos`. Measured
 *     2026-09-24 (read-only): the `UOM` doctype HAS `Nos` (must_be_whole_number 1)
 *     and does NOT have `Cái`/`Chiếc`; the service item `PHI-VAN-CHUYEN` has
 *     `stock_uom: "Nos"`. Nothing knew the token, so the composed sentence
 *     `3 Nos Phí vận chuyển & bốc xếp` kept its NUMBER but lost its UNIT — the
 *     quantity never existed and the order path answered PO_QTY_MISSING with a
 *     message about "chưa rõ số lượng" even though the file said "3".
 */

import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { listItemPrices } from "../src/skills/inventory.mjs";
import { getCapability } from "../src/capability-contract.mjs";
import { pairLinesPure } from "../src/line-parse.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const REPO = path.resolve(ROOT, "..");

/* ───────────── 1. no MCP filter value may be a non-string literal ────────── */

// The repo-wide form of this rule already lives in `filter-literal-types.test.mjs`
// — which is why the two numeric sites here were EXTENDED into that tripwire
// instead of being copied into a second one: its scan required a QUOTED field
// name, so `[[side, "=", 1]]` (the exact form that shipped) was invisible to it.
// What cannot be seen statically is pinned below at the WIRE level.

test("A2 fix: listItemPrices sends STRING filter values over the wire", async () => {
  const seen = [];
  const mcp = {
    callTool: async (tool, args) => {
      seen.push({ tool, args });
      return { data: { doctype: "Item Price", data: [] } };
    },
  };
  await listItemPrices(mcp, { side: "buying", itemCode: "CAM-GA-25KG" });
  assert.equal(seen.length, 1);
  const { tool, args } = seen[0];
  assert.equal(tool, "erpnext_doc_list");
  assert.equal(args.doctype, "Item Price");
  for (const [field, op, value] of args.filters) {
    assert.equal(typeof op, "string", `${field}: operator must be a string`);
    assert.equal(typeof value, "string", `${field}: value must be a string, got ${typeof value} (${JSON.stringify(value)})`);
  }
  assert.deepEqual(args.filters[0], ["buying", "=", "1"], "the buying side is asked as the string \"1\"");
  assert.deepEqual(args.filters[1], ["item_code", "=", "CAM-GA-25KG"]);
});

/* ───────── 2. a supplier-party builder REFUSAL keeps its own reason ──────── */

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
    child.on("exit", (code) => reject(new Error(`nlp service exited early (${code})`)));
    setTimeout(() => reject(new Error("nlp service: no ready line in 5s")), 5000);
  });
  return { child, port };
}

test("A2 fix: a supplier-party builder refusal returns its OWN code and reason (not a ReferenceError)", async () => {
  // The sentence resolves the supplier but names NO quantity, so the purchase
  // order builder must REFUSE. Before the fix this refusal was swallowed by
  // "ReferenceError: customerId is not defined" (the catch block read a variable
  // declared inside the try it belongs to) and surfaced as a bare 500.
  const nlp = await startNlp();
  const prevPort = process.env.NLP_SERVICE_PORT;
  process.env.NLP_SERVICE_PORT = String(nlp.port);
  try {
    const { answerQuestion } = await import("../src/copilot-server.mjs");
    const res = await answerQuestion("đặt mua cám gà thịt 25kg từ Hà Tiên", {});

    assert.equal(res.routed?.group, "purchase_order_write", JSON.stringify(res.routed));
    assert.equal(res.proposal, null, "a refusal never builds a card");
    assert.equal(
      getCapability("purchase_order.create").type,
      "WRITE",
      "sanity: the refusal below is on a WRITE path",
    );
    // WHICH refusal depends on the data (the mock resolves "25kg" but has no
    // Kg→Bao factor, the real site instead reported PO_QTY_MISSING for the
    // service line) — that is not what this test is about. The property is that
    // the builder's OWN code and Vietnamese reason survive, instead of the catch
    // block crashing on a variable from the try scope.
    assert.match(res.error_code ?? "", /^PO_/, `expected a PO_* refusal code, got ${JSON.stringify(res)}`);
    assert.doesNotMatch(String(res.error_code), /ReferenceError/);
    assert.match(res.reason ?? "", /không tạo được đề xuất đơn mua: .+/, "the Vietnamese reason must survive");
    // The party block travels too — it is the field the catch used to crash on.
    assert.equal(res.supplier?.id, "SUP-HATIEN", "the resolved supplier is reported on the refusal");
  } finally {
    if (prevPort === undefined) delete process.env.NLP_SERVICE_PORT;
    else process.env.NLP_SERVICE_PORT = prevPort;
    nlp.child.kill();
  }
});

/* ───────── 3. a service line's `Nos` unit keeps its quantity (R5) ────────── */

async function normalizeOnce(port, text) {
  const res = await fetch(`http://127.0.0.1:${port}/normalize`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
  const body = await res.json();
  if (!body.ok) throw new Error(`normalize failed for "${text}": ${body.error}`);
  return body.result;
}

test("A2 fix (R5): a service line's `Nos` unit survives the compose → NLP → pair chain", async () => {
  // The sentence the A2 loop composes for a service-only document: the file's own
  // UOM, verbatim. Before the fix the pair step had nothing to pair and emitted
  // `<PREFIX>QTY_MISSING` — a refusal that blames the user's sentence for a unit
  // the PIPELINE did not know, on a unit ERPNext itself ships.
  const sentence = "đặt mua 3 Nos Phí vận chuyển & bốc xếp từ Đại lý Cám Bình Dương";
  const nlp = await startNlp();
  try {
    const result = await normalizeOnce(nlp.port, sentence);
    assert.deepEqual(
      result.quantities.map((q) => [q.value, q.canonical_unit]),
      [[3, "nos"]],
      "`3 Nos` must come back as the quantity 3 with canonical unit `nos`",
    );
    // ...and it must stay a QUANTITY, never money (Nos is not a scale word).
    assert.equal(result.amount, null);

    const SERVICE = { item_code: "PHI-VAN-CHUYEN", item_name: "Phí vận chuyển & bốc xếp", stock_uom: "Nos" };
    const at = sentence.indexOf("Phí");
    const { lines, problems } = pairLinesPure({
      matched: [{ item: SERVICE, hit: 1, span: { start: at, end: at + SERVICE.item_name.length, phrase: SERVICE.item_name } }],
      quantities: result.quantities,
      codePrefix: "PO_",
    });
    assert.deepEqual(problems, [], `expected no problem, got ${JSON.stringify(problems)}`);
    assert.equal(lines.length, 1);
    // The NUMBER is the file's own — an alias must never rewrite it.
    assert.equal(lines[0].quantity.value, 3);
    assert.equal(lines[0].item.item_code, "PHI-VAN-CHUYEN");
  } finally {
    nlp.child.kill();
  }
});
