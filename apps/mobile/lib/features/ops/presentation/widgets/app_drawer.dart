import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../../../../app/theme/app_theme.dart';
import '../../data/drill_models.dart';
import 'summary_status_footer.dart';

/// P4-3 (plan4_final §2) — the app's left drawer.
///
/// Layout and rules, straight from §2:
///   * **Tóm tắt ngày is the default item** — first, and the only enabled entry
///     of "THEO DÕI";
///   * every **write** still happens in chat + a confirm card (the Safety
///     Gateway). This drawer therefore contains NO write affordance at all:
///     nothing here creates, submits, pays or deletes, and nothing here can
///     reach `/execute` — including the items still to come (P4-4/P4-5), which
///     exist as READ drills;
///   * a section whose work is not in yet says so ("sắp có") instead of showing
///     a button that would guess. There is deliberately no free-text entry here:
///     §4.4 forbids injecting text into a classifier to guess a capability, so
///     the future shortcuts are declared as structured drills, not as a box to
///     type in.
///
/// The footer (REAL|MOCK · URL · when read) is the SAME widget the summary screen
/// pins, fed with whatever this screen knows: on the summary screen it is the
/// real thing, on chat it admits it has not read anything yet.
class AppDrawer extends StatelessWidget {
  const AppDrawer({
    super.key,
    this.currentRoute,
    this.company,
    this.erpTarget,
    this.updatedAt,
    this.stale = false,
    this.draftsBadge,
  });

  /// The route this drawer was opened from — used to mark the current item
  /// instead of introspecting the router.
  final String? currentRoute;

  /// Company the numbers belong to, when a summary has been read.
  final String? company;
  final String? erpTarget;
  final DateTime? updatedAt;
  final bool stale;

  /// D4 (§6: "Badge: D4 optional; fail → ẩn, không hiện 0") — how many drafts the
  /// app created today, when the caller ALREADY knows it.
  ///
  /// Deliberately fed from a number the summary screen has already read: the
  /// drawer performs no request of its own, so opening it can never be blocked
  /// (or slowed) by a badge. `null` = not known (chat opens the drawer with no
  /// summary, or the drafts block could not be read) ⇒ NO badge; `0` ⇒ also no
  /// badge, because a zero badge is a claim the server has not made here. The
  /// only state that draws anything is a positive count.
  final int? draftsBadge;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Drawer(
      child: SafeArea(
        child: Column(
          children: [
            Expanded(
              child: ListView(
                padding: EdgeInsets.zero,
                children: [
                  _Header(company: company),
                  _SectionTitle('THEO DÕI'),
                  _Item(
                    icon: Icons.today_outlined,
                    label: 'Tóm tắt ngày',
                    route: '/summary',
                    currentRoute: currentRoute,
                    trailing: 'Mặc định',
                  ),
                  // D1 (drawer-plan-final §3.1) — the two company-wide debt
                  // views are READ drills: fixed ids from the server's closed
                  // set (`receivable_customers`, `overdue_top`), no free text,
                  // no write affordance — the same posture as the day drills.
                  const _Item(
                    icon: Icons.account_balance_wallet_outlined,
                    label: 'Công nợ (lối tắt)',
                    drill: 'receivable_customers',
                  ),
                  const _Item(
                    icon: Icons.priority_high_outlined,
                    label: 'Nợ quá hạn / Nợ lâu',
                    drill: 'overdue_top',
                  ),
                  // D2 (drawer-plan-final §3.3) — low stock in the PINNED
                  // default warehouse: a READ drill with a fixed id, the same
                  // posture as every other entry here. Rows are quantities,
                  // never money; the warehouse is named by the server.
                  const _Item(
                    icon: Icons.inventory_2_outlined,
                    label: 'Tồn kho nóng',
                    drill: 'stock_low',
                  ),
                  _SectionTitle('PHIẾU TỪ APP'),
                  // D3 (drawer-plan-final §3.4) — the app's own drafts of the day,
                  // served by ONE aggregate (the same payload as
                  // `/read/app-drafts`): the client never fans out to the
                  // doctypes and never merges/dedupes them itself.
                  _Item(
                    icon: Icons.description_outlined,
                    label: 'Nháp hôm nay',
                    drill: 'app_drafts_today',
                    badge: draftsBadge,
                  ),
                  // D1c (drawer-plan-final §3.2) — "HĐ chưa trả": a READ drill
                  // with a fixed id from the server's closed set, the same
                  // posture as the two debt views above. Invoice rows only
                  // (§3.2 forbids a PE-able abstraction); no write affordance.
                  const _Item(
                    icon: Icons.receipt_long_outlined,
                    label: 'HĐ chưa trả',
                    drill: 'unpaid_invoices',
                  ),
                  _SectionTitle('CÀI ĐẶT'),
                  _Item(
                    icon: Icons.settings_outlined,
                    label: 'Server / đăng nhập',
                    route: '/settings',
                    currentRoute: currentRoute,
                    trailing: 'Có thể sửa',
                  ),
                ],
              ),
            ),
            Divider(height: 1, color: theme.dividerColor),
            SummaryStatusFooter(
              erpTarget: erpTarget,
              updatedAt: updatedAt,
              stale: stale,
            ),
          ],
        ),
      ),
    );
  }
}

