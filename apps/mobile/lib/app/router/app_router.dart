import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../../features/chat/data/chat_models.dart';
import '../../features/chat/presentation/screens/chat_screen.dart';
import '../../features/chat/presentation/screens/read_list_screen.dart';
import '../../features/ops/data/drill_models.dart';
import '../../features/ops/presentation/screens/daily_summary_screen.dart';
import '../../features/ops/presentation/screens/drill_list_screen.dart';
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
