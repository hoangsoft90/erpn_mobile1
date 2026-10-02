#!/usr/bin/env bash
# DSH WRITE BLOCK E2E — `.plan/dsh_prompt_check.md` §9.
#
#   bash scripts/dsh-e2e-write-block.sh ["câu lệnh ghi"]
#
# THE safety assertion of the DSH path: a write-shaped question sent to the
# opt-in agent route must come back refused (DSH_WRITE_BLOCKED) in a fraction of
# a second — and that timing is itself the proof it never spawned a session
# (a real session through the tunnel takes tens of seconds). Also asserts NO
# proposal and NO execute line in the audit trail, so "refused" cannot be
# mistaken for "refused after doing something".

set -uo pipefail
# shellcheck source=scripts/lib-dsh-e2e.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib-dsh-e2e.sh"

QUESTION="${1:-thu tiền cho chị Lan 50 nghìn}"

# A refusal that takes longer than this is not a pre-screen refusal.
SPAWN_THRESHOLD_MS="${DSH_SPAWN_THRESHOLD_MS:-5000}"

echo "== DSH WRITE BLOCK E2E =="
info "endpoint: $ASK_BASE/dsh/ask"
info "question: $QUESTION"
info "audit: $AUDIT_LOG"

# The "no new write" assertions below are deltas on this file: if it is missing
# they are trivially true (vacuous PASS). Assert its presence FIRST.
if dsh_audit_ready; then
  pass "audit file exists (the write-delta assertions below can actually fail)"
else
  fail "audit file missing: $AUDIT_LOG — 'no new proposal/execute' would be a vacuous PASS"
  info "start the gateway once (it creates the file) or point LEARNING_LOG_DIR at the right dir"
fi

PROPOSALS_BEFORE=$( [ -f "$AUDIT_LOG" ] && grep -c '"has_proposal":true' "$AUDIT_LOG" 2>/dev/null || echo 0 )
EXECUTE_BEFORE=$( [ -f "$AUDIT_LOG" ] && grep -c '"phase":"execute"' "$AUDIT_LOG" 2>/dev/null || echo 0 )

START_MS=$(date +%s%3N)
BODY="$(curl "${curl_args[@]}" -X POST "$ASK_BASE/dsh/ask" \
  -d "$(node -e "process.stdout.write(JSON.stringify({message:process.argv[1]}))" "$QUESTION")" \
  -w '\n%{http_code}')"
END_MS=$(date +%s%3N)
ELAPSED_MS=$((END_MS - START_MS))

HTTP_CODE="$(printf '%s' "$BODY" | tail -1)"
JSON="$(printf '%s' "$BODY" | sed '$d')"
CODE="$(json_field "$JSON" code)"

echo "--- response (http_code=$HTTP_CODE, elapsed=${ELAPSED_MS}ms) ---"
printf '%s\n' "$JSON" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{console.log(JSON.stringify(JSON.parse(s),null,1))}catch{console.log(s)}})"
echo '---'

[ "$CODE" = "DSH_WRITE_BLOCKED" ] && pass "code=DSH_WRITE_BLOCKED" || fail "code='$CODE' (expected DSH_WRITE_BLOCKED)"
if [ "$ELAPSED_MS" -lt "$SPAWN_THRESHOLD_MS" ]; then
  pass "refused in ${ELAPSED_MS}ms (< ${SPAWN_THRESHOLD_MS}ms ⇒ no dsh session was spawned)"
else
  fail "took ${ELAPSED_MS}ms — too slow for a pre-screen refusal; a session may have started"
fi

PROPOSALS_AFTER=$( [ -f "$AUDIT_LOG" ] && grep -c '"has_proposal":true' "$AUDIT_LOG" 2>/dev/null || echo 0 )
EXECUTE_AFTER=$( [ -f "$AUDIT_LOG" ] && grep -c '"phase":"execute"' "$AUDIT_LOG" 2>/dev/null || echo 0 )

[ "$PROPOSALS_AFTER" -eq "$PROPOSALS_BEFORE" ] && pass "audit: no new proposal ($PROPOSALS_BEFORE → $PROPOSALS_AFTER)" || fail "a proposal appeared during a refused write"
[ "$EXECUTE_AFTER" -eq "$EXECUTE_BEFORE" ] && pass "audit: no new execute ($EXECUTE_BEFORE → $EXECUTE_AFTER)" || fail "an execute line appeared during a refused write"

finish
