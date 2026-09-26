import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:erpn_mobile/app/providers.dart';
import 'package:erpn_mobile/core/constants/app_constants.dart';
import 'package:erpn_mobile/core/settings/app_settings_service.dart';
import 'package:erpn_mobile/core/tts/tts_service.dart';
import 'package:erpn_mobile/features/chat/application/chat_controller.dart';
import 'package:erpn_mobile/features/chat/data/chat_history_service.dart';
import 'package:erpn_mobile/features/chat/data/chat_models.dart';
import 'package:erpn_mobile/features/chat/data/copilot_api_client.dart';
import 'package:erpn_mobile/features/chat/presentation/screens/chat_screen.dart';
import 'package:erpn_mobile/features/chat/presentation/widgets/chat_bubble.dart';

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

/// A HIGH payment proposal. The summary deliberately carries a UUID-shaped token
/// (as a future/loose backend payload might) so the sanitizer test proves the
/// read-aloud text really drops identifiers instead of merely never seeing one.
const _paymentProposalResult = {
  'question': 'thu tiền cho chị Lan 100.000',
  'routed': {'group': 'payment_write', 'matched': 'thu tiền'},
  'customer': {'id': 'CUST-001', 'name': 'Nguyễn Thị Lan'},
  'answer': 'Đề xuất thu 100.000đ từ Nguyễn Thị Lan.',
  'proposal': {
    'schema': 'erpn.proposal/v1',
    'action': 'create_payment_entry',
    'risk': 'HIGH',
    'risk_display': {'icon': '⚠️', 'label': 'Cao'},
    'need_confirm': true,
    'need_double_confirm': false,
    'executable': true,
    'entity': {'kind': 'customer', 'id': 'CUST-001', 'name': 'Nguyễn Thị Lan'},
    'summary':
        'Thu 100.000đ từ Nguyễn Thị Lan (mã a1b2c3d4-1111-4222-8333-444455556666)',
    'command_id': 'a1b2c3d4-1111-4222-8333-444455556666',
    'created_at': '2026-09-18T10:00:00.000Z',
    'proposal_id': 'a1b2c3d4-1111-4222-8333-444455556666',
    'version': 1,
    'params': {'amount_vnd': 100000},
  },
};

/// Fake TTS engine: records what the controller asked it to say.
class _RecordingTts implements TtsService {
  final List<String> spoken = <String>[];
  int stopCount = 0;

  @override
  Future<void> speak(String text) async => spoken.add(text);

  @override
  Future<void> stop() async => stopCount++;
}

/// TTS engine that always throws — the chat result must survive it.
class _ThrowingTts implements TtsService {
  @override
  Future<void> speak(String text) async => throw StateError('engine down');

  @override
  Future<void> stop() async {}
}

/// TTS engine that NEVER answers — models a device whose TTS binder is dead or
/// that has no speech engine at all (the init call simply never resolves).
class _HangingTts implements TtsService {
  @override
  Future<void> speak(String text) => Completer<void>().future;

  @override
  Future<void> stop() async {}
}

Future<void> _pumpApp(
  WidgetTester tester, {
  required Handler handler,
  SharedPreferences? prefs,
}) async {
  await tester.pumpWidget(
    ProviderScope(
      overrides: [
        sharedPreferencesProvider.overrideWithValue(prefs),
        copilotApiClientProvider.overrideWithValue(
          CopilotApiClient(
            dio: Dio(BaseOptions(baseUrl: 'http://mock.local'))
              ..httpClientAdapter = _MockAdapter(handler),
          ),
        ),
      ],
      child: const MaterialApp(home: ChatScreen()),
    ),
  );
  await tester.pumpAndSettle();
}

