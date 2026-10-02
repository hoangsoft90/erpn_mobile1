#!/usr/bin/env node
/**
 * Probe LLM (next6 / P1) — a DETERMINISTIC, zero-quota OpenAI-compatible
 * endpoint whose ONLY job is to make the workspace-context leak OBSERVABLE at
 * the /dsh/ask OUTPUT level.
 *
 * Why it exists: the real leak (`anh khánh` → dev persona) came from dsh
 * injecting the workspace `AGENTS.md`/`CLAUDE.md` chain (see
 * `.plan/next6/P0-result.md` §P0.2) into the model request. A dumb mock that
 * never echoes can't prove that, and a real LLM costs quota. This probe:
 *
 *   - scans EVERY message it receives for `DEV_CONTEXT_SENTINEL_DO_NOT_LEAK`;
 *   - ALWAYS appends `PROBE_SENTINEL=LEAK|NO_LEAK` to its answer, so the
 *     sentinel's presence in the model context shows up verbatim in the
 *     `/dsh/ask` response — the assertion target.
 *
 *   OLD config (dsh cwd = repo root, sentinel in AGENTS.md) → LEAK (red).
 *   NEW config (dsh cwd = isolated dir)              → NO_LEAK (green).
 *
 * Turn shape mirrors scripts/mock-llm.mjs so it can stand in for the model in
 * the existing e2e wiring. `PROBE_CALL_TOOL=0` makes it answer on turn 1
 * without calling copilot_ask — use that to isolate the leak test from
 * NLP/ERPNext availability.
 *
 * Run: PROBE_LLM_PORT=8900 node scripts/probe-llm.mjs
 */

import http from "node:http";

const PORT = Number(process.env.PROBE_LLM_PORT || 8899);
const MODEL = process.env.PROBE_LLM_MODEL || "ag/gemini-3.6-flash-low";
const SENTINEL = "DEV_CONTEXT_SENTINEL_DO_NOT_LEAK";
/** P3: proves the SYSTEM-level domain boundary (personaPrefix) reached the model. */
const BOUNDARY_MARKER = "ERP_BOUNDARY_V1";
const CALL_TOOL = process.env.PROBE_CALL_TOOL !== "0";

const json = (res, status, body) => {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
};

/** Every message's text, concatenated (string or OpenAI text-block array). */
function allText(messages) {
  return messages
    .map((m) => {
      const c = m?.content;
      if (typeof c === "string") return c;
      if (Array.isArray(c)) return c.map((p) => p?.text ?? "").join("");
      return "";
    })
    .join("\n");
}

function lastUserText(messages) {
  const texts = messages
    .filter((m) => m?.role === "user")
    .map((m) => (typeof m.content === "string" ? m.content : ""));
  const injected = (t) =>
    t.startsWith("<system-reminder") ||
    t.startsWith("Current runtime context") ||
    t.startsWith("Generate the session title");
  return texts.find((t) => t.length > 0 && !injected(t)) ?? texts[0] ?? "";
}

function toolResultText(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role !== "tool") continue;
    const c = m.content;
    if (typeof c === "string" && c.length > 0) return c;
    if (Array.isArray(c)) {
      const t = c.filter((p) => p?.type === "text").map((p) => p?.text ?? "").join("");
      if (t) return t;
    }
    if (c && typeof c === "object" && typeof c.text === "string" && c.text) return c.text;
  }
  return null;
}

function resolveCopilotTool(tools) {
  const names = (Array.isArray(tools) ? tools : [])
    .map((t) => t?.function?.name ?? t?.name)
    .filter((n) => typeof n === "string");
  return (
    names.find((n) => n === "copilot_ask") ??
    names.find((n) => n.endsWith("copilot_ask")) ??
    names[0] ??
    "copilot_ask"
  );
}

