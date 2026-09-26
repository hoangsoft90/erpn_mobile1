# checklist.md — ERPNext Vietnamese Voice Copilot (erpn_mobile1)

Danh sách kiểm tra nhanh: **đã làm / chưa làm / cần hỏi lại**.
Bằng chứng chi tiết: `result*.txt` (mới nhất = result74) + `.plan/phases3/*-result.md`.
Trạng thái roadmap chi tiết nằm ở `next.md` — file này KHÔNG nhân bản, chỉ tóm tắt.

## PHIÊN 2026-09-26 — next5 ĐÃ COMMIT + fix "Hôm qua" ĐÃ COMMIT + audit NEXT6 — 2 commit CHƯA push

| Việc | Trạng thái |
|---|---|
| Commit toàn bộ next5 (D0→D5) | ✅ `17d6f9b` (39 file, +4093/−169) — secret scan sạch. Loại khỏi commit: `syncode`, `checklist1.md`, `faq1.md`, `icon.png`, `query_customer.py` |
| Commit fix P4-6 "Hôm qua" | ✅ `ed79f77` (8 file) — [VÙNG SỐ TIỀN], user duyệt riêng |
| Push | ⏳ **CHƯA** — chờ user gõ "push" ⇒ CI APK |

### Đã làm — fix P4-6 "Tóm tắt ngày Hôm qua" (`ed79f77`)

- Hướng user chốt (A)+2: xem "Hôm qua" ⇒ 2 thẻ (Hóa đơn đã xuất · Tiền khách trả) hiện **số HÔM QUA**; **bỏ hẳn** dòng delta.
- `_DayNotRead`: hôm qua chưa đọc được ⇒ tiêu đề + "Đang đọc…"/"Chưa đọc được…" + `Thử lại` — **fail-closed, KHÔNG rơi về số hôm nay** (`summary-day-not-read-*`).
- Drill date = `d.meta.date` (ngày của server). Xoá `_deltaLine()` + keys `invoices-delta`/`receipts-delta`.
- Số đo: Flutter **333/333** · analyze **0** · falsify `p44-read-drill` **38/38 RED**.

### CHƯA sửa — M1/M2 (Code Review `ed79f77`, MANUAL vì OCR không khả dụng) — ⏳ **CHỜ USER**

- **M1 (Medium):** `onRefresh: () => _load(force: true)` (`daily_summary_screen.dart:265`) chỉ đọc lại HÔM NAY ⇒ đang xem "Hôm qua" kéo-refresh KHÔNG làm mới ngày đang xem.
- **M2 (Medium):** `_BlockError.onRetry` (trong `_salesInvoices`/`_receipts` khi `d=_yesterday`) reload HÔM NAY, không phải ngày đang xem.
- Cả hai chạm **vùng SỐ TIỀN** ⇒ AI KHÔNG tự sửa/tự commit; đang chờ user quyết.
- Low (ghi nhận, không cấp bách): L1 note "chỉ bán/thu" nhưng thẻ SO giữ số hôm nay · L2 tiêu đề block-error không nhất quán · L3 ngày fetch client-side vs drill server · L4 `_isQuietDay(data)` dùng hôm nay khi xem hôm qua.

### Đã làm — audit NEXT6 (Prompt-1, AUDIT-ONLY)

- Deliverable `.plan/next6-audit1.md` (277 dòng): 11 gap G1–G11 (session isolation) — store key không principal · không lock per-conversation · `sessionContext` global cross-user · replay không kiểm user_id · proposal không bind principal · 429 thiếu `Retry-After` · `DSH_MAX_SESSIONS` chưa dùng · Flutter id không persist · thiếu endpoint clear · log `/ask` thiếu `conversation_id`.
- Baseline: Node **820/818/2** (2 fail dsh từ B0) · Flutter **333/333** · analyze **0**.
- **CHƯA tạo** change `next6-session-isolation` (sẽ tạo ở đầu Prompt-2 trước khi code).

### Cần hỏi lại user

1. Sửa **M1/M2** không, sửa theo hướng nào? (vùng số tiền)
2. `push` 2 commit `17d6f9b` + `ed79f77` khi nào? (chưa từng qua CI)
3. NEXT6 Prompt-2: tạo change `next6-session-isolation` ngay bây giờ chứ?

### Còn treo từ trước (nhắc lại)

- Revoke token `ghp_…7aO` + dán token mới / dùng deploy key WRITE (user).
- Duyệt 2 layout P5-4 + test tay Android thật (auto-send) (user).
- Vòng XML THẬT 2 lần cùng file (P9-D) — cần user cho phép ghi thật.
- `docs/plan4-mode-map.md` (P4-0) chưa tạo; B2/B3/B4 idempotency site thật; P4-3/4/5/6 chưa tách `result*.txt` riêng.

---

## next5/D0 → D5 — Drawer READ (D0 ✅ · D0.5 PASS · D1→D4 ✅ · **D5 ✅ next5 ĐÓNG**) — 2026-09-25/26

| Mốc | Trạng thái |
|---|---|
| **D0** — liệt kê surface READ + map 5 mục placeholder + đo site (company/default warehouse/`custom_ai_action_id`) | ✅ Xong — `.plan/next5/D0-result.md`. Kết luận: **2/5 mục dùng được ngay**, 3 mục thiếu drill id, 1 mục cần đổi contract. `custom_ai_action_id` **đã có `search_index=1`** trên 9 doctype ⇒ **D0.7 không cần làm**. **Default warehouse mâu thuẫn** (`Stock Settings` = `Stores - S` **thuộc SANLOAN**) ⇒ D2 cần pin tường minh, **chờ user quyết** |
| **D0.5** — REAL-only audit (grep mở rộng + provenance/state + error≠empty + authz) | ✅ **PASS** — `.plan/next5/D0.5-result.md`. Lần audit đầu **FAIL** (1 vi phạm: `MOCK`/unknown vẫn render tiền), user chốt **(A) ẩn số**, đã sửa + verify thật |
| 3 màn tiền nay có **cổng provenance dùng chung** (`core/widgets/data_provenance.dart`) | ✅ `MOCK`/`null` ⇒ panel **THAY** số (không dán nhãn trên số) |
| Server mang `erp_target` tới `/read/drill` + `/read/list` (cùng biểu thức với `/read/daily-summary`) | ✅ `drill-views.mjs` · `read-views.mjs` · `http-ask.mjs`; mặc định `null` ⇒ **field luôn có mặt** |
| **Verify trên site THẬT** | ✅ `/read/drill` → `erp_target "REAL"` · `/read/list` → `"REAL"` · process **MOCK** → `"MOCK"` cho phần phục vụ được, phần không phục vụ được trả **503/404** (không bịa số) ⇒ **"ERP fail → MOCK success" KHÔNG xảy ra** |
| Số đo | ✅ Flutter **315/315** (+5 ca) · analyze **0** · Node full **807/805/2** (2 fail `dshGateway*` từ B0) |
| Còn lại (KHÔNG phải điều kiện cổng, thuộc D1) | ⏳ fixture **chưa hỗ trợ `>`** ⇒ "Nợ quá hạn" không test được bằng mock · `/read/drill` chưa hiện mốc thời gian · 403 chưa có câu riêng · authz chưa có dữ liệu quyền để test negative |
| Commit | ⏳ **Chưa** — diff gộp chung với đợt A3 đang chờ user duyệt |

Lệnh mở cổng: `drawer-plan-final.md` §7 — D0.5 **PASS ⇒ được phép sang D1**. Tên change OpenSpec (nếu tạo) phải **không bắt đầu bằng số**.

### D0.7 — index `custom_ai_action_id` (PE/SO/PO) — ✅ **SKIP — index đã đủ** (2026-09-25)

| Mốc | Trạng thái |
|---|---|
| Meta tươi hôm nay (probe chỉ-đọc) | ✅ `search_index=1 · unique=1 · Data` trên **cả 3** doctype (PE/SO/PO) + `custom_business_doc_key` trên PO; `DocField` = 0 dòng ⇒ đúng là Custom Field do migration tạo |
| Idempotence migration đo được | ✅ `--plan-only` (10 cặp, exit 0) · `--dry-run` ("ĐÃ CÓ" cả 10, "không cần làm gì", exit 0) ⇒ không chạy chế độ ghi thật vì không có gì thiếu |
| Bằng chứng | `.plan/next5/D0.7-result.md` + probe `.plan/next5/d07-index-probe.py` (chỉ GET, host không secret) |
| Giới hạn | Meta-level, **chưa** đo EXPLAIN (cần quyền DB — ngoài phạm vi); `unique=1` ⇒ dedupe D3 phải định nghĩa canonical theo doctype |

### D1 — Công nợ (lối tắt) + Nợ quá hạn / Nợ lâu — ✅ **ĐẠT, 2 mục ĐÃ BẬT** (2026-09-25)

| Mốc | Trạng thái |
|---|---|
| Contract + 2 drill id mới | ✅ `receivable_customers` · `overdue_top` (validate READ-only sẵn có phủ) |
| Số = GL raw, **KHÔNG trừ Draft PE** (§9) | ✅ node test fixture có nháp PE mà số không đổi + **verify thật**: site có **13 nháp PE (162.092.570đ)** mà drawer vẫn = REST GL (461.505.625đ) |
| Footnote verbatim §3.1 | ✅ server gửi, client chỉ render; vắng mặt khi server không gửi |
| Hint nháp (optional, dòng phụ) | ✅ `{count, amount}` company-wide; **không** khớp allocation (P9-D giữ effective trên chat); đọc lỗi ⇒ vắng mặt, không 0 giả |
| Sort `days_overdue` DESC | ✅ node fixture khách nợ 40 ngày đứng trước khách nợ 20 triệu; verify thật khớp oldest REST từng khách |
| Fresh GET mỗi lần mở | ✅ đo: 2 lần gọi → 2 `generated_at` khác nhau |
| Verify ERPNext thật | ✅ drawer == REST **từng khách (top-10 trang đầu đúng luật sort) + tổng + overdue + oldest**; truncated trung thực (10/47) |
| Số đo | ✅ Node **810/808/2** (2 fail dsh từ B0) · `p44` **15/15** · Flutter **318/318** · analyze **0** · falsify drill **20/20 RED** |
| Commit | ⏳ **Chưa** — diff gộp A3 + D0.5 + D1 chờ user duyệt |

Bằng chứng: `.plan/next5/D1-result.md` + probe `.plan/next5/d1-verify-real.py` (chỉ đọc).

### D1.5 — Negative permission test — ✅ **ĐẠT (capability-level) + NO-GO môi trường (row-level)** (2026-09-25)

| Mốc | Trạng thái |
|---|---|
| Permission check TRƯỚC mọi ERP read | ✅ test E2E mới `test/d15-drawer-negative-authz.test.mjs` (temp contract + own process): denied ⇒ **403 `AUTHORIZATION_DENIED`, 0 rows/0 figures** trên cả 3 view (receivable_customers · overdue_top · unpaid_invoices) |
| Cặp chứng cứ 403/503 | ✅ cùng env rigged: denied 403 (read chưa chạy) vs allowed 503 ⇒ 403 là do **quyền** |
| Control | ✅ allowed nhận đủ list fixture (2/2 khách, 2/2 HĐ) — không ai rớt do tai nạn đường đọc |
| “User không được Customer X ⇒ không thấy X” | ⛔ **NO-GO môi trường** — site **không có User Permission** (probe: 0 rows) + kiến trúc **1 API key chung** ⇒ không có danh tính end-user tới tầng ERP; ghi NO-GO + hướng test sau (per-user credential), **không fake PASS** |
| Không bypass bằng report SQL | ✅ drawer chỉ đọc `erpnext_doc_list` (whitelisted) — không có SQL report tool trên đường |

Bằng chứng: `.plan/next5/D1.5-result.md` + `mcp-erpnext/test/d15-drawer-negative-authz.test.mjs`.

### D1c — HĐ chưa trả (`unpaid_invoices`) — ✅ **ĐẠT, mục drawer ĐÃ BẬT** (2026-09-25)

| Mốc | Trạng thái |
|---|---|
| CHỈ SI `docstatus=1 & outstanding>0`, MỌI NGÀY (§3.2) | ✅ dùng lại `companyDebtRows()` (anti-drift với block `receivables`); `outstanding>0` loại credit note |
| Không “PE-able” abstraction | ✅ mỗi dòng `kind=unpaid_invoice` = 1 chứng từ |
| Row = mã HĐ · khách · còn nợ · due_date; sort outstanding DESC | ✅ test pin sort + tiebreak due_date ASC |
| Error ≠ empty | ✅ SI đọc lỗi ⇒ refusal `ERP_UNAVAILABLE` (không list rỗng) |
| Verify ERPNext thật | ✅ `.plan/next5/d1c-verify-real.py`: 283 HĐ/461.505.625đ khớp REST **từng dòng** (trang 10/283 `truncated=true`), 13 nháp PE **không** bị trừ, fresh read OK |

Bằng chứng: `.plan/next5/D1c-result.md` + probe `.plan/next5/d1c-verify-real.py`.

### D2 — Tồn kho nóng (`stock_low`) — ✅ **ĐẠT, mục drawer ĐÃ BẬT** (2026-09-25)

| Mốc | Trạng thái |
|---|---|
| Nguồn kho | ✅ **user chốt**: pin `COPILOT_DEFAULT_WAREHOUSE="Kho Cám - MP"` trong `.env` (D0 đo 3 settings mâu thuẫn, 1 cái trỏ kho **SANLOAN**); probe đối chiếu `Feed Dealer Settings.default_warehouse` = **KHỚP** |
| Thiếu kho ⇒ config error (**CẤM `warehouses[0]`**) | ✅ `STOCK_WAREHOUSE_UNPINNED` (mã riêng, không gộp vào `ERP_UNAVAILABLE`) + câu hướng dẫn `.env`/Desk |
| Số là SỐ LƯỢNG, không phải tiền | ✅ row `kind=stock_low_item` render **unit-less** (test chặn mọi figure dạng `\d…đ$`) |
| Header “Tồn thấp — Kho: {tên}” + Top N sort qty tăng | ✅ server gửi tên kho trên header + mỗi dòng note = kho |
| Verify ERPNext thật | ✅ `.plan/next5/d2-verify-real.py`: kho tồn tại/lá/đúng company, REST Bin 3 dòng–tổng 833 **khớp từng dòng**, sort đúng, fresh read OK |

Bằng chứng: `.plan/next5/D2-result.md` + probe `.plan/next5/d2-verify-real.py`.

### D3 — Nháp hôm nay (aggregate + partial + dedupe server) — ✅ **ĐẠT, mục drawer ĐÃ BẬT — 5/5 mục drawer hết `soon`** (2026-09-26)

| Mốc | Trạng thái |
|---|---|
| MỘT aggregate; Flutter không tự gọi/merge/dedupe | ✅ `GET|POST /read/app-drafts` là **alias** của drill `app_drafts_today` (cùng code path, id pin trong route — test so payload bằng nhau) |
| Filter `custom_ai_action_id is set` + `docstatus=0` + ngày shop (server tính) | ✅ giữ đúng 4 doctype của block `app_drafts` (SO/Quotation/PO/PE = MVP §3.4 + Quotation, để list cộng đúng số) |
| 1 doctype fail ⇒ `partial:true` + sections status, vẫn trả items OK | ✅ test: knot `MOCK_ERP_FAIL_LIST_DOCTYPE`; thiếu field ⇒ section `FIELD_MISSING` (skip + log, **không** 500 cả màn) |
| **0 section đọc được ⇒ 503** (không “partial rỗng”) | ✅ **bug thật phát hiện lúc tunnel site đứt** rồi sửa + test + 1 ca falsify (§2.2: unreachable ⇒ Error) |
| Dedupe server | ✅ canonical = chứng từ **sớm nhất** của action (trùng ngày ⇒ tên ASC), `duplicates_dropped` đếm; client không chọn |
| Empty actionable | ✅ câu rỗng thêm gợi ý nói trong chat + bấm xác nhận (§5) |
| Partial banner (loadedPartial) | ✅ `drill-partial-banner` nêu tên section chết |
| Verify ERPNext thật | ✅ `.plan/next5/d3-verify-real.py`: REST PO 4 nháp app-tagged; `?date=25/09` ⇒ **3 dòng khớp REST từng dòng**, sections 4/4, fresh read OK. (Site không có action id trùng xuyên doctype ⇒ dedupe chỉ chứng minh bằng unit test — **không** nói là đã kiểm thật) |
| Số đo | ✅ Node **818/816/2** (2 fail dsh từ B0) · `p44` **22/22** · Flutter **323/323** · analyze **0** · falsify drill **31 ca ALL RED** |
| Commit | ⏳ **Chưa** — diff gộp A3 + D0.5 + D1 + D1.5 + D1c + D2 + D3 + D4 + D5 chờ user duyệt |

Bằng chứng: `.plan/next5/D3-result.md` + probe `.plan/next5/d3-verify-real.py`.

### D4 — Polish drawer — ✅ **ĐẠT, 6/6 mục** (2026-09-26)

| Mốc | Trạng thái |
|---|---|
| Pull-to-refresh chạy cả list ngắn | ✅ **bug thật sửa**: `RefreshIndicator` im lặng trên ListView vừa khung ⇒ `AlwaysScrollableScrollPhysics()`; test dùng stepped drag |
| Tiêu đề drill phản ánh ngày thực đọc (server-side) | ✅ 3 drill ngày `day_scoped: true` + title ngày-trung-tính trong contract; `validateDrillScreens` chặn title có chữ ngày khi day_scoped; `drillDayWord` (hôm nay/hôm qua/ngày YYYY-MM-DD); đồng hồ của server, drill toàn công ty giữ nguyên title |
| Clear cache khi đổi server/user | ✅ Settings xoá cache ngày + invalidate khi đổi URL/user (đổi setting khác KHÔNG xoá — test riêng); màn summary đang mở `ref.listen` client ⇒ đọc lại |
| Empty state actionable | ✅ đã có từ D1–D3 (không cần thêm) |
| Badge nháp optional fail-safe | ✅ `draftsBadge` nullable — chỉ vẽ khi > 0; feed từ summary đã đọc; drawer không gọi request nào |
| Hard timeout 7s (§2.4) | ✅ `AppConstants.readTimeout` + `Future.timeout` trên cả 3 read method (KHÔNG dùng Dio receiveTimeout) ⇒ `CopilotTimeoutException` một hành vi [Thử lại] |
| Verify ERPNext thật | ✅ `.plan/next5/d4-verify-real.py`: 7/7 tiêu đề đúng ngày (3 drill ngày + 2 toàn công ty giữ nguyên); rows 25/09 khớp REST từng mã (4 HĐ · 1.125.000); độ trễ 0,90–1,33s < 7s; fresh read |
| Số đo | ✅ Node **820/818/2** (2 fail dsh từ B0) · `p44` **23/23** · authz **1/1** (assert title đổi luật có chủ ý) · Flutter **333/333** · analyze **0** · falsify drill **37 ca ALL RED** |
| Phát hiện NGOÀI scope | ✅ **ĐÃ SỬA** 2026-09-26 (user chốt hướng A): commit `ed79f77` — thẻ HĐ/Tiền khách trả xem "Hôm qua" nay hiện ĐÚNG số hôm qua; `_DayNotRead` fail-closed; xoá dòng delta. Xem mục "PHIÊN 2026-09-26" đầu file |
| Commit | ⏳ **Chưa** — diff gộp chờ user duyệt |

Bằng chứng: `.plan/next5/D4-result.md` + probe `.plan/next5/d4-verify-real.py`.

### D5 — Docs + đóng next5 — ✅ **ĐẠT — next5 ĐÓNG** (2026-09-26)

| Mốc | Trạng thái |
|---|---|
| features.md mục Drawer | ✅ tiêu đề mục + block next5: 5 entry (từng entry có drill id), REAL-only/provenance, **footnote công nợ verbatim**, polish D4, verify thật, số đo |
| how-to-test.md | ✅ **tạo mới** `docs/how-to-test.md` — checklist tay: mở từng mục drawer + số khớp ERPNext, title ngày, refresh, error/empty/config, đổi server/user, badge, ranh giới CẤM |
| next5-drawer-done.md | ✅ `.plan/next5/next5-drawer-done.md` — đối chiếu §8 exit criteria **10/10 ĐẠT** từng dòng + bằng chứng; khai thẳng NO-GO row-level (D1.5) + dedupe D3 chỉ unit test |
| README next5 | ✅ trỏ DONE + bảng kết quả từng phase |
| Không code feature mới | ✅ chỉ docs; CẤM aging buckets/activity log giữ nguyên |

Bằng chứng: `.plan/next5/next5-drawer-done.md` + `docs/how-to-test.md`. ✅ **ĐÃ COMMIT `17d6f9b`** (2026-09-26, toàn bộ next5 gộp 1 commit, chưa push).

## next4/P9-D — phiếu thu/chi NHÁP phủ bớt nợ (2026-09-25) — ✅ ĐÃ COMMIT `f82f656` (user duyệt riêng vùng SỐ TIỀN, **KHÔNG push**)

| Mốc | Trạng thái |
|---|---|
| **Đo lỗi TRƯỚC khi sửa** | ✅ Nháp `PE-M901` 1.000.000 phủ SINV-0001 ⇒ `/ask` "thu … 2 triệu" **2 lần** đều đề xuất **2.500.000** ⇒ xác nhận lần hai = **2 nháp cùng trả 1 khoản nợ** |
| Builder đọc phiếu nháp (`docstatus 0`, limit 10) + `references[]` ⇒ trừ phần đã phủ | ✅ `effective_outstanding`; giữ GL RAW cạnh đó (`raw_outstanding_vnd`/`draft_cover_vnd`/`draft_cover_docs`) |
| Cảnh báo nêu **tên nháp** + tên hoá đơn + GL khi hai số khác nhau | ✅ Xong |
| Phủ hết/phủ quá ⇒ `PAYMENT_DRAFT_COVERED` (nêu tên nháp để biết đi submit/hủy **phiếu nào**) | ✅ Xong |
| Executor **đọc lại cùng phép tính** lúc xác nhận (nháp đổi ở giữa ⇒ `PROPOSAL_STALE`) | ✅ Xong — `detectDrift` so trên giá trị HIỆU DỤNG |
| Trần cứng `requested > liveEffective` ⇒ `PAYMENT_AMOUNT_EXCEEDS_REMAINDER` trước `setReference` | ✅ Xong |
| Chỉ thêm **2 đường ĐỌC** · không auto-submit · không đổi hướng Pay/Receive · không chạm XML/M1/A3 | ✅ Xong |
| Đọc lỗi ⇒ TỪ CHỐI (`PAYMENT_ERP_UNAVAILABLE`) · bag thiếu read ⇒ `PAYMENT_SKILLS_INCOMPLETE` | ✅ Xong (không đội lốt "ERP chết") |
| Test + falsify | ✅ 6 file test **131/131** · falsify **12/12 RED** (+2 ca MỚI K/L) · Node full **793/791/2** |
| **1 lỗi của chính AI do suite bắt** | ✅ Guard "phủ hết" viết `<= 0` nuốt luôn credit note ÂM ⇒ siết thành `<= 0 && drawnForTarget > 0` + ca hồi quy |
| 4 test cũ phải sửa (vì hành vi mới là ĐÚNG) | ✅ `p8`×2 + `p10`×2 dùng lại cùng proposal/khoản nợ; đổi sang khoản nợ riêng, **giữ nguyên mọi khẳng định cũ** |
| Vòng smoke sau commit (mock, pipeline thật, hỏi 2 lần, **không submit**) | ✅ 2.500.000 → **1.500.000**, ổn định 2 lần; số nháp trong state vẫn **1** |
| Nháp THẬT trên ERPNext | ❌ **Chờ user cho phép** (GHI thật, dù chỉ nháp) |
| Giới hạn CHƯA đo | Race hai phiên cùng bấm (ERPNext là chốt cuối khi submit) · trần 10 nháp áp cho cả hai hướng |

Bằng chứng: `.plan/next4/P9D-result.md` (§11 = vòng smoke sau commit).

## next4/A3-Flutter — nút HĐĐT nhận luôn `.pdf` (2026-09-25) — ✅ ĐÃ COMMIT `8a692f1`

| Mốc | Trạng thái |
|---|---|
| Picker nhận `.xml` **và** `.pdf`, chọn theo ĐÚNG thứ người dùng chọn (không đoán, không fallback) | ✅ Xong |
| `.xml` → `{xml, kind}` · `.pdf` → `{pdf_base64, kind}` (base64 do chính class lo) | ✅ Xong — XOR do server chốt (`EINVOICE_INPUT_AMBIGUOUS`) |
| Client **KHÔNG** parse: 2 tripwire tĩnh quét `lib/` chặn `package:xml` VÀ `package:pdf` | ✅ Có, đã kiểm sống |
| PDF scan ⇒ 422 `EINVOICE_PDF_NO_TEXT` → hiện câu tiếng Việt của server (đã trỏ nút camera) | ✅ Xong |
| Trần dung lượng client khớp policy (XML 950 KB · PDF 650 KB — **không** cùng một số) | ✅ Xong |
| Test | ✅ `chat_einvoice_xml_test.dart` 20 test · Flutter **310/310** · analyze **0** |
| UI-checkpoint (chụp màn hình cho user duyệt) | ❌ **Chưa chụp** — thay đổi UI |

