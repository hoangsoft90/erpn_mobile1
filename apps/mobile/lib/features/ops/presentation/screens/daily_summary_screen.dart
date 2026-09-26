import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../../app/providers.dart';
import '../../../../app/theme/app_theme.dart';
import '../../../../core/constants/app_constants.dart';
import '../../../../core/widgets/data_provenance.dart';
import '../../../chat/data/copilot_api_client.dart';
import '../../data/daily_summary_models.dart';
import '../../data/drill_models.dart';
import '../widgets/app_drawer.dart';
import '../widgets/summary_status_footer.dart';

/// P4-3 (plan4_final §2, §6) — "Tóm tắt ngày", the drawer's default screen.
///
/// A READ screen, and only that. Everything on it comes from
/// `/read/daily-summary` (one server-side aggregate); there is no button here
/// that creates, submits, pays or deletes, and the screen has no path to
/// `/execute` — every write still travels the chat + confirm-card route (§2).
///
/// The states §6 asks for, and the rule behind each:
///   * **Loading** → skeleton, so a slow read never looks like an empty day;
///   * **OK** → numbers plus the server's `generated_at` stamp;
///   * **Partial** → the failing BLOCK shows "Lỗi · Thử lại" (§4.3). It is
///     never given a 0: a fabricated zero on this screen would read as "khách
///     không trả đồng nào", which is a money statement, not a blank;
///   * **offline / 401 / 503** → keep the last numbers but label them
///     "DỮ LIỆU CŨ" + the reason, instead of going blank;
///   * **empty day** → zeros are legitimate ONLY when the server measured them
///     (`partial=false`), so the screen says the day is quiet rather than
///     leaving the user to guess whether the read failed.
class DailySummaryScreen extends ConsumerStatefulWidget {
  const DailySummaryScreen({super.key});

  @override
  ConsumerState<DailySummaryScreen> createState() => _DailySummaryScreenState();
}

class _DailySummaryScreenState extends ConsumerState<DailySummaryScreen> {
  DailySummary? _data;

  /// P4-6 (§6): the PREVIOUS day, read in the same pass as [_data] so the
  /// absolute delta can be computed from two server answers instead of a
  /// client-side second guess. Never rendered as the primary day.
  DailySummary? _yesterday;

  /// P4-6: null = hôm nay (mặc định); 'Hôm qua' = xem ngày trước. It names a
  /// VIEW, not a date: the actual YYYY-MM-DD stays server-side (§3.7 — the
  /// phone's clock never picks the day).
  String? _viewDay;

  /// True while the on-demand yesterday read is in flight (dedupe taps).
  bool _yesterdayLoading = false;

  /// When THIS device received [_data] — not [DailySummaryMeta.generatedAt],
  /// which is the server's own stamp and may be older (cache).
  DateTime? _fetchedAt;
  bool _stale = false;
  String? _error;
  bool _loading = false;

  @override
  void initState() {
    super.initState();
    _load();
  }

