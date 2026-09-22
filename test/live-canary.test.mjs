/**
 * The bounded live tool-call canary — TSK-0041, against ACC-0061 and ACC-0062.
 *
 * ⚠️ **THE REAL PATH, WITH A NON-BILLABLE ENDPOINT.** Each run goes through `runLiveCanary`, its isolated child,
 * the pinned Pi SDK's agent session and Pi's own `openai-completions` client, to a loopback server in this
 * process that answers as a provider would. The server records every request exactly as Pi sent it, so what the
 * model was offered — tools, messages, token ceiling — is observed at the provider boundary, not inferred from
 * Kiln's code. Its scripted answers are the controls: an exact call, prose, and each malformed shape.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LIVE_CANARY_REFUSAL, judgeLiveReport, runLiveCanary } from "../lib/live-canary.mjs";
import { BASE_ENV } from "../lib/specialists/contract.mjs";
import {
  CANARY_MAX_TOKENS,
  CANARY_SYSTEM_PROMPT,
  PREFLIGHT_ACKNOWLEDGEMENT,
  PREFLIGHT_PARAMETERS,
  PREFLIGHT_TOOL_NAME,
  isExactChallengeCall,
} from "../lib/preflight-tool.mjs";
import { KNOWN_TOOL_NAMES } from "../lib/tool-wire-names.mjs";
import { declaredToolNames } from "../lib/pi-package.mjs";
import { piToolAllowlist, withToolAllowlist } from "../bin/start-kiln.mjs";

const ROOT = join(import.meta.dirname, "..");
const KEY = "acme-live-canary-KEY-5f02c9";
const DECLARATION = Object.freeze({ id: "acme", apiKey: "$ACME_CANARY_KEY" });
const FIXED = Buffer.from("00112233445566778899aabbccddeeff", "hex");
const CHALLENGE = FIXED.toString("hex");
const CONTEXT_SENTINEL = "KILN-CONTEXT-FILE-SENTINEL-71c2";

function cleanHost(extra = {}) {
  const out = {};
  for (const name of new Set([...BASE_ENV.win32, ...BASE_ENV.posix])) if (process.env[name] !== undefined) out[name] = process.env[name];
  return { ...out, ACME_CANARY_KEY: KEY, ...extra };
}

const sse = (res, obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

/**
 * An OpenAI-compatible endpoint scripted to answer the first request one way, and any later request with text.
 * `answer(challengeInRequest)` returns `{tool_calls}` or `{content}`.
 */
