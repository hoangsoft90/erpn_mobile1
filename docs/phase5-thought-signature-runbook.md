# Runbook — Verify `thought_signature` LIVE với Gemini thật (1 lần duy nhất)

> Mục đích: đóng nốt việc còn lại của Phase 5 — xác nhận `ThoughtSignatureCache`
> trong `scripts/llm-router.mjs` chạy đúng với provider THẬT, tức **turn replay
> tool** (turn thứ hai trở đi, có kết quả tool trong `messages`) nhận 200 thay vì
> `400 Function call is missing a thought_signature`.
>
> Đã thất bại 4 lần liên tiếp (result17/18/19/22) — **tất cả vì quota**, không phải
> vì logic. Bằng chứng hiện có: hermetic (router 19/19, gồm 1 test integration
> SSE → inject). Runbook này để lần chạy tốn quota không bị lãng phí.

## Mốc thời gian — ĐỒNG HỒ VPS LÀ UTC (đừng trộn với "giờ VN" trong docs)

- `date -u` và `date` trên VPS trả **cùng giá trị** ⇒ TZ của máy = UTC.
- **Tên file audit dùng UTC** (`audit-2026-09-15T13-46-29.jsonl` = 13:46 **UTC**),
  còn chú thích "giờ VN" trong result*.txt là agent tự **+7**. So khớp phải quy về UTC.
- Mốc reset quota = **07:00 UTC = 14:00 giờ VN**.

## 0. Điều kiện tiên quyết (kiểm TRƯỚC, không tốn quota)

```bash
# 1) Tunnel Mac phải sống (upstream real-gemini KHÔNG cần tunnel, nhưng phiên dsh cần
#    nlp_service + router; giữ nguyên thói quen kiểm tra)
ls /tmp/dsh-run/node_modules/@deepseek-ai/dsh/lib/bin.js \
  || (mkdir -p /tmp/dsh-run && cd /tmp/dsh-run && npm i @deepseek-ai/dsh)
# 2) ERPNext thật sống (patch E2E_TARGET=real)
curl -sS -o /dev/null -w "ERPNext: %{http_code}\n" -m 15 "$(grep -E '^ERPNEXT_URL=' .env | cut -d= -f2-)"
# 3) Config hợp lệ (0 quota)
node -e "import('./scripts/llm-router.mjs').then(m=>{const c=m.loadConfig('scripts/llm-router.e2e.json');console.log('upstreams:',c.upstreams.map(u=>u.name+':'+(u.model??'*')+(u.geminiThoughtSignatures?'+sig':'')).join(' , '))})"
```

## 1. Chạy đúng 1 session (không probe, không retry)

> ⚠️ **KHÔNG export `LLM_ROUTER_AUDIT_DIR` vào /tmp** — /tmp trên host này là
> overlayfs ephemeral, host là container Google Cloud Shell (restart = mất sạch;
> phiên result17 đã dính: `LLM_ROUTER_AUDIT_DIR=/tmp/audit17`, result17.txt:40).
> Giữ default (repo `llm-router-audit/`, đã gitignore) là đúng.

```bash
cd <repo-root>
fuser -k 8787/tcp 8900/tcp 2>/dev/null; sleep 1
setsid python3 -m nlp_service.server --port 8787 > /tmp/sig-nlp.log 2>&1 < /dev/null &
sleep 2; curl -s -m 5 -o /dev/null -w "nlp :8787 → %{http_code}\n" http://127.0.0.1:8787/health

{ set -a; source .env; set +a; }                     # KHÔNG in giá trị key ra đâu
setsid env LLM_ROUTER_DEBUG=1 node scripts/llm-router.mjs \
  --config scripts/llm-router.e2e.json > /tmp/sig-router.log 2>&1 < /dev/null &
sleep 3; curl -s -m 5 -o /dev/null -w "router :8900 → %{http_code}\n" http://127.0.0.1:8900/health

# GHI LẠI THỜI ĐIỂM để sau này chọn đúng file audit:
date -u "+phiên bắt đầu: %Y-%m-%dT%H:%M:%SZ"

DSH_HOME=/tmp/dsh-home-sig-$(date +%s) DSH_TELEMETRY_MODE=DISABLED \
  E2E_TARGET=real E2E_LLM_MODEL=real-gemini \
  timeout 300 node /tmp/dsh-run/node_modules/@deepseek-ai/dsh/lib/bin.js \
  --profile headless --patch mcp-erpnext/dsh-e2e.patch.yml \
  "Khách làm tròn 2026-09-15-p1b-wf1-2 còn nợ bao nhiêu?" \
  > /tmp/sig-dsh.out 2>&1
echo "=== dsh exit=$?"
grep -vE "^\[mcp-erpnext\]" /tmp/sig-dsh.out | tail -12
fuser -k 8787/tcp 8900/tcp 2>/dev/null
```

