import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:erpn_mobile/app/theme/app_theme.dart';
import 'package:erpn_mobile/features/chat/data/chat_models.dart';
import 'package:erpn_mobile/features/chat/presentation/widgets/chat_bubble.dart';

// `.plan/next2/tts-scope-and-markdown.md` §2: the answer bubble renders Markdown
// so a backend that sends `**bold**` amounts or `-` invoice lists is formatted
// instead of showing raw punctuation. Answers are plain prose TODAY, so most of
// what these tests pin is that nothing regressed for them.

ChatTurn _turn(String answer, {bool ok = true}) => ChatTurn(
      question: 'chị Lan còn nợ bao nhiêu',
      answer: answer,
      ok: ok,
      ts: DateTime.parse('2026-09-20T10:00:00.000'),
    );

Future<void> _pumpBubble(WidgetTester tester, ChatTurn turn) async {
  await tester.pumpWidget(
    MaterialApp(
      theme: AppTheme.light(),
      home: Scaffold(body: ChatBubble(turn: turn)),
    ),
  );
}

/// The rendered paragraph containing [text]. The Markdown renderer emits
/// `Text.rich`, so its content lives in `textSpan` rather than `Text.data`.
TextSpan? _paragraph(WidgetTester tester, String text) {
  for (final widget in tester.widgetList<Text>(find.byType(Text))) {
    final span = widget.textSpan;
    if (span is TextSpan && span.toPlainText().contains(text)) return span;
  }
  return null;
}

Iterable<InlineSpan> _flatten(InlineSpan span) sync* {
  yield span;
  if (span is TextSpan) {
    for (final child in span.children ?? const <InlineSpan>[]) {
      yield* _flatten(child);
    }
  }
}

/// Every rendered text span in the bubble, joined — for "the raw syntax is
/// gone" assertions.
String _allText(WidgetTester tester) => tester
    .widgetList<Text>(find.byType(Text))
    .map((w) => w.textSpan?.toPlainText())
    .whereType<String>()
    .join('\n');

void main() {
  testWidgets('plain prose renders exactly as written, in the bubble tone',
      (tester) async {
    const answer = 'Nguyễn Thị Lan còn nợ 2.500.000đ (1 chứng từ chưa thanh toán).';
    await _pumpBubble(tester, _turn(answer));

    final span = _paragraph(tester, 'Nguyễn Thị Lan còn nợ');
    expect(span, isNotNull, reason: 'the answer must render at all');
    expect(span!.toPlainText(), answer,
        reason: 'prose answers must survive the Markdown switch unchanged');
    expect(span.style?.color, AppTheme.light().colorScheme.onSurface,
        reason: 'the Markdown style sheet keeps the bubble text colour');
  });

  testWidgets('**bold** renders bold, not literal asterisks', (tester) async {
    const answer = 'Còn nợ **500.000đ** (1 chứng từ).';
    await _pumpBubble(tester, _turn(answer));

    final span = _paragraph(tester, '500.000đ');
    expect(span, isNotNull);
    expect(span!.toPlainText(), 'Còn nợ 500.000đ (1 chứng từ).',
        reason: 'the `**` markers are markup, not content');

    final bold = _flatten(span).whereType<TextSpan>().where((s) =>
        s.style?.fontWeight == FontWeight.bold &&
        (s.text ?? '').contains('500.000đ'));
    expect(bold, isNotEmpty,
        reason: 'the amount must actually be bold, not merely unmarked');
  });

  testWidgets('a Markdown list renders as a list, not as "- " lines',
      (tester) async {
    const answer = '- Hóa đơn A: 100.000đ\n- Hóa đơn B: 200.000đ';
    await _pumpBubble(tester, _turn(answer));

    expect(find.text('•'), findsNWidgets(2),
        reason: 'each list item gets a rendered bullet');
    final plain = _allText(tester);
    expect(plain, contains('Hóa đơn A: 100.000đ'));
    expect(plain, contains('Hóa đơn B: 200.000đ'));
    expect(plain, isNot(contains('- ')),
        reason: 'the "-" markers are markup, not content');
  });

  testWidgets('a multi-line plain answer keeps its line breaks',
      (tester) async {
    // Regression guard for the Markdown default: soft line breaks are JOINTED
    // into one paragraph, which would silently reflow the '•'-prefixed
    // multi-line inventory answers AskResult builds. The plain `Text` this
    // widget replaced showed the breaks, so the Markdown renderer must too.
    const answer = 'Tồn kho hiện có:\n• Cám heo: 10 bao\n• Cám gà: 5 bao';
    await _pumpBubble(tester, _turn(answer));

    final span = _paragraph(tester, 'Tồn kho hiện có:');
    expect(span, isNotNull);
    expect(span!.toPlainText(), answer,
        reason: 'every newline in the answer must still reach the screen');
  });

  testWidgets('an image in the answer is dropped, never fetched',
      (tester) async {
    // The answer is ERPNext/copilot text, i.e. untrusted. The Markdown
    // renderer's default image builder would issue `Image.network` for
    // `![](http://…)`, so a customer name could make the phone phone home just
    // by the user opening the chat. Nothing is rendered and nothing is fetched.
    const answer =
        'Khách ![pixel](https://example.invalid/pixel.png) còn nợ 100.000đ';
    await _pumpBubble(tester, _turn(answer));

    expect(find.byType(Image), findsNothing,
        reason: 'no image widget may be built from answer text');
    expect(_allText(tester), contains('còn nợ 100.000đ'),
        reason: 'the rest of the answer still renders');
  });

  testWidgets('a failed turn keeps the error bubble tone', (tester) async {
    const answer = 'Không tìm thấy khách hàng';
    await _pumpBubble(tester, _turn(answer, ok: false));

    final span = _paragraph(tester, 'Không tìm thấy');
    expect(span, isNotNull);
    expect(span!.style?.color, AppTheme.light().colorScheme.onErrorContainer,
        reason: 'an error bubble must not fall back to the default text colour');
  });
}
