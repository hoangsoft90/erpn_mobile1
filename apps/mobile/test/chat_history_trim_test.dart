import 'dart:convert';
import 'dart:typed_data';

import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:erpn_mobile/app/providers.dart';
import 'package:erpn_mobile/core/constants/app_constants.dart';
import 'package:erpn_mobile/features/chat/application/chat_controller.dart';
import 'package:erpn_mobile/features/chat/data/chat_history_service.dart';
import 'package:erpn_mobile/features/chat/data/chat_models.dart';
import 'package:erpn_mobile/features/chat/data/copilot_api_client.dart';

/// ---------------------------------------------------------------------------
/// B.2 (2026-09-16) — chat history cap.
///
/// Two contracts under test:
///   1. At most `maxChatItems` turns are kept, oldest dropped first.
///   2. SAFETY: a turn carrying a PENDING action proposal is NEVER dropped,
///      however old it is — the visible record of a write intent must not
///      vanish because the chat scrolled past the cap. This one is falsified
///      in the session evidence (remove the exception → these tests go red).
/// ---------------------------------------------------------------------------

ActionProposal _paymentProposal() => const ActionProposal(
      schema: 'erpn.proposal/v1',
      action: 'create_payment_entry',
      risk: 'HIGH',
      riskIcon: '🟠',
      riskLabel: 'Cao',
      needConfirm: true,
      needDoubleConfirm: false,
      executable: true,
      entityKind: 'customer',
      entityId: 'CUST-001',
      entityName: 'Nguyễn Thị Lan',
    );

/// The same card, but already refused: terminal, therefore trimmable.
ActionProposal _rejectedProposal() => const ActionProposal(
      schema: 'erpn.proposal/v1',
      action: 'create_payment_entry',
      risk: 'HIGH',
      riskIcon: '🟠',
      riskLabel: 'Cao',
      needConfirm: true,
      needDoubleConfirm: false,
      executable: true,
      entityKind: 'customer',
      entityId: 'CUST-001',
      entityName: 'Nguyễn Thị Lan',
      rejectionCode: 'PROPOSAL_STALE',
      rejectionProblems: ['nợ đã đổi'],
    );

ChatTurn _readTurn(int i) => ChatTurn(
      question: 'câu hỏi $i',
      answer: 'trả lời $i',
      ok: true,
      ts: DateTime(2026, 9, 16).add(Duration(minutes: i)),
    );

/// Minimal SharedPreferences fake (no plugin channel in unit tests).
class _FakePrefs implements SharedPreferences {
  final Map<String, Object> store = {};

  @override
  dynamic noSuchMethod(Invocation invocation) {
    final args = invocation.positionalArguments;
    if (invocation.memberName == #getString && args.length == 1) {
      return store[args.first as String];
    }
    if (invocation.memberName == #getInt && args.length == 1) {
      return store[args.first as String] as int?;
    }
    if (invocation.memberName == #setString && args.length == 2) {
      store[args[0] as String] = args[1] as Object;
      return Future<bool>.value(true);
    }
    if (invocation.memberName == #setInt && args.length == 2) {
      store[args[0] as String] = args[1] as Object;
      return Future<bool>.value(true);
    }
    if (invocation.memberName == #remove && args.length == 1) {
      store.remove(args.first as String);
      return Future<bool>.value(true);
    }
    return null;
  }
}