Bằng chứng: `.plan/next4/flutter-pdf-picker-result.md` (khép giới hạn #4 của A-result §6).

## next4/B — VÒNG XML THẬT 2 LẦN CÙNG FILE — ✅ CHẠY THẬT ĐẠT (2026-09-25, user cho phép ghi)

| Việc | Kết quả |
|---|---|
| Lần 1 (cùng file `tt78-basic.xml`) | ✅ `/execute` **200** ⇒ nháp **`PUR-ORD-2026-00007`** |
| Lần 2 (ĐÚNG file đó) | ✅ **409 `PO_DUPLICATE_DOC`** + `existing_doc=PUR-ORD-2026-00007` + câu tiếng Việt nêu tên đơn cũ |
| Đếm PO độc lập (REST, không qua copilot) | ✅ **6 → 7 = TĂNG ĐÚNG 1** |
| Kiểm chứng bản ghi | ✅ docstatus **0 (nháp)**, đúng company/supplier, `custom_business_doc_key=bdk_ca5eaafe…` **chỉ 1 đơn mang khoá này**, tổng **4.175.000 VND** với rate từ ERPNext |
| ⚠️ Phát hiện deployment | **THIẾU `COPILOT_COMPANY`** ⇒ `/execute` 500 `PO_COMPANY_UNRESOLVED` (site có 3 company; app không gửi company). ✅ **ĐÃ THÊM vào `.env` + VERIFY CHỈ-ĐỌC** (probe `.plan/next4/probe-company-pin.mjs`): gateway cấp `company="Minh Phát Cám & VLXD"` (`enforced=true`) · executor resolve đúng company đó trên site thật · chạy lại đường [Xác nhận] ⇒ **409 `PO_DUPLICATE_DOC` thay vì 500**, đếm PO 7→7 (**không ghi gì**). ⚠️ **Còn bước vận hành**: server đang phục vụ app không chạy ở máy này (APK trỏ `erpn8788.loca.lt`) ⇒ phải thêm biến đó vào môi trường **server đó** + **restart** thì app mới hết 500 |
| ✅ **Chứng minh đường [Xác nhận] (result73, 2026-09-25)** | Đã **restart stack thật** với env từ `.env` (NLP `:8787` + gateway `--host 10.88.0.4 :8788`, auth **thật**: `/health` không auth **401**, có auth **200**). Gửi **file XML MỚI** `C26TYY/0000128` ⇒ `/execute` **200**, tạo **NHÁP `PUR-ORD-2026-00008`** (**hết 500**), đếm PO **7 → 8 = +1**; REST độc lập: docstatus **0**, company `Minh Phát Cám & VLXD`, items `CAM-GA-25KG×12@270.000` = **3.240.000đ**, khoá `bdk_68055489…` **chỉ 1 đơn**. ⚠️ `erpn8788.loca.lt` → **503**, `lt` chưa cài ở máy này ⇒ **máy phục vụ app vẫn phải restart** |
| ❌ **RETEST QUA TUNNEL (đường app thật) — VẪN 500** | User đã restart server đầu kia ⇒ tunnel **sống lại** (`erpn8788.loca.lt/health` không auth **401**, có auth **200**; server đó bind non-loopback + auth). Gửi file MỚI `C26TYY/0000130`: `/input/einvoice` **200** → `/ask` **200** → **`/execute` 500 `PO_COMPANY_UNRESOLVED`** với nguyên văn *"có 3 company (DEMO POC CO, Minh Phát Cám & VLXD, SANLOAN) và chưa pin company — đặt COPILOT_COMPANY trước khi tạo đơn mua"*; đếm PO **9 → 9 (không ghi gì**, fail-closed đúng). ⇒ **Môi trường của MÁY ĐÓ vẫn thiếu `COPILOT_COMPANY`** — không phải lỗi code (stack local cùng code + `.env` này tạo nháp **200**). Việc cần làm: thêm biến vào môi trường process gateway **ở máy đó** rồi restart |
| ⚠️ **Phát hiện phụ (trước build APK sau)** | Repo **HIỆN KHÔNG có GitHub Variables/Secrets nào** (API 200, danh sách rỗng; token còn sống). Workflow luôn truyền `--dart-define=COPILOT_BASE_URL="${VAR}"` **kể cả khi trống**, và đo Dart cho thấy **define rỗng ⇒ `''`, KHÔNG rơi về default** ⇒ APK build từ trạng thái repo hiện tại sẽ **không có endpoint** cho tới khi nhập ở ⚙️ Settings. Cần đặt lại `COPILOT_BASE_URL` + `COPILOT_AUTH_USER`/`COPILOT_AUTH_PASSWORD` |
| Giới hạn đo được | `PUR-ORD-2026-00006` (CÙNG tờ, tạo TRƯỚC migration) có key `null` ⇒ không được dedupe; race 2 phiên chưa đo; `transaction_date` nháp = **ngày hôm nay** (2026-09-25), không phải `NLap` trong file |
| Commit | ➖ Không có gì để commit (script trong `.plan/`); nháp 00007 còn trên site, **không tự huỷ** |

Bằng chứng: `result72.txt` + `.plan/next4/B-dedupe-result.md` **§10** + script `.plan/next4/loop-xml-dedupe-real.mjs`.

## next4/A3 — review vòng 2 (tìm lỗ hổng) — ✅ H1/M1/M2 **ĐÃ SỬA + TEST + FALSIFY** (2026-09-25), chờ user duyệt commit

| Phát hiện | Mức | Trạng thái |
|---|---|---|
| `LABELS.invoiceNo` có nhánh `so` trần ⇒ khớp "mã **số** thuế"/"in **số** bản" ⇒ `invoice_no = "thu"`/`"b"` mà `complete = true` ⇒ định danh rác vào chứng từ **và** khoá chống trùng của B | **High** | ✅ **ĐÃ SỬA** — `NON_INVOICE_NO_CONTEXT` + bắt buộc có chữ số + `wholeLineToken` cho dòng-dưới-nhãn. Đo lại: `"thu"`/`"b"` → `"0000049"`; **và 3 ca RÁC NỮA do probe tự tìm thấy** trên chính bản fix đầu: `["Số hoá đơn:","Mã số thuế: …"]`→`"M"`, `["Số hoá đơn:","Số lượng: 2"]`→`"S"`, `["Số hoá đơn:", <dòng bảng>]`→`"1"` — nay đều `null` + `MISSING_INVOICE_NO` |
| `inflateSync` KHÔNG có trần đầu ra (đo 106.884 → **31.457.284 byte**, 294×, RSS +541 MB) | Medium | ✅ **ĐÃ SỬA** — `maxOutputLength` + mã riêng `EINVOICE_PDF_INFLATED_TOO_LARGE` (413) + `max_inflated_bytes: 8000000`; A/B cùng 1 file: **57 ms/RSS +49,1 MB ⇒ 19 ms/RSS +8,5 MB**; + 2 guard tầng contract (mutation chứng minh sống) |
| `readDate` lấy ngày dạng số ĐẦU TIÊN không nhãn ⇒ sai `invoice_date` ⇒ sai khoá chống trùng | Medium | ✅ **ĐÃ SỬA** — chặn theo DÒNG + ưu tiên nhãn + chỉ nhận ngày không nhãn khi tài liệu có ĐÚNG MỘT. Đo lại: `"Ngày đặt hàng 01/09"` trên `"Ngày 20/09"` → **2026-09-20**; footer-only → `null` |
| 4 ca Low | Low | ✅ **CẢ 4 ĐÃ XỬ LÝ**: L2 sửa (nhánh `ngày…tháng…năm` duyệt xuôi + `index` thay `indexOf`) · lỗi số trong doc §9.1 sửa · **L1** cap dòng nay chạy KHI DỰNG (`EINVOICE_PDF_TOO_MANY_LINES`, 413, trần `max_lines × 100`) · **L3** guard sync/pure nay áp cho **MỌI** module `src/einvoice` |
| 10 ca đo và **KHÔNG phải bug** | — | ✅ Đã đo (bfrange có trần · no-text bomb · truncated · 260 dòng ⇒ `LINE_LIMIT` giữ đúng 200 · dòng âm · control chars · `29/02/2028` ok vs `31/02` null · block "Người bán:" rỗng · dòng không parse được) |
| Bộ đọc A3 sửa hay không | — | ✅ **User duyệt "sửa đi"** (2026-09-25) ⇒ đã sửa cả 3 |

**Số đo**: `a3` **29/29** (trước 15) · `a1`+`a2`+`a3` **54/54** · Node full **807/805/2** (2 fail dsh-env từ B0) · falsify `scripts/falsify/a3-einvoice-pdf.mjs` **12/12 RED** (gồm ca L cho L1 + M cho L3) · probe §9.5 **10/10 ok**. **1 case falsify bị GỠ** vì chạy GREEN (đã có guard khác phủ) — ghi ở §9.6.5.

Bằng chứng: `.plan/next4/A3-result.md` §9.1 (đính chính) + **§9.5** (báo cáo review) + **§9.6** (bản sửa + số đo) · probe `.plan/next4/probe-a3-review.mjs`. **Chưa commit** — vùng định danh + trần an toàn.

## next4/bài học lỗi → skill (2026-09-25) — ✅ ĐÃ LƯU

| Nhóm | Nơi | Nội dung |
|---|---|---|
| ERPNext portable | `.agents/skills/erpnext-rest-api-core` §6 (+3 bullet) | nháp `docstatus=0` không giảm GL · Link field + mock dễ dãi hơn site · `limit_page_length: 0` = không giới hạn |
| Bẫy của project | `.agents/skills/erpn-verify-first` (+5 dòng) | test dùng lại proposal/khoản nợ · widget tự POST bỏ settings ⇒ 401 · guard theo HỆ QUẢ · snapshot suy-ra vs raw drift · substring lần 3 |
| Parse file người lạ | `.agents/skills/untrusted-file-parsing` — **skill MỚI** | trần OUTPUT khi inflate · regex nhãn nhánh trần · không lấy giá trị ĐẦU TIÊN |
| Cross-project (Simplenote) | — | ⚠️ Simplenote MCP **không khả dụng** phiên này ⇒ chưa ghi được |

## next4/B-dedupe — Cùng MỘT tờ HĐ gửi 2 lần ⇒ MỘT nháp (2026-09-25) — ✅ MIGRATION ĐÃ VERIFY, **ĐÃ COMMIT `7ca1409`**

| Mốc | Trạng thái |
|---|---|
| Định nghĩa `business_doc_key` ổn định (kind + party MST/id + số HĐ + ngày) | ✅ Xong — `src/business-doc-key.mjs`, kind lấy từ **contract** không lấy nhãn client |
| Định danh đi **ngoài câu nói** (`source_document` trên `/ask`, validate fail-closed 2 đầu) | ✅ Xong — vì A-result đã đo NLP đọc `00049` thành **49đ** |
| Tra trùng trước execute → **409 + `existing_doc`** (tên đơn cũ) | ✅ Xong — `PO_DUPLICATE_DOC`; probe **trước** cả correlation probe, chưa ghi gì |
| Giữ nguyên `command_id`/`custom_ai_action_id` (chống double-tap lệnh) | ✅ Xong — lớp **thêm**, không thay; intent lock = chính khóa tài liệu khi có |
| KHÔNG chặn mua nhiều lần với **số HĐ khác** (kể cả cùng NCC/cùng dòng hàng) | ✅ Có test (3 tờ khác nhau ⇒ 3 nháp) + câu nói thường vẫn 2 nháp |
| Site **thiếu cột** ⇒ TỪ CHỐI, không ghi (`PO_DOC_KEY_FIELD_MISSING`), đơn mua thường vẫn chạy | ✅ Xong (500 — site misconfig, cùng họ `*_CORRELATION_FIELD_MISSING`) |
| Test: 2 execute cùng key ⇒ 1 doc · khác key ⇒ 2 doc · verify đọc lại | ✅ `test/b-dedupe.test.mjs` **10/10** · Node full **765/763/2** (2 fail dsh-env từ B0) |
| Falsify: bỏ check ⇒ 2 doc (+ 7 ca nữa, gồm 2 ca Dart) | ✅ **8/8 RED**, restore byte-identical; M1 vẫn 16/16 |
| App gửi định danh kèm `/ask` (fail-closed ở client) | ✅ Flutter **304/304** (+5) · analyze **0** |
| Migration `custom_business_doc_key` trên Purchase Order (site thật) | ✅ **ĐÃ CHẠY + VERIFY 2026-09-25** — tạo ⇒ `VERIFIED type=Data unique=1 search_index=1`; chạy lại ⇒ **no-op**; kiểm chứng độc lập bằng REST thấy cột trong meta; probe chỉ-đọc ⇒ `field_unavailable:false` ⇒ **gate đã mở** |
| Vòng XML THẬT 2 lần cùng file | ❌ **Chờ user cho phép** (tạo 1 nháp thật) — kịch bản + kỳ vọng ở deliverable §7 |
| Commit | ✅ **ĐÃ COMMIT `7ca1409`** (2026-09-25) |
| Giới hạn đã ghi rõ | Đường BÁN chưa có lớp này · kênh ẢNH chưa phát định danh (`/ocr/slots` không dựng `source_document`) · đơn đã HỦY vẫn giữ khóa (`unique=1`) · race thật chưa đo |

Bằng chứng: `.plan/next4/B-dedupe-result.md` + `result68.txt`.

## next4/A2-Flutter — Upload HĐĐT XML trong app (2026-09-25) — ✅ ĐÃ COMMIT `8a692f1`

| Mốc | Trạng thái |
|---|---|
| Nút **"HĐĐT XML" cạnh camera** ở CẢ 2 layout input bar | ✅ Xong |
| Chọn file `.xml` → `POST /input/einvoice` (JSON `{xml, kind:"purchase"}` — đúng shape route) | ✅ Xong (`file_selector`, user duyệt cùng ngày) |
| Form slots **dùng lại của camera** (`OcrSlots` + `showOcrSlotsForm`, chỉ đổi wording `OcrSlotsSource`) | ✅ Xong |
| Lỗi tiếng Việt: lời server nguyên văn + câu riêng của app + warning thiếu NCC **nêu MST** | ✅ Xong |
| Không đường ghi mới · không auto-execute · không auto-create master · **không parser XML thứ hai** | ✅ Có **tripwire tĩnh** quét `lib/**.dart`, đã kiểm SỐNG |
| Widget/integration test (mock HTTP) | ✅ `chat_einvoice_xml_test.dart` **18 test** (gồm test cho **cả 2 layout**, đã đột biến 2 chiều RED) |
| `flutter analyze` + full suite | ✅ **0 issue** · **310/310** (baseline 281; +18 kênh XML, +6 kênh PDF/thẻ tạo khách; 0 regression) |
| E2E ERPNext THẬT cho kênh này | ➖ Không bắt buộc (server đã cover `PUR-ORD-2026-00006`); chạy lại sẽ **tạo thêm 1 nháp thật** ⇒ cần user cho phép |
| Test tay trên máy Android thật | ❌ Cần APK + điện thoại (quy trình 9 bước ở deliverable §6) |
| Commit | ✅ **ĐÃ COMMIT `8a692f1`** (2026-09-25) |

Bằng chứng: `.plan/next4/flutter-xml-upload-result.md` + `result67.txt`.

## next3/A3 — HĐĐT **PDF có lớp chữ** → cùng slots → cùng pipeline nháp (2026-09-25) — ✅ ĐÃ COMMIT `7ca1409` (+ nút `.pdf` phía Flutter ở `8a692f1`)

| Mốc | Trạng thái |
|---|---|
| PDF text-layer → cùng schema `slots` (không route mới, không pipeline thứ hai) | ✅ Xong — `/input/einvoice` nhận `pdf_base64`, cùng shape `parsed` như XML |
| Bộ đọc PDF thuần/đồng bộ, **0 dependency** (FlateDecode = stdlib `zlib`) | ✅ `src/einvoice/einvoice-pdf.mjs` (~1148 dòng) — có **test tĩnh** cấm mọi bề mặt ghi (`callTool`/`skills`/`docstatus`/`fs`) |
| Dấu tiếng Việt từ font CID/Type0 | ✅ Qua **ToUnicode CMap** (bfchar + bfrange) — không có CMap ⇒ `TEXT_UNMAPPED` |
| Ngắt dòng theo **vị trí**, không theo thứ tự toán tử | ✅ `PDF_SPACE_GAP=-250` (kerning −150 cắt đôi từ ⇒ sửa) |
| Số học: `.` nghìn / `,` thập phân (**KHÁC A1**) | ✅ `pdfNumberReadings` trả **mọi cách đọc**; **số học của dòng phân xử**; không phân xử được ⇒ **problem ⇒ TỪ CHỐI** |
| Từ chối **theo tên** (không bịa số) | ✅ `NOT_A_PDF · TOO_LARGE · ENCRYPTED · NO_TEXT · COMPRESSED_OBJECTS · TEXT_UNMAPPED · UNSUPPORTED_FILTER · BROKEN` + warning `MST_UNLABELLED · UNIT_GUESSED_FROM_TEXT` |
| Gửi CẢ `xml` và `pdf_base64` ⇒ 400, **không** chạy pipeline | ✅ `EINVOICE_INPUT_AMBIGUOUS` |
| Contract fail-closed (`max_pdf_bytes 650000` · `pdf_reader "text_layer_only"` · `comment_pdf`) | ✅ Xong — contract đọc không được ⇒ `CAPABILITY_CONTRACT_UNREADABLE` |
| Fixture: mỗi cấu trúc PDF một file (dựng byte-by-byte, idempotent) | ✅ 6 file: tounicode · winansi · nomap · no-textlayer · encrypted · objstm |
| Test: contract · fixture tự-đúng · CID↔WinAnsi cùng dòng · 4 từ chối theo tên · nhãn dòng-kế · người mua in trước · bẫy SĐT · số học phân xử · route happy + 7 từ chối | ✅ `test/a3-einvoice-pdf.test.mjs` **15/15** · Node full **782/780/2** (2 fail dsh-env từ B0) |
| **Đo trên site THẬT (chỉ ĐỌC — items + suppliers)** | ✅ PDF ToUnicode → **200**; `source=einvoice_pdf`; NCC resolve **theo MST** (`Đại lý Cám Bình Dương`, `ambiguous=false`); 2 dòng khớp item THẬT; `warnings=[]`; **không lộ bề mặt ghi** |
| PDF scan ⇒ TỪ CHỐI, chỉ sang **camera C** | ✅ **422 `EINVOICE_PDF_NO_TEXT`** kèm câu tiếng Việt — không bịa số |
| Không chạm B/M1 · không auto-create master · không auto-submit · không OCR trong luồng này | ✅ Giữ đúng phạm vi |
| Nút chọn `.pdf` trong app Flutter | ✅ **ĐÃ XONG** trong `8a692f1` — `einvoice_file_picker.dart` nhận `.xml` + `.pdf`, 2 tripwire chặn parser client; ⚠️ chưa chụp **UI-checkpoint** |
| Giải nén **ObjStm** (PDF 1.5+) | ❌ **Chưa làm** — hiện nhận diện + TỪ CHỐI theo tên (không báo sai là "scan") |
| Falsify riêng cho A3 | ✅ **ĐÃ LÀM** (2026-09-25) — `scripts/falsify/a3-einvoice-pdf.mjs` **10/10 RED** (A1/A2 vẫn chưa có) |
| PDF THẬT của nhà cung cấp | ❌ Không có trong repo ⇒ fixture **tự dựng** theo cấu trúc provider dùng (điểm yếu đã ghi rõ) |
| Commit | ✅ **ĐÃ COMMIT `7ca1409`** (2026-09-25) |

Bằng chứng: `.plan/next4/A3-result.md` · spike format `.plan/next4/A3-pdf-spike.md` · `result69.txt`.

## next3/M1-site (2026-09-24) — ✅ E2E THẬT ĐẠT, ĐÃ COMMIT `7ca1409`

| Mốc | Trạng thái |
|---|---|
| Bỏ hardcode "Múa" — phân loại resolve user→env→site (fail-closed) + env defaults `.env` | ✅ Xong |
| Migration `custom_ai_action_id` trên Customer (site thật) | ✅ Đã chạy (user duyệt) — `VERIFIED` |
| Pre-check đọc TOÀN BỘ master (`limit:0`, tool không có offset) | ✅ Xong (trước fix: card cho khách row 122/123 đã tồn tại) |
| **Fuzzy fix theo TỪ** (site có customer tên "A" — substring cũ chặn MỌI tên chứa chữ a) | ✅ Xong + test + falsify ca P |
| **E2E thật**: `/ask` thêm khách → `/execute` → Customer thật **"Khách Test App M1"** → hỏi công nợ OK → đếm 123→**124** | ✅ Đo được 2026-09-24 |
| Commit | ✅ **ĐÃ COMMIT `7ca1409`** (2026-09-25) |
| Checklist máy thật 28 case | ❌ Cần APK + điện thoại |

Bằng chứng: `.plan/next4/M1-site-result.md` + `result66.txt` (phần M1-site).

## next3 / M1 (2026-09-23) — ⏳ BACKEND XONG, CÒN 4 MỐC — KHÔNG ĐƯỢC BÁO "XONG"

| Mốc | Trạng thái |
|---|---|
| Contract `customer.create` + validator + tripwire migration/capability | ✅ Xong (capability-contract + correlation-migration + safety-gateway + router: 38/38 xanh) |
| Skill `customer-create.mjs` (builder 0-write, pre-check trùng, executor re-read+verify) | ✅ Xong (code có, fail-closed đọc contract) |
| Wire router + copilot-server (nhánh sớm + NO_MATCH offer) + gateway + mock không-dedupe | ✅ Xong |
| **Flutter** (form Tên*/SĐT/MST, nút [Tạo khách mới], parse `offer_create_customer`) | ❌ **0 hit** — chưa bắt đầu |
| **Test suite riêng** `test/m1-customer-create.test.mjs` | ❌ Chưa có — chỉ tripwire chung xanh |
| **Falsify** `scripts/falsify/m1-customer-create.mjs` | ❌ Chưa có |
| **`M1-result.md` + full suite + máy thật** | ❌ Chưa — checklist tay đã soạn (`.plan/next3/M1-real-device-checklist.md`) nhưng chưa chạy được |

**Đã chốt user (2026-09-23):** bề mặt ghi Customer — chọn **(a) chấp nhận Customer creatable**, sửa 7 test đỏ theo ngữ nghĩa mới (rationale: callWriteTool thô là bề mặt nội bộ server, HTTP write duy nhất là `/execute` qua gateway) — `result64.txt` §3.1.

**Cần hỏi lại user:** (1) policy §5 giữ default (tên + 1 trong SĐT/MST khuyến nghị, trùng ⇒ từ chối)? (2) có nối ERPNext THẬT để đo `custom_ai_action_id` trên Customer trước khi executor bật ghi không (site chưa chạy migration Customer thì mọi lệnh tạo bị từ chối)?

## plan5 (2026-09-22) — ✅ ĐÃ XONG P5-0 → P5-4, CHỜ USER 4 VIỆC

| | |
|---|---|
| **P5-0** điều tra 3 bug | ✅ bug #2 (auto-send) và #3 (draft dù bật nộp thật) **ĐÃ ĐÓNG** ở tầng logic — bằng chứng: `voice_input_test` (thêm 3 test biên) + `payment-write.test.mjs` 25/25. `/execute` timeout **không** tự reconcile nhưng **an toàn** nhờ `retry_same_command_id` + 4 lớp chống trùng ⇒ **không phải P0**. `.plan/result-p5-0.md` |
| **P5-1** | ✅ **KHÔNG thực thi** (tiền đề prompt sai: file nó `Depends` vào kết luận ngược lại) — nhưng tìm & sửa **bug thật**: 5 test P4-6 hard-code ngày ⇒ đỏ khi lịch sang ngày mới dù không code nào đổi. `.plan/result-p5-1.md` |
| **P5-2** phân loại lỗi submit | ✅ `submit_error_kind` (permission/period_locked/workflow/other) + `posting_date` freeze vào snapshot lúc PROPOSE, **kèm validate fail-closed** cho giá trị client gửi lên (dạng ngày + ngày có thật + cửa sổ ±1 ngày). **Vùng SỐ TIỀN — AI không tự ký duyệt.** `.plan/result-p5-2.md` (+§7/§8 review) |
| **P5-3** badge nháp/nộp | ✅ badge + gợi ý theo loại lỗi + copy setting rõ OFF/ON (storage key giữ nguyên) + glyph dòng kết quả theo cùng trạng thái. `.plan/result-p5-3.md` |
| **P5-4** voice-first | ✅ 2 layout (OFF nguyên trạng / ON mic CTA cùng vùng input bar, text field vẫn dùng được) + **Huỷ** (bỏ câu vừa nói — khác tap-to-dừng giữ transcript) + **cap 25s** + VAD vào `AppConstants`. `.plan/result-p5-4.md` |
| **P5-5** (backlog, chưa làm) | push-to-talk · noise meter · VAD dynamic theo entity · preview 500ms trước auto-send · draft aging |

**Chờ USER (không phải việc của agent):**
1. **Revoke token `ghp_…7aO`** (đã qua chat 2 lần + nằm trong `.chats/sess1.md`) rồi dán token mới vào `.env`; hoặc bật **deploy key WRITE** để bỏ hẳn PAT.
2. **Duyệt 2 layout P5-4** (mô tả ở `.plan/result-p5-4.md` §6 — không có tool chụp màn hình trong env này) trước khi coi plan5 xong.
3. **Test tay trên máy Android thật**: auto-send có tự gửi không (phân biệt "chữ không hiện" = tầng engine/quyền mic ≠ "chữ hiện mà không gửi" = OEM không bắn final).
4. **Duyệt commit** hàng chờ — nhưng lưu ý: P5 đã **push + CI xanh** (commit `53e1851`, run `35688782230`, APK 81.4 MB).

**Việc của agent còn treo:** `docs/plan4-mode-map.md` (P4-0) chưa tạo · P4-3/P4-4/P4-5/P4-6 chưa ghi `result*.txt` riêng (bằng chứng nằm trong `.plan/result-p4-*.txt` — `.plan/` bị gitignore).

**Cập nhật hạ tầng 2026-09-22:** `.gitignore` chặn thêm `.chats/.review/.gemini/.opencode/initp` (đã bắt được **token GitHub thật** trong `.chats/sess1.md` + 8 transcript chat trong `.review/` trước khi chúng lên GitHub) · `.env` sửa `664 → 600` theo rule dự án · skill mới **`erpn-deploy-github`** (quy trình push + đọc token từ `.env`, KHÔNG chứa secret).

---

## ISSUE1 — tắt fallback-mock ngầm (2026-09-21, `result63.txt`)

- [x] **Audit (mục 6)**: không patch `dsh*` nào chứa `COPILOT_MOCK_OK`; `dsh.cordis` truyền `ERPNEXT_*` theo TÊN (dựa `loadEnvFile`), `dsh-e2e` gate `E2E_TARGET`; `.env` checkout này ĐỦ 3 biến; **không có file supervisor/CI trong checkout** ⇒ không sửa CI ở đây
- [x] **Audit (mục 6b)**: grep toàn repo ⇒ không còn đường mock-im-lặng nào khác (khoá bằng tripwire tĩnh) · phân biệt thiếu-cấu-hình vs không-kết-nối-được (host chết VẪN resolve REAL — ma trận test) · rà secret: **không rò** (chỉ TÊN biến, không giá trị; `learning-log` không chạm secret)
- [x] **Fix**: `pickServerScript()` cổng `COPILOT_MOCK_OK === "1"` (đúng chuỗi) ⇒ thiếu cấu hình THROW `ERPNEXT_NOT_CONFIGURED`; 1 điểm chốt cho mọi đường sống; `main()` in WARNING khi phục vụ fixture
- [x] **`package.json`**: `"test": "COPILOT_MOCK_OK=1 node --test"`
- [x] **Test + falsify**: `target.test.mjs` 9 · `mock-optin.test.mjs` 5 · **falsify in-repo 5/5 RED** (`scripts/falsify/issue1-mock-optin.mjs`) · 5.4 tái hiện bug gốc (exit 2 + stdout RỖNG) + control chứng minh cổng là thứ chặn · 5.6 thiếu opt-in ⇒ `ERPNEXT_NOT_CONFIGURED` + exit 124 (không âm thầm dùng fixture)
- [x] **Node 449 (447 pass, 2 fail dsh-env từ B0)** · Python 62 OK · Flutter không đụng
- [x] **Verify ERPNext THẬT (site vừa bật)**: `"Nguyễn Thị Lan"` **KHÔNG tồn tại** (`{"message":[]}`), có `"Nguyễn Thị B"`
- [x] ✅ **BUG THỨ HAI — ĐÃ SỬA (user: "Fix ngay theo hướng đề xuất")**: ĐỌC `"Nguyễn Thị Lan còn nợ bao nhiêu"` từng trả lời tự tin về **SAI khách** `"Nguyễn Thị B"` (`error_code: none`). Fix **rule 2b**: bỏ hit duy nhất khi (a) tên ERPNext còn token phía sau, (b) token kế tiếp là name-like (không số + không thuộc từ vựng ý định của router, lấy từ `listRouting()`), (c) token đó không có trong tên row; chặn cả vị trí bắt đầu. **Đo ERPNext THẬT 11 câu: chỉ 1 dòng đổi — đúng ca bug** ⇒ zero hồi quy. **3 hồi quy do bản đầu của 2b (CHỈ full suite bắt được) đã sửa**: token kế tiếp là SỐ TIỀN (`500 ngàn`) / tiền viết bằng chữ (`năm trăm`) ⇒ thêm điều kiện "row còn token phía sau", tính theo TỪNG field
- [x] ✅ **BUG THỨ BA — validate lúc BOOT cho `http-ask`** (user chọn thêm): `main()` gọi `pickServerScript()` TRƯỚC `listen()` ⇒ thiếu cấu hình **exit 1**, không bind cổng, không phục vụ fixture; in target REAL/fixture. Cố ý KHÔNG probe mạng lúc boot
- [x] **Bằng chứng cuối**: Node **461 (459 pass, 2 fail dsh-env từ B0)** · Python 62 OK · `entity-name-collision` 10 test · **falsify rule-2b 5/5 RED** + **mock-optin 6/6 RED** · không sót mutation/`.falsify-bak`
- [ ] ❓ Cần hỏi lại: duyệt commit issue1 (gộp hay tách commit với phases3) · gap phủ sóng entity resolution cho tên nhiều từ (`result63.txt` §9.3) có thành task riêng (Phase 6) không

---

## P4-0 — Mapping Mode of Payment → Cash|Bank (2026-09-21, spec `.plan/plan4_final.md` §3.2/§10/§12)

- [x] **Đọc spec**: plan4_final (§3.2 thu/chi, §10 đã trả lời — §10.3 két, §12 checklist) · capabilities.json (chưa có map MoP — P4-0 tạo bản đầu) · plan2_final READ path (`/ask` cổng duy nhất, server aggregate — khớp yêu cầu map nằm config server, Flutter không hardcode)
- [x] **Probe ERPNext thật (CHỈ ĐỌC)**: 6 Mode of Payment đều enabled · **245 PE (173 submitted)** · **91/173 (53%) mode TRỐNG** · đo đủ **9/9** `Account.account_type` của tài khoản tiền thực dùng · 3 Company
- [x] **Map + quy tắc** → `docs/plan4-mode-map.md`: bảng hint-layer (§2) + thứ tự rule **account_type → default company → đếm riêng** (§3b) · phát hiện: mode `Chuyển khoản` bị cấu hình `type=Cash` (ngoại lệ tường minh) ⇒ **không thể xếp theo MoP.type**, phải xếp theo tài khoản tiền
- [x] **Két (§10.3)**: cả 3 company đều có `default_cash_account` ⇒ **block két KHÔNG bị chặn**; DEMO POC CO + SANLOAN **không** có `default_bank_account` (phần bank két V1 không mở cho 2 company đó)
- [x] **Cấm tuân thủ**: không UI Flutter, không WRITE, không Redis, không skill WRITE mới — mọi truy vấn get_list/read
- [ ] ❓ Cần hỏi lại: duyệt **khuyến nghị xếp theo `Account.account_type`** (thay vì MoP.type) trước khi P4-1 implement — đây là thay đổi so với định hướng "map mode → cash|bank" ban đầu, có bằng chứng PE thật kèm theo
> ✅ **ĐÃ ĐƯỢC P4-1 ÁP DỤNG**: `ops-summary.mjs` xếp Cash|Bank theo `account_type` của tài khoản tiền (fallback `Company.default_*`, còn lại `unclassified`) — đúng như khuyến nghị, không dùng MoP.type. Bằng chứng trên PE thật: 2026-09-19 tách `cash 19.627.120` / `bank 1.500.000`.

---

## P4-1 — `ops.daily_summary` (backend skill + test, 2026-09-21) — ✅ ĐÃ DUYỆT (user), CHỜ MÁY CÓ GIT ĐỂ COMMIT

**Deliverable:** `result-p4-1.txt` · spec `.plan/plan4_final.md` §3/§4.3/§7/§10 + `.plan/plan4_review3.md` §1.2

- [x] **Contract**: `ops.daily_summary` (READ · `route_group: ops` · no confirm · `triggers: []` **không thêm keyword** ⇒ đường chat không đổi)
- [x] **Skill** `src/skills/ops-summary.mjs`: aggregate server-side, 8 block đúng schema §4.3 (SO tách `submitted`/`draft`), §3.1b `docstatus=1 AND status!='Cancelled'`, SI/PE submitted + `grand_total`, chi chỉ PE Pay + footnote JE, két = GL trước 00:00 VN trên `default_cash_account`
- [x] **Partial**: nhánh lỗi ⇒ block `null` + `errors` (KHÔNG bao giờ 0 giả) · company **từ session** · không `callWriteTool`/`command_id`
- [x] **§0 đo trước (site thật)**: filter value **phải là string** (số ⇒ TOOL_ERROR) · `count` = số dòng TRẢ VỀ (không phải tổng) · `custom_ai_action_id` **chỉ có trên Payment Entry** · `>` + `GL Entry` đọc được
- [x] **Review tự bắt 5 lỗi thật rồi sửa**: filter số làm `receivables` chết trên site (551.910.625) · `app_drafts` `catch {}` báo **0 nháp giả** · **cộng thiếu im lặng** khi trang bị cắt (guard `limit+1` → `ERP_TRUNCATED`) · `cashDrawer` trả 0 giả · guard **không falsifiable** (⇒ tripwire tĩnh, strip comment)
- [x] **Bằng chứng**: Node **484 (482 pass, 2 fail dsh-env từ B0)** · P4-1 **23/23** · falsify **12/12 RED** · Python **62 OK** · Flutter không đụng
- [x] **Vòng lặp THẬT (read-only)**: 21/09 `receivables 551.910.625` **khớp chính xác** cộng độc lập qua REST (295 HĐ) · két chuỗi 3 ngày khớp (09-19 closing = 09-20 opening = 243.302.620; 09-20 closing = 09-21 opening = 243.622.620) · `app_drafts null` + lỗi Frappe nêu đúng field thiếu
- [x] ✅ **ĐÃ SỬA (user duyệt "fix ngay")**: B2/B3 dính ĐÚNG lỗi filter số — `sales-order-write.mjs` + `quotation-write.mjs` `[["selling","=",1]]` ⇒ **đọc Item Price của 2 đường ghi CHẾT trên site thật** (41 test mock vẫn xanh). Sửa `1`→`"1"` + **tripwire toàn repo** `test/filter-literal-types.test.mjs` (quét mọi `.mjs` trong `src/`, strip comment, có control chống "scan hỏng ⇒ xanh") + falsify ca **K**/**M** (harness P4 nay chạy cả 2 file test) · **bằng chứng site thật**: `selling=1` → TOOL_ERROR, `selling="1"` → **27 dòng Item Price** · B2+B3 **41/41 pass**
- [x] ✅ **ĐÃ ĐO (user duyệt "--dry-run trước")**: `add-correlation-field.mjs --dry-run` (chỉ đọc) → **Payment Entry ĐÃ CÓ** field; **THIẾU: Purchase Order · Quotation · Sales Order** (khớp độc lập với probe `Custom Field` meta)
- [x] ✅ **Review vòng 2 (user: "review code những gì vừa làm")** bắt **2 lỗ hổng trong chính tripwire vừa viết**: (a) dạng array `["docstatus","in",[0,1]]` **lọt** (regex dừng ở `]` đầu tiên) → vá + nhận cả `+1`; (b) ca falsify K/M đỏ nhưng **không chứng minh đúng tripwire là thứ bắt** → thêm `only` cho harness (K/M/N chạy riêng file tripwire) · đã xác nhận tripwire **thật sự được `npm test` chạy** (`grep` thấy `✔ static tripwire…`) · sau vá: **14/14 RED** · kiểm tác động: `src/` chỉ có `.mjs`; literal số ở `scripts/` chỉ trong chuỗi mutation của harness; Flutter không tự gọi ERPNext; không import thừa; không mutation sót
- [x] ✅ **ĐÃ SỬA (user duyệt "Sửa ngay (validate ở biên HTTP)")** — `action_id`/`command_id` do **client gửi** không kiểm kiểu ⇒ nếu là SỐ thì `reconcile*` bị tool thật từ chối ⇒ executor **từ chối ghi OAN** kèm chẩn đoán SAI `SO_CORRELATION_FIELD_MISSING` ("ERPNext chưa có field — chạy migration") (fail-closed ⇒ **không** có nguy cơ ghi trùng, nhưng chặn oan + chẩn đoán sai). **Fix**: helper `correlationIdProblem()` trong `http-ask.mjs`, gọi ngay sau parse body và **TRƯỚC rate-limiter** ⇒ 400 `INVALID_CORRELATION_ID` (dùng lại pattern `isValidCommandId` mà `/execute/cancel` đã có — `/execute` không dùng = chỗ hở) · **test** +1 (số ở `command_id`/`action_id`, chuỗi rỗng, control, và `store.status(12345) === null` chứng minh không đốt command_id) · **falsify** harness mới `scripts/falsify/execute-id-types.mjs` **3/3 RED** · Flutter khai `command_id` là `String?` ⇒ không gãy client
- [x] 🎓 **Bài học phụ**: ca falsify C **không đỏ** vì test chỉ assert **status 400** (khi bỏ guard request vẫn 400 từ chỗ khác) ⇒ đã siết thành assert **MÃ lỗi** — **assert mã, đừng assert status** (ghi LESSONS nhóm 20 + skill)
- [ ] ❓ **CHỜ USER**: có tạo `custom_ai_action_id` trên SO/QT/PO thật không? Chưa tạo ⇒ (a) `app_drafts` của P4-1 phải **null** (hiện tượng tự hết khi có field, **không cần sửa code**); (b) **idempotency/correlation của B2/B3/B4 hiện chỉ đứng với mock**. Đây là GHI vào ERPNext ⇒ AI không tự làm

---

## P4-2 — Route `GET|POST /read/daily-summary` (2026-09-21) — ✅ KỸ THUẬT XONG, CHỜ MÁY CÓ GIT + USER DUYỆT COMMIT

**Deliverable:** `result-p4-2.txt` · spec `.plan/plan4_final.md` §4.2/§4.3/§5/§7/§8 · depends P4-1

- [x] **Route** `GET|POST /read/daily-summary` trong `src/http-ask.mjs` — **không** qua NLP/classifier (id cho sẵn; file test không hề chạy service Python)
- [x] **Input**: `date` optional ở **cả** body và query (body thắng khi POST có cả hai) · `YYYY-MM-DD` · thiếu/rỗng = **hôm nay tại tiệm** (`Asia/Ho_Chi_Minh`, không phải ngày của host)
- [x] **§0 đo trước (site thật)**: `Global Defaults` là **Single** ⇒ `doc_list` **500**, `doc_get` **OK** (`default_company = "Minh Phát Cám & VLXD"`) · `User.default_company` **417** · `Company` list **3 rows** ⇒ không có default thì **TỪ CHỐI**, không chọn row đầu
- [x] **Company server-side**: pin config → `Global Defaults.default_company`; không có ⇒ **503 `COMPANY_UNRESOLVED`** (nói rõ cấu hình gì) · client gửi `company` khác ⇒ **403 `COMPANY_SCOPE_MISMATCH`** (không lặng lẽ trả sổ company khác)
- [x] **401/403/429/503/400**: basic-auth toàn cục non-loopback (401) · `authorize` **TRƯỚC mọi lần đọc ERP** (403) · bucket **READ** charge sau parse trước authz (429) · 503 cho company + ERP chưa cấu hình/spawn lỗi · 400 `INVALID_DATE` (regex **không đủ**: `2026-02-30` bị chặn bằng round-trip lịch)
- [x] **Partial đi thẳng response**: 200 + `meta.partial` + block `null` + `errors` (không viết lại object, không gộp 5xx)
- [x] **Mock**: `erpnext_doc_get` nhánh `Global Defaults` (shape như thật) + `MOCK_ERP_DEFAULT_COMPANY` (`=""` = không có default) + `MOCK_ERP_FAIL_GLOBAL_DEFAULTS`
- [x] **Review tự bắt 3 lỗi THẬT rồi sửa**: (1) `pickServerScript()`/`createMcpClient` **ngoài `try`** ⇒ ERP chưa cấu hình làm **async listener reject ⇒ process chết** (kéo cả `/ask`) → đưa vào `try` + test "can never take the service down"; (2) mã `TOOL_ERROR` của tầng MCP đi thẳng ra client → whitelist theo spec §4.3 (`ERP_UNAVAILABLE`), **log giữ mã thật**; (3) `client.close()` **treo VĨNH VIỄN** khi child đã chết (`once("exit")` không bắn lại) ⇒ route gọi `close()` trong `finally` **không bao giờ return**, rò 1 socket + 1 child MỖI request lỗi (mọi route READ dính) → `close()` **idempotent** (`child.exitCode/signalCode !== null ⇒ return`) + test `close() is IDEMPOTENT` · đã kiểm và **không phải lỗ hổng**: `new URL(req.url)` throw với request-target tuyệt đối nhưng dòng đó nằm **sau** khớp `path` nên không tới được (đo 12 dạng, kể cả percent-encoding hỏng/200k ký tự)
- [x] **Bằng chứng**: Node **505 (503 pass, 2 fail dsh-gateway từ B0)** (trước P4-2: 485 ⇒ **+20**) · P4-2 **19/19** + `client.test.mjs` **9/9** · falsify **14/14 RED** · Python **62 OK** · Flutter không đụng · không mutation sót (`grep "if (false)"` = 0)
- [x] **Vòng lặp THẬT (read-only)**: `GET` (không date) 200 + `date=2026-09-21` + `company` lấy từ **session** · `GET == POST` cùng ngày · `partial=true` với `app_drafts` null + lỗi Frappe thật · `2026-02-30` → **400** · claim `SANLOAN` → **403** · **đối chiếu chéo REST độc lập**: `receivables 493.440.625` (286 HĐ) **khớp chính xác**, SI ngày 575.000/1 khớp
- [x] 🎓 **Bài học (LESSONS nhóm 21 + skill)**: env rò giữa test ⇒ test sau **xanh vì lý do khác** (khôi phục đúng key mình chạm) · `--test-name-pattern` khớp **0 test** vẫn exit 0 ⇒ harness phải escape + đếm test chạy + chạy **xanh trước khi mutate** · client/spawn ngoài `try` trong async handler = **giết cả service** · "company của session" phải **đo đường đọc** (Single vs 417), không suy từ docs
- [ ] ❓ **CHỜ USER**: duyệt commit (máy chưa có git) — vùng đọc SỐ TIỀN ⇒ AI không tự commit · tạo `custom_ai_action_id` trên SO/QT/PO (nếu muốn `app_drafts` hết partial)

---

## P4-3 — Drawer + màn `Tóm tắt ngày` (2026-09-21) — ✅ KỸ THUẬT XONG, CHỜ MÁY CÓ GIT + USER DUYỆT COMMIT

**Deliverable:** `result-p4-3.txt` · spec `.plan/plan4_final.md` §2 (drawer) + §6 (trạng thái) · depends P4-2

- [x] **§0 đo trước (quyết định thiết kế)**: **không có tín hiệu REAL\|MOCK nào tới client** (`ops-summary.mjs` hardcode `source: "real"`, cả khi chạy fixture; `/ask` chỉ có `erpnext_target` ở đường DSH) ⇒ phải thêm `meta.erp_target`; full suite Flutter **đỏ sẵn 1 test** (`_probe_review_test.dart` P2b); drawer > 600px nên test phải mở viewport cao; `AppBar` có `drawer` tự sinh `Icons.menu`; footer hiện URL **hiệu lực** (`defaultCopilotBaseUrl`), không phải `Dio.baseUrl` của test double
- [x] **Server (mảnh nhỏ, 1 nhà cho 1 luật)**: `erpTargetLabel(env)` ở `copilot-server.mjs` (`ERPNEXT_URL ? REAL : MOCK`, presence-only) → route truyền vào skill → `meta.erp_target` (**`null` khi không ai nói**, không đoán REAL); **dòng log khởi động dùng chính helper đó** ⇒ log người vận hành và footer chủ tiệm không thể lệch
- [x] **Drawer (§2)**: `Tóm tắt ngày` **đầu tiên + "Mặc định"** · section THEO DÕI / PHIẾU TỪ APP / LỐI TẮC READ / CÀI ĐẶT · mục chưa làm = **"Sắp có (bước P4-4/P4-5)"** + disable (không nút đoán) · `Server / đăng nhập` → `/settings` · footer REAL\|MOCK + URL + giờ cập nhật · **không** ô free-text (§4.4 cấm inject text để đoán capability)
- [x] **Màn tóm tắt**: SO **submitted \| draft tách bạch** (§10.1) · HĐ **giá trị sau VAT** · thu **TM/CK/theo HĐ/ứng trước** + dòng **"Chưa phân loại được"** khi có · chi + footnote **"Chưa gồm chi qua Journal Entry"** (§10.2) · **két dự kiến** · **nợ hiện tại** + quá hạn · nháp app
- [x] **Trạng thái §6**: skeleton (Loading) · OK + stamp `generated_at` · **partial theo TỪNG block** ("Lỗi · chưa đọc được mục này (MÃ)" + `Thử lại`) · offline/401/503 ⇒ giữ số cũ + nhãn **DỮ LIỆU CŨ** + lý do · **empty day** chỉ khi `partial=false` + câu nói rõ "không phải lỗi"
- [x] **Cache §2**: **45s** (giữa 30–60s); trong cửa sổ **không gọi HTTP**; quá cửa sổ ⇒ số cũ + nhãn cũ **ngay** rồi revalidate; cache hỏng ⇒ bỏ qua + đọc live (fail-safe)
- [x] **CẤM (đã đối chiếu)**: không `/execute` (**assert trên log request**) · **không nút ghi** (assert cấu trúc: không `TextField`, không `FilledButton`/`TextButton` khi không có gì lỗi) · không drill P4-4/P4-5 · **không** dùng chữ **"Doanh thu"** (có test canh)
- [x] **Review tự bắt 4 phát hiện THẬT**: (1) "không 0 giả" phải cài ở **tầng parse** (object `{}`/chuỗi lỗi ⇒ block `null`, không thành "0đ"); (2) fixture `??` **ăn mất `null`** ⇒ cờ tường minh `noReceipts/noAppDrafts/noCashDrawer`; (3) ca falsify **"xanh oan" 2 lần** vì nhánh khác cũng chặn (guard `partial` che bởi guard `receipts==null`; guard `_stale=!fresh` che bởi nhánh lỗi tự set cờ) ⇒ đổi fixture + thêm test quan sát **lúc request đang bay**; (4) probe P2b cũ **đỏ sẵn không phải regression** — quy trách nhiệm bằng bằng chứng (cô lập + comment fix F2 trích số đo của chính probe + kiểm cây import + probe đối chứng)
- [x] **Bằng chứng**: analyze **0 issue** · `daily_summary_test` **25/25** · Flutter **233/233 pass** (đã xoá probe P2b theo quyết định user — trước P4-3 suite là **212 test / 211 pass + 1 fail**; nay +25 test của P4-3, −4 test của probe) · falsify P4-3 **11/11 RED** (7 Dart + 3 Node) · Node **508 (506 pass, 2 fail dsh-gateway từ B0)** (+3) · mutation sót **0**
- [x] **Vòng lặp THẬT (read-only)**: `meta.erp_target = REAL` **và** log khởi động nói `REAL -> host` (**khớp nhau**) · `partial=true` + `app_drafts` null (đúng: site thiếu `custom_ai_action_id`) · **cross-check REST độc lập**: receivables **493.440.625** (286 HĐ) + invoices **575.000** (1 HĐ) **khớp chính xác**
- [x] 🎓 **Bài học (LESSONS nhóm 24/25 + skill `erpn-verify-first` +8 hàng)**: nhãn provenance phải **dẫn xuất, 1 nhà**, `null` khi không biết (không mặc định REAL) · probe tạm bỏ quên ⇒ đỏ giả + cách **quy trách nhiệm bằng bằng chứng** · fixture `??` ăn mất null · falsify bị nhánh khác che · state theo thời gian phải assert **trạng thái trung gian** · assert "không ghi" bằng **cấu trúc** không bằng chuỗi · helper test private (`--fatal-infos`) · parser output đa runtime phải kiểm **tên test đỏ**
- [x] ~~(a) xoá `apps/mobile/test/_probe_review_test.dart`~~ → **ĐÃ XOÁ** theo quyết định user ⇒ suite Flutter **233/233 xanh**
- [x] ~~(b) tạo `custom_ai_action_id` trên SO/QT/PO~~ → **ĐÃ TẠO TRÊN SITE THẬT** (user duyệt bỏ `--dry-run`, 2026-09-21): `Purchase Order` · `Quotation` · `Sales Order` ⇒ **4/4 doctype** có field `type=Data unique=1 search_index=1`, script chạy **lần 2 = no-op** (idempotent). **Verify ĐỘC LẬP 3 lớp** (không tin read-back của script): META row 4/4 · đọc doc có field (PE/SO/PO thật; QT **không có chứng từ ⇒ vacuous, nói rõ**) · **WHERE trên cột** (thiếu cột ⇒ Frappe 417 `Unknown column`) 4/4 **HTTP 200 rows=0** ⇒ cột có cả trên `Quotation` · **control âm** field không tồn tại ⇒ 0 row ✓. **Hệ quả đo được**: vòng lặp thật nay **`partial=false`** (trước đó `true` + `app_drafts` null); cross-check REST cùng lúc: **receivables 488.040.625 / 281 HĐ** khớp chính xác. ⚠️ Số **493.440.625 / 286 HĐ** ghi ở mục trên **không sai lúc ghi** — site **đổi dữ liệu giữa 2 lần đo** (−5.400.000, thu trong ngày 11.430.000 ⇒ 5 HĐ đã thanh toán); điều được chứng minh là **route luôn khớp REST tại thời điểm đo**
- [x] **Review vòng 2 trên phần vừa làm** (`result-p4-3.txt` §8): **an toàn đã đo** — `unique=1` trên bảng có dữ liệu **không** phá luồng tạo chứng từ (PE: field có từ 2026-09-17, **106 PE tạo sau đó cùng rỗng** ⇒ rỗng lưu là NULL; nói rõ phép đo này **vacuous với SO**); **phát hiện #1 (đã vá)**: nhánh fixture của mock **không** mô phỏng "site thiếu field" ⇒ **CI mù** với đúng lỗi vừa fix (và "thiếu field" lặng lẽ thành "0 nháp") → parity + **2 test mới** (1 doctype thiếu ⇒ null + tên block + **control các block khác vẫn đúng số**; đối chứng: đủ 4 ⇒ `partial=false` + `{count:0,by_type:{}}`) + falsify ca **O** ⇒ **15/15 RED**; **phát hiện #2 (chưa sửa, chờ user)**: `add-correlation-field.mjs` nhánh `ĐÃ CÓ` **không so spec** (`unique=0` ⇒ vẫn exit 0 ⇒ báo an toàn cho trạng thái chưa an toàn, chạm nửa DB của duplicate guard); comment cũ trong `ops-summary.mjs` (nói site thiếu field) **đã cập nhật**. Số: Node **510 (508 pass, 2 fail dsh từ B0)** · P4-2 **20/20** · Flutter không đụng.
- [ ] ❓ **CHỜ USER**: (c) **duyệt commit** (máy chưa có git) — vùng đọc SỐ TIỀN ⇒ AI không tự ký duyệt; (e) **B2/B3/B4 idempotency trên site thật**: field đã có ⇒ **giờ mới chứng minh được**, nhưng cần **chạy ghi thật** (tạo nháp rồi tạo lần 2 xem dedupe) ⇒ chưa được phép, tới lúc đó correlation của B2/B3/B4 **vẫn chỉ đứng với mock**
  - Khảo sát giữ lại (để phiên sau không push thô): **TẮC từ máy này** — checkout **không có `.git`** (không push) và **không có `.github/workflows`** ⇒ `gh workflow run` chỉ build **trạng thái trên remote = KHÔNG có P4-3**; build local không được (`/usr/lib/android-sdk` **thiếu `platforms/` + `build-tools/`**, `/home` còn **~1.5G** ⇒ cài SDK = tool mới ⇒ xin phép); máy **không có phone/emulator** (`flutter devices` chỉ `Linux (desktop)`) ⇒ bước **cài lên máy** do user làm.
  - **Đo thêm (read-only `gh api`)**: remote `hoangsoft90/erpn_mobile1` **CÓ** workflow `android-debug-apk.yml` và chỉ **1 branch** `change/flutter-chat-mvp`; `gh` 2.99.0 + `GH_TOKEN` ⇒ đường CI khả thi. ⚠️ **KHÔNG push thô từ bản này**: history **không chung gốc** + bản local **thiếu file so với remote** (chính `.github/workflows` là ví dụ) ⇒ push cả cây local sẽ **XÓA file trên branch duy nhất** (cần `--force`) = không hoàn tác; muốn đi đường đó phải `git init` → `fetch` → checkout **đúng tree remote** → **overlay chỉ file P4-1/P4-2/P4-3** → commit → push (không force) và **chỉ khi user duyệt rõ**.

---

## P4-4 — Drill-down structured (2026-09-21) — ✅ KỸ THUẬT XONG, CHỜ MÁY CÓ GIT + USER DUYỆT COMMIT

**Deliverable:** `result-p4-4.txt` · spec `.plan/plan4_final.md` §4.4 · depends P4-2 + P4-3 + A1 pattern

- [x] **§0 đo trước**: A1 đã có `ui_screens` + `/read/list` + `ReadListScreen` (envelope items/total/truncated) ⇒ tái dùng đúng envelope + màn list; drill là **theo NGÀY + id cố định** (khác `ui_screens` theo entity) ⇒ block contract riêng `drill_screens` validate fail-closed
- [x] **Server**: `drill_screens` 5 id (sales_orders_today→sales.summary · invoices_today→invoice.lookup · receipts_today→payment.history · overdue_customers→customer.balance · app_drafts_today→ops.daily_summary — capability là **Nguồn quyền + Nguồn số**) · `readDayDrill` **DÙNG LẠI đúng primitive của aggregate** (không extractor thứ hai) · route `GET|POST /read/drill`: auth như /ask · bucket READ · **KHÔNG classifier** · id lạ 404 · company resolve server-side qua helper dùng chung `resolveReadCompany()` (tách từ P4-2, 1 nhà) · partial đi thẳng
- [x] **Flutter**: `drill_models.dart` + `dailySummaryDrill()` + `DrillListScreen` (Back · retry · truncated trung thực · không affordance ghi) · route `/drill` **fail-closed** khi thiếu intent · tap chỉ số trên màn tóm tắt qua `context.go` (**không** `Navigator.pushNamed`)
- [x] **Test**: server **9/9** + authz tách file · Flutter **8/8** (tap drill không gọi /execute — assert log request · không classifier · truncated · Back · fail-closed) · **guard chống drift**: tổng dòng drill = ĐÚNG số block aggregate trên cùng fixture
- [x] **Bằng chứng**: Node **519 (517 pass, 2 fail dsh từ B0)** (+9) · Flutter **241/241** (+8) · analyze **0** · falsify **12/12 RED** qua **harness lib dùng chung** `scripts/falsify/lib/harness.mjs` (không bản sao runner thứ 3) · Python **62 OK**
- [x] **Vòng lặp THẬT (read-only)**: 5 drill đối chiếu block summary trên site thật ngày 2026-09-21 — **ALL MATCH** (SO sub/draft · HĐ 575.000 · thu 11.430.000 tách theo HĐ/ứng trước · quá hạn 4.700.000 · nháp 0)
- [x] **Lỗi tự gây đã sửa + falsify lại** (`result-p4-4.txt` §5): credit-note fixture phải **âm** · authz đoán sai helper khuôn · `Navigator.pushNamed` không qua GoRouter · **test chaos dùng store mặc định của repo** (duy nhất không truyền `idemStore`) để record PENDING sót ⇒ **độc hại lần chạy sau** — đã cô lập store · **SQL COUNT gộp dòng null** ⇒ lệch +1 với aggregate ⇒ đếm bằng list đã lọc (guard drift bắt ngay)
- [ ] ❓ **CHỜ USER**: duyệt commit (vùng đọc SỐ TIỀN) · P4-5 nháp block chi tiết

---

## P4-7 — Đóng plan4 V1: đối chiếu §7 + docs (2026-09-21) — ✅ XONG

**Deliverable:** `result-p4-done.txt` · nguồn: `.plan/plan4_final.md` §7 (12 acceptance case)

### Ma trận §7 — từng case → bằng chứng THẬT

| §7 | Case | Test / bằng chứng | KQ |
|----|------|-------------------|----|
| 1 | SO và SI khác số tiền cùng ngày → 2 block khác nhau | `p4-ops-summary.test.mjs` "P4 §7.1: SO and SI amounts differ for the same day" | ✅ |
| 2 | PE allocate HĐ vs PE advance → `against_invoice` ≠ `advances` | "P4 §3.2 + §1.3: receipts split against_invoice vs advances, cash vs bank" | ✅ |
| 3 | PE Cash vs Bank → tách `cash`/`bank` | "§3.2/§1.3" + "P4 §7.3 + P4-0 lesson: 'Chuyển khoản' (mode type=Cash) lands in BANK by account_type" | ✅ |
| 4 | SI `docstatus=0` **không** vào `sales_invoices` | "P4 §7.4: draft SI never enters sales_invoices" | ✅ |
| 5 | Return/credit **không** làm tăng `sales_invoices.amount` | "P4 §3.5: returns/credit notes never inflate the invoice amount" | ✅ |
| 6 | Thiếu quyền một doctype → partial, không crash, không số bịa | **THIẾU — đã BỔ SUNG phiên này**: test "P4 §7.6: a doctype the user may NOT read is a NULL block — never an empty 0-day" + sentinel `__FORBIDDEN__` trong `src/mock-server.mjs` (mô phỏng Frappe PermissionError/403 — trạng thái site thật mà fixture trước đây **không thể** tái hiện) + ca falsify **O** | ✅ (mới) |
| 7 | Biên timezone (23:30 vs 00:30) | `p42-read-daily-summary.test.mjs` "P4-2 date: the day is the SHOP's (Asia/Ho_Chi_Minh) not the host's — 23:59 vs 00:00 VN" (16:59Z/17:00Z + 17:30Z = 00:30 VN + control format `YYYY-MM-DD`) — biên **chặt hơn** spec đòi | ✅ |
| 8 | Không double-count cùng một PE | "P4 §7.8: the same PE cannot be counted twice (idempotent aggregation)" | ✅ |
| 9 | Flutter: tap drill **không** gọi `/execute` | `drill_list_test.dart` (assert trên **log request**) + `daily_summary_test.dart` + static "P4 §7.9/§7.10: the ops path carries no /execute, no callWriteTool, no command_id" | ✅ |
| 10 | Regress `payment.create`, SO/QT/PO, OCR C0–C2 | `payment-write` · `b2-sales-order` · `b3-quotation` · `b4-purchase-order` · `c0/c1/c2-ocr-*` · `http-execute` — toàn bộ suite xanh (xem số dưới) | ✅ |
| 11 | Huỷ + amend cùng ngày → tính đúng 1 lần (INV-0003→INV-0004) | "P4 §3.1b: cancelled excluded, amended counted once (INV-0003 → INV-0004)" | ✅ |
| 12 | Dùng nguyên bộ 20 chứng từ `plan4_review3.md` §1.2 làm fixture; **không chép mù SQL** | fixture trong `p4-ops-summary.test.mjs` = **đúng 20 entry** (đếm được), ghi rõ §1.2 ở đầu file; filter "advance" đã **verify lại với site thật** (vòng thật P4-4/P4-6 tách được `Theo hóa đơn` / `Ứng trước`) | ✅ |

**Kết luận §7: 12/12 có test + bằng chứng.** Trước phiên này là **11/12** (§7.6 thiếu).

- [x] **Số thật cuối phiên này**: Node **524 — 522 pass, 2 fail (dsh, có từ B0)** · Flutter **248/248** · analyze **0** · Python **62 OK** (`PYTHONPATH=src python3 -m unittest discover -s tests -q` — **không dùng pytest**, máy không cài) · falsify: p4-ops **15/15 RED** (+ca O), p42 **15/15 RED**, p44 **20/20 RED**, p43 **11/11 RED** — **0 PROBLEM**
- [x] **2 anchor falsify bị TRÔI do code đổi sau đó** (đúng loại lỗi "test cũ không còn kiểm cái nó tưởng"): ca **L** (`appDrafts`, trôi ở P4-5 khi thêm `company` vào field list) và ca **F** (`http-ask`, trôi ở P4-4 khi guard công ty chuyển vào `resolveReadCompany()`) ⇒ harness báo **`anchor missing`** chứ **không** im lặng bỏ qua ⇒ đã sửa cả 2. **Ca bị bỏ qua trông y hệt ca đã pass** trong dòng tóm tắt — đây là lý do phải phân biệt.
- [x] **Docs**: `faq.md` §10 (cách đọc Tóm tắt ngày) + sửa §4.3/§7 đã lỗi thời ("tổng hợp theo ngày **chưa có**" ⇒ nay **đã có ở màn drawer**) · `features.md` · `next.md` · `LESSONS_LEARNED.md` · skill `erpn-verify-first` (+2 hàng)
- [x] **KHÔNG làm (đúng lệnh dừng)**: không skill WRITE mới (P9), không Redis, **không ghi/két WRITE** (két giữ READ §3.6)
- [x] 🎓 **Đợt rà harness toàn repo (sau P4-7, cùng ngày)**: chạy đủ **10/10 harness** (c0/c1/c2 · execute-id-types · issue1×2 · p4-ops/p42/p43/p44) ⇒ **phát hiện c2-ocr CHẾT IM**: spawn `node --test` **không có `COPILOT_MOCK_OK=1`** ⇒ baseline đỏ 3 test ⇒ exit **trước mọi case** ⇒ 0 ca được kiểm (chỉ an toàn nhờ baseline-check — nếu chỉ nhìn `status !== 0` thì mọi ca đỏ-giả). Sửa + chạy lại ⇒ **ALL C2 GUARDS FALSIFIED 10/10**. Kèm: gửi nhầm `timeout 240` kill c2 lúc baseline (không sót mutation vì chưa áp); sentinel 403 bổ sung test với **đúng hình thái message client thật** (grep node_modules 3.0.4: `FrappeAPIError` throw khi `!response.ok`) ⇒ p4-ops **25/25** · Node **525 (523 pass, 2 fail dsh)**
- [x] **Bài học → LESSONS (đợt rà harness, 5 bullet) + skill `erpn-verify-first` (+2 hàng)** · openspec `flutter-chat-mvp` ghi `STATUS-2026-09-21.md` (2 task chờ USER: GitHub Settings + APK máy thật — không archive để "dọn file")
- [ ] ❓ **CHỜ USER**: duyệt commit hàng chờ **P4-1→P4-6** (vùng đọc SỐ TIỀN; máy chưa có git)

---

## P4-6 — Hôm nay | Hôm qua (delta ĐÃ BỎ 2026-09-26) (2026-09-21) — ✅ KỸ THUẬT XONG, CHỜ DUYỆT COMMIT

**Deliverable:** `result-p4-6.txt` · spec `.plan/plan4_final.md` §6 + §3.4 · depends P4-1→P4-5

- [x] **§0 đo trước (verify-first)**: route `/read/daily-summary` **đã nhận `date` từ P4-2** + `readDailySummary({date})` client đã có ⇒ **P4-6 KHÔNG cần sửa server** (xác nhận bằng đọc code, không đoán). Khoảng trống thật: `DrillIntent` chưa có `date` và `DrillListScreen` không truyền
- [x] **Selector**: `SegmentedButton` Hôm nay (mặc định) / Hôm qua · `_viewDay` state cục bộ (không đụng router)
- [x] **Delta** (bản 2026-09-21: hiệu TUYỆT ĐỐI `±Xđ`, không %) — **ĐÃ BỎ 2026-09-26** (xem fix dưới): khi thẻ hiện đúng số ngày đang xem thì dòng "so với hôm qua" gắn lên số hôm qua là vô nghĩa
- [x] **Công nợ LUÔN hiện tại** khi xem Hôm qua (§3.4 — ERPNext không có "công nợ của hôm qua" ở đường đọc này) + chú thích UI để không đọc nhầm
- [x] **Drill theo ngày đang xem** (`DrillIntent.date`) — nhưng giữ `date: null` khi xem Hôm nay ⇒ **server** quyết định ngày tiệm, không gửi giờ máy
- [x] **Đọc Hôm qua LƯỜI** (chỉ khi user chọn) — sửa bug re-mount mất delta im lặng, đồng thời giữ **1 lượt ERP** mỗi lần mở màn (không +1)
- [x] **Bằng chứng**: Flutter **248/248** (+6) · analyze **0** · Node **523 (521 pass, 2 fail dsh từ B0)** — không đổi (không đụng server) · falsify **20/20 RED, 0 PROBLEM** (+3 ca)
- [x] **Vòng lặp THẬT (read-only)**: 2 ngày đều **200 / `partial=false`** · **receivables 2 ngày GIỐNG HỆT NHAU** (488.935.625 / 4.700.000) ✅ đúng §3.4 · delta ± tuyệt đối tính đúng · cross-check từng ngày **ALL MATCH**
- [x] 🎓 **Phát hiện thật (4)**: (a) **kill harness giữa chừng ⇒ mutation P4-5 sót trên đĩa** ⇒ thêm restore-on-`SIGINT/SIGTERM` vào harness lib; (b) case falsify **trỏ sai Dart suite** ⇒ harness báo **PROBLEM** (không cho RED giả — tự tố giác); (c) **test yếu**: ca drill-theo-ngày vẫn PASS khi bỏ `date` ⇒ siết assert đúng ngày cụ thể; (d) **bug thật**: `DrillIntent.date` có nhưng `_load()` không truyền ⇒ drill từ Hôm qua đọc hôm nay
- [x] ⚠️ **Probe CỦA TÔI sai trước code**: lần chạy đầu lệch 5.000.000.000 vs 320.000 — probe thiếu lọc company nên gom 10 phiếu thu của `DEMO POC CO` (site 3 công ty); **route đúng**. Lần thứ 3 trong dự án ⇒ đã ghi skill
- [x] **Không làm (đúng ranh giới)**: không %/chart · không "công nợ hôm qua" (§3.4 — phạm vi mới) · không `/execute`, không nút ghi
- [x] **FIX 2026-09-26** (D4 phát hiện ngoài scope): chọn **Hôm qua** trước đây **đổi tiêu đề nhưng số vẫn của hôm nay** ⇒ nay 2 thẻ bán/thu hiện **đúng số ngày đang xem** (`_yesterday`); đọc lỗi/chưa xong ⇒ **"Chưa đọc được ngày hôm qua" + `Thử lại`, KHÔNG hiện số hôm nay** (fail-closed); drill mang `date = d.meta.date`. Bỏ dòng delta. Bằng chứng: Flutter **333/333** · analyze **0** · falsify p44 **38/38 RED**
- [ ] ❓ **CHỜ USER**: duyệt commit (vùng đọc SỐ TIỀN — AI không tự ký duyệt; máy chưa có git)

---

## P4-5 — Block nháp app hôm nay (2026-09-21) — ✅ KỸ THUẬT XONG, CHỜ MÁY CÓ GIT + USER DUYỆT COMMIT

**Deliverable:** `result-p4-5.txt` · spec `.plan/plan4_final.md` §4.4 (block nháp) + §5.3 · depends P4-1/2/3/4

- [x] **§0 đo trước**: DocField meta — `grand_total` có trên SO/QT/PO, **KHÔNG có trên PE** (hỏi ⇒ 417) ⇒ PE dùng `posting_date` + `paid_amount`; bản drill đầu của phiên hỏi `grand_total` cho cả 4 ⇒ **vòng thật bộc lộ 503 ERP_UNAVAILABLE**, đã sửa + đo lại 200
- [x] **Server**: drill nháp field list **theo doctype**; row COPY giá trị chứng từ (`grand_total` / `paid_amount`) — không tự tạo 0; giữ filter `custom_ai_action_id is set` + docstatus 0 + trong ngày + company scoping (P4-4); block aggregate không đổi (by_type đã có sẵn)
- [x] **"Không id không vào"** (spec §4.4): 4 dạng không-field / null / chuỗi rỗng / PE-PLAIN đều VẮNG ở cả block lẫn drill (SO-PLAIN, SO-NULLID, PE-PLAIN, PE-EMPTYID trong fixture)
- [x] **Biên ngày**: `transaction_date`/`posting_date` của chính chứng từ; draft dated hôm qua chỉ thuộc hôm qua; ngày không nháp ⇒ list rỗng là CÂU TRẢ LỜI
- [x] **Flutter**: row nháp dẫn bằng CHỨNG TỪ, money side **"—"** (không 0đ); **CẤM ghi/xoá/submit** — assert 7 cụm hành động + không TextField + không FilledButton + log request không 'execute' (§5.3)
- [x] **Bằng chứng**: server drill test **12/12** (3 test P4-5 mới) · Flutter drill **9/9** (+1) · falsify **17/17 RED** (+3 ca P4-5) · Node **523 (521 pass, 2 fail dsh từ B0)** · Flutter **242/242** · analyze **0** · vòng thật: drill nháp **200, drill=block=0** (đúng — site chưa có nháp trong ngày, partial=false) · ALL MATCH 9/9
- [x] **Không làm**: "command store trong ngày" (nửa còn lại của câu spec) — không tạo nguồn sự thật thứ hai cạnh `custom_ai_action_id`
- [x] 🎓 **Bài học (LESSONS đợt P4-4 bổ sung + skill +2 hàng)**: field list cho NHIỀU doctype phải đo meta từng doctype (417 giết cả cụm; mock không biết schema thật ⇒ vòng thật là phép kiểm duy nhất) · "không 0 giả" ở TỪNG ROW (server copy giá trị thật, client chọn nhân cách hiển thị)
- [ ] ❓ **CHỜ USER**: duyệt commit (vùng đọc SỐ TIỀN) · P4-6 (optional) hôm qua + delta

---

## P3 (phases3 — B0 · A1 · B1 · B2 · B3 · B4 · C0 · C1 · C2, 2026-09-20)

- [x] **B0 readiness gate** — GO + 7 gap (`B0-result.md`); G1: thiếu `custom_ai_action_id` trên SO/Quotation (migration đã soạn, KHÔNG tự tạo field) · G2: 2 test dsh-env đỏ trên máy không có dsh · G3: probe P2b Flutter đỏ
- [x] **A1 UX-READ drill-down** — `ui_screens` trong contract + `POST /read/list` (authz + re-validate entity + limit 5–10) + Flutter nút/màn/Back; test chặn write surface từ drill-down (`A1-result.md`)
- [x] **B1 Item/Supplier/UOM** — `uom_policy` fail-closed (no-inverse, no-two-hop, missing→ask) + `supplier.lookup` READ + item 4 states; đo trước trên ERPNext thật đảo ngược 3 giả định của plan (`B1-result.md`)
- [x] **B2 sales_order.create (WRITE #2)** — deny-list `sales_order_write` + disambiguation đặt/giao/báo giá + card Flutter + execute NHÁP + golden o01–o08 + tripwire Dart↔contract (`B2-result.md`)
- [x] **B3 quotation.create (WRITE #3)** — pattern B2 + taxonomy `QT_*` riêng + `QT_DUPLICATE_ACTION 409` + golden q01–q08 ✅ ĐÃ DUYỆT (user: "Đạt") (`B3-result.md`)
- [x] **B4 purchase_order.create (WRITE #4)** — pattern B2/B3 + disambiguation mua/nhập/nhận + golden p01–p08 + party-theo-route (`B4-result.md`)
- [x] **C0 OCR foundation** ✅ ĐÃ DUYỆT (user: "Đạt") — `OcrProvider` + mock CI + MVP router-vision + `ocr_policy` fail-closed + untrusted wrap trước classifier + mime allowlist + trần ảnh 8 MB (`C0-result.md`)
- [x] **C1 camera UI + fallback** ✅ ĐÃ DUYỆT (user: "Đạt") — `image_picker` + `POST /ocr` (validate tại ROUTE, không chỉ provider — lỗ mock-trả-hóa-đơn-bịa đã vá) + sheet kết quả + [Nhập tay từ ảnh] + không auto-send (`C1-result.md`)
- [x] **C2 camera → proposal** — kind do USER chọn (ảnh không có động từ mệnh lệnh — đo trước) · slots từ parser CHUNG với builder (`line-parse.mjs`) · party photo chặt hơn chat (tên cụt → candidates, word-boundary) · provenance gate fail-closed 4 lớp · `ocr_policy.document_kinds` validate contract · Flutter form sửa-được → câu gửi qua `/ask` = user's own turn · **review vòng 2 bắt 1 lỗ THẬT đã vá: `/ocr/slots` nhận text 1 MB không chặn (`assertSlotsText` + `OCR_READ_TOO_LONG` + falsify guard)** — **CHỜ DUYỆT (vùng ghi)** (`C2-result.md`, `result62.txt`)
- [x] Falsify tất cả phase đặt TRONG REPO (`scripts/falsify/c0-ocr.mjs` · `c1-ocr.mjs` · `c2-ocr.mjs`) — B2/B3 để ở /tmp đã mục nát (bài học); C2 10/10 RED (Node + Dart)
- [ ] Việc người thật: cho phép ERPNext thật cho C-verify (mock-only đến khi có lệnh) · migration correlation field cho SO/Quotation trước khi ghi thật
- [ ] ❓ Cần hỏi lại: duyệt C2 (AI không tự ký duyệt vùng ghi) · có làm C3+ (kind quotation?) hay quay lại verify SO/PO thật trước

---

## P0 (phases2) — Capability Contract + Safety + Golden Dataset (2026-09-17)

- [x] Capability Contract `mcp-erpnext/capabilities.json` + loader validate fail-closed (7 capability, `scope.company` có từ P0)
- [x] Router đọc trigger từ contract (không hardcode rời)
- [x] Safety Gateway `src/safety-gateway.mjs` là cửa DUY NHẤT cho WRITE + **test tĩnh no-bypass**
- [x] Kill switch `global_read_only` (env/flag file) ⇒ 503 `SYSTEM_MAINTENANCE`, không tiêu tốn `command_id`
- [x] `custom_ai_action_id` Data/unique/indexed **ĐÃ TẠO + VERIFY trên ERPNext demo** (`scripts/add-correlation-field.mjs`, idempotent) + `action_id` ghi khi tạo PE + reconcile theo field
- [x] Golden Dataset v1 200 câu/6 bucket, runner + threshold: read 50/50 · write 30/30 · kinship 39/40 · money 29/30 · ambiguous 30/30 · adversarial 20/20 · **Node 152/152**
- [x] Untrusted-data/prompt-injection filter + test bắt buộc (tên khách chứa injection không kích WRITE)
- [x] `document.delete` bị cấm trên AI path (403 `FORBIDDEN_IN_AI_PATH`, không proposal)
- [x] Command store persistent: 4 test khoá hành vi (không /tmp · sống qua restart · atomic · torn file)
- [x] ✅ **ĐÃ COMMIT + PUSH `b4acdb1`** đợt P0 (user duyệt 2026-09-17) — bằng chứng `result44.txt` + `.plan/phases2/p0-result.md`
- [x] Vòng tự review sau P0: **3 lỗi crash/safety THẬT đã sửa + falsify** (config lỗi không còn giết process; không còn treo vĩnh viễn khoá ý định `(customer|invoice)`; đóng process con khi `initialize()` fail; test tĩnh no-bypass quét thêm `scripts/`) — chi tiết `result44.txt` §3–§8, **Node 152 → 156**
- [ ] Việc người thật: xác nhận 1 phiếu demo thật mang `custom_ai_action_id` · diễn tập `global_read_only` (tạo/xoá flag)
- [ ] Gap đã biết của Golden Dataset (thuộc Phase 1, cần falsify riêng): `k18` "Con Linh" (`money.py:FILLERS` chứa "linh") · `m15` "một triệu hai" · `k36` "Bác sĩ Nam"
- [x] **P1 (phases2) — Entity Execution Resilience KỸ THUẬT XONG (chờ duyệt commit — vùng tiền)**: entity 4 trạng thái (`EXACT/FUZZY_SINGLE/AMBIGUOUS/NO_MATCH`) · WRITE HIGH không auto-select fuzzy + AMBIGUOUS → candidate picker (Flutter `entity_picker.dart`, `/ask` nhận `entity_id`, server re-validate trên fresh read) · immutable proposal snapshot (`proposal_id`/`version`/`expires_at`) · mã tách `PROPOSAL_EXPIRED` vs `PROPOSAL_VERSION_STALE`/`PROPOSAL_ENTITY_CHANGED` · `UNKNOWN_EXECUTION_STATE` → RECONCILING theo `custom_ai_action_id` · business dedup (fingerprint) warn + `dedup_ack` qua `/execute` · NLP down → chặn WRITE phụ thuộc amount · **Node 156 → 172** · Flutter 63 → 67 · Python 60/60 · analyze 0 · review vòng 2: fix harness `_bodyOf` (dio đưa Map nguyên vào adapter, không phải chuỗi JSON — result45 §1) + soi 2 điểm wiring (cancel lock-release CỐ ÊN không qua kill-switch; entity_id re-validate) — bằng chứng `result45.txt`
- [x] **P1 COMMIT `ee93f13`** (user duyệt 2026-09-17, đã push) — 32 file, Node 173, evidence result44/45
- [x] **P2 (phases2) — Session context + Uncertainty UX KỸ THUẬT XONG**: taxonomy 11 mã + copy TV bắt buộc (`uncertainty.mjs`) · session context provenance+TTL 30m/10m, hết hạn = xoá (`session-context.mjs`) · WRITE chỉ nhận context `user_selected`/exact, hết hạn → hỏi lại (fail-closed) · `KNOWN_INTENT_UNIMPLEMENTED` cho capability stub (cần thêm "doanh thu" vào routing sales trong contract) · Flutter `PipelineProgress` 4 pha · falsify 3 luật trên bản sao /tmp (F1 provenance, F2 TTL, F3 thứ tự refusal) · **Node 181 · Flutter 69 · Python 60 · analyze 0** · `.plan/phases2/p2-result.md`
- [x] **P2 ĐÃ COMMIT `33ff725` (đã push)** — 15 file +717/−35; secret scan CLEAN; suite Python 60 · Node 181 · Flutter 69 · analyze 0
- [x] **P3 (phases2) — LLM Classifier + Regression gate KỸ THUẬT XONG**: classifier semantic-only qua LLM Router (không agent loop/DSH) · không bao giờ trả ERP id (regex + allowlist 2 lớp) · intent ∈ contract (forbidden không offerable) · routeByCapability → cùng Safety path · LLM down → rule-only, low confidence → LOW_CONFIDENCE · golden classifier regression 9 case mock LLM (CI gate) · falsify F1/F3/F4 trên /tmp · fix 1 test flaky có sẵn (bucket P1) · **Node 195 · Flutter 69 · Python 60 · analyze 0** · `.plan/phases2/p3-result.md` · `result47.txt`
- [x] **P3 ĐÃ COMMIT `c38e4ea` (đã push)** — 13 file +1025/−7; secret scan staged diff CLEAN; suite Python 60 · Node 196 · Flutter 69 · analyze 0
- [x] **P4 (phases2) — Learning loop KỸ THUẬT XONG + ĐÃ COMMIT `d7e9ba9` (đã push)**: `learning-log.mjs` JSONL never-throw (dir repo-local, không /tmp) · `scripts/learning-cluster.mjs` READ-ONLY + `npm run learning:cluster` · workflow người duyệt (`docs/learning-loop-workflow.md`) · **vòng thử thật**: cluster phát hiện "doanh số" chưa route → thêm trigger vào contract (+1 keyword) + golden +2 case → 7/7; review vòng 2 bắt 2 lỗi (copilotAsk/dsh chưa qua wrapper log; claim "E2E 1 dòng" CHƯA có test ⇒ viết test E2E thật) · **Node 204**
- [x] **P5 (phases2) — DSH explicit opt-in READ KỸ THUẬT XONG + ĐÃ COMMIT `6318eca` (đã push)**: `dsh-optin.mjs` — dsh chỉ chạy khi spawn với `COPILOT_DSH_CONTEXT=1`, `/ask` KHÔNG có đường nào spawn dsh (test tĩnh quét `src/`) · trong context dsh: mọi WRITE bị `DSH_WRITE_BLOCKED` TRƯỚC skill factory (proposal null) · `docs/dsh-optin.md`; review vòng 2 fix 2 lỗi (`DSH_WRITE_BLOCKED` thiếu trong taxonomy P2 ⇒ refusal không có copy TV; bị xếp nhầm bucket `error` trong cluster) · **Node 212**
- [x] **P7 (phases2) — Background job queue KỸ THUẬT XONG + ĐÃ COMMIT `3e6240a` (đã push)**: `job-queue.mjs` (JSONL repo-local, enqueue chỉ khi verdict `retry_same_command_id`, bounded retry, crash-recovery RUNNING→RETRYING, `release()` cho cancel, `completed()` cho report) · **`startJobRunner()` nối vào `main()`** (F-A: trước đó job enqueue mà KHÔNG ai drain) · `/jobs` trả pending + completed · **5 finding review + 4 falsify** · TTS ⏭ skip có lý do (việc client) · **Node 228**
- [x] **P10 SLICE (phases2) — RATE LIMIT + CORRELATION ✅ ĐÃ COMMIT `7cb2798` (đã push)**: `rate-limit.mjs` enforce luật ĐÃ KHAI trong contract từ P0 (read 30/phút · write_proposal 10/phút · write_execute 5/phút · `payment.create` 20/giờ) — vượt ⇒ **429 + Retry-After + câu TV**; **throttle TRƯỚC Safety Gateway ⇒ KHÔNG đốt `command_id`** (đo thật: `store.status(cid) = null`, 0 PE, sau cửa sổ mở lại ghi đúng 1 lần) · `proposalBucketFor()`: câu ĐỌC không tiêu ngân sách ghi (mọi route đọc CŨNG trả proposal) · `COPILOT_RATE_LIMIT=off` là opt-out duy nhất; config hỏng ⇒ fallback default THẬT + cảnh báo · correlation §17 (`request_id/user_id/command_id/action_id/erp_document_id/latency_ms`) trên `/ask` + `/execute` + job runner qua `logEvent()` · **3 lỗi thật của chính code đã sửa**: viết lại `capabilityForAction` (nhánh không tồn tại ⇒ limit `payment.create` tắt lặng lẽ), `export {x} from` không tạo binding (⇒ mọi `/ask` 500), meter theo "có proposal" thay vì theo loại contract · **12 test mới · Node 240 · falsify 4 guard** · bằng chứng `result51.txt` + `.plan/phases2/p10-result.md` (**slice**, không phải P10 full: DR drill/dashboard/load test chưa làm)
- [x] **Đợt commit của P10 slice — đã đẩy hết lên branch**: `7cb2798` (rate-limit + correlation) · `21d77ff` (test E2E per-capability + `docs/kill-switch-runbook.md`) · `d6295ab` (bài học vòng 3). Working tree sạch, `change/flutter-chat-mvp` đồng bộ origin.
- [x] **Review vòng 3 P10 slice (2026-09-18, sau commit) — 2 điều thật**: **F5** `p7-result.md` claim "✅ in-app polling" KHÔNG có client (0 hit `/jobs` trong `apps/mobile/lib`) ⇒ đính chính claim + ghi gap; **F6** mọi test HTTP đều truyền `perCapability: {}` ⇒ **đường per-capability chưa từng được test ở tầng wiring** (đúng lớp lỗi F1 đã hỏng im lặng) ⇒ thêm test E2E per-capability (429 + `store.status(cid)=null` + log `scope:"per_capability"` + cửa sổ mới cho qua), **falsify bằng cách tái tạo lỗi F1** (`capabilityId = null`) → test mới + correlation test **FAIL**, restore IDENTICAL · **F7 ĐÃ GIẢI QUYẾT (policy a do user chọn, 2026-09-18 — commit `3b41313`)**: refusal `SYSTEM_MAINTENANCE`/`CAPABILITY_DISABLED` xảy ra TRƯỚC khi thử ghi ⇒ không phải một lần thử — job về lại RETRYING, attempts roll back về 0, backoff hẹn lại, JSONL `TEMPORARY_REFUSAL`; tắt switch ⇒ tự chạy lại VERIFIED đúng 1 lần (bằng chứng `result53.txt`)
- [x] **`docs/kill-switch-runbook.md`** (mới — tài liệu vận hành): 2 lớp storage (flag file hiệu lực NGAY, env cần restart) · disable theo capability · bảng kỳ vọng từng đường (`/health` ok · `/ask` ok · `/execute` 503 `SYSTEM_MAINTENANCE` · cancel VẪN chạy · `command_id` không bị tiêu) · lệnh xác minh curl · audit line stderr · **§4 tương tác với job queue (F7)**
- [x] **P6 (phases2) — Voice / STT (`speech_to_text`) ✅ ĐÃ COMMIT `9b54d35` (đã push)**: gate 150 câu audio **ĐÃ BỎ** (user 2026-09-18) ⇒ dùng **STT của OS** (`speech_to_text` 7.5.0), không tự host model · luồng đúng `plan2_final` §20: mic → STT → text vào **CHÍNH ô nhập editable** → user sửa → Gửi → `POST /ask`; **không auto-Send**, **không đường nào tới `/execute`** · `speech_service.dart` interface mỏng mockable + `SystemSpeechService`; `SpeechStatus` tách `denied`/`unavailable` để báo đúng việc cần làm · quyền `RECORD_AUDIO` + `<queries>` `android.speech.RecognitionService` (repo KHÔNG có target iOS ⇒ keys `Info.plist` ghi lại trong result) · locale `vi_VN` + cảnh báo fallback; dictation giữa lúc đang gõ không xoá chữ đã viết; partial **thay** không nối; `dispose()` đóng mic · **21 test** (15 widget mock STT + 6 unit trên subclass plugin thật) **+ falsify 8 guard** · self-review tìm **4 lỗi thật** đã sửa (kết quả STT muộn ghi đè ô nhập đã gửi · thông báo che "Đang nghe…" · double-tap 2 phiên · `cancel()` không thực thi hợp đồng) · **Flutter 101** (80→101) · analyze 0 · bằng chứng `.plan/phases2/p6-result.md`
- [x] (P6 — CI) **APK build lại trên GitHub Actions: run `35367603981` ✅ success** (head `bbca7ca`, artifact `erpn-chat-debug-apk` 84.169.705 bytes, hết hạn 2026-12-17) — plugin native build được trên CI. **Xác minh binary chứa bản fix** (không chỉ tin status): tải artifact → `grep -c` trong `assets/flutter_assets/kernel_blob.bin`: chuỗi mới "Máy không liệt kê tiếng Việt" = 2 · câu SAI cũ "Máy không có bộ nhận dạng tiếng Việt" = **0** · `vi_VN` = 3 (`result55.txt` §8) — *lưu ý: bản APK đó còn gợi ý nhẹ; UX follow-up bỏ gợi ý nhẹ **chưa được build lại** (cần push commit UX này)*
- [ ] (P6 còn lại — human) cài APK trên **máy thật có Gboard tiếng Việt** + smoke mục 7 `p6-result.md` (đọc ra đúng chữ · **không hiện dòng nào về "tiếng Việt"** · cùng máy, thu hồi quyền micro ⇒ vẫn phải hiện thông báo quyền · không tự gửi/nộp) → theo dõi ở `human.md` §2
- [x] **P6 UX "Tự gửi sau khi nói xong" ✅ ĐÃ COMMIT `f55d557` (đã push) (mobile client)**: switch trong Settings — mục "Giọng nói", **mặc định OFF**; ON ⇒ final STT + ô nhập có text + không loading ⇒ gọi **cùng** `onSend()` (`POST /ask`), không path riêng, không auto-confirm WRITE, không `/execute`; partial/transcript rỗng không gửi. Key `settings_voice_auto_send_v1` (fail-safe OFF, bật ON không cần dialog) · **+13 test** (11 tính năng + 2 review vòng 3) · falsify A/B/C · **Flutter 120** (107→120) · analyze 0 · bằng chứng `result55.txt` §10–§11 · **[review vòng 3]** gỡ guard chết thứ 3 (chỉ còn 1 điều kiện `voiceAutoSend`) · sửa 2 doc sai · sửa báo-sai-kết-quả-lưu (`ok = okGateway && okSubmit && okVoice`) · ❓ chờ user chọn hướng cho `pauseFor: 3s` (`human.md` §1)
- [x] **Bugfix P6 — cảnh báo sai "Máy không có bộ nhận dạng tiếng Việt" ✅ ĐÃ COMMIT `77e2b57` + docs `bbca7ca` (đã push)**: `locales()` của plugin **chỉ phủ recognizer ON-DEVICE** (doc nguyên văn: list "may not be the complete list of languages available for online recognition") ⇒ thiếu `vi` KHÔNG phải "máy không hỗ trợ". Sửa: luôn xin `vi_VN` (`fallbackLocaleId`, kể cả list rỗng) · thêm `localeVerified` **tách** "máy có liệt kê" khỏi "dùng được" · platform từ chối locale ⇒ retry 1 lần với mặc định máy · `error_language_not_supported/_unavailable` ⇒ bỏ locale ép, **không** tắt service · UI **không hiện gì về locale** (UX follow-up 2026-09-18: bỏ luôn gợi ý nhẹ; cảnh báo THẬT denied/unavailable/error_language_* giữ nguyên + có test) · nới copy `unavailable` · **+6 test** (service 6→11, widget 15→16) + **falsify 4 guard** (D tái tạo ĐÚNG code cũ ⇒ đỏ đúng ca bug) · **Flutter 107** · analyze 0 · bằng chứng `result55.txt` + `.plan/phases2/p6-result.md`
- [x] **P8 (phases2) — Multi-user / RBAC / company scope ✅ ĐÃ COMMIT `90401f0` (đã push)**: `src/authorization.mjs` (mới) đọc quyền từ `capabilities.json`, không hardcode capability nào trong logic · 2 chế độ `multi_user` (`COPILOT_USERS`) và `single_tenant` (mặc định, giữ hành vi cũ — đo thật: bỏ miễn trừ này làm đỏ **33 test**) · company **server-first** (principal → `COPILOT_COMPANY` → request) + allow-list; multi-user thiếu company ⇒ `COMPANY_SCOPE_REQUIRED` (map về copy P2 để user luôn có chữ) · wire: `/ask` chặn **trước** `route.factory()` (không proposal, không đọc ERPNext) · `/execute` chặn ở 1b **trước** idempotency (403, **không tiêu `command_id`**) · `/jobs` lọc theo actor (+`hidden`) · `/execute/cancel` chỉ chủ lệnh hoặc người có quyền · job replay mang `user_id` gốc ⇒ phân quyền tính lại lúc ghi · audit `user_id`+`company` vào record idempotency + job; log `/execute`/`/cancel` dùng `principal.user_id` · **17 test mới + falsify 13 guard** · self-review tìm **5 lỗi thật** (rò `/jobs` chéo user · cancel không kiểm ai · `COMPANY_SCOPE_REQUIRED` không copy · audit ghi sai người · allow-list không test nào chạm) · **Node 267** (250→267) · bằng chứng `.plan/phases2/p8-result.md`
- [ ] (P8 còn lại — human) `COPILOT_USERS`/`COPILOT_COMPANY` thật cho deployment + xác nhận user ERPNext thứ 2 bằng tài khoản thật (P8 test bằng fake principal) + smoke 2 bước trong `p8-result.md`
- [ ] (P10 full) còn lại: backup/restore drill · chạy thử runbook kill-switch trên gateway thật (human) · load/smoke + APK device (human) · compliance note · rate-limit store phân tán (hiện in-process, reset khi restart) · Flutter chưa poll `GET /jobs` (gap UX P7 đã đính chính)

---

## Yêu cầu sản phẩm gốc (KHÔNG xoá — tiêu chí nghiệm thu app)

- [ ] Mọi hành động thao tác app phải mượt, nếu có process ngầm phải show loading indicator
- [ ] Không giới hạn tính năng sử dụng, muốn sử dụng tính năng pro phải xem ads, và chỉ sử dụng được trong ngày. Ngày hôm sau muốn dùng pro tiếp phải xem ads.
- [ ] App không được giật lag ở mọi chức năng, mọi process nặng đều đưa vào background process, để UI mượt
- [ ] Mọi thao tác nếu lỗi / không cho phép phải thông báo qua toast notification
- [ ] Code ở Flutter & đồng bộ hoàn thiện ở native integration
- [ ] Data cần được đồng bộ, nếu có thể để 1 nơi, đừng để rải rác rồi quên đồng bộ — tránh lệch số liệu

> 6 mục trên là yêu cầu sản phẩm, không phải task. App giờ ĐÃ có giao diện chat
> (Phase 3) nhưng chưa mục nào verify được trên thiết bị thật — chờ APK CI.

---

## Đã làm ✅

### Phase 0 — Foundation & Verification
- Verify toàn bộ external dependency thật (npm/GitHub API/docs) → chốt: dsh runtime,
  pin `@casys/mcp-erpnext@3.0.4` + stdio, STT order (Web Speech → Cohere → Whisper → PhoWhisper),
  xây mới NLP/Router. Chi tiết: `phase-00-result.md`, `result1.txt`

### Phase 1 — Vietnamese NLP Pipeline (`src/vietnamese_nlp/`, Python stdlib thuần)
- Number normalizer → integer VND; kinship stripper 21 title; synonym mapper 10 nhóm intent;
  quantity extractor; CLI độc lập; fail-safe tiền là điểm cốt lõi
- **58/58 test PASS · money 259/259 = 100%** (corpus 3 miền, 37 negative)
- 2 đợt fix thật: 3 bug số-tiền-sai-im-lặng (result1) + 4 false positive & slang trẹo/chai &
  hậu tố dính liền (result2/3)
- **Đợt fix result9:** kinship CHỈ strip cụm xưng hô ĐẦU câu (title giữa câu là phần tên thật
  trong DB) — test corpus cập nhật theo, 58/58 vẫn xanh

### Phase 2 — MCP ERPNext read-only + skill layer + cầu nối
- Skill layer (`mcp-erpnext/`): readonly-guard chặn write ở tầng code, 12 tool đọc thật,
  chống bịa ID, markUntrusted; pin 3.0.4 lockfile; mock server đúng shape 3.0.4
- Cầu nối Python HTTP (`nlp_service/server.py`, stdlib, 127.0.0.1) — đúng quyết định đã khóa
- Copilot MCP server 1 tool `copilot_ask` cho dsh; env-switch real/mock (sai config → hard error)
- dsh 0.1.5-rc.1 headless E2E thật với ERPNext thật (269.000đ khớp 3 hóa đơn) — `result6.txt`
- **Đo accuracy thật theo exit-criteria (result9, commit `119edd4`): 18 câu tiếng Việt
  qua `answerQuestion()` với ERPNext thật — 27.8% → 61.1% → 18/18 = 100%** sau khi fix
  5 nhóm lỗi unit-xanh-không-bắt-được. **Test: 40/40 node · 58/58 Python**
- Fail-safe tiền củng cố: ambiguous fallback chỉ nhận fragment ≥ 2 từ, không thì null + hỏi lại

### Phase 3 — Flutter chat MVP (client đích đã chốt Flutter, không phải PWA)
- `apps/mobile` (Riverpod + dio): màn hình chat, lịch sử (SharedPreferences), empty state,
  SnackBar lỗi giữ text; gọi HTTP `/ask` wrapper trên VPS (không nhúng key vào app)
- `/ask` HTTP wrapper (`http-ask.mjs`) + GH Actions workflow build APK debug (artifact
  `erpn-chat-debug-apk`); sửa workflow thêm step build_runner (gitignore `*.g.dart` gây
  CI fail run 1)
- Flutter analyze 0 issue · 13/13 test · Node 40/40 · Python 58/58
- Bug thật sửa nổi bật: ChatBubble không bao giờ render answer (bắt bằng debug widget test)

### Hạ tầng dự án
- 4 commits: `33f9dc0` (Phase 1) → `0ac8e61` (Phase 2 real) → `590b1b2` (Phase 3) →
  `119edd4` (fix result9) → `87fcbb1`/`e2f5caf`/`49317a7` (Phase 5 router + review 2 vòng). Branch `change/flutter-chat-mvp`, remote origin = github.com/hoangsoft90/erpn_mobile1
- 2 project skills (`.agents/skills/`, local-only vì repo gitignore `.agents/` — user
  chốt 2026-09-16: KHÔNG đưa vào repo):
  `erpnext-mcp-connect` (kết nối/authorize ERPNext MCP) + `erpn-verify-first` (quy trình
  chống "code xong đi sửa" — 5 phiên bài học)

---

## Chưa làm / đang làm (thứ tự)

### Đang làm
- [x] **DSH RUNTIME DISCOVERY (`.plan/dsh_prompt_fix1.md`) — ✅ ĐÃ COMMIT `dc60a4e` + PUSH (user duyệt vùng an toàn) + CI run #22 success** — bằng chứng `result59.txt` + `result60.txt`
  - [x] **Lỗi gốc đã sửa**: resolver hardcode `/tmp/dsh-run/...` ⇒ máy Mac (chạy `npx @deepseek-ai/dsh web`, KHÔNG cài trong repo) báo "entry missing". Nay `resolveDshRuntime()` 6 mức: `DSH_ENTRY` → `DSH_COMMAND` → package local → **`npx --yes @deepseek-ai/dsh@<pin>`** → `/tmp/dsh-run` (*chỉ khi file tồn tại thật*) → unavailable; pin đọc từ `package.json` lúc chạy.
  - [x] **Một chỗ spawn duy nhất**: `dshSpawnPlan()` (argv-shaped, không shell string) — gateway local + `scripts/dsh-remote-runner.mjs` dùng chung (không có implementation thứ 2).
  - [x] **Bằng chứng**: `npm run dsh:check` PASS (`source=npx-pinned` + `--version -> 0.1.5-rc.1`) · `/dsh/health` trả thêm `source` · WRITE block 31ms (`DSH_WRITE_BLOCKED`) · `/ask` không dính dsh (171.800đ/4 khớp ground truth).
  - [x] **3 lỗi thật vá thêm khi chạy**: health phải chạy `--version` thật (không suy luận từ file) · response lỗi `/dsh/ask` mang `log_tail` = lý do thật · check script WARN khi `source=legacy-tmp`.
  - [x] **Falsify 4 lớp** (gỡ npx / đảo ưu tiên legacy-trước-npx / health không chạy thật / gỡ nhánh `DSH_COMMAND`) → ĐỎ đúng chỗ, khôi phục IDENTICAL.
  - [ ] 🚧 **BLOCKED_EXTERNAL**: DSH READ chạm ERPNext thật lần cuối không chạy — `llm9000.loca.lt` trả **503 Tunnel Unavailable** (người thật bật lại `lt` trên Mac). Cùng code đã PASS thật lúc 09:19 trong phiên (171.800đ/4); dsh spawn thật được chứng minh bằng 7 call router + `log_tail` chứa output của chính dsh.
  - [x] **Commit + push**: `dc60a4e` (fix vùng an toàn) + `03338ae`/`7476051` (docs) → `2edafa4..7476051`; **CI run #22 `35435259669` success** (dispatch tay vì push chỉ-backend/docs không trigger); APK verify binary thật (label `Nghiệp Vụ AI`, marker chế độ AI/TTS trong `kernel_blob.bin`) — `result60.txt`.
  - [ ] Việc người thật: chạy `npm run dsh:check` **trên chính Mac** (agent không truy cập được) để xác nhận `source=npx-pinned` · cài APK run #22 + smoke **chế độ AI** trên thiết bị.
- [x] **✅ ĐÃ COMMIT `4546997` (user duyệt 2026-09-16, "commit nhưng KHÔNG push" — branch ahead 1)**: 4 file Dart `chat_models.dart` (parse tolerant `rejection_problems`) · `proposal_card.dart` (4 guard `mounted` sau await + banner luôn render + **F2 keep-alive `AutomaticKeepAliveClientMixin`**) · `chat_data_test.dart` · `proposal_card_test.dart` (+5 test hồi quy; Flutter 34→**39**). Lệnh + output thật ở `result40.txt` + `result42.txt`; đã **falsify cả 3 fix** (F1/F3 ở result40, F2 ở result42 §4). Message đề xuất (gộp 3 fix theo yêu cầu user "đợi làm F2 rồi gộp"): `fix: chat UI crash/fail-open guards + keep a written card alive — mounted after await; tolerant problems[]; keep-alive stops the confirm button returning after a ListView recycle`
- [x] **F2 — USER ĐÃ CHỌN (b) `AutomaticKeepAliveClientMixin`** ✅ implement + falsify (result42): card giữ state cục bộ qua recycle (`wantKeepAlive = _confirming || _result != null || _error != null || _rejectionCode != null` — card chưa bấm vẫn scroll bình thường); test `result41 F2` trong `proposal_card_test.dart` (ListView 60 item, drag −5000/+6000) · hạn chế: không sống qua app restart (option (a) mới persist — ĐỔI SCHEMA), nhưng bấm lại sau restart vẫn replay cùng `command_id`
- [ ] **CẦN USER QUYẾT (còn lại sau result40)**: ① F4 — clone `attachRejection` đổi command_id khi seed null (latent) ② F6 — field parse nhưng không dùng ③ F7 — `waitForNlpService` fetch thiếu AbortSignal ④ F8 — `int(Content-Length)` non-số ở nlp_service ⇒ traceback stderr
- [x] **Fix F6 — ✅ ĐÃ COMMIT `9f496bf` (đã push 2026-09-16)**: review commit docs `2f7ec1f` (scope docs-only ✓, docs khớp code ✓) phát hiện `answerQuestion()` gọi `resolveCustomer()` 2 lần cho cùng câu `thu tiền cho <khách> <số>` (guard ngoài + nhánh `payment_write`) ⇒ mỗi câu tốn thêm 1 vòng full-catalog `findCustomer("")` chạm ERPNext, và 2 khối resolve dễ lệch nhau sau này (cùng nhóm bug guard-before-branch của fix `notIf` result31). **Fix**: nhánh write REUSE binding `customer`/`ambiguous`/`candidates` từ guard ngoài. Hành vi KHÔNG đổi — test E2E thật `copilot.test.mjs:251` vẫn xanh (`entity.name="Nguyễn Thị Lan"`, `amount_vnd=500_000`, `invoice=SINV-0001`). Test hồi quy `test/copilot-dup-resolve.test.mjs` + falsify (chèn lại call → FAIL `found 2`; gỡ → grep 0 marker, call site = 1). Suite: **Python 60/60 · Node 120/120 · Flutter 34/34 · analyze 0**. Message đề xuất: `fix: payment_write reuses the outer customer resolve (one round-trip per question, no second resolveCustomer call)`. Chưa stage `.env`/store/.plan/rác
- [x] **COMMIT đợt result31 — ✅ `bda54cf` (đã push 2026-09-16)**: 18 files +978/−66 (14 file code/docs + result31.txt + 2 handoff); secret scan CLEAN trên staged diff; `.env` + `idempotency-store` xác nhận git-ignored; không stage `.gemini//.opencode//initp` — router payment_write (+notIftIf deny-list) · /execute/cancel + bọc try/catch quanh store.cancel (F2) · copilot-server rawText (F3) · store.cancel() · faq.md · 3 test Node + 1 widget test · docs root · result31 §11 addendum. Message đề xuất ở result31 §7.
- [x] **Code review sâu chuỗi client (result16, 2026-09-15): 7 lỗi thật đã sửa** — 3 crash router (upstream stream không error listener / client ngắt giữa request / models path — đều giết process), 2 stuck (http-ask không deadline → socket treo vô hạn; NLP fetch không AbortSignal), 2 logic Flutter (cold-start race ghi đè lịch sử; mounted guard sau await). **+3 regression test. Node 49/49 (9s) · router 8/8 · Flutter analyze 0 · Flutter 14/14.** 4 lỗi của chính agent trong đợt này (finding sai, Promise.race timer không clear, test thiếu override, str_replace miss) đã vào skill mục 6. Chờ duyệt commit
- [x] **Phase 5 — LLM Router nối upstream thật** (result15, 2026-09-15): endpoint chính thức điền xong (zen `opencode.ai/zen/v1` · gemini `generativelanguage.googleapis.com/v1beta/openai`); **2 bug router tự bắt khi chạy thật** (https transport + field `store` Gemini từ chối → `stripFields`) + `LLM_ROUTER_DEBUG=1`; **Gemini verify generate thật 200** qua router · **Zen bị chặn billing** (CreditsError: No payment method — glm-5.3-flash là PAID, big-pickle chỉ chạy trong OpenCode client); cơ chế dsh thật = cordis patch row (settings.yaml result6 lỗi thời) → skill mới `erpn-dsh-setup`; **E2E dsh→router→Gemini flaky do free tier 20 req/phút** (1 session dsh tốn 2–3 calls: 429 quota + 503 high demand nguyên văn trong result15 §6)
- [x] GH Actions run #2 ✅ **SUCCESS** (`result10.txt`): [run 34826575147](https://github.com/hoangsoft90/erpn_mobile1/actions/runs/34826575147) — build_runner/Analyze/Test/Build APK đều xanh; artifact `erpn-chat-debug-apk` (80MB zip) đã tải về VPS `/home/kythuat_hoangweb/erpn-apk/app-debug.apk`
- [x] **APK nối được VPS — endpoint security** ✅ (`result11.txt`, commit `c3d74c3`): http-ask bind policy (non-loopback BẮT BUỘC basic auth, public cần ASK_ALLOW_PUBLIC=1 — server tự từ chối cấu hình unsafe) + Flutter client gửi auth qua dart-define + CI build APK từ repo Variables/Secret. Verify thật: 401 không auth → 200 có auth → trả lời 269.000đ qua ERPNext thật. ⚠️ **Port 8788 bị cloud firewall hosting chặn từ internet** (read_url timeout) — cần user mở port HOẶC dùng Tailscale (đã cài, chờ login)
- [x] **Mandatory Sign-off Phase 5 ĐÃ KÝ (2026-09-15)**: `SIGNOFF-phase5-pii.md` — 4/4 quyết định đã điền. Hoàng xác nhận qua trao đổi trực tiếp: **KHÔNG PII scrubbing, KHÔNG LLM Router 2-tier** — gửi thẳng tên khách/số tiền cho LLM, free tier được dùng (rủi ro pháp lý chủ dự án tự chấp nhận, đã ghi minh bạch trong sign-off). **Gate MỞ** → phạm vi Phase 5 còn: LLM Router đơn giản + audit log (bỏ mục scrub)
- [x] **Phase 5 khởi động — LLM Router bản đơn giản** ✅ (result14): `scripts/llm-router.mjs` (proxy OpenAI-compatible 127.0.0.1:8900, fallback chain config-driven JSON, cooldown upstream lỗi 429/5xx/timeout) + `scripts/llm-router.config.json` (mock → zen → gemini-openai, 2 upstream thật còn PENDING verify key/baseURL) + audit JSONL `llm-router-audit/` (không chép nội dung câu hỏi). **Test: 7/7 router + 49/49 mcp-erpnext; E2E smoke thật qua mock-llm.** Còn lại Phase 5: nối dsh → router, verify rate limit/baseURL thật khi có key
- [x] **Tunnel localtunnel verify E2E thật (2026-09-14)** ✅: user chạy `lt -s erpn8788 --port 8788` trên **máy Mac** (forward qua SSH tới VPS) → từ VPS test qua tunnel: `/health` 3/3 = 200 · `/ask` HTTP 200 · **"Khách smoke 2026-09-13-p1done còn nợ 269.000đ (3 hóa đơn chưa trả)" khớp ground-truth result9**. Lưu ý: curl phải kèm header `bypass-tunnel-reminder: 1` (không có → 502 Bad Gateway từ tunnel server, dễ nhầm là service chết). Quy trình chuẩn hóa ở `mcp-erpnext/LOCAL-TEST.md` + npm script `start:ask`. ⚠️ URL tunnel public KHÔNG auth (http-ask bind loopback) — chỉ bật khi test, Ctrl-C ngay khi xong. COPILOT_BASE_URL cho APK có thể trỏ tunnel này (HTTPS qua firewall)
- [ ] **Chờ user dán 3 giá trị vào GitHub Settings** (token hiện tại chỉ-đọc, PUT 404): Variables `COPILOT_BASE_URL=https://erpn8788.loca.lt` (tunnel HTTPS đã verify E2E thật — result13) + `COPILOT_AUTH_USER=copilot` (user lấy từ `.env` ASK_USER), Secret `COPILOT_AUTH_PASSWORD` (= ASK_PASSWORD trong `.env`) → CI build APK cài được luôn. ⚠️ Tunnel chỉ sống khi `lt` đang chạy trên máy Mac của user. **Endpoint lâu dài: user chốt 2026-09-16 HOÃN** — Cloud Shell = workspace dev, Mac/ngrok/tunnel = demo tạm; chuyển VPS thật SAU khi app xong; đừng tự thiết kế production
- [x] **Kịch bản thu âm** ✅ `docs/audio-collection-script.md`: 150 câu 3 miền có ground truth (A-G), chỉ tài liệu

- [x] **Commit đợt result17** ✅ `be57052` (đã duyệt + push): gateway mang `thought_signature` + harness E2E + docs
- [x] **Session E2E sau review (result18) — CHẶN BỞI QUOTA**: session nhận **6× 429 `RESOURCE_EXHAUSTED` "generate_content_free_tier_requests, limit: 20, model: gemini-3.6-flash"** + 1× 503 (nguyên văn trong result18 §D). ⚠️ **Số liệu ở bản đầu của mục này đã SAI và đã được sửa (result18 §J)**: tôi viết "audit có 20 lần 200 = chạm trần" nhưng **chính con số đó cũng sai** (đếm thô, chưa lọc `attempts` có `gemini`): đếm lại bằng script = **17** lần 200 qua provider thật trong ngày LỊCH = **10** trước + **7** từ mốc reset ~07:00 UTC (nửa đêm Pacific). Audit router thêm nữa **không ghi** các lần curl trực tiếp nên không phải sổ quota đầy đủ. Bằng chứng hành vi: 429 bền vững sau **>15 phút** im lặng (không phải trần theo phút), nhưng **mốc/định nghĩa bucket chưa xác lập chắc** (2 ứng viên: 7 theo mốc 07:00 UTC vs 17 qua router + ≥2 probe trực tiếp ≈ 19-20 theo mốc 00:00 UTC) → đã ghi cả hai con số thay vì khẳng định. Router KHÔNG lỗi (mọi 502 đều `attempts:[gemini-openai]` = đã thử thật). **Dừng theo kỷ luật, không retry trong ngày.** ⚠️ Turn replay tool chưa lần nào 200 ⇒ logic thought_signature **chưa verify live bằng code sau review** (mới hermetic 19/19) — phải nói rõ, không được coi là xong.
- [x] **E2E 0-quota XANH (bù cho hạn chế trên)** — mock LLM wildcard + mock ERPNext với code sau review: trả đúng `Nguyễn Thị Lan còn nợ 2.500.000đ`, audit 200×3 turn **gồm cả turn replay tool** (`messages:7`) ⇒ plumbing nguyên vẹn. Thêm `scripts/llm-router.mock.json`; phát hiện model filter loại mock (đúng thiết kế — mock không được trả lời thay LLM thật) nên mock upstream phải là wildcard (không khai `model`).
- [x] **Commit đợt result18** ✅ `8d9f04c` (đã duyệt + push): mock config 0-quota + docs.
- [x] **E2E lần 2 sau review (result19) — CHƯA CHẠY ĐƯỢC, và phép đếm quota cũ bị BÁC BỎ bằng chính lần chạy**: làm đúng §G.1 user chỉ định (đếm `status 200` qua router từ mốc 07:00Z + cộng probe trực tiếp = **8 < 20**; doc chính thức xác nhận "RPD quotas reset at midnight Pacific" = 07:00 UTC) → chạy **đúng 1 session** → **7×429** `generate_content_free_tier_requests, limit: 20, model: gemini-3.6-flash` (nguyên văn result19 §C). Sắp theo thời gian: 429 bắt đầu từ request **#17** và **mọi request sau đó đều 429** (kể cả lúc gần như idle) ⇒ con số 20 bị tiêu bởi nhiều nguồn `status 200` không thấy: **mỗi turn dsh = 6–8 request** provider, retry nội bộ, probe trực tiếp không qua audit. **Luật mới (dùng từ nay)**: ① đếm REQUEST GỬI TỚI PROVIDER (`attempts` chứa upstream thật), không đếm 200; ② ngân sách 20/ngày ≈ **1 session dsh**, không phải 20; ③ **429 đầu tiên trong ngày quota = hết ngày** → dừng MỌI request (probe "kiểm tra cho chắc" cũng là 1 request), chờ reset; ④ việc verify quan trọng chạy vào request ĐẦU TIÊN của ngày quota. Vẫn **chưa verify live** `thought_signature` (session chết ở turn đầu). ERPNext thật đã sống lại (ping 200) — chặng đó hết bị chặn.

### Bị chặn — chờ người thật (không phải việc agent)
- [ ] **Rotate key ERPNext** — user (Hoàng) làm trực tiếp trên server; trạng thái 2026-09-14:
      key cũ vẫn hợp lệ (HTTP 200), rotation chưa hiệu lực (`result9.txt` §1)
- [ ] **Thu 100–200 câu audio thật 3 miền** — điều kiện còn thiếu của Phase 1, chặn Phase 4 (STT)
- [ ] **Cài APK lên thiết bị thật tại điểm bán + test** — checklist 1 trang sẵn: `docs/device-test-checklist.md` (cài → đọc → ghi nháp → restart → STALE/EXPIRED). Endpoint đã có đường sống: tunnel `erpn8788.loca.lt` verify E2E (result13) — dùng ngay khi `lt` chạy; demo luồng ghi có kịch bản sẵn: `docs/demo-payment-draft.md`. Sau đó user dán 3 giá trị GitHub Settings → CI build APK cài được
- [x] **Quyết định upstream LLM (user 2026-09-15)**: Zen ĐỂ SAU (billing-blocked giữ nguyên, không xóa config) · Gemini free tier được chấp nhận (không nâng paid; 429/503 = bình thường, retry ~60s). ⚠️ **Evidence result16 §6D: trần NGÀY (RPD=20) đã cạn hôm nay** (149 requests, 10 gemini 200) — "retry in Xs" của Google gây hiểu nhầm cho daily quota; E2E xanh chạy DUY NHẤT 1 session sau reset (~nửa đêm giờ Pacific ≈ 14-15h giờ VN)
- [x] **Review vòng 2 trên fix của mình (result16 §6C): 5 window-sau-await còn sót** — chain-loop abort check · models catch guard · exhausted-502 guard + audit 499 · debug-drain error listener · stripFields validation (string iterate ký tự xóa nhầm key im lặng). Router 10/10 (452ms) + 2 test mới (client-abort survival, stripFields). → **commit `49317a7` (đã duyệt + push)**
- [x] **E2E sau reset quota — 1 SESSION DUY NHẤT (result17, 2026-09-15 14:18 giờ VN)**: chạy đúng 1 lần, không retry. **Quota reset ĐÚNG dự đoán** — agent turn nhận **200** từ gemini-3.6-flash (latency 3.9s) ⇒ 429 trước đó đúng là daily cap. **NHƯNG session vẫn fail, thủ phạm là 2 bug THẬT của router mình viết**: ① 1 spike 503 làm chain RỖNG 30s → router từ chối 6 request tiếp theo NGAY (audit `attempts: []`, latency 2-3ms) mà không thử gì → dsh abort; ② báo lỗi SAI: "all upstreams failed (tried: none)" trong khi chưa hề thử. Đã fix (cooldown chỉ DEPRIORITISE, không disable đường duy nhất + phân biệt error type thật) + 3 test hồi quy → **router 13/13 · 562ms**. **Phát hiện thứ 3 (an toàn)**: `dsh` TỰ `process.loadEnvFile(<cwd>/.env)` lúc boot → `unset ERPNEXT_*` ở shell VÔ HIỆU, patch "ý định mock" bị ghi đè thành REAL (probe chứng minh, 0 quota) → fix bằng literal `''` → `mock -> mock (in-memory)`. Harness E2E giờ nằm trong repo: `mcp-erpnext/dsh-e2e.patch.yml` + `scripts/llm-router.e2e.json` (default MOCK, `E2E_TARGET=real` mới chạm ERPNext thật).
- [x] 🎉 **E2E XANH — chuỗi thật chạy hết (result17 §K, 2026-09-15 14:40 giờ VN)**: user báo ERPNext hết 500 → verify REST thật (ping 200, khách thật "Anh Ba — xây nhà") → lấy ground truth độc lập (ACC-SINV-2026-00047, outstanding **457.875**) → chạy **1 session**: dsh → router → Gemini → MCP tool → NLP → **ERPNext THẬT** trả nguyên văn *"Khách hàng **Khách làm tròn 2026-09-15-p1b-wf1-2** hiện còn nợ **457.875đ** (1 hóa đơn chưa thanh toán)."* — **khớp chính xác ground truth**, dsh exit 0. Session chịu **7 lần provider 503 high-demand** mà vẫn xong (trước fix cooldown chỉ 1 lần đã giết session).
- [x] **Root cause thứ 2 của chuỗi tool: Gemini 3.x bắt buộc `thought_signature`** (result17 §L) — turn thứ hai (có tool result) chết `400 (no body)`; tái hiện rẻ bằng payload tối giản → nguyên văn *"Function call is missing a thought_signature in functionCall parts... `default_api:copilot_ask`"*. Kiểm chứng: Gemini CÓ trả signature (`tool_calls[].extra_content.google.thought_signature`) nhưng dsh drop; **mọi model trên key đều chặn** (2.5-flash 404 user mới; flash-lite/3.1-flash-lite/3-flash-preview đều 400) ⇒ phải xử ở gateway. **Đã fix**: `ThoughtSignatureCache` + capture qua stream + inject lại khi id khớp, bật theo upstream `geminiThoughtSignatures`, cache có trần LRU → **router 17/17 (590ms)** gồm 1 test integration thật (SSE → turn sau upstream NHẬN được signature). **Test toàn bộ: router 17/17 · mcp-erpnext 49/49**
- [x] **Upstream `mac-custom` (LLM tự host trên Mac, KHÔNG quota) — verify + E2E XANH (result20, 2026-09-15)**: endpoint `https://llm9000.loca.lt/v1` model `oc/big-pickle` — tunnel flaky (502/408 lần đầu, retry được: probe 3 lần = 502, 502, **200 "Hello! How can I help you today?"**). Đã thêm ĐẦU chain CẢ 2 config (dev hàng ngày); gemini-openai GIỮ NGUYÊN chỉ để verify tương thích provider thật (`E2E_LLM_MODEL=real-gemini`, không sửa file — router route THEO TÊN MODEL nên patch dsh chọn model qua env). ⚠️ **ĐÍNH CHÍNH (result22 §9B)**: claim cũ "E2E qua mac-custom + audit 5 req (408, 502, 200×3) + 2 turn replay đều 200" **KHÔNG kiểm chứng lại được** — khung giờ đó (08:20–08:45 UTC) không còn file audit nào, file gần nhất (09:52 UTC) lại là `attempts=['mock']`. Phần **ERPNext/NLP** trong phiên đó vẫn đúng (457.875đ reproducible; bug credit-note 269.000đ là phát hiện thật, đã fix `6054458`). **E2E mac-custom có bằng chứng hợp lệ duy nhất = result22** (13:46:29 UTC: 4×200, `attempts=['mac-custom']`). ⚠️ **BUG MỚI tìm thấy qua E2E này**: copilot_ask trả **269.000đ/3 hóa đơn** cho khách smoke mới trong khi ERPNext thật = **171.800đ/4 hóa đơn chưa trả** — traced đến tận dòng code: `listUnpaidInvoices` lọc `outstanding_amount > 0` **loại credit note âm** (−97.200đ); tool thô 3.0.4 trả ĐÚNG 5 hóa đơn, NLP resolve ĐÚNG khách, LLM chỉ đọc lại kết quả tool. Vùng tiền — KHÔNG tự sửa, chờ user duyệt hướng `> 0` → `!== 0` + test (result20 §4)
- [x] **Commit đợt result20** ✅ `a379a71` (đã duyệt + push): mac-custom ĐẦU chain 2 config + `dsh-e2e.patch.yml` (model qua `E2E_LLM_MODEL`) + docs + result19/20
- [x] **Fix credit-note ĐÃ ÁP DỤNG + COMMIT `6054458` (result21)**: `outstanding_amount > 0` → `!== 0` ở `mcp-erpnext/src/skills/customer.mjs` (helper `listUnpaidInvoices` dùng CHUNG cho `getCustomerBalance` + sales) và `sales.mjs`; mock thêm credit note SINV-0004 (−320.000) + filter mock đổi theo; nhãn "hóa đơn chưa trả" → "**chứng từ** chưa thanh toán" + nhánh mới "hiện dư X" khi outstanding âm. **Verify THẬT** (probe gọi thẳng `answerQuestion` với ERPNext thật, không LLM — số tiền không phụ thuộc LLM): **457.875đ/1 chứng từ ✓** và **171.800đ/4 chứng từ ✓** (trước fix: 269.000đ/3). Test: Python 58/58 · mcp-erpnext 50/50 · Flutter 14/14
- [x] **Review vòng 2 đợt fix (result21 §6) — tìm thêm 3 lỗi THẬT trong chính đợt này**: **(A nặng)** `node --test` discover MỌI file trong `test/` nên 2 batch runner (`batch-accuracy.mjs` 18 câu + `batch-groundtruth.mjs` dump khách/hóa đơn THẬT) bị chạy như unit test → trong shell đã `source .env` sẽ bắn vào ERPNext THẬT + in tên khách/số tiền thật ra stdout; fix guard `NODE_TEST_CONTEXT` (probe: `child-v8` vs unset — guard argv[1] một mình SAI vì runner spawn từng file). **(B)** `http-ask.test.mjs` làm TREO cả suite >120s: shell leak `ASK_USER/ASK_PASSWORD` (test chỉ strip `ERPNEXT_*`) → `resolveBindPolicy` throw trong SETUP → child Python rò → không exit; fix strip `ASK_*` + đưa mọi setup vào try/finally. **(C)** 5 kỳ vọng eval cũ `"(N hóa đơn"` sẽ báo FAIL GIẢ sau khi đổi nhãn → thêm `DOC=/chứng từ|hóa đơn/`, chấm theo số tiền + số lượng
- [x] **Commit `6054458`** (đã duyệt + push): fix credit-note net + nhãn "chứng từ" + test hồi quy + guard batch runner + hermetic `ASK_*` (result21) — 18 files
- [x] **E2E đầy đủ qua `mac-custom` XANH (result22 §4, 2026-09-15 13:46Z)**: user bật lại `lt` → probe 3/3 **200** → dsh exit 0, trả **457.875đ/1** ✓ và **171.800đ/4** ✓ (lần đầu câu 171.800đ đi hết chuỗi thật). Audit (file `audit-2026-09-15T13-46-29.jsonl`) **4/4 request 200, `attempts=['mac-custom']`**, `messages` tăng **2→5→7→9** ⇒ **≥2 turn mang tool result** và đều 200. ⚠️ Số tool-call chính xác KHÔNG chốt được (transcript headless không in khối tool result; mức tăng không đều) — bản đầu ghi "2 tool-call, 2 turn replay" là quá mức bằng chứng, đã sửa (result22 §8A)
- [x] **Thử `E2E_LLM_MODEL=real-gemini` (đúng 1 lần, không probe trước) — VẪN CHẶN BỞI QUOTA (result22 §5)**: dsh 502 `llm_router_all_failed (tried: gemini-openai)`; provider thật **5×429 + 2×503** ⇒ trần ngày free tier vẫn cạn. ⚠️ **`thought_signature` VẪN CHƯA verify live** — lần thứ 4 liên tiếp; bằng chứng duy nhất vẫn là hermetic (router 19/19). Không retry trong ngày (đúng luật result19)
- [x] **Lần đầu E2E bị `408 (no body)` — đã loại trừ "endpoint yếu" bằng probe 0-session (result22 §6)**: payload 11.600 bytes → 200 (2.7s) · có `tools` → 200 (có `tool_calls`) · có `tools` + stream → 200 (43 dòng SSE) ⇒ 408 là **flaky tunnel**, chạy lại là xanh
- [x] **[2026-09-16] Điều tra audit biến mất — XÁC ĐỊNH ĐƯỢC NGUYÊN NHÂN, bỏ kết luận sai "cron bên ngoài" (result22 §9C đính chính)**: có phiên set `LLM_ROUTER_AUDIT_DIR=/tmp/audit17` (mỏ neo result17.txt:40) + `/tmp` = overlayfs ephemeral + host là **container Google Cloud Shell** (PID 1 = `/google/scripts/onrun.sh`, boot 21:44 UTC 15/09) ⇒ restart xoá sạch /tmp. Đã loại trừ: crontab, systemd timer, tmpfiles.d, router tự xoá, bash history. **File trong `llm-router-audit/` của repo KHÔNG bị ai xoá** — quy tắc mới: đừng bao giờ set AUDIT_DIR vào /tmp

- [x] **[2026-09-16] Đối chiếu Phase 5 đã ship với `.plan/phases/phase-05-ai-gateway-core.md`** (chỉ đọc + verify, không code mới):
  - **A. Gateway/runtime (dsh)** ✅ — dsh 0.1.5-rc.1 + copilot MCP server (125 tools, read-only guard) + cordis patch mechanism; single-user auth = built-in dsh (đúng mục tiêu spec); 2 trigger tách lớp chưa chạm (≥2 user đồng thời / breaking change) — ghi nhớ đọc lại trước Phase 10
  - **B. PII scrubbing** ⛔ **CHỦ ĐÍCH KHÔNG LÀM** — theo sign-off đã ký 2026-09-15 (không scrub, không 2-tier; chấp nhận gửi tên/số tiền cho LLM). Rủi ro Nghị định 13 được chủ dự án chấp nhận có ý thức trong bối cảnh dev/demo (user chốt 2026-09-16: production = SAU khi app xong) — điểm cần REVIEW LẠI trước khi có khách thật
  - **C. LLM Router config-driven** ✅ — `scripts/llm-router.mjs` + JSON config (mac-custom/mock/zen/gemini chain), fallback + cooldown, không hardcode model
  - **C.1 Mandatory sign-off** ✅ đã ký, gate giải phóng
  - **D. Audit** ✅ — JSONL per-session (fields: id/ts/upstream/model/attempts/status/latencyMs/messages/stream); tool call/result nằm trong `messages` từng turn ⇒ trace được 1 request từ input → tool result (đã chứng minh: messages 2→5→7→9, result22). Bài học durability đã khắc phục (audit ở repo dir, không /tmp)
  - **Exit criteria 2 (mobile không giữ key)** ✅ **VERIFY THẬT lần đầu**: tải artifact APK debug từ GH run 34976761017 (success), giải nén, quét TOÀN BỘ (assets/res/lib*/kernel_blob.bin) → **0 hit** cho ERPNEXT_API_KEY/SECRET, GEMINI/ZEN/MAC_LLM key; kernel_blob chỉ chứa TÊN dart-define (`COPILOT_BASE_URL/USER/PASSWORD` — giá trị nhúng khi CI build, đang chờ user dán GH vars). Debug APK = JIT (không libapp.so) — quét kernel_blob là chỗ đúng
  - **Exit criteria 3 (PII test case)** N/A theo quyết định sign-off (không scrub)
  - Còn mở Phase 5: verify `thought_signature` live (chờ quota — không phải mục spec, là tự đặt thêm)

