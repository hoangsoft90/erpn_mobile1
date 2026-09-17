/**
 * P3 — Classifier golden regression (CI GATE, plan2_final §24.5 + §15 D6).
 *
 * Runs the version-controlled classifier cases through the REAL pipeline
 * (copilot-server → classifier → router → skills → mock ERPNext) with a local
 * MOCK LLM. No provider, no quota, no flake — so it can gate CI on every
 * change to the router/classifier, exactly like golden-dataset.json gates the
 * deterministic core.
 *
 * Exit code is the verdict: any case whose observable result differs from the
 * pinned expectation fails the suite.
 */

import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const REPO = path.resolve(ROOT, "..");
const COPILOT = path.join(ROOT, "src", "copilot-server.mjs");
const CASES = JSON.parse(readFileSync(path.join(HERE, "golden", "classifier-cases.json"), "utf8")).cases;

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

function startMockClassifier() {
  const state = { content: "{}" };
  const server = http.createServer((req, res) => {
    if (req.method !== "POST" || !req.url.startsWith("/v1/chat/completions")) {
      res.writeHead(404);
      return res.end();
    }
    req.resume();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: state.content }, finish_reason: "stop" }] }));
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, state, port: server.address().port })));
}

function startCopilot(nlpPort, env) {
  const child = spawn(process.execPath, [COPILOT], {
    env: { ...env, NLP_SERVICE_PORT: String(nlpPort) },
    stdio: ["pipe", "pipe", "inherit"],
  });
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
      const msg = JSON.parse(line);
      const entry = pending.get(msg.id);
      if (!entry) continue;
      pending.delete(msg.id);
      entry.resolve(msg.result?.structuredContent ?? JSON.parse(msg.result.content[0].text));
    }
  });
  const call = (text) =>
    new Promise((resolve) => {
      const id = nextId++;
      pending.set(id, { resolve });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "copilot_ask", arguments: { text } } }) + "\n");
    });
  return { child, call, close: () => child.stdin.end() };
}

test("P3 classifier golden regression — every case matches its pinned outcome", async () => {
  assert.ok(CASES.length >= 8, `regression set should hold ≥8 cases, has ${CASES.length}`);

  // HERMETIC: strip ERPNEXT_* so the child always uses the mock catalog.
  const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^ERPNEXT_/.test(k)));
  const nlp = await startNlpService();
  const mock = await startMockClassifier();
  const copilot = startCopilot(nlp.port, { ...cleanEnv, COPILOT_CLASSIFIER_URL: `http://127.0.0.1:${mock.port}` });
  const failures = [];
  try {
    for (const c of CASES) {
      mock.state.content = JSON.stringify({
        intent: c.llm.intent,
        confidence: c.llm.confidence,
        slots: c.llm.slots ?? {},
        missing_entities: [],
        needs_clarification: c.llm.needs_clarification ?? false,
      });
      const res = await copilot.call(c.text);
      const problems = [];
      if (c.expect.error_code !== undefined && res.error_code !== c.expect.error_code) {
        problems.push(`error_code want ${c.expect.error_code} got ${res.error_code}`);
      }
      if (c.expect.group !== undefined && res.routed?.group !== c.expect.group) {
        problems.push(`group want ${c.expect.group} got ${res.routed?.group}`);
      }
      if (c.expect.matched !== undefined && res.routed?.matched !== c.expect.matched) {
        problems.push(`matched want ${c.expect.matched} got ${res.routed?.matched}`);
      }
      if (c.expect.proposal_risk !== undefined && res.proposal?.risk !== c.expect.proposal_risk) {
        problems.push(`proposal_risk want ${c.expect.proposal_risk} got ${res.proposal?.risk}`);
      }
      if (c.expect.answer_contains !== undefined && !String(res.answer ?? "").includes(c.expect.answer_contains)) {
        problems.push(`answer missing "${c.expect.answer_contains}"`);
      }
      if (c.expect.answer_not_contains !== undefined && String(res.answer ?? "").includes(c.expect.answer_not_contains)) {
        problems.push(`answer must NOT contain "${c.expect.answer_not_contains}"`);
      }
      if (problems.length > 0) failures.push({ id: c.id, text: c.text, problems, got: { routed: res.routed, error_code: res.error_code } });
    }

    for (const f of failures) {
      console.log(`\n  ✖ ${f.id} "${f.text}"`);
      for (const p of f.problems) console.log(`      ${p}`);
    }
    assert.equal(failures.length, 0, `${failures.length}/${CASES.length} classifier cases failed`);
    console.log(`\n  classifier regression: ${CASES.length}/${CASES.length} cases passed\n`);
  } finally {
    copilot.close();
    mock.server.close();
    nlp.child.kill();
  }
});