function buildBody(messages, stream, hasTools, tools) {
  const text = allText(messages);
  const leak = text.includes(SENTINEL);
  // The boundary marker must arrive on a SYSTEM-role message (P3), not merely
  // somewhere in the conversation.
  const boundary = messages.some(
    (m) => m?.role === "system" && typeof m.content === "string" && m.content.includes(BOUNDARY_MARKER),
  );
  process.stderr.write(
    `[probe-llm] turn: messages=${messages.length} chars=${text.length} sentinel=${leak ? "LEAK" : "NO_LEAK"} boundary=${boundary ? "FOUND" : "MISSING"}\n`,
  );
  const marker = `PROBE_SENTINEL=${leak ? "LEAK" : "NO_LEAK"}\nPROBE_BOUNDARY=${boundary ? "FOUND" : "MISSING"}`;

  const toolContent = toolResultText(messages);
  let message;
  let finish;
  if (toolContent !== null) {
    // Final turn: quote the tool result verbatim AND surface the probe marker.
    let answer;
    try {
      const p = JSON.parse(toolContent);
      answer = typeof p?.answer === "string" && p.answer ? `Trả lời từ ERPNext: ${p.answer}` : `Không trả lời được: ${p?.reason}`;
    } catch {
      answer = "Tool không trả về JSON đọc được.";
    }
    message = { role: "assistant", content: `${answer}\n${marker}` };
    finish = "stop";
  } else if (!hasTools) {
    // dsh auxiliary calls (session title) — plain text, no tool_call.
    message = { role: "assistant", content: "hỏi công nợ khách" };
    finish = "stop";
  } else if (!CALL_TOOL) {
    message = { role: "assistant", content: `PROBE_ONLY\n${marker}` };
    finish = "stop";
  } else {
    message = {
      role: "assistant",
      content: null,
      tool_calls: [{
        id: "call_probe_1",
        type: "function",
        function: { name: resolveCopilotTool(tools), arguments: JSON.stringify({ text: lastUserText(messages) }) },
      }],
    };
    finish = "tool_calls";
  }

  const created = Math.floor(Date.now() / 1000);
  const id = `chatcmpl-probe-${created}`;
  if (stream) {
    return {
      sse: true,
      chunks: [
        { id, object: "chat.completion.chunk", created, model: MODEL, choices: [{ index: 0, delta: message, finish_reason: null }] },
        { id, object: "chat.completion.chunk", created, model: MODEL, choices: [{ index: 0, delta: {}, finish_reason: finish }] },
      ],
    };
  }
  return {
    json: { id, object: "chat.completion", created, model: MODEL, choices: [{ index: 0, message, finish_reason: finish }], usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } },
  };
}

const server = http.createServer((req, res) => {
  if (req.method === "GET" && req.url === "/health") return json(res, 200, { ok: true, model: MODEL });
  if (req.method === "GET" && req.url === "/v1/models") {
    return json(res, 200, { object: "list", data: [{ id: MODEL, object: "model", owned_by: "probe" }] });
  }
  if (req.method === "POST" && req.url === "/v1/chat/completions") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch {
        return json(res, 400, { error: { message: "invalid JSON" } });
      }
      const messages = Array.isArray(parsed?.messages) ? parsed.messages : [];
      const hasTools = Array.isArray(parsed?.tools) && parsed.tools.length > 0;
      const built = buildBody(messages, parsed?.stream === true, hasTools, parsed?.tools);
      if (built.sse) {
        res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
        for (const chunk of built.chunks) res.write(`data: ${JSON.stringify(chunk)}\n\n`);
        res.write("data: [DONE]\n\n");
        res.end();
      } else {
        json(res, 200, built.json);
      }
    });
    return;
  }
  json(res, 404, { error: { message: `no route: ${req.method} ${req.url}` } });
});

server.listen(PORT, "127.0.0.1", () => {
  process.stderr.write(`[probe-llm] listening on http://127.0.0.1:${PORT}/v1 (model: ${MODEL}, callTool=${CALL_TOOL})\n`);
});
