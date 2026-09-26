import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../../app/providers.dart';
import '../../../../app/theme/app_theme.dart';

/// P4-3 (plan4_final §2) — the mandatory status line of the read screens:
/// **REAL ERPNext | MOCK · URL · when it was read**.
///
/// Why this is not decoration: every number in this part of the app is money,
/// and a fixture day looks EXACTLY like a real one. The label comes from the
/// server (`meta.erp_target`, `copilot-server.mjs#erpTargetLabel`) — the client
/// cannot infer it, because the gateway URL says where the COPILOT runs, not
/// what the copilot reads.
///
/// When the server did not say, this widget prints that it does not know. It
/// never falls back to "REAL": an invented provenance on a money screen is the
/// kind of lie that makes a rehearsal look like the shop's books.
class SummaryStatusFooter extends ConsumerWidget {
  const SummaryStatusFooter({
    super.key,
    this.erpTarget,
    this.updatedAt,
    this.stale = false,
    this.padding = const EdgeInsets.symmetric(
      horizontal: AppSpacing.md,
      vertical: AppSpacing.sm,
    ),
  });

  /// `REAL` / `MOCK` from the server, or null when it did not say.
  final String? erpTarget;

  /// When this device received the payload (local time) — null before any read.
  final DateTime? updatedAt;

  /// True when what is on screen came from the cache, not from this session.
  final bool stale;

  final EdgeInsets padding;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final theme = Theme.of(context);
    // The EFFECTIVE base URL: a value saved in Settings wins over the compiled-in
    // --dart-define (same expression the chat screen's footer uses).
    final settings = ref.watch(appSettingsServiceProvider);
    final baseUrl = settings.gatewayBaseUrl.isNotEmpty
        ? settings.gatewayBaseUrl
        : ref.watch(appEnvironmentProvider).copilotBaseUrl;

    final (label, color) = switch (erpTarget) {
      'REAL' => ('REAL ERPNext', theme.colorScheme.primary),
      'MOCK' => ('MOCK (dữ liệu giả lập)', theme.colorScheme.error),
      _ => ('Không rõ nguồn dữ liệu', theme.colorScheme.outline),
    };

    return Padding(
      padding: padding,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Icon(Icons.circle, size: 8, color: color),
              const SizedBox(width: AppSpacing.xs),
              Flexible(
                child: Text(
                  label,
                  style: theme.textTheme.labelSmall?.copyWith(color: color),
                  overflow: TextOverflow.ellipsis,
                ),
              ),
              if (stale) ...[
                const SizedBox(width: AppSpacing.sm),
                Text(
                  'DỮ LIỆU CŨ',
                  style: theme.textTheme.labelSmall
                      ?.copyWith(color: theme.colorScheme.error),
                ),
              ],
            ],
          ),
          Text(
            updatedAt == null
                ? 'Chưa đọc lần nào trong phiên này.'
                : 'Cập nhật ${_clock(updatedAt!)}',
            style: theme.textTheme.labelSmall,
          ),
          Text(
            'COPILOT_BASE_URL: $baseUrl',
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: theme.textTheme.labelSmall,
          ),
        ],
      ),
    );
  }
}

String _clock(DateTime t) {
  final local = t.toLocal();
  String two(int n) => n.toString().padLeft(2, '0');
  return '${two(local.hour)}:${two(local.minute)}:${two(local.second)}';
}
