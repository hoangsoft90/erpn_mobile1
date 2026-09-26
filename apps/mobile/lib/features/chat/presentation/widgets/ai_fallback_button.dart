import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../../app/theme/app_theme.dart';
import '../../application/chat_controller.dart';

/// The "Hỏi AI câu này" affordance on an answer whose deterministic route found
/// nothing (`.plan/next2/auto-fallback-dsh.md` §3).
///
/// It shows up only when the auto-fallback setting was OFF at the moment that
/// answer arrived — the turn carries that decision
/// ([ChatTurn.aiFallbackOffered]), so the button's presence never depends on the
/// CURRENT setting and cannot appear on a message that was already handled.
///
/// Tapping asks the AI path about the SAME sentence: nothing to re-type, and
/// nothing to confirm — that path is read-only server-side, so the original
/// question stays in the history exactly as the user asked it.
class AiFallbackButton extends ConsumerStatefulWidget {
  const AiFallbackButton({
    super.key,
    required this.question,
    required this.foregroundColor,
  });

  /// The sentence that produced this answer — re-sent verbatim.
  final String question;

  /// The bubble's own text colour, so the button matches the bubble it sits in
  /// (an unrouted answer currently renders in the error container).
  final Color foregroundColor;

  @override
  ConsumerState<AiFallbackButton> createState() => _AiFallbackButtonState();
}

class _AiFallbackButtonState extends ConsumerState<AiFallbackButton> {
  bool _asking = false;

  /// The ask this button started has already been answered (or is on its way as
  /// a new turn). Kept separate from [_asking] purely so the label can stop
  /// claiming "đang hỏi" once there is nothing in flight: the button stays
  /// one-shot for as long as its turn is on screen.
  bool _done = false;

  Future<void> _ask() async {
    // One tap = at most one agent session; the second tap of a double tap is
    // dropped here (the controller refuses a concurrent send as well).
    if (_asking || _done) return;
    setState(() => _asking = true);
    try {
      final ok = await ref
          .read(chatControllerProvider.notifier)
          .askAiFallback(widget.question);
      if (!mounted) return;
      if (ok) {
        // Clear `_asking` as well: nothing is in flight any more, and the label
        // reads `_asking` first. The button still stays disabled — `_done` is
        // what makes it one-shot.
        setState(() {
          _done = true;
          _asking = false;
        });
      } else {
        // A failure is already recorded on the chat (SnackBar / status line), so
        // this only re-arms the button for another try.
        setState(() => _asking = false);
      }
    } catch (_) {
      if (mounted) setState(() => _asking = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(top: AppSpacing.sm),
      child: OutlinedButton.icon(
        onPressed: (_asking || _done) ? null : _ask,
        icon: const Icon(Icons.auto_awesome, size: 18),
        label: Text(
          _asking
              ? 'Đang hỏi AI...'
              : (_done ? 'Đã hỏi AI' : 'Hỏi AI câu này'),
        ),
        style: OutlinedButton.styleFrom(
          foregroundColor: widget.foregroundColor,
          textStyle: const TextStyle(fontSize: 13),
        ),
      ),
    );
  }
}
