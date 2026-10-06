/**
 * `start-kiln.mjs --rpc`: the real launcher with Pi in its RPC mode - #177.
 *
 * `test/pi-rpc-structured.test.mjs` proves what Pi's RPC mode writes when Kiln's flag is on the agent's command.
 * This proves the command an integration actually runs: the launch checks, the supervisor, the browser launcher and
 * Pi all share one process tree, and only Pi may write to standard output.
 *
 * ⚠️ **EVERY LINE OF STANDARD OUTPUT IS ONE JSON EVENT.** Kiln's own `[kiln]` notices and the launcher's output are
 * on standard error. One stray line would be a line a client cannot parse.
 *
 * ⚠️ **THE DEFAULT IS UNCHANGED, AND `--rpc` IS NEVER INFERRED.** The piped route without the flag is
 * `test/piped-stage1-route.test.mjs`, which still gets Pi's print mode and `[kiln]` lines on standard output.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FIXTURE_KEY, FIXTURE_KEY_VAR, FIXTURE_MODEL, FIXTURE_PROVIDER, modelsJson, startProviderFixture } from "./helpers/provider-fixture.mjs";
import { withBuildLock } from "./helpers/build-lock.mjs";
import { removeTestTree } from "./helpers/cleanup.mjs";
import { blockText } from "../lib/project-gitignore.mjs";
import { START_PROMPT } from "../lib/supervisor.mjs";

const ROOT = join(import.meta.dirname, "..");
const BOUND_MS = 4 * 60_000;
const QUESTION = "RPC-START-QUESTION-51c7: what problem are you solving?";
const ESC = "\u001b";

async function freePort() {
  const server = createServer();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  await new Promise((r) => server.close(r));
  return port;
}

function run(args, opts) {
  return new Promise((done) => {
    const child = spawn(process.execPath, args, { ...opts, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("close", (status) => done({ status, out }));
  });
}

test("⚠️ #177 start-kiln --rpc gives a client Pi's JSON protocol on standard output and nothing else", { timeout: 2 * BOUND_MS + 120_000 }, async () => {
  const offered = (req) => (req.tools ?? []).map((t) => t.function?.name ?? t.name);
  // Setup's canary is answered with its tool; the one turn calls kiln_project_status once, then asks.
  const first = (req) =>
    offered(req).includes("kiln_preflight")
      ? { toolCalls: [{ name: "kiln_preflight", arguments: { challenge: /[0-9a-f]{32}/.exec(JSON.stringify(req.messages))?.[0] ?? "absent" } }] }
      : { toolCalls: [{ name: "kiln_project_status", arguments: {} }] };
  const fixture = await startProviderFixture({ script: [first, { text: QUESTION }] });
  const root = mkdtempSync(join(tmpdir(), "kiln-rpc-start-"));
  const dir = join(root, "project");
  const agentDir = join(root, "agent");
  try {
    mkdirSync(dir);
    mkdirSync(agentDir);
    execFileSync("git", ["init", "-q"], { cwd: dir });
    symlinkSync(ROOT, join(dir, ".planning"), process.platform === "win32" ? "junction" : "dir");
    writeFileSync(join(dir, ".gitignore"), blockText());
    writeFileSync(join(agentDir, "auth.json"), "{}");
    writeFileSync(join(agentDir, "models.json"), JSON.stringify(modelsJson(fixture.url)));
    const env = { ...process.env, PI_CODING_AGENT_DIR: agentDir, PLANNING_CONTENT_DIR: join(dir, "planning-content"), PORT: String(await freePort()), [FIXTURE_KEY_VAR]: FIXTURE_KEY, PI_OFFLINE: "1" };

    const setup = await run(
      [
        join(ROOT, "bin", "setup.mjs"),
        ...["--project-root", dir, "--name", "RPC Start", "--trust", "approve", "--inspect", "approve"],
        ...["--provider", FIXTURE_PROVIDER, "--model", FIXTURE_MODEL, "--thinking", "off", "--model-use", "approve"],
        ...["--research", "disabled", "--live-model-check", "approve", "--credential-var", FIXTURE_KEY_VAR, "--non-interactive"],
      ],
      { cwd: dir, env }
    );
    assert.equal(setup.status, 0, setup.out);

    await withBuildLock(async () => {
      const before = fixture.requests.length;
      const child = spawn(process.execPath, [join(ROOT, "bin", "start-kiln.mjs"), "--rpc"], { cwd: dir, env, stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => (stdout += d));
      child.stderr.on("data", (d) => (stderr += d));
      const exited = new Promise((done) => child.on("close", (status, signal) => done({ status, signal })));
      const bound = setTimeout(() => child.kill(), BOUND_MS);
      const seen = (needle) =>
        new Promise((resolve, reject) => {
          const timer = setInterval(() => {
            if (stdout.includes(needle)) {
              clearInterval(timer);
              resolve();
            } else if (child.exitCode !== null) {
              clearInterval(timer);
              reject(new Error(`start-kiln exited before ${needle}:\n${stdout.slice(-1500)}\n${stderr.slice(-3000)}`));
            }
          }, 200);
        });

      // ⚠️ A COMMAND, WRITTEN AS SOON AS THE PROCESS EXISTS. It waits in the pipe through the launch checks and the
      // launcher's start, and Pi reads it when its RPC loop begins. The supervisor sends no start prompt of its own.
      child.stdin.write(`${JSON.stringify({ id: "start", type: "prompt", message: START_PROMPT })}\n`);
      await seen('"type":"agent_settled"');
      // Closing the protocol's input is how a client ends the session.
      child.stdin.end();
      const exit = await exited;
      clearTimeout(bound);
      const all = `${stdout}\n--- stderr ---\n${stderr}`;
      assert.equal(exit.signal, null, `the run was killed at its bound:\n${all.slice(-4000)}`);
      assert.equal(exit.status, 0, all.slice(-4000));

      // ⚠️ STANDARD OUTPUT: JSON EVENTS AND NOTHING ELSE.
      const lines = stdout.split("\n").filter((line) => line.trim().length > 0);
      assert.ok(lines.length > 5, `standard output carried ${lines.length} lines`);
      for (const line of lines) {
        let event = null;
        try {
          event = JSON.parse(line);
        } catch {
          assert.fail(`a line of standard output is not JSON: ${line.slice(0, 200)}`);
        }
        assert.equal(typeof event.type, "string", `an event has no type: ${line.slice(0, 200)}`);
      }
      assert.equal(stdout.includes(ESC), false, "standard output carries an escape sequence");
      assert.equal(stdout.includes("[kiln]"), false, "a Kiln notice is on standard output");
      assert.equal(stdout.includes("[vpw]"), false, "the launcher's output is on standard output");

      // Kiln's notices and the launcher's output are still said, on standard error.
      assert.match(stderr, /\[kiln\] launch checks passed/);
      assert.match(stderr, /\[kiln\] session \S+ \(new, recorded\)/);
      assert.ok(stderr.includes(`new session: no ${START_PROMPT}, because Pi's input or output is not a terminal`), stderr.slice(-2000));
      assert.match(stderr, /\[kiln\] stopped \(agent-exit\)/);
      assert.ok(stderr.includes("[vpw]"), "the launcher's output went nowhere");

      // The turn was a real one: the response to the command, the status call, the question, all as events.
      const events = lines.map((line) => JSON.parse(line));
      assert.ok(events.some((e) => e.type === "response" && e.command === "prompt" && e.success === true), "the prompt command was not acknowledged");
      assert.ok(events.some((e) => e.type === "tool_execution_end" && e.toolName === "kiln_project_status" && e.isError !== true), "kiln_project_status did not run");
      assert.ok(stdout.includes(QUESTION), "the model's question is not in the event stream");
      const requests = fixture.requests.slice(before);
      assert.equal(requests.length, 2, `the turn made ${requests.length} provider requests, not two`);
      for (const request of requests) assert.ok(request.authorized);
    });
  } finally {
    await fixture.close();
    removeTestTree(root, "#177 start-kiln --rpc");
  }
});
