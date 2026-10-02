/**
 * C0 — MOCK OCR provider. Required for CI: with `OCR_PROVIDER` unset this is
 * what every test and a fresh checkout get, so the OCR seam is exercised on
 * every run without a vendor, a network, credentials, or provider quota.
 *
 * Two properties matter more than realism:
 *   - DETERMINISTIC: the same call returns the same text, so a failing test is
 *     a real regression and not a flaky vendor.
 *   - HONEST ABOUT BEING A MOCK: `provider: "mock"` travels with the result, and
 *     the text is a synthesised invoice — nothing here can be mistaken for a
 *     real reading of the caller's image.
 *
 * Pass `text` to exercise a specific shape (an invoice, an empty page, an
 * injection trying to impersonate the system).
 */

import { OcrError } from "../ocr-provider.mjs";

/** A feed-shop invoice, close enough to what C1/C2 will see in the field. */
export const MOCK_INVOICE_TEXT = [
  "HÓA ĐƠN BÁN HÀNG",
  "Công ty TNHH Cám Hà Tiên",
  "Khách hàng: Nguyễn Thị Lan",
  "Cám heo tăng trọng 25kg  10 Bao  305.000  3.050.000",
  "Tổng tiền: 3.050.000",
].join("\n");

export const MOCK_OCR_MODEL = "mock-ocr-1";

/**
 * @param {{text?: string, confidences?: number[], blocks?: object[], latencyMs?: number, ms?: number}} [opts]
 * @returns {{id: string, recognize: Function}}
 */
export function createMockOcrProvider({ text, confidences, blocks, latencyMs = 0, ms } = {}) {
  const raw = text === undefined ? MOCK_INVOICE_TEXT : String(text);
  const conf = confidences === undefined ? [0.97, 0.95, 0.93] : confidences;
  const shaped = blocks === undefined ? undefined : blocks;

  return {
    id: "mock",
    provider: "mock",
    model: MOCK_OCR_MODEL,
    /**
     * @param {{image?: unknown, mimeType?: string, hint?: string}} [_input]
     */
    async recognize(_input = {}) {
      if (latencyMs > 0) await new Promise((r) => setTimeout(r, latencyMs));
      // Deliberately NOT keyed off the image bytes: a mock that varies by input
      // makes an unrelated test flake the moment a fixture changes size.
      return {
        raw_text: raw,
        confidences: conf,
        ...(shaped === undefined ? {} : { blocks: shaped }),
        provider: "mock",
        model: MOCK_OCR_MODEL,
        ms: ms === undefined ? 0 : ms,
      };
    },
  };
}

/**
 * A provider that always fails — for asserting the fail-closed path without a
 * network. Kept here (not in the test file) so a real caller can also use it.
 * @param {string} [code]
 */
export function createFailingOcrProvider(code = "OCR_PROVIDER_FAILED") {
  return {
    id: "mock-failing",
    provider: "mock-failing",
    model: null,
    async recognize() {
      throw new OcrError(code, "mock provider configured to fail");
    },
  };
}
