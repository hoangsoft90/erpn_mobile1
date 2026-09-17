/**
 * P0 §24.4 — command store persistence + DR.
 *
 * plan2_final forbids a Redis-only store: the ledger of executed commands is
 * financial state and must survive a gateway restart. The MVP store already
 * writes atomically (tmp + fsync + rename) into the repo directory; these tests
 * pin that behaviour so a future "optimisation" cannot quietly move it to an
 * ephemeral location.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { IdempotencyStore } from "../src/idempotency.mjs";

test("the DEFAULT store lives inside the package dir — never in /tmp", () => {
  const store = new IdempotencyStore();
  assert.ok(store.dir.startsWith(process.cwd()), `store dir inside the repo: ${store.dir}`);
  assert.ok(!store.dir.includes("idempotency-store-tmp"), "no temp-dir naming");
  assert.ok(!store.dir.startsWith(tmpdir()), "the command ledger must not live in /tmp (result22 lesson)");
  assert.ok(store.file.endsWith("commands.json"));
});

test("a command written by one process is visible to a NEW instance (restart survival)", () => {
  const dir = mkdtempSync(join(tmpdir(), "cmd-store-"));
  try {
    const cid = randomUUID();
    const first = new IdempotencyStore(dir);
    first.begin(cid, { action: "create_payment_entry", fingerprint: "fp-1", intentKey: "CUST-00001|SINV-0001" });
    first.setReference(cid, "ref-1");

    // Process restart: a brand-new store object with no in-memory cache.
    const second = new IdempotencyStore(dir);
    const rec = second.status(cid);
    assert.ok(rec, "the record survived the restart");
    assert.equal(rec.status, "PENDING");
    assert.equal(rec.reference_no, "ref-1", "the ERPNext reference is durable — reconcile depends on it");
    assert.equal(rec.intent_key, "CUST-00001|SINV-0001");

    // The gate still refuses a second command on the same intent after restart.
    assert.throws(
      () => second.begin(randomUUID(), { action: "create_payment_entry", fingerprint: "fp-2", intentKey: "CUST-00001|SINV-0001" }),
      (err) => err.code === "IDEMPOTENCY_INTENT_IN_FLIGHT",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("persist is atomic: only commands.json remains, and it is valid JSON", () => {
  const dir = mkdtempSync(join(tmpdir(), "cmd-store-"));
  try {
    const store = new IdempotencyStore(dir);
    const cid = randomUUID();
    store.begin(cid, { action: "create_payment_entry", fingerprint: "fp" });
    store.complete(cid, { erpnext_doc: "PE-0001" });

    const files = readdirSync(dir);
    assert.deepEqual(files, ["commands.json"], `no temp/partial files may survive a write: ${files.join(",")}`);
    const parsed = JSON.parse(readFileSync(store.file, "utf8"));
    assert.equal(parsed.commands[cid.toLowerCase()].status, "COMPLETED");
    assert.equal(parsed.commands[cid.toLowerCase()].result.erpnext_doc, "PE-0001");
    assert.ok(existsSync(store.file));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a torn store is moved aside and never silently trusted", () => {
  const dir = mkdtempSync(join(tmpdir(), "cmd-store-"));
  try {
    const store = new IdempotencyStore(dir);
    // Write garbage where the store expects JSON.
    writeFileSync(store.file, "{ this is not json", "utf8");

    const fresh = new IdempotencyStore(dir);
    assert.equal(fresh.status(randomUUID()), null, "a corrupt store must not resurrect records");
    const backups = readdirSync(dir).filter((f) => f.includes(".corrupt-"));
    assert.equal(backups.length, 1, "the corrupt file is kept aside for forensics");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
