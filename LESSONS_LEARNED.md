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
   **Hai họ hàng phases3 (2026-09-20) — cùng luật "kiểm ở MỌI điểm vào":** (a) **C1**:
   `POST /ocr` để validate input **chỉ trong provider** ⇒ provider MOCK (bỏ qua input theo
   thiết kế cho CI) trả **hóa đơn BỊA 200 OK** cho `POST /ocr {}`, mà mọi unit test provider
   vẫn xanh ⇒ kiểm tra thuộc **BIÊN** (route/handler), không thuộc implementation — mọi impl
   khác (mock/stub/fake) là cửa hậu; (b) **C2**: `ocr_policy.max_text_length` enforce trong
   `/ocr` (nơi SẢN XUẤT bản đọc) nhưng route tiêu thụ `/ocr/slots` nhận `body.text` TRỰC TIẾP
   từ client (comment còn khẳng định sai "đã sanitize ở C0 seam") ⇒ client đã auth đẩy ~1 MB
   vào NLP + resolver O(n²). Luật: bound phải re-enforce ở **mọi** đường input đến từ client,
   không chỉ đường sản xuất nó; tự hỏi "đường này nhận input từ đâu — ĐIỂM ĐÓ có gì chặn chưa?".

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
   **Biến thể phases3 (2026-09-20): claim "đã cập nhật docs X" NGAY TRONG file result
   nhưng edit chưa từng vào file** — `result62.txt` §7 khai đã update `features.md` /
   `faq.md` / `LESSONS_LEARNED.md` / `handoff_20260920-1739.md`, nhưng grep thật = **0 hit**
   và handoff đó **không tồn tại** (phiên bị cắt giữa chừng). Luật: mục "đã cập nhật docs"
   chỉ được viết SAU khi `grep` chứng minh nội dung đã vào file; nếu chưa, ghi rõ "CHƯA làm"
   — đừng để bản thân file result trở thành nguồn tin sai cho phiên sau.

7. **Oracle RỖNG — khẳng định không thể sai (falsify XANH oan)** — khác nhóm 2 (nhóm 2
   là *nhìn sai output*, nhóm này là *test không có khả năng thất bại*). result56
   §5a bắt được 2 ca trong CÙNG một đợt: (a) adapter ghi request gắn vào Dio riêng
   của `copilotApiClientProvider` trong khi `ProposalCard` POST `/execute` qua
   `dioProvider` ⇒ nhét auto-confirm vào card mà test "không có request /execute"
   VẪN XANH; (b) khẳng định "text đọc không chứa UUID" bị chính sanitizer (lớp phòng
   thủ khác) gỡ UUID trước khi tới oracle ⇒ đổi nguồn thành JSON máy mà VẪN XANH.
   Luật: khẳng định **PHỦ ĐỊNH** / khẳng định **ÂM** phải được falsify bằng cách TỰ
   TAY phát ra hành vi bị cấm rồi xem test có đỏ — xanh nghĩa là oracle rỗng, KHÔNG
   phải "code an toàn". Khi có nhiều lớp phòng thủ: test phải khẳng định **NGUỒN**
   (hình dạng dữ liệu vào), không chỉ **giá trị cuối đã bị lọc**, và falsify TỪNG lớp
   ĐỘC LẬP.

8. **Từ chối chính sách bị báo nhầm thành lỗi hạ tầng** — result58 §1-F6: `dshGatewayAsk`
   khai báo từ chối cổng AN TOÀN là `httpStatus:200` (đó là CÂU TRẢ LỜI, gateway chưa
   chạm runtime), nhưng route chỉ biết 400/429 rồi `else → 502` ⇒ `DSH_WRITE_BLOCKED`
   đi ra với **502**, giám sát/retry không phân biệt được với tunnel chết. Đọc code
   từng nhánh riêng thì cả hai đều "hợp lý"; chỉ **gọi thật** rồi đọc `http_code` mới
   thấy. Luật: quyết định chính sách mang **đúng status của nó**, và mọi route phải được
   kiểm bằng 1 request THẬT ở tầng HTTP, không chỉ bằng unit test hàm.

9. **"Chạy ở đâu" không phải field máy đọc được ⇒ dễ báo cáo sai máy** — result58 §2:
   trước đợt này response không có `runtime`; hop thật sang Mac BLOCKED (tunnel 503)
   trong khi topology remote vẫn chạy được với runner THẬT trên loopback ⇒ nguy cơ
   một lần chạy local/stand-in bị kể lại thành "đã verify trên Mac". Đã thêm
   `runtime: local|remote` vào CẢ response thành công VÀ thất bại + runner ghi log
   riêng + `check-dsh-topology.sh` in `LOCAL_OK|REMOTE_OK|BLOCKED`. Luật: khi hệ có
   nhiều nơi thực thi, mỗi kết quả phải tự khai nơi đã chạy (kể cả khi lỗi); hop không
   chạy được thì ghi **BLOCKED_EXTERNAL + bằng chứng nguyên nhân** và nói rõ cái gì
   ĐÃ được chứng minh (đường code/auth/parse), không đẩy thành "PASS".

10. **Xanh vô nghĩa ở tầng thấp + state toàn cục giữa các test** — result58: (a) test
   session-continuity gọi thẳng `runDshAsk` (store rỗng) trong khi store được ghi ở
   `dshGatewayAsk` ⇒ không kiểm gì; (b) biến module-level `NLP_SERVICE_PORT` đọc một
   lần lúc import, test sau nói chuyện với cổng đã chết ⇒ cổng fail-closed trả **SAI
   mã lỗi**. Luật: test hành vi phải gọi đúng tầng ghi state (hoặc seed tường minh),
   và khi thêm test sau vào file đã import module giữ config thì **re-point seam** +
   restore trong `finally`; đọc đúng `code` trả về trước khi kết luận đỏ vì gì.

11. **Hardcode đường dẫn runtime của một máy ⇒ máy khác "khả dụng" mà không chạy được** —
   result58 §3: entry dsh nằm ở `/tmp/dsh-run/...` và `/dsh/health` chỉ `existsSync`.
   Luật: resolve theo cách node vẫn resolve (`createRequire` → `pkg.bin`), PIN version
   vào manifest, báo version ra health, và mọi script kiểm tra phải trả **exit code**.

12. **Secret mình ĐANG GIỮ thì che theo GIÁ TRỊ, không theo mẫu** — result58 §1-F7: bộ
   scrub generic không nhận ra token runner nên nó lọt vào tail chẩn đoán. Luật: che
   bằng cách thay chính giá trị đã biết (`redactToken`) rồi mới scrub theo mẫu như lớp 2.

13. **Một route thiếu lưới bắt lỗi ⇒ chết cả process** — result58 §16 (review vòng 2):
   `/dsh/health` là route DUY NHẤT không `try/catch` trong `http-ask.mjs`; throw trong
   async listener = unhandled rejection = Node exit (lỗi cùng dạng đã giết gateway ở
   result44 §3). Falsify: gỡ `try/catch` ⇒ **cả 4 test trong file ĐỎ** (process chết),
   khôi phục ⇒ 4/4 xanh. Luật: sau khi thêm/bọc route, `grep 'req.method ==='` kiểm
   **TOÀN BỘ** nhánh có cùng lớp bảo vệ; fault-injection qua seam hợp lệ (`env`,
   `fetchImpl`, `principal`) để chứng minh — ĐỎ phải là process/file test chết.

14. **Nhân bản cơ chế mà quên nhân bản GIỚI HẠN của nó** — result58 §16: spawn local đã
   cap `stdout`/`stderr`, runner từ xa thì không ⇒ session hoang ăn hết RAM máy Mac.
   Luật: khi sao chép một cơ chế sang chỗ thứ hai, **đối chiếu hai bản có chủ đích**
   (cap · timeout · refusal · dọn temp), không chỉ đối chiếu phần "chạy được".

15. **Bằng chứng có thể VẮNG ⇒ delta trở thành oracle rỗng** — result58 §16:
   `check-ask-normal.sh` in `RESULT: PASS` khi file audit không tồn tại ("0 → 0").
   Luật: mọi khẳng định dạng "không tăng/không xuất hiện" phải khẳng định **NGUỒN
   BẰNG CHỨNG TỒN TẠI** trước, và đã từng chứng minh nó CÓ THỂ tăng.

16. **Hợp nhất / tái dùng làm MẤT thứ có sẵn (shape tham số · state persist · bảng
   status)** — Trụ B phases3 (2026-09-20): (a) **B3**: gộp nhánh SO/Quotation dùng chung
   builder ⇒ truyền **thẳng object khách** thay vì `{ customer: … }` ⇒ **mọi** câu đặt hàng
   `SO_CUSTOMER_UNRESOLVED`; unit test B3 (gọi builder trực tiếp) KHÔNG thấy, **chỉ E2E B2
   qua copilot** bắt được. (b) **B2**: mock persist state qua file nhưng `const SALES_ORDERS`
   khai SAU khối restore ⇒ lần chạy sau **không bao giờ đọc lại** state (TDZ nuốt bởi
   try/catch) — hậu quả thật: **đơn thứ hai GHI THẬT** (duplicate test đỏ `200 ≠ 409`).
   (c) bảng `SKILL_REFUSAL_STATUSES`: `SO_DUPLICATE_ACTION` trả 500 thay 409 + mất
   `existing_doc`. Luật: sau khi gộp 2 call-site dùng chung 1 hàm/thêm 1 capability theo
   pattern cũ, phải (1) chạy **E2E qua đường vừa hợp nhất** (không chỉ unit tầng thấp),
   (2) với state persist: chạy **2 process thật** rồi kiểm lần sau ĐỌC LẠI được, (3) sao
   chép bảng refusal/status phải mang đủ **mã + HTTP code + field phụ**.

17. **Công cụ TỰ SỬA file có thể ĐỂ LẠI thay đổi khi bị NGẮT giữa chừng** — result63
   (issue1): harness falsify gỡ guard rồi khôi phục trong `finally`, nhưng ca "bỏ cổng"
   làm tiến trình con **phục vụ tiếp** thay vì exit ⇒ test E2E `await exited` **treo** ⇒
   harness bị `timeout` giết GIỮA mutation ⇒ `src/copilot-server.mjs` **còn nguyên
   `if (false)`** trên đĩa (kèm `.falsify-bak` sót). Nguy hiểm vì phiên sau sẽ đọc/chạy
   trên code đã bị sửa mà không biết. Luật: (a) mọi `await` chờ tiến trình con trong test
   phải bound (`Promise.race([p, timeout])`, timeout = FAIL chứ không phải treo) — nếu
   không thì KHÔNG harness mutation nào an toàn; (b) harness tự sửa file phải bắt
   `SIGINT`/`SIGTERM` để khôi phục; (c) sau mỗi lần bị ngắt: `find -name '*.falsify-bak'`
   + grep chính chuỗi mutation TRƯỚC khi tin trạng thái repo.

18. **Guard mới chặn QUÁ RỘNG ⇒ hồi quy; chỉ FULL SUITE bắt được** — result63 §9.2:
   bản đầu của rule 2b chỉ hỏi "token kế tiếp có nằm trong tên row không?" → chặn oan
   `"payment cho chị Lan 500 ngàn"` vì token kế tiếp là **số tiền**, làm đỏ 3 test có sẵn
   (`B2/copilot E2E P1 §4.3`, `§4.4`, `customer-resolve "title hit…"`); và khi đổi sang điều kiện
   "row còn token phía sau", lần đầu tính `rowRemainder` trên **chuỗi nối display-name + id**
   ⇒ id bị đọc thành "tên còn dài" ⇒ vẫn chặn oan `"…năm trăm ngàn"` (tiền viết bằng CHỮ, không
   phải số) — chính test tôi vừa viết bắt được. Luật: khi thêm một guard vào hàm đã có người dùng,
   (a) liệt kê **các DẠNG THẬT của input** mà guard sẽ gặp (số tiền dạng chữ lẫn dạng số, từ vựng
   ý định, từ nối) và miễn trừ chúng — đừng suy từ trực giác; (b) chạy **full suite**, không chỉ
   test mới: 3 hồi quy này hoàn toàn vô hình với `node --test test/<file-mới>`;
   (c) điều kiện "phần còn lại của X" phải tính trên **từng field**, không trên chuỗi đã ghép.

19. **Mock DỄ DÃI HƠN tool thật ⇒ test xanh KHÔNG chứng minh được gì cho site** — P4-1
   (`result-p4-1.txt` §0): tool thật `erpnext_doc_list` **đòi filter value là STRING**
   (số ⇒ `TOOL_ERROR: Property /filters/0/2 must be string`), còn `mock-server.mjs`
   **không validate kiểu** ⇒ `receivables` dùng `["docstatus","=",1]` **chết cả nhánh**
   trên site thật (551 triệu không bao giờ hiện) mà **484 test vẫn xanh**; **cùng lớp lỗi nằm ở B2/B3**
   (`sales-order-write.mjs` + `quotation-write.mjs`, `Item Price` `selling = 1`) ⇒ đọc Item Price của
   **cả hai đường ghi** chết trên site, đã sửa `1`→`"1"` và đo lại: `selling=1` → TOOL_ERROR,
   `selling="1"` → **27 dòng Item Price**. Đáng chú ý: **harness falsify B2/B3 trước đây là script TẠM
   không nằm trong repo** ⇒ lớp lỗi này không có gì canh cho tới khi thành tripwire in-repo.
   Họ hàng: `count` của tool **là số dòng
   trả về** (limit 3 → count 3), KHÔNG phải tổng đã lọc — suýt viết một guard truncation
   **chết** dựa trên giả định đó. Luật: (a) với MỖI param/field mới, **đo schema + ngữ nghĩa
   trên tool THẬT** (probe read-only), đừng suy từ mock — mock là implementation phụ, không
   phải contract; (b) khi một invariant là "giá trị phải thuộc kiểu X", khoá bằng **tripwire
   tĩnh trên source** (như đã làm cho `MOCK_SERVER`) vì guard runtime trên literal **không
   falsifiable được** — và tripwire phải quét **TOÀN BỘ `src/`**, không chỉ file đang viết
   (`test/filter-literal-types.test.mjs`, có **control** "tìm thấy >= N" để scan hỏng không xanh giả);
   (c) tripwire tĩnh **phải strip comment trước khi quét** — comment mô tả
   đúng cái bị cấm ("tool từ chối `1`") làm tripwire báo động giả (lần thứ 2 trong 2 phiên).

20. **Guard tự viết cũng phải được REVIEW như code sản phẩm — regex/assert có ĐIỂM MÙ, và falsify phải chứng minh ĐÚNG GUARD là thứ đỏ** — P4-1 review vòng 2 (`result-p4-1.txt` §6), 2 lỗ hổng trong chính tripwire vừa viết: (a) nhóm giá trị của regex dừng ở `]` đầu tiên ⇒ dạng array `["docstatus","in",[0,1]]` **lọt** (đã vá: tách phần tử khi value bắt đầu bằng `[`, nhận cả `+1`); (b) ca falsify K/M đỏ nhưng **không chứng minh được tripwire là thứ bắt** — chạy cả bộ suite thì đỏ vì bất kỳ lý do nào (đã vá: tuỳ chọn `only` ⇒ ca K/M/N chỉ chạy đúng file tripwire). Thêm nữa: một guard mới **phải được xác nhận là CÓ ĐƯỢC CHẠY** trong CI (`grep` tên test trong output của `npm test`) — tripwire không được runner discover thì vẫn là trang trí dù file có tồn tại. **Điểm mù còn lại (không giả thuyết): tripwire chỉ thấy LITERAL**, nên giá trị là **biến** vẫn lọt — và chính vì vậy mới lòi ra phát hiện §6: `action_id` do **client** gửi (`http-ask.mjs:655`, không kiểm kiểu) → vào filter động `[[field,"=",actionId]]` → tool thật từ chối → `reconcile*` báo `correlation_field_unavailable` → executor **từ chối ghi oan** kèm chẩn đoán SAI ("ERPNext chưa có field — chạy migration") trong khi site bình thường (fail-closed nên **không** có nguy cơ ghi trùng). Luật: mỗi guard mới phải trả lời được 3 câu — (1) dạng nào lọt? (2) làm sao chứng minh ĐÚNG nó là thứ bắt? (3) runner CI có thật sự chạy nó? — và khi biến số đến từ client thì kiểm **ở BIÊN**, không dựa vào guard tĩnh.
   **Phát hiện ở (b.3) — ASSERT SAO cho đủ mạnh**: sau khi sửa phát hiện trên (400 `INVALID_CORRELATION_ID` ở `http-ask.mjs`), harness mới cho ra ca **C không đỏ** — bỏ nhánh "chuỗi rỗng" mà suite vẫn xanh, vì test của tôi chỉ assert **STATUS 400**, và khi guard bị bỏ thì request vẫn 400 **từ chỗ khác** (mã lỗi khác) ⇒ assertion yếu, test đỏ/xanh vì lý do không liên quan. Siết thành assert **MÃ lỗi** ⇒ ca C đỏ đúng chỗ. Luật: với lỗi nhiều nguồn (400/403/409/503 dễ đến từ nhiều nhánh), test **phải** assert **mã** (hoặc field đặc trưng), không chỉ status — nếu không, falsify sẽ đỏ giả hoặc xanh giả. Và cặp này còn cho thấy **pattern sẵn có phải được grep TRƯỚC khi viết**: `/execute/cancel` đã có `isValidCommandId` từ lâu, `/execute` thiếu nó — nửa validate áp cho một route là dạng hở rất dễ bỏ sót khi chỉ đọc route đang sửa.

21. **"xanh" có thể là KHÔNG CHẠY GÌ CẢ, và test sau có thể xanh vì ENV RÒ từ test trước** — P4-2 (`result-p4-2.txt` §2/§5) bắt được đúng 2 dạng này trong **chính harness vừa viết**: (a) helper test khôi phục **danh sách cứng** key env ⇒ `COPILOT_COMPANY` do test trước set **sót lại**, và test "không pin company ⇒ 503" trả về **200** (được pin từ env rò) — sửa: snapshot **đúng những key mình chạm** rồi khôi phục; (b) ca falsify D báo `PROBLEM NOT RED` vì `--test-name-pattern` là **REGEX** và `?` trong pattern làm nó khớp **0 test** ⇒ runner exit 0, tức "xanh" dù **không test nào chạy**. Luật cho mọi harness: (1) **escape** pattern, (2) **đếm test thật sự chạy** (`# tests N` ≥ 1) chứ không tin exit code, (3) chạy **xanh TRƯỚC khi mutate** để chứng minh test không hỏng sẵn, (4) **khôi phục đúng key mình chạm** — env rò làm kết quả của test sau không còn là kết quả của nó.

