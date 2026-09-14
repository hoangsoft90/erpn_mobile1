import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../../app/providers.dart';
import '../../../../app/theme/app_theme.dart';
import '../../application/chat_controller.dart';
import '../widgets/chat_bubble.dart';

/// Single-screen chat MVP (phase-03 spec). Read-only copilot.
class ChatScreen extends ConsumerStatefulWidget {
  const ChatScreen({super.key});

  @override
  ConsumerState<ChatScreen> createState() => _ChatScreenState();
}

class _ChatScreenState extends ConsumerState<ChatScreen> {
  final _textController = TextEditingController();
  final _scrollController = ScrollController();

  @override
  void dispose() {
    _textController.dispose();
    _scrollController.dispose();
    super.dispose();
  }

  Future<void> _send() async {
    final text = _textController.text;
    if (text.trim().isEmpty) return;
    final controller = ref.read(chatControllerProvider.notifier);
    final ok = await controller.send(text);
    if (ok) {
      _textController.clear();
      _scrollToBottom();
    }
    // On failure the typed text is kept (tasks.md 2.5); the error surfaces
    // via ref.listen below — no blocking dialog.
    if (!ok && mounted) {
      _textController.selection = TextSelection.fromPosition(
        TextPosition(offset: _textController.text.length),
      );
    }
  }

  void _scrollToBottom() {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (_scrollController.hasClients) {
        _scrollController.animateTo(
          _scrollController.position.maxScrollExtent,
          duration: const Duration(milliseconds: 250),
          curve: Curves.easeOut,
        );
      }
    });
  }

  Future<void> _confirmClear() async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Xóa lịch sử chat?'),
        content: const Text('Lịch sử sẽ bị xóa khỏi thiết bị này.'),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(context).pop(false),
            child: const Text('Hủy'),
          ),
          FilledButton(
            onPressed: () => Navigator.of(context).pop(true),
            child: const Text('Xóa'),
          ),
        ],
      ),
    );
    if (confirmed == true) {
      await ref.read(chatControllerProvider.notifier).clearHistory();
    }
  }

  @override
  Widget build(BuildContext context) {
    final chatAsync = ref.watch(chatControllerProvider);
    final chat = chatAsync.value ?? const ChatState();
    final baseUrl = ref.watch(appEnvironmentProvider).copilotBaseUrl;

    ref.listen(chatControllerProvider, (prev, next) {
      final err = next.value?.lastError;
      final changed = prev?.value?.lastError != err;
      if (err != null && changed && mounted) {
        ScaffoldMessenger.of(context)
          ..hideCurrentSnackBar()
          ..showSnackBar(SnackBar(content: Text(err)));
      }
    });

    return Scaffold(
      appBar: AppBar(
        title: const Text('ERPNext Copilot'),
        actions: [
          if (chat.turns.isNotEmpty)
            IconButton(
              tooltip: 'Xóa lịch sử',
              icon: const Icon(Icons.delete_outline),
              onPressed: _confirmClear,
            ),
        ],
      ),
      body: SafeArea(
        child: Column(
          children: [
            Expanded(
              child: chat.turns.isEmpty
                  ? const _EmptyState()
                  : ListView.builder(
                      controller: _scrollController,
                      padding: const EdgeInsets.all(AppSpacing.md),
                      itemCount: chat.turns.length,
                      itemBuilder: (context, i) =>
                          ChatBubble(turn: chat.turns[i]),
                    ),
            ),
            if (chat.isLoading)
              const Padding(
                padding: EdgeInsets.all(AppSpacing.sm),
                child: LinearProgressIndicator(),
              ),
            _InputBar(
              controller: _textController,
              enabled: !chat.isLoading,
              onSend: _send,
            ),
            Padding(
              padding: const EdgeInsets.symmetric(
                horizontal: AppSpacing.md,
                vertical: AppSpacing.xs,
              ),
              child: Text(
                'COPILOT_BASE_URL: $baseUrl',
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: Theme.of(context).textTheme.labelSmall,
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _EmptyState extends StatelessWidget {
  const _EmptyState();

  @override
  Widget build(BuildContext context) {
    final scheme = Theme.of(context).colorScheme;
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(AppSpacing.lg),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(Icons.forum_outlined, size: 48, color: scheme.outline),
            const SizedBox(height: AppSpacing.md),
            Text(
              'Hỏi công nợ, hóa đơn, kho — ví dụ:\n"chị Lan còn nợ bao nhiêu"',
              textAlign: TextAlign.center,
              style: Theme.of(context).textTheme.bodyMedium,
            ),
          ],
        ),
      ),
    );
  }
}

class _InputBar extends StatelessWidget {
  const _InputBar({
    required this.controller,
    required this.enabled,
    required this.onSend,
  });

  final TextEditingController controller;
  final bool enabled;
  final Future<void> Function() onSend;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(
        AppSpacing.md, AppSpacing.sm, AppSpacing.md, AppSpacing.sm,
      ),
      child: Row(
        children: [
          Expanded(
            child: TextField(
              controller: controller,
              enabled: enabled,
              textInputAction: TextInputAction.send,
              onSubmitted: (_) => onSend(),
              decoration: const InputDecoration(
                hintText: 'Nhập câu hỏi tiếng Việt…',
              ),
            ),
          ),
          const SizedBox(width: AppSpacing.sm),
          IconButton.filled(
            onPressed: enabled ? onSend : null,
            tooltip: 'Gửi',
            icon: const Icon(Icons.send),
          ),
        ],
      ),
    );
  }
}
