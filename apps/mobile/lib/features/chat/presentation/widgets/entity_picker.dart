import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../../app/theme/app_theme.dart';
import '../../application/chat_controller.dart';
import '../../data/chat_models.dart';

/// P1 §4.4 — the candidate picker.
///
/// Why this exists at all: for a WRITE, a name that only matched as a substring
/// (\"chị Lan\" → \"Nguyễn Thị Lan\") is NOT allowed to become an authoritative
/// customer id (plan2_final §4.3, §8: payment is HIGH + Exact). Instead of
/// guessing, the server returns the candidates and NO proposal — this widget is
/// how the user settles it. Picking re-asks the same sentence with the chosen id,
/// which the server re-validates against a fresh read.
///
/// Deliberately NOT a dropdown of every customer: the list is what the server
/// judged relevant to THIS sentence, so the user is choosing between plausible
/// readings, not searching the whole catalogue.
class EntityPicker extends ConsumerStatefulWidget {
  const EntityPicker({
    super.key,
    required this.candidates,
    required this.question,
  });

  final List<EntityCandidate> candidates;

  /// The sentence that produced these candidates — re-sent verbatim with the
  /// picked id so the intent cannot drift while the user decides.
  final String question;

  @override
  ConsumerState<EntityPicker> createState() => _EntityPickerState();
}

class _EntityPickerState extends ConsumerState<EntityPicker> {
  String? _pickingId;

  Future<void> _pick(EntityCandidate candidate) async {
    // Guard against a double tap racing two /ask calls for one decision.
    if (_pickingId != null) return;
    setState(() => _pickingId = candidate.id);
    try {
      final ok = await ref
          .read(chatControllerProvider.notifier)
          .pickEntity(candidate, question: widget.question);
      if (!mounted) return;
      if (!ok) {
        // send() already recorded the failure message on the chat.
        setState(() => _pickingId = null);
      }
    } catch (_) {
      if (mounted) setState(() => _pickingId = null);
    }
  }

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Padding(
      padding: const EdgeInsets.only(top: AppSpacing.sm),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: [
          Text(
            'Chọn đúng khách hàng trước khi ghi:',
            style: TextStyle(
              color: scheme.onSurfaceVariant,
              fontSize: 12,
              fontWeight: FontWeight.w600,
            ),
          ),
          const SizedBox(height: AppSpacing.xs),
          Wrap(
            spacing: AppSpacing.xs,
            runSpacing: AppSpacing.xs,
            children: [
              for (final candidate in widget.candidates)
                ActionChip(
                  label: Text(
                    _pickingId == candidate.id
                        ? 'Đang chọn...'
                        : candidate.display,
                  ),
                  // One decision at a time: every other chip is disabled while a
                  // pick is in flight.
                  onPressed: _pickingId == null ? () => _pick(candidate) : null,
                ),
            ],
          ),
        ],
      ),
    );
  }
}
