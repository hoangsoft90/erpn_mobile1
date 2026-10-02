/**
 * C0 — OCR input layer, FOUNDATION ONLY (plan3 §6.3–6.4, Trụ C).
 *
 * Camera is an INPUT CHANNEL, not a second pipeline: a photo becomes text, that
 * text enters the same classifier → Capability Contract → Safety Gateway path
 * typed text already takes. This module is the seam, and it is deliberately
 * thin — it owns exactly four things:
 *
 *   1. THE INTERFACE. An `OcrProvider` is `{ id, recognize(input) }`:
 *        recognize({ image, mimeType, hint }) →
 *          { raw_text, confidences?, blocks?, provider, model?, ms? }
 *      `raw_text` is the ONLY required field. `confidences`/`blocks` are
 *      optional because vendors differ; when they are absent the confidence
 *      gate below simply cannot judge (it does NOT assume "high").
 *
 *   2. FAIL-CLOSED VALIDATION of whatever a provider hands back
 *      (`assertOcrResult`): a malformed result is an error, never an empty
 *      string that later looks like "the photo had no text".
 *
 *   3. THE UNTRUSTED BOUNDARY (`prepareOcrText`): text read off a photo is
 *      attacker-influenced DATA — an invoice can print "ignore previous
 *      instructions" — so it is sanitised and wrapped with the SAME helper the
 *      rest of the system uses (src/untrusted-data.mjs) BEFORE it can reach any
 *      classifier/LLM prompt. Nothing in this file trusts a photo's text.
 *
 *   4. PROVIDER SELECTION (`getOcrProvider`): missing env = the CI mock, a
 *      PARTIAL or unknown configuration = a hard error. Never a silent swap,
 *      because "the OCR engine silently changed" is not observable downstream.
 *
 * It does NOT: call /execute, touch ERPNext, build a proposal, submit anything,
 * or persist an image. C0 opens no write path (that is C2, through the same
 * gateway as every other write).
 */

import { ocrPolicy } from "../capability-contract.mjs";
import { containsInstructionPattern, sanitizeUntrustedText, wrapUntrusted } from "../untrusted-data.mjs";
import { createMockOcrProvider } from "./providers/mock-ocr.mjs";
import { createRouterVisionProvider } from "./providers/router-vision.mjs";

/** Outcomes of turning an OCR result into pipeline-ready text. */
export const OCR_STATUSES = Object.freeze(["OK", "LOW_CONFIDENCE", "NO_TEXT"]);

/** Typed error so callers (and tests) can branch on the code, not the message. */
export class OcrError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = "OcrError";
    this.code = code;
  }
}

/**
 * Image types this layer will hand to a model. An allowlist, not a passthrough:
 * the mime type is interpolated into a `data:` URL AND travels into the prompt,
 * so a caller-supplied string is input from an untrusted boundary — it either
 * matches one of these or the request is refused.
 */
export const OCR_IMAGE_TYPES = Object.freeze(["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"]);

/**
 * Size of an image in BYTES, for a Buffer/Uint8Array/ArrayBuffer or a base64
 * string. Used both for the size cap and for the metadata-only log line.
 * @param {Uint8Array|Buffer|ArrayBuffer|string|null} image
 */
export function imageBytes(image) {
  if (typeof image === "string") return Buffer.byteLength(image, "base64");
  if (image instanceof ArrayBuffer) return image.byteLength;
  return image?.length ?? image?.byteLength ?? 0;
}

/**
 * Fail-closed input check, run BEFORE anything is sent anywhere: the image must
 * exist, its type must be on the allowlist, and it must fit the policy cap.
 * A 12 MB photo is a refusal with a clear code, never an attempt that dies
 * somewhere inside a vendor call.
 *
 * @param {{image?: unknown, mimeType?: string}} input
 * @param {{policy?: object}} [opts]
 */
