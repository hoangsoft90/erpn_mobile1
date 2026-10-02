#!/usr/bin/env bash
# Shared helpers for the DSH E2E scripts (`npm run dsh:e2e:*`).
#
# Every script below follows the same law as the project's own rules: a claim is
# only PASS with a command and its real output, and no script ever prints a
# credential. Tokens/passwords are read from the environment and only ever
# referenced by name.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ASK_BASE="${COPILOT_BASE_URL:-http://127.0.0.1:8788}"
ASK_BASE="${ASK_BASE%/}"
AUDIT_LOG="${LEARNING_LOG_DIR:-$REPO_ROOT/learning-log}/observations.jsonl"

pass() { printf 'PASS  %s\n' "$1"; }
fail() { printf 'FAIL  %s\n' "$1"; FAILED=$((FAILED + 1)); }
info() { printf '      %s\n' "$1"; }
FAILED=0

# Basic auth is only needed on a non-loopback bind (ASK_USER/ASK_PASSWORD).
# Never echo the value; only whether an Authorization header is being sent.
curl_args=(-sS -m "${DSH_E2E_TIMEOUT:-240}" -H "content-type: application/json")
if [ -n "${ASK_USER:-}" ] && [ -n "${ASK_PASSWORD:-}" ]; then
  curl_args+=(-u "${ASK_USER}:${ASK_PASSWORD}")
  info "auth: basic (ASK_USER/ASK_PASSWORD present)"
else
  info "auth: none (loopback bind)"
fi

# dsh audit lines are the write path's evidence. Count only phase=dsh_ask rows.
#
# A MISSING file must never be silently reported as "0 lines, unchanged": a
# delta of 0 → 0 is then TRUE for a service that wrote nowhere, which is the
# vacuous-PASS class of bug this project has already been bitten by twice
# (result56 §5a, result58 §11-L2). Callers assert dsh_audit_ready() first.
dsh_audit_ready() { [ -f "$AUDIT_LOG" ]; }
dsh_audit_count() {
  if [ ! -f "$AUDIT_LOG" ]; then
    echo 0
    return 1
  fi
  grep -c '"phase":"dsh_ask"' "$AUDIT_LOG" 2>/dev/null || true
}

json_field() {
  # json_field <json> <field> — prints the value or empty; never fails the script.
  node -e "const o=JSON.parse(process.argv[1]||'{}');const v=o[process.argv[2]];process.stdout.write(v==null?'':String(v))" "$1" "$2" 2>/dev/null || true
}

finish() {
  echo
  if [ "$FAILED" -eq 0 ]; then
    echo "RESULT: PASS (all assertions green)"
    exit 0
  fi
  echo "RESULT: FAIL ($FAILED assertion(s) failed)"
  exit 1
}
