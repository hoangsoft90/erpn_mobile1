// PROBE ONLY — temporary review harness (result40). Deleted/converted once the
// findings are confirmed. Proves two suspected defects with real widget runs:
//   P1: ProposalCard._confirm() calls setState/ref.read after the widget was
//       disposed mid-flight (unmount while /execute is in flight).
//   P2: the local success stamp (_result) is lost when ListView.builder
//       recycles the card (scroll away + back ⇒ confirm button returns).
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

ActionProposal _paymentProposal() => ActionProposal(
      schema: 'erpn.proposal/v1',
      action: 'create_payment_entry',
      risk: 'HIGH',
      riskIcon: '🔴',
      riskLabel: 'Cần xác nhận',
      needConfirm: true,
      needDoubleConfirm: false,
      executable: false,
      entityKind: 'customer',
      entityId: 'CUST-00001',
      entityName: 'Nguyễn Thị Lan',
      summary: 'Thu 500.000đ từ Nguyễn Thị Lan cho chứng từ SINV-0001',
      params: const {
        'amount_vnd': 500000,
        'invoice': 'SINV-0001',
        'outstanding_vnd': 2500000,
        'mode': 'Tiền mặt',
      },
    );

Widget _wrap(Widget child, Handler handler) => ProviderScope(
      overrides: [
        dioProvider.overrideWith((ref) {
          final dio = Dio(BaseOptions(baseUrl: 'http://mock'));
          dio.httpClientAdapter = _MockAdapter(handler);
          return dio;
        }),
      ],
      child: MaterialApp(home: Scaffold(body: child)),
    );

void main() {
  testWidgets('P1 — unmount while /execute is in flight (409 refusal path)',
      (tester) async {
    final gate = Completer<ResponseBody>();
    final proposal = _paymentProposal();
    await tester.pumpWidget(_wrap(ProposalCard(proposal: proposal), (o) => gate.future));

    await tester.tap(find.byType(FilledButton));
    await tester.pump(); // request started, still pending

    // The user navigates away / clears history while the write is in flight:
    // the card is unmounted, its ProviderScope disposed with it.
    await tester.pumpWidget(const MaterialApp(home: Scaffold(body: SizedBox())));
    expect(find.byType(ProposalCard), findsNothing);

    // The server then answers with the Phase 9 refusal (real 409 shape).
    gate.complete(_json({
      'ok': false,
      'code': 'PROPOSAL_STALE',
      'error': 'Dữ liệu đã thay đổi sau khi tạo đề xuất',
      'problems': ['nợ đã đổi từ 2500000 sang 2000000'],
    }, 409));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));

    final err = tester.takeException();
    // ignore: avoid_print
    print('P1 EXCEPTION AFTER DISPOSE: ${err.runtimeType} :: $err');
    expect(err, isNull,
        reason: 'no setState/ref use after dispose — see printed value above');
  });

  testWidgets('P1b — unmount while /execute is in flight (success path)',
      (tester) async {
    final gate = Completer<ResponseBody>();
    await tester.pumpWidget(
        _wrap(ProposalCard(proposal: _paymentProposal()), (o) => gate.future));

    await tester.tap(find.byType(FilledButton));
    await tester.pump();
    await tester.pumpWidget(const MaterialApp(home: Scaffold(body: SizedBox())));

    gate.complete(_json({
      'ok': true,
      'replay': false,
      'result': {'erpnext_doc': 'ACC-PAY-2026-00999', 'paid_vnd': 500000},
    }));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));

    final err = tester.takeException();
    // ignore: avoid_print
    print('P1b EXCEPTION AFTER DISPOSE: ${err.runtimeType} :: $err');
    expect(err, isNull, reason: 'success path must also guard mounted');
  });

  testWidgets('P2 — success stamp survives ListView recycle?', (tester) async {
    final calls = <String>[];
    await tester.pumpWidget(_wrap(
      ListView.builder(
        itemCount: 30,
        itemBuilder: (context, i) => i == 0
            ? ProposalCard(proposal: _paymentProposal())
            : const SizedBox(height: 300),
      ),
      (o) async {
        calls.add(o.path);
        return _json({
          'ok': true,
          'replay': false,
          'result': {'erpnext_doc': 'ACC-PAY-2026-00999', 'paid_vnd': 500000},
        });
      },
    ));

    await tester.tap(find.byType(FilledButton));
    await tester.pumpAndSettle();
    final beforeSuccess = find.textContaining('Đã ghi phiếu thu').evaluate().length;
    final beforeButton = find.byType(FilledButton).evaluate().length;
    // ignore: avoid_print
    print('P2 BEFORE scroll: success=$beforeSuccess button=$beforeButton');

    // Scroll the card far out of view (item 0 unmounts), then back.
    await tester.drag(find.byType(ListView), const Offset(0, -4000));
    await tester.pumpAndSettle();
    final whileAway = find.byType(ProposalCard).evaluate().length;
    await tester.drag(find.byType(ListView), const Offset(0, 4000));
    await tester.pumpAndSettle();

    final afterSuccess = find.textContaining('Đã ghi phiếu thu').evaluate().length;
    final afterButton = find.byType(FilledButton).evaluate().length;
    // ignore: avoid_print
    print('P2 card mounted while scrolled away: $whileAway');
    // ignore: avoid_print
    print('P2 AFTER scroll back: success=$afterSuccess button=$afterButton (calls=${calls.length})');

    expect(afterSuccess, beforeSuccess,
        reason: 'the "Đã ghi phiếu thu" result must survive a scroll cycle');
  });

  testWidgets('P2b — pressing the RETURNED button after recycle: same key?',
      (tester) async {
    final sentKeys = <String>[];
    await tester.pumpWidget(_wrap(
      ListView.builder(
        itemCount: 30,
        itemBuilder: (context, i) => i == 0
            ? ProposalCard(proposal: _paymentProposal())
            : const SizedBox(height: 300),
      ),
      (o) async {
        final body = jsonDecode(o.data as String) as Map<String, dynamic>;
        sentKeys.add(body['command_id'] as String);
        return _json({
          'ok': true,
          'replay': sentKeys.length > 1,
          'result': {'erpnext_doc': 'ACC-PAY-2026-00999', 'paid_vnd': 500000},
        });
      },
    ));

    await tester.tap(find.byType(FilledButton));
    await tester.pumpAndSettle();
    await tester.drag(find.byType(ListView), const Offset(0, -4000));
    await tester.pumpAndSettle();
    await tester.drag(find.byType(ListView), const Offset(0, 4000));
    await tester.pumpAndSettle();

    final buttonBack = find.byType(FilledButton).evaluate().length;
    await tester.tap(find.byType(FilledButton));
    await tester.pumpAndSettle();

    // ignore: avoid_print
    print('P2b button back after recycle: $buttonBack · keys=$sentKeys');
    // ignore: avoid_print
    print('P2b after second press: ${find.textContaining("chống trùng").evaluate().length} '
        'replay-message(s)');
    expect(sentKeys.length, 2, reason: 'two presses really hit the server');
    expect(sentKeys[0], sentKeys[1],
        reason: 'the same card must reuse its idempotency key across recycle');
  });
}
