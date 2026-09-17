/**
 * Session context (plan2_final §14) — what the user was JUST talking about,
 * stored server-side with provenance and a TTL, so a follow-up sentence like
 * "còn hóa đơn thì sao" can mean the same customer without the user repeating
 * themselves — and so a STALE context can never silently drive a WRITE.
 *
 * Safety contract (P2 deliverables 2–3):
 *  - every entry carries provenance: USER_SELECTED (the candidate picker or an
 *    exact name match) vs DERIVED (a fuzzy read match). Only USER_SELECTED /
 *    exact context is ever eligible to seed a WRITE, and even then only within
 *    its TTL.
 *  - expired context is DELETED, not returned: the pipeline then behaves
 *    exactly like a first mention — including asking the user again. A write
 *    proposal may therefore never silently attach to a customer/invoice the
 *    user named minutes ago.
 */

export const CONTEXT_PROVENANCE = Object.freeze({
  USER_SELECTED: "user_selected",
  DERIVED: "derived",
});

/** TTLs (plan2_final §14): the invoice changes faster than the customer. */
export const CONTEXT_TTL_MS = Object.freeze({
  customer: 30 * 60 * 1000, // 30m
  invoice: 10 * 60 * 1000, // 10m
});

/** Who may seed a WRITE from context. Only these, only inside TTL. */
export const WRITE_ELIGIBLE_PROVENANCE = Object.freeze([CONTEXT_PROVENANCE.USER_SELECTED, "exact"]);

/**
 * In-memory session store. One instance per gateway process is correct here:
 * the idempotency ledger is the durable state; context only needs to survive
 * the length of a conversation turn gap.
 */
export class SessionContext {
  constructor({ now = Date.now } = {}) {
    /** @type {Map<string, {value:string, name:string|null, provenance:string, ts:number}>} */
    this.entries = new Map();
    this.now = now;
  }

  /**
   * Record a context entity. Overwrites any previous value for the kind — the
   * most recent mention wins (that is what "context" means).
   *
   * @param {string} kind "customer" | "invoice"
   * @param {{id:string, name?:string|null, provenance:string}} entity
   * @param {{ts?:number}} [opts]
   */
  set(kind, entity, opts = {}) {
    const ttl = CONTEXT_TTL_MS[kind];
    if (!ttl || typeof entity?.id !== "string" || entity.id.trim() === "") {
      return { ok: false, code: "CONTEXT_KIND_UNKNOWN" };
    }
    const provenance = String(entity.provenance ?? "");
    if (!Object.values(CONTEXT_PROVENANCE).includes(provenance)) {
      return { ok: false, code: "CONTEXT_PROVENANCE_INVALID" };
    }
    this.entries.set(kind, {
      value: entity.id.trim(),
      name: entity.name ?? null,
      provenance,
      ts: opts.ts ?? this.now(),
    });
    return { ok: true };
  }

  /**
   * Get a LIVE context value. Expired entries are dropped on read (and the
   * read returns null) — a stale customer must be re-named by the user, never
   * silently reused.
   *
   * @param {string} kind
   * @param {{now?:number}} [opts]
   * @returns {{id:string, name:string|null, provenance:string, ageMs:number}|null}
   */
  get(kind, opts = {}) {
    const entry = this.entries.get(kind);
    if (!entry) return null;
    const now = opts.now ?? this.now();
    const ageMs = now - entry.ts;
    if (ageMs > CONTEXT_TTL_MS[kind]) {
      this.entries.delete(kind); // expired ⇒ gone, not "stale but usable"
      return null;
    }
    return { ...entry, ageMs };
  }

  /**
   * Can a WRITE consume this context? Exactly when it is alive AND its
   * provenance is user-selected/exact. DERIVED context (a fuzzy read match)
   * may drive a follow-up READ but never a payment proposal.
   *
   * @param {string} kind
   * @param {{now?:number}} [opts]
   * @returns {{eligible:boolean, context:object|null, code:string|null}}
   */
  writeEligible(kind, opts = {}) {
    const ctx = this.get(kind, opts);
    if (!ctx) return { eligible: false, context: null, code: "CONTEXT_EXPIRED_OR_ABSENT" };
    if (!WRITE_ELIGIBLE_PROVENANCE.includes(ctx.provenance)) {
      return { eligible: false, context: ctx, code: "CONTEXT_NOT_USER_SELECTED" };
    }
    return { eligible: true, context: ctx, code: null };
  }

  /** Test/admin seam — drop everything. */
  clear() {
    this.entries.clear();
  }
}
