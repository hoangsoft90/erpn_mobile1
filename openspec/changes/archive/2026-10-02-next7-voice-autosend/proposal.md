## Why

`voiceAutoSend` is documented as *"Tự gửi sau khi nói xong"* and `plan_final.md` §4 fixes its DoD:

```text
voiceAutoSend && stopped && final received && text non-empty && !autoSendDone
→ exactly one onSend()
```

B0 (`.plan/next7/B0-result.md`) reproduced the user report and proved the code does NOT meet it. The
auto-send trigger was wired to ONE event only — the recognizer's own FINAL result — while the
interaction the user actually performs is **speak, then tap the mic to stop** ("Dừng nhập giọng nói").
That path is dead twice over:

1. `_toggleMic`'s stop branch never calls `_maybeAutoSend` (`chat_screen.dart:517-528`);
2. `SystemSpeechService.stop()` bumps its session token (`speech_service.dart:228-231`), so the final
   result the plugin guarantees on stop is dropped before the UI sees it — and
   `_onSpeechResult`'s own `if (!_listening) return;` (`:985`) would drop it anyway.

The transcript is NOT lost (partials stream into the field), so the user is left holding a filled
input box that silently refused to send. Two probe cases stay red today: `B0#2` (tap-stop) and `B0#3`
(teardown final after stop), while `B0#1` (engine self-final) is green — the bug is the missing
trigger, not the setting (H1 and H4 were both falsified in B0).

## What Changes

- **"Stopped" now means what the user means by it.** Tapping the mic to stop the dictation is a
  completion event: after `stop()` the widget runs the same ONE auto-send decision the final-result
  path runs. No timers, no magic delay — a state machine, not a heuristic.
- **Exactly one send per dictation session.** Both triggers funnel into ONE decision point, and
  "at most once" holds for any order of `final`/`stop` and any duplicate final. It is NOT carried by
  a dedicated flag: B1's falsification run measured a purpose-built flag as redundant (removing it
  turned no test red) because pre-existing layers already close every path — the `!_listening`
  return after the first final, the empty-field drop after the first send, and
  `ChatController.send`'s `isLoading` refusal. Adding a fourth copy would have been the exact
  unreachable-guard smell this repo already removed once (review 2026-09-18), so the guarantee is
  documented where it lives and pinned by tests instead.
- **A write-shaped partial is never auto-sent without a final.** When a dictation ends WITHOUT a
  final result (the engine swallowed it — the stop path), the field may hold only partial text. If
  that text matches the WRITE trigger vocabulary of the server contract (thu tiền / thanh toán /
  lập đơn / đặt hàng …), auto-send is SKIPPED and the text is left in the field for the user to
  review and press Gửi. A final-result utterance keeps sending as before (the server's confirm card
  is still the only way to write).
- **Nothing said ⇒ nothing sent.** A dictation that contributed no word at all (mic opened and
  closed, recognizer silent) must not send the text the user had typed earlier. "Nói xong" requires
  having said something; the field's contents are evidence of typing, not of speech. (Found by the B1
  review: before this rule, mic-on-then-mic-off posted a pre-typed question with no speech at all.)
- **The 25s safety cap is NOT "nói xong".** The cap ends the session and keeps the words, but it
  never auto-sends: a timer expiring is not the shopkeeper saying they finished. That preserves the
  pre-B1 behaviour the suite already pinned.
- **Huỷ stays absolute**: it cancels the session — zero sends, and nothing that was heard reaches
  the field.
- **`SpeechService.stop()` is NOT touched.** Its contract ("results after stop are dropped") is
  pinned by `speech_service_test.dart`; patching the widget is sufficient and lower-risk.

## Capabilities

### New Capabilities

- `voice-dictation` — dictation is an input modality, and the opt-in auto-send must be exactly-once
  and fail-closed on un-reviewed write-shaped text.

### Modified Capabilities

(none — no backend contract, no capability JSON, no API shape changes)

## Impact

- **Files:** `apps/mobile/lib/features/chat/presentation/screens/chat_screen.dart` (new
  `_stopDictation({required bool userInitiated})` shared by the tap and the cap, `_finalHeard`
  state, `_maybeAutoSend` guard) ·
  `apps/mobile/lib/features/chat/data/voice_write_guard.dart` (new, pure predicate) ·
  `apps/mobile/test/voice_autosend_test.dart` (new; absorbs the B0 probe) ·
  probe `test/_probe_b0_voice_autosend.dart` removed (its cases become real tests).
- **Client-only.** No `/ask`, `/execute`, DSH, sales, ERPNext or `capabilities.json` change; no TTS.
- **Safety:** the only reachable request remains `POST /ask`; auto-send can never confirm a proposal
  and never reaches `/execute`. The write-shaped rule makes the *un-reviewed* case stricter than
  before (it used to auto-send partials only via a path that never fired — now the firing path
  refuses write-shaped ones).
- **Not in scope:** partial READ fallback (B7, optional), a second after the last partial, TTS
  confirmation.
