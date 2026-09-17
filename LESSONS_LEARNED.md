# LESSONS_LEARNED — ERPNext Vietnamese Voice Copilot (erpn_mobile1)

> Bài học lỗi rút ra để KHÔNG tái phạm. File này là bản TÓM TẮT CHỈ MỤC (nhóm lỗi lặp,
> top bài học theo thiệt hại). Danh sách ĐẦY ĐỦ + chi tiết từng case nằm ở:
> **`.agents/skills/erpn-verify-first/SKILL.md`** (~70 hàng, cập nhật sau mỗi result) —
> file này KHÔNG nhân bản bảng.
>
> Quy tắc vận hành: mỗi lần tự phát hiện lỗi của chính mình (không chờ user nhắc),
> cập nhật 1 hàng vào SKILL.md; chỉ khi lỗi thuộc NHÓM đã có dưới đây mới KHÔNG thêm
> hàng trùng. Sau mỗi phiên lớn: rà lại xem có nhóm mới nổi không và cập nhật mục này.

## Nhóm lỗi lặp lại nhiều nhất (tần suất ≥ 2 — luôn cảnh giác)

1. **Đoán contract thay vì đọc source thật** — tool MCP name (result4), env lazy-loader
   (result6), dsh namespace tool (result6), schema `erpnext_doc_create` (result25:
   `erpnext_create_payment_entry` KHÔNG tồn tại). Luật: đọc node_modules/source thật
   TRƯỚC khi viết bất kỳ call nào; tên tool/field phải được trích nguyên văn.

2. **Falsification hụt — tưởng đã chứng minh mà chưa** — gỡ fix nhưng khối validate
   khác vẫn còn (result26), regex sed không khớp code nhiều dòng nên không có gì bị
   sửa (result27), ghi "không cần falsify" rồi phải rút lại (result29 §10), grep marker
   TAP `not ok` trong khi Node 24 in spec reporter `✖` ⇒ 2 lần "falsify đạt" thực ra
   chưa nhìn đúng output (result31 §11).
   Luật: mỗi vòng falsify phải chứng minh FILE ĐỔI THẬT (grep trước–sau) + test FAIL
   đúng assertion, rồi mới khôi phục; marker pass/fail của tool phải lấy từ output
   THẬT của chính nó trong môi trường hiện tại.

3. **Fallback âm thầm biến giá trị sai thành giá trị nguy hiểm hơn** — `Number(x) ||
   live` biến 0/NaN thành thu toàn bộ nợ (result26), `?? modes[0]` chọn đại phương
   thức ⇒ sai tài khoản (result26), `Math.min` clamp im lặng (Phase 7, nay là 409
   PROPOSAL_STALE), anchor bắt đầu câu vẫn nuốt câu hỏi ĐỌC lịch sử bắt đầu bằng
   động từ synonym — "thanh toán gần nhất..." normalize thành "payment gần nhất..."
   (result31 §11-F1, fix bằng deny-list từ nghi vấn). Luật: trong đường tiền, fallback
   phải fail-closed hoặc được chứng minh an toàn; cùng 1 field phải validate GIỐNG NHAU
   ở mọi đường đọc; route có hướng phân biệt (lệnh ghi vs câu hỏi đọc) phải có
   deny-list tường minh, không chỉ anchor một chiều.

4. **Async handler để store-mutation throw ngoài catch ⇒ crash cả process** —
   `store.cancel()` throw `IDEMPOTENCY_CANCEL_REFUSED` khi race với `/execute` đồng
   thời; không có global unhandledRejection handler (fail-fast cố ý) ⇒ Node ≥15 exit 1
   (result31 §11-F2). Suite unit KHÔNG bắt được vì child-process cách ly che crash.
   Luật: mọi store-mutation đặt trạng thái terminal trong async HTTP handler phải nằm
   trong try/catch → map lỗi thành 409; suite pass ≠ không crash — kiểm exit code
   process thật khi nghi race.

4. **State sống qua vòng đời sai** — `command_id` đổi khi rebuild card (result24),
   đổi khi khôi phục history vì `toJson` không ghim (result27), zombie PENDING khoá
   intent vĩnh viễn không có đường cứu (result29 §10-F2). Luật: khoá idempotency phải
   sống qua retry + rebuild + restore; mọi trạng thái treo phải có đường thoát.

5. **Báo động giả từ tool probe → sửa → nhân bản lỗi** — awk đếm sai cột bảng markdown
   vì cell chứa `\|` (result15/16/29), số liệu audit không lọc attempts (result18),
   đếm quota theo status 200 thay vì request gửi đi (result19). Luật: in NGUYÊN VĂN
   đối tượng trước khi tin con số của tool probe; kết luận "mất dữ liệu" phải có cơ
   chế từng bước (result20 — nguyên nhân thật là /tmp overlayfs ephemeral trên Cloud
   Shell container, không phải cron).

6. **Docs claim lệch code** — result29 §10-F1: ghi intentKey gồm số tiền trong khi
   code khoá `(customer|invoice)`; mô tả hành vi phải grep đúng dòng code rồi copy
   nguyên văn, không suy diễn từ tên biến/tên test.

## Top bài học theo thiệt hại (mỗi cái tốn ≥ 1 phiên hoặc chạm tiền)

- **Đọc source trước khi đoán API/tool name** — 3 lần viết lại guard/skill chỉ vì
  đoán tên (result4 → result21 → result25). Chi phí lớn nhất của cả dự án.
- **ERPNext không ràng buộc unique `reference_no`** — store idempotency là lưới an
  toàn DUY NHẤT chống ghi trùng; bất biến `begin()` không xoá field (result25, bug
  thật ghi phiếu thứ hai trên ERPNext demo).
