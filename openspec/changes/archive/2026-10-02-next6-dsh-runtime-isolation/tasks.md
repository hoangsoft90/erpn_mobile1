## 1. Runtime isolation (P1)

- [x] 1.1 Default `cwd` không còn `REPO_ROOT` — `env.DSH_CWD ?? path.join(tmpdir(), "dsh-gw-cwd")`; tạo thư mục on demand trước spawn. — `src/dsh-gateway.mjs` (`dshGatewayConfig`, `runDshAskInner` mkdirSync).
- [x] 1.2 Patch YAML nhận path TUYỆT ĐỐI: `ERPN_REPO_ROOT` / `ERPN_COPILOT_SERVER` (fallback `process.cwd()` cho `dsh web --patch` thủ công từ repo root). — `dsh-e2e.patch.yml` + `dsh.cordis.patch.yml`.
- [x] 1.3 `DSH_ROUTER_CREDENTIAL` (placeholder không-bí-mật, router tự thay auth per-upstream) thay `GEMINI_API_KEY` trong route config; gateway set nếu thiếu. — patch + `buildDshChildEnv`.
- [x] 1.4 `.env` (gitignored) đã set `DSH_CWD` + `DSH_ROUTER_CREDENTIAL`. — không commit.

## 2. Poison/sentinel — bằng chứng 2 vế (P1)

- [x] 2.1 FALSIFY (config cũ, cwd=repo, sentinel tạm trong 3 file .md): output `PROBE_SENTINEL=LEAK`, chars 104472.
- [x] 2.2 Config mới (cwd cô lập): `PROBE_SENTINEL=NO_LEAK`, chars 52248 (mất đúng phần AGENTS/CLAUDE ~52k).
- [x] 2.3 Vế 2 — `/dsh/ask` thật: "Trả lời từ ERPNext: lan không còn nợ gì." + `erp_target=REAL` (copilot_ask vẫn gọi ERPNext thật).
- [x] 2.4 Sentinel hoàn tác sạch (grep 0 hit trong AGENTS.md/working.md/operating_rules.md).
- [x] 2.5 Lữ khách xác nhận system boundary: `PROBE_BOUNDARY=FOUND` trên message `role=system` (P3).

## 3. Code gate mở rộng (P2)

- [x] 3.1 `foldVietnamese()` + deny-list off-topic (fold dấu; chỉ áp cho câu router KHÔNG nhận diện — ERP thắng deny-list). — `src/dsh-gateway.mjs`.
- [x] 3.2 `isErpNextMeta()` → `DSH_META_INFO` trả câu CỐ ĐỊNH `DSH_META_ANSWER` (không để LLM tự giải thích).
- [x] 3.3 "anh khánh" đi QUA gate (entity-shaped → resolver; không refuse cứng).
- [x] 3.4 Test +5 (`test/dsh-gateway.test.mjs`): 52/52 PASS.
- [x] 3.5 FALSIFY: gỡ nhánh gate ⇒ đúng 5 test off-topic đỏ (47/52) ⇒ khôi phục ⇒ 52/52.

## 4. System boundary (P3)

- [x] 4.1 Xác minh dsh CÓ lớp system thật: `@deepseek-ai/dsh-system-prompt`, row id `system-prompt`, `personaPrefix` — đọc từ source package, không đoán.
- [x] 4.2 Thêm row vào `dsh-e2e.patch.yml` với ranh giới phạm vi ERP + marker `ERP_BOUNDARY_V1`.

## 5. Untrusted data (P4 — audit-only)

- [x] 5.1 Nguyên tắc đã có sẵn: `src/untrusted-data.mjs` nối copilot-server (dùng chung child `/dsh/ask`); test 3/3 gồm "injection cannot trigger a WRITE".
- [ ] 5.2 **CHỜ DUYỆT**: live test GHI 1 note injection lên khách probe trên ERPNext THẬT rồi hỏi qua `/dsh/ask` (đây là GHI production — cần user duyệt), dọn note sau.

## 6. Tests + docs

- [x] 6.1 Full `mcp-erpnext`: **859/859 PASS**.
- [x] 6.2 P5 bảng test §7 (các dòng code-gate): 5×`DSH_OFF_TOPIC` + 1×`DSH_META_INFO` qua `/dsh/ask` thật — PASS.
- [ ] 6.3 **CHỜ LLM THẬT**: 3 dòng P5 cần entity-resolver ("anh khánh", "công nợ khách Anh Khánh", "cám heo tồn bao nhiêu") + 2 lượt cùng `conversation_id`.
- [x] 6.4 Commit `4e99e00` (isolation+scope, KHÔNG `.env`) — user đã duyệt push 2026-09-27.
