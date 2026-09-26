import 'package:flutter/material.dart';

/// Design tokens (openspec/config.yaml "Design tokens") as a ThemeData.
/// Widgets MUST take colors/spacing/radius from the theme — never magic values.
class AppTheme {
  AppTheme._();

  static ThemeData light() {
    final scheme = ColorScheme.fromSeed(seedColor: const Color(0xFF6750A4));
    return ThemeData(
      useMaterial3: true,
      colorScheme: scheme,
      scaffoldBackgroundColor: scheme.surface,
      appBarTheme: AppBarTheme(centerTitle: true, backgroundColor: scheme.surface),
      cardTheme: CardThemeData(
        elevation: 1, // design token: elevation.card
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(12), // design token: radius.md
        ),
      ),
      inputDecorationTheme: InputDecorationTheme(
        border: OutlineInputBorder(
          borderRadius: BorderRadius.circular(12), // design token: radius.md
        ),
        isDense: true,
        contentPadding: const EdgeInsets.symmetric(
          horizontal: AppSpacing.md,
          vertical: AppSpacing.sm + 4,
        ),
      ),
    );
  }
}

/// Spacing scale — reference as AppSpacing.* in widgets.
class AppSpacing {
  const AppSpacing._();

  static const double xs = 4;
  static const double sm = 8;
  static const double md = 16;
  static const double lg = 24;
  static const double xl = 32;
}
