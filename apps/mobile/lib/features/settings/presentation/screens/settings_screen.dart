import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../../app/providers.dart';
import '../../../../app/theme/app_theme.dart';
import '../../../../core/constants/app_constants.dart';
import '../../../../core/settings/app_settings_service.dart';

/// Settings screen (2026-09-16): point the app at a gateway and cap the chat
/// history — WITHOUT rebuilding the APK.
///
/// Values are read live by [CopilotApiClient] on every request, so pressing
/// Save applies immediately (no restart). Nothing is written until Save, so an
/// APK that was built with `--dart-define` keeps using those values until the
/// user deliberately changes them.
class SettingsScreen extends ConsumerStatefulWidget {
  const SettingsScreen({super.key});

  @override
  ConsumerState<SettingsScreen> createState() => _SettingsScreenState();
}

class _SettingsScreenState extends ConsumerState<SettingsScreen> {
  final _formKey = GlobalKey<FormState>();
  late final TextEditingController _urlController;
  late final TextEditingController _userController;
  late final TextEditingController _passwordController;
  late final TextEditingController _maxItemsController;

  bool _obscurePassword = true;
  bool _saving = false;

  /// F7-2 (user decision 2026-09-18): "allow real submission" switch. Toggling
  /// ON requires the explicit confirmation dialog — a tap alone never enables
  /// it, and Save persists whatever state the dialog left.
  bool _allowSubmit = false;

  /// P6 UX (user decision 2026-09-18): "Tự gửi sau khi nói xong" — default OFF.
  /// No dialog needed: it only changes WHEN the client sends text the user just
  /// spoke; it cannot confirm a proposal or reach /execute.
  bool _voiceAutoSend = false;

  /// TTS (plan2 next2): "Đọc câu trả lời" — default OFF. No dialog needed: it
  /// only reads the answer aloud through the on-device engine; it can never
  /// confirm a proposal or reach /execute.
  bool _ttsEnabled = false;

  AppSettingsService get _settings => ref.read(appSettingsServiceProvider);

  @override
  void initState() {
    super.initState();
    final s = _settings;
    // First open (nothing saved): PRE-FILL the current dev tunnel so the field
    // is not empty. Saved values always win.
    _urlController = TextEditingController(text: s.gatewayBaseUrlOrDefault);
    _userController = TextEditingController(text: s.gatewayAuthUser);
    _passwordController = TextEditingController(text: s.gatewayAuthPassword);
    _maxItemsController =
        TextEditingController(text: s.maxChatItems.toString());
    _allowSubmit = s.allowSubmitPayment;
    _voiceAutoSend = s.voiceAutoSend;
    _ttsEnabled = s.ttsEnabled;
  }

  @override
  void dispose() {
    _urlController.dispose();
    _userController.dispose();
    _passwordController.dispose();
    _maxItemsController.dispose();
    super.dispose();
  }

  String? _validateUrl(String? value) {
    if (!AppSettingsService.isValidGatewayUrl(value ?? '')) {
      return 'URL không hợp lệ (phải là http:// hoặc https:// có host)';
    }
    return null;
  }

  String? _validateMaxItems(String? value) {
    final n = int.tryParse((value ?? '').trim());
    if (n == null) return 'Nhập một số nguyên';
    if (n < AppConstants.minMaxChatItems) {
      return 'Tối thiểu ${AppConstants.minMaxChatItems}';
    }
    return null;
  }

