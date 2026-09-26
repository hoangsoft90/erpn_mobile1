# Kịch bản thu âm 150 câu tiếng Việt 3 miền (Phase 4 blocker)

> Mục đích: khi tổ chức thu âm, người thu mở file này và đọc theo bảng — không phải
> nghĩ lúc đó. Mỗi câu có **ground truth** để sau này đo STT + pipeline accuracy ĐO ĐƯỢC,
> không đánh giá cảm tính. Tên khách/vật tư dùng TÊN THẬT đang có trong ERPNext test
> để audio chạy end-to-end sau khi thu. **Không dùng TTS** (yêu cầu phase-01).

## 1. Hướng dẫn thu âm (đọc trước khi bấm record)

| Mục | Yêu cầu |
|---|---|
| Thiết bị | Điện thoại thật (mục tiêu sản phẩm) — mic thường, KHÔNG mic studio; ghi app ghi âm mặc định, định dạng m4a/wav, tối thiểu 16kHz |
| Môi trường | 3 điều kiện mỗi miền: **(a)** trong nhà yên tĩnh, **(b)** cửa hàng/kho có tiếng nền nhẹ, **(c)** ngoài đường tiếng xe — mỗi điều kiện ~50 câu |
| Cách đọc | Tự nhiên như nói với nhân viên, KHÔNG đọc vē chữ; giữ tốc độ bình thường; nghỉ 1–2 giây giữa 2 câu |
| Số tiền | Đọc đúng tự nhiên: "269 nghìn" → đọc "hai trăm sáu mươi chín nghìn"; 2.500.000 → "hai triệu năm trăm nghìn" (hoặc "hai triệu rưỡi" nếu bảng ghi rưỡi) |
| Đặt tên file | `<miền>_<điều kiện>_<số câu>.<ext>` ví dụ `bac_nha_013.m4a`, `nam_duong_077.m4a` |
| Metadata mỗi người thu | Tên (hoặc bí danh), miền (Bắc/Trung/Nam), tỉnh/thành lớn hơn 20 năm, tuổi, giới tính — ghi vào file `nguoi-thu.csv` |
| Số lượng mục tiêu | 3 miền × 50 câu = **150 câu** (tối thiểu chấp nhận: 3 × 34 = 102) |
| Ground truth | KHÔNG ghi vào file audio; giữ trong bảng này — chấm điểm đối chiếu sau |

## 2. Chú giải cột

- **GT** = ground truth (đáp án đúng để chấm): số tiền nguyên VND / tên khách / vật tư / hành vi kỳ vọng (`NULL` = pipeline PHẢI từ chối, không sinh số).

## 3. Nhóm A — Công nợ (30 câu, 10/miền)

