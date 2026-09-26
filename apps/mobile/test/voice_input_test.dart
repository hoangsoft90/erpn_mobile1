import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:erpn_mobile/app/providers.dart';
import 'package:erpn_mobile/core/settings/app_settings_service.dart';
import 'package:erpn_mobile/features/chat/data/copilot_api_client.dart';
import 'package:erpn_mobile/features/chat/data/speech_service.dart';
import 'package:erpn_mobile/features/chat/presentation/screens/chat_screen.dart';

/// P6 (`plan2_final.md` §20, `.plan/phases2/p6-voice-stt.md`).
///
/// The safety property these tests defend is narrow and absolute: **voice is an
/// input modality**. Dictation may only write text into the editable field.
/// It must never send, and it must never reach `/execute`. A microphone is not
/// required — [SpeechService] is faked, so CI stays hermetic.

typedef Handler = Future<ResponseBody> Function(RequestOptions options);

class _MockAdapter implements HttpClientAdapter {
  _MockAdapter(this.handler);
  final Handler handler;

  @override
  void close({bool force = false}) {}

  @override
  Future<ResponseBody> fetch(
    RequestOptions options,
    Stream<Uint8List>? requestStream,
    Future<void>? cancelFuture,
  ) =>
      handler(options);
}

ResponseBody _json(Object body, [int status = 200]) => ResponseBody.fromString(
      jsonEncode(body),
      status,
      headers: {
        Headers.contentTypeHeader: [Headers.jsonContentType],
      },
    );

const _answerResult = {
  'question': 'chị Lan còn nợ bao nhiêu',
  'normalized': {'text': 'Lan còn nợ bao nhiêu'},
  'routed': {'group': 'customer', 'matched': 'còn nợ'},
  'customer': {'id': 'CUST-001', 'name': 'Nguyễn Thị Lan'},
  'outstanding_vnd': 2500000,
  'open_invoices': 1,
  'answer': 'Nguyễn Thị Lan còn nợ 2.500.000đ (1 chứng từ chưa thanh toán).',
};

/// A dictation engine under test control. It mirrors the real contract:
/// results arrive through callbacks, and it never sends anything itself.
class _FakeSpeech implements SpeechService {
  _FakeSpeech({
    this.initResult = SpeechStatus.idle,
    this.locale = 'vi_VN',
    this.localeIsVerified = true,
    this.throwOnListen = false,
  });

  SpeechStatus initResult;
  String? locale;

  /// Mirrors [SpeechService.localeVerified]: `false` = the device's list had no
  /// `vi` entry, which is NOT the same as "Vietnamese unsupported" (bug P6).
  bool localeIsVerified;
  bool throwOnListen;

  /// Holds initialize() open so a second tap can land while the first mic
  /// transition is still in flight (tester.tap pumps a frame, so without this
  /// the first session would already be fully open before the second tap).
  Completer<void>? initGate;

  int initCount = 0;
  int listenCount = 0;
  int stopCount = 0;
  int cancelCount = 0;

  bool _listening = false;
  SpeechResultCallback? _onResult;
  SpeechStatusCallback? _onStatus;

  @override
  Future<SpeechStatus> initialize() async {
    initCount++;
    if (initGate != null) await initGate!.future;
    return initResult;
  }

  @override
  String? get localeId => locale;

  @override
  bool get localeVerified => localeIsVerified;

  @override
  bool get isListening => _listening;

  @override
  Future<void> listen({
    required SpeechResultCallback onResult,
    required SpeechStatusCallback onStatus,
  }) async {
    listenCount++;
    if (throwOnListen) {
      onStatus(SpeechStatus.unavailable);
      return;
    }
    _onResult = onResult;
    _onStatus = onStatus;
    _listening = true;
    onStatus(SpeechStatus.listening);
  }

  /// Models the real plugin HONESTLY: `stop()` does not unregister the result
  /// listener, so one final result can still arrive while the session tears
  /// down. That is exactly the race the UI guard exists for — if this fake
  /// dropped it, the guard could never be falsified from here.
  @override
  Future<void> stop() async {
    stopCount++;
    _listening = false;
  }

  @override
  Future<void> cancel() async {
    cancelCount++;
    _listening = false;
    // cancel() DOES promise "no text afterwards" — honour it.
    _onResult = null;
  }

  /// Stands in for the OS recognizer reporting what it heard.
  void emit(String transcript, {bool isFinal = false}) =>
      _onResult?.call(transcript, isFinal);

  /// Stands in for a mid-session refusal (permission revoked, service died).
  void failWith(SpeechStatus status) => _onStatus?.call(status);
}

class _Recorder {
  final List<String> paths = [];
  final List<Map<String, dynamic>> bodies = [];

  /// When set, the handler waits on it — the only way for a widget test to
  /// observe the in-flight (loading) frame, which a mock that returns
  /// immediately skips straight past.
  Completer<void>? gate;

