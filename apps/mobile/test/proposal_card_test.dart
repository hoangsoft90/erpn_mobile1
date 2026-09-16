import 'dart:convert';
import 'dart:typed_data';

import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:erpn_mobile/app/providers.dart';
import 'package:erpn_mobile/features/chat/data/chat_models.dart';
import 'package:erpn_mobile/features/chat/presentation/widgets/proposal_card.dart';

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

ActionProposal _proposal(
  String risk, {
  bool doubleConfirm = false,
  // Phase 7 Stage A: the ONLY confirmable action is the HIGH write. Tests of
  // the confirm flow must pass action: 'create_payment_entry' explicitly;
  // the default keeps older display-only assertions on a non-executable verb.
  String action = 'read_balance',
}) {
  final needConfirm = risk != 'READ';
  return ActionProposal(
    schema: 'erpn.proposal/v1',
    action: action,
    risk: risk,
    riskIcon: switch (risk) {
      'READ' => '🟢',
      'LOW' => '🟡',
      'HIGH' => '🔴',
      _ => '⚫',
    },
    riskLabel: switch (risk) {
      'READ' => 'Chỉ đọc',
      'LOW' => 'Thao tác nhẹ',
      'HIGH' => 'Cần xác nhận',
      _ => 'Nguy hiểm cao',
    },
    needConfirm: needConfirm,
    needDoubleConfirm: needConfirm && doubleConfirm,
    executable: !needConfirm,
    entityKind: 'customer',
    entityId: 'CUST-00001',
    entityName: 'Nguyễn Thị Lan',
    summary: 'Xem công nợ: Nguyễn Thị Lan',
    // A server-built payment proposal ALWAYS carries params (copilot.test.mjs
    // Phase 7b asserts amount_vnd/outstanding_vnd/invoice/mode) — the /execute
    // money-shape gate refuses anything else, so tests of the confirm flow
    // must mirror the real shape.
    params: action == 'create_payment_entry'
        ? const {
            'amount_vnd': 500000,
            'invoice': 'SINV-0001',
            'outstanding_vnd': 2500000,
            'mode': 'Tiền mặt',
          }
        : null,
  );
}

Widget _host(ActionProposal proposal) => MaterialApp(
      home: Scaffold(
        body: ProposalCard(proposal: proposal),
      ),
    );

/// Host wired to a mock Dio so the confirm button can POST /execute.
Widget _hostWithMock(ActionProposal proposal, Handler handler) =>
    ProviderScope(
      overrides: [
        dioProvider.overrideWith((ref) {
          final dio = Dio(BaseOptions(baseUrl: 'http://mock'));
          dio.httpClientAdapter = _MockAdapter(handler);
          return dio;
        }),
      ],
      child: MaterialApp(
        home: Scaffold(body: ProposalCard(proposal: proposal)),
      ),
    );

