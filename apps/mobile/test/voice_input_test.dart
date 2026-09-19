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
}
