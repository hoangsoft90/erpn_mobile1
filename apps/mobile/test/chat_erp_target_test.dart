import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:erpn_mobile/app/theme/app_theme.dart';
import 'package:erpn_mobile/features/chat/data/chat_models.dart';
import 'package:erpn_mobile/features/chat/presentation/widgets/chat_bubble.dart';

// issue3 — the bubble labels WHERE the answer's data came from, on every turn
// (/ask and /dsh/ask alike). The API field is the server's `erp_target`
// (`REAL` / `MOCK`); MOCK is DISPLAYED as SMOKE, and a null label is shown as
// "không rõ" — never upgraded to REAL (the same rule as the drawer's D0.5
// provenance gate).

ChatTurn _turn(String? erpTarget, {String? routedGroup}) => ChatTurn(
      question: 'chị Lan còn nợ bao nhiêu',
      answer: 'Nguyễn Thị Lan còn nợ 2.500.000đ (1 chứng từ chưa thanh toán).',
      ok: true,
      ts: DateTime.parse('2026-09-26T10:00:00.000'),
      routedGroup: routedGroup,
      erpTarget: erpTarget,
    );

Future<void> _pumpBubble(WidgetTester tester, ChatTurn turn) async {
  await tester.pumpWidget(
    MaterialApp(
      theme: AppTheme.light(),
      home: Scaffold(body: ChatBubble(turn: turn)),
    ),
  );
  await tester.pumpAndSettle();
}

void main() {
  testWidgets('erpTarget REAL shows "nguồn: REAL"', (tester) async {
    await _pumpBubble(tester, _turn('REAL'));
    expect(find.byKey(const ValueKey('chat-erp-target')), findsOneWidget);
    expect(find.text('nguồn: REAL'), findsOneWidget);
    expect(find.text('nguồn: SMOKE'), findsNothing);
  });

  testWidgets('erpTarget MOCK is DISPLAYED as SMOKE (JSON keeps MOCK)', (tester) async {
    await _pumpBubble(tester, _turn('MOCK'));
    expect(find.text('nguồn: SMOKE'), findsOneWidget);
    expect(find.text('nguồn: REAL'), findsNothing);
  });

  testWidgets('null erpTarget shows "nguồn: không rõ" — never an assumed REAL',
      (tester) async {
    await _pumpBubble(tester, _turn(null));
    expect(find.text('nguồn: không rõ'), findsOneWidget);
    expect(find.text('nguồn: REAL'), findsNothing);
    expect(find.text('nguồn: SMOKE'), findsNothing);
  });

  testWidgets('route meta and provenance line coexist', (tester) async {
    await _pumpBubble(tester, _turn('REAL', routedGroup: 'customer'));
    expect(find.text('route: customer'), findsOneWidget);
    expect(find.text('nguồn: REAL'), findsOneWidget);
  });

  testWidgets('dsh turn with MOCK renders SMOKE under route: dsh', (tester) async {
    await _pumpBubble(tester, _turn('MOCK', routedGroup: 'dsh'));
    expect(find.text('route: dsh'), findsOneWidget);
    expect(find.text('nguồn: SMOKE'), findsOneWidget);
  });
}
