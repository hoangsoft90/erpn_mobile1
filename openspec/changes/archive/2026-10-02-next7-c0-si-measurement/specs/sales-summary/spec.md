## Purpose

Gate đo đạc bắt buộc TRƯỚC khi code `sales.summary` (plan_final §5.2): mọi filter/field của skill
doanh thu phải được chứng minh trên ERPNext thật, không đoán. Change này KHÔNG thêm capability —
nó chốt BẰNG CHỨNG cho capability `sales.summary` sẽ khai báo ở change C1.

## ADDED Requirements

### Requirement: Sales-summary filters and fields are C0-proven, not guessed

Skill `sales.summary` (C1) MUST dùng: field tiền + cách xử lý return + filter docstatus đã đo
trên ERPNext thật ở C0 và ghi trong `.plan/next7/C0-result.md`. CẤM hardcode filter đoán.
Kết luận tối thiểu C0 phải phủ: SI submitted thường / submitted return / cancelled (docstatus=2) /
draft (docstatus=0) trong cùng một ngày lịch `Asia/Ho_Chi_Minh` và một company scope pin.

#### Scenario: return trong ngày không được tính thành doanh thu dương

- **WHEN** ngày đo có SI submitted return (đã đo dấu + field thật ở C0)
- **THEN** công thức net = Σ SI submitted thường − |Σ SI submitted return| (theo dấu đã đo), và
  số này được đối chiếu với block bán của Drawer cùng ngày/company

#### Scenario: PE không bao giờ vào doanh thu

- **WHEN** Payment Entry (kể cả submitted, cùng ngày) tồn tại
- **THEN** KHÔNG nằm trong phép tính doanh thu net (doanh thu ≠ tiền đã thu)

### Requirement: Measurement is evidence-first (C0 gate)

C0 MUST query ERPNext thật (không suy diễn từ fixture), sample phải ghi (name/docstatus/is_return/
amount/posting_date — không secret), và kết luận C1 phải trích được dòng code drawer đối chiếu.
Nếu ngày đo không có return thật: MUST ghi rõ giới hạn bằng chứng thay vì khẳng định công thức
đã được chứng minh trọn vẹn.

#### Scenario: thiếu return trong ngày đo

- **WHEN** cửa sổ đo không có SI return nào submitted
- **THEN** C0-result ghi giới hạn này + đề xuất đo bổ sung; C1 KHÔNG được tuyên bố C7 (return làm
  net giảm đúng) đã PASS chỉ từ fixture