export function assertOcrInput({ image, mimeType = "image/jpeg" } = {}, { policy = ocrPolicy() } = {}) {
  if (image === undefined || image === null) {
    throw new OcrError("OCR_INPUT_INVALID", "recognize() needs an image");
  }
  if (!OCR_IMAGE_TYPES.includes(mimeType)) {
    throw new OcrError(
      "OCR_INPUT_INVALID",
      `unsupported image type "${mimeType}" (allowed: ${OCR_IMAGE_TYPES.join(", ")})`,
    );
  }
  const bytes = imageBytes(image);
  if (bytes === 0) throw new OcrError("OCR_INPUT_INVALID", "the image is empty");
  if (bytes > policy.max_image_bytes) {
    throw new OcrError(
      "OCR_INPUT_TOO_LARGE",
      `${bytes} bytes exceeds ocr_policy.max_image_bytes (${policy.max_image_bytes})`,
    );
  }
  return { bytes, mimeType };
}

/**
 * Fail-closed shape check for a provider result.
 *
 * Deliberately strict: `raw_text` must be a STRING (an array/object here means
 * the provider was wired wrong, and coercing it with String() would hide that),
 * and `confidences` — when present — must be numbers in [0, 1].
 *
 * @param {object} result
 * @returns {object} the same result (for chaining)
 */
export function assertOcrResult(result) {
  if (!result || typeof result !== "object") {
    throw new OcrError("OCR_RESULT_INVALID", `expected an object, got ${typeof result}`);
  }
  if (typeof result.raw_text !== "string") {
    throw new OcrError("OCR_RESULT_INVALID", `raw_text must be a string, got ${typeof result.raw_text}`);
  }
  if (result.confidences !== undefined) {
    if (!Array.isArray(result.confidences)) {
      throw new OcrError("OCR_RESULT_INVALID", "confidences must be an array when present");
    }
    for (const c of result.confidences) {
      if (typeof c !== "number" || Number.isNaN(c) || c < 0 || c > 1) {
        throw new OcrError("OCR_RESULT_INVALID", `confidences must be numbers in [0, 1], got ${c}`);
      }
    }
  }
  if (result.blocks !== undefined && !Array.isArray(result.blocks)) {
    throw new OcrError("OCR_RESULT_INVALID", "blocks must be an array when present");
  }
  return result;
}

/**
 * The confidence a result claims, or null when it cannot say.
 *
 * The MINIMUM is used, not the average: one confidently-read line must not
 * carry a page of guesses into a WRITE proposal.
 *
 * @param {object} result
 * @returns {number|null}
 */
export function confidenceOf(result) {
  const list = result?.confidences;
  if (!Array.isArray(list) || list.length === 0) return null;
  return Math.min(...list);
}

/**
 * Turn a provider result into pipeline-ready text.
 *
 * The order here IS the safety argument, so it is not rearranged casually:
 *   validate shape → sanitise (strip instruction-looking content + bound
 *   length) → decide status → wrap for any LLM prompt.
 *
 * A `usable: false` result must not open a proposal: `LOW_CONFIDENCE` means the
 * policy says ask again, and `NO_TEXT` means the photo produced nothing to act
 * on. Neither is an error — both are refusals.
 *
 * @param {object} result a provider result
 * @param {{policy?: object}} [opts]
 */
export function prepareOcrText(result, { policy = ocrPolicy() } = {}) {
  assertOcrResult(result);
  const raw = result.raw_text;
  // sanitizeUntrustedText ALSO bounds the length, so one photo cannot push an
  // unbounded string into the classifier.
  const text = sanitizeUntrustedText(raw, { maxLength: policy.max_text_length });
  const confidence = confidenceOf(result);
  let status = "OK";
  if (text.length === 0) status = "NO_TEXT";
  else if (confidence !== null && confidence < policy.min_confidence) status = "LOW_CONFIDENCE";
  return {
    status,
    usable: status === "OK",
    text,
    // For an LLM prompt (an optional slot extractor, C1/C2) — never the raw
    // string, and never without the delimiter the policy demands.
    wrapped: wrapUntrusted(raw, { maxLength: policy.max_text_length }),
    confidence,
    min_confidence: policy.min_confidence,
    instruction_pattern_found: containsInstructionPattern(raw),
    provider: result.provider ?? null,
    model: result.model ?? null,
  };
}

