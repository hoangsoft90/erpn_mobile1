import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../../app/providers.dart';
import '../../../../app/theme/app_theme.dart';
import '../../../../core/widgets/data_provenance.dart';
import '../../data/chat_models.dart';
import '../../data/copilot_api_client.dart';

/// A1 (plan3 Trụ A) — the READ drill-down behind the bubble button.
///
/// Data does not come from the chat turn: the intent only names WHICH screen and
/// WHICH entity, and this screen fetches `/read/list` fresh (the point of the
/// button is a current list, not a re-render of the answer). READ-only — the
/// screen has no confirm/execute affordance and no path to `/execute`.
class ReadListScreen extends ConsumerStatefulWidget {
  const ReadListScreen({super.key, required this.intent});

  final ReadUiIntent intent;

  @override
  ConsumerState<ReadListScreen> createState() => _ReadListScreenState();
}

class _ReadListScreenState extends ConsumerState<ReadListScreen> {
  ReadScreenData? _data;
  String? _error;
  bool _loading = false;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    if (_loading) return;
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final data = await ref.read(copilotApiClientProvider).readList(
            screen: widget.intent.screen,
            entityId: widget.intent.entityId,
            limit: widget.intent.limit,
          );
      // The user can leave while the read is in flight; writing state after
      // dispose is the classic crash this project already paid for once.
      if (!mounted) return;
      setState(() {
        _data = data;
        _loading = false;
      });
    } on CopilotException catch (err) {
      if (!mounted) return;
      setState(() {
        _error = err.message;
        _loading = false;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final title = widget.intent.title.isNotEmpty
        ? widget.intent.title
        : 'Chi tiết công nợ';
    return Scaffold(
      appBar: AppBar(
        title: Text(title),
        leading: BackButton(onPressed: () => Navigator.of(context).maybePop()),
      ),
      body: SafeArea(child: _body(context)),
    );
  }

  Widget _body(BuildContext context) {
    final data = _data;
    if (data == null && _loading) {
      return const Padding(
        padding: EdgeInsets.all(AppSpacing.lg),
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            CircularProgressIndicator(),
            SizedBox(height: AppSpacing.md),
            Text('Đang đọc dữ liệu mới nhất từ ERPNext…'),
          ],
        ),
      );
    }
    if (data == null && _error != null) {
      return Padding(
        padding: const EdgeInsets.all(AppSpacing.lg),
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Text(
              _error!,
              textAlign: TextAlign.center,
              style: TextStyle(color: Theme.of(context).colorScheme.error),
            ),
            const SizedBox(height: AppSpacing.md),
            FilledButton(onPressed: _load, child: const Text('Thử lại')),
          ],
        ),
      );
    }
    if (data == null) return const SizedBox.shrink();
    // §2.1/§2.2 — the debt figure and the document list are replaced, not
    // labelled, when the payload's source is not REAL.
    if (!isRealProvenance(data.erpTarget)) {
      return InvalidProvenancePanel(erpTarget: data.erpTarget, onRetry: _load);
    }
    return _ReadView(data: data, onRefresh: _load, refreshing: _loading);
  }
}

class _ReadView extends StatelessWidget {
  const _ReadView({
    required this.data,
    required this.onRefresh,
    required this.refreshing,
  });

  final ReadScreenData data;
  final Future<void> Function() onRefresh;
  final bool refreshing;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final scheme = theme.colorScheme;
    return RefreshIndicator(
      onRefresh: onRefresh,
      child: ListView(
        padding: const EdgeInsets.all(AppSpacing.md),
        children: [
          Card(
            color: scheme.surfaceContainerHighest,
            child: Padding(
              padding: const EdgeInsets.all(AppSpacing.md),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    data.entityName ?? data.entityId,
                    style: theme.textTheme.titleMedium,
                  ),
                  const SizedBox(height: AppSpacing.xs),
                  Text(
                    'Còn nợ ${_vnd(data.outstandingVnd)}đ '
                    '(${data.openDocuments} chứng từ chưa thanh toán)',
                    style: theme.textTheme.bodyMedium,
                  ),
                ],
              ),
            ),
          ),
          const SizedBox(height: AppSpacing.sm),
          if (data.rows.isEmpty)
            Padding(
              padding: const EdgeInsets.all(AppSpacing.md),
              child: Text(
                'Không còn chứng từ nào chưa thanh toán.',
                style: theme.textTheme.bodyMedium,
              ),
            )
          else ...[
            Padding(
              padding: const EdgeInsets.symmetric(vertical: AppSpacing.sm),
              child: Text(
                data.truncated
                    // Never let a capped list look like the whole debt: the
                    // server sends how many documents exist.
                    ? 'Hiện ${data.rows.length}/${data.totalDocuments} chứng từ '
                        '(danh sách giới hạn ${data.limit})'
                    : '${data.totalDocuments} chứng từ chưa thanh toán',
                style: theme.textTheme.labelMedium,
              ),
            ),
            for (final row in data.rows)
              ListTile(
                dense: true,
                contentPadding: EdgeInsets.zero,
                title: Text(row.name),
                subtitle: Text(row.date ?? 'không rõ ngày'),
                trailing: Text(
                  '${_vnd(row.outstandingVnd)}đ',
                  style: TextStyle(
                    fontWeight: FontWeight.w600,
                    color: row.outstandingVnd < 0
                        ? scheme.primary
                        : scheme.onSurface,
                  ),
                ),
              ),
            if (data.truncated)
              Padding(
                padding: const EdgeInsets.only(top: AppSpacing.sm),
                child: Text(
                  'Còn ${data.totalDocuments - data.rows.length} chứng từ khác — '
                  'xem đầy đủ trên ERPNext.',
                  style: theme.textTheme.bodySmall,
                ),
              ),
          ],
          const SizedBox(height: AppSpacing.md),
          Text(
            // A READ is only as good as when it was taken: the server stamps
            // every read, so "lúc mấy giờ" is answerable instead of assumed.
            '${_readAt(data.generatedAt)} Màn này chỉ để xem — '
            'muốn thu tiền, quay lại chat và nói câu lệnh.',
            style: theme.textTheme.bodySmall,
          ),
        ],
      ),
    );
  }
}

/// "Số liệu đọc lúc 14:05 từ ERPNext." Falls back to a plain sentence when the
/// server sent no stamp (an old payload must not render "null").
String _readAt(String? iso) {
  final t = iso == null ? null : DateTime.tryParse(iso)?.toLocal();
  if (t == null) return 'Số liệu đọc trực tiếp từ ERPNext.';
  final hh = t.hour.toString().padLeft(2, '0');
  final mm = t.minute.toString().padLeft(2, '0');
  return 'Số liệu đọc lúc $hh:$mm từ ERPNext.';
}

/// Display-only grouping of a number that came from ERPNext — the same
/// fixed-point shape the server uses (2500000 → "2.500.000"). No arithmetic
/// happens here: money is copied, never computed, on the client either.
String _vnd(int n) => n.toString().replaceAllMapped(
      RegExp(r'\B(?=(\d{3})+(?!\d))'),
      (_) => '.',
    );