async function provider(answer) {
  const requests = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const parsed = JSON.parse(body || "{}");
      requests.push(parsed);
      const userText = JSON.stringify(parsed.messages ?? []);
      const seen = /[0-9a-f]{32}/.exec(userText)?.[0] ?? null;
      const replied = (parsed.messages ?? []).some((m) => m.role === "tool");
      const base = { id: "chatcmpl-kiln", object: "chat.completion.chunk", created: 0, model: parsed.model };
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      const out = replied ? { content: "done" } : answer(seen);
      if (out.tool_calls) {
        sse(res, { ...base, choices: [{ index: 0, delta: { role: "assistant", tool_calls: out.tool_calls }, finish_reason: null }] });
        sse(res, { ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] });
      } else {
        sse(res, { ...base, choices: [{ index: 0, delta: { role: "assistant", content: out.content }, finish_reason: null }] });
        sse(res, { ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
      }
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  return { requests, url: `http://127.0.0.1:${port}/v1`, close: () => new Promise((r) => server.close(r)) };
}

const call = (name, args, index = 0) => ({ index, id: `call_${index}`, type: "function", function: { name, arguments: typeof args === "string" ? args : JSON.stringify(args) } });

/** Run the canary against a scripted endpoint, with a private parent so leftovers are visible. */
async function canary(answer, opts = {}) {
  const p = await provider(answer);
  const parent = mkdtempSync(join(tmpdir(), "kiln-live-canary-test-"));
  // ⚠️ A CONTEXT FILE WHERE PI WOULD LOOK. Pi walks up from its working directory for AGENTS.md, and the
  // canary's working directory sits under this parent, so a session that loaded context files would send this.
  writeFileSync(join(parent, "AGENTS.md"), `${CONTEXT_SENTINEL}\n`);
  try {
    let result = null;
    let refusal = null;
    try {
      result = await runLiveCanary({
        provider: "acme",
        model: "acme-model",
        thinkingLevel: "off",
        custom: DECLARATION,
        customProviderConfig: {
          baseUrl: p.url,
          api: "openai-completions",
          models: [{ id: "acme-model", name: "Acme Model", contextWindow: 128000, maxTokens: 4096, reasoning: false }],
        },
        hostEnv: cleanHost(),
        tempParent: parent,
        randomBytes: () => FIXED,
        ...opts,
      });
    } catch (e) {
      refusal = e;
    }
    return { result, refusal, requests: p.requests, url: p.url, leftovers: readdirSync(parent).filter((n) => n !== "AGENTS.md") };
  } finally {
    await p.close();
    rmSync(parent, { recursive: true, force: true });
  }
}

const exact = (seen) => ({ tool_calls: [call(PREFLIGHT_TOOL_NAME, { challenge: seen })] });

test("⚠️ ACC-0061 an exact tool call with this run's challenge passes, observed through Pi's real provider path", async () => {
  const o = await canary(exact);
  assert.equal(o.refusal, null, o.refusal?.message);
  const { observed, requests, ...rest } = o.result;
  assert.deepEqual(rest, { provider: "acme", model: "acme-model", thinkingLevel: "off", passed: true, challengeEchoed: true, ceiling: CANARY_MAX_TOKENS });
  // R8 and R9: what the child resolved and where its request actually went, as endpoint parts only.
  const port = Number(new URL(o.url).port);
  assert.deepEqual(observed.endpointIdentity, { scheme: "http", hostname: "127.0.0.1", port, pathname: "/v1" });
  assert.equal(observed.apiType, "openai-completions");
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0], { scheme: "http", hostname: "127.0.0.1", port, pathname: "/v1/chat/completions" });
  assert.equal(JSON.stringify(o.result).includes(CHALLENGE), false, "the single-use challenge was returned");
  assert.deepEqual(o.leftovers, [], "the canary's temporary root survived");

  // At the provider boundary: one request carried the challenge and was answered by the tool call, and the
  // tool result that came back is the fixed acknowledgement, which does not repeat the challenge.
  assert.ok(o.requests.length >= 1);
  const first = o.requests[0];
  assert.ok(JSON.stringify(first.messages).includes(CHALLENGE), "the request did not carry the challenge");
  const toolResults = o.requests.flatMap((r) => (r.messages ?? []).filter((m) => m.role === "tool"));
  for (const m of toolResults) assert.equal(JSON.stringify(m.content).includes(PREFLIGHT_ACKNOWLEDGEMENT), true);
  for (const m of toolResults) assert.equal(JSON.stringify(m.content).includes(CHALLENGE), false);
  // ⚠️ ONE CALL: the session is stopped after the preflight tool runs, so no request follows the tool result.
  assert.equal(o.requests.length, 1, "a further turn was requested after the canary's one call");
});

