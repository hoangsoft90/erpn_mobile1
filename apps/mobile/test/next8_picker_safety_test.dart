import 'dart:convert';
import 'dart:typed_data';

import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:erpn_mobile/app/providers.dart';
import 'package:erpn_mobile/features/chat/application/chat_controller.dart';
import 'package:erpn_mobile/features/chat/data/chat_models.dart';
import 'package:erpn_mobile/features/chat/data/copilot_api_client.dart';
import 'package:erpn_mobile/features/chat/presentation/widgets/entity_picker.dart';

/// next8 (D2) — picker safety on the CLIENT side:
///
///   T15  a double tap on a chip races ONE decision, not two /ask calls —
///        the `_pickingId` guard (already shipped with the widget) is pinned
///        here so it can never silently regress.
///   T16  a picker held open longer than the pending-selection TTL
///        (ChatTurn.entityPickTtl, ~5m like the server) no longer acts:
///        - `awaitingEntityPick` goes false (the stale chips leave the screen),
///        - a tap that still reaches the widget sends NOTHING and says why,
///        - a FRESH picker is never blocked by the guard.
///
/// The oracle is the request body of the Dio the client actually uses (the
/// shared-Dio rule: a recorder on a different Dio proves nothing — result77).
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

class _Recorder {
  final List<String> paths = [];
  final List<Map<String, dynamic>> bodies = [];

  Handler get handler => (options) async {
        final raw = options.data;
        final body = raw is String
            ? jsonDecode(raw) as Map<String, dynamic>
            : (raw as Map<String, dynamic>? ?? const {});
        paths.add(options.path);
        bodies.add(body);
        return _json(const {
          'ok': true,
          'result': {
            'question': 'nhà cung cấp tiên',
            'answer': 'Nhà cung cấp: Hà Tiên (SUP-HATIEN)',
          },
        });
      };
}

ResponseBody _json(Object body, [int status = 200]) => ResponseBody.fromString(
      jsonEncode(body),
      status,
      headers: {
        Headers.contentTypeHeader: [Headers.jsonContentType],
      },
    );

Future<ProviderContainer> _container(_Recorder rec) async {
  final container = ProviderContainer(
    overrides: [
      sharedPreferencesProvider.overrideWithValue(null),
      copilotApiClientProvider.overrideWithValue(
        CopilotApiClient(
          dio: Dio(BaseOptions(baseUrl: 'http://mock.local'))
            ..httpClientAdapter = _MockAdapter(rec.handler),
        ),
      ),
    ],
  );
  addTearDown(container.dispose);
  container.listen(chatControllerProvider, (_, _) {}, fireImmediately: true);
  await container.read(chatControllerProvider.future);
  return container;
}

ChatTurn _turn({required DateTime ts}) => ChatTurn(
      question: 'nhà cung cấp tiên',
      answer: 'tên khớp nhiều kết quả',
      ok: false,
      ts: ts,
      candidates: const [
        EntityCandidate(id: 'SUP-HATIEN', name: 'Hà Tiên', label: 'Hà Tiên (SUP-HATIEN)'),
        EntityCandidate(id: 'SUP-HATIEN-2', name: 'Hà Tiên 2', label: 'Hà Tiên 2 (SUP-HATIEN-2)'),
        EntityCandidate(id: 'SUP-BAY', name: 'Anh Bảy', label: 'Anh Bảy (SUP-BAY)'),
      ],
    );

Widget _host(ProviderContainer container, ChatTurn turn) =>
    UncontrolledProviderScope(
      container: container,
      child: MaterialApp(
        home: Scaffold(
          body: EntityPicker(
            candidates: turn.candidates,
            question: turn.question,
            createdAt: turn.ts,
          ),
        ),
      ),
    );

void main() {
  test('next8 T15: a DOUBLE pickEntity call sends exactly ONE /ask', () async {
    final rec = _Recorder();
    final container = await _container(rec);
    final controller = container.read(chatControllerProvider.notifier);

    // The first call is NOT awaited: both must be in flight together for the
    // guard to be exercised at all.
    final first = controller.pickEntity(
      const EntityCandidate(id: 'SUP-HATIEN', name: 'Hà Tiên'),
      question: 'nhà cung cấp tiên',
    );
    final second = controller.pickEntity(
      const EntityCandidate(id: 'SUP-HATIEN', name: 'Hà Tiên'),
      question: 'nhà cung cấp tiên',
    );
    await first;
    await second;

    expect(rec.paths, ['/ask']);
    expect(rec.paths.length, 1,
        reason: 'T15: one decision, one request — the double tap must not '
            'race a second /ask with the same entity');
    expect(rec.bodies.single['entity_id'], 'SUP-HATIEN');
  });

  testWidgets('next8 T15: tapping a chip twice in the widget posts ONE /ask',
      (tester) async {
    final rec = _Recorder();
    final container = await _container(rec);

    await tester.pumpWidget(_host(container, _turn(ts: DateTime.now())));

    await tester.tap(find.byType(ActionChip).first);
    await tester.pump();
    // Second tap while the first is in flight: every chip is disabled
    // (onPressed: null) once _pickingId is set.
    await tester.tap(find.byType(ActionChip).first, warnIfMissed: false);
    await tester.pump(const Duration(milliseconds: 50));

    expect(rec.paths.length, 1,
        reason: 'T15: the widget guard turns the second tap into a no-op');
    expect(rec.bodies.single['entity_id'], 'SUP-HATIEN');
  });

  test('next8 T16: a picker past its TTL is no longer awaiting a pick', () {
    final fresh = _turn(ts: DateTime.now());
    final expired =
        _turn(ts: DateTime.now().subtract(const Duration(minutes: 6)));

    expect(fresh.awaitingEntityPick, isTrue,
        reason: 'a fresh picker still waits for the user');
    expect(expired.awaitingEntityPick, isFalse,
        reason: 'T16: past the ~5m TTL the chips can no longer resume anything '
            '(the server pending context has expired)');
  });

  testWidgets(
      'next8 T16: a tap on a held-open picker sends NOTHING and says why',
      (tester) async {
    final rec = _Recorder();
    final container = await _container(rec);
    final expired =
        _turn(ts: DateTime.now().subtract(const Duration(minutes: 6)));

    await tester.pumpWidget(_host(container, expired));

    await tester.tap(find.byType(ActionChip).first);
    await tester.pumpAndSettle();

    expect(rec.paths, isEmpty,
        reason: 'T16: hết hạn + tap → báo, KHÔNG chạy query cũ (plan §5)');
    expect(find.byType(SnackBar), findsOneWidget);
    expect(
      find.text('Lựa chọn đã hết hạn — hỏi lại để nhận danh sách mới.'),
      findsOneWidget,
    );
  });

  testWidgets(
      'next8 T16: a FRESH picker still sends on tap (guard never over-blocks)',
      (tester) async {
    final rec = _Recorder();
    final container = await _container(rec);

    await tester.pumpWidget(_host(container, _turn(ts: DateTime.now())));

    await tester.tap(find.byType(ActionChip).first);
    await tester.pump(const Duration(milliseconds: 50));

    expect(rec.paths, ['/ask'],
        reason: 'the TTL guard must never block a live decision');
    expect(rec.bodies.single['entity_id'], 'SUP-HATIEN');
  });
}
