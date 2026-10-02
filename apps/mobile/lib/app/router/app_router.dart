import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../../features/chat/data/chat_models.dart';
import '../../features/collect/data/collect_models.dart';
import '../../features/collect/presentation/screens/collect_screen.dart';
import '../../features/chat/presentation/screens/chat_screen.dart';
import '../../features/chat/presentation/screens/read_list_screen.dart';
import '../../features/ops/data/drill_models.dart';
import '../../features/ops/presentation/screens/daily_summary_screen.dart';
import '../../features/ops/presentation/screens/drill_list_screen.dart';
import '../../features/purchase/presentation/screens/purchase_screen.dart';
import '../../features/sales/presentation/screens/sales_screen.dart';
import '../../features/settings/presentation/screens/settings_screen.dart';

/// Route name is camelCase, path is kebab-case (architecture skill naming
/// convention).
final GoRouter appRouter = GoRouter(
  initialLocation: '/chat',
  routes: [
    GoRoute(
      path: '/chat',
      name: 'chat',
      pageBuilder: (context, state) => MaterialPage<void>(
        key: state.pageKey,
        child: const ChatScreen(),
      ),
    ),
    // A1 (plan3 Trụ A): the READ drill-down opened from a chat bubble. The
    // intent travels as route data because it WAS the answer's own payload —
    // there is nothing to derive here, and no deep link can invent one (see
    // the fail-closed branch below).
    GoRoute(
      path: '/read',
      name: 'readList',
      pageBuilder: (context, state) {
        final extra = state.extra;
        if (extra is! ReadUiIntent) {
          // Only a bubble that carries a server-built intent may open this
          // screen: without one there is no screen id and no entity id to read,
          // and guessing either is exactly what A1 forbids.
          return MaterialPage<void>(
            key: state.pageKey,
            child: const _MissingReadIntentScreen(),
          );
        }
        return MaterialPage<void>(
          key: state.pageKey,
          child: ReadListScreen(intent: extra),
        );
      },
    ),
    // P4-4 (plan4_final §4.4): the day drill behind ONE metric. The intent is a
    // fixed drill id the server declared (`drill_screens`) plus its title — no
    // phrase, no free text, and nothing the caller could pass that would change
    // which day or which books are read (both are server-side).
    GoRoute(
      path: '/drill',
      name: 'drillList',
      pageBuilder: (context, state) {
        final extra = state.extra;
        if (extra is! DrillIntent) {
          // Only a tap on a metric that HAS a declared drill may open this
          // screen: without an intent there is no id to read, and inventing one
          // is exactly the guessing §4.4 forbids.
          return MaterialPage<void>(
            key: state.pageKey,
            child: const _MissingReadIntentScreen(),
          );
        }
        return MaterialPage<void>(
          key: state.pageKey,
          child: DrillListScreen(intent: extra),
        );
      },
    ),
    // P4-3 (plan4_final §2): "Tóm tắt ngày" — the drawer's default screen.
    // Deliberately takes no `extra` and no parameters: the screen reads ONE
    // server-side aggregate, and there is nothing a caller could hand it that
    // should change WHICH books are read (company is server-side only, §4.1)
    // or which day (the server's own "today at the shop" default).
    GoRoute(
      path: '/summary',
      name: 'dailySummary',
      pageBuilder: (context, state) => MaterialPage<void>(
        key: state.pageKey,
        child: const DailySummaryScreen(),
      ),
    ),
    // next8 Phase 2 (plan §8): the dedicated collect screen. The handoff TICKET
    // travels as route data because it IS the server's own payload (the /ask
    // answer carried it) — a deep link or a stale route has none, and building
    // one on the client would fabricate the very authority the server re-checks
    // at propose time. Without a ticket the screen REFUSES (T5), it never
    // improvises a customer or an amount.
    GoRoute(
      path: '/collect',
      name: 'collect',
      pageBuilder: (context, state) {
        // The extra may be the FULL ticket (parsed by the caller from the
        // turn's raw map) — a deep link without one refuses.
        final extra = state.extra;
        if (extra is! BusinessHandoff) {
          return MaterialPage<void>(
            key: state.pageKey,
            child: const _MissingCollectHandoffScreen(),
          );
        }
        return MaterialPage<void>(
          key: state.pageKey,
          child: CollectScreen(handoff: extra),
        );
      },
    ),
    // next8 Phase 6: the dedicated sales screen — the handoff TICKET travels
    // as route data exactly like /collect (it IS the server's own payload; a
    // deep link or a stale route has none, and building one on the client
    // would fabricate the very authority the server re-checks at propose
    // time). Without a ticket the screen REFUSES — it never improvises a
    // customer, a line or an amount.
    GoRoute(
      path: '/sales',
      name: 'sales',
      pageBuilder: (context, state) {
        final extra = state.extra;
        if (extra is! BusinessHandoff) {
          return MaterialPage<void>(
            key: state.pageKey,
            child: const _MissingSalesHandoffScreen(),
          );
        }
        return MaterialPage<void>(
          key: state.pageKey,
          child: SalesScreen(handoff: extra),
        );
      },
    ),
    // next8 Phase 7: the dedicated purchase screen — the handoff TICKET travels
    // as route data exactly like /sales (it IS the server's own payload; a deep
    // link or a stale route has none). Without a ticket the screen REFUSES — it
    // never improvises a supplier, a line or an amount.
    GoRoute(
      path: '/purchase',
      name: 'purchase',
      pageBuilder: (context, state) {
        final extra = state.extra;
        if (extra is! BusinessHandoff) {
          return MaterialPage<void>(
            key: state.pageKey,
            child: const _MissingPurchaseHandoffScreen(),
          );
        }
        return MaterialPage<void>(
          key: state.pageKey,
          child: PurchaseScreen(handoff: extra),
        );
      },
    ),
    // Settings (2026-09-16): change gateway URL/auth + history cap without
    // rebuilding the APK.
    GoRoute(
      path: '/settings',
      name: 'settings',
      pageBuilder: (context, state) => MaterialPage<void>(
        key: state.pageKey,
        child: const SettingsScreen(),
      ),
    ),
  ],
  errorBuilder: (context, state) => Scaffold(
    appBar: AppBar(title: const Text('Lỗi điều hướng')),
    body: Center(child: Text('Không tìm thấy trang: ${state.uri}')),
  ),
);

