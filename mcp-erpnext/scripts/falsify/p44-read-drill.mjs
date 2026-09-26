#!/usr/bin/env node
/**
 * P4-4 falsification harness — day drill-down (plan4_final §4.4).
 *
 * Break ONE guard at a time, prove the NAMED test turns RED, restore the file,
 * verify the restore is byte-identical. A guard whose removal turns nothing red
 * is decoration — this file is how that claim gets checked.
 *
 * The cases are chosen around the two things that could quietly go wrong here:
 * a drill answering for an id nobody declared (or the wrong capability's
 * authority), and the list disagreeing with the number the user tapped.
 *
 * Run: node scripts/falsify/p44-read-drill.mjs
 */
import { runCases } from "./lib/harness.mjs";

const NODE_FILES = {
  drill: "test/p44-read-drill.test.mjs",
  authz: "test/p44-read-drill-authz.test.mjs",
};

const DART_SUITES = {
  drill: "test/drill_list_test.dart",
  // P4-6 lives on the summary screen, so its cases must point at the SUMMARY
  // suite — pointing them at the drill file made every one of them "no test
  // matched" while still printing PROBLEM (caught by the harness, not by me).
  summary: "test/daily_summary_test.dart",
  // D4: the "clear cache on server/account switch" guard lives in the Settings
  // form (the persisted half) — its own suite.
  settings: "test/settings_test.dart",
};

const DART_VIEW = "../apps/mobile/lib/features/ops/presentation/screens/drill_list_screen.dart";
const DART_SUMMARY = "../apps/mobile/lib/features/ops/presentation/screens/daily_summary_screen.dart";
const DART_SETTINGS = "../apps/mobile/lib/features/settings/presentation/screens/settings_screen.dart";
const DART_CLIENT = "../apps/mobile/lib/features/chat/data/copilot_api_client.dart";
const DART_DRAWER = "../apps/mobile/lib/features/ops/presentation/widgets/app_drawer.dart";

