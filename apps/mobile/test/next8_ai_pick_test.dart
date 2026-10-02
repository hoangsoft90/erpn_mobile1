import 'dart:convert';
import 'dart:typed_data';

import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:erpn_mobile/app/providers.dart';
import 'package:erpn_mobile/features/chat/application/chat_controller.dart';
import 'package:erpn_mobile/features/chat/data/chat_models.dart';
import 'package:erpn_mobile/features/chat/data/copilot_api_client.dart';

/// next8 (F1) — the AI-mode picker carries the picked id to `/dsh/ask`.
///
/// Pins the wire contract the server now consumes (D0 F1: the id used to be
/// dropped at BOTH layers — the controller never forwarded it in DSH mode and
/// `dshAsk` had no parameter for it):
///
///   1. `pickEntity` in AI mode posts `/dsh/ask` with the SAME message AND
///      `entity_id` — the id is a hint the server re-validates.
///   2. A TYPED AI-mode question sends NO `entity_id` (the field is the
///      picker's, never a general input).
///   3. Normal mode keeps posting `/ask` with `entity_id` (P1 contract
///      unchanged — guard against overreach).
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

void main() {
  test('next8 F1: pickEntity in AI mode posts /dsh/ask WITH entity_id', () async {
    final rec = _Recorder();
    final container = await _container(rec);
    final controller = container.read(chatControllerProvider.notifier);
    controller.setMode(ChatMode.dsh);

    await controller.pickEntity(
      const EntityCandidate(id: 'SUP-HATIEN', name: 'Hà Tiên'),
      question: 'nhà cung cấp tiên',
    );

    expect(rec.paths, ['/dsh/ask'], reason: 'AI mode stays on the AI route');
    expect(rec.bodies.single['message'], 'nhà cung cấp tiên',
        reason: 'the pick re-asks the SAME sentence — intent must not drift');
    expect(rec.bodies.single['entity_id'], 'SUP-HATIEN',
        reason: 'THE FIX: the picked id reaches the AI route as a hint');
    expect(rec.bodies.single.containsKey('submit_now'), isFalse,
        reason: 'the AI route input surface gains NOTHING except the pick id');
  });

  test('next8 F1: a TYPED AI-mode question sends NO entity_id', () async {
    final rec = _Recorder();
    final container = await _container(rec);
    final controller = container.read(chatControllerProvider.notifier);
    controller.setMode(ChatMode.dsh);

    await controller.send('nhà cung cấp tiên');

    expect(rec.paths, ['/dsh/ask']);
    expect(rec.bodies.single.containsKey('entity_id'), isFalse,
        reason: 'entity_id belongs to the picker interaction, not typed input');
  });

  test('next8 F1: normal mode keeps /ask + entity_id (P1 contract unchanged)', () async {
    final rec = _Recorder();
    final container = await _container(rec);
    final controller = container.read(chatControllerProvider.notifier);

    await controller.pickEntity(
      const EntityCandidate(id: 'CUST-00001', name: 'Nguyễn Thị Lan'),
      question: 'công nợ ai đó',
    );

    expect(rec.paths, ['/ask']);
    expect(rec.bodies.single['entity_id'], 'CUST-00001');
    expect(rec.bodies.single.containsKey('submit_now'), isTrue,
        reason: 'the /ask contract keeps its own submit flag');
  });
}