- [x] **[2026-09-16] Phase 6 (display-only) — Risk Level + Action Proposal + UI card** (mức task lớn — **ĐÃ COMMIT `553d962`**, user duyệt 2026-09-16):
  - **Code mới**: `mcp-erpnext/src/risk-levels.mjs` (4 mức READ/LOW/HIGH/CRITICAL frozen; `riskFor()` map sẵn verb Phase 7 — create/submit=HIGH, delete/cancel=CRITICAL; `assertProposalAllowed()` chặn mọi mức >READ khỏi execute — safety mechanism TRONG CODE, không phải feature flag theo cảnh báo spec) + `mcp-erpnext/src/action-proposal.mjs` (`buildProposal()` object `erpn.proposal/v1` frozen: action/entity/risk/params/summary; thiếu field → throw, không default câm)
  - **copilot-server.mjs**: MỌI nhánh trả lời (customer/sales/payment/inventory) giờ mang `proposal` v1 (nhánh payment có thêm `next_action_hint` trỏ create_payment_entry/HIGH cho Phase 7); `resolveCustomer` phân biệt 3 kết quả — resolve / ambiguous + DANH SÁCH candidates (spec: "≥2 candidate gần nhau: hỏi lại user") / not-found thật (reason khác nhau, không trả "không tìm thấy" cho case trùng tên nữa)
  - **Flutter**: `ActionProposal` model + `ProposalCard` (badge risk theo theme, summary, entity ID, note "Sẽ cần xác nhận khi Phase 7") — KHÔNG nút [Xác nhận] (chủ đích, chưa có gì để execute); card hiện dưới bubble copilot
  - **Test**: Node 61/61 (mới: risk-proposal 7 — 4 mức có case riêng + execution block; ER battery 12 case tên trùng/gần giống pass 100% ≥ 90% exit criteria, kèm case "Lan"/"Hai" 1-từ multi-hit = ask-the-user; copilot E2E +2 proposal assertions) · Flutter 19/19 (mới: 5 widget test — 4 risk level 4 badge riêng + KHÔNG nút confirm + JSON round-trip) · Python 58/58 · analyze 0 issue
  - **KHÔNG chạm** tool create_*/submit/cancel (ranh giới Phase 6); ER ranking SĐT/lịch sử → Phase 6.5 (user chốt 2026-09-16)
  - **Review vòng 1 (2026-09-16) — 3 lỗi thật trong chính đợt code Phase 6, đã sửa + test hồi quy**: ① `riskFor()` FAIL-OPEN (verb lạ/typo → READ executable — ngược hoàn toàn mục đích safety gate) → fail-CLOSED: allowlist `KNOWN_READ_OPS` + regex mở rộng (apply/post/allocate/reconcile) + `RISK_UNKNOWN` throw; ② `Object.freeze` nông + `...extra` ghi đè được safety fields → freeze nested + re-pin risk/need_confirm sau spread; ③ `ActionProposal.fromJson` Dart fail-open (thiếu risk → READ xanh) → UNKNOWN + needConfirm:true + executable:false. Suite sau fix: **Node 63/63 · Flutter 19/19 · analyze 0**

