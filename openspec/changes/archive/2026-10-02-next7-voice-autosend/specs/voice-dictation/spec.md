## Purpose

Write down what the opt-in "Tự gửi sau khi nói xong" (`voiceAutoSend`) may do, now that B0 proved the
shipped code only fired on one of the two ways a dictation ends. Dictation is an input modality: it
may fill the editable field and, when the user opted in, send that text ONCE through the ordinary
Send path. It may never authorise a write, never reach `/execute`, and never post text the user has
not had a chance to see.

There is no `voice-dictation` spec under `openspec/specs/` yet (no change has been archived), so the
requirements below are ADDED here.

## ADDED Requirements

### Requirement: "Finished speaking" includes the user's own stop

`voiceAutoSend` MUST trigger the auto-send when EITHER end-of-dictation event occurs: the recognizer
emitting a FINAL result, OR the user stopping the microphone (the same tap-to-stop control whose
tooltip is "Dừng nhập giọng nói"). The trigger MUST NOT depend on a timer or on a delay introduced to
approximate "the user has stopped talking".

The 25-second safety cap is explicitly NOT one of those events: it ends the session and keeps
whatever was heard, but it MUST NOT auto-send.

#### Scenario: speak then tap the mic to stop

- **WHEN** `voiceAutoSend` is ON, the user dictates, and then taps the microphone to stop it
- **THEN** the TEXT IN THE FIELD — what the user had typed, plus what was dictated (dictation runs
  mid-edit) — is sent exactly once through the ordinary Send path

#### Scenario: the recognizer finalizes on its own

- **WHEN** `voiceAutoSend` is ON and the recognizer emits a FINAL result without the user tapping
  anything
- **THEN** the text in the field is sent exactly once, as before this change

#### Scenario: the mic is tapped but nothing is said

- **WHEN** `voiceAutoSend` is ON, the user taps the microphone, says nothing (so no result ever
  arrives), and taps the microphone again to stop
- **THEN** no request is made — even when the field already holds text the user typed earlier.
  Opening and closing the mic is not "nói xong": the field's contents are evidence of TYPING, not of
  speech, so they must not be sent as if the user had just spoken them

#### Scenario: opting out sends nothing

- **WHEN** `voiceAutoSend` is OFF and the user dictates and stops the microphone
- **THEN** no request is made and the text stays in the field for a manual Gửi

#### Scenario: the safety cap expires

- **WHEN** `voiceAutoSend` is ON and a dictation runs past the 25-second cap without the user
  stopping it and without a final result
- **THEN** the session ends, the words stay in the field, and NO request is made

### Requirement: One dictation session sends at most once

For one dictation session, auto-send MUST call the Send path AT MOST ONCE, whatever order the two
end events arrive in and however many FINAL results the recognizer flushes. A dictation that the
user CANCELLED MUST send zero times. A later dictation session MUST be able to send again — the
"at most once" scope is one dictation, never the screen's lifetime.

This is an OUTCOME requirement, not a demand for a dedicated flag. It is satisfied by layers that
already exist for their own reasons (the session-open return after a final result, the empty-field
drop after a successful send, the controller's refusal to send while a request is in flight), and a
purpose-built flag was measured as redundant and removed — see `proposal.md` and
`.plan/next7/B1-result.md` §6.

#### Scenario: duplicate final results

- **WHEN** `voiceAutoSend` is ON and the recognizer emits two FINAL results for one utterance
- **THEN** exactly one request is made

#### Scenario: stop then the teardown final

- **WHEN** `voiceAutoSend` is ON, the user taps the mic to stop, and the recognizer then flushes one
  final result during teardown
- **THEN** exactly one request is made in total

#### Scenario: cancelled dictation

- **WHEN** the user presses Huỷ while listening
- **THEN** no request is made, the field is restored to the text it held before dictation, and a
  later teardown result cannot cause a send

### Requirement: A write-shaped partial is never auto-sent unreviewed

When a dictation ends WITHOUT a FINAL result (the recognizer swallowed it — the case the stop trigger
covers), the field may hold only PARTIAL text. If that text contains a WRITE trigger phrase of the
server contract (`capabilities.json`, capability `type: WRITE` — e.g. *thu tiền*, *thanh toán*,
*đặt hàng*, *tạo đơn*, *lập hóa đơn*), auto-send MUST NOT fire: the text MUST be left in the field so
the user reviews it and presses Gửi.

The rule is a POSITIVE match against that vocabulary: a text matching no WRITE phrase is sent,
because the only request auto-send can make is the ordinary question request and any proposal it
returns still needs its own Xác nhận (see the last requirement). A false detection therefore only
costs the shopkeeper one manual Gửi — which is why the matching is deliberately coarse. A bare *bán*
is NOT a WRITE phrase (the contract does not list it, and "doanh thu bán được" is a READ question).
The rule MUST NOT apply to an utterance that HAS a final result.

The vocabulary MUST be checkable against the contract, not reinvented: `test/voice_autosend_test.dart`
asserts that every `type: WRITE` trigger in `mcp-erpnext/capabilities.json` is matched by the guard, so
adding a WRITE capability without teaching the guard fails the suite.

#### Scenario: a payment sentence only heard partially

- **WHEN** `voiceAutoSend` is ON, the user says "thu tiền chị Lan 2 triệu", the recognizer emits
  partials but no final, and the user taps the mic to stop
- **THEN** nothing is sent, and "thu tiền chị Lan 2 triệu" (or the partial that was heard) stays in
  the input field for the user to check and send by hand

#### Scenario: a read-only question heard partially still sends

- **WHEN** `voiceAutoSend` is ON, the user says "chị Lan còn nợ bao nhiêu", the recognizer emits
  partials but no final, and the user taps the mic to stop
- **THEN** the text in the field (the partial, plus anything the user had already typed) is sent
  exactly once through the ordinary Send path

#### Scenario: a write sentence with a final result is unaffected

- **WHEN** `voiceAutoSend` is ON and a FINAL result carries a payment sentence
- **THEN** it is sent exactly once, exactly as before this change — the request is only `/ask`, and
  the resulting proposal still needs its own Xác nhận

### Requirement: Auto-send can only ever ask

Auto-send MUST reuse the same Send path as the Gửi button, so the only request it can produce is the
ordinary question request (`POST /ask`). It MUST NOT be able to confirm a proposal, execute a write,
or reach `/execute`.

#### Scenario: write question auto-sent reaches only /ask

- **WHEN** `voiceAutoSend` is ON and a WRITE question is auto-sent
- **THEN** the only request made is `/ask`, no confirmation dialog is raised by dictation, and no
  `/execute` request is made
