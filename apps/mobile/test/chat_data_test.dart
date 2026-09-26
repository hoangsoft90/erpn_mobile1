import 'dart:convert';
import 'dart:typed_data';

import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:erpn_mobile/features/chat/data/chat_models.dart';
import 'package:erpn_mobile/features/chat/data/copilot_api_client.dart';

/// Mocks the REAL /ask contract (verified against mcp-erpnext/src/http-ask.mjs):
///   200 {ok:true, result:{question, answer, routed, customer, ...}}
///   4xx/5xx {ok:false, error}
typedef Handler = Future<ResponseBody> Function(RequestOptions options);

Dio _dioWith(Handler handler) {
  return Dio(BaseOptions(
    baseUrl: 'http://mock.local',
    connectTimeout: const Duration(seconds: 1),
    receiveTimeout: const Duration(seconds: 1),
  ))
    ..httpClientAdapter = _MockAdapter(handler);
}

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

void main() {
  group('AskResult.fromJson (real /ask shapes)', () {
    test('customer balance answer (String answer)', () {
      final r = AskResult.fromJson({
        'question': 'chị Lan còn nợ bao nhiêu',
        'normalized': {'text': 'Lan còn nợ bao nhiêu', 'amount': null},
        'routed': {'group': 'customer', 'matched': 'còn nợ'},
        'customer': {'id': 'CUST-001', 'name': 'Nguyễn Thị Lan'},
        'outstanding_vnd': 2500000,
        'open_invoices': 1,
        'answer': 'Nguyễn Thị Lan còn nợ 2.500.000đ (1 chứng từ chưa thanh toán).',
      });
      expect(r.hasAnswer, isTrue);
      expect(r.answer, contains('2.500.000đ'));
      expect(r.routedGroup, 'customer');
      expect(r.customerName, 'Nguyễn Thị Lan');
      expect(r.outstandingVnd, 2500000);
      expect(r.openInvoices, 1);
    });

    test('inventory answer (List<String> answer)', () {
      final r = AskResult.fromJson({
        'question': 'trong kho còn bao nhiêu cám heo',
        'normalized': {'text': 'trong kho còn bao nhiêu cám heo'},
        'routed': {'group': 'inventory', 'matched': 'kho'},
        'answer': ['CAM-HEO-25KG: 120 (kho Kho chính)'],
      });
      expect(r.hasAnswer, isTrue);
      expect(r.answer, '• CAM-HEO-25KG: 120 (kho Kho chính)');
      expect(r.routedGroup, 'inventory');
      expect(r.customerId, isNull);
    });

    test('no route -> null answer', () {
      final r = AskResult.fromJson({
        'question': 'hello world',
        'normalized': {'text': 'hello world'},
        'routed': false,
        'answer': null,
        'reason': 'no skill route matched',
      });
      expect(r.hasAnswer, isFalse);
      expect(r.routedGroup, isNull);
    });

    test('customer not found -> falls back to reason text', () {
      final r = AskResult.fromJson({
        'question': 'anh Ba còn nợ mấy',
        'normalized': {'text': 'Ba còn nợ mấy'},
        'routed': {'group': 'customer', 'matched': 'còn nợ'},
        'answer': null,
        'reason': 'không tìm thấy khách hàng trong "Ba còn nợ mấy"',
      });
      expect(r.hasAnswer, isFalse);
      final turn = ChatTurn.fromAskResult(r, typedQuestion: 'anh Ba còn nợ mấy');
      expect(turn.ok, isFalse);
      expect(turn.answer, 'không tìm thấy khách hàng trong "Ba còn nợ mấy"');
    });
  });

  group('ChatTurn serialization (chat_history_v1)', () {
    test('roundtrip through JSON', () {
      final t = ChatTurn(
        question: 'q',
        answer: 'a',
        ok: true,
        ts: DateTime.parse('2026-09-14T10:00:00.000'),
        routedGroup: 'customer',
      );
      final back = ChatTurn.fromJson(t.toJson());
      expect(back.question, 'q');
      expect(back.answer, 'a');
      expect(back.ok, isTrue);
      expect(back.ts, t.ts);
      expect(back.routedGroup, 'customer');
    });
  });

  group('CopilotApiClient against contract shapes', () {
    test('happy path parses result', () async {
      final client = CopilotApiClient(
        dio: _dioWith((options) async => _json({
              'ok': true,
              'result': {
                'question': 'q',
                'answer': 'Trả lời',
                'routed': {'group': 'customer', 'matched': 'còn nợ'},
              },
            })),
      );
      final r = await client.ask('q');
      expect(r.answer, 'Trả lời');
      expect(r.routedGroup, 'customer');
    });

    test('400 {ok:false,error} -> CopilotServerException with message',
        () async {
      final client = CopilotApiClient(
        dio: _dioWith(
          (options) async => _json(
            {'ok': false, 'error': 'missing required field: text'},
            400,
          ),
        ),
      );
      await expectLater(
        client.ask(''),
        throwsA(isA<CopilotServerException>().having(
          (e) => e.message,
          'message',
          'missing required field: text',
        )),
      );
    });

    test('connection error -> CopilotNetworkException', () async {
      final client = CopilotApiClient(
        dio: _dioWith(
          (options) async => throw DioException(
            requestOptions: options,
            type: DioExceptionType.connectionError,
            error: 'refused',
          ),
        ),
      );
      await expectLater(
        client.ask('q'),
        throwsA(isA<CopilotNetworkException>()),
      );
    });

    test('timeout -> CopilotTimeoutException', () async {
      final client = CopilotApiClient(
        dio: _dioWith(
          (options) async => throw DioException(
            requestOptions: options,
            type: DioExceptionType.connectionTimeout,
          ),
        ),
      );
      await expectLater(
        client.ask('q'),
        throwsA(isA<CopilotTimeoutException>()),
      );
    });
  });

  group('result40 — corrupt-payload tolerance (fail-safe, never wipe history)', () {
    test(
        'a NON-list rejection_problems parses as empty and the rest of the history survives',
        () {
      // Was: `json['rejection_problems'] as List<dynamic>?` ⇒ TypeError for a
      // String ⇒ ChatHistoryService.load() catches and returns [] ⇒ ONE bad
      // field silently wiped the whole chat history. The parse must be
      // tolerant and keep every good turn.
      final stored = jsonEncode([
        {
          'question': 'chị Lan còn nợ bao nhiêu',
          'answer': 'Còn 2.500.000đ',
          'ok': true,
          'ts': DateTime.now().toIso8601String(),
          'proposal': {
            'schema': 'erpn.proposal/v1',
            'action': 'create_payment_entry',
            'risk': 'HIGH',
            'need_confirm': true,
            'entity': {'kind': 'customer', 'id': 'CUST-00001', 'name': 'Lan'},
            'params': {'amount_vnd': 500000, 'invoice': 'SINV-1', 'outstanding_vnd': 500000},
            'created_at': '2026-09-16T04:00:00.000Z',
            // corrupt/hostile: a String where the server sends a list
            'rejection_code': 'PROPOSAL_STALE',
            'rejection_problems': 'nợ đã đổi từ 2500000 sang 2000000',
          },
        },
        {
          'question': 'hỏi sau đó',
          'answer': 'ok',
          'ok': true,
          'ts': DateTime.now().toIso8601String(),
        },
      ]);

      // Mirrors ChatHistoryService.load() exactly (whereType + map).
      final list = jsonDecode(stored) as List<dynamic>;
      final turns = list
          .whereType<Map<String, dynamic>>()
          .map(ChatTurn.fromJson)
          .toList();

      expect(turns.length, 2,
          reason: 'a malformed field must not drop good turns');
      final p = turns.first.proposal!;
      expect(p.rejectionCode, 'PROPOSAL_STALE',
          reason: 'the refusal reason is still shown (fail-closed banner)');
      expect(p.rejectionProblems, isEmpty,
          reason: 'unparseable problems[] degrades to empty, never throws');
    });
  });
}
