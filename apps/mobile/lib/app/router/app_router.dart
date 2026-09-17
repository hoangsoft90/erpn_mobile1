import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../../features/chat/presentation/screens/chat_screen.dart';
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
