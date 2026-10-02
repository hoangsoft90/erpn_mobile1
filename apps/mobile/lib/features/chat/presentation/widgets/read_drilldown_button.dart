import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../../../../app/theme/app_theme.dart';
import '../../data/chat_models.dart';

/// A1 (plan3 Trụ A) — the CTA on an answer that can be opened as a list.
///
/// It exists only when the SERVER sent a UI intent for this answer
/// (`ChatTurn.readUi`), so the client never decides that a question was a
/// "debt question" by itself. Pressing it navigates to the read-only screen and
/// carries the intent as route data; nothing here can write.
class ReadDrillDownButton extends StatelessWidget {
  const ReadDrillDownButton({
    super.key,
    required this.intent,
    required this.foregroundColor,
  });

  final ReadUiIntent intent;
  final Color foregroundColor;

  @override
  Widget build(BuildContext context) {
    return Align(
      alignment: Alignment.centerLeft,
      child: Padding(
        padding: const EdgeInsets.only(top: AppSpacing.sm),
        child: OutlinedButton.icon(
          onPressed: () => context.push('/read', extra: intent),
          icon: const Icon(Icons.receipt_long_outlined, size: 18),
          label: Text(
            intent.title.isEmpty ? 'Xem chi tiết' : 'Xem ${intent.title.toLowerCase()}',
          ),
          style: OutlinedButton.styleFrom(foregroundColor: foregroundColor),
        ),
      ),
    );
  }
}
