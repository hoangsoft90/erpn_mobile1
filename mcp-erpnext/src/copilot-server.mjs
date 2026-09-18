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
import { buildPaymentProposal } from "./skills/payment-write.mjs";
// P8 (plan2_final §5 + §24.2): the authorization boundary. Server-side,
// contract-driven, never a prompt.
import { authorize, resolvePrincipal } from "./authorization.mjs";
// ── P4 (plan2_final §12 + §19): structured learning log for refusals/signals ──
import { logObservation } from "./learning-log.mjs";
// ── P5 (plan2_final §2 D2/D3/D8): dsh explicit opt-in gate — READ only ──
import { isDshContext, blockedInDshContext, dshWriteBlockedAnswer } from "./dsh-optin.mjs";
// ── P2 (plan2_final §12 + §14): uncertainty taxonomy + session context ──
import { SessionContext, CONTEXT_PROVENANCE } from "./session-context.mjs";
import { uncertaintyCopy, toUncertaintyCode, UNCERTAINTY_CODES } from "./uncertainty.mjs";

/**
 * One session-context per pipeline process. Keyed by NOTHING today (single
 * shop console); P8 (multi-user) keys it by session id — the API already takes
 * the instance, so the future change is at the call sites, not the store.
 */
const sessionContext = new SessionContext();
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
import { __contract, getCapability } from "./capability-contract.mjs";
import {
  classifyResolution,
  entityPolicy,
  pickFromCandidates,
  pickerCandidates,
  pickerForText,
} from "./entity-resolution.mjs";

/**
 * ERPNext target selection (user decision 2026-09-14: "khi tôi cung cấp
 * ERPNEXT_URL/API_KEY/API_SECRET thật, chỉ cần đổi endpoint, không phải
 * viết lại logic").
 *
 * - All three ERPNEXT_* env vars present -> spawn the PINNED real server.
 * - Otherwise -> mock (no credentials needed; tests default here).
 * - A malformed ERPNEXT_URL throws instead of silently falling back to mock
 *   (a wrong-target answer is worse than a refused start).
 *
 * Secrets stay in the environment (.env, gitignored) — never in cordis patch
 * files or anything committed.
 */
