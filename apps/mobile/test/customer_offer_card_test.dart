import 'dart:convert';
import 'dart:typed_data';

import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:erpn_mobile/app/providers.dart';
import 'package:erpn_mobile/features/chat/data/chat_models.dart';
import 'package:erpn_mobile/features/chat/presentation/widgets/chat_bubble.dart';
import 'package:erpn_mobile/features/chat/presentation/widgets/customer_offer_card.dart';

/// M1 — the create-customer OFFER, from the client's side.
///
/// What this file proves, in the order the risk appears:
///
///  1. PARSING: `offer_create_customer` becomes a form, and an offer without a
///     usable name does not (fail closed — no half-built offer).
///  2. PERSISTENCE: the offer survives a history round-trip, so an unanswered
///     offer is still actionable after an app restart (same rule as `read_ui`).
///  3. ONE AFFORDANCE: a turn carrying BOTH the offer and a proposal shows only
///     the proposal card — a second create button on the same message would
///     invite a second record.
///  4. NOTHING WITHOUT A PRESS: rendering the card performs zero requests.
///  5. THE NAME GATE: the button is disabled while the name is empty (the server
///     would refuse CC_NAME_MISSING; offering the press would invite a call that
///     cannot succeed).
///  6. THE SERVER OWNS THE PROPOSAL: pressing asks `/ask` first; a refusal
///     (duplicate) is shown as an answer and NO `/execute` is ever sent.
///  7. ONE WRITE, ONE KEY: the confirm posts `/execute` with the form's contact
///     slots and a command id that a retry REUSES (an error-then-retry must not
///     create two customers).
///  8. THE OUTCOME IS MASTER DATA: the success line says the record is REAL and
///     does not promise a sale.

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

/// An `/ask` envelope carrying a server-built create proposal.
Map<String, dynamic> _askWithProposal({String name = 'Nguyễn Văn Tèo'}) => {
      'ok': true,
      'result': {
        'question': 'thêm khách $name',
        'answer': 'Đề xuất tạo khách hàng MỚI: $name',
        'proposal': {
          'schema': 'erpn.proposal/v1',
          'action': 'create_customer',
          'risk': 'HIGH',
          'risk_display': {'icon': '🔴', 'label': 'Cần xác nhận'},
          'need_confirm': true,
          'need_double_confirm': false,
          'executable': false,
          'entity': {'kind': 'customer', 'id': name, 'name': name},
          'summary': 'Tạo khách hàng MỚI: $name',
          'params': {'customer_name': name},
          'created_at': DateTime.now().toUtc().toIso8601String(),
          'proposal_id': 'prop-m1-1',
          'version': 1,
        },
      },
    };

/// An `/ask` envelope for a customer that already exists (no proposal at all).
Map<String, dynamic> _askRefused(String reason, String code) => {
      'ok': true,
      'result': {
        'question': 'thêm khách Nguyễn Thị Lan',
        'answer': null,
        'reason': reason,
        'error_code': code,
        'proposal': null,
      },
    };

Map<String, dynamic> _execOk({String doc = 'CUST-M001'}) => {
      'ok': true,
      'replay': false,
      'result': {
        'erpnext_doc': doc,
        'customer': doc,
        'customer_name': 'Nguyễn Văn Tèo',
        'mobile_no': '0901234567',
        'tax_id': null,
      },
    };

Widget _host(Widget child, Handler handler) =>
    ProviderScope(
      overrides: [
        dioProvider.overrideWith((ref) {
          final dio = Dio(BaseOptions(baseUrl: 'http://mock'));
          dio.httpClientAdapter = _MockAdapter(handler);
          return dio;
        }),
        // The offer card applies the client's settings (base URL + basic auth)
        // before POSTing /execute, exactly like the proposal card — a protected
        // server answers 401 to a confirm that skipped it.
        sharedPreferencesProvider.overrideWithValue(null),
      ],
      // The real screen hosts turns in a ListView, so a tall card scrolls
      // instead of overflowing the 800x600 test surface.
      child: MaterialApp(home: Scaffold(body: ListView(children: [child]))),
    );

ChatTurn _offerTurn({
  String name = 'Nguyễn Văn Tèo',
  ActionProposal? proposal,
  List<EntityCandidate> candidates = const [],
}) =>
    ChatTurn(
      question: 'giao 2 bao cám cho $name',
      answer: 'Không tìm thấy khách hàng trong câu.',
      ok: false,
      ts: DateTime.now(),
      customerCreateOffer: CustomerCreateOffer(name: name),
      proposal: proposal,
      candidates: candidates,
    );