- [x] **[2026-09-16] Phase 7 GIAI ĐOẠN A — first write (payment) + idempotency** (mức task lớn, vùng TIỀN — **ĐÃ COMMIT `8ebfc0e`**, duyệt 2026-09-16, bằng chứng `result23.txt`):
  - **Code mới**: `mcp-erpnext/src/idempotency.mjs` (store 3 trạng thái PENDING/COMPLETED/FAILED, atomic tmp+fsync+rename; COMPLETED → replay trả CHÍNH kết quả cũ; FAILED = terminal, retry cùng id bị TỪ CHỐI; cùng id khác fingerprint → throw; default `mcp-erpnext/idempotency-store/` trong repo + gitignored — KHÔNG /tmp theo bài học result22) + `mcp-erpnext/src/skills/payment-write.mjs` (`buildPaymentProposal()` = Stage A **dừng ở proposal**, dùng lại `buildProposal()` Phase 6 KHÔNG viết proposal riêng; `executePaymentProposal()` = Stage B, hiện mock)
  - **`/execute` route**: P0 (2026-09-17) đã UỶ QUYỀN toàn bộ policy cho **Safety Gateway** (`safety-gateway.mjs`, cửa duy nhất cho WRITE) — action hợp lệ lấy từ **Capability Contract** (`executableWriteActions()`), không còn hằng số `EXECUTABLE_ACTIONS` trong `http-ask.mjs`/`idempotency.mjs` → `store.begin()` → replay/PENDING-reconcile(409 kèm reference_no)/thực thi (mock hoặc thật)
  - **Guard KHÔNG bị nới**: `assertReadOnly` Phase 2 vẫn chặn mọi tool; write đi qua `callWriteTool()` TƯỜNG MINH ở `client.mjs` + mock `create_payment_entry` trong mock-server
  - **An toàn số tiền**: thu vượt dư nợ hoá đơn → clamp về đúng dư nợ + warning; hoá đơn âm (credit note) không thể thu; khách mơ hồ/không thấy → từ chối kèm message cụ thể; số tiền + khách + hoá đơn đọc LẠI từ ERPNext lúc execute (không tin params client)
  - **Flutter**: `ActionProposal.confirmable` (action=create_payment_entry + risk=HIGH + có entity id) → nút [Xác nhận thu tiền] → POST `/execute` với command_id sinh client; hiển thị "Đã ghi phiếu thu…" / "Đã ghi nhận trước đó (chống trùng)"; card READ/LOW/CRITICAL vẫn KHÔNG có nút
  - **Test thật (`result23.txt`)**: Python 58/58 OK · **Node 77/77** (trước 63; +14: duplicate command_id → ĐÚNG 1 lần ghi, FAILED terminal, fingerprint mismatch throw, PENDING+reference reconcile-required, clamp/hoá đơn âm/khách mơ hồ, proposal STOPS không có lệnh ghi) · **Flutter 23/23** · analyze 0 issue
  - **Lỗi tự phát hiện + sửa trong phiên**: 3 widget test FAIL vì helper test default `action: 'read_balance'` trong khi `confirmable` đòi "create_payment_entry" ⇒ **lỗi TEST, gate production ĐÚNG** — đã sửa test (KHÔNG nới gate cho khớp test) + làm mạnh test 2 chiều
  - ⚠️ **Giai đoạn B CHƯA CHẠY** (đúng yêu cầu user): chưa có lệnh nào ghi ERPNext thật. Trước khi replay thật PHẢI implement bước tra `reference_no` (mock chưa có)
  - ✅ **[2026-09-16] FIX `command_id` ổn định theo proposal (user quyết định + duyệt yêu cầu sửa, `result24.txt`)**: lỗi cũ = Flutter sinh UUID MỚI mỗi lần bấm ⇒ bấm lại sau lỗi mạng là "intent mới" ⇒ ghi phiếu thứ hai (trái thiết kế gốc "mất mạng → bấm lại → không ghi 2 lần"). Fix: `ActionProposal.commandId` getter lazy cache bằng **Expando** theo instance (giữ `@immutable`; chọn Expando thay vì State của widget vì card bị rebuild/recycle có thể mất key ⇒ lại mở cửa sổ ghi 2 lần). Proposal mới (/ask mới) = key mới = intent mới. KHÔNG đụng `idempotency.mjs` (dùng lại replay có sẵn)
  - ✅ **Test mới + falsification (result24 §3)**: ① mock lỗi mạng lần 1 → bấm lại → `second['command_id'] == first['command_id']`, 2 lần gọi HTTP, UI hiện "chống trùng" (chỉ 1 write); ② proposal mới → key mới; ③ tiêm lại bug cũ (per-press id) → test FAIL đúng assertion rồi hoàn nguyên — chứng minh test thật sự bắt regression, không phải test rỗng

