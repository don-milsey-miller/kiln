/**
 * ACC-0117: the live canary proves the request a custom provider's `compat` makes — TSK-0073, measured against the
 * loopback provider with nothing replaced.
 *
 * ⚠️ **THE PROVIDER SEES THE DIFFERENCE.** For a loopback URL Pi's defaults send `store: false` and `stream_options`,
 * and name the token limit `max_completion_tokens`. The `compat` below turns all three off or around, so each request
 * body says whether it was built from that configuration. The canary's request, setup's compatibility record and the
 * started Pi's own request must all agree with it.
 *
 * ⚠️ **AND A CHANGED `compat` INVALIDATES THE PROOF.** The compatibility key includes the resolved `compat`, so after the
 * operator changes it, the record setup wrote no longer proves the launch, and the launch refuses rather than starting
 * on a proof of a different request.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FIXTURE_DONE, FIXTURE_KEY, FIXTURE_KEY_VAR, FIXTURE_MODEL, FIXTURE_PROVIDER, modelsJson, startProviderFixture } from "./helpers/provider-fixture.mjs";
import { withBuildLock } from "./helpers/build-lock.mjs";
import { blockText } from "../lib/project-gitignore.mjs";

const ROOT = join(import.meta.dirname, "..");
const BOUND_MS = 5 * 60_000;
const COMPAT = { supportsStore: false, supportsUsageInStreaming: false, maxTokensField: "max_tokens" };
const PROMPT = "KILN-COMPAT-PROMPT-3e81";

function run(args, opts, input = "") {
  return new Promise((done) => {
    const child = spawn(process.execPath, args, { ...opts, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    const bound = setTimeout(() => child.kill(), BOUND_MS);
    child.on("close", (status, signal) => {
      clearTimeout(bound);
      done({ status, signal, stdout, stderr, out: `${stdout}\n${stderr}` });
    });
    child.stdin.end(input);
  });
}

async function freePort() {
  const server = createServer();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  await new Promise((r) => server.close(r));
  return port;
}

/** The request fields this `compat` decides, as the provider received them. */
const shaped = (body) => ({
  store: Object.hasOwn(body, "store"),
  streamOptions: Object.hasOwn(body, "stream_options"),
  maxTokens: Object.hasOwn(body, "max_tokens"),
  maxCompletionTokens: Object.hasOwn(body, "max_completion_tokens"),
});
const COMPAT_SHAPE = { store: false, streamOptions: false, maxTokens: true, maxCompletionTokens: false };

test("⚠️ ACC-0117 the canary sends the request a custom provider's compat makes, the record describes it, and a changed compat invalidates it", { timeout: 2 * BOUND_MS + 60_000 }, async () => {
  const offered = (req) => (req.tools ?? []).map((t) => t.function?.name ?? t.name);
  const echo = (req) =>
    offered(req).includes("kiln_preflight")
      ? { toolCalls: [{ name: "kiln_preflight", arguments: { challenge: /[0-9a-f]{32}/.exec(JSON.stringify(req.messages))?.[0] ?? "absent" } }] }
      : { text: FIXTURE_DONE };
  const fixture = await startProviderFixture({ script: [echo] });
  const root = mkdtempSync(join(tmpdir(), "kiln-custom-compat-"));
  const dir = join(root, "project");
  const agentDir = join(root, "agent");
  try {
    mkdirSync(dir);
    mkdirSync(agentDir);
    execFileSync("git", ["init", "-q"], { cwd: dir });
    symlinkSync(ROOT, join(dir, ".planning"), process.platform === "win32" ? "junction" : "dir");
    writeFileSync(join(dir, ".gitignore"), blockText());
    writeFileSync(join(agentDir, "auth.json"), "{}");
    writeFileSync(join(agentDir, "models.json"), JSON.stringify(modelsJson(fixture.url, { compat: COMPAT })));
    const port = await freePort();
    const env = { ...process.env, PI_CODING_AGENT_DIR: agentDir, PLANNING_CONTENT_DIR: join(dir, "planning-content"), PORT: String(port), [FIXTURE_KEY_VAR]: FIXTURE_KEY, PI_OFFLINE: "1" };

    // ---- setup's live check runs in a child that has the resolved compat ----------------------------------------
    const setup = await run(
      [
        join(ROOT, "bin", "setup.mjs"),
        ...["--project-root", dir, "--name", "Custom Compat", "--trust", "approve", "--inspect", "approve"],
        ...["--provider", FIXTURE_PROVIDER, "--model", FIXTURE_MODEL, "--thinking", "off", "--model-use", "approve"],
        ...["--research", "disabled", "--live-model-check", "approve", "--credential-var", FIXTURE_KEY_VAR, "--non-interactive"],
      ],
      { cwd: dir, env }
    );
    assert.equal(setup.status, 0, setup.out);
    assert.equal(fixture.requests.length, 1, "setup's live check made other than one request");
    const canary = fixture.requests[0];
    assert.ok(canary.authorized, "the canary's request carried the declared variable's key");
    assert.deepEqual(shaped(canary.body), COMPAT_SHAPE, `the canary's request was not built from the compat: ${Object.keys(canary.body)}`);

    // The record setup wrote describes a request made with that compat.
    const record = JSON.parse(readFileSync(join(dir, ".pi", "runtime", "model-compatibility.json"), "utf-8"));
    const recorded = JSON.stringify(record);
    for (const [k, v] of Object.entries(COMPAT)) assert.ok(recorded.includes(`"${k}":${JSON.stringify(v)}`), `the record does not carry compat ${k}`);

    // ---- the started Pi makes the same request -----------------------------------------------------------------
    const started = await withBuildLock(() => run([join(ROOT, "bin", "start-kiln.mjs")], { cwd: dir, env }, `${PROMPT}\n`));
    assert.equal(started.status, 0, started.out);
    assert.match(started.stdout, /compatibility proved by this computer's record/, started.out);
    const turn = fixture.requests.slice(1).find((r) => JSON.stringify(r.body?.messages ?? []).includes(PROMPT));
    assert.ok(turn, `the started Pi did not send the prompt: ${started.out}`);
    assert.deepEqual(shaped(turn.body), COMPAT_SHAPE, "the project's own request is the request the canary proved");

    // ---- a changed compat invalidates the proof ----------------------------------------------------------------
    writeFileSync(join(agentDir, "models.json"), JSON.stringify(modelsJson(fixture.url, { compat: { ...COMPAT, maxTokensField: "max_completion_tokens" } })));
    const before = fixture.requests.length;
    const changed = await run([join(ROOT, "bin", "start-kiln.mjs")], { cwd: dir, env }, `${PROMPT}\n`);
    assert.equal(changed.status, 2, changed.out);
    assert.match(changed.out, /taken under different conditions/, changed.out);
    assert.equal(fixture.requests.length, before, "a launch refused on its proof contacted the provider");
  } finally {
    await fixture.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 17, retryDelay: 100 });
  }
});
