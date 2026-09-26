import 'dart:async';
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
  // P9-A2: a LINE document carries its own params shape (the order's lines),
  // so a delivery test needs to hand in the real one instead of the payment
  // default below.
  Map<String, dynamic>? params,
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
    params: params ??
        (action == 'create_payment_entry'
            ? const {
                'amount_vnd': 500000,
                'invoice': 'SINV-0001',
                'outstanding_vnd': 2500000,
                'mode': 'Tiền mặt',
              }
            : null),
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
        // The confirm path applies the client's settings (base URL + basic auth)
        // before POSTing /execute — a protected server answers 401 otherwise. That
        // reads the settings service, so the host must supply its dependency
        // (a null prefs instance is enough: the getters fall back to defaults).
        sharedPreferencesProvider.overrideWithValue(null),
      ],
      child: MaterialApp(
        home: Scaffold(body: ProposalCard(proposal: proposal)),
      ),
    );

/// Same host, but the card sits at the TOP of a long ListView — the setup the
/// real chat screen has, and the one that exposes F2: `ListView.builder`
/// DISPOSES off-screen children, so a card scrolled away and back used to be
/// rebuilt from scratch (result40 probe P2: success=1/button=0 →
/// success=0/button=1). Fillers are tall so a single drag moves the card out
/// of the viewport and back.
Widget _hostInListView(ActionProposal proposal, Handler handler) =>
    ProviderScope(
      overrides: [
        dioProvider.overrideWith((ref) {
          final dio = Dio(BaseOptions(baseUrl: 'http://mock'));
          dio.httpClientAdapter = _MockAdapter(handler);
          return dio;
        }),
        // The confirm path applies the client's settings (base URL + basic auth)
        // before POSTing /execute — a protected server answers 401 otherwise. That
        // reads the settings service, so the host must supply its dependency
        // (a null prefs instance is enough: the getters fall back to defaults).
        sharedPreferencesProvider.overrideWithValue(null),
      ],
      child: MaterialApp(
        home: Scaffold(
          body: ListView.builder(
            itemCount: 60,
            itemBuilder: (context, index) => index == 0
                ? ProposalCard(proposal: proposal)
                : SizedBox(
                    height: 120,
                    child: Text('filler $index'),
                  ),
          ),
        ),
      ),
    );

// ---- P5-3 (§4.1): draft/submitted badge + advice per refusal kind ----
// Top-level on purpose: helpers declared inside `main()` are LOCAL identifiers,
// and `_`-prefixed locals trip `no_leading_underscores_for_local_identifiers`.

/// The badge's real background colour, read from its own BoxDecoration — a
/// test that only checked "a badge exists" would pass on the wrong tone.
Color _badgeColor(WidgetTester tester) {
  final container =
      tester.widget<Container>(find.byKey(const ValueKey('submit-badge')));
  return ((container.decoration! as BoxDecoration).color)!;
}

ColorScheme _schemeAt(WidgetTester tester) => Theme.of(
        tester.element(find.byKey(const ValueKey('submit-badge'))))
    .colorScheme;