test("⚠️ ACC-0062 the canary offers exactly kiln_preflight, sends no project content, and uses a low token ceiling", async () => {
  const o = await canary(exact);
  assert.equal(o.refusal, null, o.refusal?.message);
  const first = o.requests[0];
  assert.deepEqual((first.tools ?? []).map((t) => t.function?.name).sort(), [PREFLIGHT_TOOL_NAME], "another tool was offered to the model");
  const offered = first.tools[0].function;
  assert.deepEqual(offered.parameters.required, ["challenge"]);
  assert.equal(offered.parameters.additionalProperties, false);
  assert.deepEqual(Object.keys(offered.parameters.properties), ["challenge"]);
  // The ceiling Pi sent is the canary's, not the model's 4096.
  const ceiling = first.max_completion_tokens ?? first.max_tokens;
  assert.equal(ceiling, CANARY_MAX_TOKENS, `the request's token ceiling is ${ceiling}`);
  // Only the canary's system prompt and request. No context file, skill, prompt template or planning text.
  const roles = first.messages.map((m) => m.role);
  assert.deepEqual(roles.filter((r) => r !== "system" && r !== "developer"), ["user"]);
  const system = first.messages.find((m) => m.role === "system" || m.role === "developer");
  assert.ok(JSON.stringify(system.content).includes(CANARY_SYSTEM_PROMPT));
  const all = JSON.stringify(first);
  assert.equal(all.includes(CONTEXT_SENTINEL), false, "a context file above the canary's working directory was sent");
  // `all` is JSON, so a Windows path appears with its backslashes escaped.
  for (const path of [ROOT.replace(/\\/g, "/"), JSON.stringify(ROOT).slice(1, -1)])
    assert.equal(all.includes(path), false, "the request names the project's directory");
  for (const forbidden of ["planning-content", "AGENTS.md", "CLAUDE.md", "SKILL.md", "kiln_create", "kiln_write", "bash", "research_search"])
    assert.equal(all.includes(forbidden), false, `the canary request mentions ${forbidden}`);
  // The credential travels as a header, never in the body.
  assert.equal(all.includes(KEY), false, "the key appeared in the request body");
});

test("⚠️ ACC-0061 prose, a malformed or extra argument, a wrong challenge, another tool, or two calls each fail", async () => {
  const cases = [
    ["prose", () => ({ content: "Yes, I support tool calls and would call kiln_preflight." }), LIVE_CANARY_REFUSAL.NO_TOOL_CALL],
    ["wrong challenge", () => ({ tool_calls: [call(PREFLIGHT_TOOL_NAME, { challenge: "f".repeat(32) })] }), LIVE_CANARY_REFUSAL.MALFORMED_CALL],
    ["extra argument", (seen) => ({ tool_calls: [call(PREFLIGHT_TOOL_NAME, { challenge: seen, extra: 1 })] }), LIVE_CANARY_REFUSAL.MALFORMED_CALL],
    ["no argument", () => ({ tool_calls: [call(PREFLIGHT_TOOL_NAME, {})] }), LIVE_CANARY_REFUSAL.MALFORMED_CALL],
    ["not JSON", () => ({ tool_calls: [call(PREFLIGHT_TOOL_NAME, "{challenge:")] }), LIVE_CANARY_REFUSAL.MALFORMED_CALL],
    ["number", () => ({ tool_calls: [call(PREFLIGHT_TOOL_NAME, { challenge: 12345 })] }), LIVE_CANARY_REFUSAL.MALFORMED_CALL],
    ["another tool", (seen) => ({ tool_calls: [call("kiln_write", { challenge: seen })] }), LIVE_CANARY_REFUSAL.WRONG_TOOL],
    ["two calls", (seen) => ({ tool_calls: [call(PREFLIGHT_TOOL_NAME, { challenge: seen }, 0), call(PREFLIGHT_TOOL_NAME, { challenge: seen }, 1)] }), LIVE_CANARY_REFUSAL.TOO_MANY_CALLS],
  ];
  for (const [label, answer, reason] of cases) {
    const o = await canary(answer);
    assert.equal(o.result, null, `${label} passed`);
    assert.equal(o.refusal?.reason, reason, `${label}: ${o.refusal?.message}`);
    assert.equal(o.refusal.message.includes(CHALLENGE), false, `${label}: the refusal repeated the challenge`);
    assert.deepEqual(o.leftovers, [], `${label}: the canary's temporary root survived`);
  }
});

test("a model the registry does not hold is refused before any request is sent", async () => {
  const o = await canary(exact, { model: "acme-missing" });
  assert.equal(o.refusal?.reason, LIVE_CANARY_REFUSAL.MODEL_NOT_FOUND);
  assert.equal(o.requests.length, 0);
});