void main() {
  testWidgets(
      'Phase 7b: the REAL /ask write-proposal JSON renders the [Xác nhận thu tiền] button',
      (tester) async {
    // Verbatim shape of the proposal the E2E pipeline returns for
    // "thu tiền cho chị Lan 500 ngàn" (copilot.test.mjs Phase 7b E2E, mock
    // ERPNext) — parsed exactly like AskResult.fromJson parses it.
    final serverJson = <String, dynamic>{
      'schema': 'erpn.proposal/v1',
      'action': 'create_payment_entry',
      'created_at': '2026-09-16T07:40:00.000Z',
      'risk': 'HIGH',
      'risk_display': {'icon': '🔴', 'label': 'Cần xác nhận'},
      'need_confirm': true,
      'need_double_confirm': false,
      'executable': false,
      'entity': {'kind': 'customer', 'id': 'CUST-00001', 'name': 'Nguyễn Thị Lan'},
      'params': {
        'amount_vnd': 500000,
        'invoice': 'SINV-0001',
        'outstanding_vnd': 2500000,
        'mode': 'Tiền mặt',
      },
      'summary': 'Thu 500.000đ từ Nguyễn Thị Lan cho chứng từ SINV-0001',
    };
    final proposal = ActionProposal.fromJson(serverJson);
    await tester.pumpWidget(_host(proposal));
    // THE assertion the whole Phase 7b wire exists for: the confirm button is
    // really there for a real server payload (before this, no chat answer
    // could ever produce it — result28 §3).
    expect(find.textContaining('Xác nhận thu tiền'), findsOneWidget);
    expect(find.textContaining('🔴 Cần xác nhận'), findsOneWidget);
    expect(find.textContaining('SINV-0001'), findsOneWidget);
  });

  testWidgets('READ proposal renders badge, summary, entity id — no confirm note',
      (tester) async {
    await tester.pumpWidget(_host(_proposal('READ')));
    expect(find.textContaining('🟢 Chỉ đọc'), findsOneWidget);
    expect(find.text('Xem công nợ: Nguyễn Thị Lan'), findsOneWidget);
    expect(find.textContaining('CUST-00001'), findsOneWidget);
    expect(find.textContaining('Phase 7'), findsNothing,
        reason: 'READ needs no confirmation, so no Phase 7 note');
  });

  testWidgets('each of the four risk levels renders its own badge (exit criteria)',
      (tester) async {
    final expectations = {
      'LOW': '🟡 Thao tác nhẹ',
      'HIGH': '🔴 Cần xác nhận',
      'CRITICAL': '⚫ Nguy hiểm cao',
    };
    for (final entry in expectations.entries) {
      await tester.pumpWidget(_host(_proposal(entry.key, doubleConfirm: true)));
      expect(find.textContaining(entry.value), findsOneWidget,
          reason: '${entry.key} badge must be distinct');
    }
  });

  testWidgets('LOW/HIGH show single-confirm note; CRITICAL shows double-confirm',
      (tester) async {
    await tester.pumpWidget(_host(_proposal('HIGH')));
    expect(find.textContaining('Sẽ cần xác nhận khi kích hoạt ghi'), findsOneWidget);
    expect(find.textContaining('xác nhận kép'), findsNothing);

    await tester.pumpWidget(_host(_proposal('CRITICAL', doubleConfirm: true)));
    expect(find.textContaining('xác nhận kép'), findsOneWidget);
  });

  testWidgets('there is NO confirm button — Phase 6 is display-only',
      (tester) async {
    for (final risk in ['READ', 'LOW', 'HIGH', 'CRITICAL']) {
      await tester.pumpWidget(_host(_proposal(risk, doubleConfirm: true)));
      expect(find.widgetWithText(ElevatedButton, 'Xác nhận'), findsNothing);
      expect(find.widgetWithText(FilledButton, 'Xác nhận'), findsNothing);
      expect(find.byType(TextButton), findsNothing);
      expect(find.byType(ElevatedButton), findsNothing);
    }
  });

  testWidgets('ActionProposal JSON round-trips through toJson/fromJson',
      (tester) async {
    final original = _proposal('HIGH');
    final restored = ActionProposal.fromJson(original.toJson());
    expect(restored.risk, 'HIGH');
    expect(restored.riskIcon, '🔴');
    expect(restored.entityId, 'CUST-00001');
    expect(restored.needConfirm, true);
    expect(restored.executable, false);
  });

  testWidgets('confirmable getter: only HIGH create_payment_entry with entity id',
      (tester) async {
    expect(
        _proposal('HIGH', action: 'create_payment_entry').confirmable, isTrue,
        reason: "the single HIGH write is confirmable (Phase 7 Stage A)");
    expect(_proposal('HIGH').confirmable, isFalse,
        reason: 'read_balance HIGH is NOT confirmable — action must match too');
    expect(_proposal('READ').confirmable, isFalse);
    expect(_proposal('CRITICAL', doubleConfirm: true).confirmable, isFalse,
        reason: 'CRITICAL demands double-confirm UI — not Phase 7 Stage A');
    final noEntity = ActionProposal.fromJson(
        _proposal('HIGH').toJson()..['entity']['id'] = null);
    expect(noEntity.confirmable, isFalse);
  });

  testWidgets(
      'Phase 9 UI: a PROPOSAL_STALE 409 renders the reason banner with problems[] '
      'and REMOVES the confirm button', (tester) async {
    // A stale card must be re-asked on fresh numbers — never confirmed on old
    // ones. The banner carries the server's concrete mismatches (problems[]).
    final stale = ActionProposal.fromJson(
      _proposal('HIGH', action: 'create_payment_entry').toJson()
        ..['rejection_code'] = 'PROPOSAL_STALE'
        ..['rejection_problems'] = [
          'nợ đã đổi từ 2500000 sang 2000000',
          'chứng từ không còn thuộc khách CUST-00001',
        ],
    );
    expect(stale.isRejected, isTrue);
    await tester.pumpWidget(_host(stale));
    expect(find.textContaining('đã lệch so với dữ liệu thật'), findsOneWidget);
    expect(find.textContaining('nợ đã đổi từ 2500000'), findsOneWidget);
    expect(find.textContaining('chứng từ không còn thuộc khách'), findsOneWidget);
    expect(find.text('Xác nhận thu tiền'), findsNothing,
        reason: 'a refused card must not offer the confirm affordance');
  });

  testWidgets('Phase 9 UI: PROPOSAL_EXPIRED renders the expiry banner', (tester) async {
    final expired = ActionProposal.fromJson(
      _proposal('HIGH', action: 'create_payment_entry').toJson()
        ..['rejection_code'] = 'PROPOSAL_EXPIRED',
    );
    await tester.pumpWidget(_host(expired));
    expect(find.textContaining('đã hết hạn'), findsOneWidget);
    expect(find.text('Xác nhận thu tiền'), findsNothing);
  });

  testWidgets(
      'Phase 9 UI: rejection survives history restore (toJson → fromJson keeps code + problems)',
      (tester) async {
    final stale = ActionProposal.fromJson(
      _proposal('HIGH', action: 'create_payment_entry').toJson()
        ..['rejection_code'] = 'PROPOSAL_STALE'
        ..['rejection_problems'] = ['nợ đã đổi từ 2500000 sang 2000000'],
    );
    final restored = ActionProposal.fromJson(stale.toJson());
    expect(restored.rejectionCode, 'PROPOSAL_STALE');
    expect(restored.rejectionProblems, ['nợ đã đổi từ 2500000 sang 2000000']);
    expect(restored.commandId, stale.commandId,
        reason: 'same card identity — the banner must survive restarts');
  });

  testWidgets('HIGH card shows confirm button; pressing it POSTs /execute once',
      (tester) async {
    final requests = <dynamic>[];
    await tester.pumpWidget(
        _hostWithMock(_proposal('HIGH', action: 'create_payment_entry'),
            (options) async {
      requests.add(options.data);
      return _json({
        'ok': true,
        'replay': false,
        'result': {
          'erpnext_doc': 'PE-M001',
          'paid_vnd': 2500000,
        },
      });
    }));
    expect(find.text('Xác nhận thu tiền'), findsOneWidget);
    await tester.tap(find.byType(FilledButton));
    await tester.pumpAndSettle();
    expect(requests.length, 1, reason: 'exactly one /execute call per press');
    final sent = jsonDecode(requests.first as String) as Map<String, dynamic>;
    expect(sent['command_id'], isA<String>());
    expect(sent['proposal']['action'], 'create_payment_entry');
    expect(find.textContaining('Đã ghi phiếu thu: PE-M001'), findsOneWidget);
  });

  testWidgets(
      'network error then retry on the SAME card → ONE stable command_id, '
      'retry is served as replay (phase-07: no second write)', (tester) async {
    final requests = <dynamic>[];
    var attempt = 0;
    final proposal = _proposal('HIGH', action: 'create_payment_entry');
    await tester.pumpWidget(_hostWithMock(proposal, (options) async {
      requests.add(options.data);
      attempt++;
      if (attempt == 1) {
        // The write may or may not have reached the server — from the client
        // it looks exactly like a lost network call.
        throw DioException.connectionError(
          requestOptions: options,
          reason: 'simulated network drop',
        );
      }
      return _json({
        'ok': true,
        'replay': true,
        'result': {'erpnext_doc': 'PE-M001', 'paid_vnd': 2500000},
      });
    }));

    await tester.tap(find.byType(FilledButton));
    await tester.pumpAndSettle();
    expect(find.textContaining('Không gửi được lệnh xác nhận'), findsOneWidget,
        reason: 'first press fails at the network layer');
    expect(find.byType(FilledButton), findsOneWidget,
        reason: 'button stays available so the user can retry');

    await tester.tap(find.byType(FilledButton));
    await tester.pumpAndSettle();

    expect(requests.length, 2, reason: 'two HTTP attempts were made');
    final first = jsonDecode(requests[0] as String) as Map<String, dynamic>;
    final second = jsonDecode(requests[1] as String) as Map<String, dynamic>;
    expect(second['command_id'], first['command_id'],
        reason: 'the SAME idempotency key must be reused on retry — a fresh '
            'key would let the gateway write a second payment');
    expect(first['command_id'], proposal.commandId,
        reason: 'the key belongs to the proposal instance, not to the press');
    expect(find.textContaining('chống trùng'), findsOneWidget,
        reason: 'the server replayed the first write instead of writing again');
  });

  testWidgets(
      'a NEW /ask answer (new proposal instance) gets a NEW command_id',
      (tester) async {
    final first = _proposal('HIGH', action: 'create_payment_entry');
    final second = _proposal('HIGH', action: 'create_payment_entry');
    expect(first.commandId, isNot(second.commandId),
        reason: 'same-looking proposals are separate intents — reusing the key '
            'would make the second payment a replay of the first');
    // Stability inside one instance, across repeated reads.
    expect(first.commandId, first.commandId);
  });  testWidgets(
      'a card restored from history keeps its ORIGINAL command_id (regression: '
      're-parsing history used to mint a new key ⇒ second write)',
      (tester) async {
    // 1. A proposal arrives from /ask. Its key is what the confirm flow uses.
    final original = _proposal('HIGH', action: 'create_payment_entry');
    final originalKey = original.commandId;

    // 2. The turn goes to prefs (toJson) and the app restarts: the history is
    //    parsed back into a NEW ActionProposal instance.
    final persisted =
        jsonDecode(jsonEncode(original.toJson())) as Map<String, dynamic>;
    final restored = ActionProposal.fromJson(persisted);
    expect(identical(restored, original), isFalse,
        reason: 'a restore really does build a fresh instance');
    expect(restored.commandId, originalKey,
        reason: 'the restored card must reuse the key it was persisted with — '
            'a fresh key would make the same debt payable twice');

    // 3. Pressing confirm on the restored card sends that same key, so the
    //    gateway replays the first write instead of writing a second payment.
    final requests = <dynamic>[];
    await tester.pumpWidget(_hostWithMock(restored, (options) async {
      requests.add(options.data);
      return _json({
        'ok': true,
        'replay': true,
        'result': {'erpnext_doc': 'PE-M001', 'paid_vnd': 2500000},
      });
    }));
    await tester.tap(find.byType(FilledButton));
    await tester.pumpAndSettle();

    final sent = jsonDecode(requests.single as String) as Map<String, dynamic>;
    expect(sent['command_id'], originalKey,
        reason: 'confirm after restart must keep the original idempotency key');
    expect(find.textContaining('chống trùng'), findsOneWidget);
  });

  testWidgets('a proposal round-trip keeps created_at (Phase 9 age gate)',
      (tester) async {
    // /execute refuses a proposal with no created_at, or older than the TTL, so
    // the field must survive both the API parse and the history round-trip.
    final json = {
      'schema': 'erpn.proposal/v1',
      'action': 'create_payment_entry',
      'risk': 'HIGH',
      'need_confirm': true,
      'entity': {'kind': 'customer', 'id': 'CUST-00001', 'name': 'Lan'},
      'params': {'amount_vnd': 500000, 'invoice': 'SINV-1', 'outstanding_vnd': 500000},
      'created_at': '2026-09-16T04:00:00.000Z',
    };
    final parsed = ActionProposal.fromJson(Map<String, dynamic>.from(json));
    expect(parsed.createdAt, '2026-09-16T04:00:00.000Z');

    final again = ActionProposal.fromJson(
        jsonDecode(jsonEncode(parsed.toJson())) as Map<String, dynamic>);
    expect(again.createdAt, parsed.createdAt,
        reason: 'dropping created_at would make every confirm fail server-side');
  });

  testWidgets('ChatTurn history round-trip preserves the proposal command_id',
      (tester) async {
    final turn = ChatTurn(
      question: 'chị Lan còn nợ bao nhiêu',
      answer: 'Còn 2.500.000đ',
      ok: true,
      ts: DateTime.now(),
      proposal: _proposal('HIGH', action: 'create_payment_entry'),
    );
    final key = turn.proposal!.commandId;

    final restored = ChatTurn.fromJson(
        jsonDecode(jsonEncode(turn.toJson())) as Map<String, dynamic>);

    expect(restored.proposal, isNotNull,
        reason: 'the restored turn must still render its confirm card');
    expect(restored.proposal!.commandId, key);
  });  testWidgets('server replay response shows the anti-duplicate message'
      , (tester) async {    await tester.pumpWidget(
        _hostWithMock(_proposal('HIGH', action: 'create_payment_entry'),
            (options) async {
      return _json({
        'ok': true,
        'replay': true,
        'result': {'erpnext_doc': 'PE-M001', 'paid_vnd': 2500000},
      });
    }));
    await tester.tap(find.byType(FilledButton));
    await tester.pumpAndSettle();
    expect(find.textContaining('chống trùng'), findsOneWidget);
  });

  testWidgets(
      'Phase 7b wire: pressing confirm sends params.amount_vnd the server '
      'money-shape gate REQUIRES (result33 review F4)', (tester) async {
    // http-ask.mjs:309 reads proposal.params.amount_vnd and 400s without it.
    // The Dart model must carry the confirmed numbers BACK to the server —
    // a model that drops params makes every real confirm press a 400 (unit
    // tests never caught it because Node tests hand-build the JSON with
    // params and Dart tests only asserted the response, not the sent body).
    final bodies = <Map<String, dynamic>>[];
    await tester.pumpWidget(
        _hostWithMock(_proposal('HIGH', action: 'create_payment_entry'),
            (options) async {
      bodies
          .add(jsonDecode(options.data as String) as Map<String, dynamic>);
      return _json({
        'ok': true,
        'replay': false,
        'result': {'erpnext_doc': 'PE-M001', 'paid_vnd': 500000},
      });
    }));
    await tester.tap(find.byType(FilledButton));
    await tester.pumpAndSettle();
    final sent = bodies.single['proposal'] as Map<String, dynamic>;
    expect(
        (sent['params'] as Map<String, dynamic>?)?['amount_vnd'], 500000,
        reason: 'the server money-shape gate 400s without params.amount_vnd — '
            'the round-trip must keep the confirmed amount');
    expect(
        (sent['params'] as Map<String, dynamic>?)?['outstanding_vnd'],
        2500000,
        reason: 'the drift snapshot must survive too (detectDrift reads it)');
  });

  testWidgets(
      'Phase 9 wire: /execute answering 409 PROPOSAL_STALE THROUGH dio (throws '
      'by default) still attaches the reason banner — regression for the '
      'result33 review finding', (tester) async {
    // dio rejects non-2xx (validateStatus default) — so the 409 body arrives
    // as err.response.data inside a DioException, NOT as res.data. This test
    // drives the REAL wire path; the earlier banner tests fed rejections
    // straight into the model and could not catch the missing branch.
    await tester.pumpWidget(
        _hostWithMock(_proposal('HIGH', action: 'create_payment_entry'),
            (options) async {
      return _json(
        {
          'ok': false,
          'code': 'PROPOSAL_STALE',
          'error': 'Dữ liệu đã thay đổi sau khi tạo đề xuất',
          'problems': ['nợ đã đổi từ 2500000 sang 2000000'],
        },
        409,
      );
    }));
    await tester.tap(find.byType(FilledButton));
    await tester.pumpAndSettle();
    expect(find.textContaining('đã lệch so với dữ liệu thật'), findsOneWidget,
        reason: 'the banner must render on the REAL 409 path too');
    expect(find.textContaining('nợ đã đổi từ 2500000'), findsOneWidget);
    expect(find.text('Xác nhận thu tiền'), findsNothing,
        reason: 'fail-closed: no confirm affordance on a refused card');
  });

  testWidgets('READ and CRITICAL cards still have NO button (display-only)',
      (tester) async {
    await tester.pumpWidget(_host(_proposal('READ')));
    expect(find.byType(FilledButton), findsNothing);
    await tester.pumpWidget(_host(_proposal('CRITICAL', doubleConfirm: true)));
    expect(find.byType(FilledButton), findsNothing);
  });
}