  /// [force] is what pull-to-refresh and a block's "Thử lại" pass: the
  /// freshness window exists to save ERP round trips, and an explicit tap is the
  /// user overriding it, not something to be ignored.
  Future<void> _load({bool force = false}) async {
    if (_loading) return;

    // 1. Paint what we already have. Inside the freshness window that is the
    //    whole job — no request, so re-opening the drawer is free.
    if (_data == null) {
      final cached = await ref.read(dailySummaryCacheProvider).read();
      final restored = _parseCached(cached?.rawJson);
      if (!mounted) return;
      if (restored != null && cached != null) {
        final fresh = cached.isFresh(AppConstants.summaryCacheWindow);
        setState(() {
          _data = restored;
          _fetchedAt = cached.fetchedAt;
          // Inside the window this is still today's read, so it is not labelled
          // "cũ"; past it, say so and the live read below replaces it.
          _stale = !fresh;
        });
        if (!force && fresh) return;
      }
    } else if (!force &&
        _fetchedAt != null &&
        DateTime.now().toUtc().difference(_fetchedAt!) <
            AppConstants.summaryCacheWindow) {
      return;
    }

    // 2. Read the day from the gateway.
    setState(() => _loading = true);
    try {
      final client = ref.read(copilotApiClientProvider);
      final at = DateTime.now();
      // P4-6: yesterday is read LAZILY — when the user first picks "Hôm qua"
      // (see [_loadYesterday]), not on every entry. Two reasons: the delta is
      // OPTIONAL (§6), and an eager read would either cost an extra ERP
      // aggregate on every drawer open or silently vanish whenever the screen
      // re-mounted into a fresh cache.
      final summary = await client.dailySummary();
      if (!mounted) return;
      setState(() {
        _data = summary;
        _fetchedAt = at;
        _stale = false;
        _error = null;
        _loading = false;
      });
      await ref.read(dailySummaryCacheProvider).write(summary.rawJson, at: at);
    } on CopilotException catch (err) {
      if (!mounted) return;
      setState(() {
        _error = err.message;
        _loading = false;
        // Keep the numbers we have and SAY they are old (§6) rather than
        // replacing a readable day with an error page.
        _stale = _data != null;
      });
    }
  }

