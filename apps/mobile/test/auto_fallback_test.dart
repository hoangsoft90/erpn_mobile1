import 'dart:convert';
import 'dart:typed_data';

import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:erpn_mobile/app/providers.dart';
import 'package:erpn_mobile/core/constants/app_constants.dart';
import 'package:erpn_mobile/features/chat/data/copilot_api_client.dart';
import 'package:erpn_mobile/features/chat/presentation/screens/chat_screen.dart';

/// Auto AI fallback (`.plan/next2/auto-fallback-dsh.md` §3/§4).
///
/// The properties these tests defend:
///  1. **Two separate client requests.** An unrouted `/ask` answer may be
///     followed by a `/dsh/ask` — issued by the CLIENT. `/ask` itself still
///     never spawns dsh (D2, `p5-dsh-optin.test.mjs`).
///  2. **The setting decides, and it is read at ANSWER time.** ON ⇒ the follow-up
///     happens by itself; OFF (default) ⇒ the message offers a button and NO
///     session is spent until the user taps. Flipping the switch later must not
///     rewrite a message already on screen.
///  3. **Only UNKNOWN_INTENT.** LOW_CONFIDENCE asks the user to be clearer — it
///     is the system working, so it never offers or triggers AI.
///  4. **A busy gateway is not a failure.** `DSH_GATEWAY_IN_FLIGHT` (429) shows
///     the wait wording, leaves the red failure line alone, and never retries by
///     itself.
///
/// The oracle is the request log of the Dio the CLIENT actually uses — a
/// recorder attached to a different Dio proves nothing (result56 §5).

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

/// What `/ask` answers with. `answer: null` + `error_code` is exactly the shape
/// `answerQuestion` returns for a refusal, and the turn shows `reason`.
const Map<String, dynamic> _unrouted = {
  'question': 'chị Lan còn nợ bao nhiêu',
  'normalized': {'text': 'Lan còn nợ bao nhiêu'},
  'routed': false,
  'answer': null,
  'error_code': 'UNKNOWN_INTENT',
  'reason': 'no skill route matched — chưa hiểu câu này',
};

const Map<String, dynamic> _lowConfidence = {
  'question': 'chị Lan còn nợ bao nhiêu',
  'routed': false,
  'answer': null,
  'error_code': 'LOW_CONFIDENCE',
  'reason': 'phân loại chưa đủ chắc (confidence=0.3) — cần nói rõ hơn',
  'needs_clarification': true,
};

/// Records every request, answering `/ask` with [askResult] and `/dsh/ask` with
/// either an answer or [dshError].
class _Router {
  _Router({this.askResult = _unrouted});

  final List<String> paths = [];
  final List<Map<String, dynamic>> bodies = [];

  Map<String, dynamic> askResult;

  /// When set, `/dsh/ask` answers with this envelope + [dshErrorStatus]
  /// (a gateway refusal carries the machine `code` and its Vietnamese copy).
  Map<String, dynamic>? dshError;
  int dshErrorStatus = 502;

  String dshAnswer =
      'Khách smoke 2026-09-15-p1b-wf1-2 hiện còn nợ 171.800đ (4 chứng từ).';

  int dshCalls() => paths.where((p) => p == '/dsh/ask').length;

  Handler get handler => (options) async {
        final raw = options.data;
        final body = raw is String
            ? jsonDecode(raw) as Map<String, dynamic>
            : (raw as Map<String, dynamic>? ?? const {});
        paths.add(options.path);
        bodies.add(body);
        if (options.path == '/dsh/ask') {
          final err = dshError;
          if (err != null) return _json(err, dshErrorStatus);
          return _json({
            'ok': true,
            'mode': 'dsh',
            'conversation_id': body['conversation_id'],
            'dsh_session_id': 'sess-dsh-1',
            'erpnext_target': 'REAL',
            'result': {'answer': dshAnswer},
          });
        }
        return _json({'ok': true, 'result': askResult});
      };
}

/// Minimal SharedPreferences fake (no plugin channel in unit tests), same shape
/// as the one the other widget tests use.
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
      return Future<bool>.value(true);
    }
    if (invocation.memberName == #getBool &&
        invocation.positionalArguments.length == 1) {
      return store[invocation.positionalArguments.first as String] as bool?;
    }
    if (invocation.memberName == #setBool &&
        invocation.positionalArguments.length == 2) {
      store[invocation.positionalArguments[0] as String] =
          invocation.positionalArguments[1] as Object;
      return Future<bool>.value(true);
    }
    if (invocation.memberName == #remove &&
        invocation.positionalArguments.length == 1) {
      store.remove(invocation.positionalArguments.first as String);
      return Future<bool>.value(true);
    }
    return null; // unimplemented members return null, like a mock would
  }
}

