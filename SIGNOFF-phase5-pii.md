# SIGN-OFF — Phase 5: PII & Nghị định 13/2023 (Mandatory Sign-off, gate pháp lý)

> **Trạng thái: CHỜ KÝ DUYỆT.** Tài liệu này là điều kiện giải phóng gate C.1 của
> `phase-05-ai-gateway-core.md`. **Không code LLM Router / PII scrubbing cho tới khi
> bảng ở mục 6 được điền đủ và có chữ ký.** Đây là gate pháp lý CỐ Ý, không phải gate kỹ thuật.
>
> Người soạn: agent (Buffy) · Ngày soạn: 2026-09-14 · Người review/ký: chủ dự án (user)
> Sau khi ký: commit file này để lưu vết — dấu vết pháp lý cần nằm trong git history.

---

## 1. Tại sao có gate này (bằng chứng đã verify, không phải cảm tính)

Verify từ docs chính thức ngày 2026-09-13 (Phase 0, `phase-00-result.md`):

| Dịch vụ | Chính sách data | Hệ quả với PII |
|---|---|---|
| **Gemini free tier** | "Content used to improve our products" = **Yes** | Tên khách/SĐT/số tiền gửi qua free tier bị Google dùng cho mục đích riêng của họ |
| **Gemini paid tier** | Yes → **No** | Đường thoát hợp lệ nếu phải gửi dữ liệu thật |
| **OpenCode Zen / big-pickle** | Free, **không công bố cam kết zero-retention** | Coi như không an toàn cho PII |

Dữ liệu đang chảy trong hệ thống này (có thật, đã đo ở result9): **tên khách hàng,
số tiền công nợ (VND), tên vật tư, số hóa đơn** — đây là dữ liệu cá nhân theo
Nghị định 13/2023/NĐ-CP khi gắn với một con người cụ thể.

**Luật:** Nghị định 13/2023/NĐ-CP quy định xử lý dữ liệu cá nhân (kể cả chuyển dữ liệu
ra nước ngoài — Gemini/OpenCode server ngoài VN) cần sự đồng ý của chủ thể dữ liệu và
đánh giá tác động. Gửi PII khách hàng qua free tier mà không có cơ chế bảo vệ =
vi phạm tiềm ẩn ngay từ khách hàng thật đầu tiên.

---

## 2. Dữ liệu PII cụ thể trong luồng hiện tại (khoanh vùng để quyết định scrub)

Từ pipeline thật (Phase 2, result9 — 18 câu batch):

| Loại dữ liệu | Ví dụ thật | Xuất hiện ở đâu |
|---|---|---|
| Tên khách hàng (đơn vị/cá nhân) | "Trang trại Minh Anh", "Công trình nhà ông An" | Câu hỏi user → normalize → nameCandidates → **sẽ đi tới LLM** |
| Số tiền công nợ | 269.000đ, 91.000đ | Tool result ERPNext → câu trả lời → **sẽ đi qua LLM khi dsh dùng LLM thật** |
| SĐT | (chưa xuất hiện trong batch, có trong ERPNext) | Future phases (proposal card) |
| Tên vật tư, mã hóa đơn | "Cám gà thịt 25kg", SINV-… | Câu hỏi + tool result |

Điểm chèn scrub duy nhất cần bảo vệ: **trước khi text/JSON được gửi tới LLM endpoint**
(mọi chỗ khác đều là hạ tầng tự chủ: VPS, ERPNext, NLP service, HTTP nội bộ).

---

## 3. Các phương án scrubbing đã khảo sát (để trả lời câu hỏi 1 ở mục 6)

| Phương án | Cách làm | Ưu | Nhược | Ghi chú |
|---|---|---|---|---|
| **A. Placeholder scrub** | Tên khách → `CUSTOMER_1`, SĐT → `PHONE_1` trước khi gửi LLM; mapping giữ trong dsh plugin state; map ngược sau khi LLM trả lời | Free tier dùng được; LLM không bao giờ thấy PII thật | Phải map ngược chính xác; LLM mất ngữ cảnh tên (có thể trả lời máy móc hơn) | Đúng hướng phase-05 mục B |
| **B. Route theo PII** | Câu chứa PII → paid/zero-retention/self-host; câu generic → free tier | LLM thấy ngữ cảnh đầy đủ | Tốn tiền cho mọi câu có tên khách (thực tế = gần như mọi câu); phải detect PII trước khi route (bản thân việc detect là code thật) | |
| **C. A + B kết hợp** | Mặc định scrub; chỉ khi scrub làm hỏng chất lượng trả lời thì route paid | Đường lùi có chủ đích | Phức tạp nhất | phase-05 đề nghị "hay làm cả hai?" — đây là phương án C |
| **D. Self-host hoàn toàn** | LLM chạy trên VPS (vd model nhỏ) | Không PII nào ra ngoài | Chất lượng/chi phí GPU trên VPS hiện tại chưa biết; là dự án riêng | Không chặn Phase 5 — có thể là cải tiến sau |

