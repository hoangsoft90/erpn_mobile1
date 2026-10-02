import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../../../app/providers.dart';
import '../../../../core/constants/app_constants.dart';
import '../../../../app/theme/app_theme.dart';
import '../../application/chat_controller.dart';
import '../../data/copilot_api_client.dart';
import '../../data/einvoice_file_picker.dart';
import '../../data/ocr_models.dart';
import '../../data/photo_picker_service.dart';
import '../../data/speech_service.dart';
import '../../data/voice_write_guard.dart';
import '../../../collect/data/collect_models.dart';
import '../../../ops/presentation/widgets/app_drawer.dart';
import '../../data/chat_models.dart';
import '../widgets/chat_bubble.dart';
import '../widgets/ocr_sheet.dart';
import '../widgets/ocr_slots_form.dart';
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

  /// How close to the end still counts as "at the bottom". Small enough that a
  /// few stray pixels do not keep the jump button up while the user is reading
  /// the last message, wide enough to survive the list's own padding/bounce.
  static const double _atBottomThreshold = 64;

  /// True once the user has scrolled away from the bottom far enough to want a
  /// way back. Kept honest by [_onScroll]; the send path already scrolls to the
  /// bottom itself, so it never becomes "stuck visible with nothing new below".
  bool _showScrollToBottom = false;

  @override
  void initState() {
    super.initState();
    _scrollController.addListener(_onScroll);
  }

  @override
  void dispose() {
    _scrollController.removeListener(_onScroll);
    _textController.dispose();
    _scrollController.dispose();
    super.dispose();
  }

  /// Flips [_showScrollToBottom] as the list scrolls. A list short enough to
  /// have nothing to scroll has `maxScrollExtent == 0`, which reads as "at the
  /// bottom" here — so the button stays hidden, as it should.
  void _onScroll() {
    if (!_scrollController.hasClients) return;
    final position = _scrollController.position;
    final atBottom =
        position.maxScrollExtent - position.pixels <= _atBottomThreshold;
    final shouldShow = !atBottom;
    if (_showScrollToBottom != shouldShow) {
      setState(() => _showScrollToBottom = shouldShow);
    }
  }

  /// next8 Phase 2 — opens the collect screen when the NEWEST answer carries a
  /// collect handoff (guard: theo handoff_id, mỗi ticket chỉ tự mở MỘT lần —
  /// một turn restore từ lịch sử không bao giờ mở lại màn tiền tự động).
  /// next8 Phase 6: a handoff whose screen is `sales` opens the SALES screen
  /// instead — the ticket's own `screen` field (the server's decision from the
  /// contract) decides which form opens; this method never re-decides it.
  void _maybeOpenCollect(BuildContext context, ChatState? chat) {
    final turns = chat?.turns ?? const <ChatTurn>[];
    if (turns.isEmpty) return;
    final last = turns.last;
    final handoffRaw = last.collectHandoff;
    if (handoffRaw == null) return;
    final handoffId = handoffRaw['handoff_id'] as String? ?? '';
    if (handoffId.isEmpty) return;
    // Guard: đã mở ticket này rồi thì không mở lại (kể cả sau restore).
    if (_openedCollectHandoffs.contains(handoffId)) return;
    final full = BusinessHandoff.tryParse(handoffRaw);
    if (full == null) return;
    _openedCollectHandoffs.add(handoffId);
    final route = full.screen == 'sales'
        ? '/sales'
        : full.screen == 'purchase'
            ? '/purchase'
            : '/collect';
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      context.push(route, extra: full);
    });
  }

  /// The set of handoff ids THIS session has already auto-opened (one open per
  /// answer; a returned-to turn never re-opens the money form by itself).
  final Set<String> _openedCollectHandoffs = {};

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
      if (!mounted || !_scrollController.hasClients) return;
      // Landing on the newest message means the jump button must not be up.
      // [_onScroll] cannot be relied on to say so: a list with nothing to
      // scroll never emits a scroll event, so the flag would keep whatever
      // value it had before the list shrank (e.g. right after "Xóa lịch sử",
      // or when a long thread is replaced by a single short reply). Clear it
      // here, where we already know we are going to the bottom.
      if (_showScrollToBottom) setState(() => _showScrollToBottom = false);
      _scrollController.animateTo(
        _scrollController.position.maxScrollExtent,
        duration: const Duration(milliseconds: 250),
        curve: Curves.easeOut,
      );
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
    _maybeOpenCollect(context, ref.read(chatControllerProvider).value);

    return Scaffold(
      // P4-3 (plan4_final §2): the left drawer. Chat stays the DEFAULT surface
      // (it is where writes happen, and every write is chat + confirm card);
      // the drawer's own default item is "Tóm tắt ngày".
      drawer: const AppDrawer(currentRoute: '/chat'),
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
              // The button lives INSIDE the list area (a Stack sibling, not the
              // Scaffold's FAB slot) so it hovers over the messages and cannot
              // sit on top of the input bar below.
              child: Stack(
                children: [
                  chat.turns.isEmpty
                      ? const _EmptyState()
                      : ListView.builder(
                          controller: _scrollController,
                          padding: const EdgeInsets.all(AppSpacing.md),
                          itemCount: chat.turns.length,
                          // The KEY is load-bearing, not decoration
                          // (plan-debug next9, Symptom B): without it Flutter
                          // matches children by INDEX, so when the history
                          // shifts — ChatHistoryService.trimTurns drops the
                          // oldest turn once the list passes maxChatItems — the
                          // ProposalCard element of one turn is reused for
                          // another and its locally-held outcome ("Đã tạo khách
                          // hàng: <tên>") appears on the WRONG card. The turn's
                          // own (ts, question) — ChatTurn.key — is stable across
                          // a history restore and across attachRejection's
                          // rebuild, so the element follows its turn instead.
                          itemBuilder: (context, i) => ChatBubble(
                            key: ValueKey(chat.turns[i].key),
                            turn: chat.turns[i],
                          ),
                        ),
                  if (chat.turns.isNotEmpty && _showScrollToBottom)
                    Positioned(
                      right: AppSpacing.md,
                      bottom: AppSpacing.md,
                      child: FloatingActionButton.small(
                        key: const ValueKey('scroll-to-bottom'),
                        tooltip: 'Xuống cuối',
                        onPressed: _scrollToBottom,
                        child: const Icon(Icons.keyboard_arrow_down),
                      ),
                    ),
                ],
              ),
            ),
            // C1/C2 (`.plan/dsh_end_to_end.md`): the explicit mode selector and
            // the DSH status line. Default is Normal; nothing here can switch
            // mode on its own — the user taps it or the question goes down the
            // deterministic path as before.
            _ModeBar(
              mode: chat.mode,
              phase: chat.dshPhase,
              enabled: !chat.isLoading,
              onChanged: (mode) =>
                  ref.read(chatControllerProvider.notifier).setMode(mode),
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

/// The mode selector: Normal (deterministic /ask) vs "Phân tích bằng AI"
/// (explicit DSH opt-in).
///
/// Two things this widget deliberately does NOT have:
/// * no UNREQUESTED switching — the selection moves on a tap, or on the
///   auto-fallback the user turned on in Settings (`autoFallbackToAi`, default
///   OFF). Plan §12 forbids turning an unknown question into an agent session on
///   its own; a switch the user enabled is that user's decision, made once,
///   visibly, in Settings — see `.plan/next2/auto-fallback-dsh.md` §3;
/// * no confirm affordance of its own — next7 A0–A1: a WRITE question asked in
///   AI mode is HANDED OFF to the deterministic pipeline and comes back as the
///   ordinary proposal card, so the notice describes the one rule that matters
///   (nothing is written without the card's [Xác nhận]) instead of telling the
///   user to leave the mode they chose (plan_final §2, A8).
class _ModeBar extends StatelessWidget {
  const _ModeBar({
    required this.mode,
    required this.phase,
    required this.enabled,
    required this.onChanged,
  });

  final ChatMode mode;
  final DshPhase phase;
  final bool enabled;
  final ValueChanged<ChatMode> onChanged;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final isDsh = mode == ChatMode.dsh;
    return Padding(
      padding: const EdgeInsets.fromLTRB(
        AppSpacing.md, AppSpacing.xs, AppSpacing.md, 0,
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          // Scrollable so the two Vietnamese labels never overflow on a narrow
          // phone (a RenderFlex overflow here would be a visible bug).
          SingleChildScrollView(
            scrollDirection: Axis.horizontal,
            child: SegmentedButton<ChatMode>(
              segments: const [
                ButtonSegment(
                  value: ChatMode.normal,
                  icon: Icon(Icons.chat_bubble_outline),
                  label: Text('Chat thường'),
                ),
                ButtonSegment(
                  value: ChatMode.dsh,
                  icon: Icon(Icons.auto_awesome),
                  label: Text('Phân tích bằng AI'),
                ),
              ],
              selected: {mode},
              showSelectedIcon: false,
              onSelectionChanged:
                  enabled ? (selection) => onChanged(selection.first) : null,
            ),
          ),
          if (isDsh) ...[
            const SizedBox(height: AppSpacing.xs),
            Text(
              // next7 A3 (plan_final §2, A8): the OLD copy told the shopkeeper
              // to leave AI mode for every write — but since the A0/A1 handoff
              // the write IS answered here, as an ordinary card with its own
              // [Xác nhận]. The copy now states the actual rule: AI reads and
              // proposes; the card's confirm is what writes.
              'AI: đọc + đề xuất ghi. Mọi ghi sổ cần bấm Xác nhận trên thẻ.',
              key: const ValueKey('ai-mode-notice'),
              style: theme.textTheme.bodySmall,
            ),
          ],
          if (isDsh && phase == DshPhase.starting) ...[
            const SizedBox(height: AppSpacing.xs),
            Text(
              'Đang phân tích bằng AI… câu hỏi này cần khoảng 20 giây.',
              style: theme.textTheme.bodySmall,
            ),
          ],
          if (isDsh && phase == DshPhase.failed) ...[
            const SizedBox(height: AppSpacing.xs),
            Text(
              'Phiên AI vừa lỗi — câu hỏi của bạn vẫn còn trong ô nhập, '
              'bấm Gửi để thử lại.',
              style: theme.textTheme.bodySmall?.copyWith(
                color: theme.colorScheme.error,
              ),
            ),
          ],
        ],
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
/// THIS editable field → the USER reads/edits → presses Send. There is no
/// route to `/execute`; the only request path out of this widget is the
/// existing [onSend] → `POST /ask`. Auto-send exists ONLY as a user opt-in
/// ("Tự gửi sau khi nói xong", default OFF) and reuses that same [onSend].
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

  /// One camera round trip at a time. Same reason as [_starting] for the mic:
  /// two taps would send two photos and open two sheets over each other. Shared
  /// with the HĐĐT button (`.xml` and `.pdf` alike): all of them are "open a
  /// document input and show a form", so two running at once would stack two
  /// sheets over each other.
  bool _reading = false;

  /// Which of the document inputs [_reading] is busy with, for the progress
  /// line only ("Đang đọc ảnh…" vs "Đang đọc file hoá đơn…"). Nothing branches on it.
  bool _readingFile = false;

  /// One mic transition at a time. `_listening` only turns true once the
  /// recognizer reports it, so without this two quick taps both pass the
  /// `_listening == false` check and open TWO sessions (self-review
  /// 2026-09-18).
  bool _starting = false;

  /// Why the mic could not start (permission / no recognizer / language
  /// refusal). Shown verbatim — a silent no-op is a dead end for the user.
  String? _notice;
  bool _noticeIsError = false;

  /// P5-4 (plan5_final §6): the voice-first layout variant, read fresh on every
  /// build. The settings service is deliberately NOT reactive (its getters are
  /// synchronous map lookups — `providers.dart`), so the bar rebuilds whenever
  /// the ChatScreen does, and ChatScreen re-renders when the user returns from
  /// `/settings` — the same mechanism the base-URL footer already relies on
  /// (comment at the top of its `build`). No new subscription is invented here.
  bool get _voiceFirst =>
      ref.read(appSettingsServiceProvider).voiceAutoSend;

  /// P5-4 §6: the 25s cap fires as a TAP-TO-STOP, not a Huỷ — the transcript
  /// heard so far is kept (it lands in the field; auto-send may then run).
  /// Cancelled in [_toggleMic]/[_cancelDictation]/dispose paths.
  Timer? _maxRecordTimer;

  /// Field text at the moment dictation started; the running transcript is
  /// prefixed with it so dictating mid-edit does not wipe what was typed.
  String _baseText = '';

  /// B1 — a genuine FINAL result arrived for THIS session. It is what separates
  /// "the engine finished the sentence" from "we only ever saw partials", and
  /// is therefore the switch that arms the write-shaped guard in
  /// [_maybeAutoSend].
  bool _finalHeard = false;

  /// B1 (found by the B1 review, probe E1): did DICTATION itself contribute any
  /// word this session?
  ///
  /// Without it, tapping the mic and stopping it without saying anything sent
  /// whatever happened to be in the box — the user's own earlier typing — even
  /// though nothing was spoken and no result ever arrived. "Nói xong" requires
  /// having said something: the field contents are not evidence of speech.
  bool _heardAnything = false;

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
    _maxRecordTimer?.cancel();
    super.dispose();
  }

  /// P5-4 §6: arms the 25s hard cap for one dictation session.
  ///
  /// The duration is read through [_maxRecordDuration], which honours a TEST
  /// override via the `P5-4-TEST-MAX-RECORD-OVERRIDE` dart-define — the ONLY
  /// way a widget test can exercise the cap without pumping 25 real seconds.
  /// Production never sets the flag, so it always sees
  /// [AppConstants.voiceMaxRecordDuration]; the override path is test-only by
  /// construction, not by convention.
  static Duration get _maxRecordDuration {
    const flag = String.fromEnvironment('P5-4-TEST-MAX-RECORD-OVERRIDE');
    if (flag.isEmpty) return AppConstants.voiceMaxRecordDuration;
    final seconds = int.tryParse(flag);
    // An unparseable value falls back to the real cap — never to zero/none.
    return seconds == null || seconds <= 0
        ? AppConstants.voiceMaxRecordDuration
        : Duration(seconds: seconds);
  }

  void _armMaxRecordTimer() {
    _maxRecordTimer?.cancel();
    _maxRecordTimer = Timer(_maxRecordDuration, () async {
      if (!mounted || !_listening) return;
      // Same shape as the user tapping the running mic (tap-to-stop): the
      // transcript flows into the field. NOT [_cancelDictation], which discards
      // what was heard. B1: NOT user-initiated, so it keeps the words but never
      // auto-sends — a timer expiring is not the shopkeeper saying "xong rồi".
      await _stopDictation(userInitiated: false);
    });
  }

  /// Ends the CURRENT dictation session and keeps whatever was heard (it is
  /// already in the field — partials stream in while listening).
  ///
  /// [userInitiated] is the whole point of B1: the shopkeeper's own tap on the
  /// mic IS "nói xong", so it must run the auto-send decision — B0 proved no
  /// final result can be waited for here, because `SpeechService.stop()` drops
  /// the one the plugin flushes on teardown. The 25s safety cap is NOT that
  /// decision (the user may have walked away), so it only keeps the words.
  Future<void> _stopDictation({required bool userInitiated}) async {
    await _speech.stop();
    if (!mounted) return;
    setState(() {
      _listening = false;
      _notice = null;
    });
    if (userInitiated) await _maybeAutoSend();
  }

  /// P5-4 §6: the explicit Huỷ button (voice-first layout). Stops the
  /// recognizer the way [_cancelDictation]'s contract promises — nothing that
  /// was heard reaches the field, and no auto-send can fire. This is the
  /// deliberate opposite of tap-to-stop, which KEEPS the transcript.
  ///
  /// Partial results have ALREADY been written into the field while listening
  /// ([_onSpeechResult] streams them there) — so "not putting the transcript
  /// into the input" means restoring the field to [_baseText], the text the
  /// user had BEFORE the mic opened, not merely blocking later results.
  Future<void> _cancelDictation() async {
    _maxRecordTimer?.cancel();
    await _speech.cancel();
    if (!mounted) return;
    widget.controller.value = TextEditingValue(
      text: _baseText,
      selection: TextSelection.collapsed(offset: _baseText.length),
    );
    setState(() {
      _listening = false;
      _baseText = '';
      _notice = null;
      _noticeIsError = false;
    });
  }

  Future<void> _toggleMic() async {
    if (_starting) return; // double tap must not open a second session
    _starting = true;
    try {
      if (_listening) {
        await _stopDictation(userInitiated: true);
        return;
      }

      _baseText = widget.controller.text;
      // B1: a new utterance has not heard a final and has contributed nothing.
      _finalHeard = false;
      _heardAnything = false;
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
        // NO locale notice at all (P6 UX, user 2026-09-18). `localeVerified`
        // only reports whether the device's ON-DEVICE locale list mentions
        // `vi`, which says nothing about whether Vietnamese works — the online
        // recognizer handles it (Gboard did, on a phone whose list had no
        // `vi`). The user cannot act on that difference and dictation works, so
        // showing it is pure noise. Real refusals still speak for themselves:
        // denied / unavailable / error_language_* arrive through
        // [_onSpeechStatus] and [_deniedOrUnavailable].
        _noticeIsError = false;
        _notice = null;
      });

      // P5-4 §6 + §7 item 3: the hard cap runs for EVERY session, in BOTH
      // layouts — it protects the typed-dictation path from the same risk
      // (an open mic recording an unrelated conversation), and §7 pins the
      // cap regardless of capability.
      _armMaxRecordTimer();

      await _speech.listen(onResult: _onSpeechResult, onStatus: _onSpeechStatus);
    } finally {
      _starting = false;
    }
  }

  /// P5-4 layout 1 (voiceAutoSend == false): the ORIGINAL row, unchanged —
  /// text input centred, small mic inside the bar. §1.1: nothing in this branch
  /// may move; the old tests pin this shape (they find `Icons.mic_none` etc.).
  Widget _buildDefaultRow(ThemeData theme) {
    return Row(
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
          onPressed: widget.enabled && !_reading ? _openCamera : null,
          tooltip: 'Chụp ảnh hoá đơn / phiếu (đọc thành chữ)',
          icon: const Icon(Icons.photo_camera_outlined),
        ),
        IconButton(
          onPressed: widget.enabled && !_reading ? _openEinvoiceFile : null,
          tooltip: 'Nhập hoá đơn điện tử (file .xml hoặc .pdf)',
          icon: const Icon(Icons.description_outlined),
        ),
        IconButton(
          onPressed: widget.enabled ? _toggleMic : null,
          tooltip: _listening ? 'Dừng nhập giọng nói' : 'Nhập bằng giọng nói',
          icon: Icon(_listening ? Icons.mic : Icons.mic_none),
          color: _listening ? theme.colorScheme.error : null,
        ),
        IconButton.filled(
          onPressed: widget.enabled ? widget.onSend : null,
          tooltip: 'Gửi',
          icon: const Icon(Icons.send),
        ),
      ],
    );
  }

  /// P5-4 layout 2 (voiceAutoSend == true): voice-first, but STILL the same
  /// region as the old input bar (§1.2 — review2 §4.4: no full-screen redesign,
  /// no muscle-memory disruption). The text field stays VISIBLE and ENABLED —
  /// typing is always the fallback (plan5 invariant) — the mic becomes the
  /// primary CTA, and while listening the explicit Huỷ sits next to it: unlike
  /// tap-to-stop (which keeps the transcript), Huỷ discards what was heard.
  Widget _buildVoiceFirstRow(ThemeData theme) {
    return Column(
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
            IconButton.filledTonal(
              onPressed: widget.enabled && !_listening && !_reading
                  ? _openCamera
                  : null,
              tooltip: 'Chụp ảnh hoá đơn / phiếu (đọc thành chữ)',
              icon: const Icon(Icons.photo_camera_outlined),
            ),
            IconButton.filledTonal(
              onPressed: widget.enabled && !_listening && !_reading
                  ? _openEinvoiceFile
                  : null,
              tooltip: 'Nhập hoá đơn điện tử (file .xml hoặc .pdf)',
              icon: const Icon(Icons.description_outlined),
            ),
            IconButton.filled(
              key: const ValueKey('voice-primary-mic'),
              onPressed: widget.enabled ? _toggleMic : null,
              tooltip:
                  _listening ? 'Dừng nhập giọng nói' : 'Nhập bằng giọng nói',
              icon: Icon(_listening ? Icons.mic : Icons.mic_none,
                  size: 28),
              color: _listening ? theme.colorScheme.error : null,
            ),
            if (_listening)
              IconButton(
                key: const ValueKey('cancel-dictation-icon'),
                onPressed: _cancelDictation,
                tooltip: 'Huỷ — không dùng câu vừa nói',
                icon: const Icon(Icons.cancel_outlined),
              ),
          ],
        ),
      ],
    );
  }

  /// C1 (`plan3` Trụ C) — the camera channel: one photo → one OCR reading → the
  /// text lands in THIS editable field, or the user types it themselves.
  ///
  /// What this method CANNOT do, by construction:
  /// * it cannot send. The only request it makes is `POST /ocr`, which reads a
  ///   photo; nothing here calls `/ask`, and nothing here can reach `/execute`;
  /// * it cannot auto-send afterwards — [_maybeAutoSend] is the voice setting's
  ///   business (the user opted into it for DICTATION), and a photo is exactly
  ///   the input the phase requires a human to read before acting on
  ///   (plan3 §6.4). The user presses Gửi;
  /// * it cannot quietly use a reading the server was unsure about — the sheet
  ///   is handed `read.usable`, and LOW_CONFIDENCE / NO_TEXT / an unrecognised
  ///   status leave manual entry as the only action;
  /// * it cannot pass a fixture off as the user's document: a reading from the
  ///   mock provider says so on the sheet.
  Future<void> _openCamera() async {
    if (_reading) return;
    _reading = true;
    try {
      final PickedPhoto? photo;
      try {
        photo = await ref.read(photoPickerProvider).pick();
      } catch (err) {
        if (!mounted) return;
        setState(() {
          _noticeIsError = true;
          _notice = 'Không mở được camera hoặc thư viện ảnh trên máy này. '
              'Bạn nhập bằng bàn phím như bình thường.';
        });
        return;
      }
      // A cancel is not an error and must not produce a request.
      if (!mounted || photo == null) return;

      setState(() {
        _noticeIsError = false;
        _notice = null;
      });
      final OcrRead read;
      try {
        read = await ref.read(copilotApiClientProvider).ocr(
              bytes: photo.bytes,
              mimeType: photo.mimeType,
            );
      } catch (err) {
        if (!mounted) return;
        setState(() {
          _noticeIsError = true;
          _notice = err is CopilotServerException
              ? err.message
              : 'Không đọc được ảnh lúc này. Bạn thử lại hoặc nhập tay.';
        });
        return;
      }
      if (!mounted) return;

      final choice = await showOcrSheet(context, read);
      if (!mounted || choice == null) return;

      switch (choice.action) {
        case OcrSheetAction.injectText:
          final text = choice.text.trim();
          if (text.isEmpty) {
            setState(() {
              _noticeIsError = false;
              _notice = 'Không còn chữ nào để đưa vào ô chat. Bạn nhập tay giúp.';
            });
            return;
          }
          widget.controller.value = TextEditingValue(
            text: text,
            selection: TextSelection.collapsed(offset: text.length),
          );
          setState(() {
            _noticeIsError = false;
            _notice = 'Đã đưa nội dung ảnh vào ô chat — bạn kiểm tra lại rồi bấm Gửi.';
          });
        case OcrSheetAction.manualEntry:
          setState(() {
            _noticeIsError = false;
            _notice = 'Mời bạn nhập tay nội dung trên ảnh, rồi bấm Gửi.';
          });
        case OcrSheetAction.buildDocument:
          await _buildDocumentFromPhoto(read, choice);
      }
      // NOTE: no _maybeAutoSend() here on purpose — see the doc comment.
    } finally {
      _reading = false;
    }
  }

  /// C2 (`plan3` Trụ C) — the second half of the camera flow: a photo becomes a
  /// DRAFT document, through the ordinary pipeline.
  ///
  /// The shape of the safety argument, in order:
  ///  1. the reading must be one the server accepts as a basis for a document
  ///     (`POST /ocr/slots` refuses a low-confidence or mock reading — the mock
  ///     is the DEFAULT provider, so this is the ordinary path, not an edge
  ///     case), and it authorizes the capability the chosen kind maps to in the
  ///     CONTRACT;
  ///  2. what comes back is SLOTS, not a proposal — the user corrects them on a
  ///     form where every field the photo produced is editable;
  ///  3. the corrected sentence is sent through the SAME chat path as any typed
  ///     question (`/ask` → classifier → capability ∈ contract → proposal),
  ///     so this is not a second write path and the confirm card is the same one
  ///     every other write uses;
  ///  4. at no point here is anything executed: the only requests made are
  ///     `/ocr/slots` and `/ask`, and the sentence is sent as the user's own turn
  ///     so it stays visible in the chat.
  Future<void> _buildDocumentFromPhoto(OcrRead read, OcrSheetChoice choice) async {
    final OcrSlots slots;
    try {
      slots = await ref.read(copilotApiClientProvider).ocrSlots(
            text: choice.text,
            kind: choice.kind,
            read: read,
          );
    } catch (err) {
      if (!mounted) return;
      setState(() {
        _noticeIsError = true;
        _notice = err is CopilotServerException
            ? err.message
            : 'Không lập được chứng từ từ ảnh này. Bạn nhập tay giúp tôi.';
      });
      return;
    }
    if (!mounted) return;

    final sentence = await showOcrSlotsForm(context, slots);
    if (!mounted || sentence == null || sentence.isEmpty) return;

    // The sentence goes out as the user's OWN turn: what the photo was
    // interpreted as is visible afterwards and correctable in the chat.
    // next3/B: the reading's document identity rides ALONGSIDE the sentence when
    // it has one, so a second photo of the same hóa đơn cannot produce a second
    // draft. Null when the reading did not yield a usable identity — the server
    // refuses a half one, and inventing parts of it here would be worse than
    // having none.
    //
    // TODAY THIS IS ALWAYS NULL on the photo channel: `/ocr/slots` does not build
    // a `source_document` block (only the file channel's builder does), so the
    // photo path keeps exactly the behaviour it had. The argument is here anyway
    // because the two channels share one send path — the day the OCR slots
    // builder reports an identity, this line starts deduping instead of silently
    // NOT deduping, which is the failure mode worth spending one argument on.
    final sent = await ref
        .read(chatControllerProvider.notifier)
        .send(sentence, sourceDocument: slots.sourceDocument?.toAskJson());
    if (!mounted) return;
    setState(() {
      _noticeIsError = !sent;
      _notice = sent
          ? 'Đã gửi câu từ ảnh — xem kết quả phía trên (đơn vẫn phải bấm [Xác nhận]).'
          : 'Chưa gửi được câu từ ảnh — thử lại sau khi câu hỏi trước trả lời xong.';
    });
  }

  /// A2 (`.plan/next3/implementation.md` workstream A) + A3
  /// (`.plan/next4/A3-result.md`) — the SUPPLIER-FILE channel: a HÓA ĐƠN ĐIỆN TỬ
  /// file the shop received (`.xml` OR `.pdf`) becomes SLOTS, on the SAME form
  /// and through the SAME one pipeline as a photo.
  ///
  /// The shape of the safety argument, in order:
  ///  1. the file leaves the app in the one form it travels in and is never read
  ///     here — the XML as TEXT, the PDF as raw BYTES. The gateway owns the only
  ///     parser for each (`src/einvoice/einvoice-xml.mjs`,
  ///     `src/einvoice/einvoice-pdf.mjs`), and a client-side reading of the same
  ///     document is how "the user confirmed one thing and the file said
  ///     another" is born. The two are MUTUALLY EXCLUSIVE per request (the
  ///     route refuses both with `EINVOICE_INPUT_AMBIGUOUS`), because they are
  ///     two readings of ONE document — so which one goes is decided by the
  ///     THING THE USER PICKED, and nothing here guesses between them;
  ///  2. what comes back is SLOTS, not a proposal: no price from the file, no
  ///     command id, and an unknown supplier MST is a WARNING with candidates —
  ///     never an auto-created Supplier (`phases3` Cấm: no auto-create master);
  ///  3. the user corrects the form and the composed sentence travels the
  ///     ordinary `/ask` → proposal → [Xác nhận] → Safety Gateway path, so this
  ///     is NOT a second write path — the document is still created as a DRAFT;
  ///  4. at no point here is anything executed: the only requests made are
  ///     `/input/einvoice` and `/ask`;
  ///  5. no auto-send afterwards. The voice auto-send setting is DICTATION's
  ///     business, and a supplier's invoice is exactly the input a human has to
  ///     read before acting on (same rule as the camera).
  Future<void> _openEinvoiceFile() async {
    if (_reading) return;
    _reading = true;
    _readingFile = true;
    try {
      final PickedEinvoiceFile? file;
      try {
        file = await ref.read(einvoiceFilePickerProvider).pick();
      } on EinvoiceFileException catch (err) {
        // The file itself cannot be sent — say exactly why (empty, too large,
        // not text). Nothing was requested.
        if (!mounted) return;
        setState(() {
          _noticeIsError = true;
          _notice = err.message;
        });
        return;
      } catch (err) {
        if (!mounted) return;
        setState(() {
          _noticeIsError = true;
          _notice = 'Không mở được trình chọn file trên máy này. Bạn thử lại hoặc nhập tay.';
        });
        return;
      }
      // A cancel is not an error and must not produce a request.
      if (!mounted || file == null) return;
      // Non-nullable copy: `file` was assigned inside a `try`, and Dart keeps
      // such a variable un-promotable inside the closures below.
      final picked = file;

      setState(() {
        _noticeIsError = false;
        _notice = null;
      });
      final OcrSlots slots;
      try {
        // The kind is the WORD the contract declares for this channel
        // (`einvoice_policy.document_kinds` offers `purchase`), never a
        // capability id — the server owns the kind → capability mapping.
        //
        // A3: ONE route, TWO readers, and the PICKED FILE decides which — never
        // a preference, never a fallback (a PDF that the XML reader "sort of"
        // handles is not a thing). The wrapped type makes the choice exhaustive.
        final client = ref.read(copilotApiClientProvider);
        slots = switch (picked) {
          PickedXmlFile(:final xml) => await client.einvoiceSlots(xml: xml),
          PickedPdfFile(:final base64) =>
            await client.einvoiceSlots(pdfBase64: base64),
        };
      } catch (err) {
        if (!mounted) return;
        setState(() {
          _noticeIsError = true;
          // A refusal the server explained is already a Vietnamese sentence the
          // user can act on — show it rather than replacing it. That covers the
          // XML side (XML_MALFORMED, XML_NOT_INVOICE, EINVOICE_INCOMPLETE,
          // XML_TOO_LARGE) AND the PDF side, where the important one is
          // EINVOICE_PDF_NO_TEXT (422): the PDF is real but has no text layer —
          // i.e. a SCAN — and the server's own message already points at the
          // camera button, which is the correct remedy.
          _notice = err is CopilotServerException
              ? err.message
              : 'Không đọc được file hoá đơn lúc này. Bạn thử lại hoặc nhập tay.';
        });
        return;
      }
      if (!mounted) return;

      final sentence = await showOcrSlotsForm(
        context,
        slots,
        source: OcrSlotsSource.file,
      );
      if (!mounted || sentence == null || sentence.isEmpty) return;

      // The sentence goes out as the user's OWN turn: what the file was
      // interpreted as is visible afterwards and correctable in the chat.
      // next3/B: the file's own identity (số HĐ + ngày + MST người bán) travels
      // OUT OF BAND here — the number must never be composed into the sentence,
      // because the pipeline reads "00049" as an amount. This is what makes
      // sending the same file twice create ONE draft.
      final sent = await ref
          .read(chatControllerProvider.notifier)
          .send(sentence, sourceDocument: slots.sourceDocument?.toAskJson());
      if (!mounted) return;
      setState(() {
        _noticeIsError = !sent;
        _notice = sent
            ? 'Đã gửi câu từ file ${picked.name} — xem kết quả phía trên (đơn vẫn phải bấm [Xác nhận]).'
            : 'Chưa gửi được câu từ file hoá đơn — thử lại sau khi câu hỏi trước trả lời xong.';
      });
    } finally {
      _reading = false;
      _readingFile = false;
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
      // Also used when the recognizer refuses the LANGUAGE (not just when the
      // device has no recognizer at all), so the wording covers both and never
      // tells the user their phone is incapable when it is not.
      : 'Không dùng được nhận dạng giọng nói trên máy này. Bạn nhập bằng bàn phím như bình thường, hoặc thử lại nút micro.';

  void _onSpeechResult(String transcript, bool isFinal) {
    if (!mounted) return;
    // The microphone must be CLOSED for this result to count. A recognizer in
    // teardown still emits one final result; without this the utterance the
    // user just sent would be written back into the field the send cleared
    // (self-review 2026-09-18).
    if (!_listening) return;
    if (transcript.trim().isEmpty) {
      // Nothing was actually heard (no speech / timeout). Leave the field
      // exactly as the user left it — appending an empty transcript would only
      // add a stray space — but a FINAL result still closes the session.
      if (isFinal) setState(() => _listening = false);
      return;
    }
    // B1: the recognizer put words on the table — only now may a stop count as
    // "nói xong" (see [_heardAnything]).
    _heardAnything = true;
    final combined = _baseText.trim().isEmpty
        ? transcript
        : '${_baseText.trimRight()} $transcript';
    widget.controller.value = TextEditingValue(
      text: combined,
      selection: TextSelection.collapsed(offset: combined.length),
    );
    if (!isFinal) return; // partials only ever update the field
    setState(() => _listening = false);
    // B1: this utterance DOES have a final result, so the write-shaped guard in
    // [_maybeAutoSend] must not apply to it (the engine heard the whole
    // sentence — that is the pre-B1 behaviour the existing suite pins).
    _finalHeard = true;
    // P6 deliverable 4 default: no auto-send — the user reads/edits, then
    // presses Send. Opt-in only via Settings ("Tự gửi sau khi nói xong").
    _maybeAutoSend();
  }

  /// P6 UX (user decision 2026-09-18): OPTIONAL auto-send, default OFF.
  /// B1 (`.plan/next7/B1-result.md`): the ONE decision point, run from BOTH
  /// end-of-dictation triggers — [_onSpeechResult]'s final result and
  /// [_stopDictation]'s user tap. DoD (plan §4, as amended by B1 §6 — the
  /// `!autoSendDone` clause was DROPPED because falsification measured it as
  /// redundant):
  ///
  /// ```text
  /// voiceAutoSend && heard something && stopped && text non-empty
  ///   && !(write-shaped && no final) → onSend()
  /// ```
  ///
  /// It then calls the SAME [onSend] the button calls — there is no second path
  /// to `/ask`, and nothing here can confirm a proposal or reach `/execute`.
  ///
  /// "At most once per utterance" is NOT a guard here — it is the joint result of
  /// layers that each already have their own job, and B1's falsification run
  /// proved no test can tell the difference (removing a dedicated flag turned
  /// nothing red):
  /// * a second FINAL result cannot re-enter ⇒ [_onSpeechResult] returns on
  ///   `!_listening`, which the first final already cleared;
  /// * a re-entrant call cannot post the same text twice ⇒ this method drops an
  ///   empty field, and the first send cleared it;
  /// * a concurrent send ⇒ `ChatController.send` refuses while `isLoading`.
  /// * a request in flight ⇒ the send path closes the mic ([didUpdateWidget]),
  ///   so `_listening == false` and a stop cannot reach here anyway.
  Future<void> _maybeAutoSend() async {
    if (!ref.read(appSettingsServiceProvider).voiceAutoSend) return;
    // Nothing was heard this session ⇒ nothing to finish saying. Without this,
    // mic-on-then-mic-off sent whatever the user had typed earlier (B1 review
    // probe E1: a pre-typed question went out with no speech at all).
    if (!_heardAnything) return;
    final text = widget.controller.text;
    if (text.trim().isEmpty) return;
    // B1 §4.2: no final result means the field may hold only PARTIAL text. A
    // write-shaped partial is left for the user to read and send by hand — an
    // auto-sent payment sentence is a sentence nobody checked. A final-result
    // utterance is unaffected: the engine heard the whole sentence, and the
    // request still only asks (a proposal needs its own Xác nhận).
    if (!_finalHeard && looksLikeWriteOrder(text)) return;
    await widget.onSend();
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
          // P5-4 (plan5_final §6): EXACTLY two layouts, switched by the
          // voiceAutoSend setting. AnimatedSwitcher keeps the transition smooth
  // (review2 §4.4: no full-screen layout jump). The KeyedSubtree keys make the
          // switcher see two genuinely different children — without keys it
          // would not animate, and the state would be reused across layouts.
          AnimatedSwitcher(
            duration: const Duration(milliseconds: 200),
            child: _voiceFirst
                ? KeyedSubtree(
                    key: const ValueKey('input-voice-first'),
                    child: _buildVoiceFirstRow(theme),
                  )
                : KeyedSubtree(
                    key: const ValueKey('input-text-default'),
                    child: _buildDefaultRow(theme),
                  ),
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
          if (_listening && _voiceFirst) ...[
            const SizedBox(height: AppSpacing.xs),
            // P5-4: the explicit Huỷ lives OUTSIDE the animated row so it never
            // animates in/out with the layout — a control that must stop a
            // live microphone should not be moving while it is tapped.
            OutlinedButton.icon(
              key: const ValueKey('cancel-dictation'),
              onPressed: _cancelDictation,
              icon: const Icon(Icons.cancel_outlined),
              label: const Text('Huỷ'),
            ),
          ],
          if (_reading) ...[
            const SizedBox(height: AppSpacing.xs),
            Text(
              _readingFile ? 'Đang đọc file hoá đơn…' : 'Đang đọc ảnh…',
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