| # | Miền | Câu đọc | GT |
|---|---|---|---|
| A01 | B | Khách smoke 2026-09-13-p1done còn nợ bao nhiêu | 269000 |
| A02 | B | Cho tôi biết công nợ của Trang trại Minh Anh | (khách có thật, dư nợ theo DB) |
| A03 | B | Công trình nhà ông An còn nợ mấy tiền | (theo DB) |
| A04 | B | Công ty xây dựng ABC còn nợ bao nhiêu | (theo DB) |
| A05 | B | Anh Nam ơi hỏi giùm khách smoke 2026-09-13-p1done còn nợ bao nhiêu tiền | 269000 |
| A06 | B | Bác Hai hỏi công nợ của khách smoke 2026-09-13-postfix | (theo DB) |
| A07 | B | Khách lẻ Minh Phát còn nợ không | (theo DB) |
| A08 | B | Chị Lan còn nợ bao nhiêu | NULL (khách không tồn tại → fail-safe hỏi lại) |
| A09 | B | Hỏx công nợ khách Nguyễn Văn A | (theo DB; "hỏx" = lỗi gõ/tiếng ồm có chủ đích) |
| A10 | B | Khách smoke 2026-09-13-p1done nợ mình bao nhiêu rồi | 269000 |
| A11 | T | Trang trại Minh Anh còn nợ bao nhiêu vậy cô | (theo DB) |
| A12 | T | Dư nợ của Công trình nhà ông An là bao nhiêu | (theo DB) |
| A13 | T | Công ty xây dựng ABC nợ bao nhiêu tiền | (theo DB) |
| A14 | T | Cho hỏi khách lẻ Minh Phát còn nợ mấy | (theo DB) |
| A15 | T | Khách smoke 2026-09-13-p1done còn nợ không | 269000 |
| A16 | T | Cô Ba hỏi công nợ của Trang trại Minh Anh | (theo DB) |
| A17 | T | Nguyễn Văn A còn nợ bao nhiêu | (theo DB) |
| A18 | T | Khách smoke 2026-09-13-postfix còn dư nợ mấy tiền | (theo DB) |
| A19 | T | Hỏi giùm Công trình nhà ông An còn thiếu bao nhiêu | (theo DB) |
| A20 | T | Trời ơi khách Nguyễn Văn A còn nợ không đó | (theo DB) |
| A21 | N | Trang trại Minh Anh còn nợ mấy tiền dạ | (theo DB) |
| A22 | N | Dạ khách lẻ Minh Phát còn nợ bao nhiêu | (theo DB) |
| A23 | N | Công ty xây dựng ABC còn nợ tới bao nhiêu rồi | (theo DB) |
| A24 | N | Khách smoke 2026-09-13-p1done còn nợ bao nhiêu luốn | 269000 |
| A25 | N | Hỏi công nợ của Công trình nhà ông An giùm em | (theo DB) |
| A26 | N | Chú ơi khách Nguyễn Văn A nợ bao nhiêu | (theo DB) |
| A27 | N | Khách smoke 2026-09-13-postfix còn thiếu mấy | (theo DB) |
| A28 | N | Trang trại Minh Anh còn nợ hông | (theo DB) |
| A29 | N | Cho em hỏi dư nợ khách lẻ Minh Phát | (theo DB) |
| A30 | N | Ông Sáu hỏi công nợ Trang trại Minh Anh nè | (theo DB) |

## 4. Nhóm B — Hóa đơn (20 câu)

| # | Miền | Câu đọc | GT |
|---|---|---|---|
| B01 | B | Hóa đơn chưa trả của Khách làm tròn 2026-09-14-p1fixwhole còn lại bao nhiêu | (theo DB) |
| B02 | B | Liệt kê hóa đơn chưa thanh toán của khách smoke 2026-09-13-p1final | (theo DB) |
| B03 | B | Đơn hàng nào của khách đo lại 309110 chưa trả tiền | (theo DB) |
| B04 | B | Khách smoke 2026-09-13-p1done có mấy hóa đơn chưa trả | 3 |
| B05 | B | Hóa đơn nào của Trang trại Minh Anh chưa thanh toán | (theo DB) |
| B06 | T | Hóa đơn chưa trả của khách smoke 2026-09-13-p1final có mấy cái | (theo DB) |
| B07 | T | Đơn nào của Khách làm tròn 2026-09-14-p1fixwhole chưa trả tiền | (theo DB) |
| B08 | T | Kể hóa đơn chưa thanh toán của Trang trại Minh Anh | (theo DB) |
| B09 | T | Khách đo lại 309110 còn hóa đơn nào chưa trả | (theo DB) |
| B10 | T | Công trình nhà ông An có hóa đơn nào chưa đóng không | (theo DB) |
| B11 | N | Hóa đơn chưa trả của Khách làm tròn 2026-09-14-p1fixwhole còn mấy | (theo DB) |
| B12 | N | Liệt kê giùm hóa đơn chưa thanh toán của khách smoke 2026-09-13-p1final | (theo DB) |
| B13 | N | Đơn hàng nào của khách đo lại 309110 chưa trả | (theo DB) |
| B14 | N | Trang trại Minh Anh còn mấy hóa đơn chưa đóng tiền | (theo DB) |
| B15 | N | Hóa đơn nào của khách smoke 2026-09-13-p1done chưa trả vậy | 3 hóa đơn |
| B16 | B | Hóa đơn tháng này khách smoke 2026-09-13-p1done trả chưa | (theo DB) |
| B17 | T | Invoice nào của khách lẻ Minh Phát chưa thanh toán | (theo DB) |
| B18 | N | Hóa đơn của Công ty xây dựng ABC trả chưa | (theo DB) |
| B19 | B | Xem giùm hóa đơn chưa trả của Công trình nhà ông An | (theo DB) |
| B20 | T | Khách smoke 2026-09-13-postfix còn bills nào chưa trả | (theo DB; từ nước ngoài có chủ đích) |

