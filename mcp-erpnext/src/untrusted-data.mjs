/**
 * Untrusted-data policy (P0, plan2_final §24.1 — CRITICAL).
 *
 * ERPNext field values (customer names, notes, descriptions) and raw user text
 * are DATA, never INSTRUCTIONS. Today the deterministic pipeline never feeds
 * them to an LLM, but the moment an LLM sits in the loop (P3 classifier / DSH
 * advanced read) any field could carry "ignore previous instructions".
 *
 * This module is the post-entity-resolution filter the contract declares:
 *   - strip instruction-looking patterns from a field value
 *   - cap field length (max_length_per_field: 500)
 *   - wrap values in <UNTRUSTED_DATA>...</UNTRUSTED_DATA> when they will be
 *     interpolated into an LLM prompt
 *   - NEVER let a value reach a system prompt as plain instructions
 *
 * It is wired now where ERPNext-sourced text is echoed back (ambiguous
 * candidates), so the module is live code, not a prepared-but-unused file —
 * and it is the single place P3 must call.
 */

/** Patterns that look like an attempt to speak as the system, not as data. */
const INSTRUCTION_PATTERNS = [
  /ignore\s+(all\s+)?previous\s+instructions?/gi,
  /disregard\s+(all\s+)?(previous|above)/gi,
  /\bsystem\s*:/gi,
  /\bassistant\s*:/gi,
  /\bdeveloper\s*:/gi,
  /###+/g,
  /<\|[^>]*\|>/g, // chat-template control tokens
  /\bBEGIN\s+SYSTEM\b/gi,
];

export const MAX_FIELD_LENGTH = 500;

/**
 * Neutralise instruction-looking content inside one untrusted field value.
 * Returns plain text — safe to display, and safe to place inside an LLM
 * user-message after wrapping.
 * @param {unknown} value
 * @param {{maxLength?: number}} [opts]
 * @returns {string}
 */
export function sanitizeUntrustedText(value, { maxLength = MAX_FIELD_LENGTH } = {}) {
  if (value === null || value === undefined) return "";
  let text = String(value);
  // Normalise control characters first: they are how "invisible" prompts hide.
  text = text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, " ");
  for (const re of INSTRUCTION_PATTERNS) {
    text = text.replace(re, "[đã lọc chỉ dẫn]");
  }
  text = text.replace(/\s+/g, " ").trim();
  if (text.length > maxLength) text = `${text.slice(0, maxLength)}…`;
  return text;
}

/**
 * Wrap an untrusted value for interpolation into an LLM prompt. The delimiters
 * are the contract's guarantee that the model reads it as data.
 * @param {unknown} value
 * @param {{maxLength?: number}} [opts]
 * @returns {string}
 */
export function wrapUntrusted(value, opts = {}) {
  return `<UNTRUSTED_DATA>${sanitizeUntrustedText(value, opts)}</UNTRUSTED_DATA>`;
}

/**
 * Sanitise a list of ERPNext-sourced display strings (e.g. the ambiguous
 * customer candidates echoed back to the user).
 * @param {unknown[]} values
 * @returns {string[]}
 */
export function sanitizeUntrustedList(values) {
  if (!Array.isArray(values)) return [];
  return values.map((v) => sanitizeUntrustedText(v)).filter((v) => v.length > 0);
}

/**
 * True when a value carries an instruction-looking pattern (for logging
 * violations — the contract says log_violations: true).
 * @param {unknown} value
 */
export function containsInstructionPattern(value) {
  const text = String(value ?? "");
  return INSTRUCTION_PATTERNS.some((re) => {
    re.lastIndex = 0;
    return re.test(text);
  });
}
