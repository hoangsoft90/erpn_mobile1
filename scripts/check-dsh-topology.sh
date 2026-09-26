#!/usr/bin/env bash
# DSH TOPOLOGY CHECK — `.plan/dsh_prompt_check.md` §2/§9.
#
#   bash scripts/check-dsh-topology.sh
#
# Answers, with evidence: WHERE would a DSH session actually run, and is that
# place reachable right now? Reports exactly one of three states and never
# upgrades one into another:
#
#   LOCAL_OK       — the pinned runtime exists on this machine and can run
#   REMOTE_OK      — the Mac runner answered its health check
#   BLOCKED        — the configured runtime is NOT usable right now
#
# A "remote" configuration that cannot reach the Mac is BLOCKED. It is never
# reported as local, and a local success is never reported as a Mac verification
# (that is the whole point of the split — see dsh-gateway.mjs header).

set -uo pipefail
# shellcheck source=scripts/lib-dsh-e2e.sh
source "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib-dsh-e2e.sh"

echo "== DSH TOPOLOGY =="
info "mode (DSH_MODE): ${DSH_MODE:-local}"

CONFIG_JSON="$(node -e "import('./mcp-erpnext/src/dsh-gateway.mjs').then(m=>{const c=m.dshGatewayConfig();process.stdout.write(JSON.stringify({mode:c.mode,remoteUrl:c.remoteUrl}))}).catch(e=>process.stdout.write(JSON.stringify({mode:'error',error:String(e)})))" 2>/dev/null)"
MODE="$(json_field "$CONFIG_JSON" mode)"
REMOTE_URL="$(json_field "$CONFIG_JSON" remoteUrl)"
info "resolved mode: $MODE"
[ -n "$REMOTE_URL" ] && info "remote url: $REMOTE_URL"

DETAIL="$(node -e "import('./mcp-erpnext/src/dsh-gateway.mjs').then(m=>m.dshGatewayHealth()).then(h=>process.stdout.write(JSON.stringify(h))).catch(e=>process.stdout.write(JSON.stringify({available:false,detail:String(e)})))" 2>/dev/null)"
AVAILABLE="$(json_field "$DETAIL" available)"
HEALTH_DETAIL="$(json_field "$DETAIL" detail)"
VERSION="$(json_field "$DETAIL" version)"
info "health: $HEALTH_DETAIL"
[ -n "$VERSION" ] && info "runtime version: $VERSION"

if [ "$MODE" = "local" ]; then
  if [ "$AVAILABLE" = "true" ]; then
    pass "LOCAL_OK — sessions run on this machine with the pinned runtime"
  else
    fail "BLOCKED — local mode is not runnable: $HEALTH_DETAIL"
  fi
elif [ "$MODE" = "remote" ]; then
  if [ "$AVAILABLE" = "true" ]; then
    pass "REMOTE_OK — the Mac runner answered ($HEALTH_DETAIL)"
  else
    fail "BLOCKED — remote mode is configured but the Mac runner is unreachable: $HEALTH_DETAIL"
    info "a run in this state refuses; it never falls back to a local spawn"
  fi
else
  fail "BLOCKED — unknown mode '$MODE'"
fi

# The gateway endpoint, if it happens to be up, must agree with the direct probe.
GW_HEALTH="$(curl "${curl_args[@]}" -m 10 "$ASK_BASE/dsh/health" 2>/dev/null || true)"
if [ -n "$GW_HEALTH" ]; then
  GW_AVAILABLE="$(json_field "$GW_HEALTH" available)"
  GW_RUNTIME="$(json_field "$GW_HEALTH" runtime)"
  info "gateway /dsh/health: available=$GW_AVAILABLE runtime=$GW_RUNTIME"
  if [ "$GW_AVAILABLE" = "$AVAILABLE" ] && [ "$GW_RUNTIME" = "$MODE" ]; then
    pass "gateway /dsh/health agrees with the direct probe"
  else
    fail "gateway /dsh/health disagrees (gateway: available=$GW_AVAILABLE runtime=$GW_RUNTIME | shell: available=$AVAILABLE mode=$MODE)"
    info "this is a REAL difference: the running gateway resolves its topology from ITS OWN env."
    info "export the same DSH_MODE/DSH_REMOTE_URL in this shell to compare like with like."
  fi
else
  info "gateway not reachable at $ASK_BASE — skipped the endpoint cross-check"
fi

finish
