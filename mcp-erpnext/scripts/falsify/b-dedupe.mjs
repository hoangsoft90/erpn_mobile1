#!/usr/bin/env node
/**
 * Falsification harness for next3/B (`business_doc_key` — dedupe keyed on the
 * supplier invoice instead of on the command).
 *
 * A new guard on a WRITE path is exactly where "the test passes" is worth the
 * least: every case here deletes ONE piece of it and the NAMED test has to go
 * red. The anchor/restore discipline is `lib/harness.mjs` (baseline control
 * first, moved anchor reported, restore byte-identical, Ctrl-C restores).
 *
 * What is being defended, in the order the record appears:
 *
 *  - the PRE-CHECK (A): without the lookup, the second command sees nothing and
 *    writes the duplicate — the failure this whole phase exists to stop;
 *  - the COLUMN GUARD (B): without it, a site that cannot STORE the key is
 *    written to anyway, which reads as success and guarantees the duplicate on
 *    the next send;
 *  - the PAYLOAD FIELD (C): a key that never reaches the document is not stored,
 *    so the next send cannot find it;
 *  - the READ-BACK (D): a dropped key reported as success is the silent version
 *    of (C);
 *  - the NUMBER NORMALISATION (E): silently stripping separators merges two
 *    different invoice numbers into one identity;
 *  - the /ask BOUNDARY (F): an unvalidated identity would be accepted and then
 *    dropped, and the user would believe the guard was on;
 *  - the APP half (G, H): the identity has to leave the phone, and a half one
 *    must not leave it at all;
 *  - the RE-DERIVATION (I): the key is rebuilt from the document fields at
 *    execute. A key TRUSTED from the proposal is a client-chosen value written
 *    into the one column that blocks the next send of an invoice — verified by
 *    mutation rather than by reading the comment that says so.
 */
import { runCases, PATHS } from "./lib/harness.mjs";

const SKILL = "src/skills/purchase-order-write.mjs";
const KEY = "src/business-doc-key.mjs";
const ASK = "src/http-ask.mjs";
const SUITE = "test/b-dedupe.test.mjs";

// The APP half lives in the Flutter tree — the identity has to reach `/ask`
// from the phone, or the server-side guard never sees a key at all.
const APP_SCREEN = "../apps/mobile/lib/features/chat/presentation/screens/chat_screen.dart";
const APP_MODELS = "../apps/mobile/lib/features/chat/data/ocr_models.dart";
const APP_SUITE = "test/chat_einvoice_xml_test.dart";

const CASES = [
  {
    name: "A. the pre-check is gone — the same invoice through two commands writes TWO drafts",
    file: SKILL,
    old: "    if (keyProbe.found) {",
    new: "    if (false) {",
    only: "B-dedupe: the SAME invoice through two commands ⇒ ONE draft, and the refusal names it",
  },
  {
    name: "B. the missing-column guard is gone — a site that cannot store the key is written to anyway",
    file: SKILL,
    old: "    if (keyProbe.field_unavailable) {",
    new: "    if (false) {",
    only: "B-dedupe: a site WITHOUT the column refuses the keyed write — and still accepts ordinary orders",
  },
  {
    name: "C. the key never reaches the document payload — nothing is stored for the next send to find",
    file: SKILL,
    old: "    ...(businessDocKey && businessDocKeyField ? { [businessDocKeyField]: businessDocKey } : {}),",
    new: "    ...(false ? { [businessDocKeyField]: businessDocKey } : {}),",
    only: "B-dedupe: the SAME invoice through two commands ⇒ ONE draft, and the refusal names it",
  },
  {
    name: "D. the read-back stops checking the key — a dropped key reports success",
    file: SKILL,
    old: "    if (stored !== String(businessDocKey)) {",
    new: "    if (false) {",
    only: "B-dedupe verify: a key that does not read back is NOT a success",
  },
  {
    name: "E. invoice numbers get their separators stripped — two different numbers become one identity",
    file: KEY,
    old: "  return INVOICE_NO_RE.test(s) ? s : null;",
    new: '  return INVOICE_NO_RE.test(s) ? s.replace(/[/._-]/g, "") : null;',
    only: "B-dedupe boundary: a malformed source_document is REFUSED by name, never quietly dropped",
  },
  {
    name: "F. the /ask boundary stops validating the identity — a half-identity is taken and then dropped",
    file: ASK,
    old: "          if (!verdict.ok) {",
    new: "          if (false) {",
    only: "B-dedupe /ask: a malformed source_document is a 400 naming the field — and no pipeline runs",
  },
  {
    // The anchor carries the FILE branch's own indentation on purpose: both
    // input-bar branches send with the identity now, so a bare `.send(sentence,
    // sourceDocument: …)` anchor would mutate the CAMERA one first (String.replace
    // takes the first match) and this case would come back PROBLEM for a reason
    // that has nothing to do with the guard being dead.
    name: "G. the app stops forwarding the file's identity — the server never sees a key",
    file: APP_SCREEN,
    suite: "dart",
    old: "      final sent = await ref\n          .read(chatControllerProvider.notifier)\n          .send(sentence, sourceDocument: slots.sourceDocument?.toAskJson());",
    new: "      final sent = await ref\n          .read(chatControllerProvider.notifier)\n          .send(sentence);",
    only: "a complete file identity travels BESIDE the sentence, not inside it",
  },
  {
    name: "H. the app accepts a HALF identity — a 400 for the shop's own purchase question",
    file: APP_MODELS,
    suite: "dart",
    old: "        sellerTaxId == null) {",
    new: "        false) {",
    only: "OcrSourceDocument anything less than number + date + MST is null, never a partial map",
  },
  {
    // The anchor is the comparison itself, not the refusal body: a planted key is
    // not "a wrong key", it is "a key nobody derived" — and with the check gone
    // the tampered proposal is either written (planting that key into the column)
    // or refused as a duplicate of whatever invoice it claimed, and the test
    // catches both.
    name: "I. the key is TRUSTED from the proposal — a client-chosen value lands in the dedupe column",
    file: SKILL,
    old: "    if (!rebuiltDocKey || rebuiltDocKey !== wantDocKey) {",
    new: "    if (false) {",
    only: "B-dedupe: the key is RE-DERIVED at execute, never trusted from the proposal",
  },
];

process.exit(
  runCases(CASES, {
    title: "next3/B business_doc_key",
    nodeFiles: { default: SUITE },
    dartSuites: { default: APP_SUITE },
    root: PATHS.ROOT,
  }) === 0
    ? 0
    : 1,
);
