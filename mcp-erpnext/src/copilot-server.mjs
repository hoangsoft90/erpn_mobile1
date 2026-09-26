/**
 * Copilot MCP server — the tool dsh registers and calls (user task 2026-09-13).
 *
 * Flow per question (all stages already built in Phases 1-2, this file only
 * WIRES them):
 *
 *   text → HTTP 127.0.0.1:8787/normalize (Python vietnamese_nlp, locked bridge)
 *        → routeIntent()               (Phase 2 keyword router, no embeddings)
 *        → skill factory(mcp, knownIds)(Phase 2 skills, read-only guard)
 *        → client.callTool()           (Phase 2 client → mock or real ERPNext)
 *        → deterministic Vietnamese answer (NO LLM inside this pipeline leg)
 *
 * The LLM (dsh) sits ABOVE this: it decides to call `copilot_ask`, then phrases
 * the returned structured payload. Numbers shown to the user are copied
 * verbatim from ERPNext data — nothing recomputes money.
 *
 * Transport: MCP stdio (line-delimited JSON-RPC 2.0), the format dsh's
 * dsh-mcp-client registers (transport: stdio, command, args, env).
 */

import { createMcpClient, MOCK_SERVER } from "./client.mjs";
import { routeIntent, routeByCapability } from "./router.mjs";
// ── P3 (plan2_final §15): LLM classifier for sentences the keyword router misses ──
import { classifyIntent, classifierConfig } from "./classifier.mjs";
import { buildPaymentProposal, verbDirection } from "./skills/payment-write.mjs";
import { buildSalesOrderProposal } from "./skills/sales-order-write.mjs";
import { buildQuotationProposal } from "./skills/quotation-write.mjs";
import { buildPurchaseOrderProposal } from "./skills/purchase-order-write.mjs";
import { buildDeliveryProposal } from "./skills/delivery-write.mjs"; // P9-A2: reached via routeByCapability's delivery_write factory
import { buildPurchaseReceiptProposal } from "./skills/purchase-receipt-write.mjs"; // P9-B: reached via routeByCapability's purchase_receipt_write factory
import { buildSalesInvoiceProposal } from "./skills/sales-invoice-write.mjs"; // P9-D: reached via routeByCapability's sales_invoice_write factory
import { buildStockAdjustmentProposal } from "./skills/stock-adjustment-write.mjs"; // P9-E: the ONE write with no party — answered BEFORE any party resolution
import { buildSalesReturnProposal } from "./skills/sales-return-write.mjs"; // P9-F: a customer-party WRITE (like the invoice) whose entity is the ORIGINAL invoice
import { buildCustomerCreateProposal } from "./skills/customer-create.mjs"; // M1: the ONE write whose entity DOES NOT EXIST yet — answered BEFORE party resolution
// P8 (plan2_final §5 + §24.2): the authorization boundary. Server-side,
// contract-driven, never a prompt.
import { authorize, resolvePrincipal } from "./authorization.mjs";
// ── P4 (plan2_final §12 + §19): structured learning log for refusals/signals ──
import { logObservation } from "./learning-log.mjs";
// ── P5 (plan2_final §2 D2/D3/D8): dsh explicit opt-in gate — READ only ──
import { isDshContext, blockedInDshContext, dshWriteBlockedAnswer } from "./dsh-optin.mjs";
// ── P2 (plan2_final §12 + §14): uncertainty taxonomy + session context ──
import { SessionContext, CONTEXT_PROVENANCE, DEFAULT_CONTEXT_SCOPE } from "./session-context.mjs";
import { uncertaintyCopy, toUncertaintyCode, UNCERTAINTY_CODES } from "./uncertainty.mjs";
// ── A1 (plan3 Trụ A): the structured UI intent a READ answer carries so the
// client can offer a drill-down without classifying anything itself. Contract-
// driven (capabilities.json → ui_screens); returns null when the action has no
// declared screen.
import { uiIntentForAction } from "./read-views.mjs";

/**
 * One session-context per pipeline process. Keyed by NOTHING today (single
 * shop console); P8 (multi-user) keys it by session id — the API already takes
 * the instance, so the future change is at the call sites, not the store.
 */
const sessionContext = new SessionContext();
/**
 * NEXT6 (G3): context scope for a request = principal (+ conversation when the
 * caller supplied one). Server-authoritative — `opts.principal` is resolved by
 * the auth layer and never read from the request body, so one user's selected
 * customer can never seed another user's WRITE proposal.
 */
function contextScopeFor(opts = {}) {
  const user = opts?.principal?.user_id ?? "anonymous";
  const conv = typeof opts?.correlation?.conversation_id === "string" && opts.correlation.conversation_id
    ? opts.correlation.conversation_id
    : DEFAULT_CONTEXT_SCOPE;
  return `${user}\u0000${conv}`;
}
/** Test seam — lets a test reset context without touching the module. */
export function __resetSessionContext() {
  sessionContext.clear();
}
export function __sessionContext() {
  return sessionContext;
}

/**
 * Attach taxonomy copy to a refusal result (P2 §12). `error_code` stays the
 * raw pipeline code the tests already assert; `uncertainty` carries the
 * canonical code + Vietnamese message the client renders verbatim.
 * @param {object} result refusal-shaped result with error_code set
 * @returns {object} same result + `uncertainty` (only when mappable)
 */
function withUncertainty(result) {
  const canonical = toUncertaintyCode(result?.error_code);
  if (!canonical) return result;
  return { ...result, uncertainty: uncertaintyCopy(canonical, { detail: result?.reason ?? null }) };
}
import { realServerScript } from "./index.mjs";
import { buildProposal, readProposal } from "./action-proposal.mjs";
import { sanitizeUntrustedList, containsInstructionPattern } from "./untrusted-data.mjs";
import { __contract, getCapability, listRouting } from "./capability-contract.mjs";
import {
  ENTITY_ACCESSORS,
  ENTITY_STATES,
  classifyEntityResolution,
  classifyResolution,
  entityPolicy,
  pickFromCandidates,
  pickerCandidates,
  pickerForRowsByText,
  pickerForText,
  resolveEntityByText,
} from "./entity-resolution.mjs";
// ── B1 (plan3_review3 §B.3): UOM là policy an toàn — tên đơn vị lấy từ ERPNext,
// hệ số lấy từ ERPNext, và mọi quy đổi phải HIỆN RA chứ không áp ngầm.
import { resolveLineUom, uomPolicy, unitFormFromNlp } from "./uom.mjs";

/**
 * ERPNext target selection (user decision 2026-09-14: "khi tôi cung cấp
 * ERPNEXT_URL/API_KEY/API_SECRET thật, chỉ cần đổi endpoint, không phải
 * viết lại logic").
 *
 * - All three ERPNEXT_* env vars present -> spawn the PINNED real server.
 * - No ERPNEXT_* AND `COPILOT_MOCK_OK=1` -> mock (explicit opt-in; the ONLY
 *   way to reach the fixture server).
 * - No ERPNEXT_* and no explicit opt-in -> THROW `ERPNEXT_NOT_CONFIGURED`.
 *   Missing configuration is a FAULT, not a licence to answer from fixtures
 *   (issue1: `mock-server.mjs` hard-codes "Nguyễn Thị Lan", so a silent mock
 *   fallback manufactured a customer that does not exist in real ERPNext —
 *   `dsh` reported it as fact). This is the last fail-OPEN branch in the
 *   system; every other guard (idempotency, entity resolution, contract
 *   loader) already refuses when unsure.
 * - Partial config, malformed URL, or non-http(s) URL -> hard error (a
 *   wrong-target answer is worse than a refused start).
 *
 * Secrets stay in the environment (.env, gitignored) — never in cordis patch
 * files or anything committed. Since mock is now opt-in, an operator who
 * forgets to export ERPNEXT_* gets a loud refusal instead of fabricated data.
 */
export function pickServerScript(env = process.env) {
  const { ERPNEXT_URL: url, ERPNEXT_API_KEY: key, ERPNEXT_API_SECRET: secret } = env;
  if (!url && !key && !secret) {
    if (env.COPILOT_MOCK_OK !== "1") {
      throw new Error(
        "ERPNEXT_NOT_CONFIGURED: thiếu ERPNEXT_URL/ERPNEXT_API_KEY/ERPNEXT_API_SECRET " +
          "và COPILOT_MOCK_OK không phải \"1\" — TỪ CHỐI khởi động thay vì âm thầm dùng " +
          "dữ liệu giả. Nếu đây THẬT SỰ là môi trường test, set COPILOT_MOCK_OK=1 một " +
          "cách tường minh (không bao giờ đặt ở môi trường có người dùng thật).",
      );
    }
    return MOCK_SERVER;
  }
  const missing = ["ERPNEXT_URL", "ERPNEXT_API_KEY", "ERPNEXT_API_SECRET"].filter((k) => !env[k]);
  if (missing.length > 0) {
    throw new Error(`PARTIAL_ERPNEXT_CONFIG: set all three or none — missing: ${missing.join(", ")}`);
  }
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`INVALID_ERPNEXT_URL: ${url}`);
  }
  if (!/^https?:$/.test(parsed.protocol)) {
    throw new Error(`INVALID_ERPNEXT_URL: protocol must be http(s), got ${parsed.protocol}`);
  }
  return realServerScript();
}

/**
 * Which ERPNext this process is actually pointed at: `"REAL"` when a host is
 * configured, `"MOCK"` when the fixture was opted into.
 *
 * One home for the rule, because two audiences now need the SAME answer: the
 * operator's startup line in http-ask.mjs and the drawer's footer, which the
 * shop owner reads before trusting a number. They must never disagree, and a
 * client cannot infer it — the gateway URL tells the app where the COPILOT is,
 * not what the copilot reads.
 *
 * Deliberately the same PRESENCE-only test pickServerScript uses (not a
 * connectivity probe): a configured-but-unreachable host is still REAL, and the
 * failure surfaces as an ERPNext error rather than a quiet fixture answer.
 * Does NOT name the fixture constant — `test/mock-optin.test.mjs` pins every
 * reference to it, and this helper must stay a pure label.
 */
export function erpTargetLabel(env = process.env) {
  return env.ERPNEXT_URL ? "REAL" : "MOCK";
}

let NLP_PORT = process.env.NLP_SERVICE_PORT || "8787";
let NLP_URL = `http://127.0.0.1:${NLP_PORT}/normalize`;

/** Test seam — the NLP port is read from env at module load, but in-process
 * tests (dsh-gateway.test.mjs) start their fake NLP on an ephemeral port
 * afterwards. Same pattern as __resetSessionContext. Production code must
 * NEVER call this. */
export function __setNlpServicePortForTest(port) {
  NLP_PORT = String(port);
  NLP_URL = `http://127.0.0.1:${NLP_PORT}/normalize`;
}

