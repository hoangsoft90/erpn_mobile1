import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:riverpod_annotation/riverpod_annotation.dart';

import '../../../app/providers.dart';
import '../data/chat_history_service.dart';
import '../data/chat_models.dart';
import '../data/copilot_api_client.dart';

part 'chat_controller.g.dart';

/// Markdown noise: an engine reads `*`/`` ` ``/`#` as literal characters.
final RegExp _markdownNoise = RegExp(r'[*_`#>~]');

/// Identifier-shaped tokens (UUID / command_id / proposal_id) — never spoken.
final RegExp _uuidLike = RegExp(
  r'[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}',
);

/// `/ask` answered, but no skill route matched the sentence (copilot-server.mjs
/// `answerQuestion`). The CLIENT may follow up on `/dsh/ask`
/// (`.plan/next2/auto-fallback-dsh.md`); the server never redirects (D2).
const _unknownIntentCode = 'UNKNOWN_INTENT';

/// The gateway is already running another agent session with
/// `DSH_MAX_CONCURRENT=1` — read from dsh-gateway.mjs (`DSH_IN_FLIGHT`, mapped
/// to HTTP 429 by http-ask.mjs) rather than guessed. It is a "come back in a
/// moment", not a broken session.
const _dshInFlightCode = 'DSH_GATEWAY_IN_FLIGHT';

/// Which pipeline a question goes down (`.plan/dsh_end_to_end.md`).
///
/// [normal] is the DEFAULT and the only path the app ever falls back to; [dsh]
/// exists solely because the user picked it. There is deliberately no
/// "auto" value: plan §12 forbids turning an unknown question into an agent
/// session automatically, so the type itself cannot express that mistake.
///
/// Session-scoped on purpose: it is NOT persisted, so every app start begins in
/// [normal] and the agent path always requires a fresh, visible choice.
enum ChatMode { normal, dsh }

/// How far a DSH session has got, for the status line.
///
/// Three states, not four: the gateway returns ONE non-streaming response, so
/// there is no honest signal to separate "starting" from "running" — inventing
/// one would only be cosmetic. [starting] therefore means "sent, awaiting the
/// agent", which is exactly what the user is looking at until the answer lands.
/// (Deviation from plan C2's four names, recorded in result57 §10 with this
/// reason.)
enum DshPhase { idle, starting, completed, failed }

/// Immutable UI state of the chat screen.
@immutable
class ChatState {
  const ChatState({
    this.turns = const [],
    this.isLoading = false,
    this.lastError,
    this.mode = ChatMode.normal,
    this.dshPhase = DshPhase.idle,
  });

  ChatState copyWith({
    List<ChatTurn>? turns,
    bool? isLoading,
    String? lastError,
    bool clearError = false,
    ChatMode? mode,
    DshPhase? dshPhase,
  }) {
    return ChatState(
      turns: turns ?? this.turns,
      isLoading: isLoading ?? this.isLoading,
      lastError: clearError ? null : (lastError ?? this.lastError),
      mode: mode ?? this.mode,
      dshPhase: dshPhase ?? this.dshPhase,
    );
  }

  final List<ChatTurn> turns;
  final bool isLoading;
  final String? lastError;

  /// Which pipeline the NEXT question takes (ChatMode).
  final ChatMode mode;

  /// Progress of the last DSH session, for the status line.
  final DshPhase dshPhase;
}

/// Chat business logic: /ask roundtrip + history persistence.
/// State is Riverpod-managed (architecture blueprint) — widgets stay dumb.
@riverpod
class ChatController extends _$ChatController {
  @override
  Future<ChatState> build() async {
    final history = await ref.watch(chatHistoryServiceProvider).load();
    // NEXT6 (G8): load the STABLE, persisted DSH conversation id for this
    // (server, user) scope — a restart resumes the same conversation, and
    // switching gateway/account deliberately starts a new one.
    final settings = ref.read(appSettingsServiceProvider);
    _dshConversationId = await ref
        .read(dshConversationServiceProvider)
        .loadOrCreate(
          server: settings.gatewayBaseUrl,
          user: settings.gatewayAuthUser,
        );
    return ChatState(turns: history);
  }

  /// Sends one question. Returns true when an answer was recorded (input may
  /// be cleared); false on failure (input must be kept — tasks.md 2.5).
  /// P1 §4.4: the user tapped a candidate in the picker. Re-ask the SAME
  /// sentence with the chosen id — the server re-validates it and, if it holds,
  /// returns the proposal the fuzzy match was not allowed to produce.
  /// The pick is deliberately NOT a new question: the text comes from the turn
  /// that offered the picker, so the intent cannot drift.
  Future<bool> pickEntity(EntityCandidate candidate, {required String question}) =>
      send(question, entityId: candidate.id);

