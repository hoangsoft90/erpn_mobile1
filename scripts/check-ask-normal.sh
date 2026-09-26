#!/usr/bin/env bash
# NORMAL PATH REGRESSION — `.plan/dsh_prompt_check.md` §6/§9.
#
#   bash scripts/check-ask-normal.sh ["câu hỏi"]
#
# LAW (D2): the deterministic path owns every question the app sends; DSH is
# never its fallback. The unit tests assert this statically, but a static
# assertion cannot see a service that is already running. This script does: it
# counts dsh audit lines before and after a normal /ask, and requires the count
# to be UNCHANGED — evidence that the request never entered the agent path.

set -uo pipefail
# shellcheck source=scripts/lib-dsh-e2e.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib-dsh-e2e.sh"

QUESTION="${1:-Khách smoke 2026-09-15-p1b-wf1-2 còn nợ bao nhiêu?}"

echo "== NORMAL /ask REGRESSION =="
info "endpoint: $ASK_BASE/ask"
info "question: $QUESTION"
info "audit: $AUDIT_LOG"

# Without the audit file the "unchanged" assertion below is trivially true and
# proves nothing — say so instead of printing a green RESULT.
if dsh_audit_ready; then
  pass "audit file exists (the 0-delta assertion below can actually fail)"
else
  fail "audit file missing: $AUDIT_LOG — 'unchanged 0 → 0' would be a vacuous PASS, not evidence"
  info "start the gateway once (it creates the file) or point LEARNING_LOG_DIR at the right dir"
fi

BEFORE="$(dsh_audit_count)"

START_MS=$(date +%s%3N)
BODY="$(curl "${curl_args[@]}" -X POST "$ASK_BASE/ask" \
  -d "$(node -e "process.stdout.write(JSON.stringify({text:process.argv[1]}))" "$QUESTION")" \
  -w '\n%{http_code}')"
END_MS=$(date +%s%3N)
ELAPSED_MS=$((END_MS - START_MS))

HTTP_CODE="$(printf '%s' "$BODY" | tail -1)"
JSON="$(printf '%s' "$BODY" | sed '$d')"

echo "--- response (http_code=$HTTP_CODE, elapsed=${ELAPSED_MS}ms) ---"
printf '%s\n' "$JSON" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const o=JSON.parse(s);const r=o.result??o;console.log(JSON.stringify({ok:o.ok,mode:o.mode,answer:(r.answer??r.message??'').toString().slice(0,400)},null,1))}catch{console.log(s)}})"
echo '---'

AFTER="$(dsh_audit_count)"

[ "$HTTP_CODE" = "200" ] && pass "HTTP 200" || fail "HTTP $HTTP_CODE (expected 200)"
[ "$AFTER" -eq "$BEFORE" ] \
  && pass "dsh audit lines unchanged ($BEFORE → $AFTER) — /ask never spawned dsh" \
  || fail "dsh audit grew $BEFORE → $AFTER — /ask reached the agent path (D2 violation)"

finish