## 5. Nhóm C — Phiếu thu / thanh toán (15 câu)

| # | Miền | Câu đọc | GT |
|---|---|---|---|
| C01 | B | Khách smoke 2026-09-14-p1fixwhole đã trả tiền chưa | đã trả 91000, 2 phiếu |
| C02 | B | Xem phiếu thu của Công trình nhà ông An | 0 phiếu |
| C03 | B | Khách smoke 2026-09-13-p1done đã thanh toán bao nhiêu rồi | (theo DB) |
| C04 | B | Trang trại Minh Anh trả tiền đợt trước chưa | (theo DB) |
| C05 | T | Phiếu thu của Công trình nhà ông An có mấy cái | 0 |
| C06 | T | Khách làm tròn 2026-09-14-p1fixwhole đã trả chưa | 91000, 2 phiếu |
| C07 | T | Khách smoke 2026-09-13-p1done đã đóng bao nhiêu | (theo DB) |
| C08 | T | Khách lẻ Minh Phát có phiếu thu nào không | (theo DB) |
| C09 | N | Dạ khách smoke 2026-09-14-p1fixwhole trả tiền chưa vậy | 91000, 2 phiếu |
| C10 | N | Xem giùm phiếu thu của Trang trại Minh Anh | (theo DB) |
| C11 | N | Công trình nhà ông An đã thanh toán gì chưa | 0 |
| C12 | N | Khách smoke 2026-09-13-p1done đã trả mấy lần rồi | (theo DB) |
| C13 | B | Khách đo lại 309110 trả tiền đợt nào rồi | (theo DB) |
| C14 | T | Thanh toán gần nhất của khách lẻ Minh Phát là hồi nào | (theo DB) |
| C15 | N | Công ty xây dựng ABC đóng tiền tới đâu rồi | (theo DB) |

## 6. Nhóm D — Tồn kho (25 câu)

| # | Miền | Câu đọc | GT |
|---|---|---|---|
| D01 | B | Cám gà còn tồn kho bao nhiêu | (theo DB, lọc đúng Cám gà thịt 25kg) |
| D02 | B | Tồn kho của cám heo là bao nhiêu | (theo DB) |
| D03 | B | Trong kho còn bao nhiêu gạch đỏ | (theo DB) |
| D04 | B | Thép D16 còn lại trong kho mấy | (theo DB) |
| D05 | B | Cám vịt còn mấy bao trong kho | (theo DB) |
| D06 | T | Kho còn cám gà không | (theo DB) |
| D07 | T | Cám heo trong kho còn bao nhiêu ký | (theo DB) |
| D08 | T | Gạch đỏ còn lại mấy ngàn viên | (theo DB) |
| D09 | T | Thép D16 tồn bao nhiêu | (theo DB) |
| D10 | T | Cám gà thịt 25kg còn mấy bao | (theo DB, tên ĐẦY ĐỦ) |
| D11 | N | Cám gà còn nhiêu trong kho dạ | (theo DB) |
| D12 | N | Tồn kho cám heo bao nhiêu rồi | (theo DB) |
| D13 | N | Gạch đỏ trong kho còn không | (theo DB) |
| D14 | N | Thép D16 còn mấy cây | (theo DB) |
| D15 | N | Cám vịt còn lại bao nhiêu bao | (theo DB) |
| D16 | B | Kiểm tra giùm tồn kho cám gà | (theo DB) |
| D17 | T | Hàng trong kho cám heo còn bao nhiêu | (theo DB) |
| D18 | N | Dạ kho mình còn cám gà hông | (theo DB) |
| D19 | B | Cám heo 25 ký còn tồn mấy | (theo DB) |
| D20 | N | Gạch đỏ 2 lỗ còn nhiêu viên | (theo DB) |
| D21 | T | Cho coi tồn kho thép D16 | (theo DB) |
| D22 | B | Vật tư cám vịt còn bao nhiêu | (theo DB) |
| D23 | N | Kho còn mấy bao cám heo | (theo DB) |
| D24 | T | Cám gà còn trong kho hay hết rồi | (theo DB) |
| D25 | B | Báo giùm số lượng tồn kho gạch đỏ | (theo DB) |