  /// Switches which pipeline the next question uses (C1: explicit, never
  /// automatic). Clearing the previous DSH phase matters: leaving a "failed"
  /// badge on screen after the user returned to Normal would describe a mode
  /// they are no longer in.
  void setMode(ChatMode mode) {
    final current = state.value ?? const ChatState();
    if (current.mode == mode && current.dshPhase == DshPhase.idle) return;
    state = AsyncData(
      current.copyWith(mode: mode, dshPhase: DshPhase.idle, clearError: true),
    );
  }

  /// The DSH conversation id, loaded once in [build] from
  /// [ConversationIdService] (persisted, scoped by server+user). A follow-up
  /// inside DSH mode resumes the same gateway session (bounded TTL server-side);
  /// an app restart keeps the SAME id, and "new conversation"/account switch
  /// rotates it. Null only before [build] finishes — [send] is guarded by
  /// `state.isLoading` until then.
  String? _dshConversationId;

  /// [sourceDocument] (next3/B) carries the identity of the paper document the
  /// sentence was read from, when the caller has one (the camera and the XML
  /// file channel do). It is handed to `/ask` UNCHANGED and only the server
  /// decides what it means — the app never derives a key, and the field is
  /// ignored by every capability that does not declare one.
  ///
  /// DSH mode never receives it: that endpoint is read-only server-side, and the
  /// field exists to stop a WRITE from being duplicated.
  Future<bool> send(
    String text, {
    String? entityId,
    Map<String, dynamic>? sourceDocument,
  }) async {
    final trimmed = text.trim();
    if (trimmed.isEmpty) return false;
    // Cold-start race guard: while build() is still loading history the state
    // is AsyncLoading with value == null. Treating that as an empty state and
    // appending would OVERWRITE the stored history with just this one turn.
    // (AsyncValue.isLoading — not the ChatState field below.)
    if (state.isLoading) return false;
    final current = state.value ?? const ChatState();
    if (current.isLoading) return false;

    // C2: DSH mode is a DIFFERENT endpoint with a different bound, and it never
    // sends entity_id/submit_now — the agent path is read-only server-side, so
    // there is nothing those fields could legitimately carry here.
    if (current.mode == ChatMode.dsh) {
      return _sendDsh(trimmed, current);
    }

    state = AsyncData(current.copyWith(isLoading: true, clearError: true));
    // Decided inside the try, ACTED ON after it — see the comment at the tail.
    var autoFallback = false;
    try {
      // F7-2 (user decision 2026-09-18): the submit switch is read NOW, when
      // the question is asked — the server freezes the answer into the proposal
      // snapshot. Changing the setting later cannot reword or re-arm a card
      // already on screen (the card replays its snapshot on /execute).
      final submitNow = ref.read(appSettingsServiceProvider).allowSubmitPayment;
      final result = await ref
          .read(copilotApiClientProvider)
          .ask(
            trimmed,
            entityId: entityId,
            submitNow: submitNow,
            sourceDocument: sourceDocument,
          );
      // This provider is auto-disposed when the chat screen goes away (opening
      // Settings mid-request). Riverpod then REJECTS a `state =` write with
      // UnmountedRefException — a real unhandled crash, caught by the DSH
      // dispose test (result57 §10) and present here since Phase 3.
      if (!ref.mounted) return false;
      // Auto AI fallback (`.plan/next2/auto-fallback-dsh.md` §3). The setting is
      // read HERE — once, when the answer arrives — and its outcome is frozen
      // onto the turn, so flipping the switch later cannot rewrite what a
      // message already on screen offers (the same one-shot rule as
      // `submit_now`, F7-2).
      //
      // Only UNKNOWN_INTENT qualifies. LOW_CONFIDENCE deliberately does not: the
      // classifier reached a business domain and is asking the user to be more
      // specific, which is the system working, not failing to understand.
      final unrouted = result.errorCode == _unknownIntentCode;
      final auto =
          unrouted && ref.read(appSettingsServiceProvider).autoFallbackToAi;
      await _append(
        ChatTurn.fromAskResult(
          result,
          typedQuestion: trimmed,
          aiFallbackOffered: unrouted && !auto,
        ),
      );
      autoFallback = auto;
    } on CopilotException catch (err) {
      await _recordFailure(trimmed, err.message);
      return false;
    } catch (_) {
      await _recordFailure(trimmed, 'Đã xảy ra lỗi không xác định.');
      return false;
    }
    // Deliberately OUTSIDE the try above: the fallback carries its own error
    // handling (`_sendDsh` never throws — every failure becomes chat state), so
    // awaiting it in here would let a second copy of the same failure be
    // recorded by these catch clauses.
    if (autoFallback) return askAiFallback(trimmed);
    return true;
  }

