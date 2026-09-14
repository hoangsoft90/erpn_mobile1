# vietnamese-nlp

Rule-based Vietnamese text normalization that runs **before** any LLM call, so
money, vocatives and domain wording are fixed by code instead of prompt
engineering.

Part of Phase 1 of the ERPNext Vietnamese voice copilot. Standard library only —
zero runtime dependencies, no LLM, no ERPNext, no network.

## What it does

| Layer | Example |
|---|---|
| Money → integer VND | `"mười triệu"`, `"10tr"`, `"1tr5"`, `"230k"`, `"10 triệu 500 nghìn"`, `"2 triệu rưỡi"` → `10000000`, …, `2500000` |
| Southern slang scales | `"hai trẹo"`, `"một chai"` → `2000000`, `1000000` (both = *triệu*) |
| Kinship titles | `"Anh Nam"` → `"Nam"` (title reported separately) |
| Domain synonyms | `"ghi nợ"` / `"bán chịu"` → `credit_sale` |
| Quantities | `"20 bao"`, `"25 ký"` → `qty 20 bao`, `qty 25 kg` |

## Usage

```python
from vietnamese_nlp import normalize

result = normalize("Anh Nam trả 10 triệu 500 nghìn tiền cám")
result.amount   # 10500000
result.text     # "Nam trả 10 triệu 500 nghìn tiền cám"
result.titles   # ("Anh",)
```

CLI:

```bash
PYTHONPATH=src python3 -m vietnamese_nlp "Anh Nam trả 10 triệu"
PYTHONPATH=src python3 -m vietnamese_nlp --pretty "Cô Ba mua 20 bao cám 25 ký, còn nợ 5 triệu"
echo "Bác Hai trả 2tr5" | PYTHONPATH=src python3 -m vietnamese_nlp
```

## Tests

```bash
PYTHONPATH=src python3 -m unittest discover -s tests
```

`pytest` also works if installed (`pythonpath` is configured in `pyproject.toml`).

To print the 3-region corpus accuracy and the unsupported-forms report:

```bash
PYTHONPATH=src python3 tests/test_dialect_set.py
```

## Safety contract

Money is **not** guessed. An amount is only emitted with strong evidence (a big
scale word, 4+ digits, or an explicit currency suffix). Bare word-numbers never
become money — `"Bác Hai"` yields no amount, and `"2 triệu 500"` is refused as
ambiguous rather than reported as `2000000`.

### Shape guards — looks numeric, is not money

The `4+ digits` rule is deliberately broad, so a few shapes are rejected before
an amount is emitted. Every one of them fails towards *no amount*: asking the
user is recoverable, writing a wrong payment is not.

| Input | Why it is not money |
|---|---|
| `"gọi anh Nam 0912345678"` | phone number (`0` + 9..11 digits) |
| `"tổng doanh thu 2024"` | bare 4-digit year 1900..2099 with no suffix |
| `"anh Nam ở nhà 1234"` | right after an identifier word (`nhà`, `mã số`, `số lượng`…) |
| `"mua 5 củ cải"` | `củ` is a tuber here, not *triệu* |
| `"mua 2 chai nước"` | `chai` is a bottle here, not *triệu* |

A suffix works with **or without** a space: `"2000 đ"` and `"2000đ"` both →
`2000`; so do `"5000vnd"`, `"500đồng"`, `"2tr5đ"`, `"230.000đ"`, `"1 500 000đ"`.
Because of the year guard a bare `"trả 2000"` is declined on purpose — write
`2000 đ` or `hai nghìn`.

Digit↔scale/suffix *runs* that money is never written as are refused rather
than merged: `"2tr5k"`, `"2tr50"`, `"2024năm"`, `"2024rưỡi"` → no amount
(the previous behaviour of `"2tr5k"` was a silent **2.500.000.000**).

Only *unambiguous* identifier words are guarded, so an ambiguous noun that is
also an ordinary word (``đơn``, ``bàn``, ``lô``…) is left alone:
`"mỗi đơn 5000"` (each order = 5000) still yields `5000`.

## HTTP bridge + copilot MCP server (wiring to dsh / Flutter)

The locked bridge decision is **local HTTP**: Node (dsh plugin / skill layer)
calls Python over `127.0.0.1` — no Dart/JS port.

```bash
# 1) Python NLP bridge (port 8787 by default, binds 127.0.0.1 only)
python3 -m nlp_service.server

# 2) Ask a question through the full pipeline (Phase 1 + Phase 2 over stdio,
#    mock ERPNext — no credentials, no LLM needed)
node scripts/ask-copilot.mjs "chị Lan còn nợ bao nhiêu"
# → ANSWER: Nguyễn Thị Lan còn nợ 2.500.000đ (1 hóa đơn chưa trả).

# 3) Register the copilot as an MCP server for dsh (Agent Runtime)
dsh web --patch mcp-erpnext/dsh.cordis.patch.yml
# the model then sees the tool: mcp__erpn_copilot__copilot_ask
```

Node tests (skill layer, mock server, copilot end-to-end — spawns the real
Python service):

```bash
cd mcp-erpnext && npm install && npm test
```

Verbatim transcripts of a full run: `result5.txt`.

## HTTP `/ask` endpoint (phone-facing, Phase 3)

The Flutter client speaks plain HTTP to the copilot pipeline:

```bash
# mock ERPNext (no credentials needed):
node mcp-erpnext/src/http-ask.mjs            # binds 127.0.0.1:8788

# REAL ERPNext — credentials come from .env (ERPNEXT_URL/ERPNEXT_API_KEY/ERPNEXT_API_SECRET):
set -a; source .env; set +a; node mcp-erpnext/src/http-ask.mjs

# phone on the LAN (operator decision — read-only but still our backend):
node mcp-erpnext/src/http-ask.mjs --host 0.0.0.0

curl -s http://127.0.0.1:8788/health
curl -s -X POST http://127.0.0.1:8788/ask \
  -H 'Content-Type: application/json' -d '{"text":"chị Lan còn nợ bao nhiêu"}'
```

Response shapes: `200 {ok:true,result:{answer,...}}` (answer is null when no
route/customer matches — the reason field explains why, the pipeline never
invents data), `400/500 {ok:false,error}`.

## Flutter client (apps/mobile, Phase 3)

```bash
export PATH="/google/flutter/bin:$PATH"
cd apps/mobile
flutter pub get && flutter analyze && flutter test

# run against a copilot on the LAN (default is 127.0.0.1:8788):
flutter run --dart-define=COPILOT_BASE_URL=http://<LAN-IP>:8788
```

Architecture: Riverpod (codegen) + GoRouter + feature-first
(`lib/features/chat/{data,application,presentation}`), design tokens in
`lib/app/theme/` + `openspec/config.yaml`.

### Android APK via GitHub Actions (never build on the dev VPS)

`.github/workflows/android-debug-apk.yml` runs on push/PR touching
`apps/mobile/**` and uploads the debug APK as artifact `erpn-chat-debug-apk`:

1. push this repo to GitHub
2. open the repo's **Actions** tab → workflow *android-debug-apk*
3. download artifact `erpn-chat-debug-apk` → install `app-debug.apk` on a phone

See `.plan/phases/phase-01-result.md` for the full accuracy report, `result2.txt`
for the follow-up fix, and the list of forms that are deliberately unsupported.