/// Builds a container with a recording TTS engine and every question answered by
/// [result]. Returns the container plus the fake so a test can assert on it.
Future<ProviderContainer> _containerWithTts(
  _RecordingTts tts, {
  Map<String, dynamic> result = _answerResult,
  SharedPreferences? prefs,
  List<Uri>? requests,
}) async {
  final container = ProviderContainer(
    overrides: [
      sharedPreferencesProvider.overrideWithValue(prefs ?? _FakePrefs()),
      ttsServiceProvider.overrideWithValue(tts),
      copilotApiClientProvider.overrideWithValue(
        CopilotApiClient(
          dio: Dio(BaseOptions(baseUrl: 'http://mock.local'))
            ..httpClientAdapter = _MockAdapter((options) async {
              requests?.add(options.uri);
              return _json({'ok': true, 'result': result});
            }),
        ),
      ),
    ],
  );
  addTearDown(container.dispose);
  // Keepalive: without a listener the autoDispose notifier goes away right
  // after read() returns (same pattern as the other controller tests).
  container.listen(chatControllerProvider, (_, _) {}, fireImmediately: true);
  await container.read(chatControllerProvider.future);
  return container;
}

void main() {
  test('cold-start race: send during history load must NOT overwrite storage',
      () async {
    final service = _DelayedHistoryService();
    final container = ProviderContainer(
      overrides: [
        // Settings provider (history cap) needs prefs; null = storage
        // unavailable ⇒ defaults (20).
        sharedPreferencesProvider.overrideWithValue(null),
        chatHistoryServiceProvider.overrideWithValue(service),
        copilotApiClientProvider.overrideWithValue(
          CopilotApiClient(
            dio: Dio(BaseOptions(baseUrl: 'http://mock.local'))
              ..httpClientAdapter = _MockAdapter(
                  (options) async => _json({'ok': true, 'result': _answerResult})),
          ),
        ),
      ],
    );
    addTearDown(container.dispose);

    // Kick off build() (loads history with an artificial delay)…
    container.listen(chatControllerProvider, (_, _) {}, fireImmediately: true);
    // …and send BEFORE the load finishes. Without the isLoading guard the
    // append would treat the state as empty and overwrite stored history.
    final rejected = await container
        .read(chatControllerProvider.notifier)
        .send('câu hỏi mới');
    expect(rejected, isFalse,
        reason: 'send must be refused while history is still loading');

    // After build() completes the same send succeeds…
    await container.read(chatControllerProvider.future);
    final accepted = await container
        .read(chatControllerProvider.notifier)
        .send('câu hỏi mới');
    expect(accepted, isTrue);

    // …and the saved history contains BOTH the loaded turn and the new one.
    final savedQuestions = service.savedTurns.map((t) => t.question);
    expect(savedQuestions, containsAll(<String>['câu hỏi cũ', 'câu hỏi mới']));
  });

  testWidgets('empty state shows example hint', (WidgetTester tester) async {
    await _pumpApp(tester, handler: (options) async => _json({'ok': true}));
    expect(find.textContaining('chị Lan còn nợ bao nhiêu'), findsOneWidget);
    expect(find.byType(ChatBubble), findsNothing);
  });

  testWidgets('send -> answer bubble + route label + input cleared',
      (WidgetTester tester) async {
    await _pumpApp(
      tester,
      handler: (options) async => _json({'ok': true, 'result': _answerResult}),
    );

    await tester.enterText(find.byType(TextField), 'chị Lan còn nợ bao nhiêu');
    await tester.tap(find.byIcon(Icons.send));
    await tester.pumpAndSettle();

    expect(
      // findRichText: the answer bubble is a Markdown renderer, so its text
      // lives in a `Text.rich` span rather than `Text.data`.
      find.text(
        'Nguyễn Thị Lan còn nợ 2.500.000đ (1 chứng từ chưa thanh toán).',
        findRichText: true,
      ),
      findsOneWidget,
    );
    expect(find.text('route: customer'), findsOneWidget);
    // user bubble shows the question
    expect(find.text('chị Lan còn nợ bao nhiêu'), findsOneWidget);
    // input cleared after success
    final field = tester.widget<TextField>(find.byType(TextField));
    expect(field.controller!.text, isEmpty);
  });

  testWidgets('server failure -> SnackBar + typed text kept',
      (WidgetTester tester) async {
    await _pumpApp(
      tester,
      handler: (options) async =>
          _json({'ok': false, 'error': 'missing required field: text'}, 400),
    );

    await tester.enterText(find.byType(TextField), 'câu hỏi bị lỗi');
    await tester.tap(find.byIcon(Icons.send));
    await tester.pump(); // request + state change
    await tester.pump(const Duration(milliseconds: 600)); // snackbar entrance

    expect(find.byType(SnackBar), findsOneWidget);
    expect(find.text('missing required field: text'), findsOneWidget);
    // typed text kept on failure (tasks.md 2.5)
    final field = tester.widget<TextField>(find.byType(TextField));
    expect(field.controller!.text, 'câu hỏi bị lỗi');
  });

  testWidgets('history restored from prefs and clear works',
      (WidgetTester tester) async {
    final prefs = _FakePrefs();
    await prefs.setString('chat_history_v1', jsonEncode([
      {
        'question': 'câu hỏi cũ',
        'answer': 'câu trả lời cũ',
        'ok': true,
        'ts': '2026-09-14T10:00:00.000',
        'routed_group': 'customer',
      }
    ]));

    await _pumpApp(tester, handler: (options) async => _json({'ok': true}), prefs: prefs);
    expect(find.text('câu trả lời cũ', findRichText: true), findsOneWidget);

    // clear via dialog
    await tester.tap(find.byIcon(Icons.delete_outline));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Xóa'));
    await tester.pumpAndSettle();
    expect(find.text('câu trả lời cũ', findRichText: true), findsNothing);
    expect(prefs.store.containsKey('chat_history_v1'), isFalse);
  });

  test('F7-2: the submit setting is read at ASK time and frozen server-side into the proposal', () async {
    final prefs = _FakePrefs();
    final settings = AppSettingsService(prefs: prefs);
    final bodies = <dynamic>[];
    final container = ProviderContainer(
      overrides: [
        sharedPreferencesProvider.overrideWithValue(prefs),
        appSettingsServiceProvider.overrideWithValue(settings),
        copilotApiClientProvider.overrideWithValue(
          CopilotApiClient(
            dio: Dio(BaseOptions(baseUrl: 'http://mock.local'))
              ..httpClientAdapter = _MockAdapter((options) async {
                final d = options.data;
                bodies.add(d is String ? jsonDecode(d) as Map<String, dynamic> : d);
                return _json({'ok': true, 'result': _answerResult});
              }),
          ),
        ),
      ],
    );
    addTearDown(container.dispose);
    // autoDispose: without an active listener the notifier is disposed right
    // after read() returns — same keepalive pattern as the cold-start test.
    container.listen(chatControllerProvider, (_, _) {}, fireImmediately: true);
    await container.read(chatControllerProvider.future);

    // Default OFF travels explicitly on the first question.
    await container.read(chatControllerProvider.notifier).send('chị Lan còn nợ bao nhiêu');
    expect(
      (bodies.last as Map<String, dynamic>)['submit_now'],
      isFalse,
      reason: 'OFF is sent explicitly so the server freezes OFF',
    );

    // Flip the setting (as the Settings screen would after its dialog)…
    final saved = await settings.saveAllowSubmitPayment(true);
    expect(saved, isTrue, reason: 'preflight: the save itself must succeed');
    expect(
      container.read(appSettingsServiceProvider).allowSubmitPayment,
      isTrue,
      reason: 'preflight: the overridden service must read back ON',
    );
    // …and the NEXT question picks it up with no app restart.
    await container.read(chatControllerProvider.notifier).send('chị Lan còn nợ bao nhiêu');
    expect(
      (bodies.last as Map<String, dynamic>)['submit_now'],
      isTrue,
      reason: 'the controller re-reads the setting per send — no restart',
    );
  });

  // ───────────────────────── TTS (plan2 next2) ─────────────────────────────
  // The read-aloud hook lives in ChatController._append() — the ONE place a
  // NEW turn enters the list. These tests pin that boundary, plus the §6 safety
  // rule that being read aloud is never the same as being confirmed.

  group('TTS', () {
    test('ON ⇒ a new answer is read aloud exactly once', () async {
      final prefs = _FakePrefs();
      await prefs.setBool(AppConstants.ttsEnabledStorageKey, true);
      final tts = _RecordingTts();
      final container = await _containerWithTts(tts, prefs: prefs);

      await container
          .read(chatControllerProvider.notifier)
          .send('chị Lan còn nợ bao nhiêu');

      expect(tts.spoken, hasLength(1));
      expect(tts.spoken.single, contains('còn nợ 2.500.000đ'));
    });

    test('OFF (default) ⇒ nothing is ever spoken', () async {
      final tts = _RecordingTts();
      // No key written at all — the absence of the setting must read as OFF.
      final container = await _containerWithTts(tts);

      await container
          .read(chatControllerProvider.notifier)
          .send('chị Lan còn nợ bao nhiêu');

      expect(tts.spoken, isEmpty,
          reason: 'answers stay silent unless the user enabled reading');
    });

    test('restoring history at startup does NOT read old turns aloud',
        () async {
      final prefs = _FakePrefs();
      await prefs.setBool(AppConstants.ttsEnabledStorageKey, true);
      await prefs.setString(
        'chat_history_v1',
        jsonEncode([
          {
            'question': 'câu hỏi cũ',
            'answer': 'câu trả lời cũ',
            'ok': true,
            'ts': '2026-09-14T10:00:00.000',
          }
        ]),
      );
      final tts = _RecordingTts();
      final container = await _containerWithTts(tts, prefs: prefs);

      expect(container.read(chatControllerProvider).value!.turns, isNotEmpty,
          reason: 'preflight: the old history really did load');
      expect(tts.spoken, isEmpty,
          reason: 'opening the app must not replay the whole conversation');
    });

    test('attachRejection() stamps an existing card WITHOUT speaking',
        () async {
      final prefs = _FakePrefs();
      await prefs.setBool(AppConstants.ttsEnabledStorageKey, true);
      final tts = _RecordingTts();
      final container = await _containerWithTts(
        tts,
        prefs: prefs,
        result: _paymentProposalResult,
      );

      await container
          .read(chatControllerProvider.notifier)
          .send('thu tiền cho chị Lan 100.000');
      expect(tts.spoken, hasLength(1),
          reason: 'preflight: the new proposal was read aloud');
      final proposal =
          container.read(chatControllerProvider).value!.turns.last.proposal!;
      tts.spoken.clear();

      await container.read(chatControllerProvider.notifier).attachRejection(
            proposal,
            code: 'PROPOSAL_STALE',
            problems: const ['Nợ đã thay đổi'],
          );

      expect(tts.spoken, isEmpty,
          reason: 'a refusal modifies an old card — it is not a new answer');
    });

    test('identifier-shaped tokens and markup never reach the engine',
        () async {
      final prefs = _FakePrefs();
      await prefs.setBool(AppConstants.ttsEnabledStorageKey, true);
      final tts = _RecordingTts();
      final container = await _containerWithTts(
        tts,
        prefs: prefs,
        result: _paymentProposalResult,
      );

      await container
          .read(chatControllerProvider.notifier)
          .send('thu tiền cho chị Lan 100.000');

      final spoken = tts.spoken.single;
      expect(spoken,
          isNot(contains('a1b2c3d4-1111-4222-8333-444455556666')),
          reason: 'command_id / proposal_id must never be spelled out');
      expect(spoken, 'Đề xuất thu 100.000đ từ Nguyễn Thị Lan.',
          reason: 'exactly the answer is spoken — the card adds nothing');

      // These assert the SOURCE is prose, not that a later filter saved us.
      // The UUID check above alone is satisfied by the defensive stripper, so
      // on its own it never fails when the spoken text is built from raw
      // machine data — the leak would just be silently scrubbed. Verified by
      // falsification C: feeding proposal.toJson() through left the UUID
      // assertion GREEN, which is why these shape checks exist.
      for (final noise in const ['{', '}', 'schema', 'params', 'risk_display']) {
        expect(spoken, isNot(contains(noise)),
            reason: 'internal payload shape "$noise" must never be spoken');
      }
    });

    test('the proposal card is NOT read aloud — only the answer is', () async {
      // User decision (2026-09-20, .plan/next2/tts-scope-and-markdown.md §1):
      // the card is a structured block the user studies with their own eyes to
      // decide, so the summary must not be spoken as well. The summary here is
      // worded so it shares NOTHING with the answer — otherwise this test could
      // pass just because the two texts happened to be near-identical.
      const result = {
        'question': 'thu tiền cho chị Lan 100.000',
        'routed': {'group': 'payment_write', 'matched': 'thu tiền'},
        'customer': {'id': 'CUST-001', 'name': 'Nguyễn Thị Lan'},
        'answer': 'Đã chuẩn bị đề xuất thu tiền.',
        'proposal': {
          'schema': 'erpn.proposal/v1',
          'action': 'create_payment_entry',
          'risk': 'HIGH',
          'risk_display': {'icon': '⚠️', 'label': 'Cao'},
          'need_confirm': true,
          'executable': true,
          'summary': 'TỔNG CẦN THU 100.000đ từ Nguyễn Thị Lan',
          'command_id': 'a1b2c3d4-1111-4222-8333-444455556666',
          'params': {'amount_vnd': 100000},
        },
      };
      final prefs = _FakePrefs();
      await prefs.setBool(AppConstants.ttsEnabledStorageKey, true);
      final tts = _RecordingTts();
      final container =
          await _containerWithTts(tts, prefs: prefs, result: result);

      await container
          .read(chatControllerProvider.notifier)
          .send('thu tiền cho chị Lan 100.000');

      expect(tts.spoken.single, 'Đã chuẩn bị đề xuất thu tiền.',
          reason: 'the answer is what gets read');
      expect(tts.spoken.single, isNot(contains('TỔNG CẦN THU')),
          reason: 'the proposal card is read with the eyes, not the ears');
    });

    test('a turn with NO text at all is not spoken (no dead-air utterance)',
        () async {
      final prefs = _FakePrefs();
      await prefs.setBool(AppConstants.ttsEnabledStorageKey, true);
      final tts = _RecordingTts();
      final container = await _containerWithTts(
        tts,
        prefs: prefs,
        result: const {'question': 'chị Lan còn nợ bao nhiêu'},
      );

      await container
          .read(chatControllerProvider.notifier)
          .send('chị Lan còn nợ bao nhiêu');

      expect(tts.spoken, isEmpty);
    });

    test('what the user READS is what gets spoken (a reason refusals too)',
        () async {
      // A refusal carries its own user-facing `reason`, which the bubble shows;
      // reading exactly that text is the point of the feature (the user may be
      // looking at the customer, not the phone). Pinned so the two sources
      // cannot silently drift apart.
      final prefs = _FakePrefs();
      await prefs.setBool(AppConstants.ttsEnabledStorageKey, true);
      final tts = _RecordingTts();
      final container = await _containerWithTts(
        tts,
        prefs: prefs,
        result: const {
          'question': 'chị Lan còn nợ bao nhiêu',
          'reason': 'Không tìm thấy khách hàng',
        },
      );

      await container
          .read(chatControllerProvider.notifier)
          .send('chị Lan còn nợ bao nhiêu');

      expect(tts.spoken.single, 'Không tìm thấy khách hàng');
    });

    test('picking a candidate re-asks, and THAT new answer IS read', () async {
      final prefs = _FakePrefs();
      await prefs.setBool(AppConstants.ttsEnabledStorageKey, true);
      final tts = _RecordingTts();
      var call = 0;
      final container = ProviderContainer(
        overrides: [
          sharedPreferencesProvider.overrideWithValue(prefs),
          ttsServiceProvider.overrideWithValue(tts),
          copilotApiClientProvider.overrideWithValue(
            CopilotApiClient(
              dio: Dio(BaseOptions(baseUrl: 'http://mock.local'))
                ..httpClientAdapter = _MockAdapter((options) async {
                  call++;
                  return _json({
                    'ok': true,
                    'result': call == 1
                        ? const {
                            'question': 'chị Lan còn nợ bao nhiêu',
                            'error_code': 'ENTITY_PICK_REQUIRED',
                            'candidates': [
                              {'id': 'CUST-001', 'name': 'Nguyễn Thị Lan'}
                            ],
                          }
                        : _answerResult,
                  });
                }),
            ),
          ),
        ],
      );
      addTearDown(container.dispose);
      container.listen(chatControllerProvider, (_, _) {}, fireImmediately: true);
      await container.read(chatControllerProvider.future);

      await container
          .read(chatControllerProvider.notifier)
          .send('chị Lan còn nợ bao nhiêu');
      expect(tts.spoken, isEmpty,
          reason: 'a picker prompt carries no answer to read');

      await container.read(chatControllerProvider.notifier).pickEntity(
            const EntityCandidate(id: 'CUST-001', name: 'Nguyễn Thị Lan'),
            question: 'chị Lan còn nợ bao nhiêu',
          );
      expect(tts.spoken, hasLength(1),
          reason: 'the resolved answer is genuinely new');
    });

    test('a broken engine never turns a good answer into a failed send',
        () async {
      final prefs = _FakePrefs();
      await prefs.setBool(AppConstants.ttsEnabledStorageKey, true);
      final container = ProviderContainer(
        overrides: [
          sharedPreferencesProvider.overrideWithValue(prefs),
          ttsServiceProvider.overrideWithValue(_ThrowingTts()),
          copilotApiClientProvider.overrideWithValue(
            CopilotApiClient(
              dio: Dio(BaseOptions(baseUrl: 'http://mock.local'))
                ..httpClientAdapter = _MockAdapter(
                    (options) async =>
                        _json({'ok': true, 'result': _answerResult})),
            ),
          ),
        ],
      );
      addTearDown(container.dispose);
      container.listen(chatControllerProvider, (_, _) {}, fireImmediately: true);
      await container.read(chatControllerProvider.future);

      final ok = await container
          .read(chatControllerProvider.notifier)
          .send('chị Lan còn nợ bao nhiêu');

      expect(ok, isTrue, reason: 'reading aloud is not part of the result');
      final state = container.read(chatControllerProvider).value!;
      expect(state.lastError, isNull);
      expect(state.turns, hasLength(1),
          reason: 'the answer was recorded and kept');
    });

    test('a TTS engine that never answers must NOT hold the send open',
        () async {
      // The chat clears its input field when send() returns true. If reading
      // aloud is awaited, a hung engine makes send() never return and the user
      // is left with text in the box after a question that actually succeeded —
      // a stuck UI caused by an optional courtesy.
      final prefs = _FakePrefs();
      await prefs.setBool(AppConstants.ttsEnabledStorageKey, true);
      final container = ProviderContainer(
        overrides: [
          sharedPreferencesProvider.overrideWithValue(prefs),
          ttsServiceProvider.overrideWithValue(_HangingTts()),
          copilotApiClientProvider.overrideWithValue(
            CopilotApiClient(
              dio: Dio(BaseOptions(baseUrl: 'http://mock.local'))
                ..httpClientAdapter = _MockAdapter(
                    (options) async =>
                        _json({'ok': true, 'result': _answerResult})),
            ),
          ),
        ],
      );
      addTearDown(container.dispose);
      container.listen(chatControllerProvider, (_, _) {}, fireImmediately: true);
      await container.read(chatControllerProvider.future);

      final ok = await container
          .read(chatControllerProvider.notifier)
          .send('chị Lan còn nợ bao nhiêu')
          .timeout(const Duration(seconds: 2));

      expect(ok, isTrue, reason: 'audio must never gate the chat result');
      expect(container.read(chatControllerProvider).value!.turns, hasLength(1),
          reason: 'the answer was recorded regardless of the engine');
    });

    testWidgets(
        '§6 safety: a HIGH proposal is READ aloud and NOT confirmed',
        (tester) async {
      final prefs = _FakePrefs();
      await prefs.setBool(AppConstants.ttsEnabledStorageKey, true);
      final tts = _RecordingTts();
      final requests = <Uri>[];
      // Built inline (not via _pumpApp) because the fake engine has to be
      // injected: `Override` is not part of flutter_riverpod's public export,
      // so the scope is spelled out here rather than passed as a list.
      //
      // `dioProvider` is the one overridden here, NOT `copilotApiClientProvider`:
      // ProposalCard posts /execute through dioProvider directly, so a recording
      // adapter attached to the api client's own Dio would be blind to a real
      // confirm — the assertion would hold no matter what the card did
      // (falsification E proved exactly that: an injected auto-confirm left
      // this test GREEN). Overriding the shared Dio makes /ask and /execute
      // observable through the same recorder.
      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            sharedPreferencesProvider.overrideWithValue(prefs),
            ttsServiceProvider.overrideWithValue(tts),
            dioProvider.overrideWithValue(
              Dio(BaseOptions(baseUrl: 'http://mock.local'))
                ..httpClientAdapter = _MockAdapter((options) async {
                  requests.add(options.uri);
                  return _json({'ok': true, 'result': _paymentProposalResult});
                }),
            ),
          ],
          child: const MaterialApp(home: ChatScreen()),
        ),
      );
      await tester.pumpAndSettle();

      await tester.enterText(
          find.byType(TextField), 'thu tiền cho chị Lan 100.000');
      await tester.tap(find.byIcon(Icons.send));
      await tester.pumpAndSettle();

      expect(tts.spoken.single, 'Đề xuất thu 100.000đ từ Nguyễn Thị Lan.',
          reason: 'the answer is announced; the card is left to the eyes');
      expect(
        requests.where((u) => u.path.contains('execute')),
        isEmpty,
        reason: 'reading a proposal must never press its confirm button',
      );
      expect(find.text('Xác nhận thu tiền'), findsOneWidget,
          reason: 'the confirm affordance is still there, waiting for a tap');
    });
  });
}

