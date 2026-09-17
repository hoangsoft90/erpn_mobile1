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
          backgroundColor: okGateway ? null : scheme.errorContainer,
          content: Text(
            okGateway
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