  /// F7-2: turning the submit switch ON goes through this dialog — never a
  /// bare tap. Cancelling leaves the switch OFF (no state change); confirming
  /// is the only path to true. Turning OFF needs no dialog (safe direction).
  Future<void> _maybeEnableSubmit() async {
    final scheme = Theme.of(context).colorScheme;
    final confirmed = await showDialog<bool>(
      context: context,
      barrierDismissible: false, // a deliberate choice, not a stray tap outside
      builder: (dialogContext) => AlertDialog(
        title: const Text('Cho phép nộp phiếu thu thật?'),
        content: Text(
          'Khi bật, bấm Xác nhận trên đề xuất thu tiền sẽ NỘP phiếu thật — '
          'công nợ khách giảm ngay. Muốn hoàn tác phải huỷ submit trực tiếp '
          'trên ERPNext.',
          style: TextStyle(color: scheme.onSurface),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(dialogContext).pop(false),
            child: const Text('Huỷ'),
          ),
          FilledButton(
            style: FilledButton.styleFrom(
              backgroundColor: scheme.error,
              foregroundColor: scheme.onError,
            ),
            onPressed: () => Navigator.of(dialogContext).pop(true),
            child: const Text('Bật nộp phiếu thật'),
          ),
        ],
      ),
    );
    if (confirmed == true && mounted) setState(() => _allowSubmit = true);
  }

  Future<void> _save() async {
    if (!(_formKey.currentState?.validate() ?? false)) return;
    setState(() => _saving = true);
    final settings = _settings;
    final okGateway = await settings.saveGateway(
      baseUrl: _urlController.text,
      authUser: _userController.text,
      authPassword: _passwordController.text,
    );
    // Clamp before storing so the field shows what was actually kept.
    final storedMax = await settings.saveMaxChatItems(
      int.parse(_maxItemsController.text.trim()),
    );
    // F7-2: the switch was already confirmed (dialog) when it was turned ON —
    // Save just persists it alongside the rest.
    //
    // Every write counts towards the reported result (review 2026-09-18):
    // reporting success from saveGateway() alone meant a switch could show as
    // ON while nothing was persisted — the same "it said saved, but it was
    // not" class of bug the footer URL once had.
    final okSubmit = await settings.saveAllowSubmitPayment(_allowSubmit);
    final okVoice = await settings.saveVoiceAutoSend(_voiceAutoSend);
    final okTts = await settings.saveTtsEnabled(_ttsEnabled);
    final ok = okGateway && okSubmit && okVoice && okTts;
    // Reactivity (review 2026-09-17, found via the chat footer): the service's
    // getters read prefs live, but a plain Provider does NOT notify its
    // watchers when only the underlying values change. Invalidate so every
    // watcher (chat footer, API client provider) rebuilds with the saved
    // values — this is what makes Save actually apply everywhere, not just in
    // the next request.
    ref.invalidate(appSettingsServiceProvider);
    if (!mounted) return;
    setState(() {
      _saving = false;
      _maxItemsController.text = storedMax.toString();
    });
    final scheme = Theme.of(context).colorScheme;
    ScaffoldMessenger.of(context)
      ..hideCurrentSnackBar()
      ..showSnackBar(
        SnackBar(
          backgroundColor: ok ? null : scheme.errorContainer,
          content: Text(
            ok
                ? 'Đã lưu — áp dụng ngay, không cần khởi động lại.'
                : 'Không lưu được cài đặt (bộ nhớ thiết bị không khả dụng).',
          ),
        ),
      );
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Cài đặt')),
      body: SafeArea(
        child: Form(
          key: _formKey,
          child: ListView(
            padding: const EdgeInsets.all(AppSpacing.md),
            children: [
              Text(
                'Máy chủ Copilot',
                style: Theme.of(context).textTheme.titleMedium,
              ),
              const SizedBox(height: AppSpacing.sm),
              TextFormField(
                controller: _urlController,
                keyboardType: TextInputType.url,
                autocorrect: false,
                decoration: const InputDecoration(
                  labelText: 'Gateway URL',
                  hintText: AppConstants.defaultGatewayBaseUrl,
                  helperText: 'Ví dụ: https://erpn8788.loca.lt',
                ),
                validator: _validateUrl,
              ),
              const SizedBox(height: AppSpacing.sm),
              TextFormField(
                controller: _userController,
                autocorrect: false,
                decoration: const InputDecoration(labelText: 'Auth user'),
              ),
              const SizedBox(height: AppSpacing.sm),
              TextFormField(
                controller: _passwordController,
                obscureText: _obscurePassword,
                autocorrect: false,
                enableSuggestions: false,
                decoration: InputDecoration(
                  labelText: 'Auth password',
                  suffixIcon: IconButton(
                    tooltip: _obscurePassword ? 'Hiện' : 'Ẩn',
                    icon: Icon(_obscurePassword
                        ? Icons.visibility_outlined
                        : Icons.visibility_off_outlined),
                    onPressed: () => setState(
                        () => _obscurePassword = !_obscurePassword),
                  ),
                ),
              ),
              const SizedBox(height: AppSpacing.lg),
              Text(
                'Lịch sử chat',
                style: Theme.of(context).textTheme.titleMedium,
              ),
              const SizedBox(height: AppSpacing.sm),
              TextFormField(
                controller: _maxItemsController,
                keyboardType: TextInputType.number,
                inputFormatters: [FilteringTextInputFormatter.digitsOnly],
                decoration: InputDecoration(
                  labelText: 'Số tin nhắn tối đa',
                  helperText:
                      'Tối thiểu ${AppConstants.minMaxChatItems}. Tin nhắn có đề xuất '
                      'thu tiền đang chờ xác nhận sẽ KHÔNG bị cắt.',
                ),
                validator: _validateMaxItems,
              ),
              const SizedBox(height: AppSpacing.lg),
              Text(
                'Thu tiền',
                style: Theme.of(context).textTheme.titleMedium,
              ),
              const SizedBox(height: AppSpacing.xs),
              // F7-2: the submit switch. ON ⇒ confirming a payment proposal
              // also SUBMITS the draft on ERPNext (debt drops immediately).
              // Default OFF; enabling requires the explicit dialog above.
              CheckboxListTile(
                contentPadding: EdgeInsets.zero,
                controlAffinity: ListTileControlAffinity.leading,
                value: _allowSubmit,
                onChanged: (on) async {
                  if (on == true) {
                    await _maybeEnableSubmit();
                  } else if (mounted) {
                    setState(() => _allowSubmit = false);
                  }
                },
                title: const Text('Cho phép nộp phiếu thu thật'),
                subtitle: Text(
                  _allowSubmit
                      ? 'ĐANG BẬT: xác nhận trên đề xuất sẽ tạo VÀ NỘP phiếu (công nợ giảm ngay).'
                      : 'TẮT: xác nhận chỉ tạo phiếu NHÁP — cần submit tay trên ERPNext.',
                  style: TextStyle(
                    color: _allowSubmit
                        ? Theme.of(context).colorScheme.error
                        : Theme.of(context).colorScheme.onSurfaceVariant,
                    fontSize: 12,
                  ),
                ),
              ),
              const SizedBox(height: AppSpacing.lg),
              Text(
                'Giọng nói',
                style: Theme.of(context).textTheme.titleMedium,
              ),
              const SizedBox(height: AppSpacing.xs),
              // P6 UX: dictation normally FILLS the input and waits for Gửi.
              // Turning this ON sends the final transcript through the very
              // same Send path — the user still gets to read the question in
              // the chat, and a payment proposal still needs its own Xác nhận.
              SwitchListTile(
                contentPadding: EdgeInsets.zero,
                value: _voiceAutoSend,
                onChanged: (on) => setState(() => _voiceAutoSend = on),
                title: const Text('Tự gửi sau khi nói xong'),
                subtitle: Text(
                  _voiceAutoSend
                      ? 'ĐANG BẬT: đọc xong là gửi câu hỏi ngay — vẫn phải bấm Xác nhận khi thu tiền.'
                      : 'TẮT: đọc xong chỉ điền vào ô nhập, bạn xem/sửa rồi bấm Gửi.',
                  style: TextStyle(
                    color: Theme.of(context).colorScheme.onSurfaceVariant,
                    fontSize: 12,
                  ),
                ),
              ),
              const Divider(height: AppSpacing.lg),
              // TTS (plan2 next2): reads a NEW answer aloud with the phone's own
              // voice engine. ON ⇒ the answer to a new question (and a payment
              // proposal's summary) is spoken; a proposal STILL needs its own
              // Xác nhận — reading it out is an announcement, not an action.
              SwitchListTile(
                contentPadding: EdgeInsets.zero,
                value: _ttsEnabled,
                onChanged: (on) => setState(() => _ttsEnabled = on),
                title: const Text('Đọc câu trả lời'),
                subtitle: Text(
                  _ttsEnabled
                      ? 'ĐANG BẬT: câu trả lời mới sẽ được đọc to — vẫn phải bấm Xác nhận khi thu tiền.'
                      : 'TẮT: chỉ hiển thị câu trả lời, không đọc.',
                  style: TextStyle(
                    color: Theme.of(context).colorScheme.onSurfaceVariant,
                    fontSize: 12,
                  ),
                ),
              ),
              // Only a note, not a warning: a device without a Vietnamese voice
              // simply stays silent (the answer is still on screen), so there
              // is nothing here the user must fix before using the app.
              Padding(
                padding: const EdgeInsets.only(left: AppSpacing.xs),
                child: Text(
                  'Cần máy đã cài gói tiếng Việt cho Google Text-to-Speech.',
                  style: TextStyle(
                    color: Theme.of(context).colorScheme.onSurfaceVariant,
                    fontSize: 11,
                  ),
                ),
              ),
              const SizedBox(height: AppSpacing.lg),
              FilledButton.icon(
                onPressed: _saving ? null : _save,
                icon: _saving
                    ? const SizedBox(
                        width: 16,
                        height: 16,
                        child: CircularProgressIndicator(strokeWidth: 2),
                      )
                    : const Icon(Icons.save_outlined),
                label: Text(_saving ? 'Đang lưu...' : 'Lưu'),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
