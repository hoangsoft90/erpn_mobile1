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
warn() { printf 'WARN  %s\n' "$1"; }
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

# ── 3. Resolve the runtime the GATEWAY would use (same code path, not a copy) ──
RESOLVED="$(node -e "import('./mcp-erpnext/src/dsh-gateway.mjs').then(m=>{const i=m.dshRuntimeInfo();process.stdout.write(JSON.stringify(i))}).catch(e=>{process.stdout.write(JSON.stringify({error:String(e)}))})" 2>/dev/null)"
# Pass the JSON as an ARGUMENT, never interpolated into the -e source: a path
# containing a quote would otherwise break the script (or worse, inject code)
# — and the path comes from an env var the operator controls. One helper for
# every JSON field this script reads (the first draft had two identical ones).
json_get() {
  node -e 'const o=JSON.parse(process.argv[1]||"{}");const v=o[process.argv[2]];process.stdout.write(v==null?"":String(v))' "$1" "$2" 2>/dev/null || true
}
MODE="$(json_get "$RESOLVED" mode)"
RUNTIME="$(json_get "$RESOLVED" runtime)"
SOURCE="$(json_get "$RESOLVED" source)"
ENTRY="$(json_get "$RESOLVED" entry)"
COMMAND="$(json_get "$RESOLVED" command)"
ARGS="$(json_get "$RESOLVED" args)"
ENTRY_EXISTS="$(json_get "$RESOLVED" entryExists)"
VERSION="$(json_get "$RESOLVED" version)"

if [ "$MODE" = "unavailable" ]; then
  fail "no dsh runtime resolved — set DSH_ENTRY / DSH_COMMAND, or declare @deepseek-ai/dsh in package.json"
elif [ "$RUNTIME" = "npx" ]; then
  pass "dsh runtime: npx (source=$SOURCE) — command: $COMMAND $ARGS"
else
  pass "dsh runtime: entry (source=$SOURCE) — $ENTRY"
  if [ "$ENTRY_EXISTS" = "true" ]; then
    pass "dsh entry exists"
  else
    fail "dsh entry missing — install it: npm install (repo root) OR DSH_ENTRY=<path>"
  fi
fi

# A runtime resolved to the sandbox default is NOT portable: /tmp is wiped and
# the file only ever existed on the machine that created it — that is exactly
# how "it works here" reached a machine where it did not. Keep PASS (it does run
# here) but say the consequence out loud; use DSH_ENTRY to make it deliberate.
if [ "$SOURCE" = "legacy-tmp" ]; then
  warn "resolved from the machine-local sandbox (/tmp/dsh-run) — it will NOT exist on another host (Mac/CI). Set DSH_ENTRY explicitly, or npm install (root) / keep the npx pin."
fi

# Version discipline: what the resolver reports must be the pin.
if [ -n "$VERSION" ] && [ -n "$PINNED" ]; then
  if [ "$VERSION" = "$PINNED" ]; then
    pass "resolved version $VERSION matches the pin"
  else
    fail "resolved version $VERSION != pinned $PINNED — behaviour would drift from the pin"
  fi
elif [ -n "$VERSION" ]; then
  info "resolved version $VERSION"
fi

# ── 4. The runtime actually runs — PROOF, through the gateway's own spawn plan ─
# (import of the SAME module the gateway uses: the argv shape exercised here is
# the argv shape a question would take. For an npx runtime this exercises the
# pinned package; for an entry it execs the file. Not a guess, a run.)
#
# Written to a scratch file and executed, NOT inline: this -e source contains
# both single AND double quotes (`.catch(e=>…String(e)…`), and one earlier
# draft lost the whole capture to shell quoting — VERIFY came back empty and
# the check failed for the wrong reason. A file has no quoting to lose.
# The helper file must live INSIDE the repo: a relative import resolves
# against the FILE'S own path, so a /tmp helper would look for /tmp/mcp-erpnext
# and fail with ERR_MODULE_NOT_FOUND (a probe run caught exactly that).
VERIFY_JS="scripts/.dsh-verify-$$.mjs"
cat > "$VERIFY_JS" <<'EOF'
import { verifyDshRuntime } from '../mcp-erpnext/src/dsh-gateway.mjs';
const v = await verifyDshRuntime();
process.stdout.write(JSON.stringify(v));
EOF
VERIFY="$(node "$VERIFY_JS" 2>/dev/null)"
rm -f "$VERIFY_JS"
RAN="$(json_get "$VERIFY" ran)"
VDETAIL="$(json_get "$VERIFY" detail)"
VVERSION="$(json_get "$VERIFY" version)"
if [ "$RAN" = "true" ]; then
  pass "runtime runs: $VDETAIL"
else
  fail "runtime does not run: $VDETAIL"
fi
if [ -n "$VVERSION" ] && [ -n "$PINNED" ] && [ "$VVERSION" != "$PINNED" ]; then
  fail "runtime --version printed $VVERSION, expected the pin $PINNED"
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
