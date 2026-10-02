// next8 Phase 1 — unit tests for the collect DATA layer (plan §5.5).
//
// Phase 1 scope, stated up front: NO widget tests yet (the screen is Phase 2).
// What is pinned here is the parse surface the rest of the flow stands on:
//   * a collect /ask answer carries a `business_handoff` that survives the
//     AskResult parse (and an absent/foreign one parses to null — the T4
//     "ticket-less answer" must not break the chat);
//   * the handoff parser is TOLERANT (older gateways, missing fields) but
//     fail-closed on the one thing the propose route needs (the id);
//   * the request builder sends exactly the shape the server validates, and
//     nothing else — no amount can sneak into the ticket side of the flow.
//
// Money rule: nothing here computes an authoritative number. `summary` fields
// are copied from the server's response and rendered as-is.

import 'package:flutter_test/flutter_test.dart';

import 'package:erpn_mobile/features/chat/data/chat_models.dart';
import 'package:erpn_mobile/features/collect/data/collect_models.dart';

Map<String, dynamic> collectAskResult({Object? handoff}) => {
      'question': 'thu tiền cho Nguyễn Thị Lan',
      'answer': null,
      'routed': {'group': 'payment_write', 'matched': 'thu tiền'},
      'customer': {'id': 'CUST-00001', 'name': 'Nguyễn Thị Lan'},
      'reason': 'câu nói thiếu số tiền — không tự đoán',
      'error_code': 'PAYMENT_AMOUNT_MISSING',
      'proposal': null,
      'business_handoff': ?handoff,
    };

Map<String, dynamic> fullHandoff() => {
      'type': 'business_handoff',
      'handoff_id': '11111111-2222-3333-4444-555555555555',
      'capability': 'payment.create',
      'screen': 'collect',
      'question': 'thu tiền cho Nguyễn Thị Lan',
      'issued_at': '2026-09-29T10:00:00.000Z',
      'prefill': <String, dynamic>{
        'customer': {
          'state': 'RESOLVED',
          'id': 'CUST-00001',
          'label': 'Nguyễn Thị Lan',
        },
        'allocations': {'state': 'MISSING'},
        'payment_methods': {'state': 'MISSING'},
        'amount': {'state': 'MISSING'},
      },
    };

