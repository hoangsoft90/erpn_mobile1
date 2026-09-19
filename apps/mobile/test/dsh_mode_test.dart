import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:erpn_mobile/app/providers.dart';
import 'package:erpn_mobile/features/chat/data/copilot_api_client.dart';
import 'package:erpn_mobile/features/chat/presentation/screens/chat_screen.dart';
import 'package:erpn_mobile/features/chat/presentation/widgets/proposal_card.dart';

/// DSH mode (`.plan/dsh_end_to_end.md` C1–C3).
///
/// The properties these tests defend:
///  1. **Explicit only.** Normal mode is the default and NOTHING in the app can
///     switch modes on its own — only a tap on the segment. AI mode never
///     becomes a fallback for a question the deterministic path could not
///     answer (plan §12).
///  2. **Separate wire.** Normal sends `POST /ask`; AI mode sends
///     `POST /dsh/ask` with a conversation id. The two never mix.
///  3. **Read-only by construction.** The DSH path renders no proposal card and
///     never reaches `/execute`.
///
/// The oracle is the request log of the Dio the CLIENT actually uses
/// (result56 §5: a recorder attached to a different Dio proves nothing).

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

const _askResult = {
  'question': 'chị Lan còn nợ bao nhiêu',
  'routed': {'group': 'customer', 'matched': 'còn nợ'},
  'customer': {'id': 'CUST-001', 'name': 'Nguyễn Thị Lan'},
  'outstanding_vnd': 2500000,
  'open_invoices': 1,
  'answer': 'Nguyễn Thị Lan còn nợ 2.500.000đ (1 chứng từ chưa thanh toán).',
};

/// Records every request and answers each path with its OWN envelope, so a test
/// can tell the two pipelines apart by the path that was actually called.
class _Router {
  final List<String> paths = [];
  final List<Map<String, dynamic>> bodies = [];

  /// Holds the response open — the only way a widget test can observe the
  /// in-flight frame (an immediately-returning mock skips straight past it).
  Completer<void>? gate;

  /// When set, `/dsh/ask` answers with this body + [errorStatus] (gateway
  /// refusals are 502 with a real Vietnamese message and a machine code).
  Map<String, Object>? errorBody;
  int errorStatus = 502;

  String dshAnswer =
      'Khách smoke 2026-09-15-p1b-wf1-2 hiện còn nợ 171.800đ (4 chứng từ).';

  Handler get handler => (options) async {
        final raw = options.data;
        final body = raw is String
            ? jsonDecode(raw) as Map<String, dynamic>
            : (raw as Map<String, dynamic>? ?? const {});
        if (gate != null) await gate!.future;
        paths.add(options.path);
        bodies.add(body);
        if (options.path == '/dsh/ask') {
          final err = errorBody;
          if (err != null) return _json(err, errorStatus);
          return _json({
            'ok': true,
            'mode': 'dsh',
            'conversation_id': body['conversation_id'],
            'request_id': 'req-dsh-1',
            'dsh_session_id': 'sess-dsh-1',
            'erpnext_target': 'REAL',
            'result': {'answer': dshAnswer},
          });
        }
        return _json({'ok': true, 'result': _askResult});
      };
}

Future<void> _pumpChat(WidgetTester tester, _Router router) async {
  await tester.pumpWidget(
    ProviderScope(
      overrides: [
        sharedPreferencesProvider.overrideWithValue(null),
        copilotApiClientProvider.overrideWithValue(
          CopilotApiClient(
            dio: Dio(BaseOptions(baseUrl: 'http://mock.local'))
              ..httpClientAdapter = _MockAdapter(router.handler),
          ),
        ),
      ],
      child: const MaterialApp(home: ChatScreen()),
    ),
  );
  await tester.pumpAndSettle();
}

Future<void> _switchToDsh(WidgetTester tester) async {
  await tester.tap(find.text('Phân tích bằng AI'));
  await tester.pumpAndSettle();
}

Future<void> _send(WidgetTester tester, String text) async {
  await tester.enterText(find.byType(TextField), text);
  await tester.tap(find.byTooltip('Gửi'));
}

String _fieldText(WidgetTester tester) =>
    tester.widget<TextField>(find.byType(TextField)).controller!.text;

