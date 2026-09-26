import 'package:flutter/material.dart';

import '../../../../app/theme/app_theme.dart';
import '../../data/ocr_compose.dart';
import '../../data/ocr_models.dart';

/// C2 (`plan3` Trụ C) — the form between a PHOTO and a proposal.
///
/// plan3 §6.4: "Luôn sửa field trước confirm". A reading is a guess about a
/// photograph, so every field it produced is shown EDITABLE, `raw_quantity`
/// shows the words each number came from, and what the reader could not work out
/// is said out loud. Only when the user sends does a sentence leave this screen.
///
/// Returns the sentence to send, or null when the user closed without sending.
/// The caller feeds it to the ordinary chat send path — this widget has no
/// request of its own, no price, and no way to execute anything.
Future<String?> showOcrSlotsForm(
  BuildContext context,
  OcrSlots slots, {
  OcrSlotsSource source = OcrSlotsSource.photo,
}) {
  return showModalBottomSheet<String>(
    context: context,
    isScrollControlled: true,
    builder: (context) => OcrSlotsForm(slots: slots, source: source),
  );
}

/// Which CHANNEL produced these slots: the camera (C2) or a supplier's HÓA ĐƠN
/// ĐIỆN TỬ file — `.xml` (A2) or `.pdf` (A3).
///
/// It changes WORDING ONLY. The fields, the corrections, the composed sentence
/// and the pipeline behind it are identical on purpose — one form, one write
/// path. Two things would be wrong and this enum is what prevents both: calling
/// a file a photo (or the reverse) in front of the person about to confirm a
/// document, and a second, channel-specific form growing a second pipeline.
///
/// The file branch says FILE, not "XML": both formats arrive as a file the shop
/// was sent, and the sheet is the same sheet for both. Which format it actually
/// was is carried by the file's own name (shown in the chat notice) and by what
/// the server's reader could get out of it — never by a claim this copy makes.
enum OcrSlotsSource {
  photo,
  file;

  /// The noun in the sheet's own copy: "<title> → Đơn mua (NHÁP)".
  String get title => this == OcrSlotsSource.photo ? 'Ảnh' : 'File hoá đơn';

  /// Where a line's raw words came from: "trên ảnh: \"10 Bao\"".
  String get rawPrefix =>
      this == OcrSlotsSource.photo ? 'trên ảnh' : 'trên file hoá đơn';
}

class OcrSlotsForm extends StatefulWidget {
  const OcrSlotsForm({
    super.key,
    required this.slots,
    this.source = OcrSlotsSource.photo,
  });

  final OcrSlots slots;

  /// Only copy changes — see [OcrSlotsSource].
  final OcrSlotsSource source;

  @override
  State<OcrSlotsForm> createState() => _OcrSlotsFormState();
}

class _OcrSlotsFormState extends State<OcrSlotsForm> {
  late final TextEditingController _party;
  late final List<_LineFields> _lines;

  @override
  void initState() {
    super.initState();
    _party = TextEditingController(text: widget.slots.party.resolved ?? '');
    _lines = widget.slots.lines.map(_LineFields.of).toList();
  }

  @override
  void dispose() {
    _party.dispose();
    for (final line in _lines) {
      line.dispose();
    }
    super.dispose();
  }

  bool get _isPurchase => widget.slots.kind == 'purchase';

