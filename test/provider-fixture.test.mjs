/**
 * The deterministic, non-billable provider fixture — TSK-0062, toward ACC-0086.
 *
 * ⚠️ **PROVED THROUGH THE PINNED RUNTIME, NOT AGAINST A MOCK OF IT.** The fixture is resolved from a real
 * `models.json` by Pi's own `ModelRegistry`, answered through Pi's own CLI and `openai-completions` client, and
 * driven through Kiln's real live canary. What Pi sent is read at the provider boundary.
 *
 * ⚠️ **WHAT THIS DOES NOT PROVE.** No Kiln project is launched against the fixture: `bin/start-kiln.mjs` cannot
 * yet start a custom provider (TSK-0037). The Stage 1 exchange through it is TSK-0063's to drive.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  FIXTURE_DONE,
  FIXTURE_KEY,
  FIXTURE_KEY_VAR,
  FIXTURE_MODEL,
  FIXTURE_PROVIDER,
  modelsJson,
  positionIn,
  startProviderFixture,
} from "./helpers/provider-fixture.mjs";
import { resolvePinnedAgent, resolvePinnedSdk } from "../lib/pi-runtime.mjs";
import { runLiveCanary } from "../lib/live-canary.mjs";
import { BASE_ENV } from "../lib/specialists/contract.mjs";
import { PREFLIGHT_TOOL_NAME } from "../lib/preflight-tool.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const QUALIFIED = `${FIXTURE_PROVIDER}/${FIXTURE_MODEL}`;

/** The base environment only, so no operator credential reaches a child. */
function cleanHost(extra = {}) {
  const out = {};
  for (const name of new Set([...BASE_ENV.win32, ...BASE_ENV.posix])) if (process.env[name] !== undefined) out[name] = process.env[name];
  return { ...out, ...extra };
}

