import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:erpn_mobile/features/chat/data/chat_models.dart';
import 'package:erpn_mobile/features/chat/presentation/widgets/proposal_card.dart';

ActionProposal _proposal(String risk, {bool doubleConfirm = false}) {
  final needConfirm = risk != 'READ';
  return ActionProposal(
    schema: 'erpn.proposal/v1',
    action: 'read_balance',
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
}
