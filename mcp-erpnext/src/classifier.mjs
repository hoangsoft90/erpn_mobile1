/**
 * P3 — LLM Classifier (plan2_final §15, §19 P3, §24.1, §24.7).
 *
 * ROLE: the deterministic keyword router covers the daily phrasings. When it
 * returns null ("I did not understand"), this module asks the LLM Router (the
 * SAME Phase-5 gateway dsh uses — no agent loop, no DSH, no tool calls) to
 * name the INTENT semantically. The result flows BACK into the existing skill
 * + Safety path: the classifier never executes anything, it only tells the
 * pipeline which contract capability the sentence meant.
 *
 * HARD RULES (plan2_final §2 D2/D7 + §24.1):
 *  - Output is SEMANTIC ONLY. Never a database id. Any `*_id` / `docname`
 *    field is STRIPPED before the caller sees it, so an ERPNext id can never
 *    travel out of an LLM (IDs only ever come from the Entity Resolver).
 *  - `intent` must be a capability that exists in the Capability Contract;
 *    anything else is rejected (the contract, not the model, decides what the
 *    system can do).
 *  - `confidence` NEVER bypasses confirmation/authorization/amount policy —
 *    it is only used to decide "route vs ask again" (LOW_CONFIDENCE).
 *  - Untrusted text is wrapped (untrusted-data.mjs) before it enters a prompt.
 *  - LLM down / slow / malformed ⇒ return { ok:false } — the caller stays
 *    rule-only. Nothing here ever throws into the HTTP path.
 */

import { listCapabilities, getCapability, isForbidden } from "./capability-contract.mjs";
import { wrapUntrusted, containsInstructionPattern } from "./untrusted-data.mjs";

/** Slot keys the model may return. TEXT only — no ids, no enums as policy. */
export const SLOT_KEYS = Object.freeze([
  "customer_text",
  "amount_text",
  "item_text",
  "invoice_text",
  "reference_text",
  "date_text",
  "note_text",
  "party_text",
  "warehouse_text",
]);

/**
 * Keys that look like a database identifier. If the model returns one it is a
 * prompt-injection / hallucination risk, so it is dropped and counted — the
 * caller must never receive it (exit criterion: "classifier không bao giờ trả
 * ERP id").
 */
const ID_LIKE_KEY = /(^|_)(id|ids|docname|erpnext_id|name_id|ref_id|pk)$/i;

export const CLASSIFIER_DEFAULTS = Object.freeze({
  /** LLM Router (Phase 5) OpenAI-compatible endpoint. */
  url: "http://127.0.0.1:8900",
  model: "oc/big-pickle",
  /** Bounded so an unknown sentence never blocks the answer for long (spec §15
   * "không block 2.5s im lặng"): the request is capped, then we fall back. */
  timeoutMs: 2500,
  /** Below this, we ask again (LOW_CONFIDENCE) instead of routing on a guess. */
  minConfidence: 0.55,
});

const MAX_KNOWN_INTENTS_IN_PROMPT = 40;

/**
 * Env numbers must be FINITE AND POSITIVE or the default is used. Three
 * concrete fail-opens this guard closes (all probed on Node 24):
 *  - `Number('garbage')` is NaN → `setTimeout(abort, NaN)` degrades to a 1ms
 *    timer (classifier aborts at t≈0, misleading TimeoutNaNWarning);
 *  - `Number('')` is 0 → minConfidence 0 means the low-confidence gate is
 *    silently OFF (and timeoutMs 0 means abort at t=0);
 *  - a negative value passes neither check either (negative minConfidence =
 *    gate off; negative timeout ≈ 1ms).
 * One rule: non-positive-or-non-finite ⇒ SAFE default. The gate cannot be
 * turned off via a broken env var — disabling the classifier is done
 * explicitly with COPILOT_CLASSIFIER=off.
 */
function finiteNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Resolve classifier config from env (off switch included). */
export function classifierConfig(env = process.env) {
  return {
    enabled: String(env.COPILOT_CLASSIFIER ?? "on").toLowerCase() !== "off",
    url: env.COPILOT_CLASSIFIER_URL ?? CLASSIFIER_DEFAULTS.url,
    model: env.COPILOT_CLASSIFIER_MODEL ?? CLASSIFIER_DEFAULTS.model,
    timeoutMs: finiteNumber(env.COPILOT_CLASSIFIER_TIMEOUT_MS ?? CLASSIFIER_DEFAULTS.timeoutMs, CLASSIFIER_DEFAULTS.timeoutMs),
    minConfidence: finiteNumber(env.COPILOT_CLASSIFIER_MIN_CONFIDENCE ?? CLASSIFIER_DEFAULTS.minConfidence, CLASSIFIER_DEFAULTS.minConfidence),
    apiKeyEnv: env.COPILOT_CLASSIFIER_API_KEY_ENV ?? null,
  };
}

/** The contract intents the classifier may name (forbidden ones excluded). */
export function allowedIntents() {
  return listCapabilities().filter((id) => !isForbidden(id));
}

function buildPrompt() {
  const intents = allowedIntents();
  const list = intents.slice(0, MAX_KNOWN_INTENTS_IN_PROMPT).join(", ");
  return [
    "Bạn là bộ phân loại ý định cho một trợ lý ERPNext tiếng Việt.",
    "CHỈ trả về JSON hợp lệ, không giải thích, không markdown.",
    "Các trường bắt buộc:",
    '  "intent": một trong các giá trị sau (đúng nguyên văn): ' + list,
    '  "confidence": số từ 0 đến 1',
    '  "slots": object chỉ chứa các khoá text (customer_text, amount_text, item_text, invoice_text, reference_text, date_text, note_text, party_text, warehouse_text)',
    '  "missing_entities": mảng chuỗi mô tả thông tin còn thiếu',
    '  "needs_clarification": true/false',
    "TUYỆT ĐỐI KHÔNG trả về id, mã chứng từ, docname hay bất kỳ định danh cơ sở dữ liệu nào.",
    "Nếu câu không khớp ý định nào, trả intent rỗng và needs_clarification = true.",
  ].join("\n");
}

/**
 * Validate a raw model classification against the contract. Fail-closed:
 * anything unexpected makes the whole classification unusable (ok:false) —
 * the pipeline then behaves exactly as if the LLM were down (rule-only).
 *
 * @param {unknown} raw parsed JSON from the model
 * @param {{knownIntents?: string[], minConfidence?: number}} [opts]
 * @returns {{ok: boolean, reason?: string, intent?: string|null, confidence?: number,
 *            slots?: Record<string,string>, missing_entities?: string[],
 *            needs_clarification?: boolean, rejected_keys?: string[], low_confidence?: boolean}}
 */
export function validateClassification(raw, opts = {}) {
  const knownIntents = opts.knownIntents ?? allowedIntents();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, reason: "NOT_AN_OBJECT" };
  }

  // intent — must be a REAL capability. Empty/unknown is a valid "I don't
  // know", surfaced as LOW_CONFIDENCE rather than a fake route.
  const rawIntent = raw.intent;
  let intent = null;
  if (typeof rawIntent === "string" && rawIntent.trim().length > 0) {
    if (!knownIntents.includes(rawIntent.trim())) {
      return { ok: false, reason: "INTENT_NOT_IN_CONTRACT", intent: rawIntent.trim() };
    }
    intent = rawIntent.trim();
  }

  // confidence — must be a FINITE NUMBER in [0,1]. Type-check first: `Number(null)`
  // is 0 and `Number(true)` is 1, so coercion would silently turn garbage into a
  // value; a missing/garbage confidence cannot be treated as certain.
  const confidence = raw.confidence;
  if (typeof confidence !== "number" || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    return { ok: false, reason: "CONFIDENCE_INVALID", intent };
  }

  // slots — keep ONLY allowlisted string keys. Everything else (including any
  // database-id-looking field) is dropped and reported.
  const slots = {};
  const rejected_keys = [];
  const rawSlots = raw.slots;
  if (rawSlots && typeof rawSlots === "object" && !Array.isArray(rawSlots)) {
    for (const [key, value] of Object.entries(rawSlots)) {
      if (ID_LIKE_KEY.test(key)) {
        rejected_keys.push(key);
        continue;
      }
      if (!SLOT_KEYS.includes(key)) continue;
      if (typeof value === "string" && value.trim().length > 0) {
        // Semantic text only; it is used as a search term, never as authority.
        slots[key] = value.trim();
      }
    }
  }

  const missing_entities = Array.isArray(raw.missing_entities)
    ? raw.missing_entities.filter((x) => typeof x === "string" && x.trim().length > 0).map((x) => x.trim())
    : [];
  const needs_clarification = raw.needs_clarification === true;

  const minConfidence = Number(opts.minConfidence ?? CLASSIFIER_DEFAULTS.minConfidence);
  const low_confidence =
    intent === null || confidence < minConfidence || needs_clarification === true;

  return {
    ok: true,
    intent,
    confidence,
    slots,
    missing_entities,
    needs_clarification,
    rejected_keys,
    low_confidence,
  };
}

