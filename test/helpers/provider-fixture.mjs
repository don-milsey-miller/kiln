/**
 * The deterministic, non-billable provider fixture — TSK-0062, toward ACC-0086.
 *
 * ⚠️ **A PROVIDER THE PINNED RUNTIME RESOLVES AS A CUSTOM MODEL, ON THE LOOPBACK INTERFACE.** It answers
 * `/v1/chat/completions` in the streamed shape Pi's `openai-completions` client reads, and `modelsJson()` is the
 * `models.json` that names it. No paid account and no network: the server binds 127.0.0.1 only, and the
 * credential is a `$VAR` reference to a value this process invents.
 *
 * ⚠️ **DETERMINISTIC: THE ANSWER IS A FUNCTION OF THE CONVERSATION, NOT OF TIME OR OF HOW MANY REQUESTS CAME
 * BEFORE.** Every id and timestamp in a reply is fixed, and which scripted step answers is decided by
 * `position` — the number of assistant messages after the last user message. A request Pi retries gets the
 * same answer, and a second user turn starts the script again.
 *
 * ⚠️ **IT CANNOT LOOP.** A script is a finite list of steps. Once the conversation is past its end, every reply
 * is prose (`FIXTURE_DONE`), so a tool call is issued once per step and never re-issued because the text that
 * triggered it is still in the conversation (section 21.3 of the technical proposal).
 */

import { createServer } from "node:http";

export const FIXTURE_PROVIDER = "kiln-fixture";
export const FIXTURE_MODEL = "fixture-model";
export const FIXTURE_KEY_VAR = "KILN_FIXTURE_PROVIDER_KEY";
/** The prose every request past the end of a script receives. */
export const FIXTURE_DONE = "FIXTURE-TURN-COMPLETE";

/** A fixed placeholder key: it is compared, never sent anywhere, and bills nothing. */
export const FIXTURE_KEY = "kiln-fixture-placeholder-key-not-a-credential";

/**
 * The number of assistant messages after the last user message: 0 for a fresh user turn, 1 after one tool round.
 *
 * @param {{messages?: Array<{role: string}>}} request
 */
export function positionIn(request) {
  const messages = Array.isArray(request?.messages) ? request.messages : [];
  let lastUser = -1;
  for (let i = 0; i < messages.length; i++) if (messages[i]?.role === "user") lastUser = i;
  return messages.slice(lastUser + 1).filter((m) => m?.role === "assistant").length;
}

const chunk = (model, delta, finish = null) =>
  `data: ${JSON.stringify({ id: "chatcmpl-kiln-fixture", object: "chat.completion.chunk", created: 0, model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;

/**
 * The exact bytes one step is streamed as.
 *
 * @param {{text: string} | {toolCalls: Array<{name: string, arguments: object|string}>}} step
 * @param {string} model
 * @param {number} position  used only to give each tool call an id that is stable across a retry
 */
export function render(step, model, position) {
  if (Array.isArray(step?.toolCalls) && step.toolCalls.length > 0) {
    const calls = step.toolCalls.map((c, index) => ({
      index,
      id: `call_${position}_${index}`,
      type: "function",
      function: { name: c.name, arguments: typeof c.arguments === "string" ? c.arguments : JSON.stringify(c.arguments ?? {}) },
    }));
    return chunk(model, { role: "assistant", content: "" }) + chunk(model, { tool_calls: calls }) + chunk(model, {}, "tool_calls") + "data: [DONE]\n\n";
  }
  if (typeof step?.text !== "string") throw new TypeError(`a scripted step is {text} or {toolCalls}: ${JSON.stringify(step)}`);
  return chunk(model, { role: "assistant", content: step.text }) + chunk(model, {}, "stop") + "data: [DONE]\n\n";
}

/**
 * Start the fixture.
 *
 * @param {{script?: Array<object|((request: object) => object)>, key?: string}} [options]
 *   `script[position]` answers a request at that position; a function step receives the parsed request, so a
 *   step can echo a value only the request carries (the canary's challenge). Past the end of the script, prose.
 * @returns {Promise<{url: string, port: number, requests: Array<object>, close: () => Promise<void>}>}
 *   `requests` holds each request as Pi sent it: `{method, path, authorized, body}`. The key is never recorded.
 */
export async function startProviderFixture({ script = [], key = FIXTURE_KEY } = {}) {
  const requests = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => (raw += d));
    req.on("end", () => {
      let body = null;
      try {
        body = JSON.parse(raw);
      } catch {
        // Recorded as null and refused below.
      }
      const authorized = req.headers.authorization === `Bearer ${key}`;
      const path = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
      requests.push({ method: req.method, path, authorized, body });

      // ⚠️ EACH REFUSAL IS ONE A REAL PROVIDER WOULD ALSO MAKE, so a wrong request is a visible failure rather
      // than a reply that happens to look right.
      const refuse = (status, message) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify({ error: { message } }));
      if (req.method !== "POST" || path !== "/v1/chat/completions") return refuse(404, `no route ${req.method} ${path}`);
      if (!authorized) return refuse(401, "the fixture key was not presented");
      if (body === null || !Array.isArray(body.messages)) return refuse(400, "the request body is not a chat completion");
      if (body.stream !== true) return refuse(400, "the fixture answers streamed requests only");

      const position = positionIn(body);
      const entry = script[position];
      const step = entry === undefined ? { text: FIXTURE_DONE } : typeof entry === "function" ? entry(body) : entry;
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "close" });
      res.end(render(step, body.model ?? FIXTURE_MODEL, position));
    });
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}/v1`,
    port,
    requests,
    close: () => new Promise((done) => server.close(done)),
  };
}

/**
 * The `models.json` that makes the pinned runtime resolve the fixture as `kiln-fixture/fixture-model`.
 *
 * ⚠️ **THE KEY IS A `$VAR` REFERENCE, NOT A LITERAL**, the shape a custom provider's credential declaration takes:
 * the model is available only in a process that carries `KILN_FIXTURE_PROVIDER_KEY`.
 *
 * @param {string} url  the fixture's `url`
 */
export function modelsJson(url) {
  return {
    providers: {
      [FIXTURE_PROVIDER]: {
        baseUrl: url,
        api: "openai-completions",
        apiKey: `$${FIXTURE_KEY_VAR}`,
        models: [{ id: FIXTURE_MODEL, name: "Kiln Fixture", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 4096 }],
      },
    },
  };
}