## 7. Nhóm E — Số tiền khó (35 câu; GT bắt buộc chính xác tuyệt đối)

| # | Miền | Câu đọc | GT (VND) |
|---|---|---|---|
| E01 | B | Anh Nam nợ hai trăm ba mươi nghìn | 230000 |
| E02 | B | Bác Hai trả mười triệu | 10000000 |
| E03 | B | Cô Ba mua 230k cám gà | 230000 |
| E04 | B | Đơn này còn nợ một trăm hai mươi lăm triệu | 125000000 |
| E05 | B | Chị Lan trả mười củ | 10000000 |
| E06 | B | Khách nợ một chục triệu | 10000000 |
| E07 | B | Hóa đơn 500 ngàn | 500000 |
| E08 | B | Thu về 0.5 triệu tiền cám | 500000 |
| E09 | B | Anh trả 10 triệu 500 nghìn | 10500000 |
| E10 | B | Đơn hàng hai triệu rưỡi | 2500000 |
| E11 | T | Nợ hai trẹo | 2000000 |
| E12 | T | Trả một trẹo rưỡi | 1500000 |
| E13 | T | Bác Hai mua cám heo 1 tỷ 200 triệu | 1200000000 |
| E14 | T | Khách trả 1,500,000 đồng | 1500000 |
| E15 | T | Hóa đơn 230.000đ | 230000 |
| E16 | T | Nợ năm trăm nghìn chẵn | 500000 |
| E17 | T | Cám giá 2tr5 một bao | 2500000 |
| E18 | T | Gửi thêm 1k5 tiền nước | 1500 |
| E19 | N | Nợ hai chai | 2000000 |
| E20 | N | Trả ba trẹo tiền gạch | 3000000 |
| E21 | N | Khách nợ một triệu không trăm | 1000000 |
| E22 | N | Đơn nửa triệu | 500000 |
| E23 | N | Trả 5000vnd tiền bóp | 5000 |
| E24 | N | Hóa đơn 2000đ | 2000 |
| E25 | N | Mua một trăm linh năm nghìn | 105000 |
| E26 | N | Nợ 1 500 000 tiền cám | 1500000 |
| E27 | B | Mười lăm triệu rưỡi tiền thép | 15500000 |
| E28 | T | Bốn trăm năm mươi nghìn tiền cám vịt | 450000 |
| E29 | N | Chín triệu tám trăm nghìn tiền gạch | 9800000 |
| E30 | B | Khách trả hai mươi lăm triệu | 25000000 |
| E31 | T | Nợ sáu chục triệu | 60000000 |
| E32 | N | Trả tám chục nghìn tiền nước | 80000 |
| E33 | B | Đơn ba tỷ đồng | 3000000000 |
| E34 | T | Cám heo bảy trăm nghìn một bao | 700000 |
| E35 | N | Khách nợ một triệu hai trăm | NULL (số trần cuối câu — pipeline PHẢI từ chối, không đoán 1.200.000) |

## 8. Nhóm F — Danh xưng + tên thật (15 câu)