/** Extract the assistant message text from an OpenAI-compatible response. */
function extractContent(body) {
  const choice = body?.choices?.[0];
  const content = choice?.message?.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((p) => p?.type === "text")
      .map((p) => p?.text ?? "")
      .join("");
  }
  return "";
}

/** Parse JSON that may be wrapped in ```json fences or extra prose. */
function parseJsonLoose(text) {
  const t = String(text ?? "").trim();
  if (!t) return null;
  try {
    return JSON.parse(t);
  } catch {
    // fall through to fence/brace extraction
  }
  const fenced = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) {
    try {
      return JSON.parse(fenced[1].trim());
    } catch {
      /* keep trying */
    }
  }
  const firstBrace = t.indexOf("{");
  const lastBrace = t.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    try {
      return JSON.parse(t.slice(firstBrace, lastBrace + 1));
    } catch {
      /* give up */
    }
  }
  return null;
}

/**
 * Ask the LLM Router to classify an (already normalized) Vietnamese sentence.
 * Never throws: any failure returns { ok:false, reason } so the caller can
 * stay rule-only.
 *
 * @param {string} text normalized text (Phase 1 output)
 * @param {{config?: object, fetchImpl?: Function, knownIntents?: string[]}} [opts]
 */
export async function classifyIntent(text, opts = {}) {
  const config = opts.config ?? classifierConfig();
  if (!config.enabled) return { ok: false, reason: "CLASSIFIER_DISABLED" };

  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") return { ok: false, reason: "NO_FETCH" };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    if (typeof text === "string" && containsInstructionPattern(text)) {
      process.stderr.write("[classifier] untrusted-data violation logged: instruction pattern in input\n");
    }
    const headers = { "Content-Type": "application/json" };
    if (config.apiKeyEnv && process.env[config.apiKeyEnv]) {
      headers.Authorization = `Bearer ${process.env[config.apiKeyEnv]}`;
    }
    const res = await fetchImpl(`${String(config.url).replace(/\/$/, "")}/v1/chat/completions`, {
      method: "POST",
      headers,
      signal: controller.signal,
      body: JSON.stringify({
        model: config.model,
        temperature: 0,
        messages: [
          { role: "system", content: buildPrompt() },
          // §24.1: the sentence is DATA, wrapped so it can never read as an
          // instruction to the model.
          { role: "user", content: wrapUntrusted(text) },
        ],
      }),
    });
    if (!res.ok) return { ok: false, reason: `HTTP_${res.status}` };
    const body = await res.json();
    const content = extractContent(body);
    const parsed = parseJsonLoose(content);
    if (!parsed) return { ok: false, reason: "UNPARSEABLE" };
    return validateClassification(parsed, {
      knownIntents: opts.knownIntents,
      minConfidence: config.minConfidence,
    });
  } catch (err) {
    const reason = err?.name === "AbortError" ? "TIMEOUT" : `ERROR_${err?.name ?? "UNKNOWN"}`;
    return { ok: false, reason };
  } finally {
    clearTimeout(timer);
  }
}

/** Test seam: the contract capability a validated classification maps to. */
export function capabilityForIntent(intent) {
  if (typeof intent !== "string") return null;
  return getCapability(intent);
}
