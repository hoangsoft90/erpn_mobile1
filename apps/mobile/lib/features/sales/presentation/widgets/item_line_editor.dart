import 'package:flutter/material.dart';

import '../../../../app/theme/app_theme.dart';
import '../../data/sales_models.dart';

/// next8 Phase 6 — ONE goods line of the sales form (phase-06 §5.4):
/// item / uom / qty / line discount. The fields are exactly the values the
/// server re-resolves: the item code and the UOM must EXIST on ERPNext (exact
/// tokens — a guessed name is refused with its own copy at propose time); the
/// discount stays on its own field (tầng 1) and never merges into the
/// order-level one (falsify F1).
///
/// Phase 7 reuse: the PURCHASE screen renders this same editor with
/// [showDiscount] = false (plan §14 has no discount for a purchase) instead of
/// forking a second line editor — the item/uom/qty fields are identical, only
/// the discount row differs.
class ItemLineEditor extends StatelessWidget {
  const ItemLineEditor({
    super.key,
    required this.index,
    required this.line,
    required this.onChanged,
    this.onRemove,
    this.showDiscount = true,
  });

  final int index;
  final SalesLineValue line;
  final ValueChanged<SalesLineValue> onChanged;
  final VoidCallback? onRemove;

  /// Whether the (sales-only) line-discount field is shown. A purchase has no
  /// discount (plan §14), so it passes false.
  final bool showDiscount;

  @override
  Widget build(BuildContext context) {
    return Card(
      key: ValueKey('sales-line-card-$index'),
      margin: const EdgeInsets.only(bottom: AppSpacing.sm),
      child: Padding(
        padding: const EdgeInsets.all(AppSpacing.sm),
        child: Column(
          children: [
            Row(
              children: [
                Expanded(
                  child: TextField(
                    key: ValueKey('sales-line-item-$index'),
                    decoration: const InputDecoration(
                      labelText: 'Mã mặt hàng (đúng mã trên ERPNext)',
                      hintText: 'CAM-HEO-25KG',
                    ),
                    onChanged: (v) => onChanged(line.copyWith(itemCode: v)),
                  ),
                ),
                if (onRemove != null)
                  IconButton(
                    key: ValueKey('sales-line-remove-$index'),
                    tooltip: 'Xoá dòng',
                    onPressed: onRemove,
                    icon: const Icon(Icons.delete_outline),
                  ),
              ],
            ),
            Row(
              children: [
                Expanded(
                  child: TextField(
                    key: ValueKey('sales-line-uom-$index'),
                    decoration: const InputDecoration(labelText: 'Đơn vị (UOM)'),
                    onChanged: (v) => onChanged(line.copyWith(uom: v)),
                  ),
                ),
                const SizedBox(width: AppSpacing.sm),
                Expanded(
                  child: TextField(
                    key: ValueKey('sales-line-qty-$index'),
                    keyboardType: TextInputType.number,
                    decoration: const InputDecoration(labelText: 'Số lượng'),
                    onChanged: (raw) => onChanged(
                      line.copyWith(qty: int.tryParse(raw.replaceAll(RegExp('[^0-9]'), ''))),
                    ),
                  ),
                ),
              ],
            ),
            if (showDiscount)
              TextField(
                key: ValueKey('sales-line-discount-$index'),
                keyboardType: TextInputType.number,
                decoration: const InputDecoration(
                  labelText: 'Chiết khấu dòng (VND — khác chiết khấu toàn đơn)',
                ),
                onChanged: (raw) => onChanged(
                  line.copyWith(
                    lineDiscount: int.tryParse(raw.replaceAll(RegExp('[^0-9]'), '')) ?? 0,
                  ),
                ),
              ),
          ],
        ),
      ),
    );
  }
}
