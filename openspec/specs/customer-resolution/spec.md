# customer-resolution Specification

## Purpose
Khả năng `customer-resolution`: đọc master khách hàng TRỌN VẸN (không cắt im lặng ở trang đầu) để id luôn phân giải được, và đọc master NHIỀU NHẤT MỘT LẦN cho mỗi request. Kết quả đọc chỉ là GỢI Ý — caller vẫn phải re-validate id, giữ nguyên HINT-NOT-AUTHORITY.

## Requirements

### Requirement: The customer master is read whole, not cut at the first page

`/collect/propose` MUST resolve a customer id against the FULL customer master
returned by ERPNext, not against a truncated page. The read MUST NOT silently cap
the number of customers; when a site holds more customers than a single page, a
customer beyond that page MUST still resolve. The master returned by the read
stays a HINT: the id the client sends is re-validated against the freshly-read
master at propose time and is never accepted as authority on its own.

#### Scenario: a customer beyond the first page still resolves

- **WHEN** a customer id belongs to a customer that ERPNext returns only after
  the first page of `erpnext_customer_list`
- **THEN** `/collect/propose` finds that customer and builds the proposal instead
  of answering `NO_MATCH`

#### Scenario: an unknown id is still refused

- **WHEN** the id the client sends is not present in the fresh master read
- **THEN** the answer is `NO_MATCH` and nothing is proposed

#### Scenario: an unreadable master is a refusal, not an empty list

- **WHEN** the customer master read fails
- **THEN** the answer is `ERP_UNAVAILABLE`, never a proposal built from an empty
  customer list

### Requirement: One request reads the customer master at most once

Several resolvers in a single request may need the whole master (chat picker,
balance, drill-down, `/collect/propose`), so the read MUST be reused within that
request instead of repeated. The reuse MUST NOT outlive the request that made it:
the next request reads ERPNext again, so no id is ever judged against a master
older than the request holding it. Reuse MUST NOT weaken the hint rule — every
caller still re-validates the id it was given, and ids from the read are still
registered as known.

#### Scenario: two lookups in one request share one read

- **WHEN** two customer lookups run inside the same request
- **THEN** ERPNext's customer list is read once, and each lookup still filters the
  rows by its own fragment and still registers the ids it returns

#### Scenario: the next request reads again

- **WHEN** a new request looks up a customer with its own registry
- **THEN** the master is read from ERPNext again, not reused from the previous
  request
