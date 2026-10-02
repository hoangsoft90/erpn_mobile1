// Phase 10 (§4.1) — the release-endpoint guard.
//
// A release APK must never silently point at loopback: `127.0.0.1` on a phone
// is the PHONE ITSELF, so the app "opens fine and answers nothing". The
// compiled-in default IS a loopback (dev convenience), so the production value
// has to arrive via `--dart-define=COPILOT_BASE_URL` from CI. These tests pin
// that contract: the default is flagged as a loopback, a real host is not, and
// the CI workflow still passes the define — so removing it turns this file red
// before an endpoint-less APK can ship.
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

import 'package:erpn_mobile/app/providers.dart';
import 'package:erpn_mobile/core/constants/app_constants.dart';

void main() {
  group('release endpoint guard (Phase 10 §4.1)', () {
    test('the compiled-in default is a dev loopback (dev-only)', () {
      expect(AppConstants.defaultCopilotBaseUrl, 'http://127.0.0.1:8788');
      expect(
        AppConstants.isLoopbackUrl(AppConstants.defaultCopilotBaseUrl),
        isTrue,
      );
    });

    test('isLoopbackUrl flags dev hosts and passes real hosts', () {
      expect(AppConstants.isLoopbackUrl('http://127.0.0.1:8788'), isTrue);
      expect(AppConstants.isLoopbackUrl('http://localhost:8788'), isTrue);
      expect(AppConstants.isLoopbackUrl('http://10.0.2.2:8788'), isTrue,
          reason: 'the Android emulator host alias is still the device itself');
      expect(AppConstants.isLoopbackUrl('https://erpn.example.com'), isFalse);
      expect(AppConstants.isLoopbackUrl('http://100.101.102.103:8788'), isFalse,
          reason: 'a Tailscale/LAN address is a real endpoint');
      expect(AppConstants.isLoopbackUrl(''), isFalse);
      expect(AppConstants.isLoopbackUrl('not a url'), isFalse);
    });

    test('with no --dart-define the app falls back to loopback and says so',
        () {
      // This test build carries NO --dart-define, so it stands in for a release
      // build whose CI forgot the variable: the guard must mark it.
      expect(AppEnvironment.defaults.isDevLoopback, isTrue,
          reason:
              'a build without COPILOT_BASE_URL is NOT a release-ready build');
    });

    test('the CI workflow supplies COPILOT_BASE_URL via --dart-define', () {
      // The guard that makes the failure loud: a release build with a loopback
      // endpoint is a SILENT failure, so the check is that CI compiles the real
      // one in. Drop the define and this goes red.
      //
      // `flutter test` runs with cwd = apps/mobile, but the exact depth is an
      // environment detail, so walk UP from cwd until the workflow is found
      // instead of hard-coding `../..`.
      File? workflow;
      var dir = Directory.current;
      for (var i = 0; i < 5 && workflow == null; i++) {
        final candidate = File(
            '${dir.path}/.github/workflows/android-debug-apk.yml');
        if (candidate.existsSync()) workflow = candidate;
        if (dir.path == dir.parent.path) break;
        dir = dir.parent;
      }
      expect(workflow, isNotNull,
          reason:
              'release guard cannot find the CI workflow (cwd=${Directory.current.path})');
      final text = workflow!.readAsStringSync();
      expect(text.contains('--dart-define=COPILOT_BASE_URL'), isTrue,
          reason:
              'CI must compile the production endpoint in; without it the APK ships loopback');
    });
  });
}
