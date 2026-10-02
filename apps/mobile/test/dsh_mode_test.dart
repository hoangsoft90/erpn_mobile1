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

  /// NEXT6 Prompt-5: when set, `/dsh/ask` answers with THIS conversation id
  /// instead of echoing the client's — the server-minted-id scenario (client
  /// omitted an id, or the gateway switched threads).
  String? serverConversationId;

  /// next7 A3: when set, `/dsh/ask` answers with this HANDOFF envelope —
  /// `handoff` names the capability and `result` is the deterministic
  /// pipeline's own answer (proposal/candidates/reason), exactly what the A0/A1
  /// gateway returns for a WRITE question.
  Map<String, Object>? handoffBody;

  /// next7 A3: the `/execute` response for the confirm flow.
  Map<String, Object>? executeBody;

  Handler get handler => (options) async {
        final raw = options.data;
        final body = raw is String
            ? jsonDecode(raw) as Map<String, dynamic>
            : (raw as Map<String, dynamic>? ?? const {});
        if (gate != null) await gate!.future;
        paths.add(options.path);
        bodies.add(body);
        if (options.path == '/execute') {
          return _json(executeBody ?? {'ok': true, 'replay': false, 'result': {'erpnext_doc': 'PE-M001'}});
        }
        if (options.path == '/dsh/ask') {
          final err = errorBody;
          if (err != null) return _json(err, errorStatus);
          final handoff = handoffBody;
          if (handoff != null) {
            return _json({
              'ok': true,
              'mode': 'dsh',
              'conversation_id':
                  serverConversationId ?? body['conversation_id'],
              'request_id': 'req-dsh-1',
              // No dsh_session_id: NO runtime ran for a handoff turn.
              'runtime': null,
              'handoff': handoff['handoff'],
              'erp_target': 'REAL',
              'result': handoff['result'],
            });
          }
          return _json({
            'ok': true,
            'mode': 'dsh',
            'conversation_id':
                serverConversationId ?? body['conversation_id'],
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
  // ONE Dio, shared by BOTH providers. ProposalCard posts /execute through
  // dioProvider directly (chat_controller_test §6 falsification E: a recorder
  // on a different Dio proves nothing), while /ask and /dsh/ask go through
  // copilotApiClientProvider — so the router must sit under both or a confirm
  // press would vanish into a real (unoverridden) localhost Dio and the
  // request log would never see it.
  final sharedDio = Dio(BaseOptions(baseUrl: 'http://mock.local'))
    ..httpClientAdapter = _MockAdapter(router.handler);
  await tester.pumpWidget(
    ProviderScope(
      overrides: [
        sharedPreferencesProvider.overrideWithValue(null),
        dioProvider.overrideWithValue(sharedDio),
        copilotApiClientProvider.overrideWithValue(
          CopilotApiClient(dio: sharedDio),
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
    expect(find.textContaining('AI: đọc + đề xuất ghi'), findsNothing);

    await _send(tester, 'chị Lan còn nợ bao nhiêu');
    await tester.pumpAndSettle();

    expect(router.paths, ['/ask']);
    expect(router.paths, isNot(contains('/dsh/ask')));
  });

  testWidgets('C1/A8 tapping the AI segment shows the handoff-era notice (no "go back to normal chat")',
      (WidgetTester tester) async {
    final router = _Router();
    await _pumpChat(tester, router);

    await _switchToDsh(tester);

    // next7 A3 (plan_final §2/A8): the copy states the ONE rule that matters —
    // AI reads + proposes, the card's [Xác nhận] writes — and never tells the
    // shopkeeper to leave the mode they chose.
    expect(find.textContaining('AI: đọc + đề xuất ghi'), findsOneWidget);
    expect(find.textContaining('Xác nhận'), findsOneWidget);
    expect(find.textContaining('chat thường'), findsNothing,
        reason: 'the old copy told the user to re-type the write in normal chat — banned by A8');
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

  // ──────────────── Prompt-5: adopt the server-issued conversation id ────────

  testWidgets('Prompt5 the server-issued conversation id is adopted for the NEXT call',
      (WidgetTester tester) async {
    final router = _Router()..serverConversationId = 'conv-server-1';
    await _pumpChat(tester, router);
    await _switchToDsh(tester);

    // First turn: the client sends its own id; the server answers in a
    // DIFFERENT thread (the server-minted-id scenario).
    await _send(tester, 'câu thứ nhất');
    await tester.pumpAndSettle();
    expect(router.bodies.first['conversation_id'], isNot('conv-server-1'));

    // The NEXT turn must carry the SERVER's id — that is what keeps the
    // follow-up in the thread the server actually answered in.
    await _send(tester, 'câu thứ hai');
    await tester.pumpAndSettle();
    expect(
      router.bodies.last['conversation_id'],
      'conv-server-1',
      reason: 'the client adopted the server-issued id after the first turn',
    );
  });

  testWidgets('Prompt5 an echoed (same) conversation id changes nothing',
      (WidgetTester tester) async {
    final router = _Router(); // echoes the client id back (current gateway)
    await _pumpChat(tester, router);
    await _switchToDsh(tester);

    await _send(tester, 'câu một');
    await tester.pumpAndSettle();
    final firstId = router.bodies.first['conversation_id'] as String?;

    await _send(tester, 'câu hai');
    await tester.pumpAndSettle();
    expect(
      router.bodies.last['conversation_id'],
      firstId,
      reason: 'same id echoed ⇒ no adoption, the thread simply continues',
    );
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

  // ─────── next7 A3: the handoff renders the ordinary card + confirm ─────────

  /// The A0/A1 handoff envelope for "thu tiền …": the deterministic pipeline's
  /// own result (proposal included), marked with `handoff` and `runtime: null`.
  const handoffEnvelope = <String, Object>{
    'handoff': 'payment.create',
    'result': <String, Object>{
      'question': 'thu tiền cho chị Lan 10 nghìn',
      'routed': {'group': 'payment_write', 'matched': 'thu tiền'},
      'customer': {'id': 'CUST-00001', 'name': 'Nguyễn Thị Lan'},
      'answer': 'Đề xuất thu 10.000đ từ Nguyễn Thị Lan cho chứng từ SINV-0001 — '
          'kiểm tra và bấm [Xác nhận] để ghi phiếu thu (đề xuất chỉ TẠO PHIẾU NHÁP, chưa submit).',
      'direction': 'receive',
      'invoice': 'SINV-0001',
      'outstanding_vnd': 2500000,
      'proposal': <String, Object>{
        'schema': 'erpn.proposal/v1',
        'proposal_id': 'prp_a3-handoff',
        'version': 1,
        'action': 'create_payment_entry',
        'risk': 'HIGH',
        'created_at': '2026-09-27T09:00:00.000Z',
        'action_id': 'act_a3-handoff',
        'need_confirm': true,
        'need_double_confirm': false,
        'executable': true,
        'entity': {'kind': 'customer', 'id': 'CUST-00001', 'name': 'Nguyễn Thị Lan'},
        'params': {
          'direction': 'receive',
          'amount_vnd': 10000,
          'invoice': 'SINV-0001',
          'outstanding_vnd': 2500000,
          'mode': 'Tiền mặt',
          'submit_now': false,
        },
        'summary': 'Thu 10.000đ từ Nguyễn Thị Lan cho chứng từ SINV-0001',
      },
    },
  };

  testWidgets('A3 a handed-off WRITE renders the ProposalCard in AI mode',
      (WidgetTester tester) async {
    final router = _Router()..handoffBody = handoffEnvelope;
    await _pumpChat(tester, router);
    await _switchToDsh(tester);

    await _send(tester, 'thu tiền cho chị Lan 10 nghìn');
    await tester.pumpAndSettle();

    expect(router.paths, ['/dsh/ask']);
    // The ordinary card — the SAME widget the normal chat renders — shows on
    // the dsh turn, with the resolved id and the draft framing.
    expect(find.byType(ProposalCard), findsOneWidget);
    expect(find.textContaining('CUST-00001'), findsWidgets);
    expect(find.textContaining('NHÁP'), findsWidgets);
  });

  testWidgets('A3 confirming the handoff card posts /execute and completes the turn',
      (WidgetTester tester) async {
    final router = _Router()
      ..handoffBody = handoffEnvelope
      ..executeBody = {
        'ok': true,
        'replay': false,
        'result': {
          'erpnext_doc': 'PE-M009',
          'paid_vnd': 10000,
          'customer': 'CUST-00001',
          'docstatus': 0,
          'note': 'phiếu thu tạo ở trạng thái NHÁP (docstatus 0) — submit là bước riêng, cần người quyết định',
        },
      };
    await _pumpChat(tester, router);
    await _switchToDsh(tester);

    await _send(tester, 'thu tiền cho chị Lan 10 nghìn');
    await tester.pumpAndSettle();

    // Confirm ON the card in AI mode — the same button the normal chat
    // renders (a payment card in the receive direction reads "Xác nhận thu
    // tiền"), the same endpoint. The turn carries a long answer + the card, so
    // the button sits below the fold: bring it into the viewport BEFORE the
    // tap (an offscreen tap is a silent no-op) — and match the button's own
    // label only; the loose 'Xác nhận' fallback would hit the AI banner text
    // ("Mọi ghi sổ cần bấm Xác nhận trên thẻ") instead of a button.
    final confirmButton = find.textContaining('Xác nhận thu tiền');
    await tester.ensureVisible(confirmButton.last);
    await tester.pumpAndSettle();
    await tester.tap(confirmButton.last);
    await tester.pumpAndSettle();

    expect(router.paths, contains('/execute'));
    final execBody = router.bodies.last;
    // A11: the id travels FROM the proposal snapshot — the display name never
    // goes back to the server as an identity.
    expect(
      (execBody['proposal'] as Map)['entity']['id'],
      'CUST-00001',
    );
    expect(execBody['command_id'], isA<String>());
    // The write result reaches the bubble (the read-back truth).
    expect(find.textContaining('PE-M009'), findsWidgets);
  });

  testWidgets('A3 a handoff clarification (missing amount) renders the reason, never a card',
      (WidgetTester tester) async {
    final router = _Router()
      ..handoffBody = {
        'handoff': 'payment.create',
        'result': <String, Object?>{
          'question': 'thu tiền cho chị Lan',
          'routed': {'group': 'payment_write', 'matched': 'thu tiền'},
          'customer': {'id': 'CUST-00001', 'name': 'Nguyễn Thị Lan'},
          'answer': null,
          'error_code': 'PAYMENT_AMOUNT_MISSING',
          'reason': 'không tạo được đề xuất thu tiền: câu nói thiếu số tiền (bộ chuẩn hoá không đọc ra số) — không tự đoán, hãy nói rõ số tiền cần thu',
          'proposal': null,
        },
      };
    await _pumpChat(tester, router);
    await _switchToDsh(tester);

    await _send(tester, 'thu tiền cho chị Lan');
    await tester.pumpAndSettle();

    expect(router.paths, ['/dsh/ask']);
    // The pipeline's clarification is the visible answer; no half-filled card.
    expect(find.byType(ProposalCard), findsNothing);
    expect(find.textContaining('thiếu số tiền'), findsOneWidget);
  });
}
