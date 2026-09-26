import 'package:flutter/material.dart';

import '../../../../app/theme/app_theme.dart';
import '../../data/ocr_compose.dart';
import '../../data/ocr_models.dart';

/// What the user chose to do with a reading.
enum OcrSheetAction {
  /// Put the (edited) text into the chat field. NEVER sends it: the shop owner
  /// reviews and presses Gửi themselves (plan3 §6.4 — "Luôn sửa field trước
  /// confirm").
  injectText,

  /// The reading is not usable (or the user says so) — drop into manual entry.
  manualEntry,

  /// C2: turn the reading into a document of a KIND the user picked. The kind is
  /// a word from the contract's list ('sales' / 'purchase'); the form is
  /// prefilled from the photo and the user corrects it before anything is sent.
  buildDocument,
}

class OcrSheetChoice {
  const OcrSheetChoice(this.action, [this.text = '', this.kind = '']);

  final OcrSheetAction action;
  final String text;

  /// Only meaningful for [OcrSheetAction.buildDocument].
  final String kind;
}

/// The label on the kind button, in the user's words. The CONTRACT owns the
/// mapping kind → capability (`ocr_policy.document_kinds`); this is only copy.
const Map<String, String> ocrKindLabels = {
  'sales': 'Đơn bán',
  'purchase': 'Đơn mua',
};

/// C1 — the result of reading a photo.
///
/// Two rules shape this screen:
///
///  1. A PHOTO IS NOT A COMMAND. The only actions offered are "put this text in
///     the field" and "let me type it" — there is no send button, no proposal,
///     and nothing that could reach `/execute`.
///  2. WHAT THE READER IS UNSURE ABOUT IS SAID OUT LOUD. The recognised text is
///     shown EDITABLE, the confidence is shown next to it, an instruction-shaped
///     photo is called out, and a mock reading is labelled as a rehearsal — the
///     user decides, with the uncertainty in front of them (plan3 §6.4).
///
/// Returns null when the user closes without choosing.
Future<OcrSheetChoice?> showOcrSheet(BuildContext context, OcrRead read) {
  return showModalBottomSheet<OcrSheetChoice>(
    context: context,
    isScrollControlled: true,
    builder: (context) => OcrSheet(read: read),
  );
}

class OcrSheet extends StatefulWidget {
  const OcrSheet({super.key, required this.read});

  final OcrRead read;

  @override
  State<OcrSheet> createState() => _OcrSheetState();
}

class _OcrSheetState extends State<OcrSheet> {
  late final TextEditingController _controller;

  @override
  void initState() {
    super.initState();
    _controller = TextEditingController(text: widget.read.text);
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final read = widget.read;
    final usable = read.usable;
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
                const Icon(Icons.photo_camera_outlined),
                const SizedBox(width: AppSpacing.sm),
                Expanded(
                  child: Text('Đọc từ ảnh', style: theme.textTheme.titleMedium),
                ),
              ],
            ),
            const SizedBox(height: AppSpacing.sm),

            // Why it cannot be used — only when it cannot.
            if (!usable && read.refusalReason != null)
              _Notice(text: read.refusalReason!, isError: true),

            if (usable) ...[
              Text(
                'Nội dung đọc được (sửa lại nếu sai):',
                style: theme.textTheme.bodySmall,
              ),
              const SizedBox(height: AppSpacing.xs),
              TextField(
                controller: _controller,
                minLines: 3,
                maxLines: 8,
                keyboardType: TextInputType.multiline,
              ),
            ],

            const SizedBox(height: AppSpacing.sm),
            Text(_trustLine(read), style: theme.textTheme.bodySmall),

            if (read.instructionPatternFound) ...[
              const SizedBox(height: AppSpacing.xs),
              const _Notice(
                text: 'Ảnh có nội dung giống chỉ dẫn hệ thống. Nội dung đó đã bị '
                    'lọc bỏ và chỉ được coi là chữ trên giấy.',
                isError: false,
              ),
            ],

            if (read.mock) ...[
              const SizedBox(height: AppSpacing.xs),
              const _Notice(
                text: 'Đây là bản đọc THỬ (máy chủ đang chạy chế độ mô phỏng), '
                    'không phải nội dung thật trên ảnh của bạn.',
                isError: false,
              ),
            ],

            const SizedBox(height: AppSpacing.md),
            // C2 — the only route from a photo to a document. A photo carries no
            // verb (measured: an invoice reading routes to a READ), so the
            // DOCUMENT KIND is the user's choice, made here, visible. A reading
            // the server was unsure about never reaches this point: `usable`
            // gates it, and the server re-checks the provenance before it will
            // turn a reading into draft fields.
            if (usable && read.confidence != null && !read.mock) ...[
              Text('Ảnh này là gì?', style: theme.textTheme.bodySmall),
              Row(
                children: [
                  for (final kind in OcrCompose.kinds) ...[
                    Expanded(
                      child: OutlinedButton(
                        key: Key('ocr-kind-$kind'),
                        onPressed: () => Navigator.of(context).pop(
                          OcrSheetChoice(
                            OcrSheetAction.buildDocument,
                            _controller.text,
                            kind,
                          ),
                        ),
                        child: Text(ocrKindLabels[kind] ?? kind),
                      ),
                    ),
                    if (kind != OcrCompose.kinds.last) const SizedBox(width: AppSpacing.xs),
                  ],
                ],
              ),
              const SizedBox(height: AppSpacing.xs),
            ],
            if (usable)
              FilledButton.icon(
                key: const Key('ocr-inject'),
                onPressed: () => Navigator.of(context).pop(
                  OcrSheetChoice(OcrSheetAction.injectText, _controller.text),
                ),
                icon: const Icon(Icons.keyboard_alt_outlined),
                label: const Text('Đưa vào ô chat'),
              ),
            const SizedBox(height: AppSpacing.xs),
            OutlinedButton.icon(
              key: const Key('ocr-manual'),
              onPressed: () => Navigator.of(context)
                  .pop(const OcrSheetChoice(OcrSheetAction.manualEntry)),
              icon: const Icon(Icons.edit_outlined),
              label: const Text('Nhập tay từ ảnh'),
            ),
            TextButton(
              key: const Key('ocr-close'),
              onPressed: () => Navigator.of(context).pop(),
              child: const Text('Đóng'),
            ),
            // The user reviews and sends: nothing here can post a question, and
            // nothing here can execute a write.
            Text(
              'Ảnh chỉ được đọc thành chữ. Bạn xem lại rồi tự bấm Gửi.',
              style: theme.textTheme.bodySmall,
            ),
          ],
        ),
      ),
    );
  }

  /// The trust line: what the reader claimed, in the user's terms.
  static String _trustLine(OcrRead read) {
    final percent = read.confidencePercent;
    final floor = read.minConfidencePercent;
    final parts = <String>[];
    if (percent != null) {
      parts.add('Độ tin cậy $percent%');
      if (floor != null) parts.add('tối thiểu $floor%');
    } else {
      parts.add('Độ tin cậy: máy đọc không báo');
    }
    if (read.provider != null) parts.add('nguồn: ${read.provider}');
    return parts.join(' · ');
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
