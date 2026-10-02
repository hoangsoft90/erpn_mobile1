import 'package:erpn_mobile/features/chat/data/conversation_id_service.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

/// NEXT6 (G8): the DSH conversation id must be STABLE across restarts for one
/// (server,user) scope, unique enough to avoid collision, and rotated/cleared
/// when the scope changes or the user starts a new conversation.
void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  test('creates a conv- id the gateway charset accepts', () async {
    SharedPreferences.setMockInitialValues({});
    final prefs = await SharedPreferences.getInstance();
    final id = await ConversationIdService(prefs: prefs)
        .loadOrCreate(server: 'http://host:8788', user: 'copilot');
    expect(id, startsWith('conv-'));
    expect(RegExp(r'^[A-Za-z0-9_.:-]{1,64}$').hasMatch(id), isTrue);
  });

  test('persists across instances for the same scope (restart continuity)',
      () async {
    SharedPreferences.setMockInitialValues({});
    final prefs = await SharedPreferences.getInstance();
    final first = await ConversationIdService(prefs: prefs)
        .loadOrCreate(server: 's', user: 'u');
    // A NEW service instance over the SAME storage == an app restart.
    final second = await ConversationIdService(prefs: prefs)
        .loadOrCreate(server: 's', user: 'u');
    expect(second, first,
        reason: 'a restart must resume the same conversation');
  });

  test('a different server/account starts a NEW conversation', () async {
    SharedPreferences.setMockInitialValues({});
    final prefs = await SharedPreferences.getInstance();
    final svc = ConversationIdService(prefs: prefs);
    final a = await svc.loadOrCreate(server: 's1', user: 'u');
    final b = await svc.loadOrCreate(server: 's2', user: 'u');
    expect(b, isNot(a));
    // Returning to s1 is a FRESH conversation (the stored id was overwritten).
    final back = await svc.loadOrCreate(server: 's1', user: 'u');
    expect(back, isNot(a));
  });

  test('rotate() forces a new id but then stays stable', () async {
    SharedPreferences.setMockInitialValues({});
    final prefs = await SharedPreferences.getInstance();
    final svc = ConversationIdService(prefs: prefs);
    final a = await svc.loadOrCreate(server: 's', user: 'u');
    final b = await svc.rotate(server: 's', user: 'u');
    expect(b, isNot(a));
    final c = await svc.loadOrCreate(server: 's', user: 'u');
    expect(c, b, reason: 'the rotated id is the new stable one');
  });

  test('save() pins a server-issued id for the scope (NEXT6 Prompt-5)',
      () async {
    SharedPreferences.setMockInitialValues({});
    final prefs = await SharedPreferences.getInstance();
    final svc = ConversationIdService(prefs: prefs);
    await svc.loadOrCreate(server: 's', user: 'u');
    // The gateway answered in its own thread — the client pins that id.
    await svc.save('conv-from-server', server: 's', user: 'u');
    expect(
      await svc.loadOrCreate(server: 's', user: 'u'),
      'conv-from-server',
      reason: 'the persisted id is the server-issued one',
    );
    // Scope law: the server id does not leak into ANOTHER scope.
    expect(
      await svc.loadOrCreate(server: 's', user: 'other'),
      isNot('conv-from-server'),
    );
  });

  test('save() with an empty id is a no-op', () async {
    SharedPreferences.setMockInitialValues({});
    final prefs = await SharedPreferences.getInstance();
    final svc = ConversationIdService(prefs: prefs);
    final a = await svc.loadOrCreate(server: 's', user: 'u');
    await svc.save('', server: 's', user: 'u');
    expect(
      await svc.loadOrCreate(server: 's', user: 'u'),
      a,
      reason: 'an empty server id must never wipe the stored thread',
    );
  });

  test('null prefs still yields a usable id (fail-safe)', () async {
    final id = await ConversationIdService(prefs: null)
        .loadOrCreate(server: 's', user: 'u');
    expect(id, startsWith('conv-'));
  });
}