  /// P4-6: read YESTERDAY on demand, the first time the user picks "Hôm qua".
  ///
  /// The delta needs a second day; making that read conditional on the user's
  /// tap keeps the default path exactly as cheap as it was before P4-6, and it
  /// survives the screen re-mounting into a fresh cache (an eager read in
  /// [_load] did NOT, because the cache branch returns before any read).
  ///
  /// Failure is swallowed into `_yesterday = null`: a day we could not read is
  /// "không rõ", never a zero to subtract from.
  Future<void> _loadYesterday() async {
    if (_yesterdayLoading) return;
    // §3.7: the day belongs to the SHOP, not the phone. The server decides
    // "today" (vnToday, en-CA over Asia/Ho_Chi_Minh); the client derives the
    // previous CALENDAR day the same way — VN midnight minus one day — so the
    // comparison day is the shop's, never the phone's.
    final String? yesterdayParam;
    try {
      final vnNow = DateTime.now().toUtc().add(const Duration(hours: 7));
      final vnMidnight = DateTime.utc(vnNow.year, vnNow.month, vnNow.day);
      final yesterday = vnMidnight.subtract(const Duration(days: 1));
      const monthNames = ['01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '11', '12'];
      yesterdayParam =
          '${yesterday.year}-${monthNames[yesterday.month - 1]}-${yesterday.day.toString().padLeft(2, '0')}';
    } catch (_) {
      setState(() => _yesterday = null);
      return;
    }
    setState(() => _yesterdayLoading = true);
    try {
      final y = await ref.read(copilotApiClientProvider).dailySummary(date: yesterdayParam);
      if (!mounted) return;
      setState(() {
        _yesterday = y;
        _yesterdayLoading = false;
      });
    } on CopilotException {
      if (!mounted) return;
      setState(() {
        _yesterday = null;
        _yesterdayLoading = false;
      });
    }
  }

  /// A cached body is replayed through the SAME parser as a live one; a corrupt
  /// entry returns null so the live read still happens (a broken cache must be
  /// able to hide the day).
  DailySummary? _parseCached(String? raw) {
    if (raw == null || raw.isEmpty) return null;
    try {
      final decoded = jsonDecode(raw);
      if (decoded is! Map<String, dynamic>) return null;
      return DailySummary.fromJson(decoded, rawJson: raw);
    } catch (_) {
      return null;
    }
  }

  @override
  Widget build(BuildContext context) {
    // D4 (§2.4 / review6) — a Settings save invalidates the settings service,
    // which rebuilds `copilotApiClientProvider`. A NEW client means the app may
    // now be pointed at another server or account: the day on screen is no
    // longer this app's day, so re-read instead of leaving the previous books'
    // numbers under the new server's footer. (The Settings screen clears the
    // persisted `DailySummaryCache` at the same moment; this half covers the
    // screen that is STILL MOUNTED in the stack when the user comes back.)
    ref.listen(copilotApiClientProvider, (prev, next) {
      if (identical(prev, next)) return;
      unawaited(_load(force: true));
    });
    final data = _data;
    return Scaffold(
      drawer: AppDrawer(
        currentRoute: '/summary',
        company: data?.meta.company,
        erpTarget: data?.meta.erpTarget,
        updatedAt: _fetchedAt,
        stale: _stale,
        // D4 (§6, optional badge) — the count the summary ALREADY read; the
        // drawer adds no request of its own, so it can never block opening.
        // Null when the drafts block could not be read ⇒ no badge (never "0").
        draftsBadge: data?.appDrafts?.count,
      ),
      appBar: AppBar(title: const Text('Tóm tắt ngày')),
      body: SafeArea(
        child: Column(
          children: [
            Expanded(child: _body(data)),
            SummaryStatusFooter(
              erpTarget: data?.meta.erpTarget,
              updatedAt: _fetchedAt,
              stale: _stale,
            ),
          ],
        ),
      ),
    );
  }

  Widget _body(DailySummary? data) {
    if (data == null) {
      if (_error != null && !_loading) return _FullError(message: _error!, onRetry: () => _load(force: true));
      return const _Skeleton();
    }
    // §2.1/§2.2 — a day whose source is not REAL is not rendered as the shop's
    // numbers. The figures AND the drill entry points that lead to more of them
    // are replaced by the panel below, instead of being shown under a warning
    // banner (a banner over a full set of figures still shows the figures).
    if (!isRealProvenance(data.meta.erpTarget)) {
      return ListView(
        padding: const EdgeInsets.all(AppSpacing.md),
        children: [
          if (_error != null)
            _Banner(
              key: const ValueKey('summary-stale-banner'),
              color: Theme.of(context).colorScheme.errorContainer,
              icon: Icons.cloud_off,
              text: 'Chưa cập nhật được: $_error',
              detail: 'Kéo xuống để thử lại.',
            ),
          _DayHeader(data: data),
          InvalidProvenancePanel(
            erpTarget: data.meta.erpTarget,
            onRetry: () => _load(force: true),
          ),
        ],
      );
    }
    final viewingYesterday = _viewDay != null;
    return RefreshIndicator(
      onRefresh: () => _load(force: true),
      child: ListView(
        padding: const EdgeInsets.all(AppSpacing.md),
        children: [
          if (_error != null)
            _Banner(
              key: const ValueKey('summary-stale-banner'),
              color: Theme.of(context).colorScheme.errorContainer,
              icon: Icons.cloud_off,
              text: 'Chưa cập nhật được: $_error',
              detail: 'Đang hiện số liệu đã đọc trước đó — kéo xuống để thử lại.',
            ),
          if (data.meta.partial)
            _Banner(
              key: const ValueKey('summary-partial-banner'),
              color: Theme.of(context).colorScheme.tertiaryContainer,
              icon: Icons.warning_amber_outlined,
              text: 'Một phần dữ liệu chưa đọc được.',
              detail: 'Mục nào lỗi thì ghi rõ ở chính mục đó — không hiện số 0 thay cho số chưa đọc.',
            ),
          _DayHeader(data: data),
          // P4-6 (§6): Hôm nay | Hôm qua. The pick changes the two FLOW blocks
          // (bán/thu) and their drills; debt and drafts stay today's.
          SegmentedButton<String>(
            key: const ValueKey('day-selector'),
            segments: const [
              ButtonSegment(value: 'today', label: Text('Hôm nay')),
              ButtonSegment(value: 'yesterday', label: Text('Hôm qua')),
            ],
            selected: {viewingYesterday ? 'yesterday' : 'today'},
            onSelectionChanged: (selection) {
              final yesterday = selection.contains('yesterday');
              setState(() => _viewDay = yesterday ? 'yesterday' : null);
              // First time the comparison is asked for, go and read that day.
              if (yesterday && _yesterday == null) unawaited(_loadYesterday());
            },
          ),
          const SizedBox(height: AppSpacing.xs),
          if (_isQuietDay(data)) const _QuietDay(),
          _salesOrders(data),
          // §6 day pick: the two bán/thu cards show the day they NAME. While
          // viewing Hôm qua they read YESTERDAY's object; until that read lands
          // (or if it failed) the card shows NO figure at all — today's numbers
          // must never sit under a "hôm qua" title, and a failed optional read
          // must not quietly fall back to the wrong day.
          if (viewingYesterday && _yesterday == null) ...[
            _DayNotRead(
              title: 'Hóa đơn đã xuất hôm qua (giá trị sau VAT)',
              block: 'sales_invoices',
              loading: _yesterdayLoading,
              onRetry: () => _loadYesterday(),
            ),
            _DayNotRead(
              title: 'Tiền khách trả hôm qua',
              block: 'receipts',
              loading: _yesterdayLoading,
              onRetry: () => _loadYesterday(),
            ),
          ] else ...[
            _salesInvoices(viewingYesterday ? _yesterday! : data),
            _receipts(viewingYesterday ? _yesterday! : data),
          ],
          _paymentsOut(data),
          _receivables(data),
          _appDrafts(data),
          _cashDrawer(data),
          const SizedBox(height: AppSpacing.sm),
          Text(
            // Fixes the meaning of the debt figure on a screen that also shows
            // one day's flows (§3.4: debt is CURRENT, never "as of that day") —
            // and P4-6 makes that note carry its weight when the user is
            // actually looking at yesterday.
            viewingYesterday
                ? 'Đang xem HÔM QUA: chỉ bán/thu là của ngày đó — công nợ và số nháp vẫn là số HIỆN TẠI.'
                : 'Ghi chú: công nợ là số hiện tại, không phải số cuối ngày đang xem. '
                    'Mọi thay đổi tiền vẫn làm trong chat rồi bấm xác nhận.',
            style: Theme.of(context).textTheme.bodySmall,
          ),
        ],
      ),
    );
  }

  /// A quiet day is a legitimate answer, not a failure — but only when the
  /// server actually measured it. One unreadable block means we do not know, so
  /// this stays silent then.
  bool _isQuietDay(DailySummary d) {
    if (d.meta.partial) return false;
    if (d.salesOrders == null ||
        d.salesInvoices == null ||
        d.receipts == null ||
        d.paymentsOut == null) {
      return false;
    }
    return d.salesOrders!.submitted.count == 0 &&
        d.salesOrders!.draft.count == 0 &&
        d.salesInvoices!.count == 0 &&
        d.receipts!.total == 0 &&
        d.paymentsOut!.total == 0;
  }

  Widget _salesOrders(DailySummary d) {
    final block = d.salesOrders;
    if (block == null) {
      return _BlockError(
        title: 'Đơn hàng (Sales Order)',
        block: 'sales_orders',
        summary: d,
        onRetry: () => _load(force: true),
      );
    }
    return _Card(
      title: 'Đơn hàng (Sales Order) — gồm nháp',
      // §4.4 drill ids. The interim label only shows while the read is in
      // flight; once it lands the screen titles itself with the SERVER's title,
      // so the contract stays the one source for what a drill is called.
      drill: const DrillIntent(drillId: 'sales_orders_today', title: 'Đơn hàng hôm nay'),
      child: Column(
        children: [
          _MoneyRow(
            label: 'Đã chốt (submitted) · ${block.submitted.count} đơn',
            value: block.submitted.amount,
            emphasize: true,
          ),
          _MoneyRow(
            label: 'Đang nháp · ${block.draft.count} đơn',
            value: block.draft.amount,
          ),
        ],
      ),
    );
  }

  Widget _salesInvoices(DailySummary d) {
    final block = d.salesInvoices;
    if (block == null) {
      return _BlockError(
        title: 'Hóa đơn đã xuất',
        block: 'sales_invoices',
        summary: d,
        onRetry: () => _load(force: true),
      );
    }
    return _Card(
      // "Doanh thu" is banned on this screen (§3.1): it is three different
      // numbers depending on who says it. This block is invoices, after VAT.
      title: _viewDay != null ? 'Hóa đơn đã xuất hôm qua (giá trị sau VAT)' : 'Hóa đơn đã xuất hôm nay (giá trị sau VAT)',
      drill: DrillIntent(
        drillId: 'invoices_today',
        title: _viewDay != null ? 'Hóa đơn hôm qua' : 'Hóa đơn hôm nay',
        // The drill reads the day the CARD shows — the server's own meta.date
        // for that response, never a date this phone computed (§3.7). On
        // today's view it sends none, so the server's own "today" applies.
        date: _viewDay != null ? d.meta.date : null,
      ),
      child: Column(
        children: [
          _MoneyRow(
            label: '${block.count} hóa đơn',
            value: block.amount,
            emphasize: true,
          ),
        ],
      ),
    );
  }

  Widget _receipts(DailySummary d) {
    final block = d.receipts;
    if (block == null) {
      return _BlockError(
        title: _viewDay != null ? 'Tiền khách trả hôm qua' : 'Tiền khách trả hôm nay',
        block: 'receipts',
        summary: d,
        onRetry: () => _load(force: true),
      );
    }
    return _Card(
      title: _viewDay != null ? 'Tiền khách trả hôm qua' : 'Tiền khách trả hôm nay',
      drill: DrillIntent(
        drillId: 'receipts_today',
        title: _viewDay != null ? 'Phiếu thu hôm qua' : 'Phiếu thu hôm nay',
        date: _viewDay != null ? d.meta.date : null,
      ),
      child: Column(
        children: [
          _MoneyRow(label: 'Tổng thu', value: block.total, emphasize: true),
          _MoneyRow(label: 'Tiền mặt', value: block.cash),
          _MoneyRow(label: 'Chuyển khoản', value: block.bank),
          if (block.unclassified != 0)
            // Shown instead of being folded into cash/bank: money that arrived
            // through an account the server cannot classify must still be
            // visible, or the split would silently fail to add up to the total.
            _MoneyRow(label: 'Chưa phân loại được', value: block.unclassified),
          const Divider(height: AppSpacing.lg),
          _MoneyRow(label: 'Theo hóa đơn', value: block.againstInvoice),
          _MoneyRow(label: 'Ứng trước / đặt cọc', value: block.advances),
        ],
      ),
    );
  }

  Widget _paymentsOut(DailySummary d) {
    final block = d.paymentsOut;
    if (block == null) {
      return _BlockError(
        title: 'Tiền chi hôm nay',
        block: 'payments_out',
        summary: d,
        onRetry: () => _load(force: true),
      );
    }
    return _Card(
      title: 'Tiền chi hôm nay',
      note: block.footnote?.isNotEmpty == true
          ? block.footnote
          // §10.2: the note is mandatory, so keep it even if an older server
          // stops sending it — never let "chi" look complete when it is not.
          : 'Chưa gồm chi qua Journal Entry',
      child: Column(
        children: [
          _MoneyRow(label: 'Tổng chi', value: block.total, emphasize: true),
          _MoneyRow(label: 'Tiền mặt', value: block.cash),
          _MoneyRow(label: 'Chuyển khoản', value: block.bank),
          if (block.unclassified != 0)
            _MoneyRow(label: 'Chưa phân loại được', value: block.unclassified),
        ],
      ),
    );
  }

  Widget _receivables(DailySummary d) {
    final block = d.receivables;
    if (block == null) {
      return _BlockError(
        title: 'Công nợ hiện tại',
        block: 'receivables',
        summary: d,
        onRetry: () => _load(force: true),
      );
    }
    return _Card(
      title: 'Công nợ hiện tại (phải thu)',
      // Tapping debt opens the OVERDUE CUSTOMERS drill (§4.4), not a list of
      // every open invoice: the block's own headline is the overdue split, and
      // the not-yet-due part of the debt has no per-customer drill in V1.
      drill: const DrillIntent(drillId: 'overdue_customers', title: 'Khách quá hạn'),
      child: Column(
        children: [
          _MoneyRow(
            label: 'Còn phải thu',
            value: block.outstandingTotal,
            emphasize: true,
          ),
          _MoneyRow(
            label: 'Quá hạn · ${block.overdueCount} hóa đơn',
            value: block.overdueTotal,
          ),
        ],
      ),
    );
  }

  Widget _appDrafts(DailySummary d) {
    final block = d.appDrafts;
    if (block == null) {
      return _BlockError(
        title: 'Nháp do app tạo hôm nay',
        block: 'app_drafts',
        summary: d,
        onRetry: () => _load(force: true),
      );
    }
    return _Card(
      title: 'Nháp do app tạo hôm nay',
      drill: const DrillIntent(drillId: 'app_drafts_today', title: 'Nháp app hôm nay'),
      child: Column(
        children: [
          _MoneyRow(label: 'Số phiếu nháp', value: null, text: '${block.count}'),
          for (final entry in block.byType.entries)
            _MoneyRow(label: entry.key, value: null, text: '${entry.value}'),
          if (block.count == 0)
            const _Note('Không có phiếu nháp nào do app tạo trong ngày.'),
        ],
      ),
    );
  }

  Widget _cashDrawer(DailySummary d) {
    final block = d.cashDrawer;
    if (block == null) {
      // Two very different nothings:
      //  * no error recorded → the company has no default cash account, so §3.6
      //    says hide the block. Hiding is the correct answer, not an error card.
      //  * an error recorded → the opening or the flows could not be read; then
      //    it must SAY so, because a partial drawer is worse than none.
      if (d.meta.errorFor('cash_drawer') == null) return const SizedBox.shrink();
      return _BlockError(
        title: 'Két tiền mặt (dự kiến)',
        block: 'cash_drawer',
        summary: d,
        onRetry: () => _load(force: true),
      );
    }
    return _Card(
      title: 'Két tiền mặt (dự kiến)',
      note: block.account == null ? null : 'Tài khoản: ${block.account}',
      child: Column(
        children: [
          _MoneyRow(label: 'Đầu ngày', value: block.opening),
          _MoneyRow(label: '+ Thu tiền mặt', value: block.cashInToday),
          // Shown as a positive figure under a minus-labelled row: the sign is
          // the LABEL's job, so the number stays exactly the one ERPNext sent.
          _MoneyRow(label: '− Chi tiền mặt', value: block.cashOutToday),
          const Divider(height: AppSpacing.lg),
          _MoneyRow(
            label: '= Dự kiến cuối ngày',
            value: block.expectedClosing,
            emphasize: true,
          ),
        ],
      ),
    );
  }
}

/// Grey placeholders while the first read is in flight (§6 "Loading → Skeleton").
class _Skeleton extends StatelessWidget {
  const _Skeleton();

