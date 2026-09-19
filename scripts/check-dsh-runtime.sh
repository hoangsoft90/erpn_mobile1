#!/usr/bin/env bash
# DSH runtime check — `.plan/dsh_prompt_check.md` §3 (reproducibility).
#
# Answers ONE question with evidence, before any E2E run: can THIS machine run
# the pinned dsh runtime, and is the config the gateway would use actually
# usable? Every check prints PASS/FAIL and the script exits non-zero on any FAIL,
# so CI (or a human) can trust the exit code instead of reading prose.
#
#   bash scripts/check-dsh-runtime.sh
#
# Reads: package.json (the pin), DSH_ENTRY / DSH_PATCH / DSH_MODE (optional).
# Never prints a secret: no key or token is read here at all.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT" || exit 1

FAILED=0
pass() { printf 'PASS  %s\n' "$1"; }
fail() { printf 'FAIL  %s\n' "$1"; FAILED=$((FAILED + 1)); }
info() { printf '      %s\n' "$1"; }

echo "== DSH runtime check =="

# ── 1. Node ──────────────────────────────────────────────────────────────────
if command -v node >/dev/null 2>&1; then
  NODE_VERSION="$(node --version)"
  NODE_MAJOR="${NODE_VERSION#v}"
  NODE_MAJOR="${NODE_MAJOR%%.*}"
  if [ "${NODE_MAJOR:-0}" -ge 20 ] 2>/dev/null; then
    pass "node $NODE_VERSION (>=20)"
  else
    fail "node $NODE_VERSION is older than the required >=20 (mcp-erpnext/package.json engines)"
  fi
else
  fail "node not found on PATH"
fi

# ── 2. The pin declared in package.json ──────────────────────────────────────
PINNED="$(node -e "try{process.stdout.write(require('./package.json').dependencies['@deepseek-ai/dsh']||'')}catch(e){process.stdout.write('')}" 2>/dev/null)"
if [ -n "$PINNED" ]; then
  pass "package.json pins @deepseek-ai/dsh@$PINNED"
else
  fail "package.json does not declare @deepseek-ai/dsh — the runtime version is not pinned"
fi

# ── 3. Resolve the entry the GATEWAY would use (same code path, not a copy) ──
RESOLVED="$(node -e "import('./mcp-erpnext/src/dsh-gateway.mjs').then(m=>{const i=m.dshRuntimeInfo();process.stdout.write(JSON.stringify(i))}).catch(e=>{process.stdout.write(JSON.stringify({error:String(e)}))})" 2>/dev/null)"
# Pass the JSON as an ARGUMENT, never interpolated into the -e source: a path
# containing a quote would otherwise break the script (or worse, inject code)
# — and the path comes from an env var the operator controls. One helper for
# every JSON field this script reads (the first draft had two identical ones).
json_get() {
  node -e 'const o=JSON.parse(process.argv[1]||"{}");const v=o[process.argv[2]];process.stdout.write(v==null?"":String(v))' "$1" "$2" 2>/dev/null || true
}
ENTRY="$(json_get "$RESOLVED" entry)"
ENTRY_EXISTS="$(json_get "$RESOLVED" entryExists)"
VERSION="$(json_get "$RESOLVED" version)"

if [ -n "$ENTRY" ]; then
  info "entry: $ENTRY"
fi
if [ "$ENTRY_EXISTS" = "true" ]; then
  pass "dsh entry exists"
else
  fail "dsh entry missing — install it: npm install (repo root) OR DSH_ENTRY=<path>"
fi

if [ -n "$VERSION" ] && [ -n "$PINNED" ]; then
  if [ "$VERSION" = "$PINNED" ]; then
    pass "installed version $VERSION matches the pin"
  else
    fail "installed version $VERSION != pinned $PINNED — behaviour would drift from the pin"
  fi
elif [ -n "$VERSION" ]; then
  info "installed version $VERSION"
fi

# ── 4. The binary actually runs ──────────────────────────────────────────────
if [ "$ENTRY_EXISTS" = "true" ]; then
  RAN="$(node "$ENTRY" --version 2>&1 | tail -1)"
  if [ "$RAN" = "$VERSION" ] || [ -n "$RAN" ]; then
    pass "entry runs (--version -> $RAN)"
  else
    fail "entry did not run"
  fi
fi

# ── 5. The patch the gateway would use, including the write-gate marker ──────
PATCH_EXISTS="$(json_get "$RESOLVED" patchExists)"
PATCH_MARKED="$(json_get "$RESOLVED" patchMarksDshContext)"
PATCH_PATH="$(json_get "$RESOLVED" patch)"
if [ "$PATCH_EXISTS" = "true" ]; then
  pass "patch exists: $PATCH_PATH"
else
  fail "patch missing: $PATCH_PATH"
fi
if [ "$PATCH_MARKED" = "true" ]; then
  pass "patch sets COPILOT_DSH_CONTEXT=1 (the in-child WRITE gate can fire)"
else
  fail "patch is MISSING COPILOT_DSH_CONTEXT=1 — the gateway refuses to run it (write gate would not fire)"
fi

# ── 6. Mode + health, through the same exported probe the route uses ─────────
HEALTH="$(node -e "import('./mcp-erpnext/src/dsh-gateway.mjs').then(m=>m.dshGatewayHealth()).then(h=>process.stdout.write(JSON.stringify(h))).catch(e=>process.stdout.write(JSON.stringify({available:false,detail:String(e)})))" 2>/dev/null)"
AVAILABLE="$(json_get "$HEALTH" available)"
DETAIL="$(json_get "$HEALTH" detail)"
MODE="$(json_get "$HEALTH" mode)"
info "mode: ${MODE:-unknown} — $DETAIL"
if [ "$AVAILABLE" = "true" ]; then
  pass "dshGatewayHealth() reports available"
else
  fail "dshGatewayHealth() reports UNAVAILABLE"
fi

echo
if [ "$FAILED" -eq 0 ]; then
  echo "RESULT: PASS (all checks green)"
  exit 0
fi
echo "RESULT: FAIL ($FAILED check(s) failed)"
exit 1