22. **`await`/client/spawn đặt NGOÀI `try` trong async handler = một route mới có thể GIẾT CẢ service** — P4-2 review tự bắt: `pickServerScript()` + `createMcpClient()` nằm ngoài `try` ⇒ khi ERP chưa cấu hình thì throw biến chính **async listener** thành **unhandled rejection** ⇒ Node thoát ⇒ request hỏng của drawer giết luôn `/ask`. Đã đưa vào trong `try` + `finally` đóng client kiểu `dayMcp?.close?.().catch(()=>{})`. Điểm cần nhớ: **hình dạng thất bại của lớp lỗi này là PROCESS CHẾT**, không phải một assertion — harness attribution có thể vẫn thấy `not ok <tên test>` (đo được),   nhưng đừng kỳ vọng lúc nào cũng vậy; và mọi route mới phải tự hỏi "dòng nào ở đây, nếu throw, sẽ làm chết tiến trình?". (Cùng họ với nhóm 4 nhưng khác tầng: nhóm 4 là store-mutation ngoài catch, đây là **thiết lập client/target** ngoài try.)
   **Anh em ruột cùng phiên — `finally` cũng có thể TREO thay vì ném:** `client.close()` chờ `once("exit")` trên một child **đã chết** ⇒ event đó không bao giờ bắn lại ⇒ `close()` treo **vĩnh viễn** (đo: `initialize()` reject sạch sau 77ms, `close()` → `TIMEOUT` 3000ms). Route gọi `close()` trong `finally` ⇒ handler **không bao giờ return** ⇒ rò 1 socket + 1 child **mỗi request lỗi** (mọi route mở client đều dính, không riêng route mới). Sửa 1 dòng: `if (child.exitCode !== null || child.signalCode !== null) return;`. Luật: hàm dọn dẹp/`close()` phải **IDEMPOTENT** và không được chờ một event đã xảy ra — với mọi tài nguyên mở theo request (child process, handle, lock), hỏi "gọi lần 2 / sau khi nó đã chết thì sao?".

23. **"Dữ liệu của SESSION" phải ĐO ĐƯỜNG ĐỌC, không suy từ tài liệu** — P4-2 §0: spec chỉ nói company lấy "từ session ERPNext user"; đi tìm cách đọc mới thấy `Global Defaults` là **Single** ⇒ `doc_list` **HTTP 500** nhưng `doc_get` **OK** (`default_company`), còn `User.default_company` **417** (field không được phép truy vấn). Nếu viết theo suy đoán (`doc_list` "cho mọi doctype") thì route đã sai đường đọc và chỉ vỡ khi chạy thật. Kèm một luật an toàn số tiền: khi đọc được **nhiều** company mà không có default ⇒ **TỪ CHỐI** (503 nói rõ phải cấu hình gì), **không** lấy "row đầu tiên" — đó là sổ của tenant khác; và client gửi company khác server ⇒ **403**, không lặng lẽ trả sổ company khác.

24. **Nhãn "nguồn dữ liệu" phải được DẪN XUẤT từ đúng cái quyết định nguồn đó, và chỉ có MỘT nhà** — P4-3 (`result-p4-3.txt` §0): `ops-summary.mjs` **hardcode** `source: "real"`, nên nếu màn hình in thẳng giá trị đó thành "REAL ERPNext" thì khi service đang chạy trên **fixture (mock)** footer sẽ **nói sai** — mà đây là màn số tiền. Đã thêm `meta.erp_target` = `erpTargetLabel(env)` ở `copilot-server.mjs`, dùng **đúng biểu thức** của dòng log khởi động (`ERPNEXT_URL ? "REAL" : "MOCK"`), và `main()` nay cũng gọi helper đó ⇒ log của người vận hành và footer của chủ tiệm **không thể lệch**; ca falsify chứng minh `erpTargetLabel` bám `pickServerScript` trên cả hai nhánh. Luật: (a) mọi nhãn **provenance** (REAL/MOCK, nguồn, "dữ liệu cũ", "chưa xác minh") mà người dùng dùng để TIN số tiền phải do server gửi và **sinh từ cùng một hàm** với thứ nó mô tả; (b) client **không được tự suy** — URL gateway cho biết copilot chạy ở đâu, KHÔNG cho biết nó đọc ERP nào — và khi server không nói thì in "không rõ nguồn", **không** mặc định REAL; (c) tham số vắng mặt ⇒ `null` ("chưa ai nói"), không phải một giá trị nghe hợp lý.

25. **Một harness "PROBE tạm" bỏ quên sẽ ĐỎ sau khi bug nó mô tả được sửa — và cái đỏ đó không phải regression của bạn** — P4-3 chạy full suite Flutter thì `test/_probe_review_test.dart` (file tự ghi "PROBE ONLY — temporary review harness") đỏ ở ca **P2b**: nó giả định nút [Xác nhận] **quay lại** sau khi `ListView` recycle, nhưng `ProposalCard` từ đó đã có `AutomaticKeepAliveClientMixin` (fix F2, `wantKeepAlive => _result != null …`) nên thẻ đã ghi **không bị dispose nữa** ⇒ "nút quay lại" **không còn tồn tại** để bấm. Cách quy trách nhiệm bằng BẰNG CHỨNG, không bằng cảm giác: (1) chạy riêng file đó — vẫn đỏ ⇒ không phải ô nhiễm chéo giữa test; (2) đọc chính code mà test nhắm tới — comment của F2 **trích số đo của chính probe đó** ("probe P2 measured success=1/button=0 → success=0/button=1"), tức tiền đề đã bị thay bằng thiết kế khác; (3) kiểm đường phụ thuộc — không file nào mình sửa nằm trong cây import của probe; (4) dựng **probe đối chứng** cùng kịch bản để đo lại hành vi hiện tại. **Kết cục (user chốt):** probe đó **ĐÃ XOÁ** khỏi repo ⇒ suite Flutter về **233/233 xanh** (finding của nó đã được fix ở F2 nên không convert thành test thật; giữ lại chỉ tạo "test đỏ vĩnh viễn" mà không canh gì). Luật: (a) harness/probe tạm phải **xoá hoặc chuyển thành test thật NGAY khi finding được fix** — bỏ quên = phiên sau nhận một "regression" giả và có thể đi sửa đúng thứ không hỏng; (b) khi một test không do mình chạm bị đỏ: **đo attribution trước khi nhận tội hoặc trước khi bỏ qua** — chạy cô lập + đọc comment/history của code đích + đường phụ thuộc.

26. **Probe TỰ VIẾT cũng phải đọc skill API trước — "đỏ" thường là do mình, và gotcha đó ĐÃ CÓ SẴN trong skill** — khi gỡ chốt P4 (`result-p4-3.txt` §7), probe verify độc lập do tôi viết json-encode **mọi** query param ⇒ `order_by="creation desc"` bị Frappe trả **417 `Định dạng trường không hợp lệ trong Order By: "creation desc"`**. Tôi suýt đọc thành "server từ chối"; sự thật là `.agents/skills/erpnext-rest-api-recipes/SKILL.md:1160` **đã ghi đúng dòng đó từ trước** (`order_by` **không** json-encode — `fields`/`filters` thì có) và tôi **không đọc skill trước khi viết probe**. Sửa 1 dòng → 4/4 PASS. Luật: (a) trước khi viết probe/script gọi một API mới, **grep skill của API đó** (encoding từng param, kiểu dữ liệu filter, tên field) — 1 phút đọc rẻ hơn 1 vòng sửa, và rẻ hơn nhiều so với một **kết luận sai về hệ thống**; (b) khi probe tự viết đỏ: mặc định **nghi mình trước** (param, kiểu, encoding) rồi mới nghi server; (c) đừng lặp lại sai lầm này dưới dạng "ghi thêm bài học" — bài học đã có rồi, cái thiếu là **BƯỚC ĐỌC** nó.

27. **Một phép verify có thể "PASS" mà VACUOUS — phải nói rõ và tìm phép kiểm khác** — cùng việc trên: để chứng minh **cột** `custom_ai_action_id` tồn tại thật (không chỉ dòng metadata `Custom Field`), tôi đọc 1 chứng từ chọn field đó; `Payment Entry`/`Sales Order`/`Purchase Order` trả `null` ⇒ chạm được cột thật, nhưng **`Quotation` không có chứng từ nào** ⇒ phép kiểm đó **không chạm gì cả** mà vẫn "PASS". Đã bịt bằng một phép kiểm khác: `filters=[['custom_ai_action_id','=', ...]]` — **thiếu cột thì Frappe trả 417 `Unknown column`**, còn 0 row có nghĩa là cột tồn tại ⇒ 4/4 **HTTP 200 rows=0** mới là bằng chứng cho cả 4 doctype (kèm **control âm**: field không tồn tại ⇒ 0 row, chứng minh query thật sự hỏi server). Luật: với mọi kết quả verify, tự hỏi **"phép kiểm này có chạm được vào thứ nó định đo không?"** — nếu dữ liệu rỗng/thiếu khiến nó không chạm gì thì ghi **"vacuous"** và tìm phép kiểm dạng "lỗi sẽ bộc lộ" (WHERE trên cột, đọc lại sau ghi, gọi bằng quyền sai) thay vì "trả rỗng". Kèm một luật về **nguồn bằng chứng**: script tự "đọc lại verify" chỉ chứng minh **nó đồng ý với chính nó** — bằng chứng phải lấy từ **đường khác** (REST độc lập, WHERE trên cột, control âm).

28. **Mock/test-double phải mô phỏng được trạng thái THIẾU — nếu không, CI mù đúng với lỗi đang xảy ra ở site thật** — `result-p4-3.txt` §8.2 (review vòng 2): site thật tới 2026-09-21 **thiếu** Custom Field trên SO/QT/PO ⇒ `appDrafts()` throw ⇒ `app_drafts` **null** + `partial=true`. Nhưng nhánh fixture của mock **bỏ qua** các knob `MOCK_ERP_*_NO_CORRELATION_FIELD` mà nhánh ledger có ⇒ **không test nào tái hiện được trạng thái đó**, tệ hơn: một doctype "thiếu field" lặng lẽ thành **"0 nháp"** — đúng loại **số 0 bịa**. Bài test cũ chỉ chạm được qua `MOCK_ERP_FAIL_LIST=1` (**sập mọi block**) nên **không chứng minh được phạm vi**. Luật: (a) khi thêm một knob giả lập điều kiện hạ tầng, phải hỏi **"mọi nhánh code của mock có tôn trọng nó chưa?"** — một knob chỉ nửa đường còn tệ hơn không có knob, vì nó tạo cảm giác đã phủ; (b) test cho một lỗi cụ thể phải **cô lập đúng nguyên nhân** (ở đây: 1 doctype thiếu field) và **kèm control** chứng minh các phần khác vẫn đúng — nếu không, test "sập toàn bộ" xanh được cả khi code quên phạm vi; (c) mỗi lỗi thật gặp ở site nên để lại **một test tái hiện được nó** — nếu không tái hiện được thì nói thẳng là **chưa có bằng chứng trong CI**.

29. **Nhánh "ĐÃ CÓ" của script idempotent phải kiểm SPEC, không chỉ kiểm TỒN TẠI** — cùng review vòng 2 (§8.3): `add-correlation-field.mjs` gặp field đã tồn tại thì in `ĐÃ CÓ` + `exit 0` mà **không so `fieldtype/unique/search_index`**. Nếu field tồn tại với `unique=0` (tạo tay/tạo dở), script **báo an toàn cho một trạng thái chưa an toàn** — và ở đây "an toàn" chính là **nửa DB của duplicate guard** cho đường ghi tiền (`payment-write.mjs`). Luật: với script migration/verify, **"đã có" phải có nghĩa "đã đúng spec"**; lệch spec ⇒ **fail (exit 1) kèm nói rõ lệch gì**, không chỉ in ra rồi đi tiếp — im lặng thành công là dạng fail-open khó thấy nhất, vì người vận hành không đọc lại output khi exit code là 0.

## Top bài học theo thiệt hại (mỗi cái tốn ≥ 1 phiên hoặc chạm tiền)

- **Đọc source trước khi đoán API/tool name** — 3 lần viết lại guard/skill chỉ vì
  đoán tên (result4 → result21 → result25). Chi phí lớn nhất của cả dự án.
- **ERPNext không ràng buộc unique `reference_no`** — store idempotency là lưới an
  toàn DUY NHẤT chống ghi trùng; bất biến `begin()` không xoá field (result25, bug
  thật ghi phiếu thứ hai trên ERPNext demo).
- **Unit xanh ≠ chạy thật** — accuracy 27.8% khi chạy ERPNext thật dù test xanh
  (result9); xác nhận môi trường nào xanh thì báo môi trường đó.
- **Test xanh ≠ test có giá trị** — một test viết ra mà không thể ĐỎ thì không bảo vệ
  được gì (xem nhóm 7, `result56` §5a): 2/6 falsify đầu tiên xanh oan vì recorder gắn
  sai provider và vì một lớp guard khác che mất. Falsify là cách DUY NHẤT phát hiện
  loại này — suite xanh không nói gì về chất lượng oracle.
- **Đừng `await` tác dụng phụ không bắt buộc trong hàm mà giá trị trả về gate việc dọn
  UI** — `result56` §9-F1: `await speak(...)` (đúng snippet plan) + engine TTS treo ⇒
  `send()` không bao giờ return ⇒ ô nhập không xoá dù câu trả lời đã xong = **stuck UI**.
  Chứng minh bằng fake **never-completing** + `.timeout()` (đỏ thật), sửa bằng
  `unawaited(...)` + try/catch bao trùm cả cổng. Khi thấy `await` một tiện ích trong
  đường đi của UI: hỏi "future này không bao giờ xong thì user kẹt ở đâu?".
- **Assertion dùng chung ĐUÔI CÂU giữa 2 control = flaky tiềm ẩn** (`result56` §9-F2):
  `textContaining('vẫn phải bấm Xác nhận khi thu tiền')` xanh vì switch kia đang OFF;
  probe đo khi bật CẢ HAI = 2 matches ⇒ sẽ đỏ về sau vì lý do không liên quan. Sau khi
  thêm control mới: **bật hết control rồi đo lại số match**, đừng tin `findsOneWidget`
  đang xanh.
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

## Phiên 2026-09-17 (P2 self-review): diff chôn delta + thứ tự nhánh refusal

- **Reformat toàn file cấu hình/contract khi chỉ sửa 1 dòng** — ghi lại `capabilities.json`
  theo style pretty-print khác ⇒ diff **495 dòng** (426/69) cho thay đổi thật **1 keyword**
  (`"doanh thu"`); trên file an toàn, reformat chôn mất delta ngữ nghĩa khiến review không
  thấy policy đã đổi gì. Phát hiện bằng `git diff --numstat` (số lớn bất thường) + so bản
  CANONICAL (`python3 -c json.dumps(...,sort_keys=True)`) HEAD vs worktree ⇒ delta đúng 1 dòng.
  Fix: `git checkout HEAD -- <file>` rồi thêm lại 1 keyword giữ style inline ⇒ diff còn
  `1 insertion(+), 1 deletion(-)`; `node --test` 181/181 vẫn xanh. Bằng chứng: `result46.txt` §6.
  → Trước khi stage file JSON/config: đọc `git diff --numstat`; số dòng đổi LỚN hơn nhiều so
  với dự kiến ⇒ bị reformat; tách delta ngữ nghĩa bằng bản canonical; KHÔNG commit reformat.
- **Thêm NHÁNH REFUSAL MỚI đặt TRƯỚC nhánh refusal nghiêm trọng hơn ⇒ nuốt mã an toàn cũ** —
  stub check (`skill:null` ⇒ `KNOWN_INTENT_UNIMPLEMENTED`) đặt trước forbidden check, mà
  `document.delete` CŨNG `skill:null` ⇒ "xóa khoản…" trả "chưa làm" thay vì `FORBIDDEN_IN_AI_PATH`.
  Test tĩnh `forbidden-path.test` (bảo vệ P0) bắt ngay khi chạy full suite ⇒ sửa thứ tự +
  comment "ORDER MATTERS". Falsify trên /tmp: hoán vị 2 khối ⇒ test FAIL đúng chỗ.
  → Nhánh refusal mới phải xếp SAU mọi nhánh an toàn hơn (`forbidden > degraded > stub > entity`);
  chạy LUÔN test tĩnh bảo vệ các mã an toàn cũ, không chỉ test mới của mình.

## Phiên 2026-09-17 (P3 — LLM Classifier): guard 2 lớp, coercion số, test flaky theo đồng hồ

- **Validator dùng `Number(x)` trần để chuẩn hoá field số ⇒ `null`/`true`/`""` lọt qua** —
  `Number(null)===0`, `Number(true)===1` nên `confidence:null` được coi là 0 (hợp lệ) thay vì
  bị từ chối. → Luôn type-check `typeof x === "number"` TRƯỚC khi so khoảng; test có ca
  `null`/`true`/`"0.9"`. Bằng chứng: `result47.txt` §6, bài học vào `SKILL.md`.
- **Env-number guard dùng truthy `n ? n : fallback` vẫn là fail-open (review P3):** `Number('')=0`,
  `Number('0')=0`, số âm đều TRUTHY ⇒ timeoutMs 0 (abort t≈0), minConfidence ≤0 (gate low-confidence
  TẮT lặng lẽ) lọt hết. → Luật chốt: `Number.isFinite(n) && n > 0 ? n : fallback` — một luật duy
  nhất, không truthy; test pin cả garbage/''/0/âm. Falsify chỉ hợp lệ khi bản sao /tmp dùng ĐÚNG
  bản test MỚI NHẤT (lần falsify đầu FAIL vì copy test cũ, test cũ không có case 0/âm).
- **Falsify guard nhiều lớp mà chỉ gỡ 1 lớp ⇒ test vẫn xanh (lớp kia che).** Luật "classifier
  không lộ ERP id" có 2 lớp (regex `ID_LIKE` + allowlist `SLOT_KEYS`); thêm `customer_id` vào
  allowlist vẫn PASS vì regex chặn trước — phải gỡ CẢ 2 mới đỏ. → Trước khi falsify: liệt kê
  mọi lớp bảo vệ, gỡ đồng thời; test xanh sau khi gỡ 1 lớp ⇒ đi tìm lớp còn lại.
- **Test dùng wall-clock bucket rồi cộng offset ⇒ flaky gần biên.** `p1-entity-state` dedup
  dùng `Date.now()` + `now+60s` với bucket 15' ⇒ tách 2 mốc khi chạy trong 60s cuối bucket
  (đo thật: còn 2.9s). Đây là flaky CÓ SẴN, không do P3, nhưng P3 là phase về CI gate nên đã
  sửa (ghim `now` vào giữa bucket). → Test có window/bucket phải tiêm `now` cố định.
- **Bait assertion quá rộng:** assert "toàn kết quả không chứa `CUST-00001`" SAI vì ID đó hợp
  lệ từ Entity Resolver — thay bằng ca mạnh hơn: mock trả id SAI (CUST-00002) nhưng text nói
  "lan" ⇒ chứng minh id của LLM KHÔNG được dùng làm authoritative (ID chỉ từ resolver).
- **Review P3 tìm thêm 1 điểm mong manh thật:** route suy từ contract (`routeByCapability`:
  `route_group` → skill factory) có thể trả route thiếu implementation (factory undefined) ⇒
  ném ở thời điểm gọi ⇒ sập cả request. Hôm nay mọi group runnable đều có factory nên không
  test nào đỏ — nhưng entry tương lai thì có. Đã thêm guard fail-closed (thiếu factory + không
  forbidden ⇒ trả null → UNKNOWN_INTENT) + test phủ mọi capability. Falsify trên /tmp: chèn
  `route_group:"sales2"` (không factory) ⇒ coverage test đỏ; bỏ guard ⇒ route lọt với
  factory=undefined (đúng ca sẽ crash). → Bảng ánh xạ suy từ cấu hình phải có guard + test phủ,
  KHÔNG tin "hiện tại chưa có ca lỗi".