  @override
  Widget build(BuildContext context) {
    final color = Theme.of(context).colorScheme.surfaceContainerHighest;
    return ListView(
      key: const ValueKey('summary-skeleton'),
      padding: const EdgeInsets.all(AppSpacing.md),
      children: [
        for (var i = 0; i < 4; i++)
          Card(
            child: Padding(
              padding: const EdgeInsets.all(AppSpacing.md),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Container(height: 14, width: 160, color: color),
                  const SizedBox(height: AppSpacing.sm),
                  Container(height: 22, width: 220, color: color),
                ],
              ),
            ),
          ),
      ],
    );
  }
}

class _FullError extends StatelessWidget {
  const _FullError({required this.message, required this.onRetry});

  final String message;
  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Padding(
      padding: const EdgeInsets.all(AppSpacing.lg),
      child: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          Text(
            'Lỗi · không đọc được tóm tắt ngày',
            style: theme.textTheme.titleMedium,
            textAlign: TextAlign.center,
          ),
          const SizedBox(height: AppSpacing.sm),
          Text(message, textAlign: TextAlign.center),
          const SizedBox(height: AppSpacing.md),
          FilledButton(onPressed: onRetry, child: const Text('Thử lại')),
        ],
      ),
    );
  }
}

class _Banner extends StatelessWidget {
  const _Banner({
    super.key,
    required this.color,
    required this.icon,
    required this.text,
    this.detail,
  });