  /// Asks the AI path about a question the deterministic route could not place
  /// (`.plan/next2/auto-fallback-dsh.md` §1/§3).
  ///
  /// Reached from exactly two places — the automatic branch in [send] and the
  /// button on that message — so both can only ever take the SAME route and the
  /// user can never get a different behaviour from the two entry points.
  ///
  /// It moves the mode selector as well: the answer it is about to record comes
  /// from the AI path, and the status line above the input has to say so.
  ///
  /// What this is NOT: a server-side redirect. `/ask` still never spawns dsh
  /// (D2, asserted by p5-dsh-optin.test.mjs) — these are two separate requests
  /// issued by the CLIENT, and the second one is read-only server-side: it can
  /// answer, it can never propose or execute anything.
  Future<bool> askAiFallback(String question) async {
    final text = question.trim();
    if (text.isEmpty) return false;
    // One agent session at a time: a second tap while a session runs is dropped
    // rather than queued, so a burst of taps cannot stack sessions.
    if (state.value?.isLoading ?? false) return false;
    setMode(ChatMode.dsh);
    return _sendDsh(text, state.value ?? const ChatState());
  }

  /// C2 — send through the DSH agent endpoint and show its progress.
  ///
  /// The result is recorded through the SAME [_append] normal answers use, so
  /// the DSH turn is trimmed and persisted identically (and cannot bypass any
  /// history rule). It carries `routedGroup: 'dsh'` so the bubble says which
  /// pipeline produced it.
  ///
  /// It cannot confirm anything: the proposal on a DSH turn is always null —
  /// the gateway never returns one on this path (plan §11), and the confirm
  /// button lives on the proposal card, not on a turn.
  Future<bool> _sendDsh(String trimmed, ChatState current) async {
    state = AsyncData(
      current.copyWith(
        isLoading: true,
        clearError: true,
        dshPhase: DshPhase.starting,
      ),
    );
    try {
      final res = await ref
          .read(copilotApiClientProvider)
          .dshAsk(trimmed, conversationId: _dshConversationId);
      // A DSH session lasts ~20s, so the user leaving the screen mid-request is
      // the NORMAL case here, not an edge case: every write after this point
      // must check that the provider still exists.
      if (!ref.mounted) return false;
      // NEXT6 Prompt-5: the gateway echoes the conversation id it ACTUALLY
      // answered in (it mints one when the client sent none). Adopting the
      // server's id — and persisting it for this (server, user) scope — is what
      // keeps the NEXT question in the same thread instead of silently forking
      // a new one. Same-id responses change nothing.
      final serverConvId = res.conversationId;
      if (serverConvId != null &&
          serverConvId.isNotEmpty &&
          serverConvId != _dshConversationId) {
        _dshConversationId = serverConvId;
        final settings = ref.read(appSettingsServiceProvider);
        await ref
            .read(dshConversationServiceProvider)
            .save(
              serverConvId,
              server: settings.gatewayBaseUrl,
              user: settings.gatewayAuthUser,
            );
      }
      await _append(
        ChatTurn(
          question: trimmed,
          answer: res.answer,
          ok: true,
          ts: DateTime.now(),
          routedGroup: 'dsh',
        ),
      );
      if (!ref.mounted) return false;
      state = AsyncData(
        (state.value ?? const ChatState())
            .copyWith(dshPhase: DshPhase.completed),
      );
      return true;
    } on CopilotException catch (err) {
      // §4: a gateway that is already busy (429 DSH_GATEWAY_IN_FLIGHT) is not a
      // broken session. Show the gateway's own wording, leave the mode bar clean
      // (nothing failed, so no red "phiên vừa lỗi"), and do NOT retry by itself —
      // one tap stays one session.
      if (err is CopilotDshRefusedException &&
          err.code == _dshInFlightCode) {
        return _noteDshBusy(err.message);
      }
      return _failDsh(trimmed, err.message);
    } catch (_) {
      return _failDsh(trimmed, 'Đã xảy ra lỗi không xác định.');
    }
  }

