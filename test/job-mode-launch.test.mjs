/**
 * Job mode end to end on Windows — F130 mechanism 2 (TSK-0058): the default, with no setting to turn it off (ACC-0081).
 *
 * ⚠️ **THE REAL COMMAND, PIPED, WITH NOTHING SET.** This runs ACC-0116's flow through the real bin/start-kiln.mjs as an
 * operator would, and job mode is what it gets: the provider must receive the piped prompt (input), Pi must print the provider's answer (output), and Pi must
 * be the model and tools it was told (arguments). The host's start-up time is printed for the record. The survivor case,
 * with the real host and a stand-in agent, is in test/supervisor.test.mjs.
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
const windowsOnly = { skip: process.platform === "win32" ? false : "job mode exists only on Windows" };

async function freePort() {
  const server = createServer();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  await new Promise((r) => server.close(r));
  return port;
}

test("⚠️ F130 JOB MODE the real launcher runs a piped Pi inside a job: its input, output and arguments pass, and the shutdown is complete", windowsOnly, async () => {
  const offered = (req) => (req.tools ?? []).map((t) => t.function?.name ?? t.name);
  const echo = (req) =>
    offered(req).includes("kiln_preflight")
      ? { toolCalls: [{ name: "kiln_preflight", arguments: { challenge: /[0-9a-f]{32}/.exec(JSON.stringify(req.messages))?.[0] ?? "absent" } }] }
      : { text: FIXTURE_DONE };
  const fixture = await startProviderFixture({ script: [echo] });
  const root = mkdtempSync(join(tmpdir(), "kiln-job-launch-"));
  const dir = join(root, "project");
  const agentDir = join(root, "agent");
  const PROMPT = "KILN-JOB-MODE-PROMPT-8d21";
  const run = (args, env, input = "") =>
    new Promise((done) => {
      const child = spawn(process.execPath, args, { cwd: dir, env, stdio: ["pipe", "pipe", "pipe"] });
      let out = "";
      child.stdout.on("data", (d) => (out += d));
      child.stderr.on("data", (d) => (out += d));
      const bound = setTimeout(() => child.kill(), 5 * 60_000);
      child.on("close", (status, signal) => {
        clearTimeout(bound);
        done({ status, signal, out });
      });
      child.stdin.end(input);
    });
  try {
    mkdirSync(dir);
    mkdirSync(agentDir);
    execFileSync("git", ["init", "-q"], { cwd: dir });
    symlinkSync(ROOT, join(dir, ".planning"), "junction");
    writeFileSync(join(dir, ".gitignore"), blockText());
    writeFileSync(join(agentDir, "auth.json"), "{}");
    writeFileSync(join(agentDir, "models.json"), JSON.stringify(modelsJson(fixture.url)));
    const port = await freePort();
    const env = { ...process.env, PI_CODING_AGENT_DIR: agentDir, PLANNING_CONTENT_DIR: join(dir, "planning-content"), PORT: String(port), [FIXTURE_KEY_VAR]: FIXTURE_KEY, PI_OFFLINE: "1" };
    const setup = await run(
      [
        join(ROOT, "bin", "setup.mjs"),
        ...["--project-root", dir, "--name", "Job Mode", "--trust", "approve", "--inspect", "approve"],
        ...["--provider", FIXTURE_PROVIDER, "--model", FIXTURE_MODEL, "--thinking", "off", "--model-use", "approve"],
        ...["--research", "disabled", "--live-model-check", "approve", "--credential-var", FIXTURE_KEY_VAR, "--non-interactive"],
      ],
      env
    );
    assert.equal(setup.status, 0, setup.out);

    const started = await withBuildLock(() => run([join(ROOT, "bin", "start-kiln.mjs")], env, `${PROMPT}\n`));
    console.log(`[job mode launch] ${(/agent started inside a job by its host in \d+ ms/.exec(started.out) ?? ["no host line"])[0]}`);
    assert.match(started.out, /launcher started inside a job by its host in \d+ ms/, started.out);
    assert.match(started.out, /agent started inside a job by its host in \d+ ms/, started.out);
    const turn = fixture.requests.slice(1).find((r) => JSON.stringify(r.body?.messages ?? []).includes(PROMPT));
    assert.ok(turn, `the piped prompt did not reach the provider: ${started.out}`);
    assert.equal(turn.body.model, FIXTURE_MODEL, "Pi was the model it was told to be");
    assert.ok(offered(turn.body).includes("kiln_project_status"), "and had the tools it was allowed");
    assert.ok(started.out.includes(FIXTURE_DONE), "Pi's output reached the terminal through the host");
    assert.match(started.out, /\[kiln\] stopped \(agent-exit\) — stop sent: true, stdin end requested: true, launcher exit observed: true, launcher tree stopped: true/, started.out);
    assert.equal(started.status, 0, started.out);
  } finally {
    await fixture.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 17, retryDelay: 100 });
  }
});