- [x] **[2026-09-16] DOCS-SYNC phiên (result30.txt) + USER ĐÃ DUYỆT 5 VIỆC — XONG HẾT trong phiên result31**: ① **GỘP 1 commit `eea0411` + push** (user quyết thay tách 3): 37 files +3794/−124, secret scan CLEAN, không commit `.gemini//.opencode//initp` ② **Nối payment_write vào `routeIntent()`**: synonym mapper biến "thu tiền" → "payment" ĐẦU câu ⇒ nhóm `payment_write` ĐẦU ROUTES với anchor `startsWith` (substring sẽ nuốt câu ĐỌC chứa "đã/chưa thanh toán" — 2 test đọc từng FAIL trước anchor); E2E thật "thu tiền cho chị Lan 500 ngàn" → proposal `create_payment_entry`/HIGH (amount 500.000 từ NLP, invoice nợ cũ nhất, có `created_at`); thiếu tiền ⇒ đề xuất THU HẾT nợ (vẫn HIGH); widget test parse JSON verbatim → nút [Xác nhận] hiện thật; sửa chữ "Phase 2 chỉ đọc" (grep 0 hit) ③ **Route `/execute/cancel`**: `store.cancel()` chỉ từ PENDING; COMPLETED ⇒ 409 + result; PENDING ⇒ `reconcilePaymentEntry()` trước — 0 chứng từ mới CANCELLED, thấy chứng từ ⇒ 409 + `erpnext_doc` (+ test retry /execute cùng id → replay đúng); thiếu reference/ERPNext chết ⇒ 409/503 — giải zombie PENDING (result29 §10-F2) ④ **Xoá 2 PE demo `ACC-PAY-2026-00114/00115`**: đọc source → tool thật `erpnext_doc_delete` (draft docstatus 0, không cần cancel); gọi qua JSON-RPC thô MỘT LẦN theo lệnh user (đường xoá KHÔNG mở vào code sản phẩm); verify độc lập: 2 GONE + `ACC-SINV-2026-00047` outstanding 457.875 Unpaid GIỐNG HẾT trước xoá ⑤ **faq.md** đầu-file + §3.2/§3.3/§9/§8 khớp hành vi mới · `result31.txt` + handoff.
- [x] **[2026-09-16] REVIEW VÒNG 2 trên chính đợt result31 (result31 §11) — 2 lỗi thật + 1 nhỏ, đã vá + falsify**: **F1** anchor `startsWith` vẫn nuốt câu ĐỌC lịch sử bắt đầu bằng động từ synonym (`'thanh toán gần nhất của chị Lan...'` → normalize `'payment gần nhất...'` → routed **payment_write** SAI — probe `answerQuestion()` chạy thật) ⇒ fix `notIf` deny-list (bao nhiêu/mấy/gần nhất/mới nhất/?) — câu hỏi rơi về nhóm payment ĐỌC; fail-safe cả 2 chiều; +1 test round 2 (6 assertion), falsify: gỡ gate → FAIL đúng assertion, khôi phục 17/17 router. **F2** `store.cancel()` NGOÀI try/catch trong async handler — race với `/execute` đồng thời (double-tap) hoàn tất lệnh giữa lúc đọc status và cancel ⇒ throw `IDEMPOTENCY_CANCEL_REFUSED` uncaught ⇒ **Node ≥15 crash cả process** (bằng chứng cơ chế: async handler throw → exit 1; grep 0 global handler; suite không bắt được vì child-process cách ly) ⇒ bọc try/catch → 409 kèm trạng thái. **F3** reason dùng `rawText` (nguyên văn) thay vì `nlp.text` (đã chuẩn hoá). Suite sau review: **Node 119/119 (+1) · Python 60/60 · Flutter 29/29 · analyze 0**; bài học mới vào skill: falsify-hụt lần 2 (marker TAP vs spec reporter Node 24) + cancel-race phải tự bọc trong handler fail-fast.
   Suite cuối: **Python 60/60 · Node 118/118 · Flutter 29/29 · analyze 0** (so result30: +6 Node +1 Flutter). Falsify từng fix: gỡ anchor → 15/16 FAIL; disable nhánh chặn cancel → 13/14 FAIL; phá `confirmable` → widget FAIL — khôi phục đủ xanh, grep 0 mã tạm.