  /// Another agent session is already running: tell the user to wait without
  /// painting a failure.
  ///
  /// Returns false for both callers' own reasons: the button re-arms itself, and
  /// `send()`'s contract is "false ⇒ the typed question is kept", which is what
  /// lets the user press Gửi again once the running session finishes. It does
  /// NOT retry on its own — a busy gateway is a wait, not a spin.
  Future<bool> _noteDshBusy(String message) async {
    if (!ref.mounted) return false;
    final current = state.value ?? const ChatState();
    state = AsyncData(
      current.copyWith(
        isLoading: false,
        dshPhase: DshPhase.idle,
        lastError: message,
      ),
    );
    return false;
  }

  /// Records a failed DSH session, tolerating a provider that is already gone.
  Future<bool> _failDsh(String question, String message) async {
    if (!ref.mounted) return false;
    await _recordFailure(question, message);
    if (!ref.mounted) return false;
    state = AsyncData(
      (state.value ?? const ChatState()).copyWith(dshPhase: DshPhase.failed),
    );
    return false;
  }

  Future<void> clearHistory() async {
    await ref.read(chatHistoryServiceProvider).clear();
    // NEXT6 (G8): clearing history is "start a NEW conversation" — rotate the
    // DSH conversation id so the gateway does not carry the old thread's
    // context into the fresh one.
    final settings = ref.read(appSettingsServiceProvider);
    _dshConversationId = await ref.read(dshConversationServiceProvider).rotate(
          server: settings.gatewayBaseUrl,
          user: settings.gatewayAuthUser,
        );
    // Same rule as everywhere else: the screen can be gone by now.
    if (!ref.mounted) return;
    state = AsyncData(const ChatState());
  }

  /// Phase 9 UI (result32): after /execute refuses a card with 409
  /// PROPOSAL_STALE / PROPOSAL_EXPIRED, stamp the reason onto THAT card in the
  /// turn list (and persist it) so the banner survives app restarts. The card
  /// is matched by its stable commandId — the same identity the idempotency
  /// gate uses server-side.
  Future<void> attachRejection(
    ActionProposal proposal, {
    required String code,
    required List<String> problems,
  }) async {
    if (!ref.mounted) return;
    final current = state.value;
    if (current == null) return;
    final targetId = proposal.commandId;
    var changed = false;
    final turns = current.turns.map((turn) {
      final p = turn.proposal;
      if (p == null || p.commandId != targetId || p.isRejected) return turn;
      changed = true;
      return ChatTurn(
        question: turn.question,
        answer: turn.answer,
        ok: turn.ok,
        ts: turn.ts,
        routedGroup: turn.routedGroup,
        candidates: turn.candidates,
        // The result33-F4 rule: a field that must survive every model rebuild
        // has to be carried here too, or stamping a refusal onto a card would
        // silently drop it. A1 had already dropped `readUi` here (same bug
        // class, found while adding M1) — a refusal is stamped on a card, and
        // the turn it sits on may also carry a drill-down or an M1 create
        // offer. Both are now carried.
        aiFallbackOffered: turn.aiFallbackOffered,
        readUi: turn.readUi,
        customerCreateOffer: turn.customerCreateOffer,
        proposal: ActionProposal(
          schema: p.schema,
          action: p.action,
          risk: p.risk,
          riskIcon: p.riskIcon,
          riskLabel: p.riskLabel,
          needConfirm: p.needConfirm,
          needDoubleConfirm: p.needDoubleConfirm,
          executable: p.executable,
          entityKind: p.entityKind,
          entityId: p.entityId,
          entityName: p.entityName,
          summary: p.summary,
          commandIdSeed: p.commandIdSeed,
          createdAt: p.createdAt,
          rejectionCode: code,
          rejectionProblems: problems,
          params: p.params,
          // P1: carry the snapshot identity + dedup warning through the rebuild.
          // Dropping them here is the result33-F4 bug class (a field the server
          // reads must survive every model rebuild).
          proposalId: p.proposalId,
          version: p.version,
          expiresAt: p.expiresAt,
          dedupRequiresAck: p.dedupRequiresAck,
          dedupMessage: p.dedupMessage,
        ),
      );
    }).toList();
    if (!changed) return;
    // Deliberately NO trimming here (review 2026-09-17). B.2 trims "after each
    // appended turn", and a refusal is not an append. Worse: rejecting a card
    // clears its hasPendingProposal, so running the cap here would drop the
    // very card the user just tried to confirm (it is usually the oldest) —
    // exactly when they need to read WHY it was refused. Proven by
    // chat_history_trim_test (6 turns → 5 without this guard).
    state = AsyncData(current.copyWith(turns: turns));
    await ref.read(chatHistoryServiceProvider).save(turns);
  }

