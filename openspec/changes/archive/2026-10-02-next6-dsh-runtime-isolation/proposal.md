## Why

NEXT6 P0 (`.plan/next6/P0-result.md`) chứng minh bằng SOURCE của dsh (`dsh-agent-instructions`,
bật mặc định qua `dsh-base/cordis.patch.yml`) + bằng chứng thực nghiệm (`mock-llm.mjs`: "verified bug
in run #2 — 45k of instructions"): child dsh chạy với `cwd = REPO_ROOT` nên tự discover chuỗi
`AGENTS.md` + `CLAUDE.md` của workspace dev và inject nguyên văn (~57KB) vào model dưới dạng
user-role `<system-reminder>`. Hậu quả đo được trên log thật: `dsh_ask answered` với câu lạc đề
("anh khánh", "hôm nay mưa hay nắng") — model trả lời như một trợ lý lập trình thay vì trợ lý
tra cứu ERPNext. Đây là rò rỉ context dev RA NGOÀI (dev instructions → LLM third-party) và là
nguy cơ persona sai cho người dùng cuối (chủ tiệm cám).

Ngoài ra Lớp 1 (code gate) trước đây chỉ chặn WRITE (`payment_write`) — câu hỏi off-topic rõ ràng
không bị chặn ở bất kỳ lớp nào trước khi tới LLM.

## What Changes

- **Runtime isolation (P1)**: `dsh-gateway.mjs` không còn default `cwd = REPO_ROOT` — dùng
  `DSH_CWD` từ env, fallback `tmpdir()/dsh-gw-cwd` (tạo on demand). Hai patch YAML nhận vị trí
  TUYỆT ĐỐI qua env `ERPN_REPO_ROOT` / `ERPN_COPILOT_SERVER` (fallback `process.cwd()` cho chạy
  tay từ repo root) để `copilot_ask` vẫn gọi ERPNext thật dưới mọi cwd. `DSH_ROUTER_CREDENTIAL`
  (placeholder KHÔNG bí mật — router tự thay Authorization per-upstream) thay `GEMINI_API_KEY`
  trong route config để dsh boot được mà không nạp `.env` repo (secret vẫn bị strip bởi
  `DSH_SECRET_ENV_KEYS`).
- **Poison/sentinel test (P1, bằng chứng 2 vế)**: đặt sentinel tạm vào `AGENTS.md`/`working.md`/
  `operating_rules.md` → config cũ echo `PROBE_SENTINEL=LEAK` (chars 104472) → config mới
  `PROBE_SENTINEL=NO_LEAK` (chars 52248). Vế 2: `/dsh/ask` vẫn trả câu trả lời ERPNext thật
  (`erp_target=REAL`) sau khi đổi cwd. Sentinel đã hoàn tác sạch.
- **Lớp 2 — code gate mở rộng (P2)**: `dshQuestionGate()` chặn off-topic rõ ràng
  (`DSH_OFF_TOPIC`, deny-list fold dấu tiếng Việt, chỉ áp cho câu router KHÔNG nhận diện) và
  trả câu cố định cho "ERPNext là gì?" (`DSH_META_INFO`). "anh khánh" (entity-shaped) ĐƯỢC đi
  qua — resolver giữ trách nhiệm MISSING_ENTITY, không refuse cứng.
- **Lớp 2b — system boundary thật (P3)**: dsh CÓ lớp system thật (`@deepseek-ai/dsh-system-prompt`,
  row `system-prompt`, `personaPrefix`). Đã thêm row vào patch với ranh giới phạm vi ERP +
  marker `ERP_BOUNDARY_V1`; probe xác nhận `PROBE_BOUNDARY=FOUND` trên message `role=system`.
  Đây là DEFENCE IN DEPTH — ranh giới chính vẫn là code gate (Lớp 2) vì workspace AGENTS.md
  inject ở user-role nên KHÔNG override được system prompt.
- **Untrusted data (P4, audit-only)**: nguyên tắc "dữ liệu ERPNext = untrusted" đã hiện thực
  sẵn ở `src/untrusted-data.mjs` (nối vào copilot-server dùng chung child của `/dsh/ask`);
  test `3/3` gồm "customer named with an injection cannot trigger a WRITE" — không cần sửa.

## Capabilities

### New Capabilities
(không có — không mở capability mới)

### Modified Capabilities
- `session-isolation` (delta): runtime của child dsh tách khỏi workspace dev (cwd cô lập,
  không auto-discover AGENTS.md/CLAUDE.md); câu hỏi off-topic rõ ràng bị chặn BY CODE trước
  LLM; lớp system prompt của dsh mang ranh giới phạm vi ERP.

## Impact

- **Code**: `mcp-erpnext/src/dsh-gateway.mjs` (cwd default + env cấp path tuyệt đối + credential
  placeholder + gate mở rộng) · `mcp-erpnext/dsh-e2e.patch.yml` + `dsh.cordis.patch.yml`
  (path/env/system-prompt row) · `scripts/probe-llm.mjs` (mới — probe tất định 0-quota).
- **Env**: `.env` thêm `DSH_CWD` + `DSH_ROUTER_CREDENTIAL` (không commit — `.env` gitignored).
- **Tests**: `test/dsh-gateway.test.mjs` +5 test gate (52/52; falsify gỡ nhánh ⇒ đúng 5 test
  off-topic đỏ) · full `mcp-erpnext` 859/859.
- **Chưa làm (cần LLM thật / GHI ERPNext)**: 3 dòng P5 cần entity-resolver thật ("anh khánh",
  "công nợ khách Anh Khánh", "cám heo tồn bao nhiêu"); P4 live test ghi note injection lên
  khách probe trên ERPNext thật — chờ duyệt vì là GHI production.
