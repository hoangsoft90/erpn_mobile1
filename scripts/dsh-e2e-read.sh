#!/usr/bin/env bash
# DSH READ E2E — `.plan/dsh_prompt_check.md` §9.
#
#   bash scripts/dsh-e2e-read.sh ["câu hỏi"]
#
# Proves the explicit opt-in agent path answers THROUGH the gateway: HTTP 200,
# mode=dsh, a non-empty answer, and one audit line for phase=dsh_ask. Run this
# only after scripts/check-dsh-runtime.sh is green — the question is real and it
# costs an LLM session.
#
# Safety: read-only by construction. The gateway pre-screens WRITE questions, so
# nothing this script sends can reach a write tool (see dsh-e2e-write-block.sh,
# which asserts exactly that).

set -uo pipefail
# shellcheck source=scripts/lib-dsh-e2e.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib-dsh-e2e.sh"

QUESTION="${1:-Khách smoke 2026-09-15-p1b-wf1-2 còn nợ bao nhiêu?}"

echo "== DSH READ E2E =="
info "endpoint: $ASK_BASE/dsh/ask"
info "question: $QUESTION"
info "audit: $AUDIT_LOG"

BEFORE="$(dsh_audit_count)"

START_MS=$(date +%s%3N)
BODY="$(curl "${curl_args[@]}" -X POST "$ASK_BASE/dsh/ask" \
  -d "$(node -e "process.stdout.write(JSON.stringify({message:process.argv[1]}))" "$QUESTION")" \
  -w '\n%{http_code}')"
END_MS=$(date +%s%3N)
ELAPSED_MS=$((END_MS - START_MS))

HTTP_CODE="$(printf '%s' "$BODY" | tail -1)"
JSON="$(printf '%s' "$BODY" | sed '$d')"

echo "--- response (http_code=$HTTP_CODE, elapsed=${ELAPSED_MS}ms) ---"
printf '%s\n' "$JSON" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{console.log(JSON.stringify(JSON.parse(s),null,1))}catch{console.log(s)}})"
echo '---'

MODE="$(json_field "$JSON" mode)"
ANSWER="$(node -e "try{const o=JSON.parse(process.argv[1]);process.stdout.write(o?.result?.answer??'')}catch(e){}" "$JSON" 2>/dev/null || true)"
TARGET="$(json_field "$JSON" erpnext_target)"
RUNTIME="$(json_field "$JSON" runtime)"
CODE="$(json_field "$JSON" code)"

AFTER="$(dsh_audit_count)"
NEW_LINES=$((AFTER - BEFORE))

[ "$HTTP_CODE" = "200" ] && pass "HTTP 200" || fail "HTTP $HTTP_CODE (expected 200)"
[ "$MODE" = "dsh" ] && pass "mode=dsh" || fail "mode='$MODE' (expected dsh)"
if [ -n "$ANSWER" ]; then
  pass "answer is non-empty (${#ANSWER} chars)"
  info "answer: $ANSWER"
else
  fail "answer is empty${CODE:+ (code=$CODE)}"
fi
if [ -n "$RUNTIME" ]; then
  pass "runtime=$RUNTIME (there is evidence for WHICH machine ran it)"
else
  fail "runtime missing from the response — a verification must say where it ran"
fi
if [ -n "$TARGET" ]; then
  pass "erpnext_target=$TARGET"
else
  info "erpnext_target not reported (the child may not have reached ERPNext)"
fi
[ "$NEW_LINES" -gt 0 ] && pass "audit: $NEW_LINES new dsh_ask line(s)" || fail "audit: no new dsh_ask line (the run left no evidence)"

finish