  /// What will actually be sent — recomputed on every keystroke so the user never
  /// confirms a sentence they have not read.
  String get _preview => OcrCompose.compose(
        kind: widget.slots.kind,
        party: _party.text,
        lines: _lines.map((line) => line.toSlot()).toList(),
      );

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final slots = widget.slots;
    final preview = _preview;
    return Padding(
      padding: EdgeInsets.only(
        left: AppSpacing.md,
        right: AppSpacing.md,
        top: AppSpacing.md,
        bottom: MediaQuery.of(context).viewInsets.bottom + AppSpacing.md,
      ),
      child: SingleChildScrollView(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Row(
              children: [
                const Icon(Icons.receipt_long_outlined),
                const SizedBox(width: AppSpacing.sm),
                Expanded(
                  child: Text('${widget.source.title} → ${slots.label} (NHÁP)',
                      style: theme.textTheme.titleMedium),
                ),
              ],
            ),
            const SizedBox(height: AppSpacing.xs),
            Text(
              'Máy chỉ đọc hộ. Bạn sửa lại cho đúng rồi bấm gửi — số tiền sẽ do '
              'ERPNext tính, không lấy theo con số trên ảnh.',
              style: theme.textTheme.bodySmall,
            ),
            const SizedBox(height: AppSpacing.sm),

            for (final warning in slots.warnings)
              _Notice(text: warning.reason, isError: true),

            TextField(
              key: const Key('slots-party'),
              controller: _party,
              onChanged: (_) => setState(() {}),
              decoration: InputDecoration(
                labelText: _isPurchase ? 'Nhà cung cấp' : 'Khách hàng',
                hintText: _isPurchase ? 'tên nhà cung cấp' : 'tên khách',
              ),
            ),
            if (slots.party.ambiguous || slots.party.candidates.isNotEmpty) ...[
              const SizedBox(height: AppSpacing.xs),
              Text(
                'Tên trên ảnh có thể là:',
                style: theme.textTheme.bodySmall,
              ),
              Wrap(
                spacing: AppSpacing.xs,
                children: [
                  for (final candidate in slots.party.candidates)
                    ActionChip(
                      label: Text(candidate),
                      onPressed: () => setState(() => _party.text = candidate),
                    ),
                ],
              ),
            ],

            const SizedBox(height: AppSpacing.sm),
            if (_lines.isEmpty)
              _Notice(
                text: '${widget.source.title} không cho ra dòng hàng nào — bạn nhập tay giúp tôi.',
                isError: true,
              ),
            for (var i = 0; i < _lines.length; i++) _lineRow(theme, i),

            if (slots.moneyVnd != null) ...[
              const SizedBox(height: AppSpacing.xs),
              Text(
                'Ảnh ghi tổng ${_money(slots.moneyVnd!)} — chỉ để đối chiếu.',
                style: theme.textTheme.bodySmall,
              ),
            ],

            const SizedBox(height: AppSpacing.sm),
            Text('Câu sẽ gửi:', style: theme.textTheme.bodySmall),
            Container(
              width: double.infinity,
              padding: const EdgeInsets.all(AppSpacing.sm),
              decoration: BoxDecoration(
                color: theme.colorScheme.surfaceContainerHighest,
                borderRadius: BorderRadius.circular(12), // design token: radius.md
              ),
              child: Text(preview.isEmpty ? '(chưa có gì để gửi)' : preview),
            ),

            const SizedBox(height: AppSpacing.md),
            FilledButton.icon(
              key: const Key('slots-send'),
              onPressed: preview.isEmpty
                  ? null
                  : () => Navigator.of(context).pop(preview),
              icon: const Icon(Icons.send_outlined),
              label: Text('Gửi để lập ${slots.label} NHÁP'),
            ),
            TextButton(
              key: const Key('slots-close'),
              onPressed: () => Navigator.of(context).pop(),
              child: const Text('Đóng'),
            ),
            Text(
              'Gửi ở đây chỉ là hỏi. Đơn vẫn phải bấm [Xác nhận] ở thẻ đề xuất, '
              'và đơn được tạo ở dạng NHÁP.',
              style: theme.textTheme.bodySmall,
            ),
          ],
        ),
      ),
    );
  }

  Widget _lineRow(ThemeData theme, int index) {
    final line = _lines[index];
    return Padding(
      padding: const EdgeInsets.only(bottom: AppSpacing.xs),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            children: [
              SizedBox(
                width: 72,
                child: TextField(
                  key: Key('slot-qty-$index'),
                  controller: line.qty,
                  keyboardType: TextInputType.number,
                  onChanged: (_) => setState(() {}),
                  decoration: const InputDecoration(labelText: 'SL'),
                ),
              ),
              const SizedBox(width: AppSpacing.xs),
              SizedBox(
                width: 80,
                child: TextField(
                  key: Key('slot-uom-$index'),
                  controller: line.uom,
                  onChanged: (_) => setState(() {}),
                  decoration: const InputDecoration(labelText: 'ĐV'),
                ),
              ),
              const SizedBox(width: AppSpacing.xs),
              Expanded(
                child: TextField(
                  key: Key('slot-item-$index'),
                  controller: line.item,
                  onChanged: (_) => setState(() {}),
                  decoration: const InputDecoration(labelText: 'Mặt hàng'),
                ),
              ),
            ],
          ),
          if (line.raw != null)
            Text('${widget.source.rawPrefix}: "${line.raw}"',
                style: theme.textTheme.bodySmall),
        ],
      ),
    );
  }

  static String _money(int value) {
    final digits = value.abs().toString();
    final buffer = StringBuffer();
    for (var i = 0; i < digits.length; i++) {
      if (i > 0 && (digits.length - i) % 3 == 0) buffer.write('.');
      buffer.write(digits[i]);
    }
    return '${value < 0 ? '-' : ''}${buffer.toString()}đ';
  }
}

/// One editable line's controllers. Quantity accepts a Vietnamese comma
/// ("10,5") because that is how the number is written on paper here.
class _LineFields {
  _LineFields({required this.qty, required this.uom, required this.item, this.raw});

  factory _LineFields.of(OcrSlotLine line) => _LineFields(
        qty: TextEditingController(text: line.qty == null ? '' : _number(line.qty!)),
        uom: TextEditingController(text: line.uom ?? ''),
        item: TextEditingController(text: line.itemName ?? ''),
        raw: line.rawQuantity,
      );

  final TextEditingController qty;
  final TextEditingController uom;
  final TextEditingController item;
  final String? raw;

  void dispose() {
    qty.dispose();
    uom.dispose();
    item.dispose();
  }

  OcrSlotLine toSlot() => OcrSlotLine(
        itemCode: null,
        itemName: item.text.trim().isEmpty ? null : item.text.trim(),
        qty: _parseNumber(qty.text),
        uom: uom.text.trim().isEmpty ? null : uom.text.trim(),
        rawQuantity: raw,
      );

  static String _number(double value) =>
      value == value.roundToDouble() ? value.round().toString() : value.toString();

  static double? _parseNumber(String raw) {
    final text = raw.trim().replaceAll('.', '').replaceAll(',', '.');
    if (text.isEmpty) return null;
    return double.tryParse(text);
  }
}

class _Notice extends StatelessWidget {
  const _Notice({required this.text, required this.isError});

  final String text;
  final bool isError;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.all(AppSpacing.sm),
      margin: const EdgeInsets.only(bottom: AppSpacing.xs),
      decoration: BoxDecoration(
        color: isError
            ? theme.colorScheme.errorContainer
            : theme.colorScheme.surfaceContainerHighest,
        borderRadius: BorderRadius.circular(12), // design token: radius.md
      ),
      child: Text(
        text,
        style: theme.textTheme.bodySmall?.copyWith(
          color: isError ? theme.colorScheme.onErrorContainer : null,
        ),
      ),
    );
  }
}
