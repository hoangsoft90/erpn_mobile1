import 'package:flutter/material.dart';

import '../../../../app/theme/app_theme.dart';

/// The summary block (phase-02 §5.1): the two totals the user reconciles
/// BEFORE confirming — what is allocated against the invoices and what will be
/// received — plus the mismatch warning.
///
/// The numbers shown are computed for DISPLAY and self-check only (phase-02
/// §3: "client chỉ tính để kiểm tra khớp, không để ghi"): the server is the
/// final authority — at propose time it validates the whole draft against its
/// own fresh read and its own arithmetic.
class CollectSummary extends StatelessWidget {
  const CollectSummary({
    super.key,
    required this.allocatedTotalVnd,
    required this.paymentTotalVnd,
  });

  final int allocatedTotalVnd;
  final int paymentTotalVnd;

  String get _allocatedText => _vnd(allocatedTotalVnd);
  String get _paymentText => _vnd(paymentTotalVnd);

  static String _vnd(int v) {
    if (v == 0) return '0';
    final s = v.abs().toString();
    final buf = StringBuffer();
    for (var i = 0; i < s.length; i++) {
      buf.write(s[i]);
      final left = s.length - 1 - i;
      if (left > 0 && left % 3 == 0) buf.write('.');
    }
    return v < 0 ? '-$buf' : buf.toString();
  }

  @override
  Widget build(BuildContext context) {
    final mismatch = allocatedTotalVnd != paymentTotalVnd;
    return Column(
      key: const ValueKey('collect-summary'),
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text('Tổng', style: Theme.of(context).textTheme.titleMedium),
        const SizedBox(height: AppSpacing.sm),
        Row(
          mainAxisAlignment: MainAxisAlignment.spaceBetween,
          children: [
            Text('Tổng gạch nợ'),
            Text('$_allocatedTextđ', key: const ValueKey('allocated-total')),
          ],
        ),
        Row(
          mainAxisAlignment: MainAxisAlignment.spaceBetween,
          children: [
            Text('Tổng tiền nhận'),
            Text('$_paymentTextđ', key: const ValueKey('payment-total')),
          ],
        ),
        if (mismatch)
          Padding(
            key: const ValueKey('mismatch-warning'),
            padding: const EdgeInsets.only(top: AppSpacing.xs),
            child: Text(
              'Tổng gạch nợ chưa khớp tổng tiền nhận — server sẽ từ chối nếu hai số này khác nhau.',
              style: Theme.of(context)
                  .textTheme
                  .bodySmall
                  ?.copyWith(color: Theme.of(context).colorScheme.error),
            ),
          ),
      ],
    );
  }
}