/// Confirm the card and settle, one result per call.
///
/// The `UniqueKey` is load-bearing, not decoration: `pumpWidget` builds the SAME
/// tree shape every call, so Flutter reuses the existing card Element/State —
/// the second call would read the FIRST call's result, and its confirm button
/// would already be gone ("Found 0 widgets with text 'Xác nhận thu tiền'").
/// A fresh key forces a fresh State per case.
Future<void> _confirmWith(WidgetTester tester, Map<String, dynamic> result) async {
  await tester.pumpWidget(KeyedSubtree(
    key: UniqueKey(),
    child: _hostWithMock(
        _proposal('HIGH', action: 'create_payment_entry'), (options) async {
      return _json({'ok': true, 'replay': false, 'result': result});
    }),
  ));
  await tester.tap(find.text('Xác nhận thu tiền'));
  await tester.pumpAndSettle();
}

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
      'P4: a 503 retry_same_command_id shows a clear banner (reconcile, no new '
      'phiếu) and the retry reuses the SAME command_id',
      (tester) async {
    final requests = <dynamic>[];
    var attempt = 0;
    final proposal = _proposal('HIGH', action: 'create_payment_entry');
    await tester.pumpWidget(_hostWithMock(proposal, (options) async {
      requests.add(options.data);
      attempt++;
      if (attempt == 1) {
        // PROMPT-4: an unverified submit is NOT a 200 PARTIAL any more — the
        // server kept the command PENDING and answers 503 retry_same_command_id.
        return _json({
          'ok': false,
          'retry_same_command_id': true,
          'error':
              'chưa xác minh được kết quả ghi: đã tạo NHÁP PE-M001 nhưng CHƯA xác minh được submit',
        }, 503);
      }
      return _json({
        'ok': true,
        'replay': true,
        'reconciled': true,
        'result': {'erpnext_doc': 'PE-M001', 'docstatus': 1, 'submit_ok': true},
      });
    }));

    await tester.tap(find.byType(FilledButton));
    await tester.pumpAndSettle();
    expect(find.textContaining('CHƯA xác minh được submit'), findsOneWidget,
        reason: 'the server reason is shown, not a generic failure');
    expect(find.textContaining('Bấm [Xác nhận] lại để hệ thống ĐỐI SOÁT'),
        findsOneWidget,
        reason: 'the banner tells the user the retry is a reconcile, not a new phiếu');
    expect(find.textContaining('KHÔNG tạo phiếu mới'), findsOneWidget);
    expect(find.byType(FilledButton), findsOneWidget,
        reason: 'the button stays so the user can reconcile');

    await tester.tap(find.byType(FilledButton));
    await tester.pumpAndSettle();
    expect(requests.length, 2);
    final first = jsonDecode(requests[0] as String) as Map<String, dynamic>;
    final second = jsonDecode(requests[1] as String) as Map<String, dynamic>;
    expect(second['command_id'], first['command_id'],
        reason: 'the reconcile retry must reuse the SAME idempotency key');
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

  // ---------------------------------------------------------------------
  // result40 review — crash/fail-open guards on the confirm+refusal path.
  // Proven red before the fix with a throwaway probe (P1/P1b/P4), then kept
  // here as regression tests.
  // ---------------------------------------------------------------------

  testWidgets(
      'result40 F1: unmount while /execute is in flight — success path must '
      'not setState after dispose', (tester) async {
    final gate = Completer<ResponseBody>();
    await tester.pumpWidget(
        _hostWithMock(_proposal('HIGH', action: 'create_payment_entry'),
            (options) => gate.future));

    await tester.tap(find.byType(FilledButton));
    await tester.pump(); // request started, still in flight

    // The user navigates away / clears history mid-write: the card (and its
    // ProviderScope) is disposed while the Future is pending.
    await tester.pumpWidget(
        const MaterialApp(home: Scaffold(body: SizedBox())));
    expect(find.byType(ProposalCard), findsNothing);

    gate.complete(_json({
      'ok': true,
      'replay': false,
      'result': {'erpnext_doc': 'PE-M001', 'paid_vnd': 500000},
    }));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));

    // An unguarded setState() (or ref.read on a disposed scope) fails the test
    // with "setState() called after dispose()".
    expect(tester.takeException(), isNull,
        reason: 'post-await UI updates must be guarded by mounted');
  });

  testWidgets(
      'result40 F1: unmount while /execute is in flight — 409 refusal path '
      'must not setState after dispose either', (tester) async {
    final gate = Completer<ResponseBody>();
    await tester.pumpWidget(
        _hostWithMock(_proposal('HIGH', action: 'create_payment_entry'),
            (options) => gate.future));

    await tester.tap(find.byType(FilledButton));
    await tester.pump();
    await tester.pumpWidget(
        const MaterialApp(home: Scaffold(body: SizedBox())));

    gate.complete(_json({
      'ok': false,
      'code': 'PROPOSAL_STALE',
      'error': 'Dữ liệu đã thay đổi sau khi tạo đề xuất',
      'problems': ['nợ đã đổi từ 2500000 sang 2000000'],
    }, 409));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));

    expect(tester.takeException(), isNull);
  });

  testWidgets(
      'result40 F3: a refusal whose problems[] is NOT a list still renders the '
      'banner and removes the confirm button (fail-CLOSED)', (tester) async {
    // Before the fix the cast `as List<dynamic>?` threw a TypeError inside the
    // DioException handler: the banner never rendered and the confirm button
    // STAYED on a refused card — fail-open exactly where it must fail closed.
    await tester.pumpWidget(
        _hostWithMock(_proposal('HIGH', action: 'create_payment_entry'),
            (options) async => _json({
                  'ok': false,
                  'code': 'PROPOSAL_STALE',
                  'error': 'Dữ liệu đã thay đổi',
                  'problems': 'nợ đã đổi từ 2500000 sang 2000000', // String
                }, 409)));

    await tester.tap(find.byType(FilledButton));
    await tester.pumpAndSettle();

    expect(tester.takeException(), isNull,
        reason: 'a non-list problems field must not break the refusal path');
    expect(find.textContaining('đã lệch so với dữ liệu thật'), findsOneWidget,
        reason: 'any refusal must show the reason banner');
    expect(find.text('Xác nhận thu tiền'), findsNothing,
        reason: 'and must never leave the confirm affordance on a refused card');
  });

  testWidgets(
      'result41 F2: a written card keeps its result through a ListView recycle '
      '(option b — AutomaticKeepAliveClientMixin)', (tester) async {
    var writes = 0;
    // ONE proposal instance for the whole test — rebuilding the card with a
    // fresh instance would reset the idempotency key and make this test lie
    // (lesson from the result40 probe bug).
    final proposal = _proposal('HIGH', action: 'create_payment_entry');
    await tester.pumpWidget(_hostInListView(proposal, (options) async {
      writes++;
      return _json({
        'ok': true,
        'replay': false,
        'result': {'erpnext_doc': 'PE-M001', 'paid_vnd': 2500000},
      });
    }));

    await tester.tap(find.byType(FilledButton));
    await tester.pumpAndSettle();
    expect(find.textContaining('Đã ghi phiếu thu: PE-M001'), findsOneWidget);
    expect(find.byType(FilledButton), findsNothing);

    // Scroll the card far out of the viewport, then back to the top.
    await tester.drag(find.byType(ListView), const Offset(0, -5000));
    await tester.pumpAndSettle();
    await tester.drag(find.byType(ListView), const Offset(0, 6000));
    await tester.pumpAndSettle();

    expect(find.textContaining('Đã ghi phiếu thu: PE-M001'), findsOneWidget,
        reason: 'the write result must survive the ListView recycle');
    expect(find.byType(FilledButton), findsNothing,
        reason: 'a card that already wrote must NOT offer confirm again '
            'after being scrolled away and back');
    expect(writes, 1,
        reason: 'recycling must not fire a second /execute (no second write)');
  });

