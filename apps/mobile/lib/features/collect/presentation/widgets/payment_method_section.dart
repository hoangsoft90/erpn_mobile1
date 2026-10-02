import 'package:flutter/material.dart';

import '../../../../app/theme/app_theme.dart';

/// The payment-method block (phase-02 §5.1).
///
/// Lock §6.1 made structural: the segmented control holds exactly ONE value —
/// the widget has no "add method" affordance and its state cannot hold two.
/// The copy *"Mỗi lần thu một hình thức thanh toán."* sits under the control so
/// a user who wants cash AND transfer reads the rule before fighting the UI:
/// the way to do both is two collections, never one merged one.
class PaymentMethodSection extends StatelessWidget {
  const PaymentMethodSection({
    super.key,
    required this.method,
    required this.onChanged,
  });

  /// `'cash'` | `'bank_transfer'` | null (nothing chosen yet).
  final String? method;
  final ValueChanged<String?> onChanged;

  static const cashCopy = 'Mỗi lần thu một hình thức thanh toán.';

  @override
  Widget build(BuildContext context) {
    return Column(
      key: const ValueKey('payment-method-section'),
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text('Phương thức', style: Theme.of(context).textTheme.titleMedium),
        const SizedBox(height: AppSpacing.sm),
        SegmentedButton<String>(
          key: const ValueKey('payment-method-segmented'),
          segments: const [
            ButtonSegment(value: 'cash', label: Text('Tiền mặt')),
            ButtonSegment(value: 'bank_transfer', label: Text('Chuyển khoản')),
          ],
          selected: method == null ? const {} : {method!},
          // §6.1: an empty selection must stay reachable (the user can always
          // see that nothing is chosen until they choose) — but never two.
          emptySelectionAllowed: true,
          multiSelectionEnabled: false,
          onSelectionChanged: (selection) =>
              onChanged(selection.isEmpty ? null : selection.first),
        ),
        const SizedBox(height: AppSpacing.xs),
        Text(
          cashCopy,
          style: Theme.of(context).textTheme.bodySmall,
        ),
      ],
    );
  }
}