/// Reached only if `/sales` is opened without a server-issued handoff (a deep
/// link, a stale route). Says so instead of rendering a usable-looking form
/// whose propose could only ever fail server-side (spec scenario: "the screen
/// is opened without a handoff").
class _MissingSalesHandoffScreen extends StatelessWidget {
  const _MissingSalesHandoffScreen();

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Bán hàng')),
      body: const Center(
        child: Padding(
          padding: EdgeInsets.all(24),
          child: Text(
            'Không có phiên bán hàng — mở màn hình này từ câu hỏi trong chat (ví dụ: "bán hàng cho chị Lan").',
            key: ValueKey('missing-sales-handoff'),
            textAlign: TextAlign.center,
          ),
        ),
      ),
    );
  }
}

/// Reached only if `/purchase` is opened without a server-issued handoff (a
/// deep link, a stale route). Says so instead of rendering a usable-looking
/// form whose propose could only ever fail server-side (spec scenario: "the
/// screen is opened without a handoff").
class _MissingPurchaseHandoffScreen extends StatelessWidget {
  const _MissingPurchaseHandoffScreen();

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Nhập hàng')),
      body: const Center(
        child: Padding(
          padding: EdgeInsets.all(24),
          child: Text(
            'Không có phiên nhập hàng — mở màn hình này từ câu hỏi trong chat (ví dụ: "nhập hàng cho Hà Tiên").',
            key: ValueKey('missing-purchase-handoff'),
            textAlign: TextAlign.center,
          ),
        ),
      ),
    );
  }
}

/// Reached only if `/collect` is opened without a server-issued handoff (a deep
/// link, a stale route). Says so instead of rendering a usable-looking form
/// whose confirm could only ever fail server-side.
class _MissingCollectHandoffScreen extends StatelessWidget {
  const _MissingCollectHandoffScreen();

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Thiếu phiên thu tiền')),
      body: const Padding(
        padding: EdgeInsets.all(24),
        child: Center(
          child: Text(
            'Màn thu tiền chỉ mở được từ câu trả lời trong chat.\n'
            'Hãy nói "thu tiền cho <tên khách> <số tiền>" rồi mở lại từ câu trả lời.',
            textAlign: TextAlign.center,
          ),
        ),
      ),
    );
  }
}

/// Reached only if `/read` is opened without a server-built intent (a deep link,
/// a stale route). Says so instead of rendering an empty list that could be
/// mistaken for "no debt".
class _MissingReadIntentScreen extends StatelessWidget {
  const _MissingReadIntentScreen();

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Thiếu thông tin màn hình')),
      body: const Padding(
        padding: EdgeInsets.all(24),
        child: Center(
          child: Text(
            'Màn này chỉ mở được từ nút trên câu trả lời trong chat.\n'
            'Hãy hỏi lại trong chat rồi bấm nút xem chi tiết.',
            textAlign: TextAlign.center,
          ),
        ),
      ),
    );
  }
}