// ---- F7-2 (user decision 2026-09-18): submit-now card copy & outcomes ----

testWidgets(
    'F7-2: a submit_now proposal shows the submit banner and sends submit_now on /execute',
    (tester) async {
  final requests = <dynamic>[];
  await tester.pumpWidget(_hostWithMock(
      _proposal('HIGH', action: 'create_payment_entry'), (options) async {
    requests.add(options.data);
    return _json({
      'ok': true,
      'replay': false,
      'result': {
        'erpnext_doc': 'PE-S001',
        'paid_vnd': 500000,
        'submit_ok': true,
        'docstatus': 1,
      },
    });
  }));
  // The default _proposal params have no submit_now — build the ON variant by
  // re-hosting with fromJson, exactly the shape the server freezes.
  final onJson = jsonDecode(jsonEncode(_proposal('HIGH', action: 'create_payment_entry').toJson()))
      as Map<String, dynamic>;
  onJson['params'] = {...onJson['params'] as Map<String, dynamic>, 'submit_now': true};
  final onProposal = ActionProposal.fromJson(onJson);
  await tester.pumpWidget(_hostWithMock(onProposal, (options) async {
    requests.add(options.data);
    return _json({
      'ok': true,
      'replay': false,
      'result': {
        'erpnext_doc': 'PE-S001',
        'paid_vnd': 500000,
        'submit_ok': true,
        'docstatus': 1,
      },
    });
  }));
  // The banner is really there, before any confirm.
  expect(find.textContaining('NỘP NGAY'), findsOneWidget);
  await tester.tap(find.text('Xác nhận thu tiền'));
  await tester.pumpAndSettle();
  final sent = jsonDecode(requests.last as String) as Map<String, dynamic>;
  expect(sent['submit_now'], true,
      reason: 'the card replays the FROZEN snapshot flag, not a live setting');
  expect(find.textContaining('Đã ghi và NỘP phiếu thu'), findsOneWidget);
  expect(find.textContaining('công nợ đã giảm'), findsOneWidget);
});

testWidgets('F7-2: draft-only card (snapshot false) shows no banner and sends no flag',
    (tester) async {
  final requests = <dynamic>[];
  await tester.pumpWidget(_hostWithMock(
      _proposal('HIGH', action: 'create_payment_entry'), (options) async {
    requests.add(options.data);
    return _json({
      'ok': true,
      'replay': false,
      'result': {'erpnext_doc': 'PE-S002', 'paid_vnd': 500000},
    });
  }));
  expect(find.textContaining('NỘP NGAY'), findsNothing);
  expect(find.textContaining('⚡'), findsNothing);
  await tester.tap(find.text('Xác nhận thu tiền'));
  await tester.pumpAndSettle();
  final sent = jsonDecode(requests.single as String) as Map<String, dynamic>;
  expect(sent.containsKey('submit_now'), isFalse,
      reason: 'no flag on the wire when the snapshot is draft-only');
  expect(find.textContaining('Đã ghi phiếu thu: PE-S002'), findsOneWidget);
  expect(find.textContaining('NHƯNG submit lỗi'), findsNothing);
});

testWidgets('F7-2: a submit failure is PARTIAL — draft reported, never a silent success',
    (tester) async {
  await tester.pumpWidget(_hostWithMock(
      _proposal('HIGH', action: 'create_payment_entry'), (options) async {
    return _json({
      'ok': true,
      'replay': false,
      'result': {
        'erpnext_doc': 'PE-S003',
        'paid_vnd': 500000,
        'submit_ok': false,
        'submit_error': 'server unavailable',
        'docstatus': 0,
      },
    });
  }));
  await tester.tap(find.text('Xác nhận thu tiền'));
  await tester.pumpAndSettle();
  expect(find.textContaining('Đã tạo phiếu NHÁP'), findsOneWidget);
  expect(find.textContaining('NHƯNG submit lỗi'), findsOneWidget);
  expect(find.textContaining('submit tay trên ERPNext'), findsOneWidget);
  // The confirm button is gone (the money record exists) and no refusal banner
  // replaced it — this is a PARTIAL, not a PROPOSAL_STALE-style refusal.
  expect(find.text('Xác nhận thu tiền'), findsNothing);
  expect(find.textContaining('🔄'), findsNothing);
});