## Vòng review P7 (2026-09-18) — 4 bài học mới

- **Runner đóng cứng dependency ⇒ exit criterion không thể test.** `startJobRunner` gọi thẳng
  `runExecute` trong closure nên test inject gateway giả vẫn chạy gateway thật → FAILED, và
  claim "queued → VERIFIED đã test" là rỗng. Fix: tham số có default (`execute = runExecute`)
  + static assertion call site thật không inject.
- **Test lỗi syntax = cả file test không chạy**, node chỉ báo 1 fail ở dòng 1. Kiểm `ℹ tests N`
  trước khi đọc logic.
- **Falsify phải nhắm đúng hàm mà test đi qua.** Gỡ guard ở `pending()` không chứng minh gì khi
  `drain()` dùng `dueJobs()`.
- **State dir mới phải vào `.gitignore` cùng đợt code** (`job-queue/` untracked sau E2E, chứa
  command_id thật).

## Kỷ luật bắt buộc trước khi báo "xong" (tóm tắt từ SKILL.md)

1. Chạy test thật của đúng phạm vi đổi (targeted), dán output nguyên văn.
2. Falsify từng fix (gỡ → FAIL đúng chỗ → khôi phục → xác nhận khôi phục).
3. Docs claim hành vi ⇒ grep code đối chiếu; claim "test chứng minh X" ⇒ đọc test đó.
4. Secret scan trên mọi file sẽ commit; `.env` không bao giờ vào git.
5. Sau mỗi phiên: cập nhật resultNN + checklist + next + working + handoff (+ skill
   nếu có bài học mới).

## Vòng P10 slice (2026-09-18) — review bắt 3 lỗi thật của chính code vừa viết

- **Đừng viết lại thứ contract đã có.** `capabilityForAction()` đã tồn tại trong
  `capability-contract.mjs`; bản sao trong `rate-limit.mjs` đọc một nhánh không tồn tại
  ⇒ luôn `null` ⇒ limit `payment.create 20/hour` **tắt lặng lẽ**. Test pin vào entry THẬT.
- **`export { x } from` không tạo binding cục bộ.** `proposalBucketFor()` gọi nó ⇒
  `ReferenceError` nằm trong `try` của `/ask` ⇒ mọi câu hỏi trả 500. Phải `import` rồi
  `export`, và test phải đi qua WIRING chứ không chỉ hàm thuần.
- **Env đọc ở cấp module là hằng số theo module cache.** `NLP_PORT` đóng băng lúc import;
  test set port trong thân test ⇒ pipeline descend thành NLP_UNAVAILABLE mà vẫn 200. Pin
  env ở ĐẦU file test, trước mọi import.
- **Meter theo loại, không theo sự hiện diện của field.** Mọi route ĐỌC cũng trả proposal
  ⇒ nếu charge theo `proposal != null` thì câu hỏi đọc tiêu ngân sách ghi.

## Review vòng 3 P10 (2026-09-18) — claim vs bằng chứng, và lỗ hổng đúng chỗ vừa hỏng

- **Claim UI phải grep phía client.** "✅ in-app polling" trong `p7-result.md` dựa trên endpoint
  server; `apps/mobile/lib` không có một dòng nào gọi `/jobs`. Endpoint + log stderr không chứng
  minh được hành vi người dùng thấy.
- **Đường wiring từng hỏng im lặng phải có test với config KHÁC RỖNG.** Mọi test HTTP đều truyền
  `perCapability: {}` ⇒ fix của F1 chưa từng được chạy E2E cho tới khi thêm test dùng rule thật.
- **Đừng để "tạm thời" thành "thất bại".** Probe thật: job QUEUED gặp kill switch ⇒ `FAILED` sau
  1 lần, terminal, dù chưa từng thử ghi (verdict `SYSTEM_MAINTENANCE` thiếu `retry_same_command_id`).
  Phải test TƯƠNG TÁC 2 feature (kill switch × queue), không chỉ từng feature riêng.

## Đồng bộ docs sau commit (2026-09-18) — marker trạng thái mục nát ở section MÌNH KHÔNG ĐỤNG

- **Luật "quét marker sau commit" đã có trong skill nhưng KHÔNG được chạy** ⇒ vẫn còn 4 marker
  "CHỜ DUYỆT COMMIT" trong tài liệu sống, tất cả đều thuộc **phase/đợt cũ**:
  `next.md` P1 (đã `ee93f13`), `features.md` P3 (đã `c38e4ea`), `checklist.md` + `next.md` result43
  (đã `c401b0f`/`f28869a`).
- **Vì sao lọt:** mỗi phiên chỉ cập nhật **section mới nhất** mình vừa làm; marker của phase cũ nằm ở
  section khác nên không bị chạm tới. Sửa phase mới KHÔNG tự làm sạch phase cũ.
- **Cách bịt:** ngoài `grep` marker, phải quét thêm (1) theo **hash của chính phiên vừa commit**
  (`grep -rn "<hash>" *.md`) và (2) theo **tên phase** (`grep -rn "^### P[0-9]" next.md`) đối chiếu
  từng dòng "KỸ THUẬT XONG/CHỜ DUYỆT" với `git log --oneline`.
- **`handoff_*.md` là ngoại lệ:** đó là **ảnh chụp** của phiên, giữ nguyên trạng thái lúc viết —
  không phải tài liệu sống, không cần (và không nên) sửa marker trong đó.

## Phiên P8 (2026-09-18) — phân quyền: 2 nguồn danh tính, nhánh chết, và phép đo thay cho phỏng đoán

- **Một khái niệm "ai" duy nhất.** P8 thêm `principal.user_id` trong khi log/rate-limit vẫn dùng
  `userId` suy từ credential. Hai nguồn trùng nhau trong production nên không test nào đỏ, nhưng
  chúng TÁCH RỜI được ⇒ audit có thể ghi người khác với người được authorize. Fix: `userId` nay suy
  TỪ principal. Luật: khi thêm identity, quy mọi chỗ đang suy "ai" (credential/header/IP) về một
  nguồn; test phải cố tình tách rời 2 nguồn và assert log ghi đúng nguồn phân quyền.
- **Nhánh chết: test "trông như đã cover".** Gỡ nguyên nhánh allow-list company mà 14/14 vẫn xanh —
  case duy nhất về company bị chặn bởi nhánh *mismatch* đứng trước. Chỉ khi thêm principal KHÔNG có
  company pinned (chỉ có `companies: [...]`) thì falsify mới đỏ. Luật: luật có ≥2 nhánh trả cùng
  refusal ⇒ mỗi nhánh cần một test đi vào ĐÚNG nhánh đó; falsify từng nhánh, đếm pass/fail —
  fail không đổi = nhánh chưa từng được chạy.
- **Mã refusal mới phải đối chiếu bảng copy UI.** `COMPANY_SCOPE_REQUIRED` chỉ tồn tại trong 2 file
  server; `uncertainty.mjs` không biết ⇒ user nhận refusal không có chữ nào. Luật: grep mã mới toàn
  repo; test liệt kê mọi mã lớp mình phát ra và assert map được + `uncertaintyCopy().message` không rỗng.
- **"Đo thật" = một lần chạy suite, ghi con số.** Miễn trừ company cho single-tenant ban đầu là
  ước lượng "đỡ vỡ 29 test"; chạy thật `if (false)` ⇒ **267 → 234 (33 đỏ)**. Con số thật là tài sản
  thiết kế, ghi vào `p8-result.md`; ước lượng thì không phải.
- **Đóng phase phân quyền phải duyệt từ danh sách ROUTE, không từ call site.** `runExecute` có đúng
  2 call site là chưa đủ — `/jobs` và `/execute/cancel` không đụng tới nó nhưng vẫn lộ/đổi dữ liệu
  của người khác. Mỗi route tự hỏi "route này lộ gì / đổi gì".

## Bugfix P6 (2026-09-18) — "danh sách của API" bị đọc thành "năng lực của nền tảng"

> Bằng chứng đầy đủ: `result55.txt` · `.plan/phases2/p6-result.md` §"Bugfix P6" · hàng bảng
> tương ứng trong `.agents/skills/erpn-verify-first/SKILL.md`.

