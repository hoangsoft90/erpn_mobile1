import 'package:flutter/material.dart';

import '../../../../app/theme/app_theme.dart';
import '../../data/sales_models.dart';

/// next8 Phase 6 — the sales summary block: renders the SERVER's own
/// arithmetic from `/sales/propose` (spec `sales-screen`: the screen "owns no
/// money authority"). No field here is ever recomputed client-side; the two
/// discount layers and the credit balance stay separate rows exactly as the
/// server sent them (falsify F1/F2 mirrored client-side: no merge, and credit
/// is a NUMBER, not a payment method).
class SalesSummaryView extends StatelessWidget {
  const SalesSummaryView({
    super.key,
    required this.summary,
    this.collectedLabel = 'Thu ngay',
    this.outstandingLabel = 'Còn lại (công nợ)',
  });

  final SalesSummary summary;

  /// Phase 7 reuse: the PURCHASE screen renders this same summary with
  /// "Trả ngay" / "Còn nợ NCC" (its money direction is PAY). Only the labels
  /// differ — the arithmetic is still entirely the server's.
  final String collectedLabel;
  final String outstandingLabel;

  String _vnd(int v) {
    final sign = v < 0 ? '-' : '';
    final s = v.abs().toString();
    final buf = StringBuffer();
    for (var i = 0; i < s.length; i++) {
      buf.write(s[i]);
      final remaining = s.length - 1 - i;
      if (remaining > 0 && remaining % 3 == 0) buf.write('.');
    }
    return '$sign$bufđ';
  }

  @override
  Widget build(BuildContext context) {
    final small = Theme.of(context).textTheme.bodySmall;
    return Column(
      key: const ValueKey('sales-summary'),
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        _row(context, 'Tạm tính', _vnd(summary.subtotalVnd)),
        if (summary.lineDiscountVnd > 0)
          _row(context, 'Chiết khấu dòng', '- ${_vnd(summary.lineDiscountVnd)}', style: small),
        if (summary.orderDiscountVnd > 0)
          _row(context, 'Chiết khấu toàn đơn', '- ${_vnd(summary.orderDiscountVnd)}', style: small),
        _row(context, 'Tổng', _vnd(summary.totalVnd)),
        if (summary.collectedVnd > 0)
          _row(context, collectedLabel, _vnd(summary.collectedVnd), style: small),
        _row(context, outstandingLabel, _vnd(summary.outstandingAfterVnd)),
      ],
    );
  }

  Widget _row(BuildContext context, String label, String value, {TextStyle? style}) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: AppSpacing.xs),
      child: Row(
        mainAxisAlignment: MainAxisAlignment.spaceBetween,
        children: [
          Text(label, style: style ?? Theme.of(context).textTheme.bodyMedium),
          Text(value, style: (style ?? Theme.of(context).textTheme.bodyMedium)?.copyWith(fontWeight: FontWeight.bold)),
        ],
      ),
    );
  }
}
