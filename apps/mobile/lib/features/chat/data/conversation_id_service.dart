import 'dart:math';

import 'package:shared_preferences/shared_preferences.dart';

import '../../../core/constants/app_constants.dart';

/// NEXT6 (G8): one STABLE DSH conversation id per `(server, user)` scope,
/// persisted so an app restart CONTINUES the same conversation instead of
/// silently starting a new one.
///
/// Why it changed: the controller used an in-memory
/// `'conv-${DateTime.now().millisecondsSinceEpoch}'` — a new id on every app
/// start (and no "new conversation" concept). The gateway scopes session
/// context by `principal + conversation_id`, so a stable id is what lets a
/// follow-up question actually resume its thread.
///
/// SECURITY SEMANTICS (must stay honest): this id is a CONVENIENCE, not
/// authentication. It can be spoofed by any client sharing the same
/// authenticated principal, so it must NEVER be treated as a security boundary.
/// Real per-user identity is a separate, future migration.
///
/// Fail-safe: storage problems never crash the app — a missing/broken
/// preference falls back to a fresh in-memory id (tasks.md 2.4 pattern).
class ConversationIdService {
  // ignore: prefer_initializing_formals — named param `prefs` stays public API
  ConversationIdService({required SharedPreferences? prefs}) : _prefs = prefs;

  final SharedPreferences? _prefs;

  /// The scope a stored id belongs to. Password is deliberately NOT part of it
  /// (a secret must never influence a stored key, and rotating a password
  /// should not silently reset a conversation).
  static String _scopeOf(String? server, String? user) => '${server ?? ''}|${user ?? ''}';

  /// Returns the stored id when it matches the current scope, otherwise creates,
  /// persists and returns a NEW id (server/account switch ⇒ new conversation).
  Future<String> loadOrCreate({String? server, String? user}) async {
    final scope = _scopeOf(server, user);
    final prefs = _prefs;
    if (prefs != null) {
      try {
        final raw = prefs.getString(AppConstants.dshConversationStorageKey);
        if (raw != null && raw.isNotEmpty) {
          final nl = raw.indexOf('\n');
          if (nl > 0) {
            final storedScope = raw.substring(0, nl);
            final storedId = raw.substring(nl + 1);
            if (storedScope == scope && storedId.isNotEmpty) return storedId;
          }
        }
      } catch (_) {
        // fall through to a fresh id
      }
    }
    final fresh = newId();
    await _persist(scope, fresh);
    return fresh;
  }

  /// Forces a NEW conversation id for this scope ("cuộc trò chuyện mới").
  Future<String> rotate({String? server, String? user}) async {
    final fresh = newId();
    await _persist(_scopeOf(server, user), fresh);
    return fresh;
  }

  /// NEXT6 Prompt-5: pins a server-issued id for this scope. The gateway may
  /// answer in a DIFFERENT conversation than the client sent (e.g. the client
  /// had none and the server minted one) — persisting the server's id is what
  /// lets the next question resume THAT thread instead of forking it.
  Future<void> save(String id, {String? server, String? user}) async {
    if (id.isEmpty) return;
    await _persist(_scopeOf(server, user), id);
  }

  /// Drops the stored id (account logout / server change).
  Future<void> clear() async {
    try {
      await _prefs?.remove(AppConstants.dshConversationStorageKey);
    } catch (_) {
      // ignore — a stale id is replaced on the next loadOrCreate anyway
    }
  }

  Future<void> _persist(String scope, String id) async {
    try {
      await _prefs?.setString(
        AppConstants.dshConversationStorageKey,
        '$scope\n$id',
      );
    } catch (_) {
      // storage unavailable — the in-memory caller still has the id
    }
  }

  /// A UUID-ish, collision-safe id made ONLY of characters the gateway's
  /// `isValidConversationId` accepts (`^[A-Za-z0-9_.:-]{1,64}$`).
  static String newId() {
    final rnd = Random.secure();
    String hex(int n) =>
        List.generate(n, (_) => rnd.nextInt(16).toRadixString(16)).join();
    return 'conv-${hex(8)}-${hex(4)}-4${hex(3)}-${hex(4)}-${hex(12)}';
  }
}
