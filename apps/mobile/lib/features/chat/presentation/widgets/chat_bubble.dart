import 'package:flutter/material.dart';

import '../../../../app/theme/app_theme.dart';
import '../../data/chat_models.dart';
import 'proposal_card.dart';

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
            Text(
              turn.answer.isEmpty ? '(không có câu trả lời)' : turn.answer,
              style: TextStyle(color: textColor),
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
          ],
        ),
      ),
    );
  }
}
