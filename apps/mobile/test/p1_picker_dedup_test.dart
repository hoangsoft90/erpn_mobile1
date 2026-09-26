import 'dart:convert';
import 'dart:typed_data';

import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:erpn_mobile/app/providers.dart';
import 'package:erpn_mobile/features/chat/application/chat_controller.dart';
import 'package:erpn_mobile/core/settings/app_settings_service.dart';
import 'package:erpn_mobile/features/chat/data/copilot_api_client.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:erpn_mobile/features/chat/data/chat_models.dart';
import 'package:erpn_mobile/features/chat/presentation/widgets/chat_bubble.dart';
import 'package:erpn_mobile/features/chat/presentation/widgets/proposal_card.dart';

/// P1 UI/wire tests. The lesson they follow (result33 F4, result43): a test that
/// only inspects the MODEL cannot prove the WIRE — every assertion here goes
/// through a real HTTP adapter and checks the body that would actually be sent.

/// In-memory prefs — the settings layer reads the SUGGESTED default URL
/// (`https://erpn8788.loca.lt`) through this, so leaving it out would make the
/// harness dial the real network (the send test would report
/// "Không kết nối được máy chủ" instead of hitting the mock adapter).
class _FakePrefs implements SharedPreferences {
  final Map<String, Object> store = {};