  final Color color;
  final IconData icon;
  final String text;
  final String? detail;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Card(
      color: color,
      child: Padding(
        padding: const EdgeInsets.all(AppSpacing.md),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Icon(icon, size: 18),
            const SizedBox(width: AppSpacing.sm),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(text, style: theme.textTheme.bodyMedium),
                  if (detail != null)
                    Text(detail!, style: theme.textTheme.bodySmall),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// Which day this is, whose books, and when the server assembled it (§6 "OK").
class _DayHeader extends StatelessWidget {
  const _DayHeader({required this.data});

  final DailySummary data;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final meta = data.meta;
    final mock = meta.erpTarget == 'MOCK';
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(AppSpacing.md),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              meta.company?.isNotEmpty == true ? meta.company! : 'Cửa hàng',
              style: theme.textTheme.titleMedium,
            ),
            const SizedBox(height: AppSpacing.xs),
            Text(
              // The date is the SHOP's day, decided server-side (§3.7) — the
              // phone's own clock never picks it.
              'Ngày ${meta.date ?? 'không rõ'} · giờ ${meta.timezone}',
              style: theme.textTheme.bodyMedium,
            ),
            Text(
              meta.generatedAt == null
                  ? 'Chưa có giờ đọc từ máy chủ.'
                  : 'Số liệu đọc lúc ${_clock(meta.generatedAt!)}',
              style: theme.textTheme.labelSmall,
            ),
            if (mock)
              Padding(
                padding: const EdgeInsets.only(top: AppSpacing.xs),
                child: Text(
                  'Bộ dữ liệu giả lập (MOCK) — dùng để thử, không dùng để đối chiếu tiền.',
                  style: theme.textTheme.bodySmall
                      ?.copyWith(color: theme.colorScheme.error),
                ),
              ),
          ],
        ),
      ),
    );
  }
}

