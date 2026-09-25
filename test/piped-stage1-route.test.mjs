/**
 * TSK-0063's no-terminal route: a Stage 1 exchange reached and continued through the real launcher with piped input.
 *
 * ⚠️ **WHY THIS ROUTE, AND WHAT IT IS NOT.** Windows CI has no terminal, and without one Pi runs in print mode: it
 * reads its input to the end, runs it as one prompt and exits. The supervisor sends no start prompt then (ACC-0103),
 * so the first run's piped input is `/kiln-start` itself, which Pi expands because the message starts with `/`. Each
 * later run resumes the recorded session and pipes the next answer. This is how an automated journey reaches and
 * continues Stage 1; an operator's interactive session is observed elsewhere (ACC-0103's terminal control, ACC-0088).
 *
 * ⚠️ **THE PROVIDER IS THE OBSERVATION.** Every turn calls `kiln_project_status` once and then asks a question, so each
 * request shows whether the session carried the earlier turns, Kiln's real tool results and the question asked.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FIXTURE_KEY, FIXTURE_KEY_VAR, FIXTURE_MODEL, FIXTURE_PROVIDER, modelsJson, startProviderFixture } from "./helpers/provider-fixture.mjs";
import { withBuildLock } from "./helpers/build-lock.mjs";
import { blockText } from "../lib/project-gitignore.mjs";
import { resolvePinnedSdk } from "../lib/pi-runtime.mjs";
import { START_PROMPT } from "../lib/supervisor.mjs";
import { removeTestTree } from "./helpers/cleanup.mjs";

const ROOT = join(import.meta.dirname, "..");
/** The bound on one run: launch checks, the shell, one piped turn, and cleanup. */
const BOUND_MS = 3 * 60_000;
const QUESTION = "STAGE1-QUESTION-9f2a: what problem are you solving?";
const ANSWERS = ["ANSWER-ONE-4b1c: a planning tool for small teams", "ANSWER-TWO-77d0: they lose decisions in chat"];

/** Run a command with `input` piped and its input then closed, killed at the bound. */
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

const answers = (port) =>
  new Promise((done) => {
    const req = request({ host: "127.0.0.1", port, path: "/", timeout: 2000 }, (res) => {
      res.resume();
      done(true);
    });
    req.on("error", () => done(false));
    req.on("timeout", () => {
      req.destroy();
      done(false);
    });
    req.end();
  });

const text = (m) => (typeof m.content === "string" ? m.content : (m.content ?? []).map((c) => c.text ?? "").join(""));
const byRole = (body, role) => (body?.messages ?? []).filter((m) => m.role === role).map(text);