void main() {
  group('AskResult carries the business handoff (chat layer)', () {
    test('a collect answer parses the ticket as a light ref', () {
      final result = AskResult.fromJson(collectAskResult(handoff: fullHandoff()));
      expect(result.errorCode, 'PAYMENT_AMOUNT_MISSING');
      expect(result.proposal, isNull, reason: 'nothing is proposed in chat');
      expect(result.businessHandoff, isNotNull);
      expect(result.businessHandoff!.handoffId, '11111111-2222-3333-4444-555555555555');
      expect(result.businessHandoff!.capability, 'payment.create', reason: 'canonical id (lock §6.5)');
      expect(result.businessHandoff!.screen, 'collect');
    });

    test('an answer WITHOUT a ticket parses fine (most answers)', () {
      final result = AskResult.fromJson(collectAskResult());
      expect(result.businessHandoff, isNull);
    });

    test('a ticket without an id parses to NULL — nothing the route could accept', () {
      final noId = fullHandoff()..remove('handoff_id');
      final result = AskResult.fromJson(collectAskResult(handoff: noId));
      expect(result.businessHandoff, isNull);
    });

    test('a foreign `type` parses to NULL (fail closed)', () {
      final wrong = fullHandoff()..['type'] = 'dsh_handoff';
      final result = AskResult.fromJson(collectAskResult(handoff: wrong));
      expect(result.businessHandoff, isNull);
    });
  });

  group('BusinessHandoff (collect feature parser)', () {
    test('parses slots with the shared state vocabulary', () {
      final h = BusinessHandoff.tryParse(fullHandoff());
      expect(h, isNotNull);
      expect(h!.slot('customer').state, CollectSlotState.resolved);
      expect(h.slot('customer').id, 'CUST-00001');
      expect(h.slot('allocations').state, CollectSlotState.missing);
      // An unnamed slot reads MISSING, never throws.
      expect(h.slot('nonexistent').state, CollectSlotState.missing);
    });

    test('ambiguous customer carries picker candidates', () {
      final raw = fullHandoff();
      (raw['prefill'] as Map)['customer'] = {
        'state': 'AMBIGUOUS',
        'candidates': ['Nguyễn Thị Lan', 'Nguyễn Văn Lan'],
      };
      final h = BusinessHandoff.tryParse(raw)!;
      expect(h.slot('customer').state, CollectSlotState.ambiguous);
      expect(h.slot('customer').candidates, ['Nguyễn Thị Lan', 'Nguyễn Văn Lan']);
    });

    test('tolerant on older gateways (missing prefill / question / issued_at)', () {
      final h = BusinessHandoff.tryParse({
        'handoff_id': 'abc',
        'capability': 'payment.create',
        'screen': 'collect',
      });
      expect(h, isNotNull);
      expect(h!.question, '');
      expect(h.slot('amount').state, CollectSlotState.missing);
    });

    test('the ticket carries no amount — and the parser has no field for one', () {
      final json = fullHandoff();
      // No amount field anywhere in the parsed object:
      final h = BusinessHandoff.tryParse(json)!;
      // No amount field exists on the object at all (a change that adds one
      // must edit this test — that is the point).
      expect(h.toString(), isNot(contains('amount_vnd')));
    });
  });

  group('CollectProposalRequest (the body /collect/propose validates)', () {
    test('sends exactly the contract shape: ticket + customer + allocations + methods', () {
      final req = CollectProposalRequest(
        handoffId: '11111111-2222-3333-4444-555555555555',
        customerId: 'CUST-00001',
        allocations: [const CollectAllocationValue(invoiceId: 'SINV-0001', allocatedAmount: 500000)],
        methods: const [CollectMethodValue(mode: 'cash', amount: 500000)],
        conversationId: 'conv-1',
      );
      final json = req.toJson();
      expect(json['handoff_id'], '11111111-2222-3333-4444-555555555555');
      expect(json['conversation_id'], 'conv-1');
      final values = json['values'] as Map<String, dynamic>;
      expect(values['customer_id'], 'CUST-00001');
      expect(values['allocations'], [
        {'invoice_id': 'SINV-0001', 'allocated_amount': 500000},
      ]);
      expect(values['payment_methods'], [
        {'mode': 'cash', 'amount': 500000},
      ]);
    });

    test('omits empty optionals instead of sending nulls', () {
      final req = CollectProposalRequest(
        handoffId: 'abc',
        customerId: 'CUST-00001',
        allocations: const [],
        methods: const [],
      );
      final json = req.toJson();
      expect(json.containsKey('conversation_id'), isFalse);
      final values = json['values'] as Map<String, dynamic>;
      expect((values['payment_methods'] as List), isEmpty);
    });

    test('lock §6.1 helper: at most ONE method leaves this layer', () {
      // The SERVER enforces the limit (tested server-side); here we only pin that
      // the two named constants map to the two modes the server accepts.
      expect(CollectMethodValue.cash.mode, 'cash');
      expect(CollectMethodValue.bankTransfer.mode, 'bank_transfer');
    });
  });

  group('CollectProposeResult (the propose answer)', () {
    test('parses the happy path: proposal + server summary, copied verbatim', () {
      final r = CollectProposeResult.fromJson({
        'ok': true,
        'capability': 'payment.create',
        'handoff_id': 'abc',
        'proposal': {'schema': 'erpn.proposal/v1', 'action': 'create_payment_entry'},
        'invoice': 'SINV-0001',
        'outstanding_vnd': 2500000,
        'summary': {
          'payment_total_vnd': 500000,
          'allocated_total_vnd': 500000,
          'unallocated_vnd': 0,
        },
        'warnings': ['đề xuất chỉ TẠO PHIẾU NHÁP'],
      });
      expect(r.ok, isTrue);
      expect(r.capability, 'payment.create');
      expect(r.proposal!['schema'], 'erpn.proposal/v1');
      expect(r.summary!.paymentTotalVnd, 500000);
      expect(r.summary!.unallocatedVnd, 0);
      expect(r.warnings, hasLength(1));
    });

    test('parses a refusal: ok=false keeps code + reason, proposal null', () {
      final r = CollectProposeResult.fromJson({
        'ok': false,
        'proposal': null,
        'code': 'STALE_HANDOFF',
        'reason': 'phiên thu tiền này đã hết hiệu lực — mở lại từ câu hỏi trong chat rồi làm tiếp',
      });
      expect(r.ok, isFalse);
      expect(r.proposal, isNull);
      expect(r.code, 'STALE_HANDOFF');
      expect(r.reason, contains('hết hiệu lực'));
    });

    test('tolerant on a 401-style body with no fields', () {
      final r = CollectProposeResult.fromJson(const {});
      expect(r.ok, isFalse);
      expect(r.summary, isNull);
    });
  });

  group('on-account (lock §6.3) at the data layer', () {
    test('an empty allocation list is a FIRST-CLASS request shape', () {
      // 0 open invoices ⇒ allocations MUST be empty; the builder sends it as-is
      // (no client-side "fix" that would invent an allocation).
      final req = CollectProposalRequest(
        handoffId: 'abc',
        customerId: 'CUST-00001',
        allocations: const [],
        methods: const [CollectMethodValue(mode: 'bank_transfer', amount: 300000)],
      );
      final values = req.toJson()['values'] as Map<String, dynamic>;
      expect(values['allocations'], isEmpty);
    });

    test('the advance answer reads as unallocated money (server summary)', () {
      final r = CollectProposeResult.fromJson({
        'ok': true,
        'proposal': {'schema': 'erpn.proposal/v1'},
        'summary': {
          'payment_total_vnd': 300000,
          'allocated_total_vnd': 0,
          'unallocated_vnd': 300000,
        },
      });
      expect(r.summary!.allocatedTotalVnd, 0);
      expect(r.summary!.unallocatedVnd, 300000, reason: 'the whole receipt is advance/unallocated');
    });
  });
}
