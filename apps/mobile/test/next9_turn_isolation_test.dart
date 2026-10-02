// next9 DEBUG probe — Turn-2 bubble reusing Turn-1's confirmed card state
// (plan-debug.md Symptom B).
/*
 *
 * Mirrors the real screen: `ListView.builder(itemBuilder: (c, i) =>
 * ChatBubble(key: ValueKey(turns[i].key), turn: turns[i]))`
 * (chat_screen.dart), where every card is a StatefulWidget keeping its outcome
 * locally (proposal_card.dart `_result`, customer_offer_card.dart `_result`).
 *
 * Why the key matters: `ChatHistoryService.trimTurns` DROPS the oldest turn as
 * soon as the history passes `maxChatItems` (user-configurable, floor 5), so
 * the list shifts. Without a key Flutter matches children by INDEX, the
 * ProposalCard element of one turn is updated with ANOTHER turn's proposal
 * (same runtime type), and its locally-held outcome — "Đã tạo khách hàng: Lê
 * Lợi" — renders on the wrong customer's card. FALSIFIED 2026-09-28 (after
 * `flutter pub get` restored the toolchain): with the key line commented out
 * this test fails with exactly the leak below; with the key it passes. The
 * pre-fix behaviour is therefore MEASURED, no longer a hypothesis.
 *
 * It writes nothing and needs no network except the mocked /execute below.
 */
import 'dart:convert';
import 'dart:typed_data';

import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:erpn_mobile/app/providers.dart';
import 'package:erpn_mobile/features/chat/data/chat_history_service.dart';
import 'package:erpn_mobile/features/chat/data/chat_models.dart';
import 'package:erpn_mobile/features/chat/presentation/widgets/chat_bubble.dart';
import 'package:erpn_mobile/features/chat/presentation/widgets/proposal_card.dart';

class _MockAdapter implements HttpClientAdapter {
  _MockAdapter(this.handler);
  final Future<ResponseBody> Function(RequestOptions o) handler;
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

ActionProposal _createCustomerCard(String name, String entityId) => ActionProposal(
      schema: 'erpn.proposal/v1',
      action: 'create_customer',
      risk: 'HIGH',
      riskIcon: '🔴',
      riskLabel: 'Cần xác nhận',
      needConfirm: true,
      needDoubleConfirm: false,
      executable: false,
      entityKind: 'customer',
      entityId: entityId,
      entityName: name,
      summary: 'Tạo khách hàng: $name',
      params: {'customer_name': name},
    );

ChatTurn _plainTurn(String question, String answer) => ChatTurn(
      question: question,
      answer: answer,
      ok: true,
      ts: DateTime(2026, 9, 28),
    );

ChatTurn _cardTurn(String question, ActionProposal p) => ChatTurn(
      question: question,
      answer: 'Đề xuất tạo khách hàng ${p.entityName}',
      ok: true,
      ts: DateTime(2026, 9, 28),
      proposal: p,
    );

void main() {
  // prompt-1 §12 — the identity must be unique, index-independent, and stable
  // across a rebuild AND across a serialize/restore round trip (the same value
  // after a restart is what keeps a restored card attached to its own turn).
  test('ChatTurn.key is unique, index-independent, and survives a restore', () {
    final a = _plainTurn('công nợ của chị Lan', 'Nợ 2.500.000đ');
    final b = _plainTurn('còn hàng không', 'Còn 12 bao');
    // Different questions, SAME timestamp: uniqueness may not come from the
    // clock alone.
    expect(a.ts, b.ts);
    expect(a.key, isNot(b.key));

    final restoredA = ChatTurn.fromJson(jsonDecode(jsonEncode(a.toJson())));
    expect(restoredA.key, a.key, reason: 'a restored turn must keep its identity');
    expect(restoredA.question, a.question);
    expect(restoredA.ts, a.ts);

    // Rebuilding the list (same turns, fresh list instance) must not change a
    // key, and a trim must not renumber anyone: the surviving keys are
    // literally the same strings, not positions.
    final before = [a, b].map((t) => t.key).toList();
    expect(before.toSet().length, 2, reason: 'keys are unique');
    final x = _plainTurn('x', 'y');
    final trimmed = ChatHistoryService.trimTurns([a, b, x], 2)
        .map((t) => t.key)
        .toList();
    // trimTurns keeps the NEWEST turns (plus any pending proposal) — what this
    // asserts is that the survivors keep their own literal keys, never a
    // renumbered position.
    expect(trimmed, [b.key, x.key]);
    expect(trimmed, isNot(contains(a.key)));
  });

  testWidgets(
    'a confirmed card never shows its outcome on ANOTHER turn\'s card after the list shifts',
    (tester) async {
      final turns = ValueNotifier<List<ChatTurn>>([
        _plainTurn('công nợ của chị Lan', 'Nguyễn Thị Lan còn nợ 2.500.000đ'),
        _cardTurn('thêm khách Lê Lợi', _createCustomerCard('Lê Lợi', 'CUST-M001')),
        _cardTurn('thêm khách Bảy', _createCustomerCard('Bảy', 'CUST-M002')),
      ]);

      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            sharedPreferencesProvider.overrideWithValue(null),
            dioProvider.overrideWith((ref) {
              final dio = Dio(BaseOptions(baseUrl: 'http://mock'));
              dio.httpClientAdapter = _MockAdapter(
                (o) async => _json({
                  'ok': true,
                  'result': {
                    'erpnext_doc': 'CUST-M001',
                    'customer_name': 'Lê Lợi',
                  },
                }),
              );
              return dio;
            }),
          ],
          child: MaterialApp(
            home: Scaffold(
              // EXACTLY the screen's list: keyed by the turn's own identity.
              body: ValueListenableBuilder<List<ChatTurn>>(
                valueListenable: turns,
                builder: (context, list, _) => ListView.builder(
                  itemCount: list.length,
                  itemBuilder: (context, i) => ChatBubble(
                    key: ValueKey(list[i].key),
                    turn: list[i],
                  ),
                ),
              ),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();

      // Confirm the Lê Lợi card (index 1) — its State now owns the outcome.
      // Scoped to THAT card: both cards carry the same button label, so a global
      // finder is ambiguous (and tapping the wrong one would prove nothing).
      final leLoiCard = find.byWidgetPredicate(
        (w) => w is ProposalCard && w.proposal.entityId == 'CUST-M001',
      );
      expect(leLoiCard, findsOneWidget);
      await tester.tap(
        find.descendant(
          of: leLoiCard,
          matching: find.text('Xác nhận tạo khách hàng (record thật)'),
        ),
      );
      await tester.pumpAndSettle();
      expect(
        find.textContaining('Đã tạo khách hàng: Lê Lợi'),
        findsOneWidget,
        reason: 'the confirmed card should show its own outcome first',
      );

      // The history hits the cap: trimTurns drops the oldest non-pending turn
      // and appends the new one — the SAME shift the real controller performs.
      turns.value = ChatHistoryService.trimTurns([
        ...turns.value,
        _plainTurn('còn hàng không', 'Còn 12 bao'),
      ], 2);

      await tester.pumpAndSettle();

      final otherCard = find.byWidgetPredicate(
        (w) => w is ProposalCard && w.proposal.entityId == 'CUST-M002',
      );
      expect(otherCard, findsOneWidget, reason: 'the other card must still be on screen');
      expect(
        find.descendant(
          of: otherCard,
          matching: find.textContaining('Đã tạo khách hàng: Lê Lợi'),
        ),
        findsNothing,
        reason: 'Turn-1 (Lê Lợi) outcome leaked onto the OTHER customer\'s card',
      );
    },
  );
}