class _MockAdapter implements HttpClientAdapter {
  _MockAdapter(this.handler);
  final Future<ResponseBody> Function(RequestOptions options) handler;

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

void main() {
  group('trimTurns (pure rule)', () {
    test('>cap plain read turns -> only the newest `cap` survive', () {
      final turns = List.generate(25, _readTurn); // oldest -> newest
      final kept = ChatHistoryService.trimTurns(turns, 20);
      expect(kept.length, 20);
      expect(kept.first.question, 'câu hỏi 5');
      expect(kept.last.question, 'câu hỏi 24');
    });

    test('a PENDING proposal at turn #1 survives 25 later reads (safety)', () {
      final pending = ChatTurn(
        question: 'thu tiền cho chị Lan 500 ngàn',
        answer: 'Đề xuất thu 500.000đ',
        ok: true,
        ts: DateTime(2026, 9, 16),
        proposal: _paymentProposal(),
      );
      expect(pending.hasPendingProposal, isTrue);

      final turns = <ChatTurn>[pending, ...List.generate(25, (i) => _readTurn(i))];
      final kept = ChatHistoryService.trimTurns(turns, 20);

      expect(kept.length, 21, reason: '20 newest + the pending proposal');
      expect(kept.first.question, 'thu tiền cho chị Lan 500 ngàn',
          reason: 'the pending write intent must never be trimmed');
      expect(kept.any((t) => t.hasPendingProposal), isTrue);
    });

    test('a REFUSED proposal is terminal -> trimmable', () {
      final refused = ChatTurn(
        question: 'thu tiền cho chị Lan 500 ngàn',
        answer: 'Đề xuất thu 500.000đ',
        ok: true,
        ts: DateTime(2026, 9, 16),
        proposal: _rejectedProposal(),
      );
      expect(refused.hasPendingProposal, isFalse);
      final kept =
          ChatHistoryService.trimTurns([refused, ...List.generate(25, _readTurn)], 20);
      expect(kept.length, 20);
      expect(kept.any((t) => t.proposal != null), isFalse);
    });

    test('a display-only LOW proposal is trimmable', () {
      const low = ActionProposal(
        schema: 'erpn.proposal/v1',
        action: 'view_customer',
        risk: 'LOW',
        riskIcon: '🟡',
        riskLabel: 'Thấp',
        needConfirm: false,
        needDoubleConfirm: false,
        executable: false,
        entityKind: 'customer',
        entityId: 'CUST-001',
      );
      final turn = ChatTurn(
        question: 'xem khách',
        answer: 'ok',
        ok: true,
        ts: DateTime(2026, 9, 16),
        proposal: low,
      );
      expect(turn.hasPendingProposal, isFalse);
      final kept = ChatHistoryService.trimTurns(
          [turn, ...List.generate(25, _readTurn)], 20);
      expect(kept.length, 20);
      expect(kept.any((t) => t.proposal != null), isFalse);
    });

    test('under the cap -> unchanged', () {
      final turns = List.generate(5, _readTurn);
      final kept = ChatHistoryService.trimTurns(turns, 20);
      expect(identical(kept, turns), isTrue);
    });
  });

  group('ChatHistoryService.save honours maxItems', () {
    test('persists only the trimmed list', () async {
      final prefs = _FakePrefs();
      final service = ChatHistoryService(prefs: prefs);
      await service.save(
        List.generate(25, _readTurn),
        maxItems: 20,
      );
      final raw = prefs.store[AppConstants.chatHistoryStorageKey] as String;
      final stored = (jsonDecode(raw) as List).cast<Map<String, dynamic>>();
      expect(stored.length, 20);
      expect(stored.first['question'], 'câu hỏi 5');
    });

    test('keeps a pending proposal that is older than the cap', () async {
      final prefs = _FakePrefs();
      final service = ChatHistoryService(prefs: prefs);
      final pending = ChatTurn(
        question: 'thu tiền',
        answer: 'proposal',
        ok: true,
        ts: DateTime(2026, 9, 16),
        proposal: _paymentProposal(),
      );
      await service.save(
        [pending, ...List.generate(25, _readTurn)],
        maxItems: 20,
      );
      final raw = prefs.store[AppConstants.chatHistoryStorageKey] as String;
      final stored = (jsonDecode(raw) as List).cast<Map<String, dynamic>>();
      expect(stored.length, 21);
      expect(stored.first['question'], 'thu tiền');
    });
  });

  group('controller applies the cap end-to-end', () {
    test('25 reads with cap 5 keep 5; a pending proposal at #1 survives', () async {
      final prefs = _FakePrefs();
      await prefs.setInt('settings_max_chat_items_v1', 5);

      var call = 0;
      final container = ProviderContainer(
        overrides: [
          sharedPreferencesProvider.overrideWithValue(prefs),
          copilotApiClientProvider.overrideWithValue(
            CopilotApiClient(
              dio: Dio(BaseOptions(baseUrl: 'http://mock.local'))
                ..httpClientAdapter = _MockAdapter((options) async {
                  // First answer carries a confirmable HIGH proposal; the rest
                  // are plain reads.
                  final first = call++ == 0;
                  return _json({
                    'ok': true,
                    'result': {
                      'question': 'q',
                      'answer': 'a',
                      'routed': {'group': 'customer', 'matched': 'còn nợ'},
                      if (first)
                        'proposal': {
                          'schema': 'erpn.proposal/v1',
                          'action': 'create_payment_entry',
                          'risk': 'HIGH',
                          'entity': {
                            'kind': 'customer',
                            'id': 'CUST-001',
                            'name': 'Lan',
                          },
                          'need_confirm': true,
                        },
                    },
                  });
                }),
            ),
          ),
        ],
      );
      addTearDown(container.dispose);

      container.listen(chatControllerProvider, (_, _) {}, fireImmediately: true);
      await container.read(chatControllerProvider.future);
      final controller = container.read(chatControllerProvider.notifier);

      await controller.send('thu tiền cho chị Lan 500 ngàn'); // turn #1, pending
      for (var i = 0; i < 25; i++) {
        await controller.send('câu đọc $i');
      }

      final turns = container.read(chatControllerProvider).value!.turns;
      expect(turns.length, 6, reason: 'cap 5 + the pending proposal at #1');
      expect(turns.first.question, 'thu tiền cho chị Lan 500 ngàn');
      expect(turns.first.hasPendingProposal, isTrue);

      // …and the SAME trimmed list is what was persisted.
      final raw = prefs.store[AppConstants.chatHistoryStorageKey] as String;
      final stored = (jsonDecode(raw) as List).cast<Map<String, dynamic>>();
      expect(stored.length, 6);
      expect(stored.first['question'], 'thu tiền cho chị Lan 500 ngàn');
    });
  });

  group('attachRejection must not delete the card being refused', () {
    test('a just-refused card stays visible even when it is the oldest',
        () async {
      // Review finding: trimming inside attachRejection would drop the card
      // the user JUST tried to confirm (rejection clears hasPendingProposal,
      // and that card is usually the oldest). The refusal reason must stay on
      // screen — that is the whole point of the Phase 9 banner.
      final prefs = _FakePrefs();
      final pending = ChatTurn(
        question: 'thu tiền cho chị Lan 500 ngàn',
        answer: 'proposal',
        ok: true,
        ts: DateTime(2026, 9, 16),
        proposal: _paymentProposal(),
      );
      final seeded = <ChatTurn>[pending, ...List.generate(5, _readTurn)];
      await prefs.setInt(AppConstants.maxChatItemsStorageKey, 5);
      await prefs.setString(
        AppConstants.chatHistoryStorageKey,
        jsonEncode(seeded.map((t) => t.toJson()).toList()),
      );

      final container = ProviderContainer(
        overrides: [sharedPreferencesProvider.overrideWithValue(prefs)],
      );
      addTearDown(container.dispose);
      container.listen(chatControllerProvider, (_, _) {}, fireImmediately: true);
      await container.read(chatControllerProvider.future);

      final before = container.read(chatControllerProvider).value!.turns;
      expect(before.length, 6);
      final target = before.first.proposal!;

      await container.read(chatControllerProvider.notifier).attachRejection(
            target,
            code: 'PROPOSAL_STALE',
            problems: const ['nợ đã đổi'],
          );

      final after = container.read(chatControllerProvider).value!.turns;
      expect(after.length, 6, reason: 'refusing a card must not evict it');
      expect(after.first.question, 'thu tiền cho chị Lan 500 ngàn');
      expect(after.first.proposal!.rejectionCode, 'PROPOSAL_STALE');
    });
  });
}