**Câu hỏi dùng 1 khách** là đủ: turn 1 (chọn tool) + turn 2 (**replay tool**). Turn
replay mới là thứ cần verify — không cần câu 2 khách như lần mac-custom.

## 2. Bằng chứng phải lấy — **DÁN NGUYÊN DÒNG**, đừng chỉ trỏ tên file

> ⚠️ **Audit có thể biến mất** (result22 §9C: 117 file → 24 file trong cùng ngày;
> nguyên nhân đã xác minh: có phiên set `LLM_ROUTER_AUDIT_DIR=/tmp/audit17` và /tmp
> là overlayfs ephemeral — container restart xoá sạch; router KHÔNG có code xoá,
> chỉ `appendFileSync`) ⇒ một tên file trong result có thể biến mất trước khi ai đó
> cần đối chiếu. **Tên file KHÔNG phải bằng chứng** — dòng JSON mới là.

**Lấy đường dẫn audit TỪ READY LINE** (in lúc router khởi động — không dùng `ls -t`, dễ lấy nhầm file của phiên khác):
```bash
grep -o '"audit":"[^"]*"' /tmp/sig-router.log | tail -1     # {"audit":"..."} 
```

**Dán output này vào `resultNN.txt`** (cả đường dẫn, cả các dòng):
```bash
AUD=$(grep -o '"audit":"[^"]*"' /tmp/sig-router.log | tail -1 | cut -d'"' -f4)
echo "AUDIT FILE: $AUD"
cat "$AUD"                                        # ← DÁN NGUYÊN CÁC DÒNG NÀY vào result
python3 -c "
import json,collections
rows=[json.loads(l) for l in open('$AUD') if l.strip().startswith('{')]
print('status  :',dict(collections.Counter(r.get('status') for r in rows)))
print('model   :',{r.get('model') for r in rows})
print('attempts:',collections.Counter(tuple(r.get('attempts') or ['<none>']) for r in rows))
print('turns   :',[(r.get('ts'),r.get('messages'),r.get('status')) for r in rows])
"
# log router: BẮT BUỘC paste cùng (đây mới là chỗ thấy 400/status thật của provider)
grep -E "llm-router\]\[debug\]" /tmp/sig-router.log | tail -20
```

### Định nghĩa XANH (cả 4 phải đúng — thiếu 1 là CHƯA verify)
1. `dsh exit=0` và câu trả lời có số tiền đúng ground truth (**457.875đ**).
2. **Có thật sự một turn replay**: audit phải có **≥2 turn cho agent** (chuỗi
   `messages` tăng, vd 2 → 5 → 7). Nếu audit chỉ có `messages:2` (chỉ 1 turn) thì
   **phiên đó KHÔNG kiểm gì cả** — ghi là "INVALID: không có tool call", KHÔNG ghi xanh.
3. **Đúng upstream**: `attempts` của các turn agent phải là `['gemini-openai']` và
   `model='gemini-3.6-flash'`. ⚠️ Kiểm `attempts` chứ không chỉ `model`: upstream có
   wildcard (mock không khai `model`) vẫn có thể phục vụ request — result20 §9B là
   ca có audit `attempts=['mock']` khiến attribution bị sai.
4. **Turn replay có status 200** và KHÔNG có `400 ... missing a thought_signature`
   trong log router.