test("the success predicate and the judge refuse an unbounded tool set and every inexact call", () => {
  const ids = { provider: "acme", model: "acme-model", thinkingLevel: "off" };
  const report = (over) => ({ model: "found", registeredTools: [PREFLIGHT_TOOL_NAME], activeTools: [PREFLIGHT_TOOL_NAME], calls: [{ name: PREFLIGHT_TOOL_NAME, args: { challenge: CHALLENGE } }], ceiling: CANARY_MAX_TOKENS, ...over });
  assert.equal(judgeLiveReport(report({}), CHALLENGE, ids).passed, true);
  for (const tools of [[PREFLIGHT_TOOL_NAME, "bash"], ["read"], []])
    assert.throws(() => judgeLiveReport(report({ registeredTools: tools }), CHALLENGE, ids), (e) => e.reason === LIVE_CANARY_REFUSAL.TOOL_SET_NOT_BOUNDED);
  assert.throws(() => judgeLiveReport(report({ activeTools: [PREFLIGHT_TOOL_NAME, "kiln_write"] }), CHALLENGE, ids), (e) => e.reason === LIVE_CANARY_REFUSAL.TOOL_SET_NOT_BOUNDED);
  assert.throws(() => judgeLiveReport(report({ calls: [{ name: PREFLIGHT_TOOL_NAME, oversized: true }] }), CHALLENGE, ids), (e) => e.reason === LIVE_CANARY_REFUSAL.MALFORMED_CALL);
  assert.equal(isExactChallengeCall({ name: PREFLIGHT_TOOL_NAME, args: { challenge: CHALLENGE.toUpperCase() } }, CHALLENGE), false);
  assert.equal(isExactChallengeCall({ name: PREFLIGHT_TOOL_NAME, args: [CHALLENGE] }, CHALLENGE), false);
  assert.equal(isExactChallengeCall({ name: PREFLIGHT_TOOL_NAME, args: { challenge: "short" } }, "short"), false, "a challenge not of the declared shape passed");
});

