import 'package:flutter/material.dart';

import '../../../../app/theme/app_theme.dart';
import '../../data/collect_models.dart';

/// One invoice row of the collect form (phase-02 §5.1): the checkbox the USER
/// ticks, the amount field pre-filled with the SERVER's outstanding, and the
/// remaining debt the row still carries.
///
/// Locks this tile keeps:
///  - no auto-selection (the checkbox starts unticked — §6.3's "không tự chọn");
///  - prefill = the outstanding the SERVER sent (never a client-derived number);
///  - `0 < amount ≤ outstanding` validated INLINE, in Vietnamese, without
///    blocking typing (§5.2). The out-of-range text the user typed stays in
///    the field so they can SEE the error — the controller refuses to hold an
///    out-of-range value, and [canSubmit] refuses the submit.
class InvoiceAllocationTile extends StatefulWidget {
  const InvoiceAllocationTile({
    super.key,
    required this.invoice,
    required this.selected,
    this.amount,
    required this.onToggle,
    required this.onAmountChanged,
  });

  final CollectOpenInvoice invoice;
  final bool selected;

  /// The allocation amount the controller currently HOLDS (null = none).
  final int? amount;
  final ValueChanged<bool?> onToggle;
  final ValueChanged<String> onAmountChanged;

  @override
  State<InvoiceAllocationTile> createState() => _InvoiceAllocationTileState();
}

class _InvoiceAllocationTileState extends State<InvoiceAllocationTile> {
  late final TextEditingController _text =
      TextEditingController(text: widget.amount?.toString() ?? '');

  @override
  void didUpdateWidget(InvoiceAllocationTile oldWidget) {
    super.didUpdateWidget(oldWidget);
    // Follow the controller's value ONLY when it differs from what the user is
    // looking at — the controller legitimately refuses out-of-range input, and
    // overwriting the field on every keystroke would fight the typist.
    final held = widget.amount;
    if (held?.toString() != _text.text && int.tryParse(_text.text) != held) {
      _text.text = held?.toString() ?? '';
    }
  }

  @override
  void dispose() {
    _text.dispose();
    super.dispose();
  }

  String get _outstandingText {
    final v = widget.invoice.outstandingVnd;
    if (v == 0) return '0';
    final s = v.abs().toString();
    final buf = StringBuffer();
    for (var i = 0; i < s.length; i++) {
      buf.write(s[i]);
      final left = s.length - 1 - i;
      if (left > 0 && left % 3 == 0) buf.write('.');
    }
    if (v < 0) return '-$buf';
    return buf.toString();
  }

  @override
  Widget build(BuildContext context) {
    final invoice = widget.invoice;
    final parsed = int.tryParse(_text.text);
    final invalid =
        widget.selected && parsed != null && (parsed <= 0 || parsed > invoice.outstandingVnd);
    return ListTile(
      contentPadding: const EdgeInsets.symmetric(horizontal: AppSpacing.sm),
      leading: Checkbox(
        key: ValueKey('invoice-check-${invoice.id}'),
        value: widget.selected,
        onChanged: widget.onToggle,
      ),
      title: Text(
        invoice.id,
        key: ValueKey('invoice-id-${invoice.id}'),
        style: Theme.of(context).textTheme.titleSmall,
      ),
      subtitle: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            invoice.isReturn
                ? '${invoice.date ?? ''} · còn lại $_outstandingTextđ (ghi trừ)'
                : '${invoice.date ?? ''} · còn lại $_outstandingTextđ',
            style: Theme.of(context).textTheme.bodySmall,
          ),
          if (widget.selected)
            TextField(
              key: ValueKey('invoice-amount-${invoice.id}'),
              controller: _text,
              keyboardType: TextInputType.number,
              decoration: InputDecoration(
                hintText: 'Số tiền gạch cho hoá đơn này',
                errorText: invalid ? 'Số tiền phải lớn hơn 0 và không vượt quá số còn nợ.' : null,
              ),
              onChanged: widget.onAmountChanged,
            ),
        ],
      ),
    );
  }
}