class _Header extends StatelessWidget {
  const _Header({this.company});

  final String? company;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return DrawerHeader(
      decoration: BoxDecoration(color: theme.colorScheme.surfaceContainerHighest),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisAlignment: MainAxisAlignment.end,
        children: [
          Text('Nghiệp Vụ AI', style: theme.textTheme.labelMedium),
          const SizedBox(height: AppSpacing.xs),
          Text(
            company?.isNotEmpty == true ? company! : 'Cửa hàng',
            style: theme.textTheme.titleMedium,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
          ),
          Text(
            // The day is the SHOP's day (Asia/Ho_Chi_Minh) — §3.7.
            'Hôm nay · giờ Việt Nam',
            style: theme.textTheme.bodySmall,
          ),
        ],
      ),
    );
  }
}

class _SectionTitle extends StatelessWidget {
  const _SectionTitle(this.text);

  final String text;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Padding(
      padding: const EdgeInsets.fromLTRB(
        AppSpacing.md,
        AppSpacing.md,
        AppSpacing.md,
        AppSpacing.xs,
      ),
      child: Text(
        text,
        style: theme.textTheme.labelSmall
            ?.copyWith(color: theme.colorScheme.onSurfaceVariant),
      ),
    );
  }
}

/// One drawer row. Exactly one of [route] / [drill] is set:
/// * [route]  — a screen that exists; tapping closes the drawer and goes there.
/// * [drill]  — a READ drill id from the server's closed set (`drill_screens`):
///   the tap pushes `/drill` with a structured intent (id + the server's title
///   comes back with the payload). No phrase is ever sent (§4.4) and there is
///   no write affordance anywhere in the drawer.
///
/// There used to be a third state — `soon: '<plan step>'`, a disabled row whose
/// subtitle named the phase that would build it. D3 finished the last one, so
/// every entry now has a real destination and the affordance was removed rather
/// than left as a way to ship a row that does nothing (its tests keep asserting
/// that no "Sắp có" text can come back).
class _Item extends StatelessWidget {
  const _Item({
    required this.icon,
    required this.label,
    this.route,
    this.drill,
    this.currentRoute,
    this.trailing,
    this.badge,
  });

  final IconData icon;
  final String label;
  final String? route;
  final String? drill;
  final String? currentRoute;
  final String? trailing;

  /// D4 — an OPTIONAL count shown beside the label, drawn only when it is a
  /// POSITIVE number the server actually reported (§6: "fail → ẩn, không hiện
  /// 0"). A badge is decoration on a row that already works without it.
  final int? badge;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final enabled = route != null || drill != null;
    final selected = enabled && route == currentRoute;
    final count = badge;
    final showBadge = count != null && count > 0;
    return ListTile(
      dense: true,
      enabled: enabled,
      selected: selected,
      leading: Icon(icon),
      title: Row(
        children: [
          Flexible(child: Text(label, overflow: TextOverflow.ellipsis)),
          if (showBadge)
            Padding(
              key: ValueKey('drawer-badge-$drill'),
              padding: const EdgeInsets.only(left: AppSpacing.sm),
              child: Text(
                '$count',
                style: theme.textTheme.labelSmall
                    ?.copyWith(color: theme.colorScheme.primary),
              ),
            ),
        ],
      ),
      trailing: trailing == null
          ? null
          : Text(trailing!, style: theme.textTheme.labelSmall),
      onTap: !enabled
          ? null
          : () {
              // Capture the router BEFORE closing: the drawer's own element is
              // gone after the pop, and GoRouter.of() needs a live context.
              final router = GoRouter.of(context);
              Navigator.of(context).pop();
              if (route != null) {
                if (route != currentRoute) router.push(route!);
                return;
              }
              // The drill id IS the request: the title comes from the SERVER's
              // payload (the screen prefers it), so the drawer hardcodes no
              // wording of its own and no phrase travels (§4.4).
              router.push(
                '/drill',
                extra: DrillIntent(drillId: drill!, title: label),
              );
            },
    );
  }
}
