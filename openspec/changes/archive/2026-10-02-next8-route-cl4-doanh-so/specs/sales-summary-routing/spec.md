## ADDED Requirements

### Requirement: "doanh số" and "doanh thu" ask the same question

`doanh số …` MUST resolve to `sales.summary`, exactly like `doanh thu …` — both mean
the shop's sales figure. Adding the phrase MUST NOT move document-list questions:
`hoá đơn chưa trả …` / `invoice …` MUST still resolve to `invoice.lookup`.

#### Scenario: doanh số reaches the sales summary

- **WHEN** the sentence is `doanh số hôm nay`
- **THEN** the router resolves `sales` / `sales.summary`

#### Scenario: doanh thu is unchanged

- **WHEN** the sentence is `báo cáo doanh thu hôm nay`
- **THEN** the router resolves `sales` / `sales.summary`

#### Scenario: a document list is still a list

- **WHEN** the sentence is `hóa đơn chưa trả của chị Lan`
- **THEN** the router resolves `sales` / `invoice.lookup`