- **Danh sách của API ≠ năng lực thật của nền tảng.** `SpeechToText.locales()` chỉ phủ recognizer
  **ON-DEVICE** (doc nguyên văn: list "may not be the complete list of languages available for
  online recognition"); máy Android thường KHÔNG có `vi` trong list mà vẫn nhận tiếng Việt tốt.
  Code cũ coi "thiếu `vi`" = "máy không hỗ trợ" ⇒ **cảnh báo sai**, chặn đúng use case chính
  (user thấy vậy thì không dùng mic). Luật: tín hiệu "tôi không chắc" chỉ được hiển thị dạng
  **gợi ý**, không bao giờ dạng **từ chối/tuyên bố năng lực**; trước khi biến dữ liệu của API
  thành phán quyết về hệ thống, đọc doc xem nó chỉ phủ cái gì.
- **Falsify phải tái tạo ĐÚNG code cũ — "đỏ" ≠ "đỏ đúng chỗ".** Lần falsify đầu tôi đảo nhánh
  ternary nên test đỏ là ca KHÁC (máy CÓ tiếng Việt lại bị gợi ý), không phải ca bug của user;
  làm lại nguyên văn code cũ mới đỏ đúng test "hint, not refusal".
- **Implement interface mới bằng FIELD trùng tên getter (Dart) ⇒ compile fail cả file test**
  (`'localeVerified' is already declared`). Sau khi thêm member vào interface: chạy `analyze`
  TRƯỚC `test`; fake nên dùng tên field khác (`localeIsVerified`).
- **`find.textContaining` phân biệt HOA/thường** — đổi chữ đầu câu trong copy làm 2 widget test
  đỏ dù logic đúng ⇒ mất 1 vòng sửa vô ích. Sau khi sửa copy: grep lại mọi test assert chuỗi đó.
- **Test widget + widget NGOÀI viewport: `ListView` LAZY không BUILD phần tử dưới màn hình.** Thêm 1 mục
  vào `SettingsScreen` ⇒ 3 test cũ đỏ (`Bad state: No element` ở `ensureVisible(find.text('Lưu'))`) dù code
  đúng, vì nút Save bị đẩy ra ngoài 800×600 và **chưa từng tồn tại** để tìm. Sửa: cho viewport test cao
  hơn (`tester.view.physicalSize = Size(1000, 2400)` + `addTearDown(tester.view.reset)`) — không đi
  scroll từng chỗ; nếu phải scroll thì dùng `scrollUntilVisible`, không dùng `ensureVisible`.
- **Mỗi luật chặn ở đúng MỘT tầng.** Vòng này tôi đặt check "transcript rỗng" ở cả `_onSpeechResult`
  (caller) lẫn `_maybeAutoSend` (callee) ⇒ lớp trong là code không thể chạm: falsify gỡ nó mà **0 test
  đỏ**. Gỡ lớp trùng + tham số thừa; luật = falsify từng chỗ, chỗ nào gỡ mà không đỏ thì nó chết.
- **Tín hiệu user KHÔNG HÀNH ĐỘNG ĐƯỢC thì đừng hiển thị (kể cả "gợi ý nhẹ").** Vòng 1 của bugfix
  P6 đổi "Máy không có bộ nhận dạng tiếng Việt" → gợi ý nhẹ "Máy không liệt kê tiếng Việt…"; user
  báo vẫn thấy dòng đó trên máy nhận tiếng Việt tốt (không thể "thêm locale" cho máy, mà đọc vẫn
  chạy) ⇒ vòng 2 **bỏ hẳn** (`_notice = null`), giữ nguyên cảnh báo THẬT `denied`/`unavailable`/
  `error_language_*` + thêm test cho ca "máy thiếu `vi` **và** bị thu hồi quyền". Luật: trước khi
  hiển thị một tín hiệu nền tảng, hỏi "user đọc xong làm được gì?"; hạ giọng cảnh báo mà vẫn hiện
  thường = vẫn còn phải bỏ.
- **Đừng `dart format` trong repo không conform formatter hiện hành.** Đo trước bằng
  `dart format --output=none --set-exit-if-changed lib test` ⇒ **20/28 file non-conforming**
  (tall style Dart 3.13 vs repo style cũ); chạy format trên 4 file đã sửa làm diff phình
  +272 → +459 rồi phải revert thủ công. Luật: đo mức non-conforming TRƯỚC, nếu repo không theo
  formatter thì **không** format file mình sửa — diff bugfix phải đúng phạm vi.

## Review vòng 3 — switch "Tự gửi sau khi nói xong" (2026-09-18)

Bối cảnh: user yêu cầu "review code những gì vừa làm" cho tính năng auto-send vừa viết. 3 lỗi thật
+ 1 guard chết thứ 3 + 1 câu hỏi để ngỏ (chi tiết `result55.txt` §11).

- **"Đỏ" trong falsify KHÔNG tự chứng minh test MỚI của mình có giá trị.** Gỡ lớp guard
  `if (!_listening) return;` ⇒ đúng là đỏ, nhưng đỏ ở **test cũ** ("a late result after stop must
  not resurrect text") — nghĩa là lớp đó đã có test khác canh từ trước, test mới của tôi không
  chứng minh được gì về nó. Luật: sau mỗi falsify, đọc **TÊN test đỏ**; nếu không phải test mình
  vừa viết thì ghi trung thực là "lớp này đã được test cũ canh", đừng gán công lao.
- **Guard thứ 3 trong CÙNG một tính năng vẫn là guard chết** — sau khi đã gỡ 2 guard trùng, lớp
  `if (!widget.enabled) return;` trong `_maybeAutoSend` vẫn không thể chạm (gỡ ra: 120 test vẫn
  xanh). Lớp THẬT SỰ chặn gửi chồng là `ChatController.send` (`if (state.isLoading) return false`).
  Luật: mỗi luật **một nhà**; lớp nào gỡ ra mà suite không đổi = lớp chết, xoá luôn.
- **Doc nằm cạnh code vừa đổi hành vi vẫn hứa hành vi cũ.** `_InputBar` docstring còn "The mic has
  **no** auto-send" sau khi thêm switch; `SpeechService.localeVerified` còn "UI may only show a soft
  note" sau khi UI bỏ hẳn notice. Luật: sau khi đổi hành vi, grep chính từ khoá của hành vi đó
  (`auto-send`, `notice`, `"no " + tên hành vi`) trên toàn repo — kể cả doc của **interface**.
- **Báo "đã lưu" từ MỘT trong nhiều lần ghi.** `_save()` chỉ đọc `okGateway`, còn `bool` của
  `saveAllowSubmitPayment`/`saveVoiceAutoSend` bị bỏ ⇒ storage ghi string được nhưng từ chối bool
  ⇒ switch hiện ON mà không lưu gì (đúng họ lỗi "nói đã lưu nhưng không lưu" user từng gặp với URL
  gateway). Sửa: `ok = okGateway && okSubmit && okVoice` + test với fake **chỉ-từ-chối-ghi-bool**
  (mọi fake "thành công hết" không bao giờ lộ lỗi ghi một phần).
- **Để ngỏ còn hơn tự quyết một hành vi user chưa chắc muốn:** `pauseFor: 3s` (Android có thể ép
  1–3s) nghĩa là khi switch BẬT, **ngập ngừng giữa câu** = "đọc xong" ⇒ gửi câu nửa vời. Hành vi
  đúng đặc tả ("final ⇒ gửi") nhưng hậu quả có thể ngoài ý user ⇒ ghi vào `human.md` §1 kèm 3 lựa
  chọn (a/b/c) và **không tự đổi**.

## Đợt DSH END-TO-END (2026-09-19) — 3 bài học mới

- **"Không thấy trong log tôi đang xem" ≠ "không xảy ra".** `/dsh/ask` trả 502; tôi đọc stdout của
  router (chỉ có dòng `ready`) và kết luận sai "router không nhận request". File audit JSONL
  (đường dẫn in ngay ở dòng `ready`) mới là nơi ghi request — và nó ghi **có**: `attempts=['mac-custom']
  status=408` (localtunnel timeout). Luật: đọc dòng `ready` để lấy **đường dẫn audit thật**, đối
  chiếu ở đó trước khi phát biểu về luồng request.
- **Falsify một lớp trong hệ nhiều lớp guard ⇒ XANH là kết quả ĐÚNG, không phải test hỏng.** Gỡ 1
  guard `ref.mounted` vẫn xanh vì còn lớp sâu hơn (`_append`/`_recordFailure`). Muốn chứng minh
  tập hợp guard có tác dụng: đếm số lớp, tháo **hết** ⇒ 2 test dispose ĐỎ (`UnmountedRefException`)
  ⇒ khôi phục xanh lại. Ghi cả hai vế vào bằng chứng.
- **Ghi `state` sau async gap khi provider auto-dispose = crash thật, dễ trúng hơn khi phiên dài.**
  `chatControllerProvider` (`@riverpod`) bị dispose khi user rời màn hình; response về sau ghi
  `state` ⇒ `UnmountedRefException`. Lỗi có sẵn ở đường `/ask` từ Phase 3, DSH chỉ mở rộng cửa sổ
  (~20s). Sửa: `if (!ref.mounted) return false;` sau mọi await + test dispose cho **cả hai** đường
  (đừng chỉ sửa đường mình đang làm).

## Đợt DSH RUNTIME DISCOVERY (2026-09-19, `result59.txt`) — 5 bài học mới

- **Chuỗi fallback làm cho "PASS" trở thành oracle YẾU: lệnh kiểm tra phải in NGUỒN nào thắng.**
  `dsh:check` vẫn PASS khi tôi gỡ nhánh `npx` — vì máy dev CÓ `/tmp/dsh-run` nên resolver rơi xuống
  fallback và chạy được **ở máy này**. Ca thật cần bắt ("chạy được ở máy dev nhưng KHÔNG mang sang
  máy khác") vẫn im lặng đi kèm chữ PASS. Sửa: in `source=npx-pinned|legacy-tmp|…` và WARN riêng
  cho nguồn máy-cục-bộ. Luật: khi có ≥2 nguồn hợp lệ, bằng chứng phải nói **đang dùng nguồn nào**,
  không chỉ "nó chạy".
- **Falsify phải kiểm cả HARNESS của chính mình — "không thấy đỏ" ≠ "không có đỏ".** 2 vòng falsify
  (health không chạy thật / gỡ nhánh `DSH_COMMAND`) chạy xong mà output trống: tôi grep
  `^# (pass|fail)` nhưng reporter MẶC ĐỊNH của `node --test` in `ℹ pass 43`, không phải TAP.
  Oracle sai ⇒ nguy cơ đọc "im lặng" thành "không lỗi". Luật: sau mọi falsify phải **ĐẾM** được
  `pass/fail` (hoặc exit code), và khi output rỗng thì nghi oracle trước khi kết luận code đúng.
- **Response lỗi phải TỰ MANG lý do — đừng buộc người sau mở log server.** `/dsh/ask` trả
  "DSH Agent không trả lời được (lỗi phiên)" ⇒ phải vào `tail` log mới biết thật ra là
  `llm-router: all upstreams failed (tried: mac-custom)`. Thêm `log_tail` vào payload: lần chạy
  ĐẦU TIÊN sau đó đã hưởng lợi ngay (nhìn response là biết tunnel Mac chết). Luật: lỗi đi ra tới
  client nên kèm 1 mẩu lý do NGUYÊN VĂN từ tầng dưới (đã bound độ dài).
- **Health phải CHỨNG MINH, không suy luận từ sự tồn tại của file.** Cùng họ với bài học result58
  (`existsSync ≠ chạy được`): `dshGatewayHealth()` nay chạy `--version` thật qua đúng spawn plan,
  fail ⇒ `available:false` kèm lý do. Falsify: thay bằng object giả ⇒ 2 test health ĐỎ.
- **Kiểm chuỗi trong APK: phải tìm trên file ĐÃ GIẢI NÉN, và AXML string pool là UTF-16LE.**
  Hai lần dò label `Nghiệp Vụ AI` trả 0 hit *giả*: lần đầu grep thẳng bytes của `app-debug.apk`
  (nội dung `resources.arsc` bị deflate ⇒ không đọc được), lần sau `strings -el` nhưng trên
  `resources.arsc` chứ không phải `AndroidManifest.xml`. Chỉ khi unzip ra rồi đếm cả UTF-8 và
  UTF-16LE mới ra: `AndroidManifest.xml | utf-16-le | 1 hit | '…Nghiệp Vụ AI·…'`. Luật: 0 hit
  là **kết quả đáng nghi trước tiên**, không phải bằng chứng "không có" — đổi cách tìm trước
  khi kết luận về artifact.
- **Tách khái niệm theo câu hỏi, đừng gộp field.** `runtime` (topology local/remote — chạy Ở ĐÂU)
  và `source` (cách resolve — CHẠY BẰNG GÌ: npx/pin/entry/legacy) là 2 câu hỏi khác nhau; gộp lại
  thì ca "máy Mac báo available mà không chạy được" không chẩn đoán nổi. Tách ra ⇒ đọc 1 dòng
  `/dsh/health` là biết ngay (và field `source` đã phát hiện đúng lỗi gốc khi falsify ưu tiên).

## Đợt phases3 — Trụ B (WRITE #2–#4) + Trụ C (camera/OCR) (2026-09-20, `result62.txt`)

> Chi tiết đầy đủ theo từng phase ở `.plan/phases3/*-result.md` (bị gitignore) + skill
> `erpn-verify-first/SKILL.md`. Dưới đây là các bài học mới CHƯA có nhóm tương ứng.

- **Kiểm guard TĨNH CỦA REPO trước khi import chéo tầng.** C2: `ocr-slots.mjs` import từ
  `skills/` ⇒ C0 static test (cấm `src/ocr/**` reference `skills/` — chặn khả năng với tới
  executor) đỏ. Guard ĐÚNG, code sai chỗ đặt ⇒ tách `src/line-parse.mjs` làm nhà chung PURE
  thay vì nới guard. Luật: trước khi import chéo tầng, `grep` xem repo có test tĩnh nào canh
  ranh giới đó không; khi guard bắt, **sửa chỗ đặt code**, đừng nới guard.
- **Harness falsify phải đặt TRONG REPO, không để `/tmp`.** B2/B3 để harness ở `/tmp`
  ⇒ mục nát/không tái chạy được; C0/C1/C2 đặt `scripts/falsify/*.mjs` ⇒ chạy lại được sau
  mọi refactor (C2 phải bắc cả 2 runtime: 5 guard Node + 4 guard Dart `flutter test`).
- **"Falsify không đỏ" ⇒ kiểm đã gỡ 1 lớp hay TOÀN BỘ chuỗi guard dự phòng.** B3 ca F chỉ
  xanh vì `setReference` đã phủ sẵn; B2 phải tháo **hết 9 lớp** `ref.mounted` mới đỏ.
- **Oracle mơ hồ (ĐÚNG kỹ thuật nhưng ĐÚNG nguồn hay không?)** — C2: finder Flutter
  `find.text('Đơn mua')` khớp 2 chỗ (title + label) ⇒ neo assertion vào chuỗi duy nhất
  (`Ảnh → Đơn mua (NHÁP)`). Cùng họ nhóm 7 (oracle rỗng) và top bài học "assertion đuôi câu".
- **Test tự khai input giả thì không kiểm được HỢP ĐỒNG THẬT.** C2: unit test kỳ vọng
  `uom === 'Bao'` vì tự khai nlp giả; NLP Python thật trả canonical **thường** `'bao'` ⇒
  sửa kỳ vọng theo hợp đồng THẬT + vẫn assert `raw_quantity` giữ nguyên văn `"10 Bao"`.
  Luật: khi test một cầu nối, dùng output THẬT của tầng dưới (chạy nó), đừng tự bịa shape.
- **MỘT triệu chứng có thể có ≥2 nguyên nhân ở 2 tầng khác nhau — phải verify lại trên
  DỮ LIỆU THẬT sau khi sửa.** result63 (issue1): triệu chứng "app báo khách không có trong
  ERPNext" có **hai** nguyên nhân — (1) fallback-mock ngầm phục vụ `CUST-00001 = "Nguyễn Thị
  Lan"` từ fixture (đã sửa), VÀ (2) resolver substring khớp SAI khách: user gõ
  "Nguyễn Thị **Lan**" nhưng fragment ngắn hơn `"Nguyễn Thị"` khớp unique với khách có thật
  "Nguyễn Thị **B**" (site không có ai tên "Lan") ⇒ ĐỌC trả lời tự tin về sai khách,
  `error_code: none`. Chỉ chạy lại đúng câu hỏi đó trên site THẬT mới thấy — suite xanh +
  unit xanh đều không phủ. Luật: sau khi sửa nguyên nhân tầng trên, **chạy lại chính câu hỏi
  gốc trên dữ liệu thật**; khi truy nguyên entity, **in ra `entity_id` thật đã chọn**, không
  chỉ câu trả lời (câu trả lời luôn trông hợp lý khi sai khách).
- **Ảnh không có "động từ mệnh lệnh" — tín hiệu Ý ĐỊNH phải đến từ NGƯỜI, không từ OCR.**
  C2 §0 đo trước: mọi ảnh chụp (`HÓA ĐƠN`/`PHIẾU THU`/mock C1) route vào đường **ĐỌC** ⇒
  design đúng là **user chọn loại chứng từ**, rồi câu đã sửa đi qua ĐÚNG `/ask` + Safety
  Gateway ⇒ **không có đường ghi thứ hai**. Đây cũng là cách tránh "OCR authoritative id".
- **Mock (CI) bỏ qua input theo thiết kế ⇒ phải kiểm input ở BIÊN, không ở provider** (xem
  nhóm 3, mục họ hàng C1) — mock trả hóa đơn bịa 200 OK cho `{}` nếu không có `assertOcrInput`
  ở route.
- **Provenance/safety gate là DEFAULT AN TOÀN, không phải security boundary** — client nói dối
  được, nhưng vì câu chữ vẫn qua `/ask` + confirm + Safety Gateway nên **không ghi được**.
  Mục đích thật: client thường/quên đổi mock không thể **seed proposal vô ý**. Nói rõ điều này
  trong result để phiên sau không tưởng nhầm nó chống được attacker đã auth.

## Đợt issue1 — tắt fallback-mock ngầm + verify ERPNext THẬT (2026-09-21, `result63.txt`)

> Chi tiết ở `result63.txt`; bài học dạng hàng đã ghi vào `erpn-verify-first/SKILL.md`.

- **Nhánh fail-OPEN duy nhất còn sót: cấu hình THIẾU bị đọc thành "cứ dùng dữ liệu giả".**
  `pickServerScript()` coi `!url && !key && !secret` ⇒ mock; launcher `dsh` quên export
  ⇒ mọi câu hỏi được trả từ `mock-server.mjs` (hard-code `CUST-00001 = "Nguyễn Thị Lan"`)
  và **agent runtime kể nó như dữ liệu ERPNext thật**. Luật: thiếu cấu hình là FAULT, không
  phải sự đồng ý; fixture phải cần **xin phép tường minh** (`COPILOT_MOCK_OK === "1"`, đúng
  chuỗi — truthy lookalike vẫn từ chối). Đây cùng họ với nhóm 3 (fallback âm thầm).
- **Test phải tái hiện ĐÚNG kịch bản bug, kèm CONTROL chứng minh nguyên nhân.** 5.4 spawn
  copilot với env "launcher quên set" → exit 2 + stdout RỖNG (không tên khách/số tiền nào);
  control: cùng env + opt-in → trả `CUST-00001 / 2.500.000`. Nếu chỉ có vế đầu, không loại
  trừ được "hỏng vì lý do khác".
- **"Người ta có thể quên set" phải được ĐO, không phải suy luận** (5.6): chạy suite
  KHÔNG có opt-in → child in `ERPNEXT_NOT_CONFIGURED` rồi **exit 124** (`timeout`), tức không
  hề âm thầm phục vụ fixture. Ghi kèm exit code thay vì chỉ nói "sẽ báo lỗi rõ ràng".
- **Thêm một đường mới ⇒ khoá bằng TRIPWIRE TĨNH, đừng chỉ viết prose.** Tripwire mới quét
  `src/` + `scripts/` cho `MOCK_SERVER` và chỉ cho đúng 3 file hợp lệ ⇒ một đường mock im lặng
  trong tương lai làm test đỏ và **nêu tên file**. (Và chính tripwire này bắt harness falsify
  của tôi — phải dựng chuỗi `"MOCK"+"_SERVER"` để file harness không tự chứa literal.)
- **Xem nhóm 17** (công cụ tự-sửa-file để lại mutation khi bị ngắt) — bài học đắt nhất phiên này.

### Phần 2 — fix bug resolver "trả lời SAI khách" (cùng phiên, sau khi user duyệt)

- **Fix ở tầng NGUỒN QUYẾT ĐỊNH, và dùng từ vựng của CONTRACT thay vì hardcode.** Rule 2b cần phân
  biệt "user gõ thêm TÊN" với "user gõ từ Ý ĐỊNH" ⇒ lấy từ vựng từ `listRouting()` (contract),
  nên nhóm route mới tự được phủ. Đây cũng là cách tránh bản sao thứ hai của một danh sách.
- **Xem nhóm 18** (guard chặn quá rộng ⇒ 3 hồi quy, chỉ full suite bắt được).
- **Đo lại trên dữ liệu THẬT theo kiểu "đổi đúng 1 dòng"**: đo 11 câu hỏi trên ERPNext thật TRƯỚC và
  SAU, rồi `diff` hai danh sách ⇒ chứng minh **chỉ ca bug đổi**, 10 ca còn lại y nguyên. Đây là
  dạng bằng chứng mạnh hơn "test xanh": nó chứng minh phạm vi ảnh hưởng, và cách này lặp lại được
  cho mọi thay đổi trong resolver.
- **"Thận trọng ≠ đúng": ghi riêng gap phủ sóng, đừng lặng lẽ mở rộng phạm vi.** Đo được nhiều tên
  nhiều từ thật (kể cả khớp ĐÚNG NGUYÊN VĂN) vẫn MISSING/AMBIGUOUS, một phần do Phase 1 stripper ăn
  mất tên ⇒ ghi thành §9.3 + đề xuất task riêng, KHÔNG tự sửa trong phiên đã được duyệt cho 1 bug.

## Đợt P4-1 — `ops.daily_summary` (2026-09-21, `result-p4-1.txt`) — bản review tự bắt 5 lỗi THẬT

Phiên này **OCR không chạy được** (checkout không có git ⇒ không có diff để review). Vẫn bắt
được 5 lỗi thật bằng **review mặc định** (tự đọc code + soát lớp lỗi phổ biến + đo trên site thật)
⇒ thiếu OCR **không** phải lý do bỏ review.

- **Nhánh aggregate nuốt lỗi = SỐ 0 GIẢ.** `app_drafts` bọc `try/catch {}` quanh 4 lượt đọc, với
  lý do viết trong comment: "site thiếu field là CHUYỆN BÌNH THƯỜNG". Đo trên site thật thì
  `custom_ai_action_id` **chỉ tồn tại trên Payment Entry** (Custom Field meta: 0 row cho
  SO/SI/QT/PO) ⇒ block đó **luôn** báo "0 nháp" cho một câu hỏi site KHÔNG THỂ trả lời — đúng cái
  §4.3 cấm. Luật: trong hàm tổng hợp, mỗi `catch` phải trả **null + lý do**, không bao giờ một giá
  trị "trông hợp lệ"; comment biện minh cho việc nuốt lỗi là dấu hiệu phải ĐO lại (thực tế thường
  khác "thi thoảng").
- **Cộng thiếu im lặng tệ hơn thiếu dữ liệu (đường tiền).** Trang bị cắt (`limit`) ⇒ tổng tiền
  **sai mà không có lỗi nào**. Tool thật không cho biết tổng đã lọc (`count` = số dòng trả về) ⇒
  cách duy nhất đáng tin là **xin `limit+1`** và từ chối cộng khi nhận nhiều hơn mức chấp nhận
  (`ERP_TRUNCATED` ⇒ block null). Luật: mọi phép CỘNG phải có bằng chứng "đã đọc hết", hoặc nói rõ
  là không đọc hết.
- **Guard không falsifiable = TRANG TRÍ — harness tự tố cáo.** 2 ca `PROBLEM` không phải anchor sai
  mà là "bỏ guard ⇒ suite vẫn xanh": (a) khối `if (!so.ok …) { /* comment */ }` rỗng (hành vi nằm ở
  mapping `so.ok ? … : null` bên dưới); (b) guard kiểm kiểu filter runtime — mọi filter trong file
  đều là literal nên **không có test nào đi qua được nó**. Luật: bỏ-guard-không-đỏ ⇒ hoặc viết test
  khẳng định **thông điệp lỗi cụ thể** (malformed payload: hôm đó test assert `ERP_MALFORMED_RESPONSE`
  mới phân biệt được với TypeError bị `catch` chung), hoặc **xoá guard** và khoá invariant bằng
  tripwire tĩnh.
- **Trước khi tin một con số tổng hợp: đối chiếu chéo bằng đường ĐỘC LẬP.** `receivables` =
  **551.910.625** được cộng lại bằng REST paged 1000/lần ⇒ **295 HĐ, khớp chính xác**; và két khớp
  **chuỗi 3 ngày** (closing 09-19 = opening 09-20 = 243.302.620; closing 09-20 = opening 09-21 =
  243.622.620). Luật: số tiền do MÌNH cộng phải có ít nhất 1 phép đo độc lập + 1 tính chất nội tại
  (ở đây: opening của ngày sau = closing của ngày trước) — test xanh trên fixture không thay được.
- **Đo "bằng chứng giá trị" thay vì "field tồn tại"**: `--dry-run`/probe cho `custom_ai_action_id`
  trước đây chỉ kết luận "417 ⇒ thiếu field"; lần này hỏi thẳng **`Custom Field` meta** ⇒ biết CHÍNH
  XÁC doctype nào có/không ⇒ cùng một dữ kiện nhưng biến câu hỏi "gặp sự cố" thành việc cần làm rõ
  ràng (tạo Custom Field) và phạm vi ảnh hưởng (B2/B3/B4 correlation chỉ đúng với mock).

## Đợt P4-2 — route `GET|POST /read/daily-summary` (2026-09-21, `result-p4-2.txt`)

OCR vẫn **không chạy được** (checkout không có git). Review mặc định (đọc code vừa viết + kiểm lớp
lỗi phổ biến) **bắt 2 lỗi thật**, và chính quá trình falsify bắt thêm **2 lỗi của harness**.

- **Test xanh vì ENV RÒ, không vì code đúng.** Helper `withFixture()` khôi phục một **danh sách cứng**
  key env; `COPILOT_COMPANY` do test "config pin" set **sót lại**, nên test kế tiếp
  ("không có company ⇒ 503") trả **200**: company được **pin từ env rò**, và câu khẳng định của test
  vẫn "đúng" theo cách sai. Sửa bằng snapshot **đúng những key mình chạm**. Dấu hiệu nhận biết:
  test đỏ ở lần chạy **đơn lẻ** nhưng xanh khi chạy **cả file** — xếp lại thứ tự test là cách rẻ nhất
  để lộ env rò.
- **`--test-name-pattern` khớp 0 test vẫn exit 0 = "xanh" giả.** Ca falsify D dùng pattern chứa `?`
  (regex!) nên **không test nào chạy** và harness báo `PROBLEM NOT RED` — nếu không có bước kiểm
  "đếm test đã chạy", harness sẽ im lặng cho qua một guard **chưa từng được chứng minh**. Luật harness
  nay: escape pattern + đếm `# tests ≥ 1` + chạy **xanh trước** khi mutate + đỏ phải **đúng tên test**.
- **`pickServerScript()`/`createMcpClient()` ngoài `try` = giết cả service.** Throw ở đó là
  **unhandled rejection** ⇒ Node thoát ⇒ một request drawer comment sai cấu hình giết luôn `/ask`.
  Hình dạng thất bại của lớp này là **process chết** (không phải assertion), nên test được viết để
  hỏi tiếp `/health` sau câu trả lời 503 — nếu process đã chết thì không ai trả lời nữa.
- **Và `finally` cũng có thể TREO, không chỉ `try` mới giết tiến trình**: `client.close()` chờ
  `once("exit")` trên child **đã chết** ⇒ không bao giờ settle (đo bằng probe: `TIMEOUT` sau 3s)
  ⇒ handler gọi `close()` trong `finally` không bao giờ return ⇒ rò socket + child **mỗi request lỗi**,
  ở **mọi** route mở client (`/read/list`, `/ocr/slots`, route mới). Fix 1 dòng (`exitCode/signalCode`
  ⇒ return) + test `close() is IDEMPOTENT` + falsify ca **N**. Luật: mọi tài nguyên theo-request phải có
  `close()` **idempotent** và không chờ event đã xảy ra — câu hỏi kiểm tra là "gọi lần 2, hoặc sau khi
  nó đã chết thì sao?".
- **Mã lỗi tầng hạ tầng không phải ngôn ngữ của KHÁCH.** Client gọi route cần
  `ERP_UNAVAILABLE` (từ vựng của spec §4.3) chứ không cần `TOOL_ERROR` của tầng MCP: map mã về
  whitelist theo spec, **giữ nguyên mã thật trong log**. Tách "mã cho máy khách" và "detail cho
  người vận hành" là cách giữ chẩn đoán mà không rò nội bộ.
- **Company của session phải ĐO đường đọc** (xem nhóm 23) — và khi site đa tenant mà không có default
  ⇒ từ chối chứ không chọn row đầu; client xin company KHÁC server ⇒ 403 (không lặng lẽ trả sổ khác).

## Đợt P4-3 — drawer + màn `Tóm tắt ngày` (2026-09-21, `result-p4-3.txt`)

Bước **UI Flutter** đầu tiên của plan4. Full suite Flutter **đỏ sẵn 1 test** ngay khi bắt đầu (probe
cũ, nhóm 25) — đã quy trách nhiệm bằng bằng chứng trước khi code.

- **"Không hiện 0 giả" phải được cài ở TẦNG PARSE, không chỉ tầng render.** Block `null` ⇒ thẻ lỗi
  (đúng §4.3), nhưng nếu parser biến `null`/`{}`/chuỗi lỗi thành **block rỗng 0** thì màn hình vẫn
  in "Tổng thu 0đ" — một câu về tiền mà server chưa từng nói. Vì vậy `_block()` trả `null` cho
  **cả object rỗng** ("không có số nào" = chưa đo được), và có test riêng + ca falsify cho từng dạng.
- **Fixture test phải biểu diễn được NULL, đừng để `param ?? default` ăn mất nó.** Builder
  `payload({receipts})` dùng `receipts ?? {...}` ⇒ truyền `null` **không** tạo block `null` mà âm thầm
  dùng giá trị mặc định ⇒ 3 test "block lỗi" đo sai thứ chúng tưởng đang đo. Sửa bằng cờ **tường minh**
  (`noReceipts`, `noAppDrafts`, `noCashDrawer`). Luật: nếu một test cần phân biệt "vắng" với "mặc
  định", API của fixture phải có đường biểu diễn **riêng** cho "vắng" — dùng `??` là dấu hiệu API
  fixture thiếu (và false-green chỉ chờ xảy ra).
- **Trạng thái "ngày yên ắng" / "không có gì" cần BẰNG CHỨNG TÍNH ĐẦY ĐỦ.** Ban đầu tôi guard bằng
  `partial == false`, nhưng ca falsify **xanh oan**: fixture lại để `receipts = null` nên guard
  `receipts == null` *khác* cũng chặn — guard được "chứng minh" bằng lý do không liên quan. Đổi
  fixture sang `noAppDrafts` (mọi block dòng tiền **đều có và bằng 0**, chỉ một block khác lỗi) ⇒
  mới thật sự kiểm `partial`. Luật: khi falsify một guard, fixture phải **cô lập đúng biến** mà guard đó
  kiểm — nếu không, "đỏ" có thể do nhánh khác (nhóm 20).
- **Assert "không có affordance ghi" thì đừng dựa vào chuỗi.** Danh sách cấm của tôi chứa `"Thu tiền"`,
  và nó bắt oan `"+ Thu tiền mặt"` — một **nhãn đọc** hợp lệ trong block két. Sửa thành: (a) cấm các
  cụm **hành động không thể nhầm** (`Xác nhận`, `Gửi`, `Tạo phiếu`, `Ghi nhận`, `Submit`), (b) khẳng định
  **cấu trúc** (`không có TextField`, không `FilledButton`/`TextButton` khi không có gì lỗi) — cấu trúc
  mạnh hơn từ ngữ và không phụ thuộc copy. Họ hàng nhóm 20: assert phải nhắm đúng thứ đặc trưng.
- **Harness tự bắt điểm mù của chính nó — lần này là định dạng output của `flutter test`.**
  `The test description was:` xuống dòng ở phiên bản hiện tại, nên parser lọc **một dòng** cho ra tên
  **rỗng** và cả 7 ca Dart bị báo `RED NHƯNG SAI TEST` (chứ không phải "RED ✓" mừng hụt). Nối tiếp
  nhóm 21: harness phải **kiểm tên test đỏ** chứ không chỉ exit code — và chính bước kiểm đó là thứ
  vừa phát hiện parser sai.
- **Một việc UI `30–60s cache` cần đo CẢ HAI chiều thời gian.** "Trong cửa sổ ⇒ không gọi HTTP"
  (đo bằng `calls == 0` khi server còn cố tình offline) và "quá cửa sổ ⇒ vẫn hiện số cũ + nhãn
  DỮ LIỆU CŨ **ngay lập tức**, trước khi request về" (đo bằng server bị **gate**, `settle: false`).
  Ca falsify  cho vế thứ hai ban đầu **xanh oan** vì test cũ chỉ assert nhãn *sau khi request thất bại*
  — lúc đó nhánh lỗi tự set cờ, còn guard `_stale = !fresh` không được kiểm. Luật: với state phụ
  thuộc thời gian, phải có một test quan sát **trạng thái trung gian** (request đang bay).

## Đợt P4-4 + P4-5 — drill-down + nháp app (2026-09-21, `result-p4-4.txt` + `result-p4-5.txt`)

- **SQL `COUNT` gộp cả dòng NULL/ngoài scope ⇒ “đếm” không phải là “danh sách đã lọc”.** Drill đếm bằng
  `COUNT(*)` trên tập trừ đi dòng null/company khác ⇒ **lệch +1 so với block aggregate** mà guard drift
  (tổng dòng drill = số block) bắt ngay. Luật: khi 1 số phải khớp 1 danh sách, **đếm bằng độ dài của
  chính danh sách đó** — đừng tin 2 truy vấn khác shape sẽ trả cùng một con số.
- **Guard chống drift chỉ đáng giá khi so SỐ với SỐ trên cùng fixture** — và nó bắt thật: drift đầu tiên
  (count SQL) bị nó bóc ra trước cả vòng thật. Luật: khi thêm view thứ hai của cùng dữ liệu, luôn thêm
  1 test “tổng view con = số view cha” trên cùng fixture — drift bị bắt tại CI, không phải trên site.
- **Test cũ dùng store/state DÙNG CHUNG của repo ⇒ độc hại vĩnh viễn cho lần chạy sau.** Test chaos
  duy nhất không truyền `idemStore` để lại record PENDING trong `idempotency-store/` ⇒ lần chạy sau đỏ
  ổn định (khác đỏ nhiễu: nó tái hiện được và theo thứ tự). Luật: test phải **cô lập state** (store riêng
  /tmp); thấy test đỏ “không rõ vì sao” sau khi thêm code không liên quan — kiểm state sót trên đĩa
  TRƯỚC khi nghi code mới (nhóm 25 là anh em: probe tạm; nhóm này: state tạm).
- **`Navigator.pushNamed` không đi qua GoRouter** ⇒ test điều hướng qua router đỏ dù app “chạy được”;
  app đang dùng `context.go` ⇒ theo đúng khuôn repo, không trộn 2 hệ điều hướng.
- **“Trường không được phép trong truy vấn” trên 1 doctype (P4-5)** = đủ để cả cụm đọc chết (417).
  Drill nháp hỏi
  `grand_total` cho cả 4 doctype, mà PE không có field đó (DocField meta rows=0) ⇒ site thật trả
  503 ERP_UNAVAILABLE cho TOÀN drill, trong khi mock fixture vẫn xanh (mock không biết schema thật).
  Sửa: field list **theo doctype** (`paid_amount` cho PE). Luật: **field list gửi cho NHIỀU doctype phải
  được đo meta từng doctype trước** — “cùng nhóm chứng từ” không đồng nghĩa “cùng schema”; mock không
  thể bắt được dạng lỗi này vì mock không biết schema thật ⇒ vòng thật là phép kiểm DUY NHẤT.
- **“Không bịa 0” có thêm một dạng (P4-5): row của chứng từ CÓ giá trị thật mà code hardcode 0.** Row nháp drill
  từng `amount_vnd: 0` trong khi PO có grand_total thật. Sửa 2 lớp: server COPY giá trị riêng từng chứng từ
  (PE = `paid_amount`), Flutter row nháp dẫn bằng CHỨNG TỪ và để money side là “—” (block là ĐẾM; giá trị
  draft chưa phải sổ sách). Luật: “không 0 giả” không chỉ ở tầng block/parse mà ở TỪNG ROW; client quyết
  định nhân cách nào được hiển thị, nhưng server không được cung cấp số chưa từng có.
- **Review vòng 2 của P4-4 bắt thêm 2 guard sai lặng lẽ**: (a) `Number(null)=0` ⇒ KHÔNG gửi limit bị clamp về min
  thay vì default; (b) nháp app không lọc company ⇒ nháp công ty khác bị đếm oan. Cả hai đều thuộc dạng
  “default path sai” mà test nghiệp vụ thường không thăm — test phải có case cho TRƯỜNG HỢP KHÔNG GỬI gì.
- **Assert tuyệt đối trên fixture dùng chung sẽ đỏ khi fixture đổi có chủ đích (P4-5)** — thêm row nháp thường
  làm SO draft 1→3; cập nhật kỳ vọng kèm giải thích trong chính test (bản chất assertion không đổi:
  nháp thường vẫn là draft của NGÀY, chỉ không phải nháp CỦA APP).

## Đợt P4-6 — Hôm nay | Hôm qua + delta tuyệt đối (2026-09-21, `result-p4-6.txt`)

- **Kill harness falsify giữa chừng ⇒ MUTATION CÒN NGUYÊN TRÊN ĐĨA (P4-6).** Harness chỉ khôi phục trong luồng
  bình thường, không bắt được `SIGINT`/`SIGTERM`. Lần sau chạy, mutation cũ khiến suite đỏ vì một lý do vô hình —
  và tệ hơn: nếu không phát hiện, **code đã bị phá sẽ được commit**. Đã thêm restore-on-signal vào `lib/harness.mjs`.
  *Luật chung: mọi công cụ sửa file tại chỗ để test đều phải khôi phục được cả khi bị ngắt giữa chừng.*
- **Case falsify trỏ SAI test file ⇒ harness báo `PROBLEM: no test ran`, KHÔNG cho RED giả.** Đây là thiết kế
  đúng đang tự tố giác: một harness im lặng cho qua mới là nguy hiểm. Khi thấy PROBLEM, nghi **cấu hình case**
  trước khi nghi code (suite/pattern/tên test) — tiết kiệm được cả một vòng debug mò.
- **Assert yếu vẫn PASS sau khi bỏ guard (P4-6)**: test "drill đọc đúng ngày" chỉ kiểm *có request xảy ra*,
  nên vẫn xanh khi `date` bị bỏ khỏi request. **Assert phải chạm ĐÚNG GIÁ TRỊ bị guard bảo vệ** (ngày cụ thể,
  không phải "có gọi"). Cách phát hiện duy nhất: chạy falsify — test xanh không chứng minh được gì.
- **Thêm field vào model ≠ đã nối vào call site (P4-6)**: `DrillIntent.date` có, serialize đúng, nhưng
  `DrillListScreen._load()` không truyền ⇒ tính năng im lặng không hoạt động. Sau khi thêm tham số, **grep mọi
  call site** và để test khẳng định giá trị đi tới tận request.
- **Probe tự viết thiếu lọc company ⇒ LẦN THỨ 3 kết luận sai về server (P4-6)**: 5.000.000.000 vs 320.000 —
  thực ra là 10 phiếu thu của công ty khác (site có 3 công ty). **Nghi mình trước khi nghi server**, và probe
  đối chiếu phải áp **đúng scope của sản phẩm** (company) — nếu không thì "ALL MATCH" vô nghĩa.
- **Cùng một loại lỗi company-scope xuất hiện 2 lần trong 1 ngày (P4-5 nháp app, P4-6 probe)**: khi sản phẩm
  đã được vá (P4-5), công cụ kiểm tra của mình vẫn còn lỗi cũ ⇒ phải vá **cả hai phía**.

## Đợt P4-7 — đóng plan4 V1: đối chiếu §7 12/12 + docs (2026-09-21, `result-p4-done.txt`)

- **Anchor của harness falsify TRÔI khi code đổi ⇒ ca đó không còn chạy, nhưng dòng tóm tắt trông y hệt ca
  đã pass (P4-7).** Hai ca bị trôi: **L** (`appDrafts` — tôi thêm `company` vào field list ở P4-5) và **F**
  (`http-ask` — tôi chuyển guard công ty vào `resolveReadCompany()` ở P4-4). Cả hai chỉ được phát hiện vì
  harness **in ra `anchor missing` và tính là PROBLEM**, chứ không im lặng `continue`.
  *Luật: sau khi refactor bất kỳ đoạn code nào có harness bám vào, chạy lại **toàn bộ** harness — và khi
  viết harness, luôn phân biệt "ca chạy mà xanh" với "ca không chạy được".*
- **"Chưa có test" là một kết luận phải đi tìm, không phải điều mặc định đúng (P4-7).** Đối chiếu §7 từng
  case: 11/12 có test, **§7.6 thiếu** — đúng loại case dễ bị coi là "đã bao phủ bởi test failure chung".
  Nhưng nó khác về bản chất: **một trang rỗng là "hôm nay không có", một lần bị từ chối là "không được xem"**
  — gộp hai thứ là bịa số 0 về tiền. Đã thêm sentinel `__FORBIDDEN__` (mô phỏng PermissionError/403) +
  test khẳng định **NULL, không phải 0** + ca falsify chứng minh test đỏ được.
- **Đếm số bằng bằng chứng của chính fixture (P4-7)**: case §7.12 đòi "dùng nguyên bộ 20 chứng từ" —
  "đúng 20" phải **đếm ra** từ file fixture, không tin trí nhớ hay comment.
- **Viết lại lệnh mình THỰC SỰ chạy, không viết lệnh mình nghĩ là đúng (P4-7).** Handoff P4-6 ghi
  `PYTHONPATH=src python3 -m pytest tests -q` — máy **không cài pytest** (`No module named pytest`); lệnh
  đúng của repo là `PYTHONPATH=src python3 -m unittest discover -s tests`. Nếu phiên sau chép nguyên handoff,
  nó sẽ báo "suite Python đỏ" oan. *Đã sửa cả hai handoff. Kiểm chứng: chạy lại đúng lệnh trước khi ghi vào docs.*

## Đợt rà harness toàn repo (sau P4-7) — 2026-09-21

- **Harness chạy TRẦN (không kế thừa env của `npm test`) ⇒ baseline đỏ ⇒ exit TRƯỚC mọi case ⇒ 0 ca được
  kiểm (c2-ocr).** `package.json` test script đặt `COPILOT_MOCK_OK=1`; c2 spawn `node --test` bằng `spawnSync`
  **không truyền biến đó** ⇒ 3 test route fail ngay baseline ⇒ harness dừng đúng quy tắc "baseline phải xanh"
  — tức là **quy tắc đã cứu**, nhưng kết cục là **toàn bộ harness im lặng vô dụng**, và trước đó `timeout 240`
  của tôi còn kill nó khi đang baseline (không sót mutation vì chưa áp, nhưng không ai biết nếu không kiểm).
  Sửa: `env: { ...process.env, COPILOT_MOCK_OK: "1" }` đúng như `npm test`.
  *Luật: mọi harness spawn test runner phải kế thừa env (hoặc set đúng) như lệnh test CHÍNH THỨC của repo —
  và sau khi sửa harness, phải nhìn thấy nó chạy **đầy đủ case** (không phải chỉ exit 0).*
- **Baseline-check của harness là GUARD, không phải thủ tục:** nó biến "harness chết vì env" thành PROBLEM
  tường minh thay vì để các ca "đỏ" trên nền đỏ sẵn. Nếu c2 chỉ nhìn `status !== 0` thì 3 fail baseline sẽ
  khiến **mọi ca đỏ giả** — 10 guard C2 "được chứng minh" trong khi không guard nào được test. *Harness phải
  luôn kiểm xanh-trước-mutate, và người đọc kết quả phải phân biệt "đỏ vì mutation" với "đỏ sẵn".*
- **Audit tĩnh cho anchor (regex/parse file harness) dễ ra 0-match không báo lỗi** — script audit đầu tiên
  của tôi khớp **0 ca** trên 10 harness mà exit 0. Phản xạ đúng: nếu audit "xanh" trong khi 2 anchor vừa trôi
  tuần trước thì **audit sai**, bỏ audit, dùng bằng chứng động (chạy đầy đủ case, mỗi ca RED đúng tên).
- **Mock sentinel phải bám CONTRACT của client thật, không phải contract của chính mock.** Với 403: pin
  3.0.4 bằng grep source (`FrappeAPIError` throw khi `!response.ok`, kèm `.status`) + bằng chứng vòng thật
  (P4-5: 417 đi đúng đường branch → ERP_UNAVAILABLE, message giữ nguyên). Thêm test thứ hai dùng **đúng
  hình thái message thật** (`[FrappeClient] … failed: … (HTTP 403)`) để regex UI không chỉ khớp wording mock.
  *Luật: khi mock mô phỏng trạng thái lỗi, phải chỉ ra (1) client thật THROW hay trả-data, (2) message thật
  trông thế nào — bằng grep node_modules, không bằng trí nhớ.*
- **`timeout <n>` bọc harness Flutter ⇒ kill giữa chừng** (c2 cần ~9 phút vì 2 lần chạy Dart baseline +
  Dart per-case). Con số "an toàn" theo trực giác của command-line là bẫy của harness đa-runtime.
  *Luật: chạy harness trong phiên agent với timeout tool đủ rộng, chạy TỪNG harness một, không chain 10 cái.*

## Đợt push lên GitHub + CI build APK (2026-09-21)

- **PAT dán qua chat = credential đã lộ ⇒ dùng xong phải revoke NGAY** (người dùng phải tự revoke;
  agent không được lưu token vào file/remote URL/git config trong repo, không echo lại). Remote URL chứa
  token cũng phải trả về trạng thái không-token ngay sau push.
- **Push cây không chung lịch sử (checkout mất .git) ⇒ dùng `merge --allow-unrelated-histories`, KHÔNG
  `push --force`.** Đếm 2 phía trước khi merge: (a) file trên remote mà local không có — bắt buộc giữ lại
  (ở đây: `.github/workflows/android-debug-apk.yml` + 11 file `.project/`); (b) file local mới. Conflict
  add/add (54 file) resolve lấy **bản đã test mới hơn** — và phải CHỨNG MINH "mới hơn" bằng nội dung
  (bản P4 có entry P4-4→P4-7 + drill code, bản remote không), không phải bằng niềm tin.
- **Deploy key có thể đọc được repo A nhưng bị deny write trên repo B** (`Permission to … denied to deploy
  key`) — `ls-remote` thành công không có nghĩa là push được. Test write bằng 1 commit nhỏ trước khi
  chuẩn bị cả cây.
- **CI trigger theo `paths:`** (`apps/mobile/**`) — push commit chỉ đụng docs sẽ KHÔNG chạy build; workflow
  này có `workflow_dispatch` để chạy tay khi cần (bẫy "push xong mà không thấy CI" đã từng ghi ở remote).

## Đợt P5-1 (2026-09-22)

- **Test hard-code một NGÀY TUYỆT ĐỐI trong khi sản phẩm TÍNH ngày đó từ `now` ⇒ bom hẹn giờ,
  không phải test.** 5 test P4-6 trong `daily_summary_test.dart` viết ngày 2026-09-21 với hằng số
  `'2026-09-20'` làm "hôm qua"; sang 2026-09-22 suite đỏ **5 test** dù không có dòng code nào đổi —
  màn production tính đúng `now − 1` (= `2026-09-21`) bằng `daily_summary_screen.dart:150-155`.
  *Luật: nếu sản phẩm suy ra một giá trị từ `now`, test phải suy ra **cùng cách** (helper dùng chung
  thuật toán), không được chép thành hằng số. Thấy mình đang gõ một ngày/năm/giờ tuyệt đối vào test
  mà code đang tính nó ⇒ dừng lại.*
- **Đỏ "nhìn như flaky" do chạy song song: tên file trong dòng `+N -M: <file>: <test>` CHỈ là test
  ĐANG CHẠY NỀN, không phải test hỏng.** Lần chạy full đầu tiên của phiên hiện `chat_controller_test`
  ⇒ tôi suýt kết luận flaky; chạy riêng `chat_controller_test.dart` = **18/18 pass**, chạy riêng
  `daily_summary_test.dart` = **đỏ đúng 5 test đó**. *Luật: bộ đếm `-M` cộng dồn và in cạnh bất kỳ
  test nào đang chạy ⇒ MUỐN BIẾT test nào hỏng thì đọc dòng có `[E]`, hoặc chạy cô lập từng file —
  đừng đọc tên file ở cột đó.*
- **Prompt của một phase ghi "Depends: <file X> kết luận Y" có thể SAI so với chính file X.** Prompt
  P5-1 mở đầu *"result-p5-0.md kết luận bug #2 CÒN TÁI HIỆN"*, còn `result-p5-0.md` ghi nguyên văn
  **"Bug #2 … ĐÃ ĐÓNG"** — và chính bộ plan đã chốt trước cho tình huống này (`plan5_final.md` §5:
  *"P5-1 (chỉ nếu P5-0 xác nhận còn bug thật)"*; §7 mục 1: *"coi bug #2 là đã đóng … chứ không sửa
  logic"*; `plan5-prompts.md`: *"CHỈ chạy nếu result-p5-0.md kết luận cần"*). *Luật: trước khi làm bất
  kỳ phase prompt nào, **mở file nó `Depends` vào và đọc dòng kết luận thật** — nếu tiền đề không
  thoả thì (1) KHÔNG tự thực thi, (2) tìm trong chính bộ plan xem tác giả đã chốt gì cho trường hợp
  này (thường có), (3) viết result file nêu tiền đề sai kèm bằng chứng, (4) hỏi user nếu việc "làm
  cho bằng được" sẽ tạo **phạm vi mới**.*
- **Đổi hành vi "đoán hộ" không bao giờ là bản vá nhỏ, kể cả khi nó chỉ thêm một timeout.**
  `_onSpeechResult` hôm nay chỉ gửi khi `isFinal == true` (`chat_screen.dart:620-624`) — tức "engine
  nghe trọn câu". Coi N giây im lặng là final nghĩa là app **đoán** câu đã xong; tiếng Việt có
  filler ("ừ", "à") nên khoảng lặng giữa câu là bình thường ⇒ nguy cơ gửi câu cụt. *Luật: đề xuất
  "thêm timeout dự phòng" phải trình bày như một **đánh đổi product** (user quyết), không phải một
  bản vá kỹ thuật trung tính.*

### Bom hẹn giờ ngày tháng — TÁI PHÁT cùng ngày, ở runtime khác (P5-2, 2026-09-22)

- **Cùng một lỗi, hai lần trong một ngày, hai runtime khác nhau** — nên đây là **pattern**, không phải
  tai nạn: `daily_summary_test.dart` (Flutter, 5 test đỏ) và `p44-read-drill.test.mjs` (Node,
  `0 !== 4`). Cả hai đều **hard-code một ngày tuyệt đối** trong khi sản phẩm **suy ngày đó từ `now`**
  (`vnToday()` cho request không kèm `date`).
  *Dấu hiệu nhận biết nhanh: **request không kèm ngày** trong khi **fixture gắn vào một hằng ngày**.*
  Gặp dấu hiệu này là mở lại test ngay, không cần đợi suite đỏ.
- **Cách sửa đúng (đã dùng cả hai lần): một đồng hồ, DERIVE chứ không hard-code.** Ở Node:
  `const D = vnToday()` + `dayOffset(n)` cho mọi ngày **tương đối** (hôm qua / quá hạn / chưa tới hạn /
  ngày mai). Và **trước khi derive, phải kiểm assert có phụ thuộc CHUỖI ngày không** — ở p44 thì không
  (overdue assert theo TÊN và theo TỔNG, không theo `due_date`), nhờ vậy mới đổi được an toàn.
- **Sau khi sửa 1 chỗ, RÀ các suite cùng loại** thay vì chờ đỏ tiếp: đã kiểm `p42` (tự derive sẵn cho
  ca ngày mặc định), `p4-ops` (gọi skill với ngày tường minh ⇒ không dính), `p43` (không có hằng ngày)
  ⇒ chỉ `p44` dính. *Luật: một khi tìm ra một quả bom ngày tháng, rà cùng lúc mọi file test có hằng
  ngày — kinh nghiệm cho thấy chúng đi theo cụm.*

### Đổi một field từ "server TÍNH" sang "snapshot" = CHUYỂN QUYỀN QUYẾT ĐỊNH cho client (P5-2, 2026-09-22)

- **Đổi nguồn của một giá trị = đổi ranh giới tin cậy, dù diff chỉ là "chuyển một biểu thức".**
  `posting_date` trước đây tính lúc execute (client không chọn được); đổi thành
  `proposal.params.posting_date` — mà `/execute` lấy `proposal` **thẳng từ request body**
  (`http-ask.mjs:846`) ⇒ client tự do đặt ngày. Probe chứng minh: `posting_date: "2026-01-02"` (lùi 5
  tháng) được **ghi không một exception**; `""` cũng ghi được vì `??` chỉ bắt `null`/`undefined`.
  *Luật: khi chuyển một giá trị từ "server tự tính" thành "đọc từ snapshot/params", hỏi ngay — giá trị
  đó có đi qua ranh giới tin cậy không? Nếu có, nó phải được kiểm lại **TRƯỚC** `setReference()` (nơi
  amount/invoice/customer đã được kiểm), và test phải chứng minh **đường TỪ CHỐI**, không chỉ đường hợp
  lệ. Một tham số không được validate, nằm trong nhóm tham số đã được validate, là dấu hiệu rõ nhất.*
- **Ranh giới tin cậy phải được CHỨNG MINH bằng probe trước/sau, không bằng lập luận.** P5-2 2026-09-22:
  probe dựng proposal thật bằng builder rồi đổi **đúng một field**, in ra thứ ERPNext thật sự nhận —
  trước: `posting_date ĐÃ GHI: "2026-01-02"`; sau: `BỊ TỪ CHỐI … PAYMENT_POSTING_DATE_INVALID`.
  *Luật: cùng một file probe chạy 2 lần (trước/sau bản sửa) là bằng chứng mạnh nhất cho một finding về
  phân quyền — mạnh hơn "đọc code thấy thiếu check".*
- **Nhóm nguyên nhân ngày tháng/thời gian và nhóm ranh giới tin cậy gặp nhau ở đây:** giá trị client
  gửi lên mà là một NGÀY thì vừa phải validate dạng, vừa phải giới hạn cửa sổ — dạng đúng vẫn có thể là
  ngày sai (lùi cả quý) đưa tiền vào kỳ kế toán khác.

## Đợt P5-3 — badge NHÁP/ĐÃ NỘP + copy setting (2026-09-22, `result-p5-3.md`)

### `pumpWidget` cùng hình dạng cây ⇒ Flutter TÁI DÙNG State — lỗi đỏ TRÔNG NHƯ finder sai (P5-3, 2026-09-22)

- **Triệu chứng đánh lừa:** test vòng lặp 4 case trong **một** `testWidgets`, mỗi case gọi
  `pumpWidget(...)` rồi `tap('Xác nhận thu tiền')` ⇒ case đầu xanh, các case sau đỏ với
  *"Found 0 widgets with text 'Xác nhận thu tiền'"*. Phản xạ tự nhiên là đi sửa **finder/label** — sai hướng.
- **Nguyên nhân gốc:** `pumpWidget` dựng **cùng hình dạng cây** (`ProviderScope > MaterialApp > Scaffold >
  ProposalCard`, không key) ⇒ Flutter **tái dùng Element/State cũ** thay vì tạo mới. State đã có kết quả
  từ case trước ⇒ nút xác nhận (chỉ tồn tại khi CHƯA thực thi) không còn. **Không phải** State bị
  reset-hay-không: nó CỐ Ý được giữ.
- **Sửa:** `KeyedSubtree(key: UniqueKey(), child: …)` quanh host trong helper dùng-chung ⇒ mỗi case một State
  mới. Ghi comment ngay tại chỗ rằng **key này là load-bearing** — nếu không, phiên sau sẽ "dọn" nó như
  một dòng thừa.
- *Luật: đỏ kiểu "có X trước, mất X sau khi chạy lại cùng kịch bản" ⇒ nghi State reuse trước khi nghi
  finder. Cách kiểm rẻ nhất: thêm `UniqueKey()` — nếu xanh ngay thì đúng là reuse. Nhiều case trong một
  `testWidgets` là mùi rõ nhất; cách sạch hơn là mỗi case một `testWidgets` (tự có State mới).*

### Helper viết ngay trước `}` cuối file có thể lọt vào `main()` (P5-3, 2026-09-22)

- Tôi chèn 3 helper trước dấu `}` cuối cùng, tưởng là top-level — nhưng `}` đó đóng **`main()`** ⇒ helper
  thành **local identifier** ⇒ `_`-prefix trên local trip
  `no_leading_underscores_for_local_identifiers`, và analyzer báo đúng chỗ: *"The local variable\_…"*.
- *Luật: trước khi chèn helper vào một file Dart, xác định `}` mình đang chèn trước nó đóng cái gì
  (`grep -n "^void main" file` rồi so với vị trí chèn). Trong file test Dart, helper **phải ở top-level**
  (trước `main`), test case mới ở trong `main`.*

### Chèn code vào Dart: oldString nuốt COMMENT QUYẾT ĐỊNH và dấu `}` đóng class (P5-4, 2026-09-22)

- **Chèn khối mới cạnh một đoạn có comment dài ⇒ oldString phải DỪNG TRƯỚC comment, không ôm comment vào.** Tôi chèn state mới vào `_InputBar` bằng oldString ôm luôn 15 dòng comment quyết định P6 ("NO locale notice…") và không trả lại ⇒ block `setState` vỡ, mất bằng chứng quyết định cũ. `flutter analyze` bắt ngay — nhưng phải khôi phục NGUYÊN VĂN comment, không viết lại theo trí nhớ.
- **Một `str_replace` xoá `}` cuối một method/class khi tôi tưởng nó là ranh giới cấm.** Đợt dọn khối test-hook trong `voice_input_test.dart`: xóa nhầm `}` đóng class `_FakeSpeech` ⇒ `class _Recorder` thành class-in-class, cả file sập. Trước đó còn tạo `void main() {` THỨ HAI (chèn cụm kèm main vào file đã có main) rồi lần sửa sau xoá nhầm main gốc ⇒ 3 trạng thái lỗi liên tiếp chỉ từ các lần "dọn" chuỗi.
- *Luật: trước mỗi str_replace trong file Dart: (1) xác định oldString nằm ở **cấu trúc nào** (method? class? main?) — `grep -n` vị trí trước; (2) oldString **không bao giờ** ôm comment quyết định dài — dừng ở dòng lệnh cuối; (3) sau mỗi lần sửa: `flutter analyze` NGAY (không dồn), và với file test: `grep -c 'void main() {'` phải = 1 + đọc EOF có `}` đóng; (4) sửa lỗi cấu trúc bằng cách đọc lại vùng lỗi, KHÔNG sửa chuỗi mù liên tiếp.*

### Trước khi push: soi DANH SÁCH thư mục sẽ push, grep pattern là KHÔNG đủ (push 2026-09-22)

- Lần push 2026-09-22 suýt đẩy lên GitHub: `.chats/sess1.md` (chứa **token GitHub thật**), `.review/chat1..7.md` + `.review/dsh_test.md` (8 transcript chat thô), `.gemini/**` (192K config CLI + skills), `initp` (script tạo .gitignore — AGENTS ghi rõ cấm commit). `.gitignore` dự án chặn `.agent/.agents/.plan/.draft/.edits/.tests/node_modules/build/...` nhưng **KHÔNG** chặn 4 thứ trên. Phát hiện nhờ 2 lệnh: `git grep -l <giá trị token thật>` (bắt `.chats`) và `git ls-files | awk -F/ 'NF>1{print $1}' | sort -u` (nhìn ra `.review`/`.gemini`).
- Nếu lọt: 8 transcript chat + token + config CLI nằm **vĩnh viễn trong history** (xoá file ở commit sau vẫn còn trong commit trước).
- *Luật: trước MỌI push cây lạ — (1) liệt kê top-level dir sẽ push, đối chiếu danh sách cấm trong AGENTS.md; (2) `git grep -l <giá trị secret đã biết>`, không chỉ pattern hẹp; (3) thấy thư mục lạ ⇒ thêm `.gitignore` + `git rm -r --cached --ignore-unmatch`, commit LẠI; nếu đã merge xong thì phải làm lại clone/merge — **đừng amend lên commit đã nhiễm**, tree của commit nhiễm vẫn nằm trong history.*

### Push lần 2: 3 cái bẫy git tốn 3 vòng thử (2026-09-22)

- **`git rm -r --cached a b c` ABORT TOÀN BỘ nếu MỘT pathspec không khớp** (`fatal: pathspec '.opencode' did not match any files`) — nuốt stderr (`2>/dev/null`) thì nó **im lặng thất bại** và file bạn tưởng đã bỏ vẫn nằm trong commit. Dùng `for p in ...; do git rm -r --cached -q --ignore-unmatch "$p"; done` rồi **kiểm lại bằng `git ls-files | grep -c`**.
- **`git merge ... FETCH_HEAD` trả "Already up to date." SAI** cho một commit hoàn toàn không liên quan (git 2.43, sau `git fetch` từ remote là đường dẫn local): `git rev-parse FETCH_HEAD` đúng là commit mới, `merge-base --is-ancestor` xác nhận KHÔNG phải tổ tiên — mà merge vẫn không làm gì. Dùng **tên ref** (`localp5/master`) thì chạy đúng ngay.
- **`.gitignore` không có tác dụng với file đã tracked**: `git check-ignore` cũng không báo chúng. Phải `git rm --cached` trước, rồi mới thấy pattern phát huy.
- *Luật: mỗi bước "dọn" trước push phải kèm một lệnh ĐẾM kiểm chứng (`grep -c` = 0, số file đổi đúng dự kiến) — không tin exit code của lệnh đã bị che output.*

### "Như thể user tap-để-dừng" nghĩa là MÔ PHỎNG ĐẦY ĐỦ hậu quả — kể cả việc KHÔNG auto-send (P5-4, 2026-09-22)

- Spec ghi cap 25s "tự động dừng như thể user tap-để-dừng". Tôi viết test kỳ vọng `/ask` (auto-send ON) và **bị đỏ** — soi lại: tap-to-stop thật có guard teardown **drop** kết quả sau `stop()` (self-review 2026-09-18), nên auto-send **không bao giờ** bắn theo tap-to-stop. Timer mô phỏng tap-to-stop ⇒ không được tự gửi.
- Quyết định đúng: sửa **expectation của test** (không thêm auto-send vào timer) — vì timer tự gửi = gửi những từ user CHƯA KỊP ĐỌC, sai tinh thần auto-send; chữ được giữ trong field cho manual Gửi (vẫn là bảo vệ cho ca engine không bao giờ final — P5-0a).
- *Luật: khi spec nói "như thể X", mô phỏng **cả hệ quả phụ** của X — đọc code của X trước để liệt kê đủ (guard drop, state dọn,…) chứ không chỉ hành động chính. Test đỏ do expectation của MÌNH sai ≠ code sai: soi cơ chế thật trước, sửa expectation khi mechanism chứng minh rõ, và ghi lại sự lựa chọn diễn giải vào result file để user đối chiếu.*

### Assert màu phải đọc CHÍNH widget, không chỉ "có tồn tại" (P5-3, 2026-09-22)

- Test badge không dừng ở `findsOneWidget`: nó đọc
  `((container.decoration! as BoxDecoration).color)!` từ container mang key, rồi so với
  `Theme.of(...).colorScheme.primaryContainer` / `.tertiaryContainer` — nên badge **đúng chữ nhưng sai tone**
  vẫn đỏ.
- *Luật: một assert "có badge là được" chỉ chứng minh widget được dựng; nếu yêu cầu là "màu X cho trạng thái
  Y", hãy assert giá trị thật (đọc `BoxDecoration`/`TextStyle` ra) so với token theme, không hardcode hex.*

### Review P5-3 (cùng phiên) — 1 giả thuyết SAI tự bắt trước khi báo, 1 finding THẬT, 1 kỹ thuật mới

- **LỖI CỦA TÔI (đã tự bắt): grep CHUỖI ĐẦY ĐỦ để kiểm coverage ⇒ FALSE NEGATIVE ⇒ tuyên bố "test thiếu"
  trước khi verify.** Tôi kết luận *"test chỉ ghim tiêu đề, không ghim mô tả OFF/ON"* vì
  `grep "chỉ TẠO phiếu NHÁP"` ra rỗng — nhưng test thật ghim bằng **tiền tố ngắn**
  `find.textContaining('TẮT: xác nhận')` (`settings_test.dart:376`) và
  `('ĐANG BẬT: xác nhận')` (`:417`). Suýt nữa thì vừa báo finding sai cho user, vừa **thêm test trùng**.
  *Luật: audit coverage bằng grep phải dùng **đoạn ngắn đặc trưng** (hoặc `textContaining` pattern), KHÔNG
  dùng cả câu — và không được **tuyên bố finding trong lúc kể diễn biến** trước khi bước verify xong.
  Grep rỗng là "chưa tìm thấy cách họ assert", không phải "họ không assert".*
- **FINDING THẬT (chưa sửa, chờ user — vùng UI chạm tiền): badge vàng NHÁP ra đời trên cùng dòng với
  glyph `✅` có sẵn.** Dòng kết quả render `'✅ $_result'` **vô điều kiện**, nên ca submit bị từ chối đọc thành
  *"✅ Đã tạo phiếu NHÁP … NHƯỚNG submit lỗi …"* + badge vàng NHÁP ⇒ **hai tín hiệu ngược nhau trên một dòng**.
  Không có test nào assert `'✅'` (grep = rỗng) nên sửa được mà không phá suite.
  *Luật: khi THÊM một tín hiệu trạng thái (badge/màu/icon) vào một dòng đã có tín hiệu cũ, phải rà **toàn bộ
  tín hiệu đang có trên chính dòng đó** — thêm màu mới bên cạnh dấu "thành công" cũ = tự mâu thuẫn, và mâu
  thuẫn về TIỀN phải để user quyết, không tự sửa dù thấy "rõ ràng đúng".*
- **ĐÃ SỬA (user chốt "đổi theo trạng thái"): glyph và badge phải múc từ CÙNG MỘT nguồn trạng thái.**
  `'${_submitOk == false ? '⚠️' : '✅'} $_result'` — `false` ⇒ ⚠️, `true`/`null` ⇒ ✅ (không gì bị từ chối thì
  không có lý do cảnh báo). *Luật: khi một dòng đã có badge trạng thái, mọi tín hiệu phụ trên dòng đó
  (glyph, màu chữ) phải đọc từ **cùng một biến** — hai nguồn trạng thái độc lập trên một dòng là mầm
  mâu thuẫn, và mâu thuẫn này chỉ lớn lên khi thêm trạng thái mới.*
- **`findsNothing` trên một GLYPH DÙNG CHUNG bị tính năng khác làm nhiễu ⇒ assert giòn/sai.** Test báo giá
  **không** assert `⚠️ findsNothing`: card dòng-hàng với `params.lines` rỗng có ⚠️ **riêng** (*"Đơn không có
  dòng hàng nào"*), không liên quan trạng thái submit — nếu cứ assert cho "chắc" thì hoặc test đỏ oan,
  hoặc phiên sau sẽ "sửa" cái ⚠️ đúng kia cho vừa test. *Luật: muốn khẳng định "KHÔNG có tín hiệu X", hãy
  khoanh vùng bằng **key/scope** (hoặc assert trên chuỗi đủ đặc trưng của tính năng mình) — đừng khẳng định
  trên một ký tự Unicode mà cả app đang dùng chung.*
- **KỸ THUẬT: UI guard chưa có harness falsify ⇒ chứng minh bằng ĐỘT BIẾN TAY + restore `sha256sum -c`.**
  `scripts/falsify/` chỉ phủ OCR/execute-id/issue1/p4x/p52 — không có harness cho card. Tôi chạy 2 đột biến
  trực tiếp trên `proposal_card.dart`: (M1) `_submitOk == true` → `!= false` ⇒ **test "absent submit_ok" RED**
  (chứng minh tone được ghim); (M2) phá chữ của map `permission` ⇒ **test advice RED** (chứng minh map được
  ghim); restore và `sha256sum -c` = **OK (byte-identical)**.
  *Luật: "test xanh" ≠ "guard sống". Với UI không có harness, ít nhất 1 đột biến cho mỗi điều kiện được nói
  là "đã ghim", kèm bằng chứng restore byte-identical — và nếu đột biến KHÔNG làm đỏ thì guard đó là
  decoration, phải nói thẳng thay vì tính là đã kiểm.*

## Đợt P9-A1 — `delivery.create` proposal (2026-09-22, `result-p9-A1.md`)

- **Cờ `status: "stub"` là CƠ CHẾ HÀNH VI, không phải nhãn sách vở.** Đo được: `copilot-server.mjs:528` chặn stub
  **TRƯỚC** `route.factory` (`:571`) và trước mọi nhánh WRITE; pipeline **không có** nhánh `delivery_write`
  (`:928-932`) và `SKILL_FACTORIES` không có factory cho group đó. Vì vậy "thêm skill cho capability" mà bỏ cờ
  stub ở A1 sẽ khiến *"giao hàng cho Nguyễn Thị Lan"* resolve khách xong **rơi xuống nhánh cuối `customer`** ⇒
  trả **số nợ** cho một **mệnh lệnh giao hàng** — regression tệ hơn "chưa làm". *Luật: trước khi sửa contract của
  một capability, đọc NHÁNH DISPATCH thật của pipeline cho group của nó, và grep mọi test nhắc id đó; bỏ cờ stub
  phải đi kèm wiring (P9-A2), ghi lý do tại contract để phiên sau không "tiện tay" bỏ.*
- **Invariant tĩnh quét raw text ⇒ COMMENT tự viết cũng là "vi phạm".** `safety-gateway.test.mjs:171` đếm file
  chứa `/execute[A-Za-z]*Proposal\s*\(/`; docstring của tôi viết *"there is no executeDeliveryProposal()"* để
  giải thích rằng file **không** có executor ⇒ bị liệt vào write path và test đỏ. *Luật: sửa bằng cách **không
  viết ra đúng chuỗi đang bị cấm** (kể cả trong câu phủ định), tuyệt đối không whitelist file vào danh sách cho
  phép; và chạy invariant liên quan ngay sau khi tạo file mới trong `src/`.*
- **Thêm `skill` cho một stub chạm 2 tripwire có chủ ý** — `capability-contract.test.mjs:200` (`stub.skill === null`)
  và INVARIANT derive write-skills từ contract. Sửa tripwire bằng **ngữ nghĩa** (`filter(!isStub(id))`, kèm lý do:
  builder của stub KHÔNG ở trên đường ghi, và giữ nó NGOÀI allowlist là điều kiện mạnh hơn) — không thêm entry
  "cho test xanh". *Test cũ phải sửa là chuyện bình thường khi hợp đồng đổi; cái phải tránh là sửa nó thành vô nghĩa.*
- **FINDING THẬT (mức CAO) do chính P9-A1 tạo ra — đã sửa:** cùng một mặt hàng được nêu **hai lần** trong danh
  sách số lượng ("2 bao và 3 bao cám heo") ⇒ 2 dòng cùng `item_code`, mỗi dòng đều ≤ phần còn chờ giao ⇒
  **double-deliver**. Đường đơn hàng (SO) coi "2 bao và 3 bao" là **CÂU HỎI**, nhưng builder DN không có gì chặn.
  Nay chặn bằng `DN_QTY_AMBIGUOUS` (không cộng, không merge) + khai `errors[]` + test + đột biến M3 ⇒ RED.
  *Luật: khi một builder nhận danh sách dòng từ câu nói, luôn hỏi "cùng một mặt hàng xuất hiện 2 lần thì sao?" —
  cộng lại là quyết định của MÁY, phải từ chối và hỏi lại.*
- **Test truyền giá trị vào SAI VỊ TRÍ tham số ⇒ code ĐÚNG bị buộc tội.** `buildDeliveryProposal(skills, resolved, opts)`
  — tôi đặt `lines` vào `resolved` (tham số 2) thay vì `opts` (tham số 3) ⇒ 3 test đỏ với *"Missing expected
  rejection"* trông y như lỗi guard. *Luật: test đỏ ở nhánh "phải TỪ CHỐI" ⇒ in/kiểm input thật đã tới hàm trước
  khi sửa logic; guard "không bao giờ reject" thường là guard **không được gọi**.*
- **VERIFY-FIRST ăn tiền (đáng ghi vì tiết kiệm 1 vòng sửa lớn):** `delivered_qty` là field tôi dùng nhưng fixture
  test của tôi **cấp sẵn** nó ⇒ test không thể phát hiện tên field sai. Tra skill đã verify của project:
  `erpnext-rest-api-recipes:974` dùng đúng `delivered_qty` trên output mapper thật ⇒ **field thật**; và
  `erpnext-rest-api-core:205` xác nhận **DN dùng `against_sales_order`** (chỉ SI mới dùng `sales_order`+`so_detail`)
  ⇒ payload đúng. Phát hiện thêm cho phiên sau: `recipes:976-980` nói đường ĐÃ CHẠY THẬT là gọi mapper
  `make_delivery_note` ("không cần tự cộng trừ") ⇒ A2 nên dùng mapper ở execute thay vì tự dựng items.
  *Luật: field/contract lấy từ tài liệu ngoài mà **test fixture của mình tự cấp giá trị** thì test không chứng minh
  gì — phải có một nguồn đã-verify khác (skill/docs của chính project) hoặc đánh dấu "chưa verify".

## Đợt P9-A2 — wire route + `/ask` + `/execute` NHÁP cho `delivery.create` (2026-09-22, `result-p9-A2.md`)

- **MỘT ĐOẠN CODE GIỐNG NHAU Ở 2 CHỖ ⇒ đột biến "không bắt được gì" và tôi suýt kết luận oan là "guard không sống".**
  Ca M2 nhắm "bỏ kiểm drift `qty > pending` trong EXECUTOR", nhưng chuỗi `if (qty - line.pending > EPS) {` xuất hiện
  **2 lần** trong cùng file (builder ở bước 5 + executor ở bước 2) và tôi `replace(..., 1)` ⇒ sửa **chỗ đầu (builder)**,
  chỗ executor còn nguyên ⇒ 2 test vẫn xanh và tôi gần như báo "guard vô dụng". Phải neo bằng **đoạn văn nhiều dòng
  đặc trưng** (`drift.push(\`… chỉ còn … chờ giao …\`)` + `continue;`) và **assert `s.count(old) == 1`** trước khi sửa.
  *Luật: khi đột biến/falsify, không neo bằng 1 dòng code có thể trùng; đếm occurrence và assert đúng 1, hoặc neo bằng
  khối nhiều dòng + thông điệp đặc trưng; nếu mutation "không làm test đỏ" thì NGHI ANCHOR TRƯỚC, đừng kết luận về guard.*
- **Đo TRƯỚC khi thêm route = tìm được misroute thật."giao 5 bao cám gà thịt 10kg cho Lan" (dạng mệnh lệnh tự nhiên
  nhất, không khớp keyword nào) rơi vào `inventory/stock.balance` ⇒ MỆNH LỆNH bị trả lời bằng một con SỐ TỒN KHO —
  đúng lớp lỗi B4 đã đóng cho "nhập kho". Đã đóng bằng keyword `"giao "` (kèm `notIf: "dịch"` để "giao dịch …"
  giữ nguyên hành vi cũ). *Luật: mỗi khi wire một route mới, chạy `routeIntent()` trên các DẠNG CÂU người thật sẽ nói
  (không chỉ câu mẫu trong spec) và ghi lại câu nào rơi vào đâu; một mệnh lệnh rơi vào nhánh ĐỌC là bug, không phải
  "hạn chế nhỏ".*
- **Tripwire "danh sách write" ở 4 file khác nhau (B2/B3/B4/correlation-migration) đều đỏ khi thêm WRITE #5.**
  Đây là thiết kế CÓ CHỦ Ý (mỗi file tự viết tường minh danh sách để "tập write không thể lớn lên trong im lặng").
  Sửa bằng **ngữ nghĩa**: thêm `create_delivery_note` vào danh sách · `Delivery Note` vào scope migration · và ca
  "stub không được bịa doctype" **chuyển sang stub còn lại** (`purchase_receipt.create`) kèm assert `write_doctype` vẫn null.
  *Luật: thêm 1 capability WRITE ⇒ grep `executableWriteActions`/`write_doctype` trong `test/` TRƯỚC khi chạy suite, và
  sửa từng tripwire bằng nội dung thật của hợp đồng mới — không xoá assertion.*
- **Test cross-write cũ ghim trạng thái CỦA PHASE TRƯỚC** (`b2: "giao hàng … is refused as unimplemented"`).
  Khi capability được wire, giữ nguyên **bất biến** mà test đó thật sự sở hữu ("never becomes a Sales Order"),
  chứ không xoá test: nay khẳng định `proposal === null` + `routed.group === delivery_write` + **refusal có lý do**.
  *Luật: phân biệt "test ghim HÀNH VI PHỤ thuộc phase" với "test ghim BẤT BIẾN"; phase sau chỉ được viết lại phần hành vi phụ.*
- **Chaos retry là phép kiểm DUY NHẤT chứng minh "không giao hai lần".** `MOCK_ERP_FAIL_AFTER_WRITE` (mock ghi xong rồi
  throw) tái hiện đúng ca mất phản hồi; lần 1 phải **503 + `retry_same_command_id: true`** và command giữ **PENDING**
  (không FAILED — FAILED sẽ đẩy user sang command_id mới = ghi phiếu thứ hai), lần 2 phải **200 `reconciled: true`**
  với **đúng 1** document trong state. *Luật: mọi write path mới phải chạy ca chaos bằng knob của mock TRƯỚC khi báo xong;
  "trùng command_id" chỉ chứng minh replay, không chứng minh reconcile.**
- **Script đột biến PHẢI tự khôi phục (backup trước + kiểm sha sau), nếu không file ở lại trong trạng thái đã bị sửa.**
  P9-B 2026-09-22: tôi chạy 4 đột biến liên tiếp trên `delivery-write.mjs` bằng 1 script **không có bước restore** ⇒ file còn **4 thay đổi chồng nhau**
  (M4∘M3∘M2 cùng lúc) và không còn biết đâu là bản gốc. Phải đảo ngược từng replace bằng tay rồi `sha256sum -c` mới về byte-identical.
  *Luật: trước mọi đột biến/falsify — `cp` file sang `/tmp` làm bản chuẩn và ghi `sha256sum > /tmp/<tên>.sha`; script phải restore trong CẢ đường thường LẪN đường lỗi
  (trap/`set -e`), và bước cuối luôn là `sha256sum -c`. Không bao giờ đột biến trên file duy nhất không có bản sao.*
- **Guard CÓ CODE nhưng KHÔNG có test = decoration; mirror một file sang file anh em (DN → PR) chính là lúc nó rơi mất.**
  P9-B 2026-09-22: đột biến M3 (vô hiệu guard khấu trừ phần đã-có-nháp trong **executor** của PR) làm suite **fail 0** ⇒ hoá ra bản `delivery-write.mjs` có test cho guard này,
  bản `purchase-receipt-write.mjs` mirror **thiếu test** dù code đã copy. Nếu chỉ tin "test xanh" thì đã báo xong với một guard không được chứng minh.
  *Luật: sau khi mirror/port một file skill sang doctype anh em, chạy **bộ đột biến của file gốc** trên file mới — mỗi ca phải RED. Ca nào không đỏ = test chưa được mirror
  (hoặc anchor trôi), bổ sung test TRƯỚC khi báo xong. Đừng giả định "code copy rồi thì test cũng phủ".*
- **Chuỗi quyết định DẪN XUẤT (partyKind, nhánh dispatch, write gate) không tự biết về nhóm route mới.**
  P9-B 2026-09-22: thêm nhóm `purchase_receipt_write` nhưng `partyKind` chỉ nhận `payment_write`/`sales_*`; hệ quả: đối tượng nhà cung cấp không được resolve ⇒ E2E đỏ.
  Tương tự A1/A2: bỏ cờ `stub` mà chưa có nhánh `isDeliveryWrite` ⇒ rơi xuống nhánh cuối `customer` (trả SỐ NỢ cho mệnh lệnh giao hàng).
  *Luật: khi thêm 1 nhóm route WRITE, grep **mọi** chỗ rẽ nhánh theo tên nhóm (`partyKind`, `SKILL_FACTORIES`, `WRITE_EXECUTORS`, hardcode `payment_write`)
  và chạy **1 câu E2E thật** cho nhóm mới — test unit của builder không chạm các chuỗi này.*
- **Biến một HẰNG thành BIẾN ⇒ mọi chỗ ĐỌC LẠI/verify giá trị đó phải được rà lại, nếu không nó "verify sạch" cho giá trị SAI.**
  P9-C 2026-09-23: `payment.create` từ nay ghi được cả hai hướng tiền, nhưng `verifyWrittenPayment()` (đọc lại phiếu sau khi ghi) chỉ so `party` với id mình gửi —
  mà id là **cùng một chuỗi** ở cả hai phía ⇒ một phiếu **Receive** cho lệnh **chi** vẫn pass verification miễn số tiền khớp. Trước P9-C điều này vô hại (chỉ có một hướng);
  khi hướng thành biến số thì đây là lỗ thật. Đã thêm so `payment_type` + `party_type` theo `DIRECTION_SPEC` (tham số tuỳ chọn để không phá caller cũ) + test "cùng tài liệu, hỏi hướng ngược ⇒ FAIL".
  *Luật: khi thay một giá trị cố định bằng giá trị suy ra/động (hướng tiền, doctype, đơn vị, account), grep **mọi** chỗ đọc lại/verify/so sánh giá trị đó và tự hỏi "nếu nó SAI thì chỗ này có bắt được không".*
- **Ca falsify báo "NOT RED" có HAI nguyên nhân — kiểm chỗ guard thật sự được khẳng định TRƯỚC khi kết luận "guard chết".**
  P9-C 2026-09-23: ca "hướng chi không còn allocate Purchase Invoice" (`anchor_doctype`) chạy ra `fail=0`; tôi suýt ghi "guard trang trí". Kiểm lại: `anchor_doctype` **có** được khẳng định,
  nhưng ở tầng **E2E `/execute`** (`references[0].reference_doctype` trên phiếu đọc lại), không phải trong test builder mà `only` của tôi trỏ vào. Sai ở **người viết ca**, không ở code.
  *Luật: `NOT RED` ⇒ bước 1 là grep xem assertion nằm ở test nào (`grep -n "<field>" test/*.mjs`), bước 2 mới kết luận về guard; và khi phát hiện mình trỏ sai thì ghi lý do **ngay trong harness** để lần sau không "sửa lại" ngược.*
- **Thông báo lỗi trên đường TIỀN phải gọi đúng phía người đọc đang ở; mã lỗi thì giữ nguyên.**
  P9-C 2026-09-23: executor của hướng chi vẫn báo "chứng từ … không phải khoản **phải thu** dương" và "số tiền **thu** không hợp lệ" — người vận hành đọc sẽ đi tìm sai sổ (phải trả vs phải thu).
  Đã sửa theo hướng, **chỉ đổi chữ**: mã `PAYMENT_INVOICE_NOT_RECEIVABLE` giữ tên cũ vì nó đã được map trong bảng uncertainty của P2 và bị test cũ khẳng định (comment ghi rõ).
  *Luật: khi một nhánh phục vụ ≥2 nghiệp vụ (thu/chi, mua/bán), rà lại TẤT CẢ thông báo trong nhánh đó — nhưng đổi **chữ hiển thị**, không đổi **mã** đã có người dùng khác (client/test/mapping).*
- **Lỗi "giá trị vào SAI VỊ TRÍ tham số" đã tái phạm lần 2 (A1 rồi B) ⇒ luật phải mạnh hơn "cẩn thận hơn".**
  P9-B 2026-09-22: lại đặt `lines` vào túi `resolved` (tham số 2) thay vì `opts` (tham số 3) của `buildPurchaseReceiptProposal(skills, resolved, opts)` ⇒ 1 ca đỏ với
  thông điệp *"Missing expected rejection"*, trông y như guard của builder sai.
  *Luật: trước khi viết test cho hàm ≥2 túi tham số — **đọc chữ ký hàm** và gọi hàm 1 lần với input tối thiểu rồi `console.log` giá trị tới được; test đỏ ở nhánh "phải TỪ CHỐI"
  gần như luôn là "guard KHÔNG ĐƯỢC GỌI", không phải guard sai.*
- **Hai nhánh CÙNG MỘT KHÓA trong dispatch của mock ⇒ nhánh viết SAU là code chết, và test đỏ sẽ buộc tội nhầm lớp skill.**
  P9-D 2026-09-23: `erpnext_doc_get` có HAI nhánh `doctype === "Sales Invoice"`; nhánh cũ (đọc fixture `INVOICES`) **throw** khi không thấy tên ⇒ nhánh mới (đọc lại hoá đơn NHÁP vừa ghi, phục vụ verify + draft-cover)
  không bao giờ chạy. Triệu chứng: `TOOL_ERROR: Sales Invoice SI-M001 not found — chưa xác minh được kết quả ghi` ⇒ trông y hệt **bug của skill/executor** (thực ra verify làm đúng việc của nó).
  *Luật: khi thêm nhánh cho một khóa ĐÃ CÓ nhánh trong mock/dispatcher, grep khóa đó trong file TRƯỚC (`grep -c 'args?.doctype === "Sales Invoice"'`), và kiểm nhánh cũ có `throw`/`return` sớm không. Symptom "not found / không đọc lại được" ở bước VERIFY ⇒ nghi fixture trước, đừng sửa guard.*
- **`NOT RED` với anchor SỐNG là nguyên nhân thứ ba: guard CÓ CODE nhưng KHÔNG có test nào khẳng định nó.**
  P9-D 2026-09-23: ca J (vô hiệu "executor trừ phần đã nằm trong hoá đơn NHÁP") ra `fail=0` — anchor đúng, `only` đúng, test tồn tại và xanh; kiểm ra **chưa có test nào phủ nhánh đó** (bản `delivery-write.mjs` có, bản hoá đơn mirror thiếu).
  *Luật: `NOT RED` ⇒ (1) anchor có sống không, (2) `only` có trỏ đúng test không, (3) **test đó có thật sự đi qua nhánh bị đột biến không** (`grep` tên field/mã lỗi trong test). Bước 3 là bước hay bị bỏ: khi ra "guard không được test", viết test TRƯỚC rồi chạy lại đột biến — không kết luận "guard chết".*
- **Một test bật HAI knob drift cùng lúc ⇒ nhánh đầu short-circuit nhánh sau, và kỳ vọng "thấy cả hai" là sai.**
  P9-D 2026-09-23: bật `MOCK_ERP_SI_DROP_LINE` + `MOCK_ERP_SI_DRIFT_RATE` rồi assert thông báo nêu **cả** số dòng lẫn đơn giá; thực tế `if (gotLines.length !== lines.length) … else { so giá }` — lệch dòng thì **không** so giá (đúng thiết kế: so giá theo item cần cùng tập dòng).
  *Luật: mỗi test một discrepancy. Khi một hàm kiểm nhiều điều kiện có `else`/`continue`, mỗi nhánh cần test riêng — và đừng "sửa" code thành báo cả hai lỗi chỉ để test cũ xanh (báo đủ lỗi trong một thông báo là thiết kế khác, có chủ ý mới làm).*
- **Khi có nhiều mã lỗi "gần nghĩa", kỳ vọng của test phải đọc TAXONOMY trước khi cáo buộc production code.**
  P9-D 2026-09-23: 4/6 test đỏ đầu tiên là **kỳ vọng sai của tôi**, không phải code sai: `PROPOSAL_STALE` (generic) vs `PROPOSAL_VERSION_STALE` (đã tách ở P1, generic chỉ còn là `legacy_code`);
  `SI_ALREADY_BILLED` (mã theo **từng đơn**, chỉ có khi đơn đã resolve) vs `SI_NOTHING_TO_BILL` (đường duyệt nhiều đơn, câu không nêu đơn nào); và "proposal ≠ null" cho câu HỎI — card ĐỌC của A1 (`read_open_invoices`, `risk READ`) **là** một proposal hợp lệ, chỉ không phải card GHI.
  *Luật: đỏ ở nhánh "mã lỗi/kỳ vọng": grep mã đó trong `src/` xem nó được ném ở ĐÂU và ngữ cảnh nào, rồi mới sửa —
  phân biệt mã **tinh chỉnh vs legacy**, mã **theo-entity vs theo-lô**, và với câu HỎI thì assert **loại card** (`action` không phải write, `risk` phải READ) chứ đừng assert `null`.*
- **Một key chung cho renderer dùng chung phải giữ NGUYÊN TÊN giữa các document anh em.**
  P9-D 2026-09-23: card Flutter có một renderer dòng hàng + dòng "Tạm tính" cho 6 loại chứng từ, đọc `params.estimated_total_vnd`; proposal hoá đơn ban đầu đặt tên riêng `net_total_vnd` ⇒ nếu chỉ thêm `create_sales_invoice` vào danh sách render thì dòng tổng in `?đ` (đúng lớp lỗi "card bịa/giấu số" mà comment của chính widget cảnh báo).
  *Luật: TRƯỚC khi đặt tên field cho proposal mới, grep widget/renderer phía client xem nó đọc key nào cho các action anh em; giữ tên đó cho phần **đề xuất**, và để tên ERPNext (`net_total_vnd`, `grand_total`) cho số **của document đã ghi** trong result — hai con số khác nghĩa thì hai tên khác nhau.*

## Đợt next3/M1 — `customer.create` backend + review "đã xong chưa" (2026-09-23, `result64.txt`)

- **"App vừa code xong" từ phiên trước KHÔNG phải bằng chứng — phiên bị đứt kết nối liên tục thì lần sau PHẢI đo lại dấu vết trên cây trước khi tiếp tục.**
  M1: user nói "app vừa code xong M1" nhưng đo bằng `ls`/`grep` thật: backend (contract + skill + wire + mock) có thật,
  còn **Flutter 0 hit, test suite riêng 0, falsify 0, result 0**. Nếu tiếp tục code theo nhớ đã viết chồng/forgets state thật.
  *Luật: sau phiên đứt kết nối — bắt đầu bằng **khoan điều tra** (`grep`/`ls` từng deliverable của spec, bảng ✅/❌), rồi mới quyết
  "làm tiếp từ đâu". Bảng đo được đó chính là phần mở đầu của result.*
- **WRITE mới làm `writeDoctypes()` (allow-list theo doctype ở `client.mjs`) RỘNG THÊM ⇒ test cũ ghim "doctype này không bao giờ được ghi" phải được giải quyết CÓ CHỦ ĐÍCH, không phải chỉ thêm tên vào danh sách tripwire.**
  M1: Customer vào allow-list ⇒ 7 test đỏ ở B2/B3/B4/p9-delivery/p9-f (deepEqual set + "client refuses undeclared doctype" +
  test cũ khẳng định "Customer must never become creatable"). Câu hỏi thật đằng sau: allow-list theo doctype là **bề mặt ghi
  ngoài gateway** — cần quyết thiết kế (client chặn theo capability? hay chấp nhận + ghi rationale) TRƯỚC khi "sửa test cho xanh".
  *Luật: khi thêm capability có `write_doctype` mới, chạy suite trước để nhìn TẤT CẢ tripwire đỏ, phân loại từng cái:
  (a) tripwire danh sách → sửa bằng ngữ nghĩa; (b) test ghim NGUYÊN TẮC cũ xung đột với feature mới → dừng lại, hỏi user/quyết
  có chủ đích, ghi rationale vào result — không xoá assertion chỉ để xanh.*
- **Số suite phải ĐẾM LẠI trong phiên, kể cả khi trong đầu "nhớ là 691/689"** — lần này đếm lại ra 682 pass/9 fail (khác con số
  nhớ), và 9 fail phân loại được đúng 2 dsh-env + 7 regression M1 (không còn fail mù). Con số trong working.md của phiên đứt là
  **tin đồn** cho tới khi log hiện tại nói lại.
  *Luật: mỗi result mở đầu bằng số suite chạy THẬT trong phiên (lệnh + con số + phân loại fail), không kế thừa số phiên trước.*

## Đợt next4 — A3 PDF + B chống trùng tỜ HĐ + M1-site + A2/A3 Flutter + P9-D (2026-09-25, `result70.txt`)

> 3 commit: `7ca1409` (server A3+B+M1-site) · `8a692f1` (Flutter kênh file HĐĐT + thẻ tạo khách) ·
> `47558ce` (docs) · `f82f656` (P9-D — commit RIÊNG, user duyệt riêng vì **vùng số tiền**).

### A. ERPNext — bài học portable (đã đồng bộ vào skill `erpnext-rest-api-core` §6)

- **Chứng từ NHÁP (`docstatus = 0`) KHÔNG giảm công nợ — GL chỉ đổi lúc SUBMIT.** Đo thật: seed nháp
  `PE-M901` 1.000.000 phủ SINV-0001 rồi hỏi "thu tiền cho Nguyễn Thị Lan 2 triệu" **2 lần** ⇒ cả hai
  lần vẫn đề xuất **2.500.000** ⇒ người dùng bấm xác nhận lần hai = **2 phiếu nháp cùng trả một khoản nợ**.
  *Luật: mọi số "còn nợ" phải trừ phần các phiếu NHÁP đang phủ (`docstatus=0` theo party + đọc
  `references[]` của từng phiếu), và **đọc lại đúng phép tính đó lúc xác nhận** — nháp đổi ở giữa ⇒ TỪ CHỐI.*
- **Field kiểu Link trỏ một giá trị KHÔNG có trên site ⇒ `LinkValidationError`, chết cả request — và mock dễ dãi hơn site che bug này.**
  Ca thật: hardcode `customer_group: "Múa"` — site không có group đó ⇒ **MỌI** create hỏng. Mock cho qua nên không thấy.
  *Luật: không hardcode tên master; đọc danh sách hợp lệ từ chính site, fail-closed khi giá trị config không có trên site; mock phải từ chối Link lạ như ERPNext.*
- **`limit_page_length: 0` = KHÔNG giới hạn (trả HẾT)**, không phải "0 bản ghi" (đo thật 20 → 20, 100 → 100, 0 → 123). Dùng cho pre-check toàn master.
- **Cột `unique = 1` thêm vào doctype đã có dữ liệu vẫn an toàn nếu các dòng cũ là NULL** — index chấp nhận nhiều NULL ⇒ migrate + `--dry-run` + chạy lại là no-op, kiểm chứng độc lập bằng REST đọc meta.

### B. Bẫy của chính project (đã đồng bộ vào skill `erpn-verify-first` bảng bẫy)

- **Test dùng LẠI cùng một proposal + cùng một khoản nợ cho HAI lần ghi ⇒ 4 test vỡ khi hành vi mới là ĐÚNG.**
  `p8`×2 + `p10`×2 gửi lại cùng `proposal` (cùng `command_id`) cho cùng khoản nợ; khi builder bắt đầu trừ phần
  đã-nằm-trong-nháp, lần hai bị `PAYMENT_DRAFT_COVERED` ⇒ đỏ. Sản phẩm KHÔNG có luồng nào làm vậy (trùng
  `command_id` = gateway replay TRƯỚC executor).
  *Luật: test đỏ ở nhánh "số CÒN LẠI" ⇒ hỏi luồng thật có bao giờ làm thế không; không ⇒ cấp mỗi lần ghi một
  khoản nợ riêng, giữ nguyên mọi khẳng định cũ.*
- **Widget tự POST bằng dio RIÊNG ⇒ bỏ qua client đã cấu hình ⇒ 401, và UI báo lỗi như thể người dùng bấm sai.**
  `ProposalCard` POST `/execute` không gọi `applySettings()` (có từ Phase 7) ⇒ server có basic auth trả 401,
  **không gì được ghi**. Không test nào bắt được (mọi host test dùng adapter không auth).
  *Luật: mọi đường HTTP MỚI (kể cả trong widget) đi qua client đã cấu hình; grep `dioProvider` mỗi khi thêm request.*
- **Guard viết theo HỆ QUẢ (`<= 0`) nuốt luôn một nguyên nhân KHÁC ⇒ báo sai bản chất.**
  `if (effectiveOutstanding <= 0) throw PAYMENT_DRAFT_COVERED` — credit note cho `outstanding` ÂM cũng thoả `<= 0`
  ⇒ hoá đơn số âm bị báo "đã có phiếu nháp phủ hết". **Suite bắt được, review không bắt được.**
  *Luật: guard nêu NGUYÊN NHÂN (`&& drawnForTarget > 0`), không nêu hệ quả; mỗi nguyên nhân cùng thoả biểu thức phải có 1 test.*
- **Snapshot lưu giá trị ĐÃ SUY RA nhưng drift so với giá trị RAW ⇒ MỌI xác nhận khi có nháp bị từ chối oan.**
  Snapshot lưu `outstanding_vnd` **hiệu dụng** (1.500.000) nhưng `detectDrift` so với GL raw (2.500.000) ⇒
  `PROPOSAL_STALE` dù không ai đổi gì. Kèm ca phụ: `Math.round` của drift bỏ qua chênh < 1đ ⇒ cần chốt so **chính xác**.
  *Luật: lưu CẢ raw lẫn giá trị dùng để quyết định; drift phải so trên đúng cơ sở đã lưu; test 2 chiều (không đổi ⇒ THÀNH CÔNG).*
- **So khớp "gần trùng" bằng `String.includes` biến một bản ghi tên CỰC NGẮN thành chặn MỌI lệnh tạo — lần THỨ 3 của cùng họ lỗi.**
  Site có customer tên đúng một chữ `"A"` ⇒ `"khách test app m1".includes("a")` ĐÚNG (chữ a trong "app") ⇒ **mọi**
  lệnh thêm khách bị `CC_FUZZY_MATCH`. Cùng họ với `result63` nhưng nặng hơn: không đọc sai mà **chặn hẳn tính năng**.
  *Luật: so khớp theo TỪ nguyên vẹn; luật "gần giống" phải có test với bản ghi tên 1–2 ký tự; xuất hiện lần 3 ⇒ nâng thành luật chung.*
- **3 workstream dùng CHUNG file plumbing ⇒ tách commit theo hunk ra commit "trông đủ" mà thiếu một nửa đường.**
  A3 + B + M1-site cùng chạm `http-ask.mjs`, `capabilities.json`, `mock-server.mjs`.
  *Luật: khi không tách được mà vẫn cần commit đọc được ⇒ gộp và ghi RÕ từng phần trong message, đừng để lịch sử git nói dối bằng im lặng.*

### C. Parse file người lạ gửi — chủ đề MỚI, đã tách thành skill riêng

- **`zlib.inflateSync` trên input không tin cậy KHÔNG có trần đầu ra** — cap trên input NÉN không cap OUTPUT.
  Đo thật: 106.884 byte nén → **31.457.284 byte (294×)**, `extractPdfText` 4,3 s, RSS **+541 MB**; trần theo
  SỐ DÒNG chỉ có tác dụng SAU khi đã dựng xong text ⇒ đã quá muộn.
  *Luật: 2 trần riêng (compressed/inflated), giải nén theo chunk, bỏ ngay khi vượt trần, mã lỗi riêng, test "bomb" thật.*
- **Regex nhãn có nhánh NGẮN TRẦN khớp bên trong nhãn KHÁC.** `/(so hoa don|so hd|so)/` — nhánh `so` khớp "mã **số** thuế",
  "in **số** bản". Đo thật: "Mã số thuế: 0300000002" trên "Số: 0000049" ⇒ `invoice_no = "thu"` (so nhãn trên dòng đã BỎ DẤU,
  lấy giá trị từ dòng GỐC ⇒ cắt giữa token), `complete = true` ⇒ **định danh rác đi vào chứng từ và khoá chống trùng**.
  *Luật: bỏ nhánh trần hoặc chặn ngữ cảnh (`ma so|so ban|so luong`), ưu tiên nhãn cụ thể, cắt giá trị và so nhãn trên CÙNG một chuỗi.*
- **Không bao giờ lấy "số/ngày ĐẦU TIÊN tìm thấy".** `readDate` lấy ngày số đầu tiên không nhãn ⇒ "Ngày đặt hàng: 01/09/2026"
  thắng "Ngày 20/09/2026" ⇒ khoá chống trùng sai ⇒ cùng một tờ hoá đơn tạo **hai** chứng từ; footer "In ngày 30/09/2026" cũng được nhận.
  *Luật: mọi field ĐỊNH DANH phải gắn NHÃN; nhiều ứng viên ⇒ mơ hồ ⇒ từ chối, không lấy cái đầu.*

### D. Nơi đã lưu (đối chiếu, để lần sau không ghi trùng)

| Nhóm | Nơi sở hữu | Hình thức |
|---|---|---|
| A (portable ERPNext) | `.agents/skills/erpnext-rest-api-core` §6 | +3 bullet |
| B (bẫy project) | `.agents/skills/erpn-verify-first` bảng bẫy | +5 dòng |
| C (parse file người lạ) | `.agents/skills/untrusted-file-parsing` | **skill MỚI** (chưa ai sở hữu) |
| Cross-project (Simplenote) | — | ⚠️ **Simplenote MCP không khả dụng phiên này** ⇒ bản dùng chung nhiều project CHƯA ghi được, phải ghi lại ở phiên có công cụ |

## Đợt next5 (D0→D5) + fix P4-6 "Hôm qua" (2026-09-26, `result74.txt`)

> Phiên này commit `17d6f9b` (next5, 39 file) + `ed79f77` (P4-6 [VÙNG SỐ TIỀN], 8 file).
> **5 lỗi/bài học của chính AI** — đã ghi vào `.agents/skills/erpn-verify-first/SKILL.md` (+5 dòng).

- **`flutter analyze --no-pub` chạy trên `package_config.json` CŨ ⇒ 1069 lỗi `undefined_class` GIẢ.**
  Sau khi thêm/xóa file Dart mà chưa `flutter pub get`, analyzer đọc package map cũ ⇒ báo cả loạt symbol không tồn tại dù code đúng.
  *Luật: thấy hàng trăm lỗi `undefined_class` không liên quan code vừa sửa ⇒ `flutter pub get` rồi chạy lại (`dart analyze <files>`), đừng đi sửa code theo lỗi giả.*
- **Sửa code làm LỆCH anchor falsify ⇒ harness báo sai (sống/chết nhầm).** Đổi cấu trúc chuỗi mà harness grep theo ⇒ 2 anchor hết khớp + nhãn `only` sai chỗ.
  *Luật: TRƯỚC khi sửa code có harness bao, grep chính xác anchor/`only` trong harness, sửa rồi chạy lại để xác nhận RED/GREEN đúng chỗ.*
- **Đổi DỮ LIỆU mà một thẻ hiển thị ⇒ phải rà MỌI đường refresh/retry, không chỉ đường render.** Fix P4-6 đổi `_salesInvoices`/`_receipts` sang `_yesterday` nhưng để nguyên `onRefresh` + `_BlockError.onRetry` gọi `_load(force)` cho hôm nay ⇒ **M1/M2** (kéo-refresh/thử-lại khi xem "Hôm qua" đọc sai ngày). Review thủ công bắt được, test không bắt.
  *Luật: khi một màn có nhiều nguồn dữ liệu theo ngày/ngữ cảnh, liệt kê hết các đường đọc lại dữ liệu (refresh, retry, re-mount, invalidate) và sửa ĐỒNG BỘ — hoặc ghi rõ giới hạn.*
- **Mô tả phương án fix với scope PHÓNG ĐẠI ⇒ phải hỏi lại user lần 2.** Bản tóm tắt option A ban đầu mô tả sai phạm vi ảnh hưởng ⇒ user hỏi vòng 2 mới chốt đúng.
  *Luật: khi trình phương án cho user, ghi rõ CHÍNH XÁC file/hành vi nào đổi — không dùng từ chung chung khiến user hiểu sai quy mô; thà hỏi lại.*
- **Ca falsify cho đường fail-closed phải biến đổi DỮ LIỆU, không phải làm code crash.** Suýt chọn cách cho object null để ép lỗi ⇒ không kiểm được logic "chưa đọc được ⇒ không hiện số ngày khác".
  *Luật: test fail-closed bằng cách cho trạng thái HỢP LỆỆ nhưng thiếu dữ liệu/đọc lỗi — cái phải chứng minh là HÀNH VI (không rơi về giá trị khác), không phải việc code ném exception.*

### Nơi đã lưu (đối chiếu, để lần sau không ghi trùng)

| Nhóm | Nơi sở hữu | Hình thức |
|---|---|---|
| Bẫy project (analyze giả · anchor falsify · refresh/retry · scope phương án · falsify fail-closed) | `.agents/skills/erpn-verify-first` | +5 dòng (nay 519 dòng) |
| Cross-project (Simplenote) | — | ⚠️ **Simplenote MCP + AgentMemory không khả dụng phiên này** ⇒ chưa ghi được, phải ghi lại ở phiên có công cụ |

