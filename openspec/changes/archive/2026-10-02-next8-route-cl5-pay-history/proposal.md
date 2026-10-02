# next8 / Route CL-5 — "Lịch sử thu của X" reaches payment.history

## Why

`res1.md` §3: `Lịch sử thu của <Tên>` does not route at all — the audit recorded
`UNKNOWN_INTENT` on the real site. Its siblings (`phiếu thu`, `đã trả bao nhiêu`)
already reach `payment.history`; only the phrase "lịch sử thu" (money IN) is missing
from the payment group's keyword set (which already has "lịch sử chi").

## What Changes

1. Add the narrow phrase `lịch sử thu` to the `payment` READ group's keywords. It is
   a two-word phrase (not the bare verb `thu`), so it cannot steal other sentences.
   `Lịch sử thu của <Tên>` → `payment` / `payment.history`, for both a customer and
   a supplier name.

## Out of scope

- No change to payment logic or the write path. This is a READ synonym only.