Khuyến nghị của agent: **A làm nền tảng bắt buộc** (áp dụng cho MỌI endpoint, kể cả paid),
C là mở rộng khi cần. Nhưng quyết định thuộc về người ký.

---

## 4. Ràng buộc đã chốt sẵn (không renegotiate trong sign-off này)

Đoạn này chốt từ Phase 0 và viết cứng vào `phase-05-ai-gateway-core.md` — sign-off
chỉ điền quyết định còn thiếu, không được phá các nguyên tắc sau:

1. **Free tier Gemini/OpenCode KHÔNG nhận PII thật** — bắt buộc scrub hoặc route trước production.
2. Mobile client **không bao giờ giữ** ERPNext key/secret hay LLM key (verify bằng inspect network traffic).
3. PII scrubbing phải có **test case đo được**: gửi câu chứa tên + SĐT + số tiền → xác nhận
   LLM chỉ nhận placeholder **và** xác nhận không request nào chứa PII thật chạm free-tier endpoint.
4. Audit log phải trace được đầy đủ 1 request từ input → tool result.

---

## 5. Việc Phase 5 SẼ làm sau khi gate mở (để người ký biết mình đang duyệt cái gì)

1. PII scrub layer (dsh plugin, chạy trước gọi LLM) + mapping store — **code thật, có test**
2. Test case bắt buộc mục 4.3 (placeholder verifiable + network-level check không PII tới free tier)
3. LLM Router config-driven (yaml): fallback chain Primary → Fallback 1 → Fallback 2;
   verify lại rate limit thực tế tại thời điểm build (số liệu Phase 0 dễ lỗi thời)
4. Audit log trên cơ chế trace của dsh, bổ sung nếu thiếu
5. Custom confirmation UI tiếng Việt KHÔNG thuộc Phase 5 (là Phase 6) — không duyệt nhầm

Ước lượng: 2–3 tuần (theo phase-05). Không bao gồm Phase 6/7.

---

## 6. BẢNG QUYẾT ĐỊNH — điền đủ 4 dòng + chữ ký mới được mở gate

| # | Câu hỏi chặn | Trả lời (điền) | Người chịu trách nhiệm | Ngày |
|---|---|---|---|---|
| 1 | **Chiến lược PII scrubbing:** placeholder scrub TRƯỚC khi gọi LLM, hay chỉ route paid/zero-retention/self-host khi câu có PII, hay cả hai (C)? *(tham khảo mục 3)* | | | |
| 2 | **Có được dùng free tier Gemini/OpenCode cho dữ liệu chứa tên khách/số tiền KHÔNG?** Nếu không → đường thay thế là gì? | | | |
| 3 | Nếu PII **bắt buộc** phải ra khỏi hạ tầng (route paid): đã có đánh giá tác động chuyển dữ liệu ra nước ngoài chưa? (khoản 2 Điều 13 NĐ13) | | | |
| 4 | Mapping placeholder → tên thật lưu **ở đâu, ai được đọc, xoá khi nào**? (đề xuất: dsh plugin state trên VPS, chỉ operator, TTL xoá sau session) | | | |

**Người ký duyệt gate:** ____________________  Ngày ký: __________

> Sau khi ký: agent commit file này (`docs: phase 5 mandatory sign-off signed`) và MỚI được
> bắt đầu mục C (LLM Router) + mục B (PII scrubbing) của phase-05. Thiếu 1 trong 2
> (4 dòng đầy đủ + tên ký) → gate KHÔNG mở, kể cả khi mọi thứ khác đã chạy.

---

## 7. Trạng thái gate hiện tại (cập nhật bởi agent, không cần ký lại)

- [2026-09-14] Tài liệu soạn xong, gửi user review. Gate: **ĐÓNG**.
- Bảng mục 6: 0/4 dòng đã điền. Chưa có chữ ký.
- Việc đang làm song song KHÔNG thuộc gate: CI APK (run #2), docs — an toàn vì không đụng LLM Router/PII.