void main() {
  group('M1 offer — parsing', () {
    test('a usable offer parses; a nameless one does not (fail closed)', () {
      final offer = CustomerCreateOffer.tryParse({
        'name': '  Nguyễn Văn Tèo ',
        'mobile_no': '0901234567',
        'tax_id': null,
      });
      expect(offer, isNotNull);
      expect(offer!.name, 'Nguyễn Văn Tèo', reason: 'trimmed');
      expect(offer.mobileNo, '0901234567');

      expect(CustomerCreateOffer.tryParse(null), isNull);
      expect(CustomerCreateOffer.tryParse({'name': '   '}), isNull);
      expect(CustomerCreateOffer.tryParse({'name': 42}), isNull);
      expect(CustomerCreateOffer.tryParse('not a map'), isNull);
    });

    test('AskResult carries the offer, and the turn keeps it across a restart',
        () {
      final parsed = AskResult.fromJson({
        'question': 'thu tiền anh Tèo 500 nghìn',
        'answer': null,
        'error_code': 'MISSING_ENTITY',
        'offer_create_customer': {'name': 'anh Tèo', 'mobile_no': null, 'tax_id': null},
      });
      expect(parsed.customerCreateOffer?.name, 'anh Tèo');
      expect(parsed.proposal, isNull, reason: 'a NO_MATCH offer has no card');

      final turn = ChatTurn.fromAskResult(parsed);
      expect(turn.awaitingCustomerCreate, isTrue);
      expect(turn.hasPendingProposal, isTrue,
          reason: 'an unanswered offer is a pending write intent — never trimmed');

      final restored = ChatTurn.fromJson(turn.toJson());
      expect(restored.customerCreateOffer?.name, 'anh Tèo',
          reason: 'the offer must survive history restore, like read_ui');
      expect(restored.awaitingCustomerCreate, isTrue);
    });

    test('a turn with no offer writes the exact old JSON shape', () {
      final json = ChatTurn(
        question: 'công nợ chị Lan',
        answer: 'Còn 2.500.000đ',
        ok: true,
        ts: DateTime.parse('2026-09-24T00:00:00.000Z'),
      ).toJson();
      // Additive only: an ordinary turn's payload is byte-for-byte what it was,
      // so histories written before M1 load unchanged (the A1 rule, kept).
      expect(json.containsKey('customer_create_offer'), isFalse);
      expect(json.containsKey('read_ui'), isFalse);
    });
  });

  group('M1 offer — rendering', () {
    testWidgets('the card shows the form and sends NOTHING until pressed',
        (tester) async {
      var calls = 0;
      await tester.pumpWidget(
        _host(
          ChatBubble(turn: _offerTurn()),
          (options) async {
            calls += 1;
            return _json(_askWithProposal());
          },
        ),
      );

      expect(find.text('Tên khách *'), findsOneWidget);
      expect(find.text('Số điện thoại'), findsOneWidget);
      expect(find.text('Mã số thuế'), findsOneWidget);
      expect(find.text('Tạo khách mới'), findsOneWidget);
      expect(calls, 0, reason: 'rendering an offer is not an action');
    });

    testWidgets('the button is DISABLED while the name is empty', (tester) async {
      var calls = 0;
      await tester.pumpWidget(
        _host(
          const CustomerOfferCard(offer: CustomerCreateOffer(name: 'Tạm')),
          (options) async {
            calls += 1;
            return _json(_askWithProposal());
          },
        ),
      );
      await tester.enterText(find.byType(TextField).first, '   ');
      await tester.pump();

      final button = tester.widget<FilledButton>(find.byType(FilledButton));
      expect(button.onPressed, isNull, reason: 'no name ⇒ no creatable request');
      expect(calls, 0);
    });

    testWidgets(
        'a turn with BOTH the offer and a proposal shows ONE affordance (the card)',
        (tester) async {
      final proposal = ActionProposal(
        schema: 'erpn.proposal/v1',
        action: 'create_customer',
        risk: 'HIGH',
        riskIcon: '🔴',
        riskLabel: 'Cần xác nhận',
        needConfirm: true,
        needDoubleConfirm: false,
        executable: false,
        entityKind: 'customer',
        entityId: 'Nguyễn Văn Tèo',
        entityName: 'Nguyễn Văn Tèo',
        summary: 'Tạo khách hàng MỚI: Nguyễn Văn Tèo',
        params: const {'customer_name': 'Nguyễn Văn Tèo'},
      );
      await tester.pumpWidget(
        _host(
          ChatBubble(turn: _offerTurn(proposal: proposal)),
          (options) async => _json(_execOk()),
        ),
      );

      expect(find.text('Tạo khách mới'), findsNothing,
          reason: 'the card owns the create affordance on this turn');
      expect(find.text('Xác nhận tạo khách hàng (record thật)'), findsOneWidget);
    });
  });

  group('M1 offer — creating', () {
    testWidgets('a refusal (duplicate) is shown as an ANSWER and never writes',
        (tester) async {
      final seen = <String>[];
      await tester.pumpWidget(
        _host(
          ChatBubble(turn: _offerTurn(name: 'Nguyễn Thị Lan')),
          (options) async {
            seen.add(options.path);
            if (options.path == '/ask') {
              return _json(_askRefused(
                'khách này ĐÃ CÓ trên ERPNext: "Nguyễn Thị Lan" (CUST-00001) — không tạo bản sao',
                'CC_DUPLICATE_NAME',
              ));
            }
            return _json(_execOk());
          },
        ),
      );

      await tester.enterText(find.byType(TextField).first, 'Nguyễn Thị Lan');
      await tester.tap(find.text('Tạo khách mới'));
      await tester.pumpAndSettle();

      expect(seen, ['/ask'],
          reason: 'a duplicate must stop at the ask — no /execute at all');
      expect(
        find.textContaining('ĐÃ CÓ trên ERPNext'),
        findsOneWidget,
        reason: 'the server\'s own wording names the existing customer',
      );
      expect(find.textContaining('Đã tạo khách hàng'), findsNothing);
    });

    testWidgets('confirm asks then executes, and shows the REAL record',
        (tester) async {
      final paths = <String>[];
      Map<String, dynamic>? execBody;
      await tester.pumpWidget(
        _host(
          ChatBubble(turn: _offerTurn()),
          (options) async {
            paths.add(options.path);
            if (options.path == '/ask') return _json(_askWithProposal());
            execBody = jsonDecode(options.data as String) as Map<String, dynamic>;
            return _json(_execOk());
          },
        ),
      );

      await tester.enterText(find.byType(TextField).at(1), '0901234567');
      await tester.tap(find.text('Tạo khách mới'));
      await tester.pumpAndSettle();

      expect(paths, ['/ask', '/execute'],
          reason: 'the server builds the proposal; the client never authors one');
      final params =
          (execBody!['proposal'] as Map<String, dynamic>)['params'] as Map<String, dynamic>;
      expect(params['customer_name'], 'Nguyễn Văn Tèo');
      expect(params['mobile_no'], '0901234567',
          reason: 'the typed contact slots travel with the confirm');
      expect(
        execBody!['command_id'],
        matches(RegExp(
            r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')),
        reason: 'a real UUID — the server shape-validates the command id '
            '(idempotency.isValidCommandId)',
      );
      expect(find.textContaining('Đã tạo khách hàng: Nguyễn Văn Tèo (CUST-M001)'),
          findsOneWidget);
      expect(find.textContaining('record THẬT'), findsOneWidget);
      expect(find.textContaining('KHÔNG tự tạo đơn/phiếu thu'), findsOneWidget);
      expect(find.text('Tạo khách mới'), findsNothing,
          reason: 'a created record must not offer to create it again');
    });

    testWidgets('a failed confirm keeps the SAME command id for the retry',
        (tester) async {
      final commandIds = <String>[];
      var execCalls = 0;
      await tester.pumpWidget(
        _host(
          ChatBubble(turn: _offerTurn()),
          (options) async {
            if (options.path == '/ask') return _json(_askWithProposal());
            execCalls += 1;
            final body =
                jsonDecode(options.data as String) as Map<String, dynamic>;
            commandIds.add(body['command_id'] as String);
            if (execCalls == 1) {
              return _json({'ok': false, 'error': 'mạng chập chờn'}, 503);
            }
            return _json(_execOk());
          },
        ),
      );

      await tester.tap(find.text('Tạo khách mới'));
      await tester.pumpAndSettle();
      expect(find.textContaining('mạng chập chờn'), findsOneWidget);

      // The button is back (nothing was created), and the retry reuses the key.
      await tester.tap(find.text('Tạo khách mới'));
      await tester.pumpAndSettle();

      expect(commandIds.length, 2);
      expect(commandIds[0], commandIds[1],
          reason: 'one press intent ⇒ one command id (retry replays, never clones)');
      expect(find.textContaining('Đã tạo khách hàng'), findsOneWidget);
    });
  });
}