/// History service whose load() is delayed — reproduces the cold-start window
/// where build() has not resolved yet. Captures save() calls for assertions.
class _DelayedHistoryService extends ChatHistoryService {
  _DelayedHistoryService() : super(prefs: null);

  List<ChatTurn> savedTurns = const [];

  @override
  Future<List<ChatTurn>> load() async {
    await Future<void>.delayed(const Duration(milliseconds: 50));
    return [
      ChatTurn(
        question: 'câu hỏi cũ',
        answer: 'câu trả lời cũ',
        ok: true,
        ts: DateTime.parse('2026-09-14T10:00:00.000'),
      ),
    ];
  }

  @override
  Future<void> save(List<ChatTurn> turns, {int? maxItems}) async {
    savedTurns = turns;
  }
}

/// Minimal SharedPreferences fake (no plugin channel in unit tests).
class _FakePrefs implements SharedPreferences {
  final Map<String, Object> store = {};

  @override
  dynamic noSuchMethod(Invocation invocation) {
    if (invocation.memberName == #getString &&
        invocation.positionalArguments.length == 1) {
      return store[invocation.positionalArguments.first as String];
    }
    if (invocation.memberName == #setString &&
        invocation.positionalArguments.length == 2) {
      store[invocation.positionalArguments[0] as String] =
          invocation.positionalArguments[1] as Object;
      return Future<bool>.value(true);
    }
    if (invocation.memberName == #getBool &&
        invocation.positionalArguments.length == 1) {
      return store[invocation.positionalArguments.first as String] as bool?;
    }
    if (invocation.memberName == #setBool &&
        invocation.positionalArguments.length == 2) {
      store[invocation.positionalArguments[0] as String] =
          invocation.positionalArguments[1] as Object;
      return Future<bool>.value(true);
    }
    if (invocation.memberName == #remove &&
        invocation.positionalArguments.length == 1) {
      store.remove(invocation.positionalArguments.first as String);
      return Future<bool>.value(true);
    }
    return null; // unimplemented members return null like mocks would
  }
}
