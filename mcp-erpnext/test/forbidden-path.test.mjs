/**
 * P0 §8 + §25 — `document.delete` must not exist on the AI path.
 *
 * The contract declares the capability so the refusal is EXPLICIT: the
 * pipeline answers with FORBIDDEN_IN_AI_PATH and produces no proposal, instead
 * of silently misrouting the request into a READ skill (which would look like
 * the system "almost" did it).
 *
 * Full pipeline: real Python NLP bridge -> routeIntent -> forbidden branch.
 * ERPNext stays the in-memory mock (no credentials, no write).
 */

import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

for (const k of Object.keys(process.env)) {
  if (/^(ERPNEXT_|ASK_)/.test(k)) delete process.env[k];
}
delete process.env.COPILOT_GLOBAL_READ_ONLY;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");

async function startNlpService() {
  const child = spawn("python3", ["-m", "nlp_service.server", "--port", "0"], {
    cwd: REPO,
    stdio: ["ignore", "pipe", "inherit"],
  });
  const port = await new Promise((resolve, reject) => {
    child.stdout.on("data", (d) => {
      const m = String(d).match(/"port":\s*(\d+)/);
      if (m) resolve(Number(m[1]));
    });
    child.on("exit", (code) => reject(new Error(`nlp service exited early (${code})`)));
    setTimeout(() => reject(new Error("nlp service: no ready line in 5s")), 5000);
  });
  return { child, port };
}

test("delete / cancel intents are refused by the pipeline — no skill, no proposal", async () => {
  const nlp = await startNlpService();
  process.env.NLP_SERVICE_PORT = String(nlp.port);
  try {
    const { answerQuestion } = await import("../src/copilot-server.mjs");
    for (const text of ["xóa khoản vừa thu", "huỷ phiếu thu hôm qua", "delete payment entry"]) {
      const res = await answerQuestion(text);
      assert.equal(res.error_code, "FORBIDDEN_IN_AI_PATH", `${text}: ${JSON.stringify(res)}`);
      assert.equal(res.proposal, null, "a forbidden intent must produce NO proposal to confirm");
      assert.equal(res.answer, null);
      assert.equal(res.routed.capability, "document.delete");
      assert.match(res.reason, /CẤM/);
    }
  } finally {
    nlp.child.kill();
  }
});
