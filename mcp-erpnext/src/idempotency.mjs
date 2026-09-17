/**
 * Idempotency store — the Phase 7 GATE for the one allowed write
 * (create_payment_entry). Spec: "Gateway đảm bảo command_id chỉ execute một
 * lần — chống mất mạng → user bấm Confirm lại → ghi nhận 2 lần".
 *
 * Three-phase records (the anti-"lửng lơ" design):
 *   PENDING    → command accepted, write NOT yet verified complete.
 *   COMPLETED  → ERPNext document name recorded; replays return this result.
 *   FAILED     → terminal failure; a retry with the SAME command_id is refused
 *                (client must issue a NEW command_id — it means a new intent).
 *
 * Crash recovery (no half-state): a PENDING record is never trusted by
 * itself. reconcile() asks ERPNext whether a Payment Entry carrying this
 * command_id as reference_no exists — ERPNext's own uniqueness on reference
 * is the second half of the protection. If it exists → completed; if not →
 * the write may be safely replayed.
 *
 * Persistence: atomic tmp-file + fsync + rename (no torn store on crash).
 * Default location is `mcp-erpnext/idempotency-store/` — INSIDE the repo dir
 * (survives Cloud Shell restarts, unlike /tmp — result22 lesson) and
 * gitignored (same policy as llm-router-audit/).
 */

import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync, openSync, fsyncSync, closeSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";

const DEFAULT_DIR = process.env.ERPN_IDEM_DIR ?? join(path2RepoRoot(), "idempotency-store");
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function path2RepoRoot() {
  // src/ → repo root is one level up from this file's directory's parent
  // (mcp-erpnext/src → mcp-erpnext). Keep the store inside the package dir so
  // it survives Cloud Shell restarts like any repo file (NOT /tmp — result22).
  return join(dirname(fileURLToPath(import.meta.url)), "..");
}

export function isValidCommandId(id) {
  return typeof id === "string" && UUID_RE.test(id);
}

// NOTE (P0): there used to be an `EXECUTABLE_ACTIONS` constant here. It was a
// SECOND copy of a policy that now lives in `capabilities.json`
// (`executableWriteActions()`), which plan2_final §2 D5 forbids. The contract
// is the only source: the Safety Gateway asks it, this store never decides what
// may be executed.

export class IdempotencyStore {
  /**
   * @param {string} [dir] directory holding the JSON store (default repo/idempotency-store)
   */
  constructor(dir = DEFAULT_DIR) {
    this.dir = dir;
    this.file = join(dir, "commands.json");
    this._cache = null;
  }

  _load() {
    if (this._cache) return this._cache;
    if (!existsSync(this.file)) {
      this._cache = { version: 1, commands: {} };
      return this._cache;
    }
    try {
      const parsed = JSON.parse(readFileSync(this.file, "utf8"));
      if (parsed && typeof parsed === "object" && parsed.commands && typeof parsed.commands === "object") {
        this._cache = parsed;
      } else {
        this._cache = { version: 1, commands: {} };
      }
    } catch {
      // A torn file (should be impossible with atomic rename) must not crash
      // the write path — but it MUST NOT silently resume either: move it aside
      // and start empty, the reconcile step re-checks ERPNext by reference.
      const backup = `${this.file}.corrupt-${Date.now()}`;
      try { renameSync(this.file, backup); } catch { /* best effort */ }
      this._cache = { version: 1, commands: {} };
    }
    return this._cache;
  }

  /** Atomic persist: tmp file + fsync + rename (no torn store on crash). */
  _persist() {
    mkdirSync(this.dir, { recursive: true });
    const tmp = join(this.dir, `.commands-${process.pid}-${randomUUID()}.tmp`);
    const data = JSON.stringify(this._cache, null, 2);
    const fd = openSync(tmp, "w");
    try {
      writeFileSync(fd, data, "utf8");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, this.file);
  }

  /**
   * Status of a command. Returns null when unknown (never executed).
   * @param {string} commandId
   * @returns {{status:"PENDING"|"COMPLETED"|"FAILED", result?:object, error?:string, ts:string}|null}
   */
  status(commandId) {
    if (!isValidCommandId(commandId)) return null;
    return this._load().commands[commandId.toLowerCase()] ?? null;
  }