/** Wait for the Python bridge (dsh may start us before the service is up). */
async function waitForNlpService(timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${NLP_PORT}/health`);
      if (res.ok) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

/** Call the Python normalize bridge; throws when the service is unreachable.
 * Exported for the DSH gateway's WRITE pre-screen (dsh-gateway.mjs) — the SAME
 * seam, not a second normalizer. */
export async function normalizeText(text) {
  // AbortSignal timeout: Node's undici fetch can hang past TCP connect when
  // the peer accepts but never answers (half-open socket) — without an
  // AbortSignal the /ask request would hang forever (no Node default).
  const res = await fetch(NLP_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`NLP_SERVICE_ERROR ${res.status}: ${body.slice(0, 200)}`);
  }
  const json = await res.json();
  if (!json.ok) throw new Error(`NLP_SERVICE_ERROR: ${json.error}`);
  return json.result;
}

/** 2500000 -> "2.500.000" (fixed-point, no ICU dependency). */
export function formatVnd(n) {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ".");
}

/**
 * Customer-name candidates from cleaned text — EVERY token substring (not just
 * prefixes: the customer name usually sits mid-utterance — "cho biết nợ của
 * Trang trại Minh Anh"), longest first. Candidates are pre-filtered by the
 * caller against the customer list (batch-accuracy result9 finding: prefix-only
 * candidates made names like "Trang trại Minh Anh" unreachable).
 * Fuzzy matching stays a Phase 6 concern; this is deliberately crude and honest.
 */
/**
 * Vocatives that are never a customer NAME on their own. Mirrors the Python
 * stripper (src/vietnamese_nlp/kinship.py): the stripper only removes a title
 * at the START of the utterance (mid-utterance titles are kept because they
 * are usually part of a stored name — batch finding b12), so a title like
 * "chị" survives in "thu tiền cho chị Lan" and must not be treated as a name.
 *
 * Real failure this guards (2026-09-16, found while writing faq.md): the demo
 * site has a customer literally named "Chị Tư — thầu nhỏ". The fragment "chị"
 * matched EXACTLY ONE customer, so the app answered a question about
 * "chị Lan" with Chị Tư's account — a confident wrong-customer answer with no
 * ambiguity flag. A title may only match as part of a longer fragment.
 */
const KINSHIP_TITLES = new Set([
  "anh", "chị", "em", "cô", "chú", "bác", "ông", "bà", "cậu", "dì", "mợ",
  "thím", "dượng", "bố", "ba", "má", "mẹ", "con", "cháu", "cụ", "thầy",
]);

export function nameCandidates(cleanedText) {
  const tokens = cleanedText.split(/\s+/).filter(Boolean);
  const cands = [];
  for (let start = 0; start < tokens.length; start++) {
    for (let len = tokens.length - start; len >= 1; len--) {
      cands.push(tokens.slice(start, start + len).join(" "));
    }
  }
  return [...new Set(cands)];
}

/**
 * Fetch the customer list ONCE, then score every candidate name substring
 * against it. (The previous per-candidate findCustomer() made up to 100 MCP
 * round-trips per question; against the real server that is minutes per
 * question — batch-accuracy result9 finding.) Same safety rule as before:
 * a candidate matching EXACTLY ONE customer wins; only when no candidate is
 * unique does the first multi-match win, flagged `ambiguous: true`.
 * Asking beats answering for the wrong "Khách smoke".
 */
/**
 * Tokens the ROUTER uses to pick an intent (from the capability contract) —
 * they can never be part of a customer's name. Rule 2b needs this to tell
 * "the user typed more NAME" (block the match) from "the user typed the intent
 * words" (do not block). Sourced from the contract, not duplicated here, so a
 * new group's vocabulary is covered automatically. Lazily built + cached.
 */
let INTENT_TOKENS = null;
function intentTokens() {
  if (!INTENT_TOKENS) {
    INTENT_TOKENS = new Set();
    for (const group of listRouting()) {
      for (const keyword of group?.keywords ?? []) {
        for (const word of String(keyword).toLowerCase().split(/\s+/).filter(Boolean)) {
          INTENT_TOKENS.add(word);
        }
      }
    }
  }
  return INTENT_TOKENS;
}

/**
 * Same fragment order as nameCandidates(), but keeping WHERE each fragment came
 * from (token index + length) so the scorer can inspect the token that FOLLOWS
 * a matched fragment. Separate from nameCandidates() because that one is
 * exported and used by pickers/callers that only want the strings.
 */
function nameCandidatesWithPosition(cleanedText) {
  const tokens = cleanedText.split(/\s+/).filter(Boolean);
  const out = [];
  for (let start = 0; start < tokens.length; start++) {
    for (let len = tokens.length - start; len >= 1; len--) {
      out.push({ cand: tokens.slice(start, start + len).join(" "), start, len });
    }
  }
  return out;
}

/**
 * B4 — the generic half of the name resolver, extracted so the SUPPLIER path
 * is not a second copy of it. The scoring rules are the ones the customer path
 * has always used (they are about Vietnamese names, not about customers):
 *
 *   1. an exact hit on the display name or the id wins outright;
 *   2. otherwise a substring hit that is unique wins — UNLESS the token the user
 *      typed right after the fragment appears nowhere in that row (rule 2b);
 *   3. a multi-hit fragment with a SPACE becomes the ambiguous fallback (the
 *      user typed something long enough to mean someone);
 *   4. a multi-hit SINGLE-WORD fragment yields NO row and reports the colliders
 *      — the Phase 6 "≥2 candidate gần nhau" case, which must ASK.
 *
 * Rule 2b exists because rule 2 answered about the WRONG customer with no
 * ambiguity flag on real data (issue1 follow-up, 2026-09-21): the site has a
 * customer "Nguyễn Thị B" and no "Nguyễn Thị Lan", so asking about
 * "Nguyễn Thị Lan" matched the fragment "Nguyễn Thị" uniquely and answered
 * "Nguyễn Thị B không còn nợ gì" — the distinguishing token "Lan" was silently
 * dropped. KINSHIP_TITLES already guarded this for titles ("chị Lan" → "Chị
 * Tư"); 2b extends the same idea to ordinary name prefixes.
 *
 * @param {object[]} rows master-data rows already read from ERPNext
 * @param {string} cleanedText
 * @param {{nameOf: (row:object)=>string|null}} accessors
 * @returns {{row:object|null, ambiguous:boolean, candidates:string[]}}
 */
/**
 * P9-C fix (measured 2026-09-24) — the shortest fragment the SUBSTRING pass may
 * match a name on.
 *
 * WHY: the substring pass asks `rowName.includes(fragment)` over EVERY
 * contiguous token span of the sentence, so a fragment taken out of the middle
 * of an ordinary word can match a row by accident. Measured on the site's own
 * supplier data: the sentence `xử lý 500 nghìn cho nguyễn thị lan` yields the
 * span `lý` (from the verb “xử lý”), and `đại lý cám bình dương`.includes(`lý`)
 * is TRUE — so `resolveSupplier` returned the supplier “Đại lý Cám Bình Dương”
 * for a sentence that names a CUSTOMER. On the payment routes that flipped the
 * direction guard to `PAYMENT_DIRECTION_AMBIGUOUS` and refused a legitimate
 * pay-out with a message claiming the name was in both books.
 *
 * The site really does have that supplier name (A0 probe, MST 0300000002), so
 * this was live, not a fixture artefact: any money sentence containing “xử lý”
 * — a very common verb — was refused.
 *
 * 3 characters, not 2, because the colliding fragment is a TWO-character word:
 * Vietnamese name fragments worth resolving (“Lan”, “Hải”, “Dương”) are longer,
 * and a genuinely short name is still found by the EXACT pass above (which
 * counts the whole token span, not a substring of it). Shortening the fuzzy
 * pass therefore only ever turns a wrong-direction guess into a refusal — the
 * safe side for money.
 */
const MIN_SUBSTRING_FRAGMENT = 3;

function resolvePartyFromList(rows, cleanedText, { nameOf }) {
  // Bare kinship titles are dropped as candidates (see KINSHIP_TITLES). They
  // are handled BEFORE scoring so they can neither win as a unique hit nor set
  // the ambiguity fallback.
  const cands = nameCandidates(cleanedText).filter((c) => !KINSHIP_TITLES.has(c.toLowerCase()));
  let fallback = null;
  let multiHitNoPick = null; // { fragment, candidates: [display names...] }
  for (const cand of cands) {
    const hits = rows.filter(
      (r) =>
        String(nameOf(r) ?? "").toLowerCase() === cand.toLowerCase() ||
        String(r?.name ?? "").toLowerCase() === cand.toLowerCase(),
    );
    if (hits.length === 1) return { row: hits[0], ambiguous: false, candidates: [] };
    if (hits.length > 1 && !fallback) fallback = hits[0];
  }
  // Rule 2b: a start position whose matched fragment is followed by a token the
  // row does not contain is poisoned for the WHOLE position — shorter fragments
  // there ("Nguyễn") would re-pick the same wrong row.
  const tokens = cleanedText.split(/\s+/).filter(Boolean);
  const blockedStarts = new Set();
  for (const { cand, start, len } of nameCandidatesWithPosition(cleanedText).filter(
    (c) => !KINSHIP_TITLES.has(c.cand.toLowerCase()),
  )) {
    if (blockedStarts.has(start)) continue;
    const low = cand.toLowerCase();
    // See MIN_SUBSTRING_FRAGMENT: a 1–2 character span is never evidence of a
    // person, but it matches names by accident (`lý` inside “Đại lý …”).
    if (low.length < MIN_SUBSTRING_FRAGMENT) continue;
    const hits = rows.filter(
      (r) =>
        String(nameOf(r) ?? "").toLowerCase().includes(low) ||
        String(r?.name ?? "").toLowerCase().includes(low),
    );
    if (hits.length === 1) {
      const next = tokens[start + len];
      if (next !== undefined) {
        const rowNames = `${nameOf(hits[0]) ?? ""} ${hits[0]?.name ?? ""}`.toLowerCase();
        const nextLow = next.toLowerCase();
        // Per FIELD, never the concatenation: joining display name + id makes the
        // id look like "name continues" (caught by the spoken-amount test, where
        // the row's own id was read as an over-typed continuation).
        const rowFields = [
          String(nameOf(hits[0]) ?? "").toLowerCase(),
          String(hits[0]?.name ?? "").toLowerCase(),
        ];
        const rowContinues = rowFields.some((field) => {
          const at = field.indexOf(low);
          return at >= 0 && field.slice(at + low.length).trim().length > 0;
        });
        // Block ONLY when all three hold:
        //   1. the ROW's name continues after the match (the fragment is a
        //      strict prefix of the customer's name) — a complete-name match
        //      followed by sentence words ("…Lan 500 ngàn") is NOT suspicious;
        //   2. the token the user typed next is name-like (not a number —
        //      amount/quantity tokens are always digits by the time the text is
        //      normalised, but guard anyway) and not router intent vocabulary;
        //   3. that token appears nowhere in the row.
        // Together: the user named someone whose name keeps going differently.
        const isNameLike = !/\d/.test(nextLow) && !intentTokens().has(nextLow);
        if (rowContinues && isNameLike && !rowNames.includes(nextLow)) {
          // Refuse (ASK / MISSING) rather than answer about the wrong customer.
          blockedStarts.add(start);
          continue;
        }
      }
      return { row: hits[0], ambiguous: false, candidates: [] };
    }
    if (hits.length > 1) {
      if (!fallback && cand.includes(" ")) fallback = hits[0];
      if (!multiHitNoPick && !cand.includes(" ")) {
        multiHitNoPick = { fragment: cand, candidates: hits.map((h) => nameOf(h) ?? h.name) };
      }
    }
  }
  if (fallback) return { row: fallback, ambiguous: true, candidates: [] };
  if (multiHitNoPick) return { row: null, ambiguous: true, candidates: multiHitNoPick.candidates };
  return { row: null, ambiguous: false, candidates: [] };
}

export async function resolveCustomer(skills, cleanedText) {
  const list = await skills.findCustomer("");
  const customers = list.data?.data ?? [];
  const r = resolvePartyFromList(customers, cleanedText, { nameOf: (c) => c.customer_name ?? c.name });
  return { customer: r.row, ambiguous: r.ambiguous, candidates: r.candidates };
}

/**
 * B4 — the SUPPLIER twin of resolveCustomer (same rules, the other master list).
 *
 * Kept as a separate entry point rather than a parameter on resolveCustomer so a
 * caller cannot silently resolve a purchase party against the customer list: the
 * function name is what the purchase path reads, and the list it reads is fixed
 * here.
 */
/**
 * P9-C — the utterance with the SPOKEN AMOUNT/QUANTITY phrases blanked out.
 *
 * MEASURED 2026-09-23 (this is the reason the pay path exists at all): the name
 * matcher builds candidates from EVERY contiguous token span, so the number that
 * follows a name becomes part of it. On the SALE side the utterance
 * "trả tiền NCC Hà Tiên 2 triệu" resolved the CUSTOMER master to “Trần Văn Hai”
 * (via the stray tokens) while the SUPPLIER master matched “Hà Tiên 2” — a
 * different supplier than the one said out loud. Blanking the amount phrases
 * first removes the contamination at its source: after it, the same sentence
 * resolves to no customer at all and to “Hà Tiên”.
 *
 * Applied to the PAYMENT routes only (a money phrase next to a party name is
 * exactly the shape that moves money), so every other route keeps the resolution
 * it has always had. The phrases come from Phase 1's own extractors, so this is
 * not a second parser — it removes what the pipeline already identified.
 *
 * @param {string} text normalized text (nlp.text)
 * @param {object} nlp NormalizedResult from the Python bridge
 */
function textWithoutAmounts(text, nlp) {
  let out = String(text ?? "");
  const raws = [...(nlp?.money_matches ?? []), ...(nlp?.quantities ?? [])]
    .map((m) => m?.raw)
    .filter((r) => typeof r === "string" && r.trim().length > 0)
    .sort((a, b) => b.length - a.length);
  for (const raw of raws) {
    const at = out.toLowerCase().indexOf(raw.toLowerCase());
    if (at >= 0) out = `${out.slice(0, at)} ${out.slice(at + raw.length)}`;
  }
  return out;
}

export async function resolveSupplier(skills, cleanedText) {
  const list = await skills.findSupplier({});
  const suppliers = list.data?.data ?? [];
  const r = resolvePartyFromList(suppliers, cleanedText, { nameOf: (s) => s.supplier_name ?? s.name });
  return { supplier: r.row, ambiguous: r.ambiguous, candidates: r.candidates };
}

/**
 * M1 — the proposed NEW-CUSTOMER name from a create-customer command: the text
 * minus the leading command keywords. Everything after "thêm khách"/"tạo
 * khách"/"khách mới" IS the name (the skill normalizes + pre-checks it; contact
 * slots come from the app's form, never from parsing prose). Empty when the
 * sentence names nobody — the skill refuses with CC_NAME_MISSING, which is the
 * correct answer for "thêm khách" said alone.
 *
 * @param {string} text normalized text (Phase 1 output)
 */
function customerCreateNameFrom(text) {
  const m = String(text ?? "")
    .replace(/^\s*(th[eê]m|t[aạ]o)\s+kh[aá]ch\s*(h[aà]ng)?\s*/i, "")
    .replace(/^\s*kh[aá]ch\s*h[aà]ng\s*m[ơợ][iớ]\s*/i, "")
    .replace(/^\s*new customer\s*/i, "")
    .replace(/[.?!]+\s*$/, "")
    .trim();
  return m || null;
}

function reply(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
}
function replyError(id, code, message) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }) + "\n");
}

/** Core pipeline — exported for tests; the MCP handler is a thin shell over it. */
export async function answerQuestion(rawText, opts = {}) {
  // ── Degraded mode, plan2_final §13 ─────────────────────────────────────────
  // When the Python normalizer is down we cannot trust the AMOUNT/DATE parse,
  // and a write must never be proposed from a guessed number. So the whole
  // question fails closed with NLP_UNAVAILABLE and **no proposal at all** —
  // rather than a best-effort answer that might build a payment for the wrong
  // sum. (``proposal: null`` is the contract with the client: nothing to confirm.)
  let nlp;
  try {
    nlp = await normalizeText(rawText);
  } catch (err) {      return withUncertainty({
        question: rawText,
        normalized: null,
        routed: null,
        answer: null,
        error_code: "NLP_UNAVAILABLE",
        reason:
          `dịch vụ chuẩn hoá tiếng Việt (:8787) không trả lời (${err?.message ?? err}) — KHÔNG đề xuất ghi gì, vì số tiền/ngày sẽ phải đoán. Thử lại sau khi service lên.`,
        proposal: null,
      });
  }
  const mcp = createMcpClient({ serverScript: pickServerScript() }); // real when ERPNEXT_* set; mock ONLY with explicit COPILOT_MOCK_OK=1, else throws
  try {
    await mcp.initialize();
    const knownIds = new Set();
    let route = routeIntent(nlp.text);

    // ── P3 (plan2_final §15): when the keyword router does not understand a
    // sentence, ask the LLM classifier ONCE (bounded timeout) to name the
    // contract intent, then route through the SAME skill/Safety path. The
    // classifier only chooses WHICH group — confirm/authz/amount policy are
    // unchanged, and IDs still come only from the Entity Resolver. If the LLM
    // is disabled/down/slow/malformed, nothing changes: we fall through to the
    // rule-only UNKNOWN_INTENT below (never a blind 500).
    if (!route) {
      const classified = await classifyIntent(nlp.text, { config: classifierConfig() });
      if (classified.ok && classified.intent && !classified.low_confidence) {
        const byCapability = routeByCapability(classified.intent);
        if (byCapability) route = byCapability;
      } else if (classified.ok) {
        // The model answered but is not confident enough to act on a guess —
        // ask the user again (P2 taxonomy copy), not a bare "I don't know".
        return withUncertainty({
          question: rawText,
          normalized: nlp,
          routed: false,
          answer: null,
          error_code: "LOW_CONFIDENCE",
          reason: classified.intent
            ? `phân loại chưa đủ chắc (intent=${classified.intent}, confidence=${classified.confidence}) — cần nói rõ hơn`
            : "phân loại chưa xác định được ý định — cần nói rõ hơn",
          needs_clarification: true,
          classifier: { used: true, intent: classified.intent ?? null, confidence: classified.confidence },
          proposal: null,
        });
      }
    }

    if (!route) {
      return withUncertainty({
        question: rawText,
        normalized: nlp,
        routed: false,
        answer: null,
        error_code: "UNKNOWN_INTENT",
        reason: "no skill route matched — Phase 2 router covers customer/sales/payment/inventory only",
      });
    }

    // P0 (plan2_final §8): a FORBIDDEN capability (document.delete) is refused
    // here, at the top of the pipeline — it must never reach a skill, never
    // produce a proposal and never touch ERPNext. Declared in the contract so
    // the refusal is explicit instead of a silent misroute into a READ group.
    // ORDER MATTERS: the forbidden check runs BEFORE the stub check below —
    // document.delete is both forbidden AND skill:null, and its refusal must
    // stay FORBIDDEN_IN_AI_PATH (the safety code), never "unimplemented".
    if (route.forbidden) {
      return {
        question: rawText,
        normalized: nlp,
        routed: { group: route.group, matched: route.matched, capability: route.capability },
        answer: null,
        error_code: "FORBIDDEN_IN_AI_PATH",
        reason: `thao tác "${route.capability}" bị CẤM trên đường AI (plan2_final §8) — dùng UI ERPNext nếu thật sự cần; không có đề xuất nào được tạo`,
        proposal: null,
      };
    }

    // ── P2 (plan2_final §12): an understood intent WITHOUT a skill is a
    // different refusal than "did not understand" — surface
    // KNOWN_INTENT_UNIMPLEMENTED so the learning loop (P4) can count them.
    // Runs AFTER the forbidden check (see the order note above).
    if (route.capability) {
      const cap = getCapability(route.capability);
      if (cap?.status === "stub" || cap?.skill === null) {
        return withUncertainty({
          question: rawText,
          normalized: nlp,
          routed: { group: route.group, matched: route.matched, capability: route.capability },
          answer: null,
          error_code: "KNOWN_INTENT_UNIMPLEMENTED",
          reason: `hiểu yêu cầu "${route.capability}" nhưng skill chưa có — đã ghi nhận`,
          proposal: null,
        });
      }
    }
    // ── P5 (plan2_final §2 D8): when THIS process was spawned by dsh (explicit
    // opt-in "Phân tích bằng AI"), it may drive READ capabilities only. A
    // question that would produce an executable (WRITE) proposal is refused
    // BEFORE any skill/ERPNext touch — fail closed, no partial work. The /ask
    // HTTP path never sets COPILOT_DSH_CONTEXT, so the main app is unchanged.
    if (isDshContext(opts.env) && blockedInDshContext(route)) {
      return withUncertainty(dshWriteBlockedAnswer(rawText));
    }
    // ── P8 (plan2_final §5): AUTHORIZATION, server-side and contract-driven,
    // BEFORE any skill touches ERPNext. An account that may not run this
    // capability gets no proposal at all — so there is nothing to confirm and
    // nothing that could later execute. Order: after entity-independent
    // refusals (forbidden/stub/dsh) so those keep their specific codes, and
    // before route.factory() so a denied user triggers ZERO ERPNext reads.
    if (route.capability) {
      const authz = authorize(route.capability, {
        principal: opts.principal ?? resolvePrincipal({ env: opts.env }),
        company: opts.company,
        env: opts.env,
      });
      if (!authz.ok) {
        return withUncertainty({
          question: rawText,
          normalized: nlp,
          routed: { group: route.group, matched: route.matched, capability: route.capability },
          answer: null,
          reason: authz.error,
          error_code: authz.code,
          proposal: null,
        });
      }
    }
    const skills = route.factory(mcp, knownIds);

    // ── M1: the CUSTOMER-CREATE path — answered HERE, before the party
    // machinery, and for the SAME structural reason as P9-E/P9-F: every guard
    // below answers "which EXISTING customer/supplier is this about?", but a
    // create-customer sentence names a customer WHO IS NOT THERE YET. Routed
    // through the party guards, the name would resolve NO_MATCH and the request
    // would die as MISSING_ENTITY — the exact dead end this feature exists to
    // replace with a card + button. There is no picker on this path: the
    // skill's own duplicate pre-check IS the entity resolution (exact/fuzzy hit
    // ⇒ refuse with the existing customer; no hit ⇒ the proposal is built).
    if (route.group === "customer_create_write") {
      try {
        const built = await buildCustomerCreateProposal(skills, {
          // The name is the text minus the command verbs — everything after the
          // keyword IS the proposed name (contact slots come from the app form,
          // not from parsing phone numbers out of prose).
          name: customerCreateNameFrom(nlp.text),
          mobile: null,
          tax: null,
        }, { nlp, text: nlp.text });
        const p = built.proposal.params;
        const answer =
          `Đề xuất tạo khách hàng MỚI: ${p.customer_name}` +
          (p.mobile_no ? ` · SĐT ${p.mobile_no}` : "") +
          (p.tax_id ? ` · MST ${p.tax_id}` : "") +
          " — kiểm tra TÊN rồi bấm [Tạo khách mới] để tạo Customer trên ERPNext (record thật; KHÔNG tự tạo đơn/phiếu thu cho khách này).";
        return {
          question: rawText,
          normalized: nlp,
          routed: { group: route.group, matched: route.matched, capability: route.capability },
          offer_create_customer: {
            name: p.customer_name,
            mobile_no: p.mobile_no ?? null,
            tax_id: p.tax_id ?? null,
          },
          warnings: built.warnings,
          answer,
          proposal: built.proposal,
        };
      } catch (err) {
        // A duplicate/fuzzy hit is an ANSWER naming the EXISTING customer —
        // never a 500, and never a card.
        const code = err?.code ?? null;
        return withUncertainty({
          question: rawText,
          normalized: nlp,
          routed: { group: route.group, matched: route.matched, capability: route.capability },
          answer: null,
          reason: `không tạo được đề xuất thêm khách: ${err?.message ?? err}`,
          error_code: code,
          existing_customer: err?.existing_id ? { id: err.existing_id, name: err.existing_name ?? null } : null,
          uncertainty: uncertaintyCopy(
            toUncertaintyCode(code) ?? UNCERTAINTY_CODES.BUSINESS_VALIDATION_FAILED,
            { detail: err?.message ?? String(err) },
          ),
          proposal: null,
        });
      }
    }

    // ── P9-E: the STOCK WRITE-OFF path — the ONE write in this project whose
    // "entity" is not a party at all, it is an ITEM plus the room it leaves. It
    // is answered HERE, before the party machinery below, for a reason that is
    // structural rather than cosmetic: every guard after this point exists to
    // answer "which customer/supplier is this about?", and "which KHO?" is not
    // that question. Routing a write-off through them would refuse every valid
    // sentence with MISSING_ENTITY (measured: the generic party guard fires on
    // any route without a partyRow), or worse, resolve the ITEM against the
    // customer list.
    if (route.group === "stock_adjustment_write") {
      try {
        const built = await buildStockAdjustmentProposal(skills, {}, { nlp, text: nlp.text });
        const p = built.proposal.params;
        const answer =
          `Đề xuất XUẤT HỦY NHÁP: ${p.qty} ${p.uom ?? ""} ${p.item_name} ở ${p.warehouse} — ` +
          `kiểm tra SỐ LƯỢNG và KHO rồi bấm [Xác nhận] để tạo phiếu xuất kho NHÁP ` +
          `(KHÔNG tự submit, CHƯA trừ tồn kho — chỉ submit trên ERPNext mới trừ thật).`;
        return {
          question: rawText,
          normalized: nlp,
          routed: { group: route.group, matched: route.matched, capability: route.capability },
          // No `customer` key on purpose: a write-off is about goods, and a
          // client that found a party here would show it on the card.
          item: { id: p.item_code, name: p.item_name },
          quantity: { qty: p.qty, uom: p.uom ?? null },
          warehouse: p.warehouse,
          warnings: built.warnings,
          answer,
          proposal: built.proposal,
        };
      } catch (err) {
        // A refusal is an ANSWER: which item? how much? WHICH WAREHOUSE? more
        // than there is on the shelf? — never a 500, and never a card. The
        // contract's own code travels with it so the client can classify it.
        const code = err?.code ?? null;
        return withUncertainty({
          question: rawText,
          normalized: nlp,
          routed: { group: route.group, matched: route.matched, capability: route.capability },
          answer: null,
          reason: `không tạo được đề xuất xuất hủy: ${err?.message ?? err}`,
          error_code: code,
          uncertainty: uncertaintyCopy(
            toUncertaintyCode(code) ?? UNCERTAINTY_CODES.BUSINESS_VALIDATION_FAILED,
            { detail: err?.message ?? String(err) },
          ),
          proposal: null,
        });
      }
    }

    // ── P9-F: the RETURN path — like P9-E, answered HERE, before the party
    // machinery, and for the same structural reason. Every guard below answers
    // "which customer/supplier is this about?", but a return's entity is the
    // ORIGINAL INVOICE: the customer is read FROM that invoice by the builder.
    // Routed through the party guards, a valid sentence was refused as
    // ENTITY_PICK_REQUIRED — MEASURED 2026-09-23: "trả hàng 2 bao cám heo theo
    // hoá đơn ACC-SINV-…" was treated as a CUSTOMER NAME (fuzzy match, whole
    // sentence), because the sentence names no customer at all.
    if (route.group === "sales_return_write") {
      // The invoice number is the ONE reference this path needs, and it must
      // come from the sentence VERBATIM (never derived from an amount: the NLP
      // layer reads "00049" as an amount of 49 — see the probe of the same day).
      const invoiceRef =
        nlp.text.match(/(?:ACC-SINV|SINV)[-\w.]*/i)?.[0] ??
        nlp.text.match(/h[oó]a [dđ][oơ]n\s+([\w\-.]+)/i)?.[1] ??
        null;
      try {
        const built = await buildSalesReturnProposal(
          skills,
          { invoice: invoiceRef },
          { nlp, text: nlp.text },
        );
        const lines = built.proposal.params.lines;
        const against = built.proposal.params.return_against;
        const lineText = lines
          .map((l) => `${l.qty} ${l.uom ?? ""} ${l.item_name}`.trim())
          .join(" + ");
        const answer =
          `Đề xuất PHIẾU TRẢ HÀNG NHÁP theo hoá đơn ${against} cho ${built.proposal.entity.name}: ${lineText} — ` +
          "kiểm tra SỐ LƯỢNG, MẶT HÀNG và HOÁ ĐƠN GỐC rồi bấm [Xác nhận] để tạo phiếu trả NHÁP " +
          "(KHÔNG tự submit, CHƯA nhận lại kho / CHƯA ghi công nợ — chỉ submit trên ERPNext mới nhận hàng thật).";
        return {
          question: rawText,
          normalized: nlp,
          routed: { group: route.group, matched: route.matched, capability: route.capability },
          // The customer travels on the answer (read from the INVOICE, not from
          // the sentence) so the card can show who the goods go back from.
          customer: { id: built.proposal.entity.id, name: built.proposal.entity.name },
          return_against: against,
          lines,
          warnings: built.warnings,
          answer,
          proposal: built.proposal,
        };
      } catch (err) {
        // A refusal is an ANSWER: which invoice? submitted? what is on it? how
        // much is still returnable? — never a 500, and never a card.
        const code = err?.code ?? null;
        return withUncertainty({
          question: rawText,
          normalized: nlp,
          routed: { group: route.group, matched: route.matched, capability: route.capability },
          answer: null,
          reason: `không tạo được đề xuất trả hàng: ${err?.message ?? err}`,
          error_code: code,
          uncertainty: uncertaintyCopy(
            toUncertaintyCode(code) ?? UNCERTAINTY_CODES.BUSINESS_VALIDATION_FAILED,
            { detail: err?.message ?? String(err) },
          ),
          proposal: null,
        });
      }
    }

    // Inventory needs no customer. When the question names an item (e.g.
    // "cám gà còn tồn kho bao nhiêu"), filter the balance rows to that item
    // — dumping the whole warehouse list was a batch-accuracy finding (b13–15).
    // Real item_names are longer than what people say ("Cám gà thịt 25kg"),
    // so matching uses word-PREFIXES of the stored name, longest first.
    if (route.group === "inventory") {
      const inv = await skills.listInventory({});
      const allRows = inv.data?.data ?? [];
      const low = nlp.text.toLowerCase();
      let named = [];
      let items = [];
      try {
        items = (await skills.findItem("")).data?.data ?? []; // "" = all items
        // Two passes: score each item by its LONGEST matching word-prefix
        // phrase, then keep only the items at the overall best length —
        // otherwise "cám gà ..." also matched bare "cám" for heo/vịt items.
        let bestLen = 0;
        const scored = [];
        for (const it of items) {
          const words = String(it.item_name ?? it.item_code ?? "")
            .toLowerCase()
            .split(/\s+/)
            .filter(Boolean);
          let hit = 0;
          for (let len = words.length; len >= 1; len--) {
            if (low.includes(words.slice(0, len).join(" "))) {
              hit = len;
              break;
            }
          }
          if (hit > 0) {
            scored.push({ it, hit });
            if (hit > bestLen) bestLen = hit;
          }
        }
        named = scored.filter((s) => s.hit === bestLen).map((s) => s.it);
      } catch {
        // item list unavailable → answer unfiltered rather than crashing
      }
      let rows = allRows;
      let note = "";
      if (named.length === 1) {
        const code = named[0].item_code ?? named[0].name;
        rows = allRows.filter((r) => r.item_code === code);
      } else if (named.length > 1) {
        note = "⚠️ tên vật tư khớp nhiều mặt hàng — hiển thị tất cả";
      }
      // ── B1: name the ITEM resolution state, then apply the contract policy —
      // the same §4.1/§4.3 shape the customer path already uses, so "matched
      // 3 mặt hàng" is a STATE with a policy (offer the picker) instead of only
      // a warning line. The matcher itself is untouched: it is the one measured
      // against real data (batch-accuracy b13–b15), this only classifies it.
      const itemFrags = nameCandidates(nlp.text).filter((c) => c.trim().length >= 2);
      const itemClass = classifyEntityResolution(
        {
          entity: named.length === 1 ? named[0] : null,
          ambiguous: named.length > 1,
          candidates: named.length > 1 ? named.map((it) => it.item_name ?? it.item_code) : [],
        },
        { ...ENTITY_ACCESSORS.item, candidates: itemFrags },
      );
      const itemRule = entityPolicy(
        itemClass.state,
        getCapability("stock.balance"),
        __contract.defaults?.entity_policy ?? null,
      );

      // ── B1: the LINE UNIT. Only when the utterance actually names a unit do
      // we read the UOM table + factors (cost control); otherwise the answer is
      // byte-for-byte what it was before, and the default unit travels in the
      // structured `uom` block instead of being appended to the prose.
      let uomInfo = null;
      if (named.length === 1) {
        // The Python layer's own quantity parse is the authority (it requires a
        // number in front of a unit); the local extractor only adds the units
        // that table does not know. See unitFormFromNlp().
        const unit = unitFormFromNlp(nlp, nlp.text, { item: named[0] });
        const namedUnit = unit.source !== "none";
        const uomNames = namedUnit ? ((await skills.listUoms()).data?.data ?? []) : [];
        const factors = namedUnit ? ((await skills.listUomFactors()).data?.data ?? []) : [];
        uomInfo = resolveLineUom({
          text: namedUnit ? nlp.text : null,
          uom: unit.form,
          quantity: unit.quantity,
          forceAmbiguous: unit.ambiguous,
          item: named[0],
          erpUomNames: uomNames,
          factors,
          policy: uomPolicy(__contract),
        });
      }
      const lines = rows.map((r) => `${r.item_code}: ${r.actual_qty} (kho ${r.warehouse})`);
      const uomLine =
        uomInfo && uomInfo.uom_source === "user"
          ? uomInfo.action === "ask"
            ? `⚠️ ${uomInfo.reason}`
            : uomInfo.display
          : null;
      const answer = [...lines, note, uomLine].filter(Boolean);
      // Phase 6: informational proposal for the inventory read (entity = the
      // named item when exactly one matched, else none).
      const itemEntity =
        named.length === 1
          ? { kind: "item", id: named[0].item_code ?? named[0].name, name: named[0].item_name ?? named[0].item_code }
          : { kind: "item", id: null, name: null };
      const proposal = readProposal({
        action: "read_stock_balance",
        entity: itemEntity,
        params: {
          ...(rows.length > 0 ? { rows: rows.length, warehouses: [...new Set(rows.map((r) => r.warehouse))] } : {}),
          // B1: the item's own default unit, straight from ERPNext (`stock_uom`
          // — `Item.uom` is not queryable on the live site, HTTP 417). Carried in
          // `params` because the proposal's `entity` block is a fixed shape the
          // builder whitelists.
          ...(uomInfo?.stock_uom ? { default_uom: uomInfo.stock_uom } : {}),
        },
        summary: named.length === 1 ? `Xem tồn kho: ${itemEntity.name}` : "Xem tồn kho",
      });
      return {
        question: rawText,
        normalized: nlp,
        routed: { group: route.group, matched: route.matched },
        answer,
        rows,
        proposal,
        // B1: item resolution state + policy, and the resolved line unit. Both
        // are additive — a client that ignores them behaves exactly as before.
        entity: { state: itemClass.state, policy: itemRule },
        uom: uomInfo,
        item_candidates:
          itemClass.state === ENTITY_STATES.AMBIGUOUS_MATCH
            ? pickerForRowsByText(items, itemFrags, { ...ENTITY_ACCESSORS.item, limit: 5 })
            : [],
        // A1: inventory has no drill-down screen declared, so this is explicitly
        // null rather than absent — the client shows a button only when the
        // server names a screen.
        ui: uiIntentForAction({ action: "read_stock_balance", entity: itemEntity }),
      };
    }

    // ── B1: SUPPLIER master data (READ). Its own route group, so a purchase-side
    // question can never be answered with a customer row (or the reverse): the
    // two namespaces look alike ("Hà Tiên" can be both) and mixing them is
    // exactly the kind of confident-wrong answer this project keeps fixing.
    if (route.group === "supplier") {
      const supplierCap = getCapability("supplier.lookup");
      // A supplier answer that cannot read the master list has nothing to say —
      // but it must SAY so with the code the contract declares. Before this
      // guard an ERPNext outage threw out of answerQuestion and the client got a
      // bare 500 ("ask failed: …"): no error_code, no Vietnamese copy, and
      // `ERP_UNAVAILABLE` — an error this capability explicitly declares — could
      // never appear. Fail closed, in the pipeline's own vocabulary.
      let list;
      try {
        list = (await skills.findSupplier({})).data?.data ?? [];
      } catch (err) {
        return withUncertainty({
          question: rawText,
          normalized: nlp,
          routed: { group: route.group, matched: route.matched, capability: route.capability },
          answer: null,
          error_code: "ERP_UNAVAILABLE",
          reason: `không đọc được danh sách nhà cung cấp từ ERPNext (${err?.message ?? err}) — chưa có kết luận nào về nhà cung cấp`,
          proposal: null,
        });
      }
      const found = resolveEntityByText(list, nlp.text, ENTITY_ACCESSORS.supplier);
      const cls = classifyEntityResolution(
        { entity: found.entity, ambiguous: found.ambiguous, candidates: found.candidates },
        { ...ENTITY_ACCESSORS.supplier, candidates: nameCandidates(nlp.text) },
      );
      const rule = entityPolicy(cls.state, supplierCap, __contract.defaults?.entity_policy ?? null);
      const ambiguous = cls.state === ENTITY_STATES.AMBIGUOUS_MATCH;
      if (!cls.entity || rule.block) {
        return withUncertainty({
          question: rawText,
          normalized: nlp,
          routed: { group: route.group, matched: route.matched, capability: route.capability },
          answer: null,
          error_code: ambiguous ? "AMBIGUOUS_SUPPLIER" : "SUPPLIER_NOT_FOUND",
          reason: ambiguous
            ? `tên nhà cung cấp khớp nhiều kết quả (${sanitizeUntrustedList(cls.candidates).slice(0, 5).join(", ")}) — cần nói rõ tên đầy đủ`
            : `không tìm thấy nhà cung cấp nào trong "${nlp.text}"`,
          proposal: null,
          ambiguous,
          candidates: ambiguous
            ? pickerForRowsByText(list, nameCandidates(nlp.text), { ...ENTITY_ACCESSORS.supplier, limit: 5 })
            : [],
          entity: { state: cls.state, policy: rule },
        });
      }
      const sup = cls.entity;
      const supName = sup.supplier_name ?? sup.name;
      // ERPNext values are UNTRUSTED DATA (P0 §24.1) even when they are the
      // answer: they are shown, never interpreted.
      const answer = sanitizeUntrustedList(
        [
          `Nhà cung cấp: ${supName}`,
          `Mã: ${sup.name}`,
          sup.supplier_group ? `Nhóm: ${sup.supplier_group}` : null,
          sup.supplier_type ? `Loại: ${sup.supplier_type}` : null,
        ].filter(Boolean),
      );
      return {
        question: rawText,
        normalized: nlp,
        routed: { group: route.group, matched: route.matched, capability: route.capability },
        answer,
        rows: [sup],
        proposal: readProposal({
          action: "read_supplier",
          entity: { kind: "supplier", id: sup.name ?? null, name: supName },
          params: sup.supplier_group ? { supplier_group: sup.supplier_group } : {},
          summary: `Nhà cung cấp: ${supName}`,
        }),
        entity: { state: cls.state, policy: rule },
        supplier: {
          id: sup.name ?? null,
          name: supName,
          group: sup.supplier_group ?? null,
          type: sup.supplier_type ?? null,
        },
        ui: uiIntentForAction({ action: "read_supplier", entity: { kind: "supplier", id: sup.name ?? null } }),
      };
    }

    // ── B4: WHICH MASTER LIST the party comes from is decided by the ROUTE, not
    // by whichever list happens to contain the name. A purchase order is raised
    // for a SUPPLIER; resolving its party against the customer list is the
    // misroute this phase exists to close — a name that is both a customer and a
    // supplier (plan3_review3 A.3.1: "anh vừa mua vừa bán") would otherwise have
    // produced a SALES order for the shop's own supplier. Read-only groups and
    // the sales/quotation writes are untouched (partyKind stays "customer").
    // P9-B: the receiving path is a SUPPLIER document too — its party resolves
    // against the supplier master list, never the customer one (the B4 lesson,
    // applied to the second supplier-party write instead of rediscovered).
    // P9-C: the PAYMENT routes (command and history) can be about EITHER master
    // list, so they resolve BOTH. Which one holds the name IS the money
    // direction for a command (Supplier ⇒ chi, Customer ⇒ thu) — measured
    // 2026-09-23: Phase 1's synonym map rewrites "thu tiền" and "trả tiền" onto
    // the SAME label "payment", so the sentence alone no longer says which way
    // the money moves; deriving it from the sentence is exactly how a pay-out
    // order used to reach the Receive path.
    const isPaymentGroup = route.group === "payment_write" || route.group === "payment";
    let partyKind = route.group === "purchase_order_write" || route.group === "purchase_receipt_write"
      ? "supplier"
      : isPaymentGroup ? "both" : "customer";
    let supplier = null;
    let supAmbiguous = false;
    let supCandidates = [];
    // The party is resolved on the text WITHOUT the spoken amount: a number right
    // after a name otherwise becomes part of the name (see textWithoutAmounts).
    const partyText = isPaymentGroup ? textWithoutAmounts(nlp.text, nlp) : nlp.text;
    let { customer, ambiguous, candidates } = partyKind === "supplier"
      ? { customer: null, ambiguous: false, candidates: [] }
      : await resolveCustomer(skills, partyText);
    if (partyKind !== "customer") {
      const r = await resolveSupplier(skills, partyText);
      supplier = r.supplier;
      supAmbiguous = r.ambiguous;
      supCandidates = r.candidates;
      if (partyKind === "supplier") {
        ambiguous = r.ambiguous;
        candidates = r.candidates;
      }
    }
    // The DIRECTION decision, made once, from DATA (never from the request):
    //   exactly one master holds the name  ⇒ that side is the direction
    //   BOTH hold it                        ⇒ refuse (a name that is both a
    //                                        customer and a supplier — plan3
    //                                        A.3.1 "anh vừa mua vừa bán" —
    //                                        cannot be paid OR collected
    //                                        without guessing the direction)
    //   neither                             ⇒ the existing "not found" path
    // No rephrasing is suggested for the BOTH case on purpose: the name is the
    // same string in both masters, so no wording can disambiguate it here.
    if (isPaymentGroup) {
      const customerMatched = Boolean(customer);
      const supplierMatched = Boolean(supplier);
      if (route.group === "payment_write" && customerMatched && supplierMatched) {
        return withUncertainty({
          question: rawText,
          normalized: nlp,
          routed: { group: route.group, matched: route.matched },
          answer: null,
          error_code: "PAYMENT_DIRECTION_AMBIGUOUS",
          reason:
            `tên đối tác trong "${rawText}" có trong CẢ hai sổ (khách hàng và nhà cung cấp) — không tự chọn hướng tiền (thu hay chi), hãy dùng tên/mã phân biệt hoặc ghi trực tiếp trên ERPNext`,
          proposal: null,
          ambiguous: true,
        });
      }
      if (supplierMatched && !customerMatched) {
        partyKind = "supplier";
        ambiguous = supAmbiguous;
        candidates = supCandidates;
      } else {
        partyKind = "customer";
      }
    }
    // An explicit PICK from the Flutter picker (additive `/ask` field) replaces
    // the fuzzy guess — but only for an id that exists in the list we just read
    // from ERPNext (§4.2: nothing downstream may invent an ERP id). The picker
    // carries CUSTOMER ids only, so a supplier party ignores it entirely rather
    // than resolving a supplier id against the customer list (B4 §gap: a
    // supplier picker is not built yet — a fuzzy supplier name is refused, never
    // auto-selected).
    let picked = null;
    if (opts.pickedEntityId && partyKind === "customer") {
      const all = (await skills.findCustomer("")).data?.data ?? [];
      picked = pickFromCandidates(all, opts.pickedEntityId);
      if (picked.ok) {
        customer = picked.customer;
        ambiguous = false;
        candidates = [];
      } else {
        process.stderr.write(`[copilot] entity pick refused: ${picked.error}\n`);
      }
    }
    // P0 §24.1 — ERPNext field values are UNTRUSTED DATA. The candidate names
    // are echoed back to the user (and, from P3, into an LLM): strip anything
    // that looks like an instruction so a customer literally named
    // "Ignore previous instructions..." cannot become a prompt.
    const safeCandidates = sanitizeUntrustedList(candidates);
    if ((candidates ?? []).some((c) => containsInstructionPattern(c))) {
      process.stderr.write(
        `[copilot] untrusted-data violation logged: instruction pattern inside an ERPNext customer name (${safeCandidates.length} candidate(s))\n`,
      );
    }
    // The party row this request is about (customer or supplier), named once so
    // every guard below reads the same thing.
    const partyRow = partyKind === "supplier" ? supplier : customer;
    const partyNoun = partyKind === "supplier" ? "nhà cung cấp" : "khách hàng";
    // A route that WRITES resolves its own party and refuses with its OWN
    // contract codes (PO_SUPPLIER_UNRESOLVED) — the generic guard below answers
    // "which customer?" and must not speak for a purchase question. P9-C: the
    // exemption is the WRITE routes specifically, not "partyKind is supplier" —
    // payment.history also accepts a supplier party, but it is a READ and must
    // still answer through its own branch instead of skipping the guard with a
    // null party and dereferencing it later.
    const isPurchaseWriteRoute =
      partyKind === "supplier" &&
      (route.group === "purchase_order_write" || route.group === "purchase_receipt_write" || route.group === "payment_write");
    // P9-C: "chi xăng 200 nghìn" / "chi tiền mặt 500 nghìn" are STORE EXPENSES:
    // money goes out with nobody to post it against. A Payment Entry always needs
    // a party (Pay = Supplier/Employee) and a Journal Entry is explicitly out of
    // scope on this path — so this refuses with the reason spelled out instead of
    // reporting a generic "không tìm thấy". The unambiguous verb "chi" is what
    // separates this from an ordinary unresolved name.
    const isCashExpense = route.group === "payment_write" && !ambiguous && verbDirection(rawText) === "pay";
    if (!partyRow && !isPurchaseWriteRoute) {
      // M1: a CUSTOMER-party WRITE that resolved NOTHING is the exact moment the
      // spec's flow diagram points at (NO_MATCH → offer the create form). The
      // offer is STRUCTURED data for the client — the button stays on the user's
      // side of the glass, and a READ ("công nợ của anh Tèo?") never carries it
      // (isWriteRoute is what separates "khách chưa có, tạo chứ?" from a debt
      // answer that must stay an answer). The suggested name is the SAME text
      // the resolver just failed on, stripped of command verbs.
      // Computed INLINE (getCapability, not the isWriteRoute const below — that
      // one is declared further down and would be a TDZ ReferenceError here).
      const isCustomerWriteNoMatch =
        getCapability(route.capability)?.type === "WRITE" && partyKind === "customer" && !ambiguous && !isCashExpense;
      return withUncertainty({
        question: rawText,
        normalized: nlp,
        routed: { group: route.group, matched: route.matched },
        answer: null,
        // Phase 6 distinction (spec: "≥2 candidate gần nhau: hỏi lại user"):
        // ambiguous ⇒ say WHICH names collided, never a bare "not found".
        error_code: isCashExpense
          ? "PAYMENT_EXPENSE_WITHOUT_PARTY"
          : ambiguous
            ? "AMBIGUOUS_ENTITY"
            : "MISSING_ENTITY",
        reason: ambiguous
          ? `tên khách trong "${nlp.text}" khớp nhiều kết quả (${safeCandidates.slice(0, 5).join(", ")}) — cần nói rõ tên đầy đủ`
          : isCashExpense
            ? `"${rawText}" là khoản chi không gắn nhà cung cấp nào — phiếu chi cần một nhà cung cấp để ghi công nợ, còn chi phí lẻ (xăng, tiền mặt…) phải ghi bằng bút toán chi phí trên ERPNext (chưa hỗ trợ trên chat). Nếu đây là trả tiền cho nhà cung cấp, hãy nói rõ tên nhà cung cấp.`
            : isPaymentGroup
              ? `không tìm thấy khách hàng hay nhà cung cấp nào trong "${nlp.text}" — nói rõ tên người/nhà cung cấp để xem lịch sử thu chi (entity resolution mở rộng là Phase 6.5)`
              : `không tìm thấy khách hàng trong "${nlp.text}" (entity resolution mở rộng là Phase 6.5)`,
        proposal: null,
        ambiguous,
        candidates: safeCandidates,
        // M1: the structured create-offer (absent on every other refusal —
        // JSON without the key keeps old clients byte-compatible).
        ...(isCustomerWriteNoMatch
          ? {
              offer_create_customer: { name: customerCreateNameFrom(nlp.text) ?? nlp.text, mobile_no: null, tax_id: null },
            }
          : {}),
      });
    }

    const ambNote = ambiguous
      ? ` (⚠️ tên ${partyNoun} trùng nhiều kết quả — đã lấy kết quả đầu tiên, entity resolution mở rộng là Phase 6.5)`
      : "";

    // ── P1 §4.3: name the resolution state, then apply the CONTRACT's policy ──
    // The state is what makes the risk rule checkable: a fuzzy substring hit is
    // FUZZY_SINGLE_MATCH, and for a WRITE the contract forbids auto-selecting
    // it. Nothing here is inferred from confidence — only from how the name
    // actually matched.
    const resolution = partyKind === "supplier"
      ? classifyEntityResolution(
          { entity: supplier, ambiguous, candidates },
          { ...ENTITY_ACCESSORS.supplier, candidates: nameCandidates(nlp.text) },
        )
      : classifyResolution(
          { customer, ambiguous, candidates },
          {
            candidates: nameCandidates(nlp.text),
            pickedEntityId: picked?.ok ? picked.customer.name : null,
          },
        );
    const capabilityId = route.capability ?? null;
    const entityRule = entityPolicy(
      resolution.state,
      capabilityId ? getCapability(capabilityId) : null,
      __contract.defaults?.entity_policy ?? null,
    );

    // ── P2 §14: remember the customer for follow-up questions — with
    // provenance. An EXACT/picked match is user-selected; a fuzzy read hit is
    // derived (never WRITE-eligible). Recorded AFTER the guards, only when a
    // concrete customer row exists.
    // B2: derived, not a list of group names — a WRITE route never seeds the
    // session context (a derived customer must not be reused to write).
    const isWriteRoute = getCapability(route.capability)?.type === "WRITE";
    if (customer?.name && !isWriteRoute) {
      sessionContext.set("customer", {
        id: customer.name,
        name: customer.customer_name ?? null,
        provenance:
          resolution.state === "EXACT_MATCH" || picked?.ok
            ? CONTEXT_PROVENANCE.USER_SELECTED
            : CONTEXT_PROVENANCE.DERIVED,
      }, { scope: contextScopeFor(opts) });
    }

    // Phase 7b (user decision 2026-09-16): the write-producing intents.
    // "thu tiền cho <khách> <số tiền>" (payment) and "đặt hàng cho <khách> N
    // đơn vị <mặt hàng>" (B2 order) each produce a HIGH proposal that STOPS at
    // the card; nothing is written until POST /execute (human confirm). The
    // write itself re-reads live ERPNext data and re-validates (Phase 9).
    //
    // The entity guards below are SHARED by both writes on purpose: §4.3 is a
    // rule about WRITE, not about payments, and a second copy of it is exactly
    // where a future change would fix one path and forget the other.
    const isPaymentWrite = route.group === "payment_write";
    const isOrderWrite = route.group === "sales_order_write";
    const isQuotationWrite = route.group === "quotation_write";
    const isPurchaseWrite = route.group === "purchase_order_write";
    // P9-A2: the delivery path is a WRITE with a CUSTOMER party (like the order
    // paths), so it joins the same §4.3 guards instead of growing a second copy
    // of them — the only thing that differs is what gets built.
    const isDeliveryWrite = route.group === "delivery_write";
    // P9-B: the receiving path is the SUPPLIER-party mirror of delivery —
    // same §4.3 guards, a receipt builder instead of an order builder.
    const isReceiptWrite = route.group === "purchase_receipt_write";
    // P9-D: the invoice path is a CUSTOMER-party WRITE (like the order paths),
    // so it joins the same §4.3 guards instead of growing a second copy of them.
    const isInvoiceWrite = route.group === "sales_invoice_write";
    if (isPaymentWrite || isOrderWrite || isQuotationWrite || isPurchaseWrite || isDeliveryWrite || isReceiptWrite || isInvoiceWrite) {
      // P9-C: which way the money moves is already decided by WHICH MASTER held
      // the party (buildPaymentProposal repeats the same derivation from the bag
      // it is handed), so the wording can follow it instead of saying "phiếu thu"
      // on a pay-out order.
      const isPayWrite = isPaymentWrite && partyKind === "supplier";
      const writeNoun = isOrderWrite
        ? "tạo đơn bán"
        : isQuotationWrite
          ? "tạo báo giá"
          : isPurchaseWrite
            ? "tạo đơn mua"
            : isDeliveryWrite
              ? "giao hàng"
              : isReceiptWrite
                ? "nhận hàng"
                : isInvoiceWrite
                  ? "xuất hoá đơn"
                  : isPayWrite
                    ? "ghi phiếu chi"
                    : "ghi phiếu thu";
      // B4: the party noun follows the ROUTE (khách vs nhà cung cấp). One guard
      // body serves both so a future change cannot fix the wording of one path
      // and leave the other telling a shop owner to "chọn đúng khách" on a
      // purchase question.
      const partyLabel = partyKind === "supplier"
        ? "nhà cung cấp"
        : isPaymentWrite
          ? "khách hàng hay nhà cung cấp"
          : "khách";
      // result37 review: the OUTER guard already resolved this party from the
      // same text — re-calling the resolver here duplicated the full catalog
      // round-trip per question and risked the two blocks diverging. Reuse
      // `partyRow`/`ambiguous`/`candidates`; the ambiguity note still travels in
      // the answer (ambNote below).
      if (!partyRow) {
        // The store-expense case is answered by the shared guard ABOVE (it is the
        // one that fires when neither master held the name); this path is for a
        // SUPPLIER-party write whose own codes take over the message.
        return withUncertainty({
          question: rawText,
          normalized: nlp,
          routed: { group: route.group, matched: route.matched },
          answer: null,
          reason: ambiguous
            ? `tên ${partyLabel} trong "${rawText}" khớp nhiều kết quả (${(candidates ?? []).slice(0, 5).join(", ")}) — cần nói rõ tên đầy đủ trước khi ${writeNoun}`
            : `không tìm thấy ${partyLabel} trong "${rawText}" — không ${writeNoun}`,
          error_code: entityRule.code ?? (ambiguous ? "AMBIGUOUS_ENTITY" : "MISSING_ENTITY"),
          proposal: null,
          ambiguous,
          candidates: candidates ?? [],
          entity: { state: resolution.state, policy: entityRule },
        });
      }
      // §4.3/§8: WRITE is Exact-only. A fuzzy single hit (e.g. "Lan" →
      // "Nguyễn Thị Lan") or several candidates must NOT become an authoritative
      // party id by itself — the user picks. No proposal is built yet, so
      // there is nothing to confirm and nothing can be written.
      if (entityRule.require_picker) {
        const all = partyKind === "supplier"
          ? (await skills.findSupplier({})).data?.data ?? []
          : (await skills.findCustomer("")).data?.data ?? [];
        return withUncertainty({
          question: rawText,
          normalized: nlp,
          routed: { group: route.group, matched: route.matched },
          answer: null,
          error_code: entityRule.code ?? "ENTITY_PICK_REQUIRED",
          reason:
            `tên ${partyLabel} "${safeCandidates[0] ?? rawText}" khớp ${resolution.state === "AMBIGUOUS_MATCH" ? `nhiều ${partyLabel}` : `một ${partyLabel} KHÔNG trùng tên chính xác`} — ${writeNoun} cần chọn đúng ${partyLabel} trước (chưa có đề xuất nào)`,
          proposal: null,
          entity: { state: resolution.state, policy: entityRule },
          candidates: partyKind === "supplier"
            ? pickerForRowsByText(all, nameCandidates(nlp.text), { ...ENTITY_ACCESSORS.supplier, limit: 5 })
            : pickerForText(all, nameCandidates(nlp.text)),
        });
      }
      if (entityRule.block) {
        return withUncertainty({
          question: rawText,
          normalized: nlp,
          routed: { group: route.group, matched: route.matched },
          answer: null,
          error_code: entityRule.code ?? "ENTITY_NOT_FOUND_BLOCKED",
          reason: `không xác định được ${partyLabel} (${resolution.state}) — không ${writeNoun}`,
          proposal: null,
          entity: { state: resolution.state, policy: entityRule },
        });
      }
      // MEASURED 2026-09-24 (A2 real loop): these two were declared INSIDE the
      // `try` below while the CATCH block also reads them — and a catch block is
      // a SEPARATE scope from its try block, so `customerId` was a
      // ReferenceError there. Effect: every refusal from a SUPPLIER-party write
      // builder (purchase order / purchase receipt) reached the user as a bare
      // 500 "ask failed: customerId is not defined" instead of the builder's own
      // Vietnamese reason and error_code. Fail-closed held (nothing was
      // written), but the reason the user needs was destroyed. Hoisted so both
      // the try and its catch see them.
      let customerId = partyRow.name;
      let customerName = partyKind === "supplier" ? (partyRow.supplier_name ?? partyRow.name) : partyRow.customer_name;
      try {
        // ── P2 §14 deliverable 3: a WRITE may consume session context only when
        // it is alive AND user-selected/exact. A derived (fuzzy) read from an
        // earlier sentence never seeds a payment; an expired entry behaves like
        // a first mention (the guards above already refused with the picker).
        //
        // B4: the remembered context is a CUSTOMER id, so a purchase question
        // (whose party is a supplier) never consumes it — reusing it here would
        // put a customer id where a supplier belongs.
        const ctx = partyKind === "customer" ? sessionContext.writeEligible("customer", { scope: contextScopeFor(opts) }) : { eligible: false };
        if (ctx.eligible) {
          customerId = ctx.context.value;
          customerName = ctx.context.name ?? ctx.context.value;
        }

        // ── P9-A2: the DELIVERY path. It is neither a payment nor a free-line
        // document: its lines come from an ORDER that is already SUBMITTED, and
        // the only thing the sentence may add is HOW MUCH of it to ship. When
        // the customer has several open orders the builder refuses
        // (DN_SO_UNRESOLVED) instead of picking one — shipping the wrong order
        // moves real goods and cannot be undone from chat.
        if (isDeliveryWrite) {
          try {
            const built = await buildDeliveryProposal(
              skills,
              { customer, order: null, ambiguous, candidates },
              { nlp, text: nlp.text },
            );
            const lines = built.proposal.params.lines;
            const againstSo = built.proposal.params.against_sales_order;
            const lineText = lines
              .map((l) => `${l.qty} ${l.uom ?? ""} ${l.item_name}`.trim())
              .join(" + ");
            const answer =
              `Đề xuất PHIẾU GIAO NHÁP theo đơn ${againstSo} cho ${customerName}: ${lineText} — ` +
              "kiểm tra rồi bấm [Xác nhận] để tạo phiếu giao NHÁP (KHÔNG tự submit, CHƯA trừ kho)." +
              ambNote;
            return {
              question: rawText,
              normalized: nlp,
              routed: { group: route.group, matched: route.matched },
              customer: { id: customerId, name: customerName },
              // The order the note fulfils travels on the answer, so a client
              // never has to read it out of the proposal's params.
              against_sales_order: againstSo,
              lines,
              warnings: built.warnings,
              answer,
              proposal: built.proposal,
            };
          } catch (err) {
            // A refusal is an ANSWER (which order? nothing left to ship? the
            // order is still a draft?) — never a 500, and never a card.
            const code = err?.code ?? null;
            return withUncertainty({
              question: rawText,
              normalized: nlp,
              routed: { group: route.group, matched: route.matched },
              customer: customer ? { id: customer.name, name: customer.customer_name } : null,
              answer: null,
              reason: `không tạo được đề xuất phiếu giao hàng: ${err?.message ?? err}`,
              error_code: code,
              uncertainty: uncertaintyCopy(
                toUncertaintyCode(code) ?? UNCERTAINTY_CODES.BUSINESS_VALIDATION_FAILED,
                { detail: err?.message ?? String(err) },
              ),
              proposal: null,
            });
          }
        }

        // ── P9-B: the RECEIVING path. The supplier-party mirror of the delivery
        // branch: lines come from a SUBMITTED Purchase Order, the only thing the
        // sentence may add is HOW MUCH of it is received, and a refusal (which
        // order? nothing left? still a draft?) is an ANSWER, never a 500.
        if (isReceiptWrite) {
          try {
            const built = await buildPurchaseReceiptProposal(
              skills,
              { supplier: partyRow, order: null, ambiguous, candidates },
              { nlp, text: nlp.text },
            );
            const lines = built.proposal.params.lines;
            const againstPo = built.proposal.params.purchase_order;
            const lineText = lines
              .map((l) => `${l.qty} ${l.uom ?? ""} ${l.item_name}`.trim())
              .join(" + ");
            const answer =
              `Đề xuất PHIẾU NHẬN HÀNG NHÁP theo đơn mua ${againstPo} từ ${customerName}: ${lineText} — ` +
              "kiểm tra rồi bấm [Xác nhận] để tạo phiếu nhận NHÁP (KHÔNG tự submit, CHƯA cộng kho)." +
              ambNote;
            return {
              question: rawText,
              normalized: nlp,
              routed: { group: route.group, matched: route.matched },
              supplier: { id: partyRow.name, name: customerName },
              // The order the receipt fulfils travels on the answer, so a
              // client never has to read it out of the proposal's params.
              purchase_order: againstPo,
              lines,
              warnings: built.warnings,
              answer,
              proposal: built.proposal,
            };
          } catch (err) {
            const code = err?.code ?? null;
            return withUncertainty({
              question: rawText,
              normalized: nlp,
              routed: { group: route.group, matched: route.matched },
              supplier: partyRow ? { id: partyRow.name, name: customerName } : null,
              answer: null,
              reason: `không tạo được đề xuất phiếu nhận hàng: ${err?.message ?? err}`,
              error_code: code,
              uncertainty: uncertaintyCopy(
                toUncertaintyCode(code) ?? UNCERTAINTY_CODES.BUSINESS_VALIDATION_FAILED,
                { detail: err?.message ?? String(err) },
              ),
              proposal: null,
            });
          }
        }

        // ── P9-D: the INVOICE path. A customer-party WRITE like the order paths,
        // so it joins the same §4.3 guards; what differs is that its lines AND
        // PRICES come from an order that is already SUBMITTED (ERPNext refuses an
        // invoice whose rate differs from the order it is linked to), and the
        // only thing the sentence may add is HOW MUCH of it to bill.
        if (isInvoiceWrite) {
          try {
            const built = await buildSalesInvoiceProposal(
              skills,
              { customer, order: null, ambiguous, candidates },
              { nlp, text: nlp.text },
            );
            const lines = built.proposal.params.lines;
            const salesOrder = built.proposal.params.sales_order;
            const lineText = lines
              .map((l) => `${l.qty} ${l.uom ?? ""} ${l.item_name}`.trim())
              .join(" + ");
            const answer =
              `Đề xuất HOÁ ĐƠN NHÁP theo đơn ${salesOrder} cho ${customerName}: ${lineText} — ` +
              "kiểm tra rồi bấm [Xác nhận] để tạo hoá đơn NHÁP (KHÔNG tự submit, CHƯA ghi doanh thu/công nợ, KHÔNG đụng kho)." +
              ambNote;
            return {
              question: rawText,
              normalized: nlp,
              routed: { group: route.group, matched: route.matched },
              customer: { id: customerId, name: customerName },
              // The order the invoice is raised against travels on the answer, so
              // a client never has to read it out of the proposal's params.
              sales_order: salesOrder,
              lines,
              warnings: built.warnings,
              answer,
              proposal: built.proposal,
            };
          } catch (err) {
            // A refusal is an ANSWER (which order? nothing left to bill? the order
            // is still a draft? the price cannot be derived?) — never a 500, and
            // never a card.
            const code = err?.code ?? null;
            return withUncertainty({
              question: rawText,
              normalized: nlp,
              routed: { group: route.group, matched: route.matched },
              customer: customer ? { id: customer.name, name: customer.customer_name } : null,
              answer: null,
              reason: `không tạo được đề xuất hoá đơn: ${err?.message ?? err}`,
              error_code: code,
              uncertainty: uncertaintyCopy(
                toUncertaintyCode(code) ?? UNCERTAINTY_CODES.BUSINESS_VALIDATION_FAILED,
                { detail: err?.message ?? String(err) },
              ),
              proposal: null,
            });
          }
        }

        // ── B2: the order path. Same customer object as the payment path, and
        // the same §4.3 guards above — this branch only decides WHAT is built.
        // ── B2: the order path. Same customer object as the payment path, and
        // the same §4.3 guards above — this branch only decides WHAT is built.
        if (isOrderWrite || isQuotationWrite || isPurchaseWrite) {
          // B3: one branch for both line documents — the DIFFERENCE is the
          // builder (and the wording), not the guards above, which are shared
          // on purpose (a second copy of §4.3 is where a future change fixes
          // one path and forgets the other). B4 adds the purchase document to
          // the SAME branch: it is a line document too, and its only structural
          // differences (supplier party, buying price) live in its own builder.
          //
          // The builder takes a RESOLVED bag — {customer,…} or {supplier,…} —
          // not the party row itself. Passing the row directly loses the wrapped
          // key and every document is refused as "unresolved" (caught by the B2
          // E2E when this branch was merged for B3).
          const partyId = partyRow.name;
          const resolvedParty = partyKind === "supplier"
            ? { supplier: { ...partyRow, name: partyId, supplier_name: customerName }, ambiguous, candidates }
            : { customer: { ...partyRow, name: partyId, customer_name: customerName }, ambiguous, candidates };
          const builtOrder = isPurchaseWrite
            // `company` is passed so the item's default-warehouse read (A2) can
            // prefer the row for the pinned company instead of treating a
            // multi-company site as ambiguous.
            ? await buildPurchaseOrderProposal(skills, resolvedParty, {
                nlp,
                text: nlp.text,
                company: opts.company ?? null,
                // next3/B: the paper document this sentence came from, when the
                // channel had one. Only the purchase path consumes it — every
                // other capability ignores it, so this adds no write path and no
                // new behaviour anywhere else.
                sourceDocument: opts.sourceDocument ?? null,
              })
            : isQuotationWrite
              ? await buildQuotationProposal(skills, resolvedParty, { nlp, text: nlp.text })
              : await buildSalesOrderProposal(skills, resolvedParty, { nlp, text: nlp.text });
          const lines = builtOrder.proposal.params.lines;
          const lineText = lines.map((l) => `${l.qty} ${l.uom} ${l.item_name}`).join(" + ");
          const totalText = `tạm tính ${formatVnd(builtOrder.proposal.params.estimated_total_vnd)}đ theo giá ERPNext`;
          // B4: a bare "mua …" does not say whether the goods already arrived,
          // so the answer asks BEFORE the card is confirmed (plan3_review3 A.3.2
          // proposes exactly this). It is wording only — the document built is
          // the draft PO either way, and the user can simply not confirm it.
          const purchaseNote = isPurchaseWrite && route.matched !== "đặt mua"
            ? " ⚠️ Bạn đã NHẬN hàng chưa? Nếu nhận rồi thì phần nhập kho là việc khác (chưa hỗ trợ) — ở đây tôi chỉ tạo đơn MUA NHÁP."
            : "";
          const answer = isPurchaseWrite
            ? `Đề xuất ĐƠN MUA NHÁP từ ${customerName}: ${lineText} (${totalText}, giá MUA từ ERPNext) — ` +
              `kiểm tra rồi bấm [Xác nhận] để tạo đơn mua NHÁP, đơn KHÔNG tự submit.` +
              purchaseNote +
              ambNote
            : isQuotationWrite
              ? `Đề xuất BÁO GIÁ NHÁP cho ${customerName}: ${lineText} (${totalText}) — ` +
                `đây là ĐỀ NGHỊ, chưa phải đơn đã chốt; kiểm tra rồi bấm [Xác nhận] để tạo báo giá NHÁP (không tự submit).` +
                ambNote
              : `Đề xuất TẠO ĐƠN NHÁP cho ${customerName}: ${lineText} (${totalText}) — ` +
                `kiểm tra rồi bấm [Xác nhận] để tạo đơn NHÁP, đơn KHÔNG tự submit.` +
                ambNote;
          return {
            question: rawText,
            normalized: nlp,
            routed: { group: route.group, matched: route.matched },
            // B4: the party travels under the key its KIND names, so a client
            // (and the tests) can never read a supplier id as `customer`.
            ...(partyKind === "supplier"
              ? { supplier: { id: partyId, name: customerName } }
              : { customer: { id: partyId, name: customerName } }),
            ...(isPurchaseWrite ? { price_side: builtOrder.proposal.params.price_side } : {}),
            lines,
            estimated_total_vnd: builtOrder.proposal.params.estimated_total_vnd,
            warnings: builtOrder.warnings,
            answer,
            proposal: builtOrder.proposal,
          };
        }

        // P9-C: the resolved bag names the master the party came from, and that
        // IS the direction (the builder derives it from the same bag — one
        // source, so the wording and the document cannot disagree). `raw_text`
        // is passed so the builder can REFUSE when the sentence's own verb
        // contradicts the direction the data implies.
        const resolvedParty =
          partyKind === "supplier"
            ? { supplier: { ...supplier, name: customerId, supplier_name: customerName }, ambiguous, candidates }
            : { customer: { ...customer, name: customerId, customer_name: customerName }, ambiguous, candidates };
        const built = await buildPaymentProposal(skills, resolvedParty, {
          amount_vnd: nlp.amount ?? undefined,
          // §13 + P1 exit criterion: the interactive path must never fall back
          // to "collect the whole debt" when the number was not understood —
          // that turns a failed parse into a bigger payment.
          requireExplicitAmount: true,
          // F7-2: the app's "allow real submission" setting as it stood WHEN
          // THIS QUESTION WAS ASKED. Frozen into the proposal snapshot so the
          // card's wording and the execute behaviour cannot diverge if the
          // user flips the setting afterwards. It is a boolean from the client
          // (default false); it can only make the write MORE visible, and the
          // executor still treats a submit failure as PARTIAL, not FAILED.
          submit_now: opts.submitNow === true,
          raw_text: rawText,
        });
        const direction = built.proposal.params.direction;
        const amt = built.proposal.params.amount_vnd;
        const verb = direction === "pay" ? "chi" : "thu";
        const prep = direction === "pay" ? "cho" : "từ";
        const docKind = direction === "pay" ? "hóa đơn mua" : "chứng từ";
        const base = built.proposal.params.submit_now === true
          ? `Đề xuất ${verb} ${formatVnd(amt)}đ ${prep} ${customerName} cho ${docKind} ${built.invoice} — bấm [Xác nhận] sẽ TẠO phiếu và NỘP NGAY: công nợ ${direction === "pay" ? "nhà cung cấp" : "khách"} thay đổi ngay khi xác nhận.`
          : `Đề xuất ${verb} ${formatVnd(amt)}đ ${prep} ${customerName} cho ${docKind} ${built.invoice} — kiểm tra và bấm [Xác nhận] để ghi phiếu ${verb} (đề xuất chỉ TẠO PHIẾU NHÁP, chưa submit).`;
        const answer = base + ambNote;
        return {
          question: rawText,
          normalized: nlp,
          routed: { group: route.group, matched: route.matched },
          // The party travels under the key its KIND names (B4's rule), so a
          // client can never read a supplier id as `customer`. The receive key
          // is unchanged (the resolved row, exactly as before P9-C) — a pay
          // order has no `customer` in scope, and cannot consume the session
          // context, so its own ids are the resolved ones.
          ...(direction === "pay"
            ? { supplier: { id: customerId, name: customerName } }
            : { customer: { id: customer.name, name: customer.customer_name } }),
          direction,
          invoice: built.invoice,
          outstanding_vnd: built.outstanding_vnd,
          warnings: built.warnings,
          answer,
          proposal: built.proposal,
        };
      } catch (err) {
        // Builder refusals are ANSWERS, not crashes: the user must know why no
        // card appeared (no open document / ambiguous name / nothing to collect).
        // P2 §12: every PAYMENT_* refusal maps onto BUSINESS_VALIDATION_FAILED
        // in the taxonomy (the message stays the specific one).
        const code = err?.code ?? null;
        return withUncertainty({
          question: rawText,
          normalized: nlp,
          routed: { group: route.group, matched: route.matched },
          customer: customer ? { id: customer.name, name: customer.customer_name } : null,
          ...(partyKind === "supplier" ? { supplier: { id: customerId, name: customerName } } : {}),
          answer: null,
          reason: `${isOrderWrite
            ? "không tạo được đề xuất đơn bán"
            : isQuotationWrite
              ? "không tạo được đề xuất báo giá"
              : isPurchaseWrite
                ? "không tạo được đề xuất đơn mua"
                : isPayWrite
                  ? "không tạo được đề xuất chi tiền"
                  : "không tạo được đề xuất thu tiền"}: ${err?.message ?? err}`,
          error_code: code,
          uncertainty: uncertaintyCopy(
            toUncertaintyCode(code) ?? UNCERTAINTY_CODES.BUSINESS_VALIDATION_FAILED,
            { detail: err?.message ?? String(err) },
          ),
          proposal: null,
        });
      }
    }

    if (route.group === "payment") {
      // P9-C: the history question is direction-aware too. A supplier's entries
      // are money OUT ("đã chi"), and reading them needs party_type=Supplier —
      // the real server requires the type when filtering by party. The party
      // was already decided above (which master held the name); if neither
      // master held it, the shared guard above has already refused.
      const isPayHistory = partyKind === "supplier";
      const partyId = isPayHistory ? supplier.name : customer.name;
      const partyName = isPayHistory ? (supplier.supplier_name ?? supplier.name) : customer.customer_name;
      const voucher = isPayHistory ? "phiếu chi" : "phiếu thu";
      const pays = await skills.listPaymentEntries(partyId, knownIds, isPayHistory ? "Supplier" : "Customer");
      const rows = (pays.data?.data ?? []).map((p) => ({
        id: p.name,
        date: p.posting_date,
        amount_vnd: Number(p.paid_amount) || 0,
      }));
      const total = rows.reduce((s, r) => s + r.amount_vnd, 0);
      const answer =
        rows.length > 0
          ? `${partyName} đã có ${rows.length} ${voucher}, tổng ${formatVnd(total)}đ (mới nhất: ${rows[0].id} ngày ${rows[0].date}).${ambNote}`
          : isPayHistory
            ? `${partyName} chưa có phiếu chi nào trong hệ thống. Để ghi phiếu chi mới, hãy nói "chi cho <tên nhà cung cấp> <số tiền>".${ambNote}`
            : `${partyName} chưa có phiếu thu nào trong hệ thống. Để ghi phiếu thu mới, hãy nói "thu tiền cho <tên khách> <số tiền>".${ambNote}`;
      // Phase 6: the read itself is READ-level; the FUTURE write this question
      // points at (create_payment_entry) is HIGH — surfaced in the proposal so
      // the UI can show what a confirmation would guard from Phase 7 on.
      const proposal = buildProposal({
        action: "read_payment_history",
        risk: "READ",
        entity: { kind: isPayHistory ? "supplier" : "customer", id: partyId, name: partyName },
        params: { entries: rows.length, total_vnd: total },
        summary: `Xem lịch sử ${voucher}: ${partyName}`,
        extra: { next_action_hint: { action: "create_payment_entry", risk: "HIGH" } },
      });
      return {
        question: rawText,
        normalized: nlp,
        routed: { group: route.group, matched: route.matched },
        ...(isPayHistory
          ? { supplier: { id: partyId, name: partyName } }
          : { customer: { id: customer.name, name: customer.customer_name } }),
        direction: isPayHistory ? "pay" : "receive",
        rows,
        answer,
        proposal,
        // Payment history is Màn 2 (plan3 §4.4, "sau") — not declared today.
        ui: uiIntentForAction({ action: "read_payment_history", entity: { id: partyId, name: partyName } }),
      };
    }

    if (route.group === "sales") {
      const inv = await skills.listUnpaidInvoices(customer.name, knownIds);
      const rows = inv.data?.data ?? [];
      const total = rows.reduce((s, r) => s + (Number(r.outstanding_amount) || 0), 0);
      // result20: the set now includes credit notes (outstanding < 0). Say
      // "chứng từ" (documents) and show each line with its signed amount so a
      // negative line reads as a deduction instead of a wrong "hóa đơn" count.
      const lines = rows.map((r) => `${r.name}: ${formatVnd(Number(r.outstanding_amount))}đ`).join(", ");
      const answer =
        rows.length > 0
          ? `${customer.customer_name} còn ${rows.length} chứng từ chưa thanh toán, tổng ${formatVnd(total)}đ (${lines}).${ambNote}`
          : `${customer.customer_name} không còn chứng từ nào chưa thanh toán.${ambNote}`;
      const proposal = buildProposal({
        action: "read_open_invoices",
        risk: "READ",
        entity: { kind: "customer", id: customer.name, name: customer.customer_name },
        params: { documents: rows.length, outstanding_vnd: total },
        summary: `Xem chứng từ chưa thanh toán: ${customer.customer_name}`,
      });
      return {
        question: rawText,
        normalized: nlp,
        routed: { group: route.group, matched: route.matched },
        customer: { id: customer.name, name: customer.customer_name },
        rows,
        answer,
        proposal,
        // A1 Màn 1: the unpaid-document list read fresh behind the button.
        ui: uiIntentForAction({ action: "read_open_invoices", entity: { id: customer.name, name: customer.customer_name } }),
      };
    }

    // group === "customer": the receivable-balance question. rows from the
    // balance now include credit notes (negative) — "chứng từ" not "hóa đơn".
    const balance = await skills.getCustomerBalance(customer.name, knownIds);
    const b = balance.data;
    const answer =
      b.outstanding_vnd > 0
        ? `${customer.customer_name} còn nợ ${formatVnd(b.outstanding_vnd)}đ (${b.open_invoices} chứng từ chưa thanh toán).${ambNote}`
        : b.outstanding_vnd < 0
          ? `${customer.customer_name} không còn nợ — hiện dư ${formatVnd(-b.outstanding_vnd)}đ (${b.open_invoices} chứng từ chưa thanh toán, phần dư từ ghi trừ/credit note).${ambNote}`
          : `${customer.customer_name} không còn nợ gì.${ambNote}`;
    const proposal = buildProposal({
      action: "read_balance",
      risk: "READ",
      entity: { kind: "customer", id: customer.name, name: customer.customer_name },
      params: { outstanding_vnd: b.outstanding_vnd, open_documents: b.open_invoices, ambiguous },
      summary: `Xem công nợ: ${customer.customer_name}`,
    });
    return {
      question: rawText,
      normalized: nlp,
      routed: { group: route.group, matched: route.matched },
      customer: { id: customer.name, name: customer.customer_name },
      outstanding_vnd: b.outstanding_vnd,
      open_invoices: b.open_invoices,
      answer,
      proposal,
      // A1 Màn 1 — same screen as the sales group: a debt question and an
      // invoice question both open the customer's account view.
      ui: uiIntentForAction({ action: "read_balance", entity: { id: customer.name, name: customer.customer_name } }),
    };
  } finally {
    await mcp.close();
  }
}

/**
 * P4 learning loop (plan2_final §12): log the outcome of every question as a
 * structured observation BEFORE returning — refusals (UNKNOWN_INTENT /
 * KNOWN_INTENT_UNIMPLEMENTED) are the product signal a human clusters and
 * turns into contract-trigger updates. Best-effort by design: a broken log
 * dir must never change the answer (learning-log.mjs never throws through).
 * The MCP tool path (copilotAsk) and the HTTP path (/ask) BOTH call this
 * wrapper — log once per question, on both transports.
 */
export async function answerQuestionLogged(rawText, opts = {}) {
  const result = await answerQuestion(rawText, opts);
  // NEXT6 (G5): stamp an executable WRITE proposal with the principal it was
  // built for, so a different user cannot confirm it at /execute. Additive — a
  // proposal without the stamp (dsh tool / non-HTTP callers) behaves as before.
  const ownerId = opts?.principal?.user_id ?? null;
  if (ownerId && result?.proposal?.executable === true) {
    // Keep the proposal FROZEN like buildProposal produced it: a mutable
    // snapshot on the server would break the immutable-snapshot invariant the
    // whole confirm/execute flow depends on.
    result.proposal = Object.freeze({
      ...result.proposal,
      principal_user_id: ownerId,
    });
  }
  // P10 §17: one place adds the correlation columns for every /ask caller
  // (HTTP wrapper and the dsh tool) — no caller has to remember.
  logObservation(result, { correlation: opts.correlation });
  return result;
}

/** The one tool dsh sees. */
async function copilotAsk(args) {
  const rawText = args?.text;
  if (typeof rawText !== "string" || rawText.trim().length === 0) {
    return { isError: true, content: [{ type: "text", text: "copilot_ask requires non-empty `text`" }] };
  }
  // P1 §4.4: the candidate picker sends the chosen ERPNext id back through the
  // tool. It is re-validated against a fresh read server-side — never trusted.
  // P4: same logged wrapper as /ask — dsh questions are learning signals too.
  const structured = await answerQuestionLogged(rawText.trim(), {
    pickedEntityId: typeof args?.entity_id === "string" ? args.entity_id : null,
    env: process.env, // P5: dsh-context detection follows the process env
  });
  return {
    content: [{ type: "text", text: JSON.stringify(structured, null, 2) }],
    structuredContent: structured,
  };
}

/** MCP stdio main loop — same protocol shape as the pinned 3.0.4 server. */
export async function main() {
  const up = await waitForNlpService();
  if (!up) {
    process.stderr.write(`[copilot] NLP bridge not reachable at ${NLP_URL} — start it: python3 -m nlp_service.server\n`);
    process.exit(3);
  }
  // Target transparency: host only — never log keys or secrets.
  try {
    const target = pickServerScript();
    const isReal = target === realServerScript();
    const host = isReal ? new URL(process.env.ERPNEXT_URL).host : "mock (in-memory)";
    process.stderr.write(`[copilot] ERPNext target: ${isReal ? "REAL" : "mock"} -> ${host}\n`);
    if (!isReal) {
      process.stderr.write(
        "[copilot] WARNING: serving the FIXTURE server (COPILOT_MOCK_OK=1) — not real ERPNext data\n",
      );
    }
  } catch (err) {
    process.stderr.write(`[copilot] fatal: ${err?.message ?? err}\n`);
    process.exit(2);
  }
  const rl = (await import("node:readline")).createInterface({ input: process.stdin, terminal: false });
  rl.on("line", (line) => {
    if (!line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      replyError(null, -32700, "Parse error");
      return;
    }
    const { id, method, params } = msg;
    switch (method) {
      case "initialize":
        reply(id, {
          protocolVersion: params?.protocolVersion ?? "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "erpn-copilot", version: "0.1.0" },
        });
        break;
      case "tools/list":
        reply(id, {
          tools: [{
            name: "copilot_ask",
            description: "Trả lời câu hỏi tiếng Việt về khách hàng/công nợ/tồn kho bằng pipeline Phase 1+2 (normalize → route → ERPNext, không LLM bên trong).",
            annotations: { readOnlyHint: true },
            inputSchema: {
              type: "object",
              properties: { text: { type: "string", description: "Câu hỏi tiếng Việt thô (đã qua STT hoặc gõ)" } },
              required: ["text"],
            },
          }],
        });
        break;
      case "tools/call":
        if (params?.name !== "copilot_ask") {
          replyError(id, -32602, `Unknown tool: ${params?.name}`);
          break;
        }
        copilotAsk(params?.arguments)
          .then((result) => reply(id, result))
          .catch((err) => reply(id, { content: [{ type: "text", text: String(err?.message ?? err) }], isError: true }));
        break;
      default:
        if (id !== undefined && id !== null) replyError(id, -32601, `Method not found: ${method}`);
        // notifications (no id) are silently ignored — as the protocol requires
    }
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    process.stderr.write(`[copilot] fatal: ${err?.message ?? err}\n`);
    process.exit(1);
  });
}
