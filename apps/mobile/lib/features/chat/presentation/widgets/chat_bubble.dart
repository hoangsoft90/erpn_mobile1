import 'package:flutter/material.dart';
import 'package:flutter_markdown_plus/flutter_markdown_plus.dart';

import '../../../../app/theme/app_theme.dart';
import '../../data/chat_models.dart';
import 'ai_fallback_button.dart';
import 'customer_offer_card.dart';
import 'entity_picker.dart';
import 'proposal_card.dart';
import 'read_drilldown_button.dart';

/// One chat turn rendered as a PAIR of bubbles: the user's question (right)
/// and the copilot's response (left). Response shows the answer, or the
/// failure message when [ChatTurn.ok] is false. All values come from the
/// theme — no magic numbers.
class ChatBubble extends StatelessWidget {
  const ChatBubble({super.key, required this.turn});

  final ChatTurn turn;

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (turn.question.isNotEmpty) _UserBubble(turn: turn),
        _CopilotBubble(turn: turn),
      ],
    );
  }
}

class _UserBubble extends StatelessWidget {
  const _UserBubble({required this.turn});

  final ChatTurn turn;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Align(
      alignment: Alignment.centerRight,
      child: Container(
        margin: const EdgeInsets.symmetric(vertical: AppSpacing.xs),
        padding: const EdgeInsets.all(AppSpacing.md),
        constraints: BoxConstraints(
          maxWidth: MediaQuery.sizeOf(context).width * 0.8,
        ),
        decoration: BoxDecoration(
          color: scheme.primaryContainer,
          borderRadius: BorderRadius.circular(12), // radius.md
        ),
        child: Text(
          turn.question,
          style: TextStyle(color: scheme.onPrimaryContainer),
        ),
      ),
    );
  }
}

/// Markdown styling for the answer bubble: the theme's own paragraph style with
/// the bubble's text colour, so introducing Markdown does not change how an
/// answer looks (and the error bubble keeps its `onErrorContainer` tone).
MarkdownStyleSheet _answerStyleSheet(BuildContext context, Color textColor) {
  final theme = Theme.of(context);
  final body = theme.textTheme.bodyMedium ?? const TextStyle();
  return MarkdownStyleSheet.fromTheme(theme).copyWith(
    p: body.copyWith(color: textColor),
    listBullet: body.copyWith(color: textColor),
  );
}

class _CopilotBubble extends StatelessWidget {
  const _CopilotBubble({required this.turn});

  final ChatTurn turn;

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    final bubbleColor = turn.ok
        ? scheme.surfaceContainerHighest
        : scheme.errorContainer;
    final textColor =
        turn.ok ? scheme.onSurface : scheme.onErrorContainer;

    return Align(
      alignment: Alignment.centerLeft,
      child: Container(
        margin: const EdgeInsets.symmetric(vertical: AppSpacing.xs),
        padding: const EdgeInsets.all(AppSpacing.md),
        constraints: BoxConstraints(
          maxWidth: MediaQuery.sizeOf(context).width * 0.8,
        ),
        decoration: BoxDecoration(
          color: bubbleColor,
          borderRadius: BorderRadius.circular(12), // radius.md
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          mainAxisSize: MainAxisSize.min,
          children: [
            // The answer is rendered as Markdown so a future backend that
            // sends `**bold**` amounts or `-` invoice lists is formatted
            // instead of showing raw punctuation. Answers are plain prose
            // today, so this is preparation, not a fix.
            MarkdownBody(
              data: turn.answer.isEmpty ? '(không có câu trả lời)' : turn.answer,
              styleSheet: _answerStyleSheet(context, textColor),
              // The answer is ERPNext/copilot data — an untrusted source. Its
              // default image builder turns `![](http://…)` in a customer or
              // item name into an outbound `Image.network` fetch, so merely
              // opening the chat would make the phone request a host the data
              // picked. This app never sends images, so drop them.
              imageBuilder: (uri, title, alt) => const SizedBox.shrink(),
              // A single newline must keep breaking the line, as the plain
              // `Text` it replaces did. Markdown's own default joins soft
              // breaks into one paragraph, which would silently reflow the
              // multi-line inventory answers `AskResult` builds with '•' lines.
              softLineBreak: true,
            ),
            // A1 (plan3 Trụ A): a READ answer whose screen the SERVER declared
            // gets a drill-down button. Absent intent ⇒ no button — the client
            // never decides on its own that a question was a debt question.
            if (turn.readUi != null)
              ReadDrillDownButton(
                intent: turn.readUi!,
                foregroundColor: textColor,
              ),
            // `.plan/next2/auto-fallback-dsh.md` §3: an answer the deterministic
            // route could not place offers the AI path. The flag was decided
            // when the answer arrived (setting OFF then) and travels with the
            // turn, so this never appears on a message that was already carried
            // to the AI — not even after the user flips the setting.
            if (turn.aiFallbackOffered)
              AiFallbackButton(
                question: turn.question,
                foregroundColor: textColor,
              ),
            if (turn.routedGroup != null) ...[
              const SizedBox(height: AppSpacing.sm),
              Text(
                'route: ${turn.routedGroup}',
                style: TextStyle(
                  color: textColor.withValues(alpha: 0.7),
                  fontSize: 11,
                ),
              ),
            ],
            // Phase 6: proposal summary card below the answer (display-only).
            if (turn.proposal != null) ProposalCard(proposal: turn.proposal!),
            // M1: a WRITE about a customer that does NOT exist yet offers to
            // create one — but ONLY when this turn has no card (the offer exists
            // to replace a missing proposal). The explicit "thêm khách …"
            // command carries BOTH, and rendering the offer there as well would
            // put two create affordances on one message.
            if (turn.awaitingCustomerCreate)
              CustomerOfferCard(offer: turn.customerCreateOffer!),
            // P1 §4.4: a write that could not settle the customer offers the
            // candidates instead of a proposal. No card, no confirm button —
            // nothing can be written until the user picks.
            if (turn.awaitingEntityPick)
              EntityPicker(
                candidates: turn.candidates,
                question: turn.question,
              ),
          ],
        ),
      ),
    );
  }
}