  /**
   * Mark a command PENDING before any ERPNext call.
   *  - COMPLETED command → {replay:true, result} (the once-only guarantee).
   *  - FAILED command → throws: FAILED is terminal, a corrected attempt must
   *    use a NEW command_id (it represents a NEW intent). Silently resetting
   *    to PENDING would erase the failure history (review 2026-09-16).
   *  - PENDING command with the same fingerprint → not replay, not error:
   *    it stays PENDING and the caller proceeds to reconcile before writing.
   * Phase 9: `meta.intentKey` (customer|invoice) makes the gate refuse a
   * SECOND command while an earlier one with the same target is still PENDING.
   * Two command_ids for the same debt are legitimate intents at the proposal
   * level, but executing both would allocate the same money twice.
   * @param {string} commandId
   * @param {{action:string, fingerprint:string, intentKey?:string|null}} meta
   */
  begin(commandId, meta) {
    if (!isValidCommandId(commandId)) throw new Error("IDEMPOTENCY_INVALID_COMMAND_ID: command_id must be a UUID");
    const db = this._load();
    const key = commandId.toLowerCase();
    const existing = db.commands[key];
    if (existing && existing.status === "COMPLETED") {
      return { replay: true, result: existing.result };
    }
    if (existing && existing.status === "FAILED") {
      throw new Error(
        `IDEMPOTENCY_FAILED_TERMINAL: command ${commandId} already FAILED (${existing.error ?? "unknown"}) — issue a NEW command_id for the corrected attempt`,
      );
    }
    if (existing && existing.status === "PENDING" && existing.fingerprint !== meta.fingerprint) {
      throw new Error(
        "IDEMPOTENCY_FINGERPRINT_MISMATCH: this command_id is pending for DIFFERENT work — do not reuse it",
      );
    }
    const intentKey = typeof meta?.intentKey === "string" && meta.intentKey ? meta.intentKey : null;
    if (intentKey) {
      const clash = Object.entries(db.commands).find(
        ([id, rec]) => id !== key && rec.status === "PENDING" && rec.intent_key === intentKey,
      );
      if (clash) {
        // Review 2026-09-16: the message alone is not actionable — the client
        // needs to know WHICH command to resume (the app pins command_id on the
        // card, so it CAN retry the blocking one). Structured field, additive.
        throw Object.assign(
          new Error(
            `IDEMPOTENCY_INTENT_IN_FLIGHT: lệnh ${clash[0]} đang xử lý cùng ý định (${intentKey}) — đợi lệnh đó xong hoặc huỷ, KHÔNG ghi thêm`,
          ),
          { code: "IDEMPOTENCY_INTENT_IN_FLIGHT", clashCommandId: clash[0] },
        );
      }
    }
    // CRITICAL (real double-write, 2026-09-16): a resumed command must KEEP the
    // facts the earlier attempt recorded — above all `reference_no`, which is
    // what reconcile() searches ERPNext with. Overwriting the record wiped it,
    // the /execute reconcile branch then had nothing to look up, and a SECOND
    // Payment Entry was written for the same money. ERPNext does not enforce
    // uniqueness on reference_no, so this store is the only protection: never
    // drop fields it holds.
    db.commands[key] = {
      ...existing,
      status: "PENDING",
      action: meta.action,
      fingerprint: meta.fingerprint,
      intent_key: intentKey ?? existing?.intent_key ?? null,
      ts: existing?.ts ?? new Date().toISOString(),
    };
    delete db.commands[key].error;
    delete db.commands[key].failed_ts;
    this._persist();
    // `resumed` tells the caller this id was ALREADY in flight, so the caller
    // must reconcile against ERPNext before writing anything new.
    return { replay: false, resumed: Boolean(existing) };
  }

  /**
   * Record the successful ERPNext result (document name etc).
   * @param {string} commandId
   * @param {object} result
   */
  complete(commandId, result) {
    const db = this._load();
    const key = commandId.toLowerCase();
    const rec = db.commands[key];
    if (!rec) throw new Error("IDEMPOTENCY_NO_PENDING: complete() without begin()");
    rec.status = "COMPLETED";
    rec.result = result;
    rec.completed_ts = new Date().toISOString();
    this._persist();
  }

  /**
   * Record a terminal failure (bad params, customer vanished...). The same
   * command_id will NOT be retried — a corrected attempt needs a new id.
   * @param {string} commandId
   * @param {string} error
   */
  fail(commandId, error) {
    const db = this._load();
    const key = commandId.toLowerCase();
    const rec = db.commands[key];
    if (!rec) throw new Error("IDEMPOTENCY_NO_PENDING: fail() without begin()");
    rec.status = "FAILED";
    rec.error = String(error).slice(0, 500);
    rec.failed_ts = new Date().toISOString();
    this._persist();
  }

  /**
   * Record the ERPNext-side identity of a PENDING write BEFORE attempting it,
   * so reconcile() knows exactly what to look for even after a crash.
   * @param {string} commandId
   * @param {string} referenceNo the value written to Payment Entry.reference_no
   */
  setReference(commandId, referenceNo) {
    const db = this._load();
    const rec = db.commands[commandId.toLowerCase()];
    if (!rec) throw new Error("IDEMPOTENCY_NO_PENDING: setReference() without begin()");
    rec.reference_no = String(referenceNo).slice(0, 140);
    this._persist();
  }

  /**
   * Phase 9 — mark a PENDING command CANCELLED, releasing its intent lock.
   * The HTTP layer only calls this AFTER ERPNext reconciles to ZERO documents
   * with this reference_no (a write that DID land must never be cancelled —
   * it must be completed/reconciled instead). COMPLETED/FAILED are refused
   * here too: cancelling a completed write would hide money that exists.
   * @param {string} commandId
   */
  cancel(commandId) {
    const db = this._load();
    const key = commandId.toLowerCase();
    const rec = db.commands[key];
    if (!rec) throw new Error("IDEMPOTENCY_NO_PENDING: cancel() without begin()");
    if (rec.status !== "PENDING") {
      throw new Error(`IDEMPOTENCY_CANCEL_REFUSED: cannot cancel a ${rec.status} command`);
    }
    rec.status = "CANCELLED";
    rec.cancelled_ts = new Date().toISOString();
    this._persist();
  }
}

/**
 * Deterministic fingerprint of the semantic payload (action + entity + amount).
 * A client retry MUST produce the same fingerprint for the same command_id;
 * a mismatch means the stored command is for different work → refuse.
 * @param {{action:string, entity:{id?:string}, params:{amount_vnd?:number, invoice?:string}}} proposal
 */
export function fingerprintProposal(proposal) {
  const h = createHash("sha256");
  h.update(proposal?.action ?? "");
  h.update("|");
  h.update(proposal?.entity?.id ?? "");
  h.update("|");
  h.update(String(proposal?.params?.amount_vnd ?? ""));
  h.update("|");
  h.update(proposal?.params?.invoice ?? "");
  return h.digest("hex").slice(0, 32);
}

/** Fresh command id for clients that do not supply one (mock/tests). */
export function newCommandId() {
  return randomUUID();
}