Future<ProviderContainer> _pumpChat(
  WidgetTester tester,
  _Router router, {
  required SharedPreferences prefs,
}) async {
  await tester.pumpWidget(
    ProviderScope(
      overrides: [
        sharedPreferencesProvider.overrideWithValue(prefs),
        copilotApiClientProvider.overrideWithValue(
          CopilotApiClient(
            dio: Dio(BaseOptions(baseUrl: 'http://mock.local'))
              ..httpClientAdapter = _MockAdapter(router.handler),
          ),
        ),
      ],
      child: const MaterialApp(home: ChatScreen()),
    ),
  );
  await tester.pumpAndSettle();
  return ProviderScope.containerOf(tester.element(find.byType(ChatScreen)));
}

Future<void> _send(WidgetTester tester, String text) async {
  await tester.enterText(find.byType(TextField), text);
  await tester.tap(find.byTooltip('Gửi'));
}

/// The AI path is selected: the mode bar's read-only notice only renders then.
Finder get _aiNotice => find.textContaining('Chế độ AI chỉ ĐỌC');
Finder get _aiButton => find.text('Hỏi AI câu này');
Finder get _aiFailureLine => find.textContaining('Phiên AI vừa lỗi');

/// Answer/reason text lives in the Markdown bubble's spans, not in `Text.data`.
Finder _textIn(String needle) =>
    find.textContaining(needle, findRichText: true);

