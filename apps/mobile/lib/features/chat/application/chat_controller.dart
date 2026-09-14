import 'package:flutter/foundation.dart';
import 'package:riverpod_annotation/riverpod_annotation.dart';

import '../../../app/providers.dart';
import '../data/chat_models.dart';
import '../data/copilot_api_client.dart';

part 'chat_controller.g.dart';

/// Immutable UI state of the chat screen.
@immutable
class ChatState {
  const ChatState({
    this.turns = const [],
    this.isLoading = false,
    this.lastError,
  });

  ChatState copyWith({
    List<ChatTurn>? turns,
    bool? isLoading,
    String? lastError,
    bool clearError = false,
  }) {
    return ChatState(
      turns: turns ?? this.turns,
      isLoading: isLoading ?? this.isLoading,
      lastError: clearError ? null : (lastError ?? this.lastError),
    );
  }

  final List<ChatTurn> turns;
  final bool isLoading;
  final String? lastError;
}

/// Chat business logic: /ask roundtrip + history persistence.
/// State is Riverpod-managed (architecture blueprint) — widgets stay dumb.
@riverpod
class ChatController extends _$ChatController {
  @override
  Future<ChatState> build() async {
    final history = await ref.watch(chatHistoryServiceProvider).load();
    return ChatState(turns: history);
  }

  /// Sends one question. Returns true when an answer was recorded (input may
  /// be cleared); false on failure (input must be kept — tasks.md 2.5).
  Future<bool> send(String text) async {
    final trimmed = text.trim();
    if (trimmed.isEmpty) return false;
    final current = state.value ?? const ChatState();
    if (current.isLoading) return false;

    state = AsyncData(current.copyWith(isLoading: true, clearError: true));
    try {
      final result = await ref.read(copilotApiClientProvider).ask(trimmed);
      await _append(ChatTurn.fromAskResult(result, typedQuestion: trimmed));
      return true;
    } on CopilotException catch (err) {
      await _recordFailure(trimmed, err.message);
      return false;
    } catch (_) {
      await _recordFailure(trimmed, 'Đã xảy ra lỗi không xác định.');
      return false;
    }
  }

  Future<void> clearHistory() async {
    await ref.read(chatHistoryServiceProvider).clear();
    state = AsyncData(const ChatState());
  }

  Future<void> _append(ChatTurn turn) async {
    final current = state.value ?? const ChatState();
    final turns = [...current.turns, turn];
    state = AsyncData(current.copyWith(turns: turns, isLoading: false));
    await ref.read(chatHistoryServiceProvider).save(turns);
  }

  Future<void> _recordFailure(String question, String message) async {
    final current = state.value ?? const ChatState();
    // The failed question is NOT appended as a fake answer row — the user
    // keeps their typed text and can resend. Error surfaces via lastError.
    state = AsyncData(
      current.copyWith(isLoading: false, lastError: message),
    );
  }
}