class _QuietDay extends StatelessWidget {
  const _QuietDay();

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(AppSpacing.md),
        child: Text(
          // Distinguishes "nothing happened" from "nothing could be read" — the
          // whole point of showing zeros only when the server measured them.
          'Chưa có phát sinh nào trong ngày (không bán, không thu, không chi). '
          'Đã đọc được đủ dữ liệu — đây không phải lỗi.',
          style: theme.textTheme.bodyMedium,
        ),
      ),
    );
  }
}

class _Card extends StatelessWidget {
  const _Card({required this.title, required this.child, this.note, this.drill});

  final String title;
  final Widget child;
  final String? note;

  /// P4-4: the metric this card shows, when the CONTRACT declares a drill for
  /// it. Cards without a declared drill stay plain (no dead affordance), and the
  /// screen never invents an id here — it passes the one the server declared.
  final DrillIntent? drill;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final brick = Padding(
      padding: const EdgeInsets.all(AppSpacing.md),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(title, style: theme.textTheme.titleSmall),
          const SizedBox(height: AppSpacing.sm),
          child,
          if (note != null)
            Padding(
              padding: const EdgeInsets.only(top: AppSpacing.xs),
              child: Text(note!, style: theme.textTheme.labelSmall),
            ),
        ],
      ),
    );
    return Card(
      margin: const EdgeInsets.only(bottom: AppSpacing.sm),
      child: drill == null
          ? brick
          : InkWell(
              key: ValueKey('drill-${drill!.drillId}'),
              // `context.push` (GoRouter), exactly like A1's drill-down button:
              // the app navigates through GoRouter, so a raw Navigator.pushNamed
              // has no named-route table behind it and throws at tap time.
              onTap: () => context.push('/drill', extra: drill),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  brick,
                  Padding(
                    padding: const EdgeInsets.only(left: AppSpacing.md, right: AppSpacing.md, bottom: AppSpacing.sm),
                    child: Row(
                      children: [
                        Text('Xem chi tiết', style: theme.textTheme.labelMedium),
                        const Icon(Icons.chevron_right, size: 18),
                      ],
                    ),
                  ),
                ],
              ),
            ),
    );
  }
}