- [x] **[2026-09-16] Viết `faq.md` ⇒ phát hiện + vá 2 bug thật, ghi nhận 1 khoảng trống lớn (`result28.txt`)**: ① 🔴 **BUG TIỀN (đã vá)**: tên khách trùng từ-chỉ-số ⇒ `"bác Hai 500 ngàn"` = **2.500.000đ**, `"chị Bảy 300 ngàn"` = **7.300.000đ** — luật "số cách nhau" (`"1 500 000"`) áp nhầm lên từ-chỉ-số; fix bằng cờ `current_from_digits` (chỉ giá trị dựng từ CHỮ SỐ mới được merge) + 11 test hồi quy, falsify: `2500000 != 500000` / `7300000 != 300000`. ② 🔴 **BUG ĐỊNH DANH (đã vá)**: site demo có khách tên `"Chị Tư — thầu nhỏ"` ⇒ mảnh danh xưng `"chị"` khớp DUY NHẤT 1 khách nên `"thu tiền cho chị Lan 500 ngàn"` trả lời về **Chị Tư** (sai khách, không cảnh báo); fix: `KINSHIP_TITLES` loại ứng viên danh xưng đứng một mình + 3 test, falsify: `actual: 'Chị Tư — thầu nhỏ'`. ③ ⚠️ **KHOẢNG TRỐNG LỚN (chưa sửa, chờ user quyết)**: `buildPaymentProposal()` **chỉ được test gọi** ⇒ **không câu hỏi nào trong luồng chat sinh ra đề xuất `create_payment_entry`** ⇒ nút [Xác nhận thu tiền] **không bao giờ hiện trong dùng thật**; thêm nữa câu trả lời vẫn ghi `"… là Phase 7 — Phase 2 chỉ đọc"` (chữ đã cũ). ④ **`faq.md` (mới)**: 9 mục, mỗi mục là câu hỏi thật + ví dụ + "app thực sự làm gì", gồm cả cạm bẫy copy `2.500.000` sang locale EN (sai 1000 lần), NHÁP ⇒ công nợ không giảm, "chống trùng", không scrub PII, dữ liệu demo lẫn site thật. Python 60/60 · Node 97/97 · Flutter 27/27. ✅ **ĐÃ COMMIT `eea0411` (2026-09-16)**
- [x] **[2026-09-16] PHASE 9 (phần an toàn) — expiry + re-validate + khoá ý định PENDING — ✅ ĐÃ COMMIT `eea0411` (`result29.txt`)**: module `proposal-freshness.mjs` (`ageSeconds` / `assertFresh` TTL 10 phút → 409 `PROPOSAL_EXPIRED` TRƯỚC `store.begin()` ⇒ không chiếm command_id) · `created_at` ghim vào ActionProposal + Dart `toJson/fromJson` · `detectDrift()` so snapshot (outstanding/invoice/customer) với dữ liệu sống — lệch ⇒ KHÔNG ghi, 409 `PROPOSAL_STALE` kèm problems (thay cho "kẹp số tiền im lặng" — đổi hành vi đúng spec phase-09) · intentKey `(customer|invoice)` chặn ý định trùng đang PENDING (409 kèm `clash_command_id` để client biết resume lệnh nào — số tiền KHÔNG nằm trong intentKey: 2 đề xuất khác tiền cùng 1 hóa đơn = CÙNG ý định khi PENDING, đúng spec; bản đầu của mục này từng ghi nhầm "(kind|customer|amount|invoice)" + "fingerprint khác tiền ⇒ intent riêng" — đã đính chính sau review result29 §10-F1) · 4 test Node mới (freshness 3 + drift) + 3 test HTTP mới (expired 409 không tạo store entry · stale 409 · pending trùng 409 kèm `clash_command_id`) + 1 test Dart (`created_at` sống qua khôi phục history) — falsify từng fix. ⚠️ Review vòng sau khi viết (result29 §10): F1 đính chính mô tả intentKey (docs từng sai so với code) · F2 zombie PENDING: đã trả `clash_command_id` để client resume đúng lệnh, **route /execute/cancel ĐÃ CÓ trong result31**. Suite cuối: Python **60/60** · Node **112/112** · Flutter **28/28** · analyze 0. ⚠️ Chưa có: saga/undo-compensation (Phase 9 nâng cao), UI hiển thị lý do PROPOSAL_STALE trên card (text vẫn chung "không thể xác nhận")
- [x] **[2026-09-16] Rà 3a + vá lỗ hổng idempotency khi khôi phục history + 2 chaos test + skeleton Phase 9 (`result27.txt`)**: (1) `readonly-guard` vs `callWriteTool`: KHÔNG xung đột (`create`/`submit`/`delete` bị chặn ở đường đọc; write chỉ mở đúng `erpnext_doc_create` + doctype `Payment Entry` ⇒ submit/delete **không có đường nào chạm tới**). (2) Store idempotency **không nằm /tmp**: default `mcp-erpnext/idempotency-store` (gitignored, `ERPN_IDEM_DIR` không set). (3) 🔴 **Lỗ hổng thật**: `ActionProposal.toJson()` không lưu `command_id` + `fromJson()` tạo instance mới ⇒ **khôi phục history (restart app) cấp UUID mới cho cùng card** ⇒ bấm [Xác nhận] sau restart = intent mới = ghi phiếu nháp thứ hai. **Fix**: `commandIdSeed` + ghim `command_id` vào JSON ⇒ khoá idempotency sống theo VÒNG ĐỜI CARD (qua cả restart). +2 test (restore key ở tầng model + widget, falsify: gỡ seed → 2 UUID khác nhau → FAIL). (4) **2 chaos test mới** với fault hook `MOCK_ERP_FAIL_AFTER_WRITE` (ERPNext **ghi xong rồi mất response** → retry reconcile về ĐÚNG document đó, đếm ledger thật = 1) và `MOCK_ERP_FAIL_LIST` (ERPNext chết đúng lúc đối soát → 503, không ghi gì, store vẫn PENDING); falsify 2 vòng (gỡ phân loại afterWrite → 500 thay vì 503; gỡ `...existing` → 409 thay vì 200). (5) **Phase 9 skeleton** (PLAN ONLY): `.plan/phases/phase-09-proposal-state-machine.md` viết lại theo code thật — đã grep xác nhận proposal KHÔNG có `created_at`/snapshot và store KHÔNG có TTL; nêu rõ Phase 9 **đổi hành vi vùng tiền** (từ "kẹp số tiền im lặng" sang "lệch ⇒ 409 PROPOSAL_STALE"). Suite: Python 58/58 · Node **93/93** · Flutter **27/27** · analyze 0. ✅ **ĐÃ COMMIT `eea0411`**
- [x] **[2026-09-16] Vòng review vùng tiền sau Stage B (`result26.txt`)**: xem mục bên dưới (5 lỗi fail-open đã sửa + falsify)
- [x] **[2026-09-16] Phase 7 GIAI ĐOẠN B — GHI THẬT VÀO ERPNEXT (ERPNext demo trên Mac, quy trình như production; ✅ ĐÃ COMMIT `eea0411` — vùng tiền)**:
  - **Tool thật verify từ source (KHÔNG đoán)**: `erpnext_create_payment_entry` **KHÔNG tồn tại** — tạo document là `erpnext_doc_create` {doctype,data}; `erpnext_payment_entry_list` **không lọc được reference_no** → reconcile dùng `erpnext_doc_list` + filter `[["reference_no","=",commandId]]`; `erpnext_doc_submit` là tool RIÊNG (chỉ submit khi user quyết)
  - **Code thêm**: `buildPaymentEntryData()` (payload PE thật: Receive/Customer/accounts/exchange rate/references allocation) · `resolvePaymentAccounts()` (đọc company + debit_to từ HÓA ĐƠN, **resolve tên Mode of Payment** thay vì hardcode nhãn) · `reconcilePaymentEntry()` (chỉ đọc, phát hiện cả duplicates) · `verifyWrittenPayment()` (đọc lại, lệch ⇒ throw) · `callWriteTool` gắt còn 1 tool + 1 doctype · `/execute` nhánh resumed reconcile fail-closed
  - **GHI THẬT THÀNH CÔNG**: `ACC-PAY-2026-00114` (10.000đ, khách “Khách làm tròn 2026-09-15-p1b-wf1-2”, hóa đơn ACC-SINV-2026-00047) — verify ĐỘC LẬP bằng đọc lại: reference_no == command_id ✅ · paid_amount == 10000 ✅ · số PE cùng reference = 1 ✅ · references allocation gắn đúng hóa đơn ✅ · mode "Cash" (resolve từ nhãn "Tiền mặt", có báo substituted) ✅
  - **Lần ghi ĐẦU TIÊN thất bại đúng cách**: `LinkValidationError: Không thể tìm thấy Phương thức thanh toán: Tiền mặt (HTTP 417)` — do code ĐOÁN tên mode; không tạo document nào; store ghi id đó = FAILED (terminal, đúng thiết kế)
  - 🔴 **BUG THẬT ĐÃ TÁI HIỆN + FIX: crash-recovery ghi PHIẾU THỨ HAI**. Ép record PENDING + restart (bắt buộc restart vì store cache RAM) → POST lại → ghi thêm `ACC-PAY-2026-00115` cùng reference. **Nguyên nhân gốc**: `begin()` ghi ĐÈ record ⇒ **xoá `reference_no`** ⇒ điều kiện `existing.reference_no` ở http-ask FALSE ⇒ **bỏ qua reconcile**; ERPNext KHÔNG unique reference_no nên không có lưới an toàn. **Fix fail-closed**: `{...existing, status:'PENDING'}` + trả `resumed` + resumed mà thiếu reference ⇒ 409 KHÔNG ghi + reconcile lỗi mạng ⇒ 503 KHÔNG ghi. **Falsification**: gỡ fix → test HTTP mới FAIL đúng chỗ; khôi phục → pass. **Kiểm chứng lại trên ERPNext THẬT sau fix**: `reconciled:true`, `duplicate_documents:2`, số PE **vẫn 2** (trước fix sẽ thành 3)
  - **Test**: Node **86/86** (thêm: payload PE thật · mode resolve · verify đọc-lại · reconcile phát hiện duplicate · crash-recovery qua HTTP · begin() giữ reference_no) · Python 58/58 · Flutter 25/25 · analyze 0
  - **Hệ quả nghiệp vụ đo được**: 2 phiếu demo NHÁP ⇒ công nợ ACC-SINV-2026-00047 **không đổi** (457.875, Unpaid); 2 phiếu này ĐÃ XOÁ trong result31; giờ có **F7-2 submit switch** (`eb4ba34`) — bật trong ⚙️ Settings (mặc định OFF) nếu muốn xác nhận nộp phiếu thật
  - **Việc của user**: dọn 2 phiếu nháp demo (ACC-PAY-2026-00114/00115) — hướng dẫn trong result25 §B.8, KHÔNG tự xóa
  - 🔎 **VÒNG REVIEW SAU STAGE B (2026-09-16, `result26.txt`) — 5 lỗi thật tìm thấy trong chính code vừa viết, đã sửa + falsify, ✅ ĐÃ COMMIT `bda54cf`:**
    - 🔴 **(1) Lỗi post-write bị đánh FAILED** ⇒ `begin()` từ chối FAILED ⇒ KHÔNG reconcile được, và đẩy user sang **command_id mới** = đúng công thức ghi phiếu thứ hai. **Fix**: phân loại theo `reference_no` — lỗi SAU khi đã đăng ký reference ⇒ `503 {retry_same_command_id:true}`, record giữ PENDING (lần sau reconcile); lỗi TRƯỚC reference (chưa thể ghi gì) ⇒ FAILED như cũ. Test fault-injection `MOCK_ERP_FAIL_WRITE`.
    - 🔴 **(2) `amount_vnd: 0`/NaN bị thăng cấp thành THU TOÀN BỘ NỢ**: `Math.round(Number(x) || liveOutstanding)` coi 0/NaN/"" là “thu hết”, trong khi builder ĐÃ từ chối `amount <= 0` ⇒ validate có ở đường build, THIẾU ở đường execute. **Fix 2 tầng**: boundary `/execute` trả 400 (**không chiếm command_id**) + executor throw `PAYMENT_AMOUNT_INVALID` trước `setReference`.
    - 🟡 **(3) `?? modes[0]?.name` chọn ĐẠI phương thức** ⇒ “thu tiền mặt” có thể ghi vào tài khoản ngân hàng (sai sổ, im lặng). **Fix**: chỉ exact → cash-named → cash-typed; không khớp ⇒ `PAYMENT_MODE_UNRESOLVED` (fail-closed).
    - 🟡 **(4) `<= 0` để lọt NaN** (`NaN <= 0` = false) ⇒ payload `paid_amount: null`. **Fix**: `Number.isFinite` + `> 0`.
    - 🟡 **(5) Docs/comment sai + 1 hàng bảng skill vỡ**: comment cũ trong http-ask, giả định tỉ giá 1:1 (nay ghi rõ single-currency), và hàng skill chứa pipe CHƯA escape ⇒ vỡ bảng markdown (đã escape, verify bằng script strip-escape trước khi đếm cột).
    - **Test**: Node **91/91** (86 → 91) · Python 58/58 · Flutter 25/25 · analyze 0 · **falsification cả 5**: gỡ từng fix → test mới FAIL đúng chỗ, khôi phục → pass (2 lần chạy thật, output trong result25 §C)

