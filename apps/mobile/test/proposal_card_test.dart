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

  testWidgets('server replay response shows the anti-duplicate message',
      (tester) async {
    await tester.pumpWidget(
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

  testWidgets('READ and CRITICAL cards still have NO button (display-only)',
      (tester) async {
    await tester.pumpWidget(_host(_proposal('READ')));
    expect(find.byType(FilledButton), findsNothing);
    await tester.pumpWidget(_host(_proposal('CRITICAL', doubleConfirm: true)));
    expect(find.byType(FilledButton), findsNothing);
  });
}