  @override
  dynamic noSuchMethod(Invocation invocation) {
    if (invocation.memberName == #getString &&
        invocation.positionalArguments.length == 1) {
      return store[invocation.positionalArguments.first as String];
    }
    if (invocation.memberName == #setString &&
        invocation.positionalArguments.length == 2) {
      store[invocation.positionalArguments[0] as String] =
          invocation.positionalArguments[1] as Object;
      return Future<void>.value();
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

/// Request body as it reaches the adapter: dio hands the request Map through
/// UNCHANGED here (no JSON round-trip in this harness), so a bare
/// `jsonDecode(options.data as String)` throws TypeError — which dio wraps
/// into CopilotNetworkException and the test sees "Không kết nối được máy
/// chủ" with an empty capture. Accept BOTH shapes (debug probe 2026-09-17:
/// adapter saw `_Map<String, String>`).
Map<String, dynamic> _bodyOf(RequestOptions options) {
  final d = options.data;
  if (d is Map) return Map<String, dynamic>.from(d);
  return jsonDecode(d as String) as Map<String, dynamic>;
}

ResponseBody _json(Object body, [int status = 200]) => ResponseBody.fromString(
      jsonEncode(body),
      status,
      headers: {
        Headers.contentTypeHeader: [Headers.jsonContentType],
      },
    );

Map<String, dynamic> _writeProposalJson({String name = 'Nguyễn Thị Lan'}) => {
      'schema': 'erpn.proposal/v1',
      'proposal_id': 'prp_test-1',
      'version': 1,
      'expires_at': DateTime.now().add(const Duration(minutes: 10)).toIso8601String(),
      'action': 'create_payment_entry',
      'risk': 'HIGH',
      'risk_display': {'icon': '🔴', 'label': 'Cao'},
      'need_confirm': true,
      'need_double_confirm': false,
      'executable': false,
      'created_at': DateTime.now().toIso8601String(),
      'entity': {'kind': 'customer', 'id': 'CUST-00001', 'name': name},
      'params': {
        'amount_vnd': 500000,
        'invoice': 'SINV-0001',
        'outstanding_vnd': 2500000,
        'mode': 'Tiền mặt',
      },
      'summary': 'Thu 500.000đ từ $name cho chứng từ SINV-0001',
    };

void main() {
  test('P1 §4.4: the picker sends entity_id and the same sentence then yields a proposal', () async {
  final seen = <Map<String, dynamic>>[];
  var call = 0;
  Future<ResponseBody> handler(RequestOptions options) async {
    seen.add(_bodyOf(options));
    call += 1;
    if (call == 1) {
      // The fuzzy first attempt: refusal + candidates, NO proposal.
      return _json({
        'ok': true,
        'result': {
          'question': 'thu tiền cho chị Lan 500 ngàn',
          'answer': null,
          'error_code': 'ENTITY_PICK_REQUIRED',
          'reason': 'cần chọn đúng khách',
          'proposal': null,
          'entity': {'state': 'FUZZY_SINGLE_MATCH'},
          'candidates': [
            {'id': 'CUST-00001', 'name': 'Nguyễn Thị Lan', 'label': 'Nguyễn Thị Lan (CUST-00001)'},
          ],
        },
      });
    }
    return _json({
      'ok': true,
      'result': {
        'question': 'thu tiền cho chị Lan 500 ngàn',
        'answer': 'Đề xuất thu 500.000đ từ Nguyễn Thị Lan — bấm [Xác nhận]',
        'routed': {'group': 'payment_write', 'matched': 'thu tiền'},
        'proposal': _writeProposalJson(),
      },
    });
  }

  final prefs = _FakePrefs();
  final settings = AppSettingsService(prefs: prefs);
  final container = ProviderContainer(
    overrides: [
      // The CONTROLLER talks to the API client, and the API client builds its
      // own Dio — overriding dioProvider alone would leave it dialing the real
      // network (the wire-test lesson again). Override the client itself,
      // exactly like chat_controller_test does.
      copilotApiClientProvider.overrideWithValue(
        CopilotApiClient(
          dio: Dio(BaseOptions(baseUrl: 'http://mock.local'))
            ..httpClientAdapter = _MockAdapter(handler),
          // Settings with EMPTY saved values: without this the client falls
          // back to the suggested default URL and never reaches the adapter.
          settings: settings,
        ),
      ),
      // History cap reads the same prefs instance (nothing saved ⇒ default 20).
      sharedPreferencesProvider.overrideWithValue(prefs),
    ],
  );
  addTearDown(container.dispose);

  // Warm the controller (history load) before sending.
  container.listen(chatControllerProvider, (_, _) {}, fireImmediately: true);
  await container.read(chatControllerProvider.future);
  final controller = container.read(chatControllerProvider.notifier);

  final sent = await controller.send('thu tiền cho chị Lan 500 ngàn');
  // ignore: avoid_print
  print('P1TEST sent=$sent state=${container.read(chatControllerProvider)} error=${container.read(chatControllerProvider).value?.lastError}');
  var turns = container.read(chatControllerProvider).value!.turns;
  expect(turns, hasLength(1));
  expect(turns.first.awaitingEntityPick, isTrue, reason: 'candidates + no proposal ⇒ picker');
  expect(turns.first.proposal, isNull);
  expect(seen, hasLength(1));
  expect(seen.first.containsKey('entity_id'), isFalse, reason: 'first ask is a plain sentence');
  // The first refusal must not have produced any confirm affordance.
  expect(turns.first.hasPendingProposal, isFalse);

  // The user taps a candidate: the SAME text goes back with the chosen id.
  await controller.pickEntity(turns.first.candidates.first,
      question: turns.first.question);

  turns = container.read(chatControllerProvider).value!.turns;
  expect(seen, hasLength(2));
  expect(seen[1]['entity_id'], 'CUST-00001');
  expect(seen[1]['text'], 'thu tiền cho chị Lan 500 ngàn',
      reason: 'the pick re-asks the SAME sentence — the intent must not drift');
  expect(turns.last.proposal, isNotNull, reason: 'the pick unlocks the write proposal');
  expect(turns.last.proposal!.entityName, 'Nguyễn Thị Lan');
});

testWidgets('P1 §10.5: a duplicate-intent card warns, and confirming sends dedup_ack', (tester) async {
  final bodies = <Map<String, dynamic>>[];
  final dio = Dio(BaseOptions(baseUrl: 'http://mock'));
  dio.httpClientAdapter = _MockAdapter((options) async {
    bodies.add(_bodyOf(options));
    return _json({
      'ok': true,
      'replay': false,
      'result': {
        'erpnext_doc': 'ACC-PAY-2026-00001',
        'paid_vnd': 500000,
        'reference_no': 'cmd-1',
      },
    });
  });

  final proposal = ActionProposal.fromJson({
    ..._writeProposalJson(),
    'business_dedup': {
      'fingerprint': 'fp-1',
      'duplicate_of': ['prp_older'],
      'require_extra_confirm': true,
      'message': 'Bạn vừa có đề xuất tương tự vài phút trước.',
    },
  });
  expect(proposal.dedupRequiresAck, isTrue);

  await tester.pumpWidget(
    ProviderScope(
      overrides: [
        dioProvider.overrideWithValue(dio),
        // Confirm applies the client's settings (base URL + basic auth) first —
        // a protected server 401s otherwise — so the settings dependency must be
        // resolvable here (null prefs ⇒ the getters fall back to defaults).
        sharedPreferencesProvider.overrideWithValue(null),
      ],
      child: MaterialApp(home: Scaffold(body: ProposalCard(proposal: proposal))),
    ),
  );

  // The warning is shown BEFORE the button, so pressing confirm is informed.
  expect(find.text('Bạn vừa có đề xuất tương tự vài phút trước.'), findsOneWidget);

  await tester.tap(find.text('Xác nhận thu tiền'));
  await tester.pumpAndSettle();

  expect(bodies, hasLength(1));
  expect(bodies.first['dedup_ack'], isTrue,
      reason: 'without the ack the server refuses with BUSINESS_DEDUP_CONFIRM_REQUIRED');
  expect(bodies.first['command_id'], isNotNull);
  // The snapshot identity must be on the wire or the server 409s VERSION_STALE.
  final sentProposal = bodies.first['proposal'] as Map<String, dynamic>;
  expect(sentProposal['version'], 1);
  expect(sentProposal['proposal_id'], 'prp_test-1');
});

test('P1 §9: the proposal snapshot survives the model round-trip (toJson/fromJson)', () {
  final original = ActionProposal.fromJson({
    ..._writeProposalJson(),
    'business_dedup': {
      'require_extra_confirm': true,
      'message': 'cảnh báo trùng',
    },
  });
  final restored = ActionProposal.fromJson(original.toJson());

  expect(restored.proposalId, 'prp_test-1');
  expect(restored.version, 1);
  expect(restored.expiresAt, isNotNull);
  expect(restored.dedupRequiresAck, isTrue);
  expect(restored.dedupMessage, 'cảnh báo trùng');
  expect(restored.params!['amount_vnd'], 500000);

  // A card with no warning must not grow a spurious business_dedup block.
  final plain = ActionProposal.fromJson(_writeProposalJson());
  expect(plain.dedupRequiresAck, isFalse);
  expect(plain.toJson().containsKey('business_dedup'), isFalse);
});

testWidgets('P1 §4.4: the picker is rendered on the turn that offered candidates', (tester) async {
  final turn = ChatTurn(
    question: 'thu tiền cho chị Lan 500 ngàn',
    answer: '',
    ok: false,
    ts: DateTime.now(),
    candidates: const [
      EntityCandidate(id: 'CUST-00001', name: 'Nguyễn Thị Lan'),
      EntityCandidate(id: 'CUST-00007', name: 'Nguyễn Lan Anh'),
    ],
  );
  expect(turn.awaitingEntityPick, isTrue);

  await tester.pumpWidget(
    ProviderScope(
      child: MaterialApp(home: Scaffold(body: ChatBubble(turn: turn))),
    ),
  );
  expect(find.text('Chọn đúng khách hàng trước khi ghi:'), findsOneWidget);
  expect(find.text('Nguyễn Thị Lan (CUST-00001)'), findsOneWidget);
  expect(find.text('Nguyễn Lan Anh (CUST-00007)'), findsOneWidget);
  // No confirm affordance anywhere: the write is not proposed yet.
  expect(find.text('Xác nhận thu tiền'), findsNothing);
  });
}
