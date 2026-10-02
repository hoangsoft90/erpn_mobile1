#!/usr/bin/env node
/**
 * Mock OpenAI-compatible LLM for the dsh smoke test (user decision 2026-09-14:
 * "smock tạm, sau này đối chiếu với OpenAI-compatible thật sau").
 *
 * Behaviour (deliberately dumb and deterministic):
 * - Turn 1: if the request carries tools and contains `copilot_ask`, answer
 *   with ONE tool_call: copilot_ask(text = last user message text).
 * - Turn 2 (tool result present): parse the tool result's structured JSON and
 *   phrase the final Vietnamese answer from its `answer` field. It NEVER
 *   invents numbers — it quotes the tool output verbatim.
 *
 * Supports stream:true as single-chunk SSE (standard OpenAI accumulation
 * logic accepts one delta carrying the complete message).
 *
 * Endpoints: POST /v1/chat/completions, GET /v1/models, GET /health.
 * Run: node scripts/mock-llm.mjs  (port via MOCK_LLM_PORT, default 8899)
 */

import http from "node:http";

const PORT = Number(process.env.MOCK_LLM_PORT || 8899);
const MODEL = "mock-copilot-1";

const json = (res, status, body) => {
  const data = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(data);
};

/**
 * The user's task text. dsh injects workspace instructions / runtime context /
 * skill catalogs as user-role `<system-reminder>` messages AFTER the real
 * task, so scanning from the end grabs 45k of instructions (verified bug in
 * run #2). The task is the first user message that is not an injected one.
 */
function lastUserText(messages) {
  const userTexts = messages
    .filter((m) => m?.role === "user")
    .map((m) => {
      const c = m.content;
      if (typeof c === "string") return c;
      if (Array.isArray(c)) return c.map((p) => p?.text ?? "").join("");
      return "";
    })
    .filter((t) => t.length > 0);
  const injected = (t) =>
    t.startsWith("<system-reminder") ||
    t.startsWith("Current runtime context") ||
    t.startsWith("Generate the session title");
  return userTexts.find((t) => !injected(t)) ?? userTexts[0] ?? "";
}

/**
 * The copilot tool result content, if this turn carries one. Handles all the
 * shapes adapters use: plain string, OpenAI text-block array, {text} object.
 */
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

/** Turn 2: phrase the answer strictly from the tool payload. */
function finalMessage(toolContent) {
  let payload = null;
  try {
    payload = JSON.parse(toolContent);
  } catch {
    payload = null;
  }
  const answer = payload?.answer;
  if (typeof answer === "string" && answer.length > 0) {
    return `Trả lời từ ERPNext (mock LLM chỉ đọc lại kết quả, không tự tính): ${answer}`;
  }
  if (payload?.reason) {
    return `Không trả lời được: ${payload.reason}`;
  }
  process.stderr.write(`[mock-llm] unparsable tool content (first 300): ${String(toolContent).slice(0, 300)}\n`);
  return "Tool không trả về câu trả lời có thể đọc lại được.";
}

/**
 * dsh registers MCP tools namespaced (e.g. mcp__erpn_copilot__copilot_ask).
 * Resolve the real name from the tools array the host sent — exact match
 * first, then suffix match, then any tool (so a catalog change cannot make
 * the mock call a bogus name).
 */
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
  const toolContent = toolResultText(messages);
  let message;
  let finish;
  if (toolContent !== null) {
    message = { role: "assistant", content: finalMessage(toolContent) };
    finish = "stop";
  } else if (!hasTools) {
    // dsh auxiliary calls (e.g. session title) come without tools — answer
    // plain text so they never receive a bogus tool_call.
    message = { role: "assistant", content: "hỏi công nợ khách" };
    finish = "stop";
  } else {
    const text = lastUserText(messages);
    message = {
      role: "assistant",
      content: null,
      tool_calls: [{
        id: "call_mock_1",
        type: "function",
        function: { name: resolveCopilotTool(tools), arguments: JSON.stringify({ text }) },
      }],
    };
    finish = "tool_calls";
  }
  const created = Math.floor(Date.now() / 1000);
  const id = `chatcmpl-mock-${created}`;
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
    return json(res, 200, { object: "list", data: [{ id: MODEL, object: "model", owned_by: "mock" }] });
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
      if (process.env.MOCK_LLM_DEBUG === "1") {
        for (const [i, m] of messages.entries()) {
          const c = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
          process.stderr.write(
            `[mock-llm][dbg] msg[${i}] role=${m.role} len=${c?.length ?? 0} head=${String(c ?? "").slice(0, 80).replace(/\n/g, " ")} ... tail=${String(c ?? "").slice(-120).replace(/\n/g, " ")}\n`,
          );
        }
      }
      const built = buildBody(messages, parsed?.stream === true, hasTools, parsed?.tools);
      process.stderr.write(`[mock-llm] ${built.sse ? "SSE" : "json"} turn (messages: ${messages.length})\n`);
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
  process.stderr.write(`[mock-llm] listening on http://127.0.0.1:${PORT}/v1 (model: ${MODEL})\n`);
});
