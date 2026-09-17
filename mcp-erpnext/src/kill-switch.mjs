/**
 * Kill switch (P0, plan2_final §24.3).
 *
 * Operational control, not a feature flag: an operator must be able to stop all
 * WRITE traffic within seconds WITHOUT a deploy. Two storage layers, exactly as
 * the contract declares:
 *
 *   1. env  `COPILOT_GLOBAL_READ_ONLY` — truthy ("1"/"true"/"yes"/"on")
 *   2. file `mcp-erpnext/control/read-only.flag` — exists ⇒ read-only
 *
 * Semantics (verbatim from plan2_final §24.3):
 *   - READ keeps working.
 *   - a NEW write request is refused with `SYSTEM_MAINTENANCE`.
 *   - WAITING_CONFIRM proposals expire (the /execute refusal IS that expiry —
 *     no proposal is burned, the user re-asks after maintenance).
 *   - a command already EXECUTING finishes: our execute is one synchronous
 *     request per command, so there is no in-flight command to interrupt; the
 *     per-command reconcile loop (P1) inherits this same rule.
 *
 * `disable_capability` is honoured too: the gateway refuses a WRITE whose
 * capability id is listed in `COPILOT_DISABLE_CAPABILITIES` (comma separated),
 * which is how a single broken capability is turned off without stopping the
 * rest. Toggle every change is logged (stderr) — never silently.
 */

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { operationalControls } from "./capability-contract.mjs";

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** @returns {string} absolute path of the read-only flag file */
export function killSwitchFlagPath() {
  const rel = operationalControls()?.kill_switch?.flag_file ?? "control/read-only.flag";
  return join(PKG_ROOT, rel);
}

const TRUTHY = new Set(["1", "true", "yes", "on"]);

/** @returns {boolean} true when the switch value means "read-only" */
export function isTruthySwitch(value) {
  return TRUTHY.has(String(value ?? "").trim().toLowerCase());
}

/**
 * Is the whole gateway in read-only mode right now?
 * Re-read on EVERY call (no caching): the point of the switch is that an
 * operator flips it and the next request obeys.
 * @param {{env?: Record<string,string|undefined>, flagFile?: string}} [opts]
 */
export function isGlobalReadOnly({ env = process.env, flagFile } = {}) {
  if (isTruthySwitch(env?.COPILOT_GLOBAL_READ_ONLY)) return true;
  const file = flagFile ?? killSwitchFlagPath();
  try {
    return existsSync(file);
  } catch {
    // Cannot stat the flag ⇒ do NOT invent a mode. The env layer still applies.
    return false;
  }
}

/**
 * Capabilities an operator has disabled individually.
 * @param {{env?: Record<string,string|undefined>}} [opts]
 * @returns {Set<string>}
 */
export function disabledCapabilities({ env = process.env } = {}) {
  return new Set(
    String(env?.COPILOT_DISABLE_CAPABILITIES ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

/**
 * Verdict for one WRITE capability. Never throws — the caller maps the verdict
 * to an HTTP shape (SYSTEM_MAINTENANCE / CAPABILITY_DISABLED).
 * @param {string} capabilityId
 * @param {{env?: Record<string,string|undefined>, flagFile?: string}} [opts]
 * @returns {{allowed:true} | {allowed:false, code:string, error:string, level:string}}
 */
export function checkKillSwitch(capabilityId, opts = {}) {
  if (isGlobalReadOnly(opts)) {
    const level = isTruthySwitch(opts.env?.COPILOT_GLOBAL_READ_ONLY) ? "global_read_only (env)" : "global_read_only (flag file)";
    return {
      allowed: false,
      code: "SYSTEM_MAINTENANCE",
      level: "global_read_only",
      error: `hệ thống đang ở chế độ CHỈ ĐỌC (${level}) — mọi lệnh ghi mới bị từ chối; đọc vẫn hoạt động bình thường. Đề xuất không bị tiêu tốn command_id, hãy thử lại sau khi bảo trì xong.`,
    };
  }
  if (capabilityId && disabledCapabilities(opts).has(capabilityId)) {
    return {
      allowed: false,
      code: "CAPABILITY_DISABLED",
      level: "disable_capability",
      error: `capability "${capabilityId}" đang bị tắt bởi người vận hành — không thực thi được; đề xuất không bị tiêu tốn command_id.`,
    };
  }
  return { allowed: true };
}

/**
 * Log a toggle transition (audit trail — the contract demands it). Only stderr:
 * never a log pipeline dependency in tests.
 * @param {{code:string, capabilityId?:string|null, source?:string}} info
 */
export function logToggle(info) {
  process.stderr.write(
    `[kill-switch] ${new Date().toISOString()} ${info.code} capability=${info.capabilityId ?? "-"} source=${info.source ?? "-"}\n`,
  );
}
