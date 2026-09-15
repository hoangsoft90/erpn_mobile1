# LOCAL-TEST — quy trình test local đã chốt (3 terminal)

> **KHÔNG BAO GIỜ** ghi giá trị thật của `ERPNEXT_API_KEY` / `ERPNEXT_API_SECRET` vào
> file này, git, hay log. Khi chạy, thay `<key>` / `<secret>` bằng giá trị thật từ
> `.env` ở repo root (file đó git-ignored). Tài liệu chỉ tham chiếu **tên biến**.

## Thành phần & cổng

| Thành phần | Lệnh | Cổng | Tín hiệu sẵn sàng (stdout) |
|---|---|---|---|
| nlp_service (Python, vietnamese_nlp) | `python3 -m nlp_service.server` | 8787 | `{"ready": true, "port": 8787}` |
| http-ask (Node, copilot HTTP) | `npm run start:ask` ( = `node src/http-ask.mjs --port 8788`) | 8788 | `{"ready":true,"port":8788,"host":"127.0.0.1","auth":false}` |
| localtunnel | `lt -s erpn8788 --port 8788` | — | `your url is: https://erpn8788.loca.lt` |

- http-ask mặc định bind `127.0.0.1` → **không cần auth** trong recipe này (bind loopback
  kèm `ASK_USER`/`ASK_PASSWORD` bị code từ chối start — đúng thiết kế).
- Target ERPNext chọn theo env: đủ cả 3 biến `ERPNEXT_URL` / `ERPNEXT_API_KEY` /
  `ERPNEXT_API_SECRET` → ERPNext thật; thiếu hoàn toàn → mock; **thiếu một phần → lỗi
  ngay khi start** (không bao giờ fallback âm thầm).

## Terminal 1 — NLP service (chạy từ repo root)

```bash
python3 -m nlp_service.server
```

Chờ dòng: `{"ready": true, "port": 8787}`

## Terminal 2 — http-ask (chạy từ thư mục `mcp-erpnext/`)

```bash
cd mcp-erpnext
export ERPNEXT_URL="https://<erpnext-host>"      # ví dụ host ngrok của ERPNext
export ERPNEXT_API_KEY="<key>"
export ERPNEXT_API_SECRET="<secret>"
npm run start:ask
```

Chờ dòng: `{"ready":true,"port":8788,"host":"127.0.0.1","auth":false}`

## Verify LOCAL trước khi mở tunnel

```bash
curl -s http://127.0.0.1:8788/health
# → {"ok":true,"service":"copilot-ask","port":8788}

curl -s -X POST http://127.0.0.1:8788/ask \
  -H "Content-Type: application/json" \
  -d '{"text":"chị Lan còn nợ bao nhiêu"}'
# → {"ok":true,"result":{...,"answer":"...còn nợ <số>đ..."}}
```

## Terminal 3 — tunnel

> Nếu `lt` chưa có trên máy: `npm i -g localtunnel`

```bash
lt -s erpn8788 --port 8788
```

> **Tunnel không bắt buộc chạy cùng máy với http-ask** (verify 2026-09-14: user chạy `lt`
> trên máy Mac, vẫn trỏ được vào http-ask trên VPS miễn máy chạy `lt` với tới được
> service — ví dụ qua SSH port-forward). localtunnel mặc định forward tới `localhost`
> của máy chạy `lt`; nếu service ở máy khác, đưa service tới `localhost` của máy đó
> (SSH -L) hoặc dùng `--local-host`.

Chờ dòng: `your url is: https://erpn8788.loca.lt`

## Verify qua tunnel

```bash
curl -s -H "bypass-tunnel-reminder: 1" https://erpn8788.loca.lt/health

curl -s -X POST https://erpn8788.loca.lt/ask \
  -H "bypass-tunnel-reminder: 1" \
  -H "Content-Type: application/json" \
  -d '{"text":"chị Lan còn nợ bao nhiêu"}'
```

- Header `bypass-tunnel-reminder` bỏ trang reminder của localtunnel (trình duyệt luôn gặp;
  một số deploy cũng chặn request không header này). Nếu Flutter qua tunnel nhận về HTML
  reminder thay vì JSON — đó là trang này, không phải lỗi pipeline.

## Thứ tự chạy (bắt buộc, không đảo)

1. Terminal 1 sẵn sàng (`{"ready": true, "port": 8787}`)
2. Terminal 2 sẵn sàng (`{"ready":true,...,"auth":false}`)
3. `curl` local: `/health` + `/ask` đều OK
4. Mở tunnel (Terminal 3)
5. `curl` qua tunnel OK
6. **Sau đó** mới chạy Flutter, ví dụ:
   `flutter run --dart-define=COPILOT_BASE_URL=https://erpn8788.loca.lt`

## Lưu ý an toàn (không bỏ qua)

- URL tunnel là **public** và recipe này chạy http-ask **không có HTTP auth** (bind
  loopback). Trong lúc tunnel sống, dữ liệu thật (tên khách, số tiền công nợ) đi qua nó —
  **Ctrl-C đóng tunnel ngay khi test xong**, không để `erpn8788.loca.lt` chạy unattended.
- Subdomain `erpn8788` là đoán được → ai biết URL đều chạm được endpoint trong lúc tunnel mở.
- URL tunnel CÓ THỂ dùng làm `COPILOT_BASE_URL` cho APK test thiết bị thật (HTTPS, đi qua
  được firewall) — nhưng chỉ trong lúc test, không phải endpoint lâu dài; fix dài hạn:
  Phase 5 gateway / bind Tailscale (xem `SIGNOFF-phase5-pii.md`, `result11.txt` §5).