const CASES = [
  // ── the closed set: an id must be declared, and authorized as itself ───────
  {
    name: "the contract lookup is skipped (any id is served)",
    suite: "node",
    file: "src/drill-views.mjs",
    nodeFile: "drill",
    only: "an id nobody declared is refused",
    old: "  const drill = getDrillScreen(id);",
    new: "  const drill = getDrillScreen(id) ?? { title: 'x', capability: 'ops.daily_summary', limit: { default: 10, min: 5, max: 10 } };",
  },
  {
    name: "the route authorizes a DIFFERENT capability than the contract names for this drill",
    suite: "node",
    file: "src/http-ask.mjs",
    nodeFile: "authz",
    only: "denied account gets 403 and ZERO ERPNext reads",
    old: "        drillAuthz = authorize(drillRef.drill.capability, { principal, env });",
    new: '        drillAuthz = authorize("ops.daily_summary", { principal, env });',
  },
  {
    name: "the page size stops coming from the contract (a client can ask for everything)",
    suite: "node",
    file: "src/drill-views.mjs",
    nodeFile: "drill",
    only: "the page size is CONTRACT policy",
    old: "  const pageSize = clampUiLimit(drill, limit);",
    new: "  const pageSize = Number.isFinite(Number(limit)) ? Math.trunc(Number(limit)) : 10;",
  },
  // ── review round (2026-09-21): two guards the code review added ────────────
  {
    name: "an ABSENT limit stops falling back to the contract default (Number(null)=0 clamps it to min)",
    suite: "node",
    file: "src/capability-contract.mjs",
    nodeFile: "drill",
    only: "an absent limit is the CONTRACT default",
    old: "  const want = requested === null || requested === undefined || requested === '' ? null : Number(requested);",
    new: "  const want = Number(requested);",
  },
  {
    name: "a draft of ANOTHER company counts as this shop's app draft (company scoping dropped from drafts)",
    suite: "node",
    file: "src/skills/ops-summary.mjs",
    nodeFile: "drill",
    only: "drill rows ADD UP",
    old: '        if (r.docstatus !== 0 || !rowOfCompany(r, company) || (r[dateField] ?? null) !== date) continue;',
    new: '        if (r.docstatus !== 0 || (r[dateField] ?? null) !== date) continue;',
  },
  // ── P4-5: the drafts block is the APP's drafts only, of THE DAY ──────────
  {
    name: "a draft WITHOUT the correlation id enters the block (every site draft counts as the app's)",
    suite: "node",
    file: "src/skills/ops-summary.mjs",
    nodeFile: "drill",
    only: "a draft WITHOUT the correlation id",
    // D3 reshaped this read (per-section try/catch + dedupe) — re-anchored on
    // the filter line + closing call of the draft section.
    old: '          filters: [["custom_ai_action_id", "is", "set"]],\n          limit: 500,\n        });',
    new: '          filters: [],\n          limit: 500,\n        });',
  },
  {
    name: "the day boundary stops being the document's own date (yesterday's draft counts as today's)",
    suite: "node",
    file: "src/skills/ops-summary.mjs",
    nodeFile: "drill",
    only: "the day boundary is the document's own date",
    old: '        if (r.docstatus !== 0 || !rowOfCompany(r, company) || (r[dateField] ?? null) !== date) continue;',
    new: '        if (r.docstatus !== 0 || !rowOfCompany(r, company)) continue;',
  },
  {
    name: "a draft row renders a fabricated 0đ again (the em-dash rule is dropped)",
    suite: "dart",
    file: DART_VIEW,
    dartSuite: "drill",
    only: "P4-5: an app-draft row leads with the DOCUMENT",
    // D2 added the quantity branch to this same trailing expression — anchor
    // on the isAppDraft line only, so the case survives unrelated extensions.
    old: "        trailing: isAppDraft",
    new: "        trailing: false && isAppDraft",
  },
  // ── P4-6: the day pick shows the day it NAMES (title ⇄ figure must match) ──
  {
    name: "the Hôm qua invoice card shows TODAY's number again (label/figure split returns)",
    suite: "dart",
    file: DART_SUMMARY,
    dartSuite: "summary",
    only: "picking Hôm qua swaps bán/thu",
    old: "            _salesInvoices(viewingYesterday ? _yesterday! : data),",
    new: "            _salesInvoices(data),",
  },
  {
    name: "the Hôm qua receipts card shows TODAY's total again (label/figure split returns)",
    suite: "dart",
    file: DART_SUMMARY,
    dartSuite: "summary",
    only: "picking Hôm qua swaps bán/thu",
    old: "            _receipts(viewingYesterday ? _yesterday! : data),",
    new: "            _receipts(data),",
  },
  {
    name: "a FAILED yesterday read falls back to today's numbers under the hôm qua title",
    suite: "dart",
    file: DART_SUMMARY,
    dartSuite: "summary",
    only: "a FAILED yesterday read shows NO figure",
    old: "            _DayNotRead(\n              title: 'Tiền khách trả hôm qua',\n              block: 'receipts',\n              loading: _yesterdayLoading,\n              onRetry: () => _loadYesterday(),\n            ),",
    new: "            _receipts(data),",
  },
  {
    name: "the day pick stops following the selected day (Hôm qua drills TODAY)",
    suite: "dart",
    file: DART_SUMMARY,
    dartSuite: "summary",
    only: "the drill follows the SELECTED day",
    old: "        date: _viewDay != null ? d.meta.date : null,",
    new: "        date: null,",
  },
  // ── one truth: the rows must belong to the number that was tapped ─────────
  {
    name: "a CANCELLED order lands in the list (the summary's rule is dropped)",
    suite: "node",
    file: "src/skills/ops-summary.mjs",
    nodeFile: "drill",
    only: "drill rows ADD UP",
    old: '    const submitted = rows.filter((r) => r.docstatus === 1 && r.status !== "Cancelled");',
    new: "    const submitted = rows.filter((r) => r.docstatus === 1);",
  },
  {
    name: "a RETURN is counted as the day's invoice in the drill list (the summary excludes it)",
    suite: "node",
    file: "src/skills/ops-summary.mjs",
    nodeFile: "drill",
    only: "drill rows ADD UP",
    old: "    const rows = submittedNotCancelled(rowsOf(res).filter((r) => rowOfCompany(r, company) && !r.is_return));\n    const amount = vnd(rows.reduce((s, r) => s + (Number(r.grand_total) || 0), 0));\n    return {\n      summary_lines: [{ label: \"Hóa đơn đã xuất (giá trị sau VAT)\", amount_vnd: amount, count: rows.length }],",
    new: "    const rows = submittedNotCancelled(rowsOf(res).filter((r) => rowOfCompany(r, company)));\n    const amount = vnd(rows.reduce((s, r) => s + (Number(r.grand_total) || 0), 0));\n    return {\n      summary_lines: [{ label: \"Hóa đơn đã xuất (giá trị sau VAT)\", amount_vnd: amount, count: rows.length }],",
  },
  {
    name: "a payment OUT lands in the receipts drill (money leaving shown as money received)",
    suite: "node",
    file: "src/skills/ops-summary.mjs",
    nodeFile: "drill",
    only: "drill rows ADD UP",
    old: '    const receive = rows.filter((r) => r.payment_type === "Receive");',
    new: "    const receive = rows;",
  },
  {
    // Re-pointed at D1's refusal assertion: after D3, the app-drafts aggregate
    // legitimately answers 200 + `partial` when a SECTION is unreadable (that is
    // §3.4's rule), so the guard this case protects now lives on a
    // single-section view — an unreadable DEBT read must still be a refusal,
    // never a 200 with an empty list.
    name: "an unreadable read answers 200 with an empty list (a fabricated zero)",
    suite: "node",
    file: "src/http-ask.mjs",
    nodeFile: "drill",
    only: "D1: the draft hint is OPTIONAL",
    old: '        const code = err?.code === DRILL_VIEW_CODES.UNKNOWN_DRILL ? DRILL_VIEW_CODES.UNKNOWN_DRILL : dailySummaryErrorCode(err);',
    new: '        if (true) { sendJson(res, 200, { drill: drillRef.id, title: "", date: drillDate, limit: 10, summary_lines: [], total_documents: 0, truncated: false, rows: [] }); return; }\n        const code = dailySummaryErrorCode(err);',
  },
  // ── D1 (drawer-plan-final §3.1): the company-wide debt views ──────────────
  {
    name: "the drawer debt view subtracts OPEN DRAFT payments from the books (GL raw lost)",
    suite: "node",
    file: "src/skills/ops-summary.mjs",
    nodeFile: "drill",
    only: "receivable_customers: company-wide GL raw",
    old: '    const rows = await companyDebtRows();\n    const byCustomer = new Map();',
    new: '    const rows = (await companyDebtRows()).map((r) => ({\n      ...r,\n      outstanding_amount: Number(r.outstanding_amount) - 1_000_000,\n    }));\n    const byCustomer = new Map();',
  },
  {
    name: "the Top view stops sorting by AGE (biggest debt first — nợ lâu no longer leads)",
    suite: "node",
    file: "src/skills/ops-summary.mjs",
    nodeFile: "drill",
    only: "overdue_top: oldest debt FIRST",
    old: '      .sort((a, b) => a.date !== b.date ? a.date.localeCompare(b.date) : b.amount_vnd - a.amount_vnd);',
    new: '      .sort((a, b) => b.amount_vnd - a.amount_vnd);',
  },
  {
    name: "the §3.1 footnote disappears (the drawer no longer says what its figures are)",
    suite: "dart",
    file: DART_VIEW,
    dartSuite: "drill",
    only: "the drawer opens Công nợ as a READ drill",
    old: "          if (data.footnote != null)",
    new: "          if (false)",
  },
  // ── D1c (drawer-plan-final §3.2): the invoice-level view ──────────────────
  {
    name: "unpaid_invoices shrinks an invoice's outstanding by the open drafts (GL raw lost)",
    suite: "node",
    file: "src/skills/ops-summary.mjs",
    nodeFile: "drill",
    only: "D1c unpaid_invoices: one row per invoice",
    old: "        name: r.name,\n        date: r.due_date ?? null,\n        amount_vnd: vnd(r.outstanding_amount),",
    new: "        name: r.name,\n        date: r.due_date ?? null,\n        amount_vnd: vnd(Number(r.outstanding_amount) - 1_000_000),",
  },
  {
    name: "the D1c tiebreak inverts (the FARTHER due date first)",
    suite: "node",
    file: "src/skills/ops-summary.mjs",
    nodeFile: "drill",
    only: "D1c: due-date tiebreak",
    old: "          : String(a.date ?? \"9999-12-31\").localeCompare(String(b.date ?? \"9999-12-31\")),",
    new: "          : String(b.date ?? \"9999-12-31\").localeCompare(String(a.date ?? \"9999-12-31\")),",
  },
  // ── D2 (drawer-plan-final §3.3): the low-stock view ──────────────────
  {
    name: "stock_low answers WITHOUT the warehouse pin (warehouses[0] fallback — §9 forbids)",
    suite: "node",
    file: "src/skills/ops-summary.mjs",
    nodeFile: "drill",
    only: "D2 stock_low: pinned warehouse only",
    old: '    const warehouse = String(env?.COPILOT_DEFAULT_WAREHOUSE ?? "").trim();\n    if (!warehouse) {',
    new: '    const warehouse = String(env?.COPILOT_DEFAULT_WAREHOUSE ?? "").trim() || "Stores - S";\n    if (!warehouse) {',
  },
  {
    name: "stock_low sorts qty DESCENDING (the low stock no longer leads)",
    suite: "node",
    file: "src/skills/ops-summary.mjs",
    nodeFile: "drill",
    only: "D2 stock_low: pinned warehouse only",
    old: '      .sort((a, b) => (a.amount_vnd !== b.amount_vnd ? a.amount_vnd - b.amount_vnd : String(a.name).localeCompare(String(b.name))));',
    new: '      .sort((a, b) => (a.amount_vnd !== b.amount_vnd ? b.amount_vnd - a.amount_vnd : String(a.name).localeCompare(String(b.name))));',
  },
  // ── D3 (drawer-plan-final §3.4): the app-drafts aggregate ────────────────
  {
    name: "a half-read aggregate stops ADMITTING it (partial always false — a section vanishes silently)",
    suite: "node",
    file: "src/skills/ops-summary.mjs",
    nodeFile: "drill",
    only: "D3: one unreadable doctype is a PARTIAL section",
    old: "      partial: failed.length > 0,",
    new: "      partial: false,",
  },
  {
    name: "one unreadable doctype takes the WHOLE screen down again (500 instead of a skipped section)",
    suite: "node",
    file: "src/skills/ops-summary.mjs",
    nodeFile: "drill",
    only: "D3: a doctype without the correlation field is a SKIPPED SECTION",
    old: "      } catch (err) {\n        const msg = String(err?.message ?? err);",
    new: "      } catch (err) {\n        throw err;\n        const msg = String(err?.message ?? err);",
  },
  {
    name: "an ERP outage reports itself as an empty 'partial' day (error dressed as a quiet day)",
    suite: "node",
    file: "src/skills/ops-summary.mjs",
    nodeFile: "drill",
    only: "D3: one unreadable doctype is a PARTIAL section",
    old: "    if (okCount === 0) {",
    new: "    if (false) {",
  },
  {
    name: "the same action id is kept TWICE (the server stops choosing canonical)",
    suite: "node",
    file: "src/skills/ops-summary.mjs",
    nodeFile: "drill",
    only: "D3: the SAME action id is ONE row",
    old: "      const prev = byAction.get(item.actionId);\n      if (!prev) {",
    new: "      const prev = byAction.get(item.actionId);\n      if (true) {",
  },
  // ── the app: the tap sends an id, never a question; refusals stay refusals ─
  {
    name: "the metric card stops opening a drill (the tap does nothing)",
    suite: "dart",
    file: DART_SUMMARY,
    dartSuite: "drill",
    only: "tapping a metric sends ONE structured drill request",
    old: "              onTap: () => context.push('/drill', extra: drill),",
    new: "              onTap: null,",
  },
  {
    name: "the tap hardcodes the WRONG drill id (the card no longer names its own metric)",
    suite: "dart",
    file: DART_SUMMARY,
    dartSuite: "drill",
    only: "tapping a metric sends ONE structured drill request",
    old: "      drill: const DrillIntent(drillId: 'sales_orders_today', title: 'Đơn hàng hôm nay'),",
    new: "      drill: const DrillIntent(drillId: 'overdue_customers', title: 'Đơn hàng hôm nay'),",
  },
  {
    name: "a capped list stops saying how many rows exist (a page reads as the whole day)",
    suite: "dart",
    file: DART_VIEW,
    dartSuite: "drill",
    only: "a CAPPED list says how many rows exist",
    old: "          if (data.truncated)",
    new: "          if (false)",
  },
  {
    name: "a failed read renders as an empty list (a refusal dressed as a quiet day)",
    suite: "dart",
    file: DART_VIEW,
    dartSuite: "drill",
    only: "an unreadable drill shows the reason with a retry",
    old: "    if (data == null) {\n      return Padding(",
    new: "    if (data == null) {\n      return const Padding(padding: EdgeInsets.all(AppSpacing.lg), child: Text('Không có dòng nào trong mục này cho ngày 2026-09-21.'));\n    }\n    if (false) {\n      return Padding(",
  },
  // ── D4: the title must name the day that was READ, and the read must end ──
  {
    name: "a day-scoped drill stops stating the day (the title no longer reflects the filter)",
    suite: "node",
    file: "src/drill-views.mjs",
    nodeFile: "drill",
    only: "D4: a day-scoped drill titles itself",
    old: '  const dayWord = drill.day_scoped === true ? drillDayWord(date, today) : "";',
    new: '  const dayWord = "";',
  },
  {
    name: "the day word is always \"hôm nay\" (a yesterday list is labelled today)",
    suite: "node",
    file: "src/drill-views.mjs",
    nodeFile: "drill",
    only: "D4: a day-scoped drill titles itself",
    old: '  if (typeof today === "string" && today !== "") {',
    new: '  if (typeof today === "string" && today !== "") {\n    return "hôm nay";',
  },
  {
    name: "the drill screen stops preferring the server's title (the local label wins over the day it read)",
    suite: "dart",
    file: DART_VIEW,
    dartSuite: "drill",
    only: "D4: the drill title states the DAY it read",
    old: "    final title = _data?.title ?? (widget.intent.title.isNotEmpty ? widget.intent.title : 'Chi tiết');",
    new: "    final title = widget.intent.title.isNotEmpty ? widget.intent.title : 'Chi tiết';",
  },
  {
    name: "the drawer READ has no hard bound (a read that never answers spins forever)",
    suite: "dart",
    file: DART_CLIENT,
    dartSuite: "drill",
    only: "D4: a read that never answers is BOUNDED",
    old: "            queryParameters: {'drill_id': drillId, 'date': ?date},\n          )\n          // D4 (§2.4) — total bound on the read (see [AppConstants.readTimeout]).\n          .timeout(AppConstants.readTimeout);",
    new: "            queryParameters: {'drill_id': drillId, 'date': ?date},\n          );",
  },
  {
    name: "the badge renders on a ZERO count (a number the server did not claim)",
    suite: "dart",
    file: DART_DRAWER,
    dartSuite: "drill",
    only: "D4: no badge when the count is 0",
    old: "    final showBadge = count != null && count > 0;",
    new: "    final showBadge = count != null;",
  },
  {
    name: "changing the server keeps the previous company's cached day (the drawer opens on another shop's books)",
    suite: "dart",
    file: DART_SETTINGS,
    dartSuite: "settings",
    only: "D4: switching the gateway CLEARS the drawer day cache",
    old: "    if (previousUrl != _urlController.text.trim() ||\n        previousUser != _userController.text.trim()) {",
    new: "    if (false) {",
  },
  {
    name: "the /drill route accepts a missing intent (it invents a screen to open)",
    suite: "dart",
    file: "../apps/mobile/lib/app/router/app_router.dart",
    dartSuite: "drill",
    only: "/drill without an intent is REFUSED",
    old: "        final extra = state.extra;\n        if (extra is! DrillIntent) {",
    new: "        final extra = state.extra;\n        if (extra is! DrillIntent) {\n          return MaterialPage<void>(key: state.pageKey, child: const DrillListScreen(intent: DrillIntent(drillId: 'invoices_today', title: '')));\n        }\n        if (false) {",
  },
];

process.exit(runCases(CASES, { title: "P4-4 day drill", nodeFiles: NODE_FILES, dartSuites: DART_SUITES }) === 0 ? 0 : 1);