> Lưu ý về "bằng chứng capture signature": router **không log** việc capture/inject
> (chỉ có debug `reqHead` 300 byte đầu + `status`/`body0` khi lỗi). Vì vậy đừng lấy
> grep log làm bằng chứng capture — **bằng chứng quyết định là turn replay trả 200**:
> nếu signature không được chèn lại, Gemini trả 400 như đã tái hiện ở result17 §L.
> (Muốn bằng chứng trực tiếp từng bước thì phải thêm log vào router — việc đó làm
> SAU, và phải review lại vì đụng đường đang verify.)

## 3. Nếu ĐỎ — đọc đúng loại lỗi rồi DỪNG (không retry trong ngày)

| Hiện tượng | Nghĩa là | Hành động |
|---|---|---|
| Provider **429** `generate_content_free_tier_requests, limit: 20` | Hết quota ngày (key dùng CHUNG, có thể bị tiêu bởi traffic khác — xem §4) | **DỪNG hết**, chờ mốc reset kế tiếp. Không probe "cho chắc" |
| Provider **503 high-demand** ở vài turn nhưng vẫn có turn 200 | Bình thường với free tier | Chỉ tính là đỏ nếu turn replay KHÔNG lần nào 200 |
| `400 ... missing a thought_signature` | **Logic gateway chưa đúng** — đây mới là bug thật cần sửa | Lưu nguyên văn payload + ghi `resultNN`: đây là bằng chứng chống lại fix hiện tại |
| `400` có body khác (field lạ) | Field OpenAI-only lọt qua `stripFields` | Thêm field vào `stripFields` của upstream gemini-openai |
| `502 llm_router_all_failed` + `attempts=[]` | Lỗi cooldown/router (đã fix từ result17) — nếu tái xuất thì là hồi quy | Báo rõ là hồi quy router, kèm audit |
| Mac tunnel 408/503 | Không liên quan — real-gemini không đi qua tunnel Mac | Bỏ qua, không tính là đỏ |
| Audit KHÔNG có dòng nào (dù dsh chạy) | Router ghi sai chỗ (`LLM_ROUTER_AUDIT_DIR`) hoặc bị dọn sau khi ghi | Đọc lại ready line để lấy đúng đường dẫn; lần sau lấy audit NGAY trong cùng block |
| Audit chỉ có 1 turn (`messages:2`) | Model trả lời luôn, KHÔNG gọi tool ⇒ chưa chạm turn replay | **INVALID** (không phải đỏ, không phải xanh): ghi rõ "không có tool call"; lần sau siết prompt cho chắc có tool (vd thêm "dùng công cụ copilot_ask") |

## 4. Vì sao KHÔNG đếm quota trước khi chạy (bài học đã trả giá)

- Đếm `status 200` **sai** (result19): lần chạy "8 < 20" vẫn 7×429.
- Audit **không phải sổ quota**: hôm nay (từ 07:00Z) audit chỉ ghi **7 request tới
  gemini** mà **request ĐẦU TIÊN đã 429** ⇒ quota bị tiêu bởi traffic không thấy
  trong audit. `GEMINI_API_KEY` là key dùng chung — đừng giả định "ngay sau reset
  là chắc chắn có quota".
- Vì vậy: chạy 1 session, và **việc verify quan trọng phải là request ĐẦU TIÊN**
  của phiên (đừng để nó thành request thứ N sau test/debug).
- Mốc reset đã xác nhận bởi doc Google: *"Requests per day (RPD) quotas reset at
  midnight Pacific time"* = **07:00 UTC = 14:00 giờ VN**.

## 5. Sau khi XANH

- Ghi `resultNN.txt`: audit file name + chuỗi turn + câu trả lời; cập nhật
  `checklist.md` / `next.md` / `working.md` (đóng mục "thought_signature chưa verify
  live") + skill `erpn-dsh-setup` (đổi dòng "CONTEXT_WINDOW_EXCEEDED" từ "đã fix
  hermetic" sang "đã verify live").
- Đây là **điều kiện cuối** của Phase 5 phần gateway; sau đó Phase 5 coi như đóng
  phần kỹ thuật (còn lại là các quyết định của user: endpoint lâu dài, Zen...).