  Handler get handler => (options) async {
        if (gate != null) await gate!.future;
        paths.add(options.path);
        final data = options.data;
        bodies.add(data is String
            ? jsonDecode(data) as Map<String, dynamic>
            : (data as Map<String, dynamic>? ?? const {}));
        return _json({'ok': true, 'result': _answerResult});
      };
}

/// Minimal stand-in for the Settings screen's voice switch: `voiceAutoSend` is
/// the only getter the chat screen reads. Persistence of the real key is
/// covered in `settings_test.dart`.
class _FakeSettings extends AppSettingsService {
  _FakeSettings(this.voiceAutoSend) : super(prefs: null);

  @override
  final bool voiceAutoSend;
}

Future<void> _pumpChat(
  WidgetTester tester, {
  required _FakeSpeech speech,
  required _Recorder rec,
  bool voiceAutoSend = false,
}) async {
  await tester.pumpWidget(
    ProviderScope(
      overrides: [
        sharedPreferencesProvider.overrideWithValue(null),
        copilotApiClientProvider.overrideWithValue(
          CopilotApiClient(
            dio: Dio(BaseOptions(baseUrl: 'http://mock.local'))
              ..httpClientAdapter = _MockAdapter(rec.handler),
          ),
        ),
        speechServiceProvider.overrideWithValue(speech),
        // Only overridden when a test wants the switch ON — leaving the real
        // provider in place is what proves "OFF unless the user saved it".
        if (voiceAutoSend)
          appSettingsServiceProvider.overrideWithValue(_FakeSettings(true)),
      ],
      child: const MaterialApp(home: ChatScreen()),
    ),
  );
  await tester.pumpAndSettle();
}

String _fieldText(WidgetTester tester) =>
    tester.widget<TextField>(find.byType(TextField)).controller!.text;

// ─── P5-4 (plan5_final §6): exactly TWO layouts, keyed on voiceAutoSend ─────
// OFF must render the ORIGINAL row (§1.1 — nothing moves); ON swaps to the
// voice-first row INSIDE the same region (§1.2 — review2 §4.4: no full-screen
// redesign), keeps the TextField usable, and adds the explicit Huỷ while
// listening. The 25s cap (§7 item 3) fires as a tap-to-STOP, never a cancel.

Future<void> _pumpVoiceFirst(WidgetTester tester,
    {required _FakeSpeech speech, required _Recorder rec}) async {
  await _pumpChat(tester, speech: speech, rec: rec, voiceAutoSend: true);
}

