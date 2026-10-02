# next7 / B1 — tasks

## 1. State machine (no magic delay)

- [x] `_InputBarState` gains `_finalHeard` (a genuine FINAL result arrived this session).
- [x] Session OPEN (`_toggleMic` start path) resets it — a new dictation starts fresh.
- [x] `_maybeAutoSend()` becomes the ONE decision point, shared by both triggers:
      `voiceAutoSend && text.trim() non-empty && !(write-shaped && !_finalHeard)` → `onSend()`.
- [x] Trigger A (final): `_onSpeechResult(isFinal: true)` sets `_finalHeard` then calls it.
- [x] Trigger B (stop): `_stopDictation(userInitiated: true)` → `_speech.stop()` → `setState` → calls
      it. `await`ed before the branch returns, `mounted` checked after every await.
- [x] Trigger B′ (the 25s cap): `_stopDictation(userInitiated: false)` — same stop, keeps the words,
      never auto-sends.
- [x] `_cancelDictation` needs no flag: `cancel()` drops the result listener and the widget is no
      longer `_listening`, so Huỷ sends zero times.
- [x] `_autoSendDone` REMOVED after measurement: a purpose-built exactly-once flag turned no test red
      (three pre-existing layers already close every path). Keeping it would be the unreachable-guard
      smell this repo removed once already. "At most once" is now documented where it lives
      (`_maybeAutoSend`) and pinned by tests (B4a–B4d).

## 2. Write-shaped partial guard

- [x] `data/voice_write_guard.dart` (new, pure, no I/O): `looksLikeWriteOrder(text)` — Vietnamese
      WRITE keywords + unaccented forms, word-boundary safe around diacritics (the C3 lesson: `\b` is
      unusable next to Vietnamese letters — use `\p{L}\p{M}` lookarounds + `u`).
- [x] Applied ONLY when `!_finalHeard`: a write-shaped partial is left in the field, never sent.
      A final-result utterance is unaffected (the existing suite pins that it still sends).
- [x] Failure direction stated in code: a false POSITIVE only costs a manual Gửi (the text stays in
      the field).
- [x] Vocabulary is CHECKABLE, not reinvented: a test asserts every `type: WRITE` trigger in
      `mcp-erpnext/capabilities.json` is matched by the guard, so a new WRITE capability cannot slip
      past it silently.

## 3. Do NOT touch

- [x] `SpeechService.stop()` / `cancel()` semantics stay as pinned by `speech_service_test.dart`.
- [x] No timer-based fallback, no "send every partial after 1s", no TTS.

## 4. Tests (acceptance plan §4)

- [x] B1 OFF + tap-stop ⇒ 0 requests.
- [x] B2 ON + final ⇒ exactly 1 `/ask`.
- [x] B3 ON + Huỷ ⇒ 0 requests, field restored to the pre-dictation text.
- [x] B4 duplicate final; final-then-stop; stop-then-teardown-final ⇒ exactly 1 `/ask` each.
- [x] B5 ON + WRITE-shaped partial with the final swallowed ⇒ 0 auto-send, text kept.
- [x] B5b ON + READ-shaped partial with the final swallowed ⇒ sends once (the fix's point).
- [x] B6 setting persists across a restart (already covered in `settings_test.dart`; asserted here as
      the client-side contract).
- [x] Cap carve-out pinned: the 25s cap keeps the words and sends nothing even with `voiceAutoSend`
      ON.
- [x] `looksLikeWriteOrder` unit tests: accented + unaccented phrases, token-vs-substring
      (`huyện` must not match `huy`), punctuation.
- [x] Guard vocabulary vs contract: every WRITE trigger in `capabilities.json` is matched (with
      canaries so the check cannot pass vacuously).
- [x] `_heardAnything`: a dictation that contributed no word sends nothing, even when the field holds
      text the user typed earlier — found by the B1 review's probe, fixed, and falsified (removing the
      guard turns `R1` red).
- [x] `R2`: a CANCELLED dictation must not mute the NEXT one (the removed flag's reset logic is now
      pinned as an outcome instead).
- [x] `R3`/`R4`: pre-typed WRITE text is blocked, and a pre-typed prefix rides along with the dictated
      partial (what actually goes out is the FIELD, not just the transcript).
- [x] B0 probe cases absorbed: the probe file is deleted, its 3 cases live here as real tests.
- [x] Unit tests for `looksLikeWriteOrder` (keywords, unaccented, diacritics, non-write sentences).

## 5. Out of scope (named, not silently dropped)

- [ ] B7 partial READ fallback when the engine never finalizes AND the user never stops — optional,
      not in the DoD.
- [ ] TTS read-back confirmation of an auto-sent question — explicitly out of next7.
- [ ] Any server-side change: the write path stays `/ask` → proposal → [Xác nhận] → `/execute`.