test("⚠️ TSK-0063 without a terminal, piped /kiln-start reaches Stage 1 and piped answers continue the same session", { timeout: 4 * BOUND_MS + 120_000 }, async () => {
  const sdk = await import(resolvePinnedSdk(ROOT).url);
  const startBody = sdk.parseFrontmatter(readFileSync(join(ROOT, "pi-package", "prompts", "kiln-start.md"), "utf8")).body;
  const offered = (req) => (req.tools ?? []).map((t) => t.function?.name ?? t.name);
  // Setup's canary is answered with its tool; every Stage 1 turn calls kiln_project_status once, then asks.
  const first = (req) =>
    offered(req).includes("kiln_preflight")
      ? { toolCalls: [{ name: "kiln_preflight", arguments: { challenge: /[0-9a-f]{32}/.exec(JSON.stringify(req.messages))?.[0] ?? "absent" } }] }
      : { toolCalls: [{ name: "kiln_project_status", arguments: {} }] };
  const fixture = await startProviderFixture({ script: [first, { text: QUESTION }] });
  const root = mkdtempSync(join(tmpdir(), "kiln-piped-stage1-"));
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
    const port = await freePort();
    const env = {
      ...process.env,
      PI_CODING_AGENT_DIR: agentDir,
      PLANNING_CONTENT_DIR: join(dir, "planning-content"),
      PORT: String(port),
      [FIXTURE_KEY_VAR]: FIXTURE_KEY,
      PI_OFFLINE: "1",
    };

    const setup = await run(
      [
        join(ROOT, "bin", "setup.mjs"),
        ...["--project-root", dir, "--name", "Piped Stage One", "--trust", "approve", "--inspect", "approve"],
        ...["--provider", FIXTURE_PROVIDER, "--model", FIXTURE_MODEL, "--thinking", "off", "--model-use", "approve"],
        ...["--research", "disabled", "--live-model-check", "approve", "--credential-var", FIXTURE_KEY_VAR, "--non-interactive"],
      ],
      { cwd: dir, env }
    );
    assert.equal(setup.status, 0, setup.out);
    assert.equal(fixture.requests.length, 1, "setup's live check made other than one request");

    await withBuildLock(async () => {
      let sessionId = null;
      for (const [turn, input] of [START_PROMPT, ...ANSWERS].entries()) {
        const before = fixture.requests.length;
        const r = await run([join(ROOT, "bin", "start-kiln.mjs")], { cwd: dir, env }, `${input}\n`);
        const label = `run ${turn + 1} (${input})`;
        assert.equal(r.signal, null, `${label} was killed at its bound: ${r.out}`);
        assert.equal(r.status, 0, `${label}: ${r.out}`);

        // The session: new on the first run, with no start prompt sent by the supervisor; the same one resumed after.
        const session = /\[kiln\] session (\S+) \(([^)]*)\)/.exec(r.stdout);
        assert.ok(session, `${label} recorded no session: ${r.out}`);
        if (turn === 0) {
          assert.equal(session[2], "new, recorded", r.out);
          assert.ok(r.stdout.includes(`new session: no ${START_PROMPT}, because Pi's input or output is not a terminal`), r.out);
          sessionId = session[1];
        } else {
          assert.equal(session[2], "resumed from the record", r.out);
          assert.equal(session[1], sessionId, `${label} resumed a different session`);
        }

        // ⚠️ ONE TURN PER RUN: the status call and the question, carrying every earlier turn.
        const requests = fixture.requests.slice(before);
        assert.equal(requests.length, 2, `${label} made ${requests.length} provider requests, not two: ${r.out}`);
        for (const q of requests) assert.ok(q.authorized, `${label}: a request did not carry the declared variable's key`);
        const last = requests[1].body;
        const users = byRole(last, "user");
        assert.equal(users.length, turn + 1, `${label}: the session did not carry the earlier turns`);
        assert.equal(users[0], startBody, `${label}: the first user turn is Pi's own expansion of ${START_PROMPT}, byte for byte`);
        if (turn > 0) assert.equal(users[turn], ANSWERS[turn - 1], `${label}: the piped answer is this turn`);
        assert.equal(byRole(last, "assistant").filter((t) => t === QUESTION).length, turn, `${label}: the earlier questions are in the history`);
        const results = byRole(last, "tool");
        assert.equal(results.length, turn + 1, `${label}: one status result per turn`);
        const status = JSON.parse(results.at(-1));
        assert.equal(status.ok, true, `${label}: kiln_project_status refused: ${results.at(-1)}`);
        assert.equal(status.artifactCount, 0, results.at(-1));
        assert.ok(JSON.stringify(status.blockers).includes("Stage 01-intake"), `${label}: the project is not at Stage 1: ${results.at(-1)}`);
        assert.ok(r.stdout.includes(QUESTION), `${label}: Pi did not print the question: ${r.out}`);

        assert.match(r.stdout, /\[kiln\] stopped \(agent-exit\) — stop sent: true, stdin end requested: true, launcher exit observed: true, launcher tree stopped: true/, r.out);
        assert.equal(await answers(port), false, `${label}: something still answers on port ${port}`);
      }
    });
  } finally {
    await fixture.close();
    removeTestTree(root, "TSK-0063 piped route");
  }
});