export function pickServerScript(env = process.env) {
  const { ERPNEXT_URL: url, ERPNEXT_API_KEY: key, ERPNEXT_API_SECRET: secret } = env;
  if (!url && !key && !secret) return MOCK_SERVER;
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

const NLP_PORT = process.env.NLP_SERVICE_PORT || "8787";
const NLP_URL = `http://127.0.0.1:${NLP_PORT}/normalize`;

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

/** Call the Python normalize bridge; throws when the service is unreachable. */
async function normalizeText(text) {
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
export async function resolveCustomer(skills, cleanedText) {
  const list = await skills.findCustomer("");
  const customers = list.data?.data ?? [];
  // Bare kinship titles are dropped as candidates (see KINSHIP_TITLES). They
  // are handled BEFORE scoring so they can neither win as a unique hit nor set
  // the ambiguity fallback.
  const cands = nameCandidates(cleanedText).filter((c) => !KINSHIP_TITLES.has(c.toLowerCase()));
  let fallback = null;
  // Phase 6: a ONE-word fragment matching SEVERAL customers is the spec's
  // "≥2 candidate gần nhau" case — the answer is ASK, not pick and not a bare
  // "not found". Track it so the caller can tell the user what was ambiguous
  // (result9 taught us never to ANSWER for such a fragment; this makes the
  // refusal explicit instead of silently indistinguishable from a miss).
  let multiHitNoPick = null; // { fragment, candidates: [customer_name...] }
  for (const cand of cands) {
    const hits = customers.filter(
      (c) =>
        c.customer_name?.toLowerCase() === cand.toLowerCase() ||
        c.name?.toLowerCase() === cand.toLowerCase(),
    );
    if (hits.length === 1) return { customer: hits[0], ambiguous: false, candidates: [] };
    if (hits.length > 1 && !fallback) fallback = hits[0];
  }
  for (const cand of cands) {
    const hits = customers.filter(
      (c) =>
        c.customer_name?.toLowerCase().includes(cand.toLowerCase()) ||
        c.name?.toLowerCase().includes(cand.toLowerCase()),
    );
    if (hits.length === 1) return { customer: hits[0], ambiguous: false, candidates: [] };
    if (hits.length > 1) {
      if (!fallback && cand.includes(" ")) fallback = hits[0];
      if (!multiHitNoPick && !cand.includes(" ")) {
        multiHitNoPick = { fragment: cand, candidates: hits.map((h) => h.customer_name ?? h.name) };
      }
    }
  }
  if (fallback) return { customer: fallback, ambiguous: true, candidates: [] };
  if (multiHitNoPick) {
    return { customer: null, ambiguous: true, candidates: multiHitNoPick.candidates };
  }
  return { customer: null, ambiguous: false, candidates: [] };
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
  const mcp = createMcpClient({ serverScript: pickServerScript() }); // real when ERPNEXT_* set, mock otherwise
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
      try {
        const items = (await skills.findItem("")).data?.data ?? []; // "" = all items
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
      const lines = rows.map((r) => `${r.item_code}: ${r.actual_qty} (kho ${r.warehouse})`);
      const answer = note ? [...lines, note] : lines;
      // Phase 6: informational proposal for the inventory read (entity = the
      // named item when exactly one matched, else none).
      const itemEntity =
        named.length === 1
          ? { kind: "item", id: named[0].item_code ?? named[0].name, name: named[0].item_name ?? named[0].item_code }
          : { kind: "item", id: null, name: null };
      const proposal = readProposal({
        action: "read_stock_balance",
        entity: itemEntity,
        params: rows.length > 0 ? { rows: rows.length, warehouses: [...new Set(rows.map((r) => r.warehouse))] } : {},
        summary: named.length === 1 ? `Xem tồn kho: ${itemEntity.name}` : "Xem tồn kho",
      });
      return {
        question: rawText,
        normalized: nlp,
        routed: { group: route.group, matched: route.matched },
        answer,
        rows,
        proposal,
      };
    }

    // Customer-bound intents: resolve the name first — IDs only ever come from
    // a tool result (the guard refuses invented ones).
    let { customer, ambiguous, candidates } = await resolveCustomer(skills, nlp.text);
    // An explicit PICK from the Flutter picker (additive `/ask` field) replaces
    // the fuzzy guess — but only for an id that exists in the list we just read
    // from ERPNext (§4.2: nothing downstream may invent an ERP id).
    let picked = null;
    if (opts.pickedEntityId) {
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
    if (!customer) {
      return withUncertainty({
        question: rawText,
        normalized: nlp,
        routed: { group: route.group, matched: route.matched },
        answer: null,
        // Phase 6 distinction (spec: "≥2 candidate gần nhau: hỏi lại user"):
        // ambiguous ⇒ say WHICH names collided, never a bare "not found".
        error_code: ambiguous ? "AMBIGUOUS_ENTITY" : "MISSING_ENTITY",
        reason: ambiguous
          ? `tên khách trong "${nlp.text}" khớp nhiều kết quả (${safeCandidates.slice(0, 5).join(", ")}) — cần nói rõ tên đầy đủ`
          : `không tìm thấy khách hàng trong "${nlp.text}" (entity resolution mở rộng là Phase 6.5)`,
        proposal: null,
        ambiguous,
        candidates: safeCandidates,
      });
    }

    const ambNote = ambiguous
      ? " (⚠️ tên khách trùng nhiều kết quả — đã lấy kết quả đầu tiên, entity resolution mở rộng là Phase 6.5)"
      : "";

    // ── P1 §4.3: name the resolution state, then apply the CONTRACT's policy ──
    // The state is what makes the risk rule checkable: a fuzzy substring hit is
    // FUZZY_SINGLE_MATCH, and for a WRITE the contract forbids auto-selecting
    // it. Nothing here is inferred from confidence — only from how the name
    // actually matched.
    const resolution = classifyResolution(
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
    if (customer?.name && route.group !== "payment_write") {
      sessionContext.set("customer", {
        id: customer.name,
        name: customer.customer_name ?? null,
        provenance:
          resolution.state === "EXACT_MATCH" || picked?.ok
            ? CONTEXT_PROVENANCE.USER_SELECTED
            : CONTEXT_PROVENANCE.DERIVED,
      });
    }

    // Phase 7b (user decision 2026-09-16): the ONLY write-producing intent.
    // "thu tiền cho <khách> <số tiền>" → a HIGH proposal that STOPS at the
    // card; nothing is written until POST /execute (human confirm). The write
    // itself re-reads live ERPNext data and re-validates (Phase 9).
    if (route.group === "payment_write") {
      // result37 review: the OUTER guard already resolved this customer from
      // the same text — re-calling resolveCustomer() here duplicated the full
      // catalog round-trip per question and risked the two blocks diverging.
      // Reuse `customer`/`ambiguous`/`candidates` from the guard above; the
      // ambiguity note still travels in the answer (ambNote below).
      if (!customer) {
        return withUncertainty({
          question: rawText,
          normalized: nlp,
          routed: { group: route.group, matched: route.matched },
          answer: null,
          reason: ambiguous
            ? `tên khách trong "${rawText}" khớp nhiều kết quả (${(candidates ?? []).slice(0, 5).join(", ")}) — cần nói rõ tên đầy đủ trước khi ghi phiếu thu`
            : `không tìm thấy khách hàng trong "${rawText}" — không ghi phiếu thu`,
          error_code: entityRule.code ?? (ambiguous ? "AMBIGUOUS_ENTITY" : "MISSING_ENTITY"),
          proposal: null,
          ambiguous,
          candidates: candidates ?? [],
          entity: { state: resolution.state, policy: entityRule },
        });
      }
      // §4.3/§8: WRITE is Exact-only. A fuzzy single hit (e.g. "Lan" →
      // "Nguyễn Thị Lan") or several candidates must NOT become an authoritative
      // customer id by itself — the user picks. No proposal is built yet, so
      // there is nothing to confirm and nothing can be written.
      if (entityRule.require_picker) {
        const all = (await skills.findCustomer("")).data?.data ?? [];
        return withUncertainty({
          question: rawText,
          normalized: nlp,
          routed: { group: route.group, matched: route.matched },
          answer: null,
          error_code: entityRule.code ?? "ENTITY_PICK_REQUIRED",
          reason:
            `tên khách "${safeCandidates[0] ?? rawText}" khớp ${resolution.state === "AMBIGUOUS_MATCH" ? "nhiều khách" : "một khách KHÔNG trùng tên chính xác"} — ghi phiếu thu cần chọn đúng khách trước (chưa có đề xuất nào)`,
          proposal: null,
          entity: { state: resolution.state, policy: entityRule },
          candidates: pickerForText(all, nameCandidates(nlp.text)),
        });
      }
      if (entityRule.block) {
        return withUncertainty({
          question: rawText,
          normalized: nlp,
          routed: { group: route.group, matched: route.matched },
          answer: null,
          error_code: entityRule.code ?? "ENTITY_NOT_FOUND_BLOCKED",
          reason: `không xác định được khách (${resolution.state}) — không ghi phiếu thu`,
          proposal: null,
          entity: { state: resolution.state, policy: entityRule },
        });
      }
      try {
        // ── P2 §14 deliverable 3: a WRITE may consume session context only when
        // it is alive AND user-selected/exact. A derived (fuzzy) read from an
        // earlier sentence never seeds a payment; an expired entry behaves like
        // a first mention (the guards above already refused with the picker).
        let customerId = customer.name;
        let customerName = customer.customer_name;
        const ctx = sessionContext.writeEligible("customer");
        if (ctx.eligible) {
          customerId = ctx.context.value;
          customerName = ctx.context.name ?? ctx.context.value;
        }
        const built = await buildPaymentProposal(
          skills,
          { customer: { ...customer, name: customerId, customer_name: customerName }, ambiguous, candidates },
          {
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
          },
        );
        const amt = built.proposal.params.amount_vnd;
        const base = built.proposal.params.submit_now === true
          ? `Đề xuất thu ${formatVnd(amt)}đ từ ${customer.customer_name} cho chứng từ ${built.invoice} — bấm [Xác nhận] sẽ TẠO phiếu và NỘP NGAY: công nợ khách giảm ngay khi xác nhận.`
          : `Đề xuất thu ${formatVnd(amt)}đ từ ${customer.customer_name} cho chứng từ ${built.invoice} — kiểm tra và bấm [Xác nhận] để ghi phiếu thu (đề xuất chỉ TẠO PHIẾU NHÁP, chưa submit).`;
        const answer = base + ambNote;
        return {
          question: rawText,
          normalized: nlp,
          routed: { group: route.group, matched: route.matched },
          customer: { id: customer.name, name: customer.customer_name },
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
          answer: null,
          reason: `không tạo được đề xuất thu tiền: ${err?.message ?? err}`,
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
      const pays = await skills.listPaymentEntries(customer.name, knownIds);
      const rows = (pays.data?.data ?? []).map((p) => ({
        id: p.name,
        date: p.posting_date,
        amount_vnd: Number(p.paid_amount) || 0,
      }));
      const total = rows.reduce((s, r) => s + r.amount_vnd, 0);
      const answer =
        rows.length > 0
          ? `${customer.customer_name} đã có ${rows.length} phiếu thu, tổng ${formatVnd(total)}đ (mới nhất: ${rows[0].id} ngày ${rows[0].date}).${ambNote}`
          : `${customer.customer_name} chưa có phiếu thu nào trong hệ thống. Để ghi phiếu thu mới, hãy nói "thu tiền cho <tên khách> <số tiền>".${ambNote}`;
      // Phase 6: the read itself is READ-level; the FUTURE write this question
      // points at (create_payment_entry) is HIGH — surfaced in the proposal so
      // the UI can show what a confirmation would guard from Phase 7 on.
      const proposal = buildProposal({
        action: "read_payment_history",
        risk: "READ",
        entity: { kind: "customer", id: customer.name, name: customer.customer_name },
        params: { entries: rows.length, total_vnd: total },
        summary: `Xem lịch sử phiếu thu: ${customer.customer_name}`,
        extra: { next_action_hint: { action: "create_payment_entry", risk: "HIGH" } },
      });
      return { question: rawText, normalized: nlp, routed: { group: route.group, matched: route.matched }, customer: { id: customer.name, name: customer.customer_name }, rows, answer, proposal };
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
      return { question: rawText, normalized: nlp, routed: { group: route.group, matched: route.matched }, customer: { id: customer.name, name: customer.customer_name }, rows, answer, proposal };
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
