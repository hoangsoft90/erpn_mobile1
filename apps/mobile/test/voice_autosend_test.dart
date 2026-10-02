import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:erpn_mobile/app/providers.dart';
import 'package:erpn_mobile/core/settings/app_settings_service.dart';
import 'package:erpn_mobile/features/chat/data/copilot_api_client.dart';
import 'package:erpn_mobile/features/chat/data/speech_service.dart';
import 'package:erpn_mobile/features/chat/data/voice_write_guard.dart';
import 'package:erpn_mobile/features/chat/presentation/screens/chat_screen.dart';

/// B1 (`.plan/next7/B1-result.md`) — "Tự gửi sau khi nói xong".
///
/// B0 proved the shipped code only auto-sent on the recognizer's own FINAL
/// result, so the interaction the shopkeeper actually performs (speak, then tap
/// the mic to stop) never sent anything. These tests pin the DoD in
/// `plan_final.md` §4: one dictation session sends AT MOST ONCE, whichever end
/// event arrives first, and a write-shaped partial is never sent unreviewed.
///
/// The B0 probe cases (`test/_probe_b0_voice_autosend.dart`) live on here as
/// real tests — the probe file is gone.

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

ResponseBody _json(Object body) => ResponseBody.fromString(
      jsonEncode(body),
      200,
      headers: {
        Headers.contentTypeHeader: [Headers.jsonContentType],
      },
    );

/// Models the real plugin HONESTLY, like `voice_input_test.dart` does: `stop()`
/// does NOT unregister the result listener, so one final result can still be
/// flushed while the session tears down. That is the race B1's exactly-once
/// guard exists for — a fake that dropped it could not falsify the guard.
class _FakeSpeech implements SpeechService {
  int initCount = 0;
  int listenCount = 0;
  int stopCount = 0;
  int cancelCount = 0;

  bool _listening = false;
  SpeechResultCallback? _onResult;

  @override
  Future<SpeechStatus> initialize() async {
    initCount++;
    return SpeechStatus.idle;
  }

  @override
  String? get localeId => 'vi_VN';

  @override
  bool get localeVerified => true;

  @override
  bool get isListening => _listening;

  @override
  Future<void> listen({
    required SpeechResultCallback onResult,
    required SpeechStatusCallback onStatus,
  }) async {
    listenCount++;
    _onResult = onResult;
    _listening = true;
    onStatus(SpeechStatus.listening);
  }

  @override
  Future<void> stop() async {
    stopCount++;
    _listening = false;
  }

  @override
  Future<void> cancel() async {
    cancelCount++;
    _listening = false;
    _onResult = null;
  }

  /// Stands in for the OS recognizer reporting what it heard.
  void emit(String transcript, {bool isFinal = false}) =>
      _onResult?.call(transcript, isFinal);

  /// The final the plugin flushes during teardown, AFTER `stop()`.
  void flushAfterStop(String transcript) => _onResult?.call(transcript, true);
}

class _Recorder {
  final List<String> paths = [];
  final List<Map<String, dynamic>> bodies = [];

  /// When set, the handler waits on it — the only way to observe the in-flight
  /// frame a mock that returns immediately skips past.
  Completer<void>? gate;

  Handler get handler => (options) async {
        if (gate != null) await gate!.future;
        paths.add(options.path);
        final data = options.data;
        bodies.add(data is String
            ? jsonDecode(data) as Map<String, dynamic>
            : (data as Map<String, dynamic>? ?? const {}));
        return _json({'ok': true, 'result': {'answer': 'ok'}});
      };
}

/// `voiceAutoSend` is the only getter the chat screen reads; persistence of the
/// real key has its own coverage in `settings_test.dart` (B6).
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

/// The voice-first layout (`voiceAutoSend == true`) — the layout the report came
/// from. Its primary CTA is a keyed widget, so tests never guess an icon.
Future<void> _pumpVoiceFirst(
  WidgetTester tester, {
  required _FakeSpeech speech,
  required _Recorder rec,
}) =>
    _pumpChat(tester, speech: speech, rec: rec, voiceAutoSend: true);

const _voiceMic = ValueKey('voice-primary-mic');
const _cancelDictation = ValueKey('cancel-dictation');