void main() {
  testWidgets('dictation fills the editable field and does NOT send',
      (WidgetTester tester) async {
    final speech = _FakeSpeech();
    final rec = _Recorder();
    await _pumpChat(tester, speech: speech, rec: rec);

    await tester.tap(find.byIcon(Icons.mic_none));
    await tester.pumpAndSettle();
    expect(speech.listenCount, 1, reason: 'mic must open the recognizer');

    speech.emit('chị Lan còn nợ bao nhiêu');
    await tester.pump();

    expect(_fieldText(tester), 'chị Lan còn nợ bao nhiêu');
    expect(rec.paths, isEmpty,
        reason: 'P6: STT must never auto-send — the user presses Send');

    // Even the FINAL result must not fire a request.
    speech.emit('chị Lan còn nợ bao nhiêu', isFinal: true);
    await tester.pumpAndSettle();
    expect(rec.paths, isEmpty);
  });

  testWidgets('user edits the transcript, then Send → one /ask with the edit',
      (WidgetTester tester) async {
    final speech = _FakeSpeech();
    final rec = _Recorder();
    await _pumpChat(tester, speech: speech, rec: rec);

    await tester.tap(find.byIcon(Icons.mic_none));
    await tester.pumpAndSettle();
    // STT mishears the amount — exactly the case the phase worries about.
    speech.emit('chị Lan trả hai triệu', isFinal: true);
    await tester.pumpAndSettle();

    await tester.enterText(find.byType(TextField), 'chị Lan trả 2 triệu');
    await tester.tap(find.byIcon(Icons.send));
    await tester.pumpAndSettle();

    expect(rec.paths, ['/ask']);
    expect(rec.bodies.single['text'], 'chị Lan trả 2 triệu');
  });

  testWidgets('the voice flow never touches /execute',
      (WidgetTester tester) async {
    final speech = _FakeSpeech();
    final rec = _Recorder();
    await _pumpChat(tester, speech: speech, rec: rec);

    await tester.tap(find.byIcon(Icons.mic_none));
    await tester.pumpAndSettle();
    speech.emit('thu tiền cho chị Lan 2 triệu', isFinal: true);
    await tester.pumpAndSettle();
    await tester.tap(find.byIcon(Icons.send));
    await tester.pumpAndSettle();

    expect(rec.paths.where((p) => p.contains('execute')), isEmpty,
        reason: 'voice can never authorize a WRITE — confirm still required');
    expect(find.byType(AlertDialog), findsNothing,
        reason: 'STT must not raise a confirm dialog on its own');
  });

  testWidgets('microphone denied → clear message, no request, no crash',
      (WidgetTester tester) async {
    final speech = _FakeSpeech(initResult: SpeechStatus.denied);
    final rec = _Recorder();
    await _pumpChat(tester, speech: speech, rec: rec);

    await tester.tap(find.byIcon(Icons.mic_none));
    await tester.pumpAndSettle();

    expect(find.textContaining('quyền micro'), findsOneWidget);
    expect(speech.listenCount, 0);
    expect(rec.paths, isEmpty);
  });

  testWidgets('no recognizer on the device → clear message',
      (WidgetTester tester) async {
    final speech = _FakeSpeech(initResult: SpeechStatus.unavailable);
    final rec = _Recorder();
    await _pumpChat(tester, speech: speech, rec: rec);

    await tester.tap(find.byIcon(Icons.mic_none));
    await tester.pumpAndSettle();

    expect(find.textContaining('Không dùng được nhận dạng giọng nói'),
        findsOneWidget);
    expect(rec.paths, isEmpty);
  });

  // The real warnings must survive the P6 UX change: same phone whose list has
  // no `vi`, now hit by a genuine refusal.
  testWidgets('refusal DURING listening is surfaced, not silent',
      (WidgetTester tester) async {
    final speech = _FakeSpeech(locale: 'vi_VN', localeIsVerified: false);
    final rec = _Recorder();
    await _pumpChat(tester, speech: speech, rec: rec);

    await tester.tap(find.byIcon(Icons.mic_none));
    await tester.pumpAndSettle();
    expect(find.byIcon(Icons.mic), findsOneWidget);

    speech.failWith(SpeechStatus.denied);
    await tester.pumpAndSettle();

    expect(find.textContaining('quyền micro'), findsOneWidget);
    expect(find.byIcon(Icons.mic_none), findsOneWidget,
        reason: 'the button must leave the listening state');
  });

  // Bug P6 + UX follow-up (user 2026-09-18): the device's locale list has no
  // `vi` entry (Android lists only the ON-DEVICE recognizer) even though the
  // online one understands Vietnamese perfectly — Gboard did, and the app
  // claimed Vietnamese was missing. A soft "not listed" hint was still noise
  // the user can do nothing about, so the mic must say NOTHING about locales:
  // it just works, and real refusals (denied / unavailable) still speak up.
  testWidgets('locale list without vi → NO notice at all, mic just works',
      (WidgetTester tester) async {
    final speech = _FakeSpeech(locale: 'vi_VN', localeIsVerified: false);
    final rec = _Recorder();
    await _pumpChat(tester, speech: speech, rec: rec);

    await tester.tap(find.byIcon(Icons.mic_none));
    await tester.pumpAndSettle();

    expect(find.textContaining('liệt kê tiếng Việt'), findsNothing,
        reason: 'the locale list is not the user\'s business (P6 UX)');
    expect(find.textContaining('không có bộ nhận dạng tiếng Việt'), findsNothing,
        reason: 'missing from the list ≠ unsupported');
    expect(find.textContaining('bộ nhận dạng tiếng Việt'), findsNothing);
    // It still listens, and the real feedback is still shown.
    expect(speech.listenCount, 1);
    expect(find.textContaining('Đang nghe'), findsOneWidget);

    // The heart of the bug: dictation still fills the field and still does not
    // send anything.
    speech.emit('chị Lan còn nợ bao nhiêu', isFinal: true);
    await tester.pumpAndSettle();
    expect(_fieldText(tester), 'chị Lan còn nợ bao nhiêu');
    expect(rec.paths, isEmpty);
  });

  testWidgets('a verified Vietnamese locale shows no hint either',
      (WidgetTester tester) async {
    final speech = _FakeSpeech();
    final rec = _Recorder();
    await _pumpChat(tester, speech: speech, rec: rec);

    await tester.tap(find.byIcon(Icons.mic_none));
    await tester.pumpAndSettle();

    expect(find.textContaining('liệt kê tiếng Việt'), findsNothing);
    expect(find.textContaining('Đang nghe'), findsOneWidget);
  });

  testWidgets('a late result after stop must not resurrect text',
      (WidgetTester tester) async {
    final speech = _FakeSpeech();
    final rec = _Recorder();
    await _pumpChat(tester, speech: speech, rec: rec);

    await tester.tap(find.byIcon(Icons.mic_none));
    await tester.pumpAndSettle();
    speech.emit('chị Lan');
    await tester.pump();

    // User stops the mic, then the recognizer flushes its last result.
    await tester.tap(find.byIcon(Icons.mic));
    await tester.pumpAndSettle();
    speech.emit('chị Lan còn nợ bao nhiêu', isFinal: true);
    await tester.pump();

    expect(_fieldText(tester), 'chị Lan',
        reason: 'a result delivered after the mic closed must be ignored');
    expect(rec.paths, isEmpty);
  });

  testWidgets('the same guard protects a field the send just cleared',
      (WidgetTester tester) async {
    final speech = _FakeSpeech();
    final rec = _Recorder();
    await _pumpChat(tester, speech: speech, rec: rec);

    await tester.tap(find.byIcon(Icons.mic_none));
    await tester.pumpAndSettle();
    speech.emit('chị Lan còn nợ');
    await tester.pump();

    rec.gate = Completer<void>();
    await tester.tap(find.byIcon(Icons.send));
    await tester.pump();
    // Late final result while the request is in flight.
    speech.emit('chị Lan còn nợ bao nhiêu', isFinal: true);
    await tester.pump();

    rec.gate!.complete();
    rec.gate = null;
    await tester.pumpAndSettle();

    expect(rec.paths, ['/ask']);
    expect(_fieldText(tester), isEmpty,
        reason: 'sent text must not reappear in the cleared input');
  });

  testWidgets('double tap on the mic opens only ONE session',
      (WidgetTester tester) async {
    final speech = _FakeSpeech();
    final rec = _Recorder();
    await _pumpChat(tester, speech: speech, rec: rec);

    // Hold the FIRST tap inside initialize(): at this instant `_listening` is
    // still false, so only the re-entrancy guard stops the second tap from
    // opening a second recognizer session.
    speech.initGate = Completer<void>();
    await tester.tap(find.byIcon(Icons.mic_none));
    await tester.pump();
    expect(speech.listenCount, 0, reason: 'first tap is still initializing');

    await tester.tap(find.byIcon(Icons.mic_none));
    await tester.pump();

    speech.initGate!.complete();
    speech.initGate = null;
    await tester.pumpAndSettle();

    expect(speech.listenCount, 1, reason: 'the double tap must not double-open');
    expect(find.byIcon(Icons.mic), findsOneWidget);
  });

  testWidgets('tapping the mic again stops dictation', (WidgetTester tester) async {
    final speech = _FakeSpeech();
    final rec = _Recorder();
    await _pumpChat(tester, speech: speech, rec: rec);

    await tester.tap(find.byIcon(Icons.mic_none));
    await tester.pumpAndSettle();
    expect(find.byIcon(Icons.mic), findsOneWidget);

    await tester.tap(find.byIcon(Icons.mic));
    await tester.pumpAndSettle();

    expect(speech.stopCount, 1);
    expect(find.byIcon(Icons.mic_none), findsOneWidget);
    expect(rec.paths, isEmpty);
  });

  testWidgets('partial results REPLACE the running transcript, never append',
      (WidgetTester tester) async {
    final speech = _FakeSpeech();
    final rec = _Recorder();
    await _pumpChat(tester, speech: speech, rec: rec);

    await tester.tap(find.byIcon(Icons.mic_none));
    await tester.pumpAndSettle();
    speech.emit('chị');
    await tester.pump();
    speech.emit('chị Lan');
    await tester.pump();
    speech.emit('chị Lan còn nợ');
    await tester.pump();

    expect(_fieldText(tester), 'chị Lan còn nợ',
        reason: 'recognizedWords is the whole utterance, not a delta');
  });

  testWidgets('dictating after typing keeps what the user already wrote',
      (WidgetTester tester) async {
    final speech = _FakeSpeech();
    final rec = _Recorder();
    await _pumpChat(tester, speech: speech, rec: rec);

    await tester.enterText(find.byType(TextField), 'cho khách');
    await tester.tap(find.byIcon(Icons.mic_none));
    await tester.pumpAndSettle();
    speech.emit('chị Lan', isFinal: true);
    await tester.pumpAndSettle();

    expect(_fieldText(tester), 'cho khách chị Lan');
  });

  testWidgets('sending mid-dictation closes the microphone',
      (WidgetTester tester) async {
    final speech = _FakeSpeech();
    final rec = _Recorder();
    await _pumpChat(tester, speech: speech, rec: rec);

    await tester.tap(find.byIcon(Icons.mic_none));
    await tester.pumpAndSettle();
    // Partial result: text is in the field, the session is still open.
    speech.emit('chị Lan còn nợ');
    await tester.pump();
    expect(find.byIcon(Icons.mic), findsOneWidget);

    // Hold the request open so the loading frame is actually rendered.
    rec.gate = Completer<void>();
    await tester.tap(find.byIcon(Icons.send));
    await tester.pump();

    expect(speech.stopCount, greaterThanOrEqualTo(1),
        reason: 'the mic must not stay open behind an in-flight /ask');
    expect(find.byIcon(Icons.mic_none), findsOneWidget);

    rec.gate!.complete();
    rec.gate = null;
    await tester.pumpAndSettle();
    expect(rec.paths, ['/ask']);
  });

  // ── P6 UX: "Tự gửi sau khi nói xong" — opt-in, default OFF ────────────────

  testWidgets('auto-send OFF by default: a FINAL result still waits for Gửi',
      (WidgetTester tester) async {
    final speech = _FakeSpeech();
    final rec = _Recorder();
    await _pumpChat(tester, speech: speech, rec: rec);

    await tester.tap(find.byIcon(Icons.mic_none));
    await tester.pumpAndSettle();
    speech.emit('chị Lan còn nợ bao nhiêu', isFinal: true);
    await tester.pumpAndSettle();

    expect(_fieldText(tester), 'chị Lan còn nợ bao nhiêu');
    expect(rec.paths, isEmpty,
        reason: 'the default must keep P6 behaviour: read it, then press Gửi');
  });

  testWidgets('auto-send ON: a final result goes through the SAME Send path',
      (WidgetTester tester) async {
    final speech = _FakeSpeech();
    final rec = _Recorder();
    await _pumpChat(tester, speech: speech, rec: rec, voiceAutoSend: true);

    await tester.tap(find.byIcon(Icons.mic_none));
    await tester.pumpAndSettle();
    speech.emit('chị Lan còn nợ bao nhiêu', isFinal: true);
    await tester.pumpAndSettle();

    expect(rec.paths, ['/ask'], reason: 'exactly one request, /ask only');
    expect(rec.bodies.single['text'], 'chị Lan còn nợ bao nhiêu');
    expect(_fieldText(tester), isEmpty, reason: 'a sent message clears the field');
  });

  testWidgets('auto-send ON: partial results never send',
      (WidgetTester tester) async {
    final speech = _FakeSpeech();
    final rec = _Recorder();
    await _pumpChat(tester, speech: speech, rec: rec, voiceAutoSend: true);

    await tester.tap(find.byIcon(Icons.mic_none));
    await tester.pumpAndSettle();
    speech.emit('chị Lan');
    speech.emit('chị Lan còn nợ');
    await tester.pumpAndSettle();

    expect(rec.paths, isEmpty, reason: 'only a FINAL result may trigger a send');
    expect(_fieldText(tester), 'chị Lan còn nợ');
  });

  testWidgets('auto-send ON: an empty final result sends nothing',
      (WidgetTester tester) async {
    final speech = _FakeSpeech();
    final rec = _Recorder();
    await _pumpChat(tester, speech: speech, rec: rec, voiceAutoSend: true);

    // Text typed BEFORE dictation: a recognition that heard nothing (timeout /
    // no speech) must not post it as if the user had spoken it.
    await tester.enterText(find.byType(TextField), 'cho khách');
    await tester.tap(find.byIcon(Icons.mic_none));
    await tester.pumpAndSettle();
    speech.emit('', isFinal: true);
    await tester.pumpAndSettle();

    expect(rec.paths, isEmpty);
    expect(_fieldText(tester), 'cho khách', reason: 'the field is left untouched');
  });

  testWidgets('auto-send ON: a recognizer refusal sends nothing',
      (WidgetTester tester) async {
    final speech = _FakeSpeech();
    final rec = _Recorder();
    await _pumpChat(tester, speech: speech, rec: rec, voiceAutoSend: true);

    await tester.tap(find.byIcon(Icons.mic_none));
    await tester.pumpAndSettle();
    // Permission revoked / recognizer died mid-session: no final result ever
    // arrives, so nothing may be sent and the refusal must be surfaced.
    speech.failWith(SpeechStatus.unavailable);
    await tester.pumpAndSettle();

    expect(rec.paths, isEmpty);
    expect(find.textContaining('Không dùng được nhận dạng giọng nói'),
        findsOneWidget);
  });

  testWidgets('auto-send ON: the only route it can reach is /ask',
      (WidgetTester tester) async {
    final speech = _FakeSpeech();
    final rec = _Recorder();
    await _pumpChat(tester, speech: speech, rec: rec, voiceAutoSend: true);

    await tester.tap(find.byIcon(Icons.mic_none));
    await tester.pumpAndSettle();
    // A WRITE question: auto-send may post it, but it can only ever ASK; the
    // proposal it comes back with still needs its own Xác nhận tap.
    speech.emit('thu tiền cho chị Lan 2 triệu', isFinal: true);
    await tester.pumpAndSettle();

    expect(rec.paths, ['/ask'], reason: 'auto-send must never execute anything');
    expect(rec.paths.any((p) => p.contains('execute')), isFalse);
  });

  testWidgets('auto-send ON: a SECOND final result cannot send twice',
      (WidgetTester tester) async {
    final speech = _FakeSpeech();
    final rec = _Recorder();
    await _pumpChat(tester, speech: speech, rec: rec, voiceAutoSend: true);

    await tester.tap(find.byIcon(Icons.mic_none));
    await tester.pumpAndSettle();
    // Recognizers flush more than one final result while tearing down. One
    // utterance = one request: the first final closes the session, so the
    // second must be ignored (it would otherwise re-post the same question).
    speech.emit('chị Lan còn nợ bao nhiêu', isFinal: true);
    speech.emit('chị Lan còn nợ bao nhiêu', isFinal: true);
    await tester.pumpAndSettle();

    expect(rec.paths, ['/ask'], reason: 'exactly one request for one utterance');
    expect(_fieldText(tester), isEmpty,
        reason: 'the late duplicate must not land back in the field');
  });

  testWidgets('a recognizer that fails to open does not wedge the button',
      (WidgetTester tester) async {
    final speech = _FakeSpeech(throwOnListen: true);
    final rec = _Recorder();
    await _pumpChat(tester, speech: speech, rec: rec);

    await tester.tap(find.byIcon(Icons.mic_none));
    await tester.pumpAndSettle();

    expect(find.textContaining('Không dùng được nhận dạng giọng nói'),
        findsOneWidget);
    expect(find.byIcon(Icons.mic_none), findsOneWidget);
    expect(rec.paths, isEmpty);
  });

  // ─── P5-4 (plan5_final §6): two layouts + Huỷ + the 25s cap ───────────

  // The STREAMED-INTO-FIELD reality the P5-4 Huỷ contract rests on: the field
  // mirrors partial results WHILE listening (so the user can read what was
  // heard), and tap-to-stop KEEPS what landed. These two asserts are the
  // precondition for the Huỷ test below — without them "discards the
  // transcript" would be unmeasurable.
  testWidgets('P5-4 precondition: partials stream into the field WHILE listening',
      (tester) async {
    final speech = _FakeSpeech();
    final rec = _Recorder();
    await _pumpVoiceFirst(tester, speech: speech, rec: rec);

    await tester.tap(find.byKey(const ValueKey('voice-primary-mic')));
    await tester.pumpAndSettle();
    speech.emit('câu đang nói');
    await tester.pump();
    expect(_fieldText(tester), 'câu đang nói',
        reason: 'the user can read the transcript while the mic is open');
    expect(find.byKey(const ValueKey('cancel-dictation')), findsOneWidget);
    expect(rec.paths, isEmpty);
  });

  testWidgets('P5-4 OFF: the input bar keeps its ORIGINAL shape (small mic, no cancel)',
      (tester) async {
    final speech = _FakeSpeech();
    final rec = _Recorder();
    await _pumpChat(tester, speech: speech, rec: rec);

    // §1.1: the OFF branch must not change ANYTHING the old tests relied on:
    // small mic icon (mic_none when idle), camera, send — and no voice-first
    // CTA key anywhere.
    expect(find.byIcon(Icons.mic_none), findsOneWidget);
    expect(find.byIcon(Icons.photo_camera_outlined), findsOneWidget);
    expect(find.byIcon(Icons.send), findsOneWidget);
    expect(find.byKey(const ValueKey('voice-primary-mic')), findsNothing,
        reason: 'the voice-first CTA must not exist in the default layout');
    expect(find.byKey(const ValueKey('cancel-dictation')), findsNothing);
    expect(find.byKey(const ValueKey('cancel-dictation-icon')), findsNothing);

    // And dictation behaves exactly as before (kept transcript on stop).
    await tester.tap(find.byIcon(Icons.mic_none));
    await tester.pumpAndSettle();
    speech.emit('chị Lan còn nợ bao nhiêu');
    await tester.pump();
    await tester.tap(find.byIcon(Icons.mic));
    await tester.pumpAndSettle();
    expect(_fieldText(tester), 'chị Lan còn nợ bao nhiêu');
    expect(find.byKey(const ValueKey('cancel-dictation')), findsNothing,
        reason: 'no explicit Huỷ in the default layout at any point');
  });

  testWidgets('P5-4 ON: voice-first CTA + the TextField stays visible and usable',
      (tester) async {
    final speech = _FakeSpeech();
    final rec = _Recorder();
    await _pumpVoiceFirst(tester, speech: speech, rec: rec);

    // §1.2: the primary mic CTA exists in the SAME region as the input bar.
    expect(find.byKey(const ValueKey('voice-primary-mic')), findsOneWidget);
    // plan5 invariant: text is ALWAYS the fallback — not hidden, not disabled.
    final field = tester.widget<TextField>(find.byType(TextField));
    expect(field.enabled, isTrue,
        reason: 'the text fallback must stay usable in voice-first mode');
    expect(field.controller, isNotNull);
    // No cancel button while NOT listening.
    expect(find.byKey(const ValueKey('cancel-dictation')), findsNothing);
    expect(find.byKey(const ValueKey('cancel-dictation-icon')), findsNothing);

    // Type by hand instead of dictating — the fallback must really work.
    await tester.enterText(find.byType(TextField), 'công nợ chị Lan');
    await tester.pump();
    expect(_fieldText(tester), 'công nợ chị Lan');
  });

  testWidgets('P5-4 ON while listening: Huỷ appears and DISCARDS the transcript',
      (tester) async {
    final speech = _FakeSpeech();
    final rec = _Recorder();
    await _pumpVoiceFirst(tester, speech: speech, rec: rec);

    await tester.tap(find.byKey(const ValueKey('voice-primary-mic')));
    await tester.pumpAndSettle();
    speech.emit('câu không muốn gửi');
    await tester.pump();
    expect(_fieldText(tester), 'câu không muốn gửi');

    // Both cancel affordances exist while listening (button below the row,
    // icon inside the row).
    expect(find.byKey(const ValueKey('cancel-dictation')), findsOneWidget);
    expect(find.byKey(const ValueKey('cancel-dictation-icon')), findsOneWidget);

    await tester.tap(find.byKey(const ValueKey('cancel-dictation')));
    await tester.pumpAndSettle();

    // The contract: stop listening AND nothing that was heard survives.
    expect(speech.cancelCount, 1, reason: 'Huỷ must cancel, not stop-and-keep');
    expect(speech.stopCount, 0,
        reason: 'Huỷ is not tap-to-stop — the fake must see cancel()');
    expect(_fieldText(tester), '',
        reason: 'the transcript must NOT reach the field after Huỷ');
    expect(rec.paths, isEmpty,
        reason: 'Huỷ must not send anything either');
    expect(find.byKey(const ValueKey('cancel-dictation')), findsNothing);
  });

  testWidgets('P5-4 ON: tap-to-stop still KEEPS the transcript (opposite of Huỷ)',
      (tester) async {
    final speech = _FakeSpeech();
    final rec = _Recorder();
    await _pumpVoiceFirst(tester, speech: speech, rec: rec);

    await tester.tap(find.byKey(const ValueKey('voice-primary-mic')));
    await tester.pumpAndSettle();
    speech.emit('chị Lan còn nợ bao nhiêu');
    await tester.pump();

    // Tap the RUNNING mic again — the classic tap-to-stop.
    await tester.tap(find.byKey(const ValueKey('voice-primary-mic')));
    await tester.pumpAndSettle();

    expect(speech.stopCount, 1, reason: 'tap-to-stop must stop(), not cancel()');
    expect(speech.cancelCount, 0);
    expect(_fieldText(tester), 'chị Lan còn nợ bao nhiêu',
        reason: 'tap-to-stop keeps what was heard — the Huỷ contrast case');
  });

  testWidgets('P5-4: the 25s cap auto-stops like tap-to-stop (transcript kept, auto-send allowed)',
      (tester) async {
    final speech = _FakeSpeech();
    final rec = _Recorder();
    await _pumpVoiceFirst(tester, speech: speech, rec: rec);

    await tester.tap(find.byKey(const ValueKey('voice-primary-mic')));
    await tester.pumpAndSettle();
    speech.emit('chị Lan còn nợ bao nhiêu');
    await tester.pump();

    // The cap is armed with AppConstants.voiceMaxRecordDuration (§7 item 3
    // pins 25s). Pumping BEYOND it (26s) must have fired it; the session ends
    // as a tap-to-STOP: cancelCount stays 0, the field keeps the words.
    await tester.pump(const Duration(seconds: 26));
    await tester.pumpAndSettle();

    expect(speech.stopCount, 1,
        reason: 'the cap fires as tap-to-stop, never as Huỷ');
    expect(speech.cancelCount, 0,
        reason: 'a cap is not a cancel — the user still gets their words');
    expect(_fieldText(tester), 'chị Lan còn nợ bao nhiêu');
    // AUTO-SEND MUST *NOT* FIRE ON THE CAP. "Tự động dừng như thể user
    // tap-để-dừng" mimics tap-to-stop EXACTLY — and a real tap-to-stop never
    // auto-sends (the teardown guard drops the post-stop result, self-review
    // 2026-09-18). Auto-send belongs to the FINAL result the engine emits on
    // its own (pauseFor/listenFor); a broken engine that never finalizes
    // (P5-0a) gets its words KEPT for a manual Gửi, not silently sent by a
    // timer the user never reviewed.
    expect(rec.paths, isEmpty,
        reason: 'the cap keeps the words for review — it must not auto-send');
  });

  testWidgets('P5-4: the 25s cap with auto-send OFF keeps the transcript and sends nothing',
      (tester) async {
    final speech = _FakeSpeech();
    final rec = _Recorder();
    await _pumpChat(tester, speech: speech, rec: rec); // OFF layout

    await tester.tap(find.byIcon(Icons.mic_none));
    await tester.pumpAndSettle();
    speech.emit('chị Lan còn nợ bao nhiêu');
    await tester.pump();

    // Same cap, same tap-to-stop shape — the layout only changes WHO the
    // primary CTA is, never the cap or the transcript contract.
    await tester.pump(const Duration(seconds: 26));
    await tester.pumpAndSettle();

    expect(speech.stopCount, 1, reason: 'the cap fires in the OFF layout too');
    expect(speech.cancelCount, 0);
    expect(_fieldText(tester), 'chị Lan còn nợ bao nhiêu',
        reason: 'the words stay for a manual Gửi');
    expect(rec.paths, isEmpty,
        reason: 'auto-send OFF: the cap must not send either');
  });

  testWidgets('P5-4 invariant: voice-first still sends ONLY through onSend() → /ask',
      (tester) async {
    final speech = _FakeSpeech();
    final rec = _Recorder();
    await _pumpVoiceFirst(tester, speech: speech, rec: rec);

    await tester.tap(find.byKey(const ValueKey('voice-primary-mic')));
    await tester.pumpAndSettle();
    speech.emit('chị Lan còn nợ bao nhiêu', isFinal: true);
    await tester.pumpAndSettle();

    // plan5 §2 invariant, pinned for the NEW layout: one /ask, nothing else —
    // a mic that could reach /execute would be a hard regression. (The field
    // is CLEARED by the send — same as pressing Gửi by hand.)
    expect(rec.paths, ['/ask']);
    expect(rec.bodies.single['text'], 'chị Lan còn nợ bao nhiêu',
        reason: 'what was dictated is what was asked');
    expect(_fieldText(tester), '',
        reason: 'the send clears the field, exactly like a manual Gửi');
  });

  // ─── P5-0 (plan5_final §5): auto-send hard corners, logic UNTOUCHED ────────
  // These three tests only PIN the current behaviour of the corner cases the
  // bug reports questioned. If any of them fails, the bug is real and P5-1
  // gets a precise reproduction; if they all pass, bug #2 stays closed.

  testWidgets('P5-0a auto-send ON: partials that NEVER become final send nothing',
      (WidgetTester tester) async {
    // The OEM hypothesis (review2 §5): some Android recognizers emit partial
    // results and never a final one. Model it exactly — a stream of non-final
    // updates, then silence. Nothing may be posted, and the field keeps the
    // last thing the user said (they can still press Gửi themselves).
    final speech = _FakeSpeech();
    final rec = _Recorder();
    await _pumpChat(tester, speech: speech, rec: rec, voiceAutoSend: true);

    await tester.tap(find.byIcon(Icons.mic_none));
    await tester.pumpAndSettle();
    speech.emit('chị Lan');
    await tester.pump();
    speech.emit('chị Lan còn');
    await tester.pump();
    speech.emit('chị Lan còn nợ bao nhiêu');
    await tester.pump();
    // …and the recognizer goes quiet — no final ever arrives.
    await tester.pump(const Duration(seconds: 3));

    expect(rec.paths, isEmpty,
        reason: 'no final result ⇒ no auto-send; waiting longer must not post it');
    expect(_fieldText(tester), 'chị Lan còn nợ bao nhiêu',
        reason: 'the transcript stays editable for a manual Gửi');
  });

  testWidgets('P5-0b auto-send ON: rapid double tap on the mic sends at most once',
      (WidgetTester tester) async {
    // The reported scenario: quick taps around the moment speech ends. Whether
    // the second tap lands before or after the auto-send, the server must see
    // AT MOST one /ask (a second session opening must not double-post).
    final speech = _FakeSpeech();
    final rec = _Recorder();
    await _pumpChat(tester, speech: speech, rec: rec, voiceAutoSend: true);

    await tester.tap(find.byIcon(Icons.mic_none));
    await tester.pumpAndSettle();
    speech.emit('chị Lan còn nợ bao nhiêu', isFinal: true);
    // No settle: the second tap lands while the first auto-send is resolving.
    // The mic icon only swaps to Icons.mic while _listening; by the time the
    // final result lands the session is already closing, so find the CURRENT
    // icon instead of guessing which state the frame is in.
    await tester.pump();
    final micNow = find.byWidgetPredicate(
      (w) => w is Icon && (w.icon == Icons.mic || w.icon == Icons.mic_none),
    );
    if (tester.any(micNow)) {
      await tester.tap(micNow.first);
    }

    await tester.pumpAndSettle();

    expect(rec.paths.length, lessThanOrEqualTo(1),
        reason: 'one utterance may produce at most one /ask, however the taps land');
    for (final p in rec.paths) {
      expect(p, '/ask', reason: 'and every request it does make is /ask only');
    }
  });

  testWidgets('P5-0c auto-send ON: a final result while the previous send is in flight does not double-post',
      (WidgetTester tester) async {
    // The guard for this lives in ChatController.send (isLoading) — P5-0 must
    // prove it holds for the VOICE path, not just for button taps. The gate
    // keeps the first request in flight while a second final result arrives.
    final speech = _FakeSpeech();
    final rec = _Recorder();
    await _pumpChat(tester, speech: speech, rec: rec, voiceAutoSend: true);

    await tester.tap(find.byIcon(Icons.mic_none));
    await tester.pumpAndSettle();
    rec.gate = Completer<void>();
    speech.emit('câu thứ nhất', isFinal: true);
    await tester.pump();
    // A second final while the first request is still in flight.
    speech.emit('câu thứ hai', isFinal: true);
    await tester.pump();

    rec.gate!.complete();
    rec.gate = null;
    await tester.pumpAndSettle();

    expect(rec.paths, ['/ask'],
        reason: 'isLoading must absorb the concurrent final — one request total');
    expect(rec.bodies.single['text'], 'câu thứ nhất',
        reason: 'and it is the FIRST utterance that went out');
  });
}
