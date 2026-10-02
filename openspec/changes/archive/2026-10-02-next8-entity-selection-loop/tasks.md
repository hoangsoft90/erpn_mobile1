# next8 / entity-selection-loop — tasks

## 1. Backend — supplier branch consumes the picked id (H2, core)

- [x] DONE 2026-09-28 (D1): supplier branch consumes `opts.pickedEntityId` via the new generic
      `pickRowFromCandidates` (entity-resolution.mjs +27); invalid id ⇒ refusal preserved +
      `[copilot] entity pick refused:` stderr. Evidence: test/next8-entity-pick.test.mjs 4/4
      (loop test RED before the fix, GREEN after; falsify A RED).
- [x] `copilot-server.mjs` supplier route group (~L1104): when `opts.pickedEntityId` is set, validate
      it against the SAME list this branch just read via `pickRowFromCandidates(list, id, {
      idOf: ENTITY_ACCESSORS.supplier.idOf })` (new generic helper in entity-resolution.mjs — the
      proposal's earlier name `pickFromCandidatesByText` does not exist; corrected 2026-09-28 in D1).
      Valid ⇒ resolve that one row, return the ordinary detail answer + `read_supplier` proposal.
      Invalid ⇒ keep the current refusal and write
      `[copilot] entity pick refused: …` to stderr (same convention as the customer path L1274).
- [x] DONE 2026-09-28 (D1): the consumed-id response carries NO candidates — pinned by the loop test's
      `candidates ?? []` deepEqual (next8-entity-pick.test.mjs (b)) and the resolved answer's detail shape.
- [x] DONE 2026-09-28 (D1): resolver matching untouched — `pickRowFromCandidates` validates the id
      against the SAME list the branch just read; customer path untouched (its 4/4 stays green).
- [x] DONE 2026-09-28 (D2): an id NOT in the fresh list answers ENTITY_PICK_STALE (its own code +
      copy) with the FRESH picker standing — the D1 refusal contract "same error_code" was refined
      per D2 (spec delta note); test (c) updated accordingly. Falsify F4 RED.

## 2. Session context — kinds + checked .ok (H6 gap)

- [x] DONE 2026-09-28 (D1): `supplier` 30m + `item` 10m added to `CONTEXT_TTL_MS` (session-context.mjs
      +9); customer call site checks `.ok` + stderr warning; supplier branch records the choice with
      USER_SELECTED/DERIVED provenance + checked `.ok`. Evidence: p2 test 6/6 incl. the new H6 test
      (falsify B RED); next6 test pinning `warehouse` refusal stays green.
- [x]

## 3. AI mode — pass the pick id, nothing else (F1)

- [x] DONE 2026-09-28 (D1): `dshAsk(message, {conversationId, entityId})` — `entity_id` sent only
      when non-empty; `send()` forwards it through `_sendDsh` in DSH mode; `/dsh/ask` parses the
      bounded field and passes `pickedEntityId` to the handoff (hoisted `let` per the A2 scope law —
      the first attempt's try-scoped const 500'd the exact request it had to serve). `submit_now`
      stays unread; no dsh spawn. Evidence: test/next8-entity-pick.test.mjs AI test GREEN
      (RED before), falsify C RED; Flutter next8_ai_pick_test.dart 3/3 (falsify D RED);
      dsh_mode_test.dart 16/16 (typed AI question still sends NO entity_id).
- [x]

## 4. Tests — evidence per user rule (line-level + suite results)

- [x] DONE 2026-09-28 (D1): `test/next8-entity-pick.test.mjs` 4/4 — (a) picker; (b) THE LOOP
      REGRESSION (RED before fix, GREEN after); (c) invalid id refusal preserved; (d) AI handoff id.
- [x] Flutter `test/next8_ai_pick_test.dart` 3/3 (AI-mode pick carries entity_id; typed AI question
      sends none; /ask contract unchanged).
- [x] Falsify A/B/C/D: each mutation turned EXACTLY its test RED; restore verified — one incident:
      the falsify script's `git checkout` wiped the UNCOMMITTED fix (restore-check said NO), the fix
      was re-applied by str_replace and re-verified (10/10 + diff-stat identical); grep FALSIFY = 0.
- [x] Full gates: Node FULL **896 tests — 894 pass / 2 fail** (baseline dsh-env pair only) ·
      targeted (p2/b1/p8/A0/copilot) 65/65 → 71/71 with the new files · flutter analyze **1 issue**
      (probe file untracked) · flutter test **381 pass / 3 fail** (`_probe_review_test.dart`
      untracked probe only).
- [x] DONE 2026-09-28 (D2): `test/next8-picker-safety.test.mjs` 5/5 — T11 bailout (bare
      hủy/thoát/bỏ qua = PICKER_BAILOUT, never FORBIDDEN/UNKNOWN + T10 new-intent reading); T12
      overflow (12 matches ⇒ 10 chips, picker_total 12, picker_more 2, hint "Còn 2 kết quả"); T14
      stale (ENTITY_PICK_STALE + fresh picker stands); enrichment ×2 (chip null-honest + MST answer).
      Falsify F1–F6 each RED exactly its test; restore from /tmp backup (grep FALSIFY = 0).
- [x] DONE 2026-09-28 (D2): Flutter `test/next8_picker_safety_test.dart` 5/5 — T15 double-tap ×2
      (controller-level + widget-level `_pickingId` guard), T16 TTL ×3 (awaitingEntityPick expiry;
      expired tap sends NOTHING + SnackBar; fresh picker never blocked).
- [x] DONE 2026-09-28 (D2) full gates: Node FULL **898 tests — 896 pass / 2 fail** (baseline
      dsh-env pair only) · related suites 22/22 · flutter analyze **1 issue** (untracked probe) ·
      flutter test **386 pass / 3 fail** (untracked `_probe_review_test.dart` only).
- [ ] REAL-server probe (T1/T2) — PENDING deploy; D1/D2 must NOT be called closed-loop on real data yet.

## 5. Docs + result

- [x] DONE 2026-09-28 (D1): `.plan/next8/D1-result.md` (diff + T-tables + verdict).
- [x] DONE 2026-09-28 (D2): `.plan/next8/D2-result.md` (6-mục table + falsify table + gates).
- [ ] `faq.md` §6.13 or a new Q: "tap card trong AI mode giờ hoạt động — id đi kèm, vẫn cần Xác nhận
      cho WRITE" + a D2 Q ("hủy/thoát/bỏ qua thoát picker; picker hết hạn sau ~5 phút") — PENDING
      (docs-sync commit; working.md entries done).
