import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

import '../../features/chat/presentation/screens/chat_screen.dart';

/// Phase 3 MVP has exactly one route. Route name is camelCase, path is
/// kebab-case (architecture skill naming convention).
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
  ],
  errorBuilder: (context, state) => Scaffold(
    appBar: AppBar(title: const Text('Lỗi điều hướng')),
    body: Center(child: Text('Không tìm thấy trang: ${state.uri}')),
  ),
);