testWidgets('P5-3: a SUBMITTED receipt gets the submitted badge (primary tone)', (tester) async {
  await _confirmWith(tester, {
    'erpnext_doc': 'PE-B1',
    'paid_vnd': 500000,
    'submit_ok': true,
    'docstatus': 1,
  });

  expect(find.byKey(const ValueKey('submit-badge')), findsOneWidget);
  expect(find.text('ĐÃ NỘP'), findsOneWidget);
  expect(find.text('NHÁP'), findsNothing);
  expect(_badgeColor(tester), _schemeAt(tester).primaryContainer,
      reason: 'a submitted receipt must carry the theme primary tone');
  // P5-3 review: the leading glyph rides the same state as the badge.
  expect(find.textContaining('✅'), findsOneWidget);
  expect(find.textContaining('⚠️'), findsNothing);
  // No advice line: nothing went wrong.
  expect(find.byKey(const ValueKey('submit-hint')), findsNothing);
});

testWidgets('P5-3: a REFUSED submit gets the draft badge, and the KIND decides the advice',
    (tester) async {
  // One case per classification P5-2 sends, plus `other` — which must add
  // NOTHING beyond ERPNext's own message.
  final cases = <MapEntry<String, String?>>[
    const MapEntry('permission', 'liên hệ quản trị viên ERPNext để được cấp quyền Submit'),
    const MapEntry('period_locked', 'liên hệ kế toán'),
    const MapEntry('workflow', 'cần được duyệt trước khi nộp'),
    const MapEntry('other', null),
  ];

  for (final entry in cases) {
    await _confirmWith(tester, {
      'erpnext_doc': 'PE-B2',
      'paid_vnd': 500000,
      'submit_ok': false,
      'submit_error': 'refused by ERPNext',
      'submit_error_kind': entry.key,
      'docstatus': 0,
    });

    expect(find.text('NHÁP'), findsOneWidget, reason: 'kind=${entry.key}');
    expect(find.text('ĐÃ NỘP'), findsNothing, reason: 'kind=${entry.key}');
    expect(_badgeColor(tester), _schemeAt(tester).tertiaryContainer,
        reason: 'a refused submit is a DRAFT on the books (kind=${entry.key})');
    // P5-3 review: a ✅ in front of a refused submit claimed the opposite of the
    // badge — the glyph must say ⚠️ here.
    expect(find.textContaining('⚠️'), findsOneWidget,
        reason: 'kind=${entry.key}: the glyph must not claim success');
    expect(find.textContaining('✅'), findsNothing, reason: 'kind=${entry.key}');

    if (entry.value == null) {
      expect(find.byKey(const ValueKey('submit-hint')), findsNothing,
          reason: 'no invented advice for kind=other');
    } else {
      expect(find.byKey(const ValueKey('submit-hint')), findsOneWidget,
          reason: 'kind=${entry.key} must come with its advice');
      expect(find.textContaining(entry.value!), findsOneWidget,
          reason: 'the advice for kind=${entry.key} must name who to ask');
    }
    // The verbatim ERPNext message is still shown — the hint ADDS, never replaces.
    expect(find.textContaining('refused by ERPNext'), findsOneWidget);
  }
});

testWidgets('P5-3: no submit step reported (draft-only, or an older server) reads as NHÁP',
    (tester) async {
  await _confirmWith(tester, {'erpnext_doc': 'PE-B3', 'paid_vnd': 500000});

  expect(find.text('NHÁP'), findsOneWidget,
      reason: 'absent submit_ok is not a submitted receipt');
  expect(_badgeColor(tester), _schemeAt(tester).tertiaryContainer);
  // Nothing was REFUSED here, so the glyph stays ✅ (only `false` earns ⚠️).
  expect(find.textContaining('✅'), findsOneWidget);
  expect(find.textContaining('⚠️'), findsNothing);
  // And with no kind, no advice is invented.
  expect(find.byKey(const ValueKey('submit-hint')), findsNothing);
  expect(find.textContaining('Đã ghi phiếu thu: PE-B3'), findsOneWidget);
});