/// One block the server could not read: says which block and offers a retry.
/// The block is NEVER rendered as 0 — see the class doc of the screen.
class _BlockError extends StatelessWidget {
  const _BlockError({
    required this.title,
    required this.block,
    required this.summary,
    required this.onRetry,
  });

  final String title;
  final String block;
  final DailySummary summary;
  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final err = summary.meta.errorFor(block);
    return Card(
      key: ValueKey('summary-block-error-$block'),
      margin: const EdgeInsets.only(bottom: AppSpacing.sm),
      child: Padding(
        padding: const EdgeInsets.all(AppSpacing.md),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(title, style: theme.textTheme.titleSmall),
            const SizedBox(height: AppSpacing.xs),
            Text(
              'Lỗi · chưa đọc được mục này (${err?.code ?? 'ERP_UNAVAILABLE'})',
              style: theme.textTheme.bodyMedium
                  ?.copyWith(color: theme.colorScheme.error),
            ),
            TextButton(onPressed: onRetry, child: const Text('Thử lại')),
          ],
        ),
      ),
    );
  }
}

/// A day-scoped card (P4-6 §6) whose day has not been read yet, or whose read
/// failed. It keeps the card's NAME — so the user knows what is missing — and
/// shows NO figure: today's number under a "hôm qua" title is the one thing
/// this state exists to prevent. "Thử lại" re-reads the day on demand.
class _DayNotRead extends StatelessWidget {
  const _DayNotRead({
    required this.title,
    required this.block,
    required this.loading,
    required this.onRetry,
  });