/** POST a chat completion to the fixture and return the status and the exact body bytes. */
async function post(url, body, { key = FIXTURE_KEY } = {}) {
  const res = await fetch(`${url}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) },
    body: JSON.stringify(body),
  });
  return { status: res.status, text: await res.text() };
}

const READ_NOTE = { toolCalls: [{ name: "read", arguments: { path: "note.txt" } }] };

test("the answer is a function of the conversation: identical requests get identical bytes, and a tool call is issued once", async () => {
  const fixture = await startProviderFixture({ script: [READ_NOTE] });
  try {
    const fresh = { model: FIXTURE_MODEL, stream: true, messages: [{ role: "user", content: "read note.txt" }] };
    const first = await post(fixture.url, fresh);
    const again = await post(fixture.url, fresh);
    assert.equal(first.status, 200);
    assert.equal(again.text, first.text, "a repeated request was answered differently");
    assert.match(first.text, /"tool_calls":\[\{"index":0,"id":"call_0_0","type":"function","function":\{"name":"read","arguments":"\{\\"path\\":\\"note.txt\\"\}"\}\}\]/);
    assert.match(first.text, /"finish_reason":"tool_calls"/);
    assert.ok(first.text.endsWith("data: [DONE]\n\n"));

    // ⚠️ THE CONTROL FOR THE LOOP TRAP: the triggering text is still in the conversation, and a tool result is now
    // after it. The fixture answers with prose, not with the same call again.
    const answered = {
      ...fresh,
      messages: [
        ...fresh.messages,
        { role: "assistant", content: null, tool_calls: [{ id: "call_0_0", type: "function", function: { name: "read", arguments: "{}" } }] },
        { role: "tool", tool_call_id: "call_0_0", content: "contents" },
      ],
    };
    assert.equal(positionIn(answered), 1);
    const settled = await post(fixture.url, answered);
    assert.equal(settled.status, 200);
    assert.ok(settled.text.includes(`"content":"${FIXTURE_DONE}"`), settled.text);
    assert.ok(!settled.text.includes("tool_calls"), "a tool call was re-issued after its result");

    // A second user turn starts the script again.
    const nextTurn = { ...fresh, messages: [...answered.messages, { role: "assistant", content: FIXTURE_DONE }, { role: "user", content: "again" }] };
    assert.equal((await post(fixture.url, nextTurn)).text, first.text);
  } finally {
    await fixture.close();
  }
});

test("a request a real provider would refuse is refused, and the key is never recorded", async () => {
  const fixture = await startProviderFixture();
  try {
    const body = { model: FIXTURE_MODEL, stream: true, messages: [{ role: "user", content: "hi" }] };
    assert.equal((await post(fixture.url, body, { key: null })).status, 401);
    assert.equal((await post(fixture.url, body, { key: "wrong" })).status, 401);
    assert.equal((await post(fixture.url, { ...body, stream: false })).status, 400);
    assert.equal((await fetch(`${fixture.url}/models`)).status, 404);
    assert.equal(fixture.requests.length, 4);
    assert.ok(!JSON.stringify(fixture.requests).includes(FIXTURE_KEY), "the key was recorded");
  } finally {
    await fixture.close();
  }
});

test("⚠️ the pinned runtime resolves the fixture as a custom model, available only with its key variable set", async () => {
  const sdk = await import(resolvePinnedSdk(ROOT).url);
  const fixture = await startProviderFixture();
  const dir = mkdtempSync(join(tmpdir(), "kiln-provider-fixture-registry-"));
  const saved = process.env[FIXTURE_KEY_VAR];
  try {
    writeFileSync(join(dir, "auth.json"), "{}");
    writeFileSync(join(dir, "models.json"), JSON.stringify(modelsJson(fixture.url)));
    const available = async () => {
      const runtime = await sdk.ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: join(dir, "models.json"), allowModelNetwork: false });
      const registry = new sdk.ModelRegistry(runtime);
      const model = registry.find(FIXTURE_PROVIDER, FIXTURE_MODEL);
      assert.ok(model, "the registry does not hold the fixture model");
      return { listed: registry.getAvailable().some((m) => `${m.provider}/${m.id}` === QUALIFIED), configured: registry.hasConfiguredAuth(model) };
    };

    // CONTROL: without the variable the model is configured but not available.
    delete process.env[FIXTURE_KEY_VAR];
    assert.deepEqual(await available(), { listed: false, configured: false });

    process.env[FIXTURE_KEY_VAR] = FIXTURE_KEY;
    assert.deepEqual(await available(), { listed: true, configured: true });
    assert.equal(fixture.requests.length, 0, "resolving the model contacted the provider");
  } finally {
    if (saved === undefined) delete process.env[FIXTURE_KEY_VAR];
    else process.env[FIXTURE_KEY_VAR] = saved;
    await fixture.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("⚠️ Pi's own CLI completes a turn with a tool call through the fixture, and the tool's result reaches it", async () => {
  const fixture = await startProviderFixture({ script: [READ_NOTE] });
  const base = mkdtempSync(join(tmpdir(), "kiln-provider-fixture-cli-"));
  const agentDir = join(base, "agent");
  const project = join(base, "project");
  const SENTINEL = "KILN-FIXTURE-NOTE-3e81";
  try {
    mkdirSync(agentDir);
    mkdirSync(project);
    writeFileSync(join(agentDir, "auth.json"), "{}");
    writeFileSync(join(agentDir, "models.json"), JSON.stringify(modelsJson(fixture.url)));
    writeFileSync(join(project, "note.txt"), `${SENTINEL}\n`);

    const agent = resolvePinnedAgent(ROOT);
    const args = [
      ...agent.args,
      ...["--model", QUALIFIED, "--mode", "json", "--no-session", "--offline", "--tools", "read"],
      ...["--no-extensions", "--no-skills", "--no-prompt-templates", "--no-context-files"],
      ...["-p", "read note.txt"],
    ];
    const child = spawn(agent.command, args, {
      cwd: project,
      env: cleanHost({ PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", [FIXTURE_KEY_VAR]: FIXTURE_KEY }),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    // ⚠️ BOUNDED, because the failure this fixture exists to prevent is a turn that never ends: a fixture that
    // re-issued the call would otherwise hang the suite instead of failing this test.
    const bound = setTimeout(() => child.kill(), 60_000);
    const code = await new Promise((done) => child.on("close", done));
    clearTimeout(bound);

    assert.equal(fixture.requests.length, 2, `expected a tool round and a closing turn; stderr: ${stderr}`);
    assert.ok(fixture.requests.every((r) => r.authorized && r.path === "/v1/chat/completions" && r.body.stream === true));
    assert.ok(fixture.requests.every((r) => r.body.model === FIXTURE_MODEL));
    // The call was executed by Pi and its result was sent back: the file's content reached the provider.
    const toolMessages = fixture.requests[1].body.messages.filter((m) => m.role === "tool");
    assert.equal(toolMessages.length, 1);
    assert.ok(JSON.stringify(toolMessages[0]).includes(SENTINEL), `the tool result did not carry the file: ${JSON.stringify(toolMessages[0])}`);
    assert.ok(stdout.includes(FIXTURE_DONE), "the closing prose was not in Pi's output");
    assert.equal(code, 0, `pi exited ${code}; stderr: ${stderr}`);
  } finally {
    await fixture.close();
    rmSync(base, { recursive: true, force: true });
  }
});

test("⚠️ the live canary passes through the fixture, which echoes only the challenge the request carries", async () => {
  // A function step: the challenge is this run's, so the fixture must read it from the request.
  const exactCall = (request) => {
    const challenge = /[0-9a-f]{32}/.exec(JSON.stringify(request.messages))?.[0] ?? "absent";
    return { toolCalls: [{ name: PREFLIGHT_TOOL_NAME, arguments: { challenge } }] };
  };
  const fixture = await startProviderFixture({ script: [exactCall] });
  const parent = mkdtempSync(join(tmpdir(), "kiln-provider-fixture-canary-"));
  try {
    const { baseUrl, api, models } = modelsJson(fixture.url).providers[FIXTURE_PROVIDER];
    const result = await runLiveCanary({
      provider: FIXTURE_PROVIDER,
      model: FIXTURE_MODEL,
      thinkingLevel: "off",
      custom: { id: FIXTURE_PROVIDER, apiKey: `$${FIXTURE_KEY_VAR}` },
      customProviderConfig: { baseUrl, api, models },
      hostEnv: cleanHost({ [FIXTURE_KEY_VAR]: FIXTURE_KEY }),
      tempParent: parent,
    });
    assert.equal(result.passed, true, JSON.stringify(result));
    assert.ok(fixture.requests.length >= 1 && fixture.requests.every((r) => r.authorized));
  } finally {
    await fixture.close();
    rmSync(parent, { recursive: true, force: true });
  }
});
