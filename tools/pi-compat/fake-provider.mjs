/**
 * A deterministic, non-billable OpenAI-compatible endpoint for the spike.
 *
 * It answers /v1/chat/completions with a streamed reply, and records every request it received so
 * the spike can read, at the provider boundary, exactly what Pi sent — which is how the delegated
 * task's arrival is observed without trusting anything the model says.
 *
 * If the incoming request declares tools and the last user message contains CALL-TOOL:<name>, the
 * reply is a tool call rather than text. That is the shape the live canary needs.
 */
import { createServer } from "node:http";
import { writeFileSync } from "node:fs";

const LOG = process.env.FAKE_PROVIDER_LOG;
const received = [];

function sse(res, obj) {
  res.write(`data: ${JSON.stringify(obj)}\n\n`);
}

const server = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    if (!req.url.includes("/chat/completions")) {
      res.writeHead(404).end("no");
      return;
    }
    let parsed = null;
    try {
      parsed = JSON.parse(body);
    } catch {
      /* recorded as unparseable below */
    }
    received.push({
      at: new Date().toISOString(),
      model: parsed?.model ?? null,
      stream: parsed?.stream ?? null,
      toolNames: (parsed?.tools ?? []).map((t) => t.function?.name ?? t.name).sort(),
      messages: (parsed?.messages ?? []).map((m) => ({
        role: m.role,
        text: typeof m.content === "string" ? m.content : JSON.stringify(m.content),
      })),
      rawLength: body.length,
    });
    if (LOG) writeFileSync(LOG, JSON.stringify(received, null, 2) + "\n");

    const lastUser = [...(parsed?.messages ?? [])].reverse().find((m) => m.role === "user");
    const userText = typeof lastUser?.content === "string" ? lastUser.content : JSON.stringify(lastUser?.content ?? "");
    // ⚠️ Answer the tool call ONCE. Once a tool result is already in the conversation the canary
    // has what it needs; continuing to re-issue the call is an infinite loop, not a finding.
    const alreadyAnswered = (parsed?.messages ?? []).some((m) => m.role === "tool");
    const wantsTool = alreadyAnswered ? null : /CALL-TOOL:([A-Za-z0-9_]+)/.exec(userText);
    const id = "chatcmpl-spike";
    const base = { id, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: parsed?.model ?? "spike" };

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    if (wantsTool) {
      const name = wantsTool[1];
      const challenge = /CHALLENGE:([A-Za-z0-9-]+)/.exec(userText)?.[1] ?? "none";
      sse(res, { ...base, choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "call_spike", type: "function", function: { name, arguments: JSON.stringify({ challenge }) } }] }, finish_reason: null }] });
      sse(res, { ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] });
    } else {
      sse(res, { ...base, choices: [{ index: 0, delta: { role: "assistant", content: "SPIKE-REPLY-OK" }, finish_reason: null }] });
      sse(res, { ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
    }
    res.write("data: [DONE]\n\n");
    res.end();
  });
});

const port = Number(process.env.FAKE_PROVIDER_PORT ?? 8099);
server.listen(port, "127.0.0.1", () => {
  process.stdout.write(`fake provider listening on http://127.0.0.1:${port}/v1\n`);
});

process.on("SIGTERM", () => server.close());
process.on("SIGINT", () => server.close());
