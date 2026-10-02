import 'package:flutter/material.dart';

import '../../app/theme/app_theme.dart';

/// Drawer plan (rev 2) §2.1/§2.2 — the ONLY provenance a payload may carry for
/// this app to render it as the shop's figures.
///
/// The value comes from the SERVER (`meta.erp_target` on the day summary,
/// `erp_target` on a drill and on a read list) and is never inferred here: the
/// gateway URL tells the app where the copilot is, not what the copilot reads.
///
/// Two cases are deliberately the same case:
///   * `MOCK` — the gateway was started with `COPILOT_MOCK_OK=1`, so the numbers
///     are fixtures, not books;
///   * `null` / anything unrecognised — the payload did not say, and an invented
///     "probably REAL" beside a money figure is exactly what §2.1 forbids.
const String realProvenance = 'REAL';

/// True only for the one provenance that may be rendered.
bool isRealProvenance(String? erpTarget) => erpTarget == realProvenance;

/// Shown **instead of** the figures when [isRealProvenance] is false.
///
/// It replaces the numbers rather than sitting above them: a warning banner over
/// a full set of figures is still a screen showing money it cannot vouch for.
/// This is a deliberate product rule, not a nicety — see the D0.5 REAL-only
/// audit, where "MOCK ⇒ no figures" was chosen over "MOCK ⇒ labelled figures".
class InvalidProvenancePanel extends StatelessWidget {
  const InvalidProvenancePanel({super.key, this.erpTarget, this.onRetry});

  /// What the server said, verbatim (`REAL` / `MOCK` / null). Null is presented
  /// as "chưa rõ", never silently upgraded to REAL.
  final String? erpTarget;

  /// Re-reads. Null when the caller has nothing to re-read.
  final Future<void> Function()? onRetry;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    final isMock = erpTarget == 'MOCK';
    return Padding(
      padding: const EdgeInsets.all(AppSpacing.lg),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Icon(Icons.report_gmailerrorred_outlined, size: 32, color: scheme.error),
          const SizedBox(height: AppSpacing.sm),
          Text(
            isMock
                ? 'Không hiện số liệu — máy chủ đang đọc dữ liệu giả lập'
                : 'Không hiện số liệu — chưa rõ nguồn dữ liệu',
            textAlign: TextAlign.center,
            style: theme.textTheme.titleSmall,
          ),
          const SizedBox(height: AppSpacing.xs),
          Text(
            isMock
                ? 'Máy chủ đang chạy ở chế độ thử (MOCK): số ở chế độ này là bộ dữ liệu '
                    'mẫu, không phải sổ của cửa hàng — nên app không hiện chúng.'
                : 'Máy chủ không cho biết số này đọc từ ERPNext thật hay từ dữ liệu giả lập. '
                    'Không hiện, để một con số không rõ nguồn không bị đọc như số thật.',
            textAlign: TextAlign.center,
            style: theme.textTheme.bodySmall,
          ),
          if (onRetry != null) ...[
            const SizedBox(height: AppSpacing.md),
            FilledButton(
              key: const ValueKey('invalid-provenance-retry'),
              onPressed: () => onRetry!(),
              child: const Text('Thử lại'),
            ),
          ],
        ],
      ),
    );
  }
}