  final String title;
  final String block;
  final bool loading;
  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Card(
      key: ValueKey('summary-day-not-read-$block'),
      margin: const EdgeInsets.only(bottom: AppSpacing.sm),
      child: Padding(
        padding: const EdgeInsets.all(AppSpacing.md),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(title, style: theme.textTheme.titleSmall),
            const SizedBox(height: AppSpacing.xs),
            Text(
              loading
                  ? 'Đang đọc ngày hôm qua…'
                  : 'Chưa đọc được ngày hôm qua.',
              style: theme.textTheme.bodyMedium,
            ),
            if (!loading)
              TextButton(onPressed: onRetry, child: const Text('Thử lại')),
          ],
        ),
      ),
    );
  }
}

class _Note extends StatelessWidget {
  const _Note(this.text);

  final String text;

  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.only(top: AppSpacing.xs),
        child: Text(text, style: Theme.of(context).textTheme.bodySmall),
      );
}

/// A label and its number. [value] is printed exactly as it arrived; the client
/// never recomputes money — [text] exists only for counts.
class _MoneyRow extends StatelessWidget {
  const _MoneyRow({
    required this.label,
    this.value,
    this.text,
    this.emphasize = false,
  });

  final String label;
  final int? value;
  final String? text;
  final bool emphasize;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: AppSpacing.xs / 2),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Expanded(child: Text(label, style: theme.textTheme.bodyMedium)),
          const SizedBox(width: AppSpacing.sm),
          Text(
            text ?? '${_vnd(value ?? 0)}đ',
            style: emphasize
                ? theme.textTheme.titleSmall
                : theme.textTheme.bodyMedium,
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

/// Display-only grouping of a number that came from ERPNext — the same
/// fixed-point shape the server uses (2500000 → "2.500.000"). No arithmetic
/// happens here: money is copied, never computed, on the client either.
String _vnd(int n) => n.toString().replaceAllMapped(
      RegExp(r'\B(?=(\d{3})+(?!\d))'),
      (_) => '.',
    );