/**
 * A log line for one OCR attempt: metadata ONLY.
 *
 * plan3 §6.4 (PII): the raw image never reaches a log, and the recognised text
 * is the user's own document — so what gets logged is the provider, the size of
 * the input, the text LENGTH, confidence and whether instruction-looking
 * content was seen. Never `image`, never base64, never the text body.
 *
 * @param {{result?: object, prepared?: object, image?: unknown, ms?: number}} args
 * @returns {string}
 */
export function ocrLogLine({ result = null, prepared = null, image = null, ms = null } = {}) {
  const parts = [
    `provider=${result?.provider ?? prepared?.provider ?? "?"}`,
    `model=${result?.model ?? prepared?.model ?? "-"}`,
    `bytes=${imageBytes(image)}`,
    `chars=${prepared?.text?.length ?? 0}`,
    `confidence=${prepared?.confidence ?? "n/a"}`,
    `status=${prepared?.status ?? "?"}`,
    `instruction_pattern=${prepared?.instruction_pattern_found === true}`,
  ];
  if (ms !== null) parts.push(`ms=${ms}`);
  return `[ocr] ${parts.join(" ")}`;
}

/** True when a prepared result may be handed to the classifier. */
export function ocrTextUsable(prepared) {
  return prepared?.usable === true;
}

/**
 * Pick the OCR provider for this process.
 *
 * Convention (same as the ERPNext client's `pickServerScript`): NOTHING set
 * means the mock, so CI and a fresh checkout never depend on a vendor. Anything
 * PARTIAL or UNKNOWN is a hard error — silently mocking a production run would
 * look like "OCR worked, the photo just had no text".
 *
 * Env:
 *   OCR_PROVIDER      "mock" (default) | "router-vision"
 *   OCR_ROUTER_URL    vision endpoint on the LLM router (falls back to LLM_ROUTER_URL)
 *   OCR_VISION_MODEL  model id the router must be asked for (vision-capable)
 *   OCR_TIMEOUT_MS    optional, default 20000
 *
 * @param {Record<string,string|undefined>} [env]
 */
export function getOcrProvider(env = process.env) {
  const policy = ocrPolicy();
  const requested = String(env.OCR_PROVIDER ?? "").trim();
  const id = requested === "" ? "mock" : requested;

  if (!policy.allowed_providers.includes(id)) {
    throw new OcrError(
      "OCR_PROVIDER_UNKNOWN",
      `"${id}" is not in ocr_policy.allowed_providers (${policy.allowed_providers.join(", ")})`,
    );
  }
  if (id === "mock") return createMockOcrProvider();

  const url = env.OCR_ROUTER_URL ?? env.LLM_ROUTER_URL;
  const model = env.OCR_VISION_MODEL;
  const missing = [
    ["OCR_ROUTER_URL (or LLM_ROUTER_URL)", url],
    ["OCR_VISION_MODEL", model],
  ].filter(([, v]) => !v).map(([k]) => k);
  if (missing.length > 0) {
    throw new OcrError(
      "OCR_PROVIDER_MISCONFIGURED",
      `OCR_PROVIDER=${id} needs ${missing.join(", ")} — refusing to fall back to the mock silently`,
    );
  }
  const timeoutMs = Number(env.OCR_TIMEOUT_MS ?? 20000);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new OcrError("OCR_PROVIDER_MISCONFIGURED", `OCR_TIMEOUT_MS must be a positive number, got ${env.OCR_TIMEOUT_MS}`);
  }
  return createRouterVisionProvider({
    url,
    model,
    timeoutMs,
    apiKey: env.OCR_ROUTER_API_KEY ?? env.LLM_ROUTER_API_KEY ?? null,
  });
}