String _fieldText(WidgetTester tester) =>
    tester.widget<TextField>(find.byType(TextField)).controller!.text;

void main() {
  // ─── Unit: the write-shaped guard (pure, no widgets) ──────────────────────
  //
  // Union of the WRITE triggers in `mcp-erpnext/capabilities.json` — accented
  // and unaccented, the two spellings that contract itself ships.
  group('looksLikeWriteOrder', () {
    test('payment and sale sentences are write-shaped', () {
      expect(looksLikeWriteOrder('thu tiền chị Lan 2 triệu'), isTrue);
      expect(looksLikeWriteOrder('thu tien chi Lan 2 trieu'), isTrue);
      expect(looksLikeWriteOrder('ghi nhận thanh toán cho chị Lan'), isTrue);
      expect(looksLikeWriteOrder('chuyển khoản 5 triệu'), isTrue);
      expect(looksLikeWriteOrder('lập hóa đơn cho đơn này'), isTrue);
      expect(looksLikeWriteOrder('đặt hàng 10 bao cám'), isTrue);
      expect(looksLikeWriteOrder('xóa đơn nháp'), isTrue);
      expect(looksLikeWriteOrder('báo giá cho khách mới'), isTrue);
    });

    test('read questions are not write-shaped', () {
      expect(looksLikeWriteOrder('chị Lan còn nợ bao nhiêu'), isFalse);
      expect(looksLikeWriteOrder('doanh thu hôm nay'), isFalse);
      // The contract does NOT list a bare "bán" as a write trigger, so a
      // revenue question that contains it must stay sendable.
      expect(looksLikeWriteOrder('doanh thu bán được bao nhiêu'), isFalse);
      expect(looksLikeWriteOrder('tồn kho cám còn bao nhiêu'), isFalse);
      expect(looksLikeWriteOrder(''), isFalse);
      expect(looksLikeWriteOrder('   '), isFalse);
    });

    test('matching is token-based, not substring-based', () {
      // "huyện" contains "huy" as a substring; a substring check would block a
      // perfectly good question. Space-padded matching is what prevents it.
      expect(looksLikeWriteOrder('khách ở huyện Củ Chi còn nợ'), isFalse);
      // …while the real token still matches, punctuation or not.
      expect(looksLikeWriteOrder('huỷ đơn này'), isTrue);
      expect(looksLikeWriteOrder('xóa, đơn nháp'), isTrue);
    });
  });

  // ─── Contract drift check (B1 review) ────────────────────────────────────
  //
  // The guard's vocabulary is copied from the server contract, and a copy can
  // rot. This asserts the copy is COMPLETE: every trigger of every `type: WRITE`
  // capability in `mcp-erpnext/capabilities.json` must be recognised by it. A new
  // WRITE capability (or a new trigger on an existing one) therefore cannot slip
  // past the guard silently — the fix is to teach `voice_write_guard.dart`, not
  // to relax this test.
  group('guard vocabulary covers the server contract', () {
    test('every WRITE trigger in capabilities.json is matched', () {
      // `flutter test` runs with the package dir (apps/mobile) as cwd.
      final file = File('../../mcp-erpnext/capabilities.json');
      expect(file.existsSync(), isTrue,
          reason: 'the contract must be readable from the test: ${file.path}');
      final root = jsonDecode(file.readAsStringSync()) as Map<String, dynamic>;
      final caps = (root['capabilities'] ?? root) as Map<String, dynamic>;

      final misses = <String>[];
      final checked = <String>[];
      final writeCaps = <String>{};
      for (final entry in caps.entries) {
        final value = entry.value;
        if (value is! Map<String, dynamic>) continue;
        if (value['type'] != 'WRITE') continue;
        writeCaps.add(entry.key);
        for (final trigger in (value['triggers'] as List? ?? const [])) {
          final phrase = trigger.toString();
          checked.add('${entry.key}: $phrase');
          if (!looksLikeWriteOrder(phrase)) misses.add('${entry.key}: $phrase');
        }
      }

      // Canaries: a vacuous pass is the real risk here (an unreadable contract or
      // a changed shape would otherwise leave both lists empty and "green").
      expect(writeCaps, contains('payment.create'),
          reason: 'the contract shape changed — fix THIS test, do not relax it');
      expect(writeCaps, contains('document.delete'));
      expect(checked.length, greaterThan(50),
          reason: 'suspiciously few WRITE triggers were read: ${checked.length}');
      expect(misses, isEmpty,
          reason: 'WRITE triggers the guard does NOT block: $misses');
    });
  });

  // ─── Harness canary (B2) ─────────────────────────────────────────────────
  //
  // Every ON test below depends on `_pumpVoiceFirst` REALLY enabling the switch.
  // If that override ever stopped taking effect, the whole regression net would
  // quietly exercise the OFF layout and still pass — a net that cannot fail is
  // worse than none. This pins the two modes apart, and pins that the OFF tests
  // are genuinely OFF rather than reading an unset key as true.
  // Two single-pump canaries rather than one double-pump: re-pumping a new
  // ProviderScope does not re-create an already-read provider, so a second pump
  // would assert against a stale element tree and prove nothing.
  testWidgets('harness canary A: OFF is the default row, and OFF by default',
      (tester) async {
    await _pumpChat(tester, speech: _FakeSpeech(), rec: _Recorder());

    expect(find.byKey(_voiceMic), findsNothing,
        reason: 'no override ⇒ the real setting ⇒ the default input row');
    expect(find.byIcon(Icons.mic_none), findsOneWidget);
    expect(AppSettingsService(prefs: null).voiceAutoSend, isFalse,
        reason: 'the "OFF" tests must be OFF by DEFAULT, not by accident');
  });

  testWidgets('harness canary B: ON really renders the voice-first CTA',
      (tester) async {
    await _pumpVoiceFirst(tester, speech: _FakeSpeech(), rec: _Recorder());

    expect(find.byKey(_voiceMic), findsOneWidget,
        reason: 'the ON helper must REALLY enable the voice-first layout — '
            'otherwise every ON test below silently exercises OFF');
    // The CTA is the keyed one; idle it still shows the same mic glyph as the
    // default row, which is exactly why the KEY (not the icon) is the marker.
    expect(find.byIcon(Icons.mic_none), findsOneWidget);
  });

  // ─── B2: the path that already worked ────────────────────────────────────
  testWidgets('B2 ON + final result → exactly one /ask', (tester) async {
    final speech = _FakeSpeech();
    final rec = _Recorder();
    await _pumpVoiceFirst(tester, speech: speech, rec: rec);

    await tester.tap(find.byKey(_voiceMic));
    await tester.pumpAndSettle();
    speech.emit('chị Lan còn nợ bao nhiêu', isFinal: true);
    await tester.pumpAndSettle();

    expect(rec.paths, ['/ask']);
    expect(rec.bodies.single['text'], 'chị Lan còn nợ bao nhiêu');
    expect(_fieldText(tester), isEmpty);
  });

  // ─── B0#2 (was the bug): the user's own stop IS "nói xong" ───────────────
  testWidgets('B0#2 ON + partials + tap-to-stop → exactly one /ask',
      (tester) async {
    final speech = _FakeSpeech();
    final rec = _Recorder();
    await _pumpVoiceFirst(tester, speech: speech, rec: rec);

    await tester.tap(find.byKey(_voiceMic));
    await tester.pumpAndSettle();
    speech.emit('chị Lan còn nợ'); // partials stream into the field
    await tester.pump();

    // The user follows the tooltip "Dừng nhập giọng nói".
    await tester.tap(find.byKey(_voiceMic));
    await tester.pumpAndSettle();

    expect(speech.stopCount, 1);
    expect(rec.paths, ['/ask'],
        reason: 'ON + the user finished speaking ⇒ exactly one send');
    expect(rec.bodies.single['text'], 'chị Lan còn nợ',
        reason: 'the partial that was heard is what goes out');
    expect(_fieldText(tester), isEmpty, reason: 'a send clears the field');
  });

  // ─── B0#3 (was the bug): the teardown final after a stop ────────────────
  testWidgets('B0#3 ON + tap-to-stop then teardown final → still one /ask',
      (tester) async {
    final speech = _FakeSpeech();
    final rec = _Recorder();
    await _pumpVoiceFirst(tester, speech: speech, rec: rec);

    await tester.tap(find.byKey(_voiceMic));
    await tester.pumpAndSettle();
    speech.emit('chị Lan còn nợ');
    await tester.pump();

    await tester.tap(find.byKey(_voiceMic));
    await tester.pumpAndSettle();
    // The plugin flushes one last final during teardown (real behaviour).
    speech.flushAfterStop('chị Lan còn nợ bao nhiêu');
    await tester.pumpAndSettle();

    expect(rec.paths, ['/ask'],
        reason: 'the late final must not add a second request');
  });

  // ─── B1: the opt-out is absolute ────────────────────────────────────────
  testWidgets('B1 OFF + tap-to-stop → no request, text kept', (tester) async {
    final speech = _FakeSpeech();
    final rec = _Recorder();
    await _pumpChat(tester, speech: speech, rec: rec); // OFF layout

    await tester.tap(find.byIcon(Icons.mic_none));
    await tester.pumpAndSettle();
    speech.emit('chị Lan còn nợ bao nhiêu');
    await tester.pump();

    await tester.tap(find.byIcon(Icons.mic));
    await tester.pumpAndSettle();

    expect(rec.paths, isEmpty);
    expect(_fieldText(tester), 'chị Lan còn nợ bao nhiêu',
        reason: 'OFF keeps P6 behaviour: read it, then press Gửi');
  });

  // ─── B3: Huỷ sends nothing, ever ────────────────────────────────────────
  testWidgets('B3 ON + Huỷ → no request, field restored, late final ignored',
      (tester) async {
    final speech = _FakeSpeech();
    final rec = _Recorder();
    await _pumpVoiceFirst(tester, speech: speech, rec: rec);

    await tester.enterText(find.byType(TextField), 'cho khách');
    await tester.tap(find.byKey(_voiceMic));
    await tester.pumpAndSettle();
    speech.emit('câu không muốn gửi');
    await tester.pump();

    await tester.tap(find.byKey(_cancelDictation));
    await tester.pumpAndSettle();

    expect(speech.cancelCount, 1);
    expect(rec.paths, isEmpty);
    expect(_fieldText(tester), 'cho khách',
        reason: 'Huỷ restores the text the field held before dictation');

    // A teardown result after the Huỷ must not resurrect the utterance either.
    speech.emit('câu không muốn gửi', isFinal: true);
    await tester.pumpAndSettle();
    expect(rec.paths, isEmpty);
  });

  // ─── B4: one utterance, one request, whatever the order ────────────────
  testWidgets('B4a ON + duplicate final → exactly one /ask', (tester) async {
    final speech = _FakeSpeech();
    final rec = _Recorder();
    await _pumpVoiceFirst(tester, speech: speech, rec: rec);

    await tester.tap(find.byKey(_voiceMic));
    await tester.pumpAndSettle();
    speech.emit('chị Lan còn nợ bao nhiêu', isFinal: true);
    speech.emit('chị Lan còn nợ bao nhiêu', isFinal: true);
    await tester.pumpAndSettle();

    expect(rec.paths, ['/ask']);
  });

  testWidgets('B4b ON + final then tap-to-stop → at most one /ask',
      (tester) async {
    final speech = _FakeSpeech();
    final rec = _Recorder();
    await _pumpVoiceFirst(tester, speech: speech, rec: rec);

    await tester.tap(find.byKey(_voiceMic));
    await tester.pumpAndSettle();
    speech.emit('chị Lan còn nợ bao nhiêu', isFinal: true);
    await tester.pump(); // no settle: the tap lands inside the send
    // After the final the session is already closing, so the CTA is idle again
    // and this tap is the user tapping "stop" a beat too late.
    await tester.tap(find.byKey(_voiceMic));
    await tester.pumpAndSettle();

    expect(rec.paths.length, 1,
        reason: 'one utterance ⇒ one request, however the taps land');
    expect(rec.paths.single, '/ask');
  });

  testWidgets('B4c ON + two stop/final orders → one request each session',
      (tester) async {
    final speech = _FakeSpeech();
    final rec = _Recorder();
    await _pumpVoiceFirst(tester, speech: speech, rec: rec);

    // Session 1: stop first, final flushed after.
    await tester.tap(find.byKey(_voiceMic));
    await tester.pumpAndSettle();
    speech.emit('câu một');
    await tester.pump();
    await tester.tap(find.byKey(_voiceMic));
    await tester.pumpAndSettle();
    speech.flushAfterStop('câu một hoàn chỉnh');
    await tester.pumpAndSettle();
    expect(rec.paths, ['/ask']);

    // Session 2: a new utterance may send again (the flag is per session).
    await tester.tap(find.byKey(_voiceMic));
    await tester.pumpAndSettle();
    speech.emit('câu hai', isFinal: true);
    await tester.pumpAndSettle();

    expect(rec.paths, ['/ask', '/ask']);
    expect(rec.bodies.last['text'], 'câu hai');
  });

  // ─── B5: a write-shaped partial is never sent unreviewed ───────────────
  testWidgets('B5 ON + write-shaped partial, no final, tap-stop → no send',
      (tester) async {
    final speech = _FakeSpeech();
    final rec = _Recorder();
    await _pumpVoiceFirst(tester, speech: speech, rec: rec);

    await tester.tap(find.byKey(_voiceMic));
    await tester.pumpAndSettle();
    // Partial only: the engine swallowed the final (B0's stop path).
    speech.emit('thu tiền chị Lan 2 triệu');
    await tester.pump();

    await tester.tap(find.byKey(_voiceMic));
    await tester.pumpAndSettle();

    expect(rec.paths, isEmpty,
        reason: 'an unreviewed payment sentence must never auto-send');
    expect(_fieldText(tester), 'thu tiền chị Lan 2 triệu',
        reason: 'the text stays for the user to check and send by hand');
  });

  testWidgets('B5b ON + read-shaped partial, no final, tap-stop → sends once',
      (tester) async {
    final speech = _FakeSpeech();
    final rec = _Recorder();
    await _pumpVoiceFirst(tester, speech: speech, rec: rec);

    await tester.tap(find.byKey(_voiceMic));
    await tester.pumpAndSettle();
    speech.emit('chị Lan còn nợ bao nhiêu');
    await tester.pump();

    await tester.tap(find.byKey(_voiceMic));
    await tester.pumpAndSettle();

    expect(rec.paths, ['/ask'],
        reason: 'the guard must block write-shaped text ONLY');
  });

  testWidgets('B5c ON + write sentence WITH a final is unaffected',
      (tester) async {
    final speech = _FakeSpeech();
    final rec = _Recorder();
    await _pumpVoiceFirst(tester, speech: speech, rec: rec);

    await tester.tap(find.byKey(_voiceMic));
    await tester.pumpAndSettle();
    speech.emit('thu tiền chị Lan 2 triệu', isFinal: true);
    await tester.pumpAndSettle();

    expect(rec.paths, ['/ask'],
        reason: 'a final result is a complete sentence — pre-B1 behaviour');
    expect(rec.paths.any((p) => p.contains('execute')), isFalse,
        reason: 'auto-send can only ever ask');
    expect(find.byType(AlertDialog), findsNothing,
        reason: 'dictation never raises a confirm dialog on its own');
  });

  // ─── The 25s cap is NOT a "nói xong" ───────────────────────────────────
  testWidgets('cap ON: 25s cap keeps the words and does NOT auto-send',
      (tester) async {
    final speech = _FakeSpeech();
    final rec = _Recorder();
    await _pumpVoiceFirst(tester, speech: speech, rec: rec);

    await tester.tap(find.byKey(_voiceMic));
    await tester.pumpAndSettle();
    speech.emit('chị Lan còn nợ bao nhiêu');
    await tester.pump();

    await tester.pump(const Duration(seconds: 26));
    await tester.pumpAndSettle();

    expect(speech.stopCount, 1);
    expect(speech.cancelCount, 0);
    expect(rec.paths, isEmpty,
        reason: 'a timer expiring is not the shopkeeper saying "xong rồi"');
    expect(_fieldText(tester), 'chị Lan còn nợ bao nhiêu');
  });

  // ─── B1 review findings: the corners the first pass missed ──────────────

  testWidgets('R1 ON + NO speech at all + tap-stop → nothing is sent',
      (tester) async {
    final speech = _FakeSpeech();
    final rec = _Recorder();
    await _pumpVoiceFirst(tester, speech: speech, rec: rec);

    // Text typed by hand BEFORE the mic — not dictated, not spoken.
    await tester.enterText(find.byType(TextField), 'chị Lan còn nợ bao nhiêu');
    await tester.tap(find.byKey(_voiceMic));
    await tester.pumpAndSettle();
    // The recognizer never produces a single result (no speech, or a dead mic).
    await tester.tap(find.byKey(_voiceMic));
    await tester.pumpAndSettle();

    expect(rec.paths, isEmpty,
        reason: 'toggling the mic on and off is not "nói xong" — the field is '
            'evidence of typing, not of speech');
    expect(_fieldText(tester), 'chị Lan còn nợ bao nhiêu',
        reason: 'the typed text must stay exactly where the user left it');
  });

  testWidgets('R2 ON + Huỷ, then a NEW dictation still sends', (tester) async {
    final speech = _FakeSpeech();
    final rec = _Recorder();
    await _pumpVoiceFirst(tester, speech: speech, rec: rec);

    await tester.tap(find.byKey(_voiceMic));
    await tester.pumpAndSettle();
    speech.emit('câu bỏ đi');
    await tester.pump();
    await tester.tap(find.byKey(_cancelDictation));
    await tester.pumpAndSettle();
    expect(rec.paths, isEmpty);

    // «at most once» is scoped to ONE dictation, never to the screen: after a
    // Huỷ the next utterance must still be able to send.
    await tester.tap(find.byKey(_voiceMic));
    await tester.pumpAndSettle();
    speech.emit('chị Lan còn nợ bao nhiêu', isFinal: true);
    await tester.pumpAndSettle();

    expect(rec.paths, ['/ask'],
        reason: 'a cancelled dictation must not mute the NEXT one');
  });

  testWidgets('R3 ON + pre-typed WRITE text + no speech + stop → no send',
      (tester) async {
    final speech = _FakeSpeech();
    final rec = _Recorder();
    await _pumpVoiceFirst(tester, speech: speech, rec: rec);

    await tester.enterText(find.byType(TextField), 'thu tiền chị Lan 2 triệu');
    await tester.tap(find.byKey(_voiceMic));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(_voiceMic));
    await tester.pumpAndSettle();

    expect(rec.paths, isEmpty);
    expect(_fieldText(tester), 'thu tiền chị Lan 2 triệu');
  });

  testWidgets('R4 ON + typed prefix + dictated partial → the FIELD is sent',
      (tester) async {
    final speech = _FakeSpeech();
    final rec = _Recorder();
    await _pumpVoiceFirst(tester, speech: speech, rec: rec);

    await tester.enterText(find.byType(TextField), 'cho khách');
    await tester.tap(find.byKey(_voiceMic));
    await tester.pumpAndSettle();
    speech.emit('chị Lan');
    await tester.pump();
    await tester.tap(find.byKey(_voiceMic));
    await tester.pumpAndSettle();

    // Dictation runs MID-EDIT (P6): the transcript is appended to what the user
    // already typed, and that is the sentence the shop will read back.
    expect(rec.paths, ['/ask']);
    expect(rec.bodies.single['text'], 'cho khách chị Lan',
        reason: 'the whole field goes out, not only the transcript');
  });

  // ─── B4 guard interplay: an in-flight request still absorbs a second ────
  testWidgets('B4d ON: a final while the previous auto-send is in flight',
      (tester) async {
    final speech = _FakeSpeech();
    final rec = _Recorder();
    await _pumpVoiceFirst(tester, speech: speech, rec: rec);

    await tester.tap(find.byKey(_voiceMic));
    await tester.pumpAndSettle();
    rec.gate = Completer<void>();
    speech.emit('câu thứ nhất', isFinal: true);
    await tester.pump();
    speech.emit('câu thứ hai', isFinal: true);
    await tester.pump();

    rec.gate!.complete();
    rec.gate = null;
    await tester.pumpAndSettle();

    expect(rec.paths, ['/ask']);
    expect(rec.bodies.single['text'], 'câu thứ nhất');
  });
}