| # | Miền | Câu đọc | GT (tên sau strip) |
|---|---|---|---|
| F01 | B | Anh Nam hỏi công nợ | Nam (lưu ý: "anh Nam" giữa câu giữ nguyên, pipeline tự xử lý) |
| F02 | B | Chị Nguyễn Thị Lan còn nợ bao nhiêu | NULL (khách không tồn tại — fail-safe) |
| F03 | B | Bác Hai mua cám heo | Hai |
| F04 | T | Cô Ba hỏi tồn kho cám gà | Ba |
| F05 | T | Chú Tư mua gạch đỏ | Tư |
| F06 | N | Ông Sáu nợ tiền cám | Sáu |
| F07 | N | Dì Mười hỏi hóa đơn | Mười |
| F08 | B | Cậu Tùng trả tiền rồi | Tùng |
| F09 | T | Thím Tám còn nợ không | Tám |
| F10 | N | Mẹ Tư hỏi công nợ Trang trại Minh Anh | (tên thật: Công trình nhà ông An KHÔNG bị strip "ông") |
| F11 | B | Công trình nhà ông An còn nợ bao nhiêu | GIỮ NGUYÊN "Công trình nhà ông An" (test chống strip giữa câu) |
| F12 | T | Anh Ba — xây nhà còn nợ mấy | GIỮ NGUYÊN "Anh Ba — xây nhà" |
| F13 | N | Bác Hai trả một trẹo tiền cám | Hai + 1000000 |
| F14 | T | Dượng Năm mua hai bao cám heo | Năm + quantity 2 bao |
| F15 | N | Cụ Tư nợ tiền gạch đỏ | Tư |

## 9. Nhóm G — Fail-safe / âm tiếp (10 câu; kỳ vọng: pipeline từ chối hoặc hỏi lại)

| # | Miền | Câu đọc | Kỳ vọng |
|---|---|---|---|
| G01 | B | Hai trăm | NULL amount (không hậu tố, không scale lớn) |
| G02 | B | Trả 2000 | NULL (4 số dạng năm — từ chối có chủ đích) |
| G03 | T | Số điện thoại tôi 0912345678 | NULL (SĐT không phải tiền) |
| G04 | T | Nhà tôi số 1234 | NULL (định danh "nhà") |
| G05 | N | Mua 5 củ cải | NULL (củ cải = vật thật) |
| G06 | N | Chai nước ngọt còn không | NULL (chai = vật thật ở đây) |
| G07 | B | Doanh thu 2024 bao nhiêu | NULL (năm) |
| G08 | T | Hôm nay trời đẹp quá | no route (không phải câu hỏi nghiệp vụ) |
| G09 | N | Khách hàng nào còn nợ | (câu hỏi không tên — hợp lệ, trả danh sách/hỏi lại, KHÔNG chọn hộ khách) |
| G10 | B | Cám còn bao nhiêu | (ambiguous item — trả nhiều mặt hàng/hỏi lại, không đoán 1 loại) |

## 10. Tổng kiểm đếm

- A30 + B20 + C15 + D25 + E35 + F15 + G10 = **150 câu**
- Phân bổ điều kiện thu: mỗi người ~50 câu chia 3 môi trường (nhà/cửa hàng/đường) — trộn đều các nhóm, KHÔNG thu cả nhóm A trong nhà rồi cả nhóm E ngoài đường
- Miền Bắc + Trung + Nam: mỗi miền tối thiểu 1 người; lý tưởng 2 người/miền (nam + nữ, khác tuổi)

## 11. Sau khi thu (cho agent, không phải người thu)

1. Chạy STT trên từng file → so transcript với cột "Câu đọc" (WER từng miền)
2. Chạy pipeline normalize trên transcript → đối chiếu cột GT (accuracy tiền/tên/route)
3. Ghi kết quả vào `result*.txt` mới — exit criteria Phase 4: accuracy đo trên bộ này,
   không phải trên text viết sẵn