void main() {
  // ─────────────────────────── OFF (the default) ─────────────────────────────

  testWidgets('OFF: an unrouted answer spends NO AI session and offers a button',
      (tester) async {
    final router = _Router();
    await _pumpChat(tester, router, prefs: _FakePrefs());

    await _send(tester, 'chị Lan còn nợ bao nhiêu');
    await tester.pumpAndSettle();

    expect(router.paths, ['/ask'], reason: 'nothing follows automatically');
    expect(router.dshCalls(), 0);
    expect(_aiButton, findsOneWidget,
        reason: 'the message itself offers the AI path');
    expect(_textIn('chưa hiểu câu này'), findsOneWidget,
        reason: 'the deterministic answer is still shown verbatim');
    expect(_aiNotice, findsNothing, reason: 'the mode never moved by itself');
  });

  testWidgets('OFF: tapping the button asks the AI path exactly once',
      (tester) async {
    final router = _Router();
    await _pumpChat(tester, router, prefs: _FakePrefs());

    await _send(tester, 'chị Lan còn nợ bao nhiêu');
    await tester.pumpAndSettle();
    expect(_aiButton, findsOneWidget, reason: 'preflight: the button exists');

    await tester.tap(_aiButton);
    await tester.pumpAndSettle();

    expect(router.dshCalls(), 1, reason: 'one tap = one session');
    expect(router.bodies.last['message'], 'chị Lan còn nợ bao nhiêu',
        reason: 'the SAME sentence is re-sent — nothing to type again');
    expect(_textIn('171.800đ'), findsOneWidget,
        reason: 'the AI answer is shown');
    expect(_aiNotice, findsOneWidget, reason: 'the selector moved to AI mode');
    expect(_textIn('chưa hiểu câu này'), findsOneWidget,
        reason: 'the original question/answer stay in the history');

    // The button is one-shot: it must stop claiming "đang hỏi" once the answer
    // has landed — a finished message still reading "Đang hỏi AI..." looks like
    // a hang, and this turn stays reachable (the user can switch back to
    // "Chat thường" and scroll to it).
    expect(find.text('Đang hỏi AI...'), findsNothing,
        reason: 'nothing is in flight any more');
    expect(find.text('Đã hỏi AI'), findsOneWidget,
        reason: 'same affordance, honest label');
    final spent = tester.widget<OutlinedButton>(find.ancestor(
      of: find.text('Đã hỏi AI'),
      matching: find.byType(OutlinedButton),
    ));
    expect(spent.onPressed, isNull,
        reason: 'a second tap cannot spend another AI session on this message');
  });

  // ──────────────────────────────── ON ───────────────────────────────────────

  testWidgets('ON: an unrouted answer is carried to the AI path by itself',
      (tester) async {
    final prefs = _FakePrefs();
    await prefs.setBool(AppConstants.autoFallbackToAiStorageKey, true);
    final router = _Router();
    await _pumpChat(tester, router, prefs: prefs);

    await _send(tester, 'chị Lan còn nợ bao nhiêu');
    await tester.pumpAndSettle();

    expect(router.paths, ['/ask', '/dsh/ask'],
        reason: 'two separate client requests, in order');
    expect(router.bodies.last['message'], 'chị Lan còn nợ bao nhiêu');
    expect(_textIn('171.800đ'), findsOneWidget);
    expect(_aiNotice, findsOneWidget, reason: 'the selector moved by itself');
    expect(_aiButton, findsNothing,
        reason: 'the app already acted on this question — no box to tick');
    expect(_textIn('chưa hiểu câu này'), findsOneWidget,
        reason: 'the original question/answer stay in the history');
  });

  // ─────────────── the setting is read once, at answer time ──────────────────

  testWidgets('the decision is frozen per message: flipping the switch later '
      'never rewrites a message already on screen', (tester) async {
    final prefs = _FakePrefs();
    final router = _Router();
    final container = await _pumpChat(tester, router, prefs: prefs);

    // 1. Answered while OFF ⇒ this message offers the button.
    await _send(tester, 'câu hỏi một');
    await tester.pumpAndSettle();
    expect(_aiButton, findsOneWidget, reason: 'preflight: OFF ⇒ button');

    // 2. The user turns the setting ON afterwards…
    final settings = container.read(appSettingsServiceProvider);
    await settings.saveAutoFallbackToAi(true);
    container.invalidate(appSettingsServiceProvider);
    await tester.pumpAndSettle();

    // …and the message they are already looking at does NOT change: it was
    // answered when the answer would not have been carried to the AI.
    expect(_aiButton, findsOneWidget,
        reason: 'a shown message must not gain/lose its button retroactively');

    // 3. The NEXT question goes down the AI path on its own (new setting)…
    await _send(tester, 'câu hỏi hai');
    await tester.pumpAndSettle();
    expect(router.paths, ['/ask', '/ask', '/dsh/ask'],
        reason: 'the new question is the one the setting governs');
    expect(_aiButton, findsOneWidget,
        reason: 'still only the FIRST message has the button');

    // 4. …and turning it back OFF does not add a button to it either.
    await settings.saveAutoFallbackToAi(false);
    container.invalidate(appSettingsServiceProvider);
    await tester.pumpAndSettle();
    expect(_aiButton, findsOneWidget,
        reason: 'an auto-fetched answer never grows a button later');
  });

  // ────────────────────── LOW_CONFIDENCE is NOT a fallback ───────────────────

  testWidgets('OFF + LOW_CONFIDENCE: no button, no AI session',
      (tester) async {
    final router = _Router(askResult: _lowConfidence);
    await _pumpChat(tester, router, prefs: _FakePrefs());

    await _send(tester, 'chị Lan còn nợ bao nhiêu');
    await tester.pumpAndSettle();

    expect(router.dshCalls(), 0);
    expect(_aiButton, findsNothing,
        reason: 'the classifier reached a domain — this is asking again, '
            'not failing to understand');
    expect(_textIn('cần nói rõ hơn'), findsOneWidget);
  });

  testWidgets('ON + LOW_CONFIDENCE: still nothing automatic', (tester) async {
    final prefs = _FakePrefs();
    await prefs.setBool(AppConstants.autoFallbackToAiStorageKey, true);
    final router = _Router(askResult: _lowConfidence);
    await _pumpChat(tester, router, prefs: prefs);

    await _send(tester, 'chị Lan còn nợ bao nhiêu');
    await tester.pumpAndSettle();

    expect(router.paths, ['/ask'],
        reason: 'the setting only covers UNKNOWN_INTENT');
    expect(_aiButton, findsNothing);
  });

  // ───────────────────────── busy gateway (429) ──────────────────────────────

  testWidgets('429 DSH_GATEWAY_IN_FLIGHT: shows the wait wording, no red '
      'failure line, and does NOT retry by itself', (tester) async {
    final router = _Router()
      ..dshError = const {
        'ok': false,
        'code': 'DSH_GATEWAY_IN_FLIGHT',
        'mode': 'dsh',
        'retryable': true,
        'error': 'Đang có một phiên DSH chạy — chờ phiên hiện tại xong rồi thử lại.',
      }
      ..dshErrorStatus = 429;
    await _pumpChat(tester, router, prefs: _FakePrefs());

    await _send(tester, 'chị Lan còn nợ bao nhiêu');
    await tester.pumpAndSettle();
    await tester.tap(_aiButton);
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 600)); // SnackBar entrance

    expect(router.dshCalls(), 1, reason: 'no automatic retry after a 429');
    expect(
      find.textContaining('Đang có một phiên DSH chạy'),
      findsOneWidget,
      reason: 'the gateway wording reaches the user verbatim',
    );
    expect(_aiFailureLine, findsNothing,
        reason: 'a busy gateway is not a broken session');
    // The original question and its answer stay in the history untouched (a
    // failed fallback must not erase what the deterministic path already said).
    expect(find.text('chị Lan còn nợ bao nhiêu'), findsWidgets);
    expect(_textIn('chưa hiểu câu này'), findsOneWidget);
  });

  testWidgets('a genuinely broken session shows the gateway reason and the '
      'failure line', (tester) async {
    final router = _Router()
      ..dshError = const {
        'ok': false,
        'code': 'DSH_UNAVAILABLE',
        'mode': 'dsh',
        'error': 'chưa tìm thấy dsh trên máy này — cài rồi thử lại.',
      };
    await _pumpChat(tester, router, prefs: _FakePrefs());

    await _send(tester, 'chị Lan còn nợ bao nhiêu');
    await tester.pumpAndSettle();
    await tester.tap(_aiButton);
    await tester.pumpAndSettle();

    expect(router.dshCalls(), 1);
    expect(find.textContaining('chưa tìm thấy dsh trên máy này'), findsWidgets,
        reason: 'the server wording is what the user sees');
    expect(_aiFailureLine, findsOneWidget,
        reason: 'this one really did fail — say so');
  });
}