test("⚠️ ACC-0062 kiln_preflight is absent from the user-facing session and every specialist, and its module imports nothing", async () => {
  // The package neither registers nor declares it, so the user-facing allowlist cannot carry it.
  const declared = await declaredToolNames();
  assert.equal(declared.includes(PREFLIGHT_TOOL_NAME), false, "the package declares the preflight tool");
  assert.equal(KNOWN_TOOL_NAMES.includes(PREFLIGHT_TOOL_NAME), false, "the orchestrator's known tool names include the preflight tool");
  const launched = withToolAllowlist({ command: process.execPath, args: ["pi"] }, await piToolAllowlist(ROOT));
  const allowlist = launched.args[launched.args.indexOf("--tools") + 1].split(",");
  assert.equal(allowlist.includes(PREFLIGHT_TOOL_NAME), false, "the user-facing session's allowlist includes the preflight tool");
  assert.ok(allowlist.length > 0);

  // No source outside the canary's own three files names the tool.
  const allowed = new Set(["preflight-tool.mjs", "live-canary.mjs", "live-canary-child.mjs"]);
  const scan = (dir) =>
    readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
      d.isDirectory() ? (d.name === "node_modules" ? [] : scan(join(dir, d.name))) : /\.(mjs|js|json|md)$/.test(d.name) ? [join(dir, d.name)] : []
    );
  const mentions = [...scan(join(ROOT, "lib")), ...scan(join(ROOT, "pi-package")), ...scan(join(ROOT, "specialists"))].filter(
    (f) => !allowed.has(f.split(/[\\/]/).at(-1)) && readFileSync(f, "utf8").includes(PREFLIGHT_TOOL_NAME)
  );
  assert.deepEqual(mentions, [], "the preflight tool is named outside the canary");

  // ⚠️ THE TOOL'S MODULE IMPORTS NOTHING, so it can reach no content, mutation, research, validation, delegation or shell.
  const source = readFileSync(join(ROOT, "lib", "preflight-tool.mjs"), "utf8");
  assert.equal(/^\s*import\s/m.test(source) || /\bimport\s*\(/.test(source) || /\brequire\s*\(/.test(source), false, "lib/preflight-tool.mjs imports something");
  assert.deepEqual(PREFLIGHT_PARAMETERS.required, ["challenge"]);

  // ⚠️ THE ACKNOWLEDGEMENT IS FIXED, and says nothing about the challenge it was called with.
  const { preflightToolDefinition } = await import("../lib/preflight-tool.mjs");
  const seen = [];
  const def = preflightToolDefinition((c) => seen.push(c));
  for (const params of [{ challenge: CHALLENGE }, { challenge: "f".repeat(32) }, {}]) {
    const out = await def.execute("call_1", params);
    assert.deepEqual(out, { content: [{ type: "text", text: PREFLIGHT_ACKNOWLEDGEMENT }], details: {} });
  }
  assert.equal(seen.length, 3);
});

test("⚠️ a tool outside a session's allowlist cannot be activated there, measured on the pinned SDK", async () => {
  // The user-facing session is built with the package allowlist; this shows Pi will not activate a name that
  // allowlist leaves out, even when asked to, so removal before the user-facing session is structural.
  const { resolvePinnedSdk } = await import("../lib/pi-runtime.mjs");
  const { preflightToolDefinition } = await import("../lib/preflight-tool.mjs");
  const sdk = await import(resolvePinnedSdk(ROOT).url);
  const dir = mkdtempSync(join(tmpdir(), "kiln-live-canary-allow-"));
  try {
    const agentDir = join(dir, "agent");
    mkdirSync(agentDir);
    writeFileSync(join(agentDir, "auth.json"), "{}");
    const runtime = await sdk.ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json"), allowModelNetwork: false });
    const settingsManager = sdk.SettingsManager.inMemory({});
    const resourceLoader = new sdk.DefaultResourceLoader({ cwd: dir, agentDir, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
    await resourceLoader.reload();
    const { session } = await sdk.createAgentSession({
      cwd: dir,
      agentDir,
      modelRuntime: runtime,
      tools: ["read"],
      customTools: [preflightToolDefinition()],
      resourceLoader,
      settingsManager,
      sessionManager: sdk.SessionManager.inMemory(dir),
    });
    assert.equal(session.getAllTools().some((t) => t.name === PREFLIGHT_TOOL_NAME), false, "an allowlist without the tool still registered it");
    session.setActiveToolsByName(["read", PREFLIGHT_TOOL_NAME]);
    assert.equal(session.getActiveToolNames().includes(PREFLIGHT_TOOL_NAME), false, "the tool was activated outside the allowlist");
    session.dispose?.();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("⚠️ D14 a reasoning model at a non-off thinking level is held to the same token ceiling in the request Pi sends", async () => {
  const reasoner = (url) => ({
    baseUrl: url,
    api: "openai-completions",
    models: [{ id: "acme-model", name: "Acme Reasoner", contextWindow: 128000, maxTokens: 32000, reasoning: true }],
  });
  for (const thinkingLevel of ["low", "high"]) {
    const p = await provider(exact);
    const parent = mkdtempSync(join(tmpdir(), "kiln-live-canary-test-"));
    try {
      const result = await runLiveCanary({
        provider: "acme",
        model: "acme-model",
        thinkingLevel,
        custom: DECLARATION,
        customProviderConfig: reasoner(p.url),
        hostEnv: cleanHost(),
        tempParent: parent,
        randomBytes: () => FIXED,
      });
      assert.equal(result.passed, true);
      assert.equal(result.thinkingLevel, thinkingLevel);
      const [first] = p.requests;
      // The level really was sent, and the ceiling is the canary's, not the model's 32000.
      assert.equal(first.reasoning_effort, thinkingLevel, `thinking level ${thinkingLevel} was not sent`);
      const ceiling = first.max_completion_tokens ?? first.max_tokens;
      assert.equal(ceiling, CANARY_MAX_TOKENS, `at ${thinkingLevel} the request's token ceiling is ${ceiling}`);
    } finally {
      await p.close();
      rmSync(parent, { recursive: true, force: true });
    }
  }
});
