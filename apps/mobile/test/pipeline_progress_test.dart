import 'package:erpn_mobile/features/chat/presentation/widgets/pipeline_progress.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

// P2 deliverable 4: the request-in-flight UX shows pipeline PHASES (labels),
// not a bare spinner. The labels are the contract with the user.
void main() {
  testWidgets('PipelineProgress shows the phase labels and advances', (tester) async {
    await tester.pumpWidget(const MaterialApp(home: Scaffold(body: PipelineProgress())));

    expect(find.text('Đang hiểu câu…'), findsOneWidget);

    // The cadence advances the label without any user input.
    await tester.pump(const Duration(milliseconds: 1700));
    expect(find.text('Đang tra khách…'), findsOneWidget);
    await tester.pump(const Duration(milliseconds: 1700));
    expect(find.text('Đang kiểm tra…'), findsOneWidget);

    // The LinearProgressIndicator is present (determinate, value 0..1).
    expect(find.byType(LinearProgressIndicator), findsOneWidget);
  });

  testWidgets('PipelineProgress does not setState after dispose (F1 crash class)', (tester) async {
    await tester.pumpWidget(const MaterialApp(home: Scaffold(body: PipelineProgress())));
    await tester.pump(const Duration(milliseconds: 100));
    // Tear down while a delayed tick is pending — the guard must swallow it
    // (no "setState called after dispose" exception surfacing in tests).
    await tester.pumpWidget(const SizedBox.shrink());
    await tester.pump(const Duration(milliseconds: 1700));
    await tester.pump(const Duration(milliseconds: 1700));
    expect(tester.takeException(), isNull);
  });
}