  Future<void> _append(ChatTurn turn) async {
    if (!ref.mounted) return;
    final current = state.value ?? const ChatState();
    // B.2 (2026-09-16): cap the history at the user's maxChatItems, dropping
    // the OLDEST turns first — but never a turn with a pending proposal. The
    // rule lives in ChatHistoryService.trimTurns so the in-memory list and the
    // persisted list are trimmed identically.
    final maxItems = ref.read(appSettingsServiceProvider).maxChatItems;
    final turns =
        ChatHistoryService.trimTurns([...current.turns, turn], maxItems);
    state = AsyncData(current.copyWith(turns: turns, isLoading: false));
    await ref
        .read(chatHistoryServiceProvider)
        .save(turns, maxItems: maxItems);

    // TTS (plan2 next2): read the turn that JUST arrived, if the user asked for
    // it. This method is the ONLY place a NEW turn enters the list — build()
    // (history restore) and attachRejection() (stamping a refusal onto an
    // existing card) return above and must never speak. `pickEntity` reaches
    // here through send(), because that is genuinely a new answer.
    //
    // NOT awaited (review 2026-09-19 — deliberate deviation from the plan's §4
    // snippet, which used `await ...speak(...)`): the chat screen clears its
    // input field only once send() returns, so awaiting audio lets an engine
    // that never answers its own init (dead TTS binder, no engine installed)
    // hold send() open forever and leave the typed text in the box after a
    // question that actually succeeded. Proven by the "engine that never
    // answers" test — it timed out before this change. Reading aloud is a
    // courtesy; the chat must never wait on it.
    unawaited(_maybeSpeak(turn));
  }

  /// Reads [turn] aloud when the setting is ON.
  ///
  /// Fire-and-forget with a TOTAL try/catch, gate included: the answer is
  /// already recorded and saved by the time we get here, so nothing about
  /// reading aloud — not the engine, not even this method's own bookkeeping —
  /// may change the chat result or surface as an error. An async failure here
  /// would otherwise escape as an unhandled zone error, because the caller no
  /// longer awaits us.
  Future<void> _maybeSpeak(ChatTurn turn) async {
    try {
      if (!ref.read(appSettingsServiceProvider).ttsEnabled) return;
      final spoken = spokenTextFor(turn);
      if (spoken.isEmpty) return;
      await ref.read(ttsServiceProvider).speak(spoken);
    } catch (_) {
      // Never let an audio problem touch the chat result.
    }
  }

  /// The sanitised text to read aloud for [turn] (plan §5; source narrowed
  /// 2026-09-20 per `.plan/next2/tts-scope-and-markdown.md` §1).
  ///
  /// Takes ONLY [ChatTurn.answer]. The proposal card is deliberately NOT read:
  /// it is a structured block (risk badge, customer, amount) the user studies
  /// with their own eyes to make the decision, and hearing it re-read while
  /// reading it is noise rather than help. Nothing about the card's
  /// affordances changes — being read aloud was never the same as confirming.
  ///
  /// A side effect worth keeping: the read-aloud source can no longer carry the
  /// internal fields that used to reach it through the summary. `commandId`,
  /// `proposalId` and `params` are machine identifiers, and an engine handed
  /// one spells it out letter by letter (`action_id` dài ngoằng — the plan's own
  /// warning).
  ///
  /// Kept as a static so a test can pin the invariant directly instead of only
  /// through a fake engine.
  static String spokenTextFor(ChatTurn turn) => sanitizeForSpeech(turn.answer);

  /// Defensive clean-up before anything reaches the engine: strips raw markdown
  /// punctuation (answers are plain prose today — this guards a future backend
  /// format change) and any leftover identifier-shaped token, so an internal id
  /// can never be read out even if one slips into a summary.
  static String sanitizeForSpeech(String text) {
    final withoutMarkup =
        text.replaceAll(_markdownNoise, '').replaceAll(_uuidLike, '');
    return withoutMarkup.replaceAll(RegExp(r'\s+'), ' ').trim();
  }

  Future<void> _recordFailure(String question, String message) async {
    if (!ref.mounted) return;
    final current = state.value ?? const ChatState();
    // The failed question is NOT appended as a fake answer row — the user
    // keeps their typed text and can resend. Error surfaces via lastError.
    state = AsyncData(
      current.copyWith(isLoading: false, lastError: message),
    );
  }
}
