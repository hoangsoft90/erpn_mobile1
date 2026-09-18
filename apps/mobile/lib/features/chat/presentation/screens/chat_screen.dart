import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../../app/providers.dart';
import '../../../../app/theme/app_theme.dart';
import '../../application/chat_controller.dart';
import '../../data/speech_service.dart';
import '../widgets/chat_bubble.dart';
import '../widgets/pipeline_progress.dart';

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
    // After the await the widget may have been unmounted (user navigated
    // away) — touching controllers/context here would throw.
    if (!mounted) return;
    if (ok) {
      _textController.clear();
      _scrollToBottom();
    } else {
      // On failure the typed text is kept (tasks.md 2.5); the error surfaces
      // via ref.listen below — no blocking dialog.
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
    // The EFFECTIVE base URL: a value saved in Settings wins, otherwise the
    // compiled-in --dart-define. Watched (not read once) so returning from the
    // Settings screen re-renders this footer with the new URL (review
    // 2026-09-17: it used to read only the static dart-define value, so a
    // successfully saved URL never showed up here).
    final baseUrl = ref
            .watch(appSettingsServiceProvider)
            .gatewayBaseUrl
            .isNotEmpty
        ? ref.watch(appSettingsServiceProvider).gatewayBaseUrl
        : ref.watch(appEnvironmentProvider).copilotBaseUrl;

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
        title: const Text('Nghiệp Vụ AI'),
        actions: [
          if (chat.turns.isNotEmpty)
            IconButton(
              tooltip: 'Xóa lịch sử',
              icon: const Icon(Icons.delete_outline),
              onPressed: _confirmClear,
            ),
          IconButton(
            tooltip: 'Cài đặt',
            icon: const Icon(Icons.settings_outlined),
            onPressed: () => context.push('/settings'),
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
            // P2 deliverable 4 (plan2_final §24.11): a long pipeline shows
            // WHERE it is (hiểu → tra khách → kiểm tra → chờ xác nhận), not
            // a bare endless spinner.
            if (chat.isLoading) const PipelineProgress(),
            // KEY is required: PipelineProgress appears above this bar while a
            // request runs, which shifts its index in the Column. Without a key
            // Flutter matches children by position, so the bar was torn down and
            // rebuilt on every send — losing the dictation state and letting the
            // microphone outlive the screen state (self-review 2026-09-18).
            _InputBar(
              key: const ValueKey('chat-input-bar'),
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

/// P6 (`plan2_final.md` §20): mic → platform STT → the transcript lands in
/// THIS editable field → the USER reads/edits → presses Send. The mic has no
/// auto-send and no route to `/execute`; the only request path out of this
/// widget is the existing [onSend] → `POST /ask`.
class _InputBar extends ConsumerStatefulWidget {
  const _InputBar({
    super.key,
    required this.controller,
    required this.enabled,
    required this.onSend,
  });

  final TextEditingController controller;
  final bool enabled;
  final Future<void> Function() onSend;

  @override
  ConsumerState<_InputBar> createState() => _InputBarState();
}

class _InputBarState extends ConsumerState<_InputBar> {
  late final SpeechService _speech;
  bool _listening = false;

  /// One mic transition at a time. `_listening` only turns true once the
  /// recognizer reports it, so without this two quick taps both pass the
  /// `_listening == false` check and open TWO sessions (self-review
  /// 2026-09-18).
  bool _starting = false;

  /// Why the mic could not start (permission / no recognizer / no Vietnamese
  /// locale). Shown verbatim — a silent no-op is a dead end for the user.
  String? _notice;
  bool _noticeIsError = false;

  /// Field text at the moment dictation started; the running transcript is
  /// prefixed with it so dictating mid-edit does not wipe what was typed.
  String _baseText = '';

  @override
  void initState() {
    super.initState();
    _speech = ref.read(speechServiceProvider);
  }

  @override
  void didUpdateWidget(covariant _InputBar oldWidget) {
    super.didUpdateWidget(oldWidget);
    // A send turns the bar read-only (chat.isLoading). If the user pressed Send
    // mid-dictation the microphone must not stay open behind a request that is
    // already carrying their words. (Self-review 2026-09-18.)
    if (oldWidget.enabled && !widget.enabled && _listening) {
      _speech.stop();
      _listening = false;
    }
  }

  @override
  void dispose() {
    // Never leave the microphone open behind a screen the user left.
    if (_speech.isListening) _speech.cancel();
    super.dispose();
  }

  Future<void> _toggleMic() async {
    if (_starting) return; // double tap must not open a second session
    _starting = true;
    try {
      if (_listening) {
        await _speech.stop();
        if (!mounted) return;
        setState(() {
          _listening = false;
          _notice = null;
        });
        return;
      }

      _baseText = widget.controller.text;
      final init = await _speech.initialize();
      if (!mounted) return;
      if (init != SpeechStatus.idle) {
        setState(() {
          _listening = false;
          _noticeIsError = true;
          _notice = _deniedOrUnavailable(init);
        });
        return;
      }

      // Mirrors "the session is open" BEFORE awaiting listen(): the recognizer
      // can deliver its first partial result while listen() is still resolving,
      // and _onSpeechResult ignores results that arrive while not listening.
      setState(() {
        _listening = true;
        _noticeIsError = false;
        // Device without a Vietnamese recognizer still works — just less
        // accurate, and the user is told to re-read before sending.
        _notice = _speech.localeId == null
            ? 'Máy không có bộ nhận dạng tiếng Việt — hãy đọc kỹ lại câu chữ trước khi gửi.'
            : null;
      });

      await _speech.listen(onResult: _onSpeechResult, onStatus: _onSpeechStatus);
    } finally {
      _starting = false;
    }
  }

  void _onSpeechStatus(SpeechStatus status) {
    if (!mounted) return;
    switch (status) {
      case SpeechStatus.listening:
        setState(() => _listening = true);
      case SpeechStatus.idle:
        setState(() => _listening = false);
      case SpeechStatus.denied:
      case SpeechStatus.unavailable:
        setState(() {
          _listening = false;
          _noticeIsError = true;
          _notice = _deniedOrUnavailable(status);
        });
    }
  }

  String _deniedOrUnavailable(SpeechStatus status) => status == SpeechStatus.denied
      ? 'Chưa được cấp quyền micro. Mở Cài đặt của điện thoại để bật quyền ghi âm rồi thử lại.'
      : 'Thiết bị này không có bộ nhận dạng giọng nói. Bạn nhập bằng bàn phím như bình thường.';

  void _onSpeechResult(String transcript, bool isFinal) {
    if (!mounted) return;
    // The microphone must be CLOSED for this result to count. A recognizer in
    // teardown still emits one final result; without this the utterance the
    // user just sent would be written back into the field the send cleared
    // (self-review 2026-09-18).
    if (!_listening) return;
    final combined = _baseText.trim().isEmpty
        ? transcript
        : '${_baseText.trimRight()} $transcript';
    widget.controller.value = TextEditingValue(
      text: combined,
      selection: TextSelection.collapsed(offset: combined.length),
    );
    // Deliberately NO auto-send (deliverable 4): the user must see and edit the
    // text, then press Send themselves.
    if (isFinal) setState(() => _listening = false);
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Padding(
      padding: const EdgeInsets.fromLTRB(
        AppSpacing.md, AppSpacing.sm, AppSpacing.md, AppSpacing.sm,
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            children: [
              Expanded(
                child: TextField(
                  controller: widget.controller,
                  enabled: widget.enabled,
                  textInputAction: TextInputAction.send,
                  onSubmitted: (_) => widget.onSend(),
                  decoration: const InputDecoration(
                    hintText: 'Nhập câu hỏi tiếng Việt…',
                  ),
                ),
              ),
              const SizedBox(width: AppSpacing.sm),
              IconButton(
                onPressed: widget.enabled ? _toggleMic : null,
                tooltip:
                    _listening ? 'Dừng nhập giọng nói' : 'Nhập bằng giọng nói',
                icon: Icon(_listening ? Icons.mic : Icons.mic_none),
                color: _listening ? theme.colorScheme.error : null,
              ),
              IconButton.filled(
                onPressed: widget.enabled ? widget.onSend : null,
                tooltip: 'Gửi',
                icon: const Icon(Icons.send),
              ),
            ],
          ),
          // Independent lines: a locale warning does NOT mean the mic is idle,
          // so it must not suppress the "Đang nghe…" feedback (self-review
          // 2026-09-18 — they used to be mutually exclusive).
          if (_listening) ...[
            const SizedBox(height: AppSpacing.xs),
            Text(
              'Đang nghe… nói xong hãy kiểm tra lại câu chữ rồi bấm Gửi.',
              style: theme.textTheme.bodySmall,
            ),
          ],
          if (_notice != null) ...[
            const SizedBox(height: AppSpacing.xs),
            Text(
              _notice!,
              style: theme.textTheme.bodySmall?.copyWith(
                color: _noticeIsError ? theme.colorScheme.error : null,
              ),
            ),
          ],
        ],
      ),
    );
  }
}
