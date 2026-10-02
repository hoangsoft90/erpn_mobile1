# route-scope Specification

## Purpose
Khả năng `route-scope`: router ý định KHÔNG được phân giải một câu thuộc thế giới đời sống/smart-home/chit-chat thành capability ERP, kể cả khi câu chứa danh từ chung trùng nhóm (`khách` trong `phòng khách`, `hàng` trong `cửa hàng`). Ngoài miền ERP thì trả lời rõ là ngoài phạm vi, không bịa.

## Requirements

### Requirement: An off-domain sentence is never answered as an ERP question

The intent router MUST NOT resolve a sentence that is about the physical, smart-home
or chit-chat world into an ERP capability, even when it contains a broad group's
generic noun (`khách` "guest" also lives in `phòng khách` "living room"; `hàng`
"goods" also lives in `cửa hàng` "shop"). Such a sentence MUST resolve to **no
route**, so the pipeline's existing out-of-scope answer is used. The guard MUST be
DENY-only: it can remove a broad-keyword match and MUST NOT add a route or widen any
keyword.

#### Scenario: a smart-home command is not an ERP question

- **WHEN** the sentence is `bật đèn phòng khách`
- **THEN** the router returns no route (the word `khách` does not make it a customer
  question)

#### Scenario: "when does the shop open" is not a stock question

- **WHEN** the sentence is `cửa hàng mở cửa lúc nào`
- **THEN** the router returns no route (the word `hàng` in `cửa hàng` does not make it
  a stock question)

#### Scenario: a real ERP sentence still routes

- **WHEN** the sentence is an ERP question such as `tồn kho cám heo còn bao nhiêu`
- **THEN** the router still resolves it to `stock.balance` (the guard only denies)