void main() {
  // ────────────────────────────── C1: explicit opt-in ────────────────────────

  testWidgets('C1 default mode is Chat thường and it sends /ask only',
      (WidgetTester tester) async {
    final router = _Router();
    await _pumpChat(tester, router);

    expect(find.text('Chat thường'), findsOneWidget);
    expect(find.text('Phân tích bằng AI'), findsOneWidget);
    // The AI notice is NOT on screen until the user chooses that mode.
    expect(find.textContaining('Chế độ AI chỉ ĐỌC'), findsNothing);

    await _send(tester, 'chị Lan còn nợ bao nhiêu');
    await tester.pumpAndSettle();

    expect(router.paths, ['/ask']);
    expect(router.paths, isNot(contains('/dsh/ask')));
  });

  testWidgets('C1 tapping the AI segment switches mode and warns it is READ-only',
      (WidgetTester tester) async {
    final router = _Router();
    await _pumpChat(tester, router);

    await _switchToDsh(tester);

    expect(find.textContaining('Chế độ AI chỉ ĐỌC'), findsOneWidget);
    // Choosing a mode alone must not send anything.
    expect(router.paths, isEmpty);
  });

  // ────────────────────────── C2: the DSH call + status ──────────────────────

  testWidgets('C2 AI mode posts /dsh/ask with a conversation id and shows the answer',
      (WidgetTester tester) async {
    final router = _Router();
    await _pumpChat(tester, router);
    await _switchToDsh(tester);

    await _send(tester, 'Khách smoke còn nợ bao nhiêu?');
    await tester.pumpAndSettle();

    expect(router.paths, ['/dsh/ask']);
    expect(router.bodies.single['message'], 'Khách smoke còn nợ bao nhiêu?');
    expect(
      router.bodies.single['conversation_id'] as String?,
      startsWith('conv-'),
    );
    // The DSH path must NOT carry the write-path fields.
    expect(router.bodies.single.containsKey('submit_now'), isFalse);
    expect(router.bodies.single.containsKey('entity_id'), isFalse);
    expect(find.textContaining('171.800đ'), findsOneWidget);
  });

  testWidgets('C2 the analysing status shows while the session runs, then clears',
      (WidgetTester tester) async {
    final router = _Router()..gate = Completer<void>();
    await _pumpChat(tester, router);
    await _switchToDsh(tester);

    await _send(tester, 'Khách smoke còn nợ bao nhiêu?');
    await tester.pump();

    expect(find.textContaining('Đang phân tích bằng AI'), findsOneWidget);

    router.gate!.complete();
    await tester.pumpAndSettle();

    expect(find.textContaining('Đang phân tích bằng AI'), findsNothing);
    expect(find.textContaining('171.800đ'), findsOneWidget);
  });

  testWidgets('C2 a refused write keeps the text and shows the gateway wording',
      (WidgetTester tester) async {
    final router = _Router()
      ..errorBody = const {
        'ok': false,
        'code': 'DSH_WRITE_BLOCKED',
        'mode': 'dsh',
        'error': 'chế độ Phân tích bằng AI chỉ ĐỌC — ghi phiếu thu phải qua '
            'mục chat chính và cần bạn bấm Xác nhận',
      };
    await _pumpChat(tester, router);
    await _switchToDsh(tester);

    await _send(tester, 'thu tiền cho Khách smoke 10 nghìn');
    await tester.pumpAndSettle();

    expect(router.paths, ['/dsh/ask']);
    // The gateway's own sentence reaches the user (not a generic failure), and
    // the question is kept so they can retry in normal mode.
    expect(
      find.textContaining('chỉ ĐỌC — ghi phiếu thu phải qua'),
      findsOneWidget,
    );
    expect(_fieldText(tester), 'thu tiền cho Khách smoke 10 nghìn');
    // Nothing was recorded as an answered turn.
    expect(find.textContaining('171.800đ'), findsNothing);
  });

  testWidgets('C2 disposing the screen mid-session does not crash',
      (WidgetTester tester) async {
    final router = _Router()..gate = Completer<void>();
    await _pumpChat(tester, router);
    await _switchToDsh(tester);
    await _send(tester, 'Khách smoke còn nợ bao nhiêu?');
    await tester.pump();

    // The user navigates away while the agent session is still running.
    await tester.pumpWidget(const SizedBox());
    router.gate!.complete();
    await tester.pumpAndSettle();

    expect(tester.takeException(), isNull);
  });

  testWidgets(
      'C2 REGRESSION (pre-existing): normal mode mid-request disposal is safe too',
      (WidgetTester tester) async {
    // The DSH work exposed this, but it was never a DSH bug: the deterministic
    // path had the same write-after-dispose hole since Phase 3 (the /ask
    // response landed on a provider the screen had already torn down).
    // Falsified by removing the `ref.mounted` guard on that path.
    final router = _Router()..gate = Completer<void>();
    await _pumpChat(tester, router);

    await _send(tester, 'chị Lan còn nợ bao nhiêu');
    await tester.pump();
    await tester.pumpWidget(const SizedBox());
    router.gate!.complete();
    await tester.pumpAndSettle();

    expect(tester.takeException(), isNull);
  });

  // ─────────────────── C3: no write path, no card, no /execute ───────────────

  testWidgets('C3 AI mode renders no proposal card and never calls /execute',
      (WidgetTester tester) async {
    final router = _Router();
    await _pumpChat(tester, router);
    await _switchToDsh(tester);

    await _send(tester, 'Khách smoke còn nợ bao nhiêu?');
    await tester.pumpAndSettle();

    expect(router.paths, isNot(contains('/execute')));
    expect(find.byType(ProposalCard), findsNothing);
  });
}
