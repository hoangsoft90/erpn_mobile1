/**
 * Business-level dedup (plan2_final §10.5) — a layer BESIDE technical
 * idempotency, never instead of it.
 *
 * The failure this catches is human, not technical: "Anh Tuấn trả 5 triệu" is
 * said twice, each utterance produces its own `command_id`, and the user
 * confirms both. `command_id` idempotency cannot see that — the two commands
 * are different by construction. What they share is the underlying INTENT:
 * same customer, same amount, same capability, close in time.
 *
 * Policy (from the contract, `business_dedup`): `warn_extra_confirm` — warn,
 * never block silently. The user is the only one who knows whether it is the
 * same transaction or an additional one.
 *
 * Storage: an append-only JSONL ledger next to the idempotency store (a plain
 * file on purpose: it must survive a restart, and it is evidence).
 */

import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** §10.5: fingerprint = customer + amount + capability + time bucket. */
export const DEDUP_BUCKET_MS = 15 * 60 * 1000;

/**
 * @param {object} proposal
 * @param {{bucketMs?: number, now?: number}} [opts]
 * @returns {string|null} null when the proposal has no amount (nothing to guard)
 */
export function businessFingerprint(proposal, { bucketMs = DEDUP_BUCKET_MS, now = Date.now() } = {}) {
  const customer = proposal?.entity?.id;
  const amount = Number(proposal?.params?.amount_vnd);
  const capability = proposal?.action;
  if (!customer || !Number.isFinite(amount) || !capability) return null;
  const bucket = Math.floor(now / bucketMs);
  return createHash("sha256").update(`${customer}|${Math.round(amount)}|${capability}|${bucket}`).digest("hex").slice(0, 32);
}

/**
 * Append-only ledger of fingerprints that were actually proposed/executed.
 */
export class BusinessDedupLedger {
  /** @param {string} dir directory that also holds the idempotency store */
  constructor(dir) {
    this.dir = dir;
    this.file = join(dir, "business-dedup.jsonl");
  }

  _ensure() {
    const d = dirname(this.file);
    if (!existsSync(d)) mkdirSync(d, { recursive: true });
  }

  /** @returns {object[]} recorded entries (tolerant of a torn last line) */
  entries() {
    if (!existsSync(this.file)) return [];
    const out = [];
    for (const line of readFileSync(this.file, "utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line));
      } catch {
        // a half-written last line must not break the guard
      }
    }
    return out;
  }

  /**
   * Who else tried this same intent, and when?
   * @param {string} fingerprint
   * @param {{now?:number, bucketMs?:number}} [opts]
   * @returns {object[]} prior entries inside the window
   */
  priorMatches(fingerprint, { now = Date.now(), bucketMs = DEDUP_BUCKET_MS } = {}) {
    if (!fingerprint) return [];
    return this.entries().filter(
      (e) => e.fingerprint === fingerprint && Number.isFinite(Number(e.ts)) && now - Number(e.ts) <= bucketMs,
    );
  }

  /**
   * Record a fingerprint. `phase` is "proposed" or "executed" — both matter:
   * a proposal that was never confirmed still signals the user's intent.
   * @param {{fingerprint:string, phase:string, proposal_id?:string|null, command_id?:string|null, ts?:number}} entry
   */
  record({ fingerprint, phase, proposal_id = null, command_id = null, ts = Date.now() }) {
    if (!fingerprint) return;
    this._ensure();
    appendFileSync(this.file, `${JSON.stringify({ fingerprint, phase, proposal_id, command_id, ts })}\n`, "utf8");
  }
}

/**
 * Attach the §10.5 warning to a proposal.
 *
 * @param {object} proposal
 * @param {BusinessDedupLedger} ledger
 * @param {{now?:number, policy?:object}} [opts]
 * @returns {object} the proposal with `business_dedup` added (unchanged when no
 *          duplicate is in the window — an absent field means "nothing to ask")
 */
export function annotateBusinessDedup(proposal, ledger, { now = Date.now(), policy = null } = {}) {
  const action = policy?.action ?? "warn_extra_confirm";
  const fingerprint = businessFingerprint(proposal, { now });
  if (!fingerprint) return proposal;
  const prior = ledger?.priorMatches(fingerprint, { now }) ?? [];
  if (prior.length === 0) {
    return { ...proposal, business_dedup: { fingerprint, duplicate_of: [], require_extra_confirm: false } };
  }
  return {
    ...proposal,
    business_dedup: {
      fingerprint,
      duplicate_of: prior.map((p) => p.proposal_id ?? p.command_id ?? null).filter(Boolean),
      require_extra_confirm: action === "warn_extra_confirm",
      message:
        "Bạn vừa có đề xuất tương tự vài phút trước. Ghi thêm hay cùng một giao dịch? " +
        "(Cần xác nhận thêm trước khi ghi.)",
    },
  };
}

/**
 * Does executing this proposal need the extra acknowledgement?
 * @param {object} proposal
 * @returns {boolean}
 */
export function requiresDedupAck(proposal) {
  return proposal?.business_dedup?.require_extra_confirm === true;
}