testWidgets('P5-3: a QUOTATION card never wears the submitted badge (B3: a quote is not a sale)',
    (tester) async {
  // The badge is rendered for every confirmable card with a result — including
  // the ORDER family, where the server sends no submit step at all. Their tone
  // must stay DRAFT: a "ĐÃ NỘP" on a quotation would tell the shop something
  // was sold and submitted when nothing was owed to anyone yet.
  await tester.pumpWidget(_hostWithMock(
      _proposal('HIGH', action: 'create_quotation'), (options) async {
    return _json({
      'ok': true,
      'replay': false,
      'result': {'erpnext_doc': 'QT-0001', 'grand_total': 1000000},
    });
  }));
  await tester.tap(find.text('Xác nhận tạo báo giá (NHÁP)'));
  await tester.pumpAndSettle();

  expect(find.text('NHÁP'), findsOneWidget);
  expect(find.text('ĐÃ NỘP'), findsNothing,
      reason: 'no submit step exists for a quotation');
  expect(_badgeColor(tester), _schemeAt(tester).tertiaryContainer);
  expect(find.byKey(const ValueKey('submit-hint')), findsNothing,
      reason: 'nothing was refused — there was nothing to submit');
  // The B3 wording is untouched by the badge, and the glyph stays ✅ (no
  // submit step exists, so nothing failed). No ⚠️ assertion here: a LINE
  // document with empty/absent `params.lines` renders its own ⚠️ line-row
  // warning, which has nothing to do with the submit state.
  expect(find.textContaining('✅'), findsOneWidget);
  expect(find.textContaining('ĐỀ NGHỊ'), findsOneWidget);
});

  testWidgets(
      'P9-A2: a DELIVERY card confirms as a NHÁP phiếu giao theo đơn, and shows no price of its own',
      (tester) async {
    // Verbatim shape the /ask pipeline returns for "giao hàng cho Nguyễn Thị
    // Lan" (p9-delivery.test.mjs E2E): the ORDER it fulfils travels on the
    // snapshot, the lines come from that order, and there is no amount — a
    // delivery note has no price of its own.
    await tester.pumpWidget(_hostWithMock(
      _proposal('HIGH', action: 'create_delivery_note', params: const {
        'against_sales_order': 'SAL-ORD-2026-00001',
        'line_count': 1,
        'submit_now': false,
        'lines': [
          {
            'item_code': 'CAM-HEO-25KG',
            'item_name': 'Cám heo tăng trọng 25kg',
            'qty': 6,
            'uom': 'Bao',
            'against_sales_order': 'SAL-ORD-2026-00001',
          },
        ],
      }),
      (options) async => _json({
        'ok': true,
        'replay': false,
        'result': {
          'erpnext_doc': 'DN-M001',
          'against_sales_order': 'SAL-ORD-2026-00001',
          'line_count': 1,
          'docstatus': 0,
        },
      }),
    ));

    // The button promises the DRAFT the server will actually write.
    expect(find.text('Xác nhận tạo phiếu giao (NHÁP)'), findsOneWidget);
    // The order's price is NOT re-shown as a total: a delivery note never
    // carries one, and a "tổng" line would imply money is being moved.
    expect(find.textContaining('Tạm tính'), findsNothing);

    await tester.tap(find.text('Xác nhận tạo phiếu giao (NHÁP)'));
    await tester.pumpAndSettle();

    // Draft badge (no submit step exists on this path), and the outcome says
    // out loud that STOCK has not moved yet.
    expect(find.text('NHÁP'), findsOneWidget);
    expect(find.text('ĐÃ NỘP'), findsNothing);
    expect(_badgeColor(tester), _schemeAt(tester).tertiaryContainer);
    expect(find.textContaining('Đã tạo phiếu giao hàng NHÁP: DN-M001'), findsOneWidget);
    expect(find.textContaining('CHƯA trừ kho'), findsOneWidget);
  });

  testWidgets('P9-B: the purchase receipt card mirrors the delivery card — draft button, no fake total, stock untouched', (tester) async {
    // Mirrors the server's E2E: "nhận hàng từ Hà Tiên" proposes a DRAFT receipt
    // from a submitted PO — lines from that order, no amount of its own.
    await tester.pumpWidget(_hostWithMock(
      _proposal('HIGH', action: 'create_purchase_receipt', params: const {
        'purchase_order': 'PUR-ORD-2026-00001',
        'line_count': 1,
        'submit_now': false,
        'lines': [
          {
            'item_code': 'CAM-GA-10KG',
            'item_name': 'Cám gà thịt 10kg',
            'qty': 5,
            'uom': 'Bao',
            'purchase_order': 'PUR-ORD-2026-00001',
          },
        ],
      }),
      (options) async => _json({
        'ok': true,
        'replay': false,
        'result': {
          'erpnext_doc': 'PR-M001',
          'purchase_order': 'PUR-ORD-2026-00001',
          'line_count': 1,
          'docstatus': 0,
        },
      }),
    ));

    expect(find.text('Xác nhận tạo phiếu nhận hàng (NHÁP)'), findsOneWidget);
    expect(find.textContaining('Tạm tính'), findsNothing);

    await tester.tap(find.text('Xác nhận tạo phiếu nhận hàng (NHÁP)'));
    await tester.pumpAndSettle();

    expect(find.text('NHÁP'), findsOneWidget);
    expect(find.text('ĐÃ NỘP'), findsNothing);
    expect(_badgeColor(tester), _schemeAt(tester).tertiaryContainer);
    expect(find.textContaining('Đã tạo phiếu nhận hàng NHÁP: PR-M001'), findsOneWidget);
    expect(find.textContaining('CHƯA cộng kho'), findsOneWidget);
  });

  testWidgets('P9-D: the sales invoice card shows the ORDER prices and a draft button — no revenue, no stock',
      (tester) async {
    // Mirrors the server's E2E: "xuất hoá đơn cho Lan" proposes a DRAFT invoice
    // from a submitted order. UNLIKE the delivery/receipt pair this document
    // carries money, so the lines AND the estimate must show — but the button
    // still promises a NHÁP, because only a submit books revenue.
    await tester.pumpWidget(_hostWithMock(
      _proposal('HIGH', action: 'create_sales_invoice', params: const {
        'sales_order': 'SAL-ORD-2026-00001',
        'line_count': 2,
        'estimated_total_vnd': 2775000,
        'submit_now': false,
        'update_stock': false,
        'lines': [
          {
            'item_code': 'CAM-GA-10KG',
            'item_name': 'Cám gà thịt 10kg',
            'qty': 5,
            'uom': 'Bao',
            'rate': 305000,
            'sales_order': 'SAL-ORD-2026-00001',
          },
          {
            'item_code': 'CAM-HEO-25KG',
            'item_name': 'Cám heo tăng trọng 25kg',
            'qty': 5,
            'uom': 'Bao',
            'rate': 250000,
            'sales_order': 'SAL-ORD-2026-00001',
          },
        ],
      }),
      (options) async => _json({
        'ok': true,
        'replay': false,
        'result': {
          'erpnext_doc': 'SI-M001',
          'sales_order': 'SAL-ORD-2026-00001',
          'lines': const [
            {'item_code': 'CAM-GA-10KG', 'item_name': 'Cám gà thịt 10kg', 'qty': 5, 'uom': 'Bao'},
            {'item_code': 'CAM-HEO-25KG', 'item_name': 'Cám heo tăng trọng 25kg', 'qty': 5, 'uom': 'Bao'},
          ],
          'line_count': 2,
          'docstatus': 0,
          'update_stock': 0,
          // ERPNext's OWN total for the written document — the number the card
          // may quote (it is not our arithmetic).
          'erpnext_grand_total': 2775000,
        },
      }),
    ));

    expect(find.text('Xác nhận tạo hoá đơn (NHÁP)'), findsOneWidget);
    // The price comes from the ORDER, and the card says so out loud.
    expect(find.textContaining('5 Bao · Cám gà thịt 10kg · 305.000đ/dv'), findsOneWidget);
    expect(find.textContaining('Tạm tính: 2.775.000đ'), findsOneWidget);

    await tester.tap(find.text('Xác nhận tạo hoá đơn (NHÁP)'));
    await tester.pumpAndSettle();

    expect(find.text('NHÁP'), findsOneWidget);
    expect(find.text('ĐÃ NỘP'), findsNothing);
    expect(_badgeColor(tester), _schemeAt(tester).tertiaryContainer);
    expect(find.textContaining('Đã tạo hoá đơn NHÁP: SI-M001'), findsOneWidget);
    // Both halves of "draft" for MONEY: nothing booked, and stock untouched.
    expect(find.textContaining('CHƯA ghi doanh thu/công nợ'), findsOneWidget);
    expect(find.textContaining('KHÔNG đụng kho'), findsOneWidget);
    expect(find.textContaining('tổng 2.775.000đ'), findsOneWidget);
  });

  testWidgets(
      'P9-C: a PAY-out card says chi (money OUT), not thu, end to end',
      (tester) async {
    // The card is the same ACTION with a direction on its params — the shape the
    // server returns for "trả tiền NCC Hà Tiên 2 triệu" (p9-pay.test.mjs E2E).
    final pay = ActionProposal.fromJson(<String, dynamic>{
      'schema': 'erpn.proposal/v1',
      'action': 'create_payment_entry',
      'created_at': '2026-09-23T07:40:00.000Z',
      'risk': 'HIGH',
      'risk_display': {'icon': '🔴', 'label': 'Cần xác nhận'},
      'need_confirm': true,
      'need_double_confirm': false,
      'executable': false,
      'entity': {'kind': 'supplier', 'id': 'SUP-HATIEN', 'name': 'Hà Tiên'},
      'params': {
        'direction': 'pay',
        'amount_vnd': 2000000,
        'invoice': 'PINV-0001',
        'outstanding_vnd': 5000000,
        'mode': 'Tiền mặt',
        'submit_now': false,
      },
      'summary': 'Chi 2000000đ cho Hà Tiên cho chứng từ PINV-0001',
    });
    await tester.pumpWidget(_hostWithMock(pay, (options) async =>
        _json({
          'ok': true,
          'replay': false,
          'result': {
            'erpnext_doc': 'PE-M001',
            'paid_vnd': 2000000,
            'direction': 'pay',
            'party_kind': 'supplier',
            'docstatus': 0,
          },
        })));

    // The button must promise what confirming DOES — a pay-out is not "thu tiền".
    expect(find.text('Xác nhận chi tiền (NHÁP)'), findsOneWidget);
    expect(find.text('Xác nhận thu tiền'), findsNothing);

    await tester.tap(find.text('Xác nhận chi tiền (NHÁP)'));
    await tester.pumpAndSettle();

    // Badge rule unchanged (P5): a DRAFT is yellow, never green.
    expect(find.text('NHÁP'), findsOneWidget);
    expect(find.text('ĐÃ NỘP'), findsNothing);
    expect(_badgeColor(tester), _schemeAt(tester).tertiaryContainer);
    expect(find.textContaining('Đã ghi phiếu chi: PE-M001'), findsOneWidget);
    expect(find.textContaining('phiếu thu'), findsNothing);
  });

  testWidgets('P9-C: the receive card is untouched — it still says thu',
      (tester) async {
    await tester.pumpWidget(_hostWithMock(
        _proposal('HIGH', action: 'create_payment_entry'),
        (options) async => _json({
              'ok': true,
              'replay': false,
              'result': {
                'erpnext_doc': 'PE-M002',
                'paid_vnd': 500000,
                'direction': 'receive',
                'party_kind': 'customer',
                'docstatus': 0,
              },
            })));

    expect(find.text('Xác nhận thu tiền'), findsOneWidget);
    await tester.tap(find.text('Xác nhận thu tiền'));
    await tester.pumpAndSettle();
    expect(find.textContaining('Đã ghi phiếu thu: PE-M002'), findsOneWidget);
    expect(find.textContaining('phiếu chi'), findsNothing);
  });

  testWidgets(
      'P9-C: a replay from BEFORE the direction fields keeps the old wording',
      (tester) async {
    // An old card replayed (or a server that predates P9-C) carries no
    // `direction`/`party_kind` — the fallback must not crash or say "phiếu chi".
    await tester.pumpWidget(_hostWithMock(
        _proposal('HIGH', action: 'create_payment_entry'),
        (options) async => _json({
              'ok': true,
              'replay': false,
              'result': {'erpnext_doc': 'PE-M003', 'paid_vnd': 500000, 'docstatus': 0},
            })));
    await tester.tap(find.text('Xác nhận thu tiền'));
    await tester.pumpAndSettle();
    expect(find.textContaining('Đã ghi phiếu thu: PE-M003'), findsOneWidget);
  });

  testWidgets(
      'P9-E: a stock write-off card says NHÁP, names the SLOT+KHO it writes off, '
      'and states the double confirmation', (tester) async {
    // Built from RAW JSON on purpose: `need_double_confirm` is a server field,
    // and the point of this test is that the two-slot condition survives the
    // wire and reaches the shop owner's eyes before they tap.
    final proposal = ActionProposal.fromJson(<String, dynamic>{
      'schema': 'erpn.proposal/v1',
      'action': 'create_stock_adjustment',
      'risk': 'HIGH',
      // The wire shape is the SERVER's (`risk_display` and `entity` are
      // objects) — using flat keys here would leave entityId null, the card
      // would not be confirmable, and the test would "pass" its setup while
      // proving nothing.
      'risk_display': const {'icon': '🔴', 'label': 'Cần xác nhận'},
      'need_confirm': true,
      'need_double_confirm': true,
      'executable': false,
      'entity': const {
        'kind': 'item',
        'id': 'XM-PCB40',
        'name': 'Xi măng PCB40',
      },
      'summary': 'Xuất hủy NHÁP: 1 Bao Xi măng PCB40 ở Kho Hàng Lỗi - MP',
      'params': const {
        'purpose': 'Material Issue',
        'item_code': 'XM-PCB40',
        'qty': 1,
        'uom': 'Bao',
        'warehouse': 'Kho Hàng Lỗi - MP',
        'submit_now': false,
      },
    });

    await tester.pumpWidget(_hostWithMock(
        proposal,
        (options) async => _json({
              'ok': true,
              'replay': false,
              'result': {
                'erpnext_doc': 'MAT-STE-M001',
                'item_code': 'XM-PCB40',
                'qty': 1,
                'uom': 'Bao',
                'warehouse': 'Kho Hàng Lỗi - MP',
                'purpose': 'Material Issue',
                'docstatus': 0,
              },
            })));

    // What is being written off, in the shop's own words.
    expect(find.textContaining('1 Bao Xi măng PCB40 ở Kho Hàng Lỗi - MP'),
        findsOneWidget);
    // The two slots the correctness depends on are called out BEFORE the tap.
    expect(find.textContaining('Xác nhận kép'), findsOneWidget);
    expect(find.textContaining('đúng SỐ LƯỢNG và đúng KHO'), findsOneWidget);
    // The button names the MOVE, not a document type the owner never said.
    expect(find.text('Xác nhận xuất hủy (NHÁP)'), findsOneWidget);

    await tester.tap(find.text('Xác nhận xuất hủy (NHÁP)'));
    await tester.pumpAndSettle();
    // A write-off from chat is a DRAFT: the result must not read as "đã xuất kho".
    expect(find.textContaining('MAT-STE-M001'), findsOneWidget);
    // The DRAFT badge — exact text, because the summary line also contains
    // "NHÁP" and a substring finder would count that as the badge.
    expect(find.text('NHÁP'), findsOneWidget);
    // Found 2026-09-23 while adding M1: this action had NO entry in the success
    // chain, so the result line fell through to the payment fallback and read
    // "Đã ghi phiếu thu: MAT-STE-M001 — ?đ" — money language on a stock
    // document. Pinned now, in both directions.
    expect(find.textContaining('Đã tạo phiếu xuất hủy NHÁP: MAT-STE-M001'),
        findsOneWidget);
    expect(find.textContaining('hàng CHƯA ra khỏi kho'), findsOneWidget);
    expect(find.textContaining('Đã ghi phiếu thu'), findsNothing);
  });

  testWidgets(
      'M1: a customer-create card says "record THẬT" (no NHÁP), claims no money, '
      'and states no auto follow-up', (tester) async {
    // Master data: the ONE write with no draft state. The card must not borrow
    // the payment strings — that is precisely what the label chain and the
    // success chain would have done without the M1 branches.
    final proposal = ActionProposal.fromJson(<String, dynamic>{
      'schema': 'erpn.proposal/v1',
      'action': 'create_customer',
      'risk': 'HIGH',
      'risk_display': const {'icon': '🔴', 'label': 'Cần xác nhận'},
      'need_confirm': true,
      'need_double_confirm': false,
      'executable': false,
      // `entity.id` is the BUSINESS KEY (the name) — no ERPNext id exists until
      // the record is written, which is what makes this write different.
      'entity': const {'kind': 'customer', 'id': 'Nguyễn Văn M1', 'name': 'Nguyễn Văn M1'},
      'summary': 'Tạo khách hàng MỚI: Nguyễn Văn M1 · SĐT 0901234567',
      'params': const {
        'customer_name': 'Nguyễn Văn M1',
        'mobile_no': '0901234567',
      },
    });

    await tester.pumpWidget(_hostWithMock(
        proposal,
        (options) async => _json({
              'ok': true,
              'replay': false,
              'result': {
                'erpnext_doc': 'CUST-M001',
                'customer': 'CUST-M001',
                'customer_name': 'Nguyễn Văn M1',
                'mobile_no': '0901234567',
                'docstatus': 0,
              },
            })));

    // The button names the RECORD, not a document type and not money.
    expect(find.text('Xác nhận tạo khách hàng (record thật)'), findsOneWidget);
    expect(find.text('Xác nhận thu tiền'), findsNothing);

    await tester.tap(find.text('Xác nhận tạo khách hàng (record thật)'));
    await tester.pumpAndSettle();
    expect(
        find.textContaining('Đã tạo khách hàng: Nguyễn Văn M1 (CUST-M001)'),
        findsOneWidget);
    expect(find.textContaining('record THẬT'), findsOneWidget);
    // Policy §5 default: the next sentence decides — never an auto order/payment.
    expect(find.textContaining('KHÔNG tự tạo đơn/phiếu thu'), findsOneWidget);
    // The money-language trap, asserted in the negative.
    expect(find.textContaining('Đã ghi phiếu thu'), findsNothing);
  });

  testWidgets(
      'P9-F: a return card names the ORIGINAL invoice, prices from it, and promises a NHÁP',
      (tester) async {
    // Mirrors the server's E2E: "trả hàng 2 bao cám heo theo hoá đơn ACC-SINV-…"
    // proposes a DRAFT Sales Invoice with is_return=1. The number the owner SAW
    // in the sentence is shown POSITIVE (the sign is the server's business) and
    // the price is the INVOICE's — the card must never invent either.
    final proposal = ActionProposal.fromJson(<String, dynamic>{
      'schema': 'erpn.proposal/v1',
      'action': 'create_sales_return',
      'risk': 'HIGH',
      'risk_display': const {'icon': '🔴', 'label': 'Cần xác nhận'},
      'need_confirm': true,
      'need_double_confirm': false,
      'executable': false,
      'entity': const {
        'kind': 'customer',
        'id': 'CUST-00001',
        'name': 'Nguyễn Thị Lan',
      },
      'summary':
          'Khách trả hàng NHÁP theo hoá đơn ACC-SINV-2026-00049: 2 Bao Cám heo tăng trọng 25kg',
      'params': const {
        'return_against': 'ACC-SINV-2026-00049',
        'entry_type': 'credit_note',
        'update_stock': 1,
        'submit_now': false,
        'line_count': 1,
        'estimated_total_vnd': 640000,
        'lines': [
          {
            'item_code': 'CAM-HEO-25KG',
            'item_name': 'Cám heo tăng trọng 25kg',
            'qty': 2,
            'uom': 'Bao',
            'rate': 320000,
            'amount': 640000,
            'return_against': 'ACC-SINV-2026-00049',
          },
        ],
      },
    });

    await tester.pumpWidget(_hostWithMock(
      proposal,
      (options) async => _json({
        'ok': true,
        'replay': false,
        'result': {
          'erpnext_doc': 'SI-M002',
          'return_against': 'ACC-SINV-2026-00049',
          'is_return': 1,
          'update_stock': 1,
          'lines': const [
            {
              'item_code': 'CAM-HEO-25KG',
              'item_name': 'Cám heo tăng trọng 25kg',
              'qty': 2,
              'uom': 'Bao',
              'rate': 320000,
            },
          ],
          'line_count': 1,
          'docstatus': 0,
          // ERPNext's OWN total for the written document.
          'erpnext_grand_total': 640000,
        },
      }),
    ));

    // WHICH invoice the goods go back against — the whole reference.
    expect(find.textContaining('ACC-SINV-2026-00049'), findsOneWidget);
    // The price is the INVOICE's, and the card says so.
    expect(find.textContaining('2 Bao · Cám heo tăng trọng 25kg · 320.000đ/dv'),
        findsOneWidget);
    expect(find.textContaining('Tạm tính: 640.000đ'), findsOneWidget);
    // The button names the REVERSAL, never a document type the owner never said.
    expect(find.text('Xác nhận trả hàng (NHÁP)'), findsOneWidget);

    await tester.tap(find.text('Xác nhận trả hàng (NHÁP)'));
    await tester.pumpAndSettle();

    expect(find.text('NHÁP'), findsOneWidget);
    expect(find.text('ĐÃ NỘP'), findsNothing);
    // A return is the OPPOSITE of a sale: the result may not read like revenue,
    // and it must say the goods are NOT back in stock yet.
    expect(find.textContaining('Đã tạo phiếu trả hàng NHÁP: SI-M002'), findsOneWidget);
    expect(find.textContaining('CHƯA nhận lại kho'), findsOneWidget);
    expect(find.textContaining('CHƯA ghi công nợ'), findsOneWidget);
    expect(find.textContaining('tổng 640.000đ'), findsOneWidget);
  });
}