### Hạ tầng dev + client (2026-09-17, `result43.txt`) ✅ ĐÃ COMMIT `c401b0f` + `f28869a` (đã push) + APK CI XANH (run `35173021349`, `35175220731`)
- [x] **A) Xác minh hạ tầng sau khi tunnel đổi URL (CHỈ config/verify, không code)**:
  `.env` đã đúng `ERPNEXT_URL=https://prevail-pantyhose-overvalue.ngrok-free.dev` (không cần sửa) —
  verify bằng ĐỌC THẬT qua pinned 3.0.4: `erpnext_customer_list` trả 3 khách thật · upstream
  `mac-custom` config khớp, tunnel SỐNG (`/v1/models` 502→**200**, flaky lần đầu là tính đã ghi
  trong `_note`) · `erpn8788.loca.lt` xác nhận là tunnel Gateway (`http-ask.mjs` default port
  **8788**) — ⚠️ tunnel erpn8788 HIỆN TẮT (408/502, `lt` không chạy trên Mac; tình trạng MÔI TRƯỜNG)
- [x] **B) Giới hạn lịch sử chat (mặc định 20, cấu hình được, KHÔNG cắt proposal đang treo)**:
  `AppSettingsService` (MỚI, SharedPreferences, getter đồng bộ) + `ChatTurn.hasPendingProposal` +
  `ChatHistoryService.trimTurns/save(maxItems)` (pure) + controller áp CÙNG luật cho cả state LẪN
  storage; mặc định **20**, sàn **5** (clamp cả khi đọc lẫn ghi). **Falsify BẮT BUỘC ĐẠT**: gỡ nhánh
  an toàn → 3 test đỏ đúng chỗ (Expected 21/Actual 20 ×2, 6/5 ×1) → khôi phục `markers=0` + xanh