- **Unit xanh ≠ chạy thật** — accuracy 27.8% khi chạy ERPNext thật dù test xanh
  (result9); xác nhận môi trường nào xanh thì báo môi trường đó.
- **An toàn > tốc độ** — mọi nhánh fail-open tìm được trong review đều chuyển thành
  fail-closed (result26: 5 lỗi, result29: 2 lỗi), không trao đổi bằng "hiếm khi xảy ra".
- **Vùng tiền/số/phân quyền: không tự commit, không tự ký duyệt** — gate của user,
  kể cả khi data là demo (tập thói quen cho VPS thật).

## Phiên 2026-09-17 — P0 self-review (3 lỗi thật, đều tự gây ra trong cùng đợt refactor)

> Chi tiết + lệnh/output: `result44.txt` §3–§9. Hàng bảng tương ứng trong `SKILL.md`.

- **Chuyển việc THU NHẬN TÀI NGUYÊN (tạo client/spawn/mở kết nối) từ TRONG `try`
  ra NGOÀI `try` ⇒ lỗi config thoát khỏi hàm async → thoát HTTP handler →
  unhandled rejection ⇒ GIẾT cả process** (không chỉ hỏng 1 request). Đường cũ
  có client trong `try` nên chỉ trả 500 — refactor tự tạo ra lỗi crash-class.
  → Mọi thứ có thể ném (kể cả "chỉ là cấu hình") phải nằm trong `try` của hàm
  async; thêm guard tầng HTTP; falsify bằng cách GỠ guard và assert `/health`
  vẫn sống sau request lỗi.
- **Lỗi KHÔNG-chắc-chắn-có-ghi (không mở được kết nối / sai config) bị đánh dấu
  FAILED terminal, hoặc để lại PENDING không `reference_no` ⇒ khoá ý định
  `(customer|invoice)` ⇒ một lỗi đánh máy trong `.env` TREO VĨNH VIỄN khoản nợ.**
  → Phân loại theo câu hỏi "đã chắc chắn chưa ghi gì chưa?": chắc chắn chưa ⇒
  non-terminal + giữ nguyên `command_id` (retry được); có thể đã ghi ⇒ PENDING
  để reconcile; chỉ FAILED khi thất bại vĩnh viễn.
- **Falsify chạy thẳng trên cây làm việc: lệnh bị timeout/giết giữa lúc SỬA và
  lúc KHÔI PHỤC ⇒ code đã bị gỡ nằm lại trên disk, không gì báo cho bạn.**
  → Falsify trên BẢN SAO (`tar` sang `/tmp`, bỏ `node_modules`/`.git`) + `timeout`
  cứng; nếu buộc sửa cây thật thì backup trước VÀ kiểm tồn tại của fix sau khi
  khôi phục (`grep -c`) — không tin rằng bước khôi phục đã chạy.
- **Test tĩnh "chỉ có MỘT đường làm X" mà chỉ quét `src/` ⇒ `scripts/`/`bin/`
  là chỗ ẩn hợp lệ cho đường thứ hai.** → Quét toàn package; ngoại lệ (tooling
  operator) phải được khẳng định TƯỜNG MINH, không bỏ sót im lặng.
- **Rò rỉ tài nguyên khi `initialize()` thất bại:** `close()` không được gọi ⇒
  process con ở lại và giữ event loop sống. → Mọi cặp open/acquire phải có
  catch-close-trước-khi-ném.
- **Số tiền thiếu ở boundary phải TỪ CHỐI**, không được để contract flag
  `allow_full_balance` biến "request hỏng" thành "thu hết nợ".

## Phiên 2026-09-17 (chiều) — P1 self-review: harness Flutter tự che chính nó

- **Test harness cast cứng shape dữ liệu request** (`jsonDecode(options.data as String)`)
  trong khi dio đưa Map NGUYÊN vào HttpClientAdapter trong harness đó ⇒ TypeError bị dio
  bọc thành `CopilotNetworkException` ⇒ test thấy "Không kết nối được máy chủ" với capture
  RỖNG — nhìn như lỗi mạng/client, thật ra là lỗi của chính harness. 3 test còn lại cùng
  file XANH vì không đọc body ⇒ suite "xanh 3/4" che luôn chỗ hỏng. Sửa: helper `_bodyOf`
  chịu cả Map lẫn String. Probe debug (gọi thẳng `ask()` với adapter, in `dataType` +
  exception thật) là thứ cho ra nguyên nhân — đoán không ra. Bằng chứng: `result45.txt` §1.
  → Đối chiếu row `"test wire phải đi qua adapter thật"` trong SKILL.md: lesson MỚI là
  **shape mà adapter nhận phụ thuộc cấu hình harness** — viết helper chịu 2 dạng, và khi
  test báo lỗi transport với capture rỗng, NGHI VỊ HARNESS trước khi nghi production.

## Kỷ luật bắt buộc trước khi báo "xong" (tóm tắt từ SKILL.md)

1. Chạy test thật của đúng phạm vi đổi (targeted), dán output nguyên văn.
2. Falsify từng fix (gỡ → FAIL đúng chỗ → khôi phục → xác nhận khôi phục).
3. Docs claim hành vi ⇒ grep code đối chiếu; claim "test chứng minh X" ⇒ đọc test đó.
4. Secret scan trên mọi file sẽ commit; `.env` không bao giờ vào git.
5. Sau mỗi phiên: cập nhật resultNN + checklist + next + working + handoff (+ skill
   nếu có bài học mới).
