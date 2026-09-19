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