- [x] **C) Màn hình Settings (đổi URL/auth/cap KHÔNG cần build lại APK)**: route `/settings` +
  icon ⚙️; `CopilotApiClient` đọc settings MỖI request ⇒ đổi URL áp dụng NGAY (test: cùng 1 client
  instance, request 2 đi URL mới); settings RỖNG → fallback `--dart-define` (APK cũ KHÔNG đổi hành
  vi); password `obscureText`; validate URL http/https + chặn max < 5
- 🔎 **Review vòng sau — 2 LỖI THẬT ĐÃ SỬA**: 🔴 `attachRejection` gọi cùng luật `trimTurns` SAU khi
  đánh dấu rejected ⇒ card (thường cũ nhất) bị CẮT NGAY, **banner lý do biến mất** đúng lúc user cần
  thấy — test chứng minh trước khi sửa (`Expected: <6> Actual: <5>`) ⇒ fix = BỎ trim khỏi
  `attachRejection` (B.2 cắt "sau mỗi lần thêm turn", từ chối KHÔNG thêm turn); 🟡 doc comment của
  provider mới "dính" sang `sharedPreferencesProvider` (analyzer không báo) — đã dán lại
- **Suite: Python 60 · Node 120 · Router 19 · Flutter 62 (39→62, +23) · analyze 0** · 3 bài học mới
  vào skill `erpn-verify-first` · KHÔNG đụng `.env`/router config/`mcp-erpnext/src/**`/ERPNext thật
- 🟡 **Hở test phát hiện khi user hỏi "đã test chưa"**: route `/settings` + icon ⚙️ KHÔNG test nào
  chạm (harness cũ pump `MaterialApp(home:)` không router / render thẳng màn đích) ⇒ suite xanh nhưng
  đường nối chưa từng chạy ⇒ thêm `test/settings_navigation_test.dart` (pump `MaterialApp.router`
  THẬT + tap ⚙️ + assert route resolve)
- [x] **Đã commit `c401b0f` + push + BUILD APK XANH** (user duyệt 2026-09-17): 14 file code/test
  (1202+/12−), secret scan CLEAN (2 hit là false positive — chỉ tên biến). GH Actions run
  `35173021349` SUCCESS 5m0s, artifact **`erpn-chat-debug-apk`** (~80 MB, hết hạn 2026-12-16):
  https://github.com/hoangsoft90/erpn_mobile1/actions/runs/35173021349 — cùng lượt push có cả
  `4546997` (F1/F3/F2). Docs (result37-43, setup-test.md, handoff37/39/43) **vẫn chưa commit**.
- ⚠️ **Repo CHƯA set GitHub Variables** (`actions/variables` → rỗng) ⇒ APK có endpoint/auth RỖNG,
  rơi về `127.0.0.1:8788`. **Cách xử lý: dùng luôn màn Settings mới** để nhập
  `https://erpn8788.loca.lt` + auth trong app (không cần build lại). Điều kiện: `lt` phải chạy trên Mac.
- [x] **USER REPORT (2026-09-17) "lưu URL thành công nhưng footer vẫn cũ" → 2 LỖI THẬT ĐÃ SỬA `f28869a`**:
  footer đọc tĩnh dart-define + plain Provider không notify khi giá trị đổi (fix: footer đọc URL hiệu lực +
  `ref.invalidate` sau Save; falsify đạt) · test hồi quy đi cả hành trình lưu→pop→assert · Flutter **63/63** ·
  run **`35175220731` SUCCESS** → APK mới ~80 MB: https://github.com/hoangsoft90/erpn_mobile1/actions/runs/35175220731
- [ ] Finding nhỏ chờ quyết: câu báo lỗi 401 còn ghi "APK cần build lại với --dart-define..." — nay Settings
  nhập được credential nên đã lệch; sửa thì phải commit+push+build lại

### Các phase kế tiếp (chi tiết ở `next.md`)
- Phase 4 (STT) — chặn bởi audio · Phase 5 (Gateway) — ĐÃ MỞ (sign-off 2026-09-15), router bản đơn giản đã code (result14) ·
  Phase 6 ✅ · Phase 7 ✅ Stage A+B nháp (chờ user SUBMIT) · Phase 9 an toàn ✅ (saga chờ duyệt §7) ·
  Phase 8–15 (jobs/TTS, multi-user, write mở rộng, multi-tenant, hardening, store, monetization-ads giữa 13 và 14)

### Nợ kỹ thuật Phase 1 (làm khi có dữ liệu quyết định)
- [ ] `bạc` = mệnh giá nào? — chờ user (`ch-003`)
- [ ] Viết tắt `m` (= triệu nhưng cũng = mét) — đoán là nguy hiểm (`ch-004`)
- [ ] Cờ `approximate` cho "khoảng/hơn 10 triệu" · số âm/hoàn tiền · tiếng lóng miền Trung ·
      phân biệt câu hỏi/lệnh (Phase 6)

---

## Cần hỏi lại / chờ user quyết định

- [x] **Gộp hay tách 3 commit?** — User quyết 2026-09-16: **GỘP 1 commit `eea0411`** (đã push).
- [ ] **SUBMIT phiếu thu demo** — user để sau, cần quyết riêng (2 phiếu nháp demo ĐÃ XOÁ 2026-09-16 qua `erpnext_doc_delete` — verify hóa đơn gốc không đổi; SUBMIT phiếu thu sau này là quyết định riêng khi có phiếu thật)
- [x] **Duyệt commit đợt result32–34 — UI STALE + F4: ✅ `31d485c` ĐÃ PUSH** (user duyệt 2026-09-16): 4 Dart (banner STALE/EXPIRED qua HTTP 409 thật + F4 params round-trip) + 4 docs + result32/33/34.txt + 3 handoff + `docs/demo-payment-draft.md`. Review result33: banner từng VÔ HÌNH trên đường thật (dio throw 409); F4: mọi confirm từ app thật từng sẽ bị 400 (model thiếu `params`) — falsify `Expected: <500000> Actual: <null>`. Suite: **Flutter 34/34 · Node 119/119 · Python 60/60 · analyze 0**; secret scan CLEAN. 15 files +1006/−22.
- [ ] **Duyệt saga plan §7** (phase-09, PLAN ONLY — `REVERSAL-<command_id>`, CRITICAL double-confirm, 5 test mock): duyệt thì mới code REVERSING/REVERSED.
- [ ] **Review `.project/ai-rules.md`** (MỚI 2026-09-14): file bạn nhắc tới KHÔNG tồn tại trước đó — agent đã tổng hợp từ AGENTS.md + operating_rules + thực tế result1→11. Duyệt hoặc sửa theo ý bạn; sau đó đây là nguồn quy tắc số 1 của `.project/`
- [x] ~~**Upstream LLM (result15):** ① Zen ② Gemini~~ — **user đã trả lời 2026-09-15**: Zen để sau (giữ billing-blocked), Gemini giữ free tier. Lưu ý result17 đính chính: phần lớn "flaky" trước đây là **bug cooldown của router**, không phải free tier
- [x] ~~**ERPNext thật đang 500**~~ — user đã khắc phục cùng ngày (14:35 verify: ping 200 + đọc được khách thật) → E2E thật đã chạy xanh (result17 §K)
- [ ] **4 câu của Phase 15 (monetization):** ad provider · múi giờ tính "hết ngày" ·
      danh sách tính năng pro · có IAP bỏ ad không
- [ ] **`bạc` mệnh giá** (`ch-003`) + có chấp nhận `m` = triệu không (`ch-004`)
- [x] ~~**`.agents/skills/*` có đưa vào repo không**~~ — **user chốt 2026-09-16: KHÔNG**. Skills bài học lỗi giữ nguyên trạng thái gitignored (chỉ sống trên máy dev này)
- [ ] **Vị trí OmniRoute/9Router + TAXPRO** — nếu mang code từ máy local sang thì refactor
      shared lib; trên máy này không có (đã chốt xây mới)
- [ ] Flutter client track chi tiết (navigation/state/token sâu hơn) — có cần phase riêng không,
      hay tích lũy dần trong Phase 4+ (hiện MVP đã có nền: Riverpod + 1 route + theme seed)

---

## DSH END-TO-END (`.plan/dsh_end_to_end.md`) — 2026-09-19, ✅ ĐÃ COMMIT `b61df0a`/`868be04`/`f2dfddb` (đã push, CI run #21)

Bảng task + bằng chứng: `.plan/dsh_e2e_tasks.md`; log đầy đủ: **`result57.txt`**.

- [x] **A1/A2 — Audit code DSH + gap** (`result57.txt` §1/§2)
- [x] **B1–B5 — Gateway backend** (`src/dsh-gateway.mjs` + `POST /dsh/ask`, 23 test):
      pre-screen WRITE, NLP down ⇒ fail closed, guard patch thiếu `COPILOT_DSH_CONTEXT`
      (LỖ HỔNG THẬT đã đóng), session TTL/concurrency, error map có copy, audit
      `request_id`/`conversation_id`/`mode=dsh`
- [x] **C1–C3 — Flutter AI mode** (`_ModeBar`/`SegmentedButton` default `Chat thường`,
      không auto, không persist → `dshAsk()`; không card, không `/execute`), 8 test +
      6 falsify (battery A–F; B/C phải tháo TOÀN BỘ 9 lớp mới đỏ — bài học result47 §6)
- [x] **D1–D6 — Test & E2E**: D2 mock (`attempts=['mock']`) · **D3 real E2E XANH**
      (`attempts=['mac-custom']` ×3×200; trả 171.800đ/4 khớp ground truth live) · D4 real
      WRITE BLOCK (`DSH_WRITE_BLOCKED`, 0.0105s, `has_proposal=false`) · D5 `/ask` tạo 0
      entry DSH (43→43) · D6 suite **Python 62 · Node 290 · Flutter 150 · analyze 0**
- [x] **E1–E3 — Tài liệu + FINAL REPORT** (`result57.txt` §12/§13 theo format plan §32)
- [ ] **Duyệt commit đợt DSH** (đụng gateway + Flutter client — chưa tự commit)

### DSH pin + topology + review fixes + REAL GEMINI — 2026-09-19 (`result58.txt`)

- [x] **6 defect review đã sửa + falsify** (gỡ → đỏ → khôi phục): F1 parser giữ NGUYÊN VĂN
      câu trả lời nhiều dòng (trước đó chỉ lấy dòng cuối ⇒ mất số tiền) · F2 store bị chặn
      `maxSessions` · F3 `conversation_id` validate tại biên (400, có test HTTP thật) ·
      F4 gỡ marker CHẾT `COPILOT_GATEWAY_DSH` + sửa doc sai + đổi test xanh-vô-nghĩa ·
      F5 `/dsh/health` nói THẬT (entry + patch + marker + version) ·
      **F6 (LỖI THẬT, test HTTP bắt được): route map TỪ CHỐI an toàn thành 502** ⇒ giám sát
      hiểu nhầm là lỗi hạ tầng; nay 200 + `refused:true` · F7 token runner lọt tail chẩn đoán
      ⇒ `redactToken()` (che theo GIÁ TRỊ đang giữ, không theo mẫu)
- [x] **§3 PIN**: `package.json` root pin `@deepseek-ai/dsh@0.1.5-rc.1` · `resolveDshEntry()`
      (resolve từ package đã cài, KHÔNG hardcode /tmp của 1 máy) · `dshRuntimeInfo()` ·
      `scripts/check-dsh-runtime.sh` (`npm run dsh:check`) → PASS, exit code là nguồn sự thật
- [x] **§2 TOPOLOGY remote**: `DSH_MODE=remote` + `scripts/dsh-remote-runner.mjs` (token bắt buộc,
      fail-closed, so bằng `timingSafeEqual`, dùng LẠI `buildDshChildEnv`) · remote **không bao giờ**
      hạ cấp về local (test + falsify) · mọi response (kể cả THẤT BẠI) mang `runtime: local|remote`
- [x] **E2E remote THẬT (loopback stand-in)**: gateway remote-mode → runner thật qua HTTP → dsh →
      router → **ERPNext THẬT** ⇒ 171.800đ/4 chứng từ; log runner `run ok in 4390ms`; WRITE block 83ms
- [ ] **BLOCKED_EXTERNAL §2 hop thật (backend → Mac qua tunnel)**: localtunnel trả
      `503 Tunnel Unavailable` ⇒ cần người bật lại `lt` trên Mac (KHÔNG phải lỗi code)
- [x] **§4 REAL GEMINI — PASS**: 1 session duy nhất qua `gemini-openai`, KHÔNG probe trước;
      `messages:7` (≥2 vòng tool-call), 200 ×3, trả **171.800đ/4** khớp ground truth live
      ⇒ đây cũng là verify sống đường đa-lượt mà `thought_signature` từng làm gãy
- [x] **§5/§12 audit bypass** 6 invariant (greps + lệnh thật: `result58.txt` §5) ·
      **§6 regression A–K** PASS · **§9** 6 script reproducible (exit code thật)
- [x] Suite cuối: **Python 62 · Node 306** (290→306) **· Flutter 150 · analyze 0**
- [x] **Drift model mac-custom**: `oc/big-pickle` đã chết (403) → `gemini/gemini-3.6-flash`
      ở 2 router config + patch dsh + default classifier; docs (`setup-test.md`,
      `features.md`) đã cập nhật + 2 hàng troubleshooting mới
- [ ] **Còn treo (không phải DSH)**: verify `gemini-openai` + `thought_signature` live
      (provider thật, 1 lần/ngày khi thuận tiện) — KHÔNG được tính PASS thay D3
- [ ] **Việc người thật**: cài APK → bật thử chế độ "Phân tích bằng AI" trên máy thật
      (UI test dùng envelope 502 mô phỏng; envelope thật đã verify bằng curl)

---

## Note

- **DSH END-TO-END + FINAL MINI-SPRINT (2026-09-19) ✅ ĐÃ COMMIT + PUSH** — `b61df0a`
  (gateway/scripts/pin) · `868be04` (Flutter AI mode) · `f2dfddb` (docs); bảng task
  `.plan/dsh_e2e_tasks.md`, bằng chứng `result57.txt` + `result58.txt`. **CI run #21
  `35426407766` success**, artifact `erpn-chat-debug-apk` 84.222.399 bytes, **đã grep
  binary APK** (kernel_blob.bin: `/dsh/ask` ×4, `Phân tích bằng AI` ×3).
  Suite mới nhất: **Python 62 · Node 307 · Router 19 · Flutter 150 · analyze 0**.
- **Phases2 P0–P8 ĐÃ ĐÓNG (đều đã commit + push)** — suite tham chiếu: Python 62 · Node 267 · **Flutter 107** (bugfix P6 `77e2b57`) · analyze 0. Bước kỹ thuật tiếp = P9 (chờ lệnh user); P10 full + saga §7 chờ duyệt riêng.
## P9-G — Đóng backlog P9 (2026-09-23) — ✅ ĐÃ ĐÓNG KỸ THUẬT, **CHỜ USER DUYỆT COMMIT**

**Deliverable:** `.plan/result-p9-done.md` · đối chiếu `.plan/next1/p9_guide.md` §2 (15 nghiệp vụ) với code thật.
**Kết quả:** 8/8 WRITE backlog P9 (A·B·C·D·E) + gate 0 ĐÃ XONG — chỉ còn `sales.summary` (READ stub) và các mục BỎ QUA CÓ CHỦ Ý (P9-F sales_return, trả hàng NCC, Reconciliation, JE, delete).

- [x] `delivery.create` (P9-A1/A2) · `purchase_receipt.create` (P9-B) · `payment.create` Pay (P9-C) · `sales_invoice.create` (P9-D) · `stock.adjustment` (P9-E) — contract→route→executor→mock→Flutter đủ 5 lớp, test P9 xanh
- [x] P9-E đã chạy **loop thật trên ERPNext site** (tạo NHÁP MAT-STE-2026-00021 → verify → xoá; migration `custom_ai_action_id` cho Stock Entry đã chạy thật)
- [x] Bảng cấm còn hiệu lực (đo lại): `document.delete` forbidden+skill:null (forbidden check chạy TRƯỚC stub check, copilot-server:546) · không có đường nào cancel chứng từ submitted · không có Journal Entry write · DSH chỉ `copilot_ask` (READ), `DSH_WRITE_BLOCKED`
- [ ] ❓ **CHỜ USER**: duyệt commit toàn bộ nhánh P9 (A→E + đóng P9) · device smoke (mic/AI/camera — human)

## P9-A2 — `delivery.create` wire UX + execute NHÁP (2026-09-22) — ✅ KỸ THUẬT XONG, **CHỜ USER DUYỆT COMMIT**

**Deliverable:** `.plan/result-p9-A2.md` · spec `.plan/next1/p9_guide.md` §3 + p9_prompts (A2) · depends P9-A1 (GO)
**Vùng rủi ro:** SỐ LƯỢNG/KHO + ràng buộc cứng "không submit" ⇒ **AI không tự ký duyệt, không tự commit**.

- [x] **Route**: 7/7 dạng LỆNH → `delivery.create` (`giao hàng …`, `giao 5 bao … cho …` ← dạng này **trước đây trả về số tồn kho**, `giao cho …`, `xuất hàng cho …`, `giao đơn hàng …`, `giao hàng đơn SAL-…`) · 9/9 CÂU HỎI **không** mở thẻ · `đặt hàng`/`báo giá` không đổi
- [x] **`/ask`**: proposal HIGH `create_delivery_note` + answer VN nói rõ NHÁP/không submit/chưa trừ kho + nút xác nhận; lines lấy từ **chính đơn** (có `so_detail`), `submit_now: false`; khách không có đơn đã submit ⇒ refusal có lý do
- [x] **`/execute`** qua Safety Gateway: 1 phiếu **docstatus 0** + verify đọc lại · trùng `command_id` ⇒ replay 1 phiếu · **CHAOS lost-response ⇒ 503 giữ PENDING → retry `reconciled: true` vẫn 1 phiếu** · không confirm ⇒ 0 · STALE ⇒ 409 0 phiếu · DRIFT ⇒ 409 `PROPOSAL_VERSION_STALE` 0 phiếu
- [x] **Submit bị chặn ở code**: `writeDoctypes()["Delivery Note"] = {create: true, submit: false}`; `erpnext_doc_submit` ⇒ `WRITE_REFUSED`
- [x] **Flutter (type tối thiểu)**: nhãn "Xác nhận tạo phiếu giao (NHÁP)" · **bỏ dòng "Tạm tính"** (phiếu giao không có giá riêng) · text kết quả nói rõ CHƯA trừ kho · +1 widget test · `_confirmableActions` khớp server (cross-check test)
- [x] **4 tripwire cũ sửa có chủ ý**: `b2-sales-order` (giữ bất biến "không bao giờ là đơn bán") · `b3-quotation` + `b4-purchase-order` (danh sách write tường minh) · `correlation-field-migration` (Delivery Note vào scope; ca "stub không bịa doctype" chuyển sang `purchase_receipt.create`)
- [x] **Số thật**: `p9-delivery.test.mjs` **20/20** · Node **557 — 555 pass, 2 fail** (cả 2 `dsh-gateway` từ B0; baseline 550/548/2 ⇒ **+7, 0 regression**) · Flutter **264/264** · analyze **0** · **đột biến M1/M2/M3 đều RED**, restore `sha256sum -c` byte-identical
- [ ] ❓ **CHỜ USER**: duyệt commit P9-A1 + P9-A2 (máy **chưa có git**) · migration `custom_ai_action_id` trên `Delivery Note` trước khi dùng thật · xác nhận mapper `make_delivery_note` khi bật ERPNext thật

- Đừng báo "xong" bằng lời — mọi claim cần lệnh + output thật (`erpn-verify-first` skill).
- **Vùng tiền/số/phân quyền: AI KHÔNG tự ký duyệt, KHÔNG tự commit** — chờ user review.
- **Gate pháp lý Phase 5: ĐÃ KÝ 2026-09-15 (không scrub)** — quyết định lưu ở `SIGNOFF-phase5-pii.md`; các gate ký duyệt TƯƠNG TỰ về sau vẫn chờ user.
- Tool đang hỏng trong env này: AgentMemory (down) · MCP cocoindex/codebase-memory (không
  expose) · OCR (không chạy được) · Simplenote (không có) → Code Review thủ công, không tự cài.
