import 'package:flutter/material.dart';

import '../../../../app/theme/app_theme.dart';
import '../../data/collect_models.dart';

/// The account picker (phase-02 §5.1) — the §6.2 UI half.
///
/// It renders ONLY the accounts of the chosen method's own channel: the list
/// arrives pre-filtered by `account_type` (the server grouped them; the widget
/// shows exactly what it is given). There is no affordance here for an account
/// of the wrong type and no fallback to "the cash account" — a channel with no
/// account renders the BLOCK copy instead (§6.2: chặn, không im lặng chuyển
/// về 1110). The default (the company's own declared default, server-checked)
/// is marked in its label.
class AccountPicker extends StatelessWidget {
  const AccountPicker({
    super.key,
    required this.accounts,
    required this.selected,
    required this.onChanged,
  });

  /// Accounts OF THE CHOSEN METHOD'S TYPE only (caller filters via
  /// [CollectAccountsData.forMode]).
  final List<CollectMoneyAccount> accounts;
  final String? selected;
  final ValueChanged<String?> onChanged;

  static const blockCopy =
      'Chưa có tài khoản nào đúng loại cho phương thức này — không thể thu vào kênh này.';

  @override
  Widget build(BuildContext context) {
    if (accounts.isEmpty) {
      return Padding(
        key: const ValueKey('account-blocked'),
        padding: const EdgeInsets.symmetric(vertical: AppSpacing.sm),
        child: Text(
          blockCopy,
          style: Theme.of(context)
              .textTheme
              .bodySmall
              ?.copyWith(color: Theme.of(context).colorScheme.error),
        ),
      );
    }
    // RadioGroup (Flutter ≥3.32) owns the group value + change callback; the
    // tiles only declare their value. `selected` seeds the group's initial
    // state (the company default the controller picked).
    return RadioGroup<String>(
      key: const ValueKey('account-picker'),
      groupValue: selected,
      onChanged: onChanged,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          for (final a in accounts)
            RadioListTile<String>(
              key: ValueKey('account-${a.account}'),
              title: Text(a.label),
              subtitle: Text(a.account),
              value: a.account,
            ),
        ],
      ),
    );
  }
}
