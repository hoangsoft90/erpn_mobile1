/**
 * Real MCP client — line-delimited JSON-RPC 2.0 over stdio with proper
 * request/response correlation (user decision 2026-09-13: complete this
 * WITHOUT real credentials using the mock server).
 *
 * Spawns a server binary (mock today, the pinned @casys/mcp-erpnext 3.0.4
 * stdio server tomorrow — ONLY the binary path changes), sends initialize,
 * correlates every response by JSON-RPC id, and enforces the read-only guard
 * on EVERY tools/call.
 */

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { assertReadOnly, markUntrusted } from "./readonly-guard.mjs";
import { writeDoctypes } from "./capability-contract.mjs";

/**
 * The fixture server (no credentials needed). This is a LOW-LEVEL default so
 * the JSON-RPC client is testable in isolation — runtime callers must pass an
 * explicit `serverScript` from `pickServerScript()`, which only returns this
 * fixture with an explicit `COPILOT_MOCK_OK=1` (issue1_fix1). A static test
 * (`test/mock-optin.test.mjs`) pins that no other src/scripts file references
 * this constant, so a silent mock path cannot be added unnoticed.
 */
export const MOCK_SERVER = fileURLToPath(new URL("./mock-server.mjs", import.meta.url));

export function createMcpClient({
  serverScript = MOCK_SERVER,
  env = process.env,
  serverArgs = [],
} = {}) {
  const child = spawn(process.execPath, [serverScript, ...serverArgs], {
    env,
    stdio: ["pipe", "pipe", "inherit"],
  });

  /** id -> { resolve, reject } */
  const pending = new Map();
  let nextId = 1;

  let buffer = "";
  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString();
    let nl;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue; // ignore non-JSON noise (server banners etc.)
      }
      const entry = pending.get(msg.id);
      if (!entry) continue;
      pending.delete(msg.id);
      if (msg.error) entry.reject(new Error(`MCP_ERROR ${msg.error.code}: ${msg.error.message}`));
      else entry.resolve(msg.result);
    }
  });

  child.on("exit", (code) => {
    for (const entry of pending.values()) {
      entry.reject(new Error(`MCP server exited (code ${code}) with ${pending.size} request(s) in flight`));
    }
    pending.clear();
  });

  function request(method, params) {
    const id = nextId++;
    const req = JSON.stringify({ jsonrpc: "2.0", id, method, params });
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      child.stdin.write(req + "\n", () => {});
    });
  }

  let initialized = false;

  return {
    child,

    /** MCP initialize handshake (idempotent). */
    async initialize() {
      if (initialized) return;
      await request("initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "erpn-skill-layer", version: "0.1.0" },
      });
      initialized = true;
    },

    /** tools/list (read-only guard does not apply — listing is harmless). */
    async listTools() {
      await this.initialize();
      const res = await request("tools/list", {});
      return res.tools ?? [];
    },

    /**
     * tools/call with the read-only guard enforced BEFORE the server sees it.
     * Unwraps the 3.0.4 result shape: structuredContent when present, else the
     * first text block parsed as JSON; tool-reported errors (isError) throw.
     */
    async callTool(tool, args) {
      assertReadOnly(tool); // throws on any write-ish/unknown tool
      await this.initialize();
      const res = await request("tools/call", { name: tool, arguments: args });
      if (res.isError) {
        const text = res.content?.find((c) => c.type === "text")?.text ?? "tool error";
        throw new Error(`TOOL_ERROR: ${text}`);
      }
      const payload = res.structuredContent ?? parseFirstText(res.content);
      return markUntrusted(`erpnext:${tool}`, payload);
    },

    /**
     * Phase 7: the ONE deliberate write call. The read-only guard above stays
     * untouched — writes are NOT generally allowed; this method exists so the
     * payment-write skill can reach `erpnext_doc_create` through the SAME
     * correlation/unwrap machinery.
     *
     * Tool name verified in the pinned @casys/mcp-erpnext 3.0.4 source: the
     * create tool is `erpnext_doc_create` ({doctype, data}); there is no
     * `erpnext_create_payment_entry`. The SAME shape is what the mock server
     * accepts (B2: its "Payment Entry only" check became contract-driven too),
     * so tests exercise the real payload rather than a private one.
     *
     * Fail-closed on doctype: `erpnext_doc_create` can create ANY doctype, so
     * only the doctypes the CONTRACT declares as writable are allowed here, in
     * code. Callers must hold a HIGH-risk confirmed proposal + idempotency gate
     * (http-ask /execute enforces both).
     *
     * B2 (plan3_review3): the list moved from a hardcoded "Payment Entry" to
     * `capabilities.json` — a second WRITE must not need an edit inside the
     * trust boundary. Adding a capability is still a deliberate contract change,
     * and `writeDoctypes()` excludes forbidden capabilities by construction.
     */
    async callWriteTool(tool, args) {
      // The two write shapes in the project are:
      //   - create a document whose doctype the contract declares writable
      //   - submit such a document, and ONLY when the capability that owns that
      //     doctype opted in (`execution.allow_submit`) — creating a draft and
      //     submitting it are different commitments (F7-2 for Payment Entry;
      //     sales_order.create is draft-only and cannot reach submit at all).
      // Anything else — any other tool, any other doctype — is refused in code.
      const allowed = writeDoctypes()[String(args?.doctype ?? "")] ?? null;
      const createOk = tool === "erpnext_doc_create" && allowed?.create === true;
      const submitOk = tool === "erpnext_doc_submit" && allowed?.submit === true;
      if (!createOk && !submitOk) {
        throw new Error(
          `WRITE_REFUSED: ${tool} on doctype "${args?.doctype}" is not allowed (creatable: ${Object.keys(writeDoctypes()).join(", ") || "none"})`,
        );
      }
      await this.initialize();
      const res = await request("tools/call", { name: tool, arguments: args });
      if (res.isError) {
        const text = res.content?.find((c) => c.type === "text")?.text ?? "tool error";
        throw new Error(`TOOL_ERROR: ${text}`);
      }
      const payload = res.structuredContent ?? parseFirstText(res.content);
      return markUntrusted(`erpnext:${tool}`, payload);
    },

    /**
     * Graceful shutdown: closes stdin, waits for the server to exit.
     *
     * IDEMPOTENT on purpose. MEASURED 2026-09-21 (P4-2 review): when the child
     * was ALREADY gone — a crashed pinned binary, a module that failed to load,
     * or a second close() — `once("exit")` can never fire again, so the wait
     * hung FOREVER. Every route that opens a client calls close() in its
     * `finally`, so one such request left a handler that never returned (socket
     * + child held open for the life of the process). Nothing else changes: a
     * live child still gets stdin closed and awaited.
     */
    async close() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.stdin.end();
      await new Promise((resolve) => child.once("exit", resolve));
    },
  };
}

function parseFirstText(content) {
  const text = content?.find((c) => c.type === "text")?.text;
  if (text === undefined) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
