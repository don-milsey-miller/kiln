/**
 * ACC-0103: a new session opens with `/kiln-start`, and a resume opens with nothing — TSK-0058, measured with
 * nothing replaced.
 *
 * ⚠️ **A REAL TERMINAL, BECAUSE THAT IS WHERE THE START PROMPT IS SENT.** Pi runs interactive only when its input
 * and output are both terminals, and the supervisor sends the start prompt only then. Node cannot allocate a
 * pseudo-terminal, so the real `bin/start-kiln.mjs` runs under util-linux `script`, which gives it one. Windows has
 * no equivalent here, so this measurement is POSIX only; the argument list both platforms build is covered in
 * test/supervisor.test.mjs.
 *
 * ⚠️ **THE PROVIDER IS THE OBSERVATION.** TSK-0062's loopback fixture records every request. The first run must
 * reach it with Pi's own expansion of `/kiln-start` exactly once; the resume must reach it not at all before the
 * operator types anything.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FIXTURE_DONE, FIXTURE_KEY, FIXTURE_KEY_VAR, FIXTURE_MODEL, FIXTURE_PROVIDER, modelsJson, startProviderFixture } from "./helpers/provider-fixture.mjs";
import { withBuildLock } from "./helpers/build-lock.mjs";
import { blockText } from "../lib/project-gitignore.mjs";
import { resolvePinnedSdk } from "../lib/pi-runtime.mjs";
import { START_PROMPT } from "../lib/supervisor.mjs";

const ROOT = join(import.meta.dirname, "..");
const BOUND_MS = 5 * 60_000;
/** How long a resumed session is watched for a turn nobody typed, once Pi has drawn it. */
const QUIET_MS = 5000;

const hasScript = process.platform !== "win32" && spawnSync("script", ["--version"], { encoding: "utf-8" }).status === 0;

function run(args, opts) {
  return new Promise((done) => {
    const child = spawn(process.execPath, args, opts);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (status) => done({ status, stdout, stderr }));
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

const quote = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const plain = (s) => s.replace(/\x1b\][^\x07]*\x07/g, "").replace(/\x1b\[[0-9;?<>=]*[a-zA-Z~]/g, "").replace(/\r/g, "");

/**
 * The real launcher in a pseudo-terminal, quit by typing `/quit` once `ready(output)` says Pi has settled.
 * The quit is typed once only, and a run that never settles is killed at the bound and fails.
 */
function startInTerminal({ dir, env, ready, afterReadyMs }) {
  return new Promise((done) => {
    const command = [process.execPath, join(ROOT, "bin", "start-kiln.mjs")].map(quote).join(" ");
    const child = spawn("script", ["-qfec", command, "/dev/null"], { cwd: dir, env, stdio: ["pipe", "pipe", "pipe"] });
    let output = "";
    let quit = false;
    const onData = (d) => {
      output += d;
      if (!quit && ready(plain(output))) {
        quit = true;
        setTimeout(() => child.stdin.write("/quit\r"), afterReadyMs);
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    const bound = setTimeout(() => child.kill("SIGKILL"), BOUND_MS);
    child.on("close", (status, signal) => {
      clearTimeout(bound);
      done({ status, signal, output: plain(output), quit });
    });
  });
}

const userText = (body) =>
  (body?.messages ?? [])
    .filter((m) => m.role === "user")
    .map((m) => (typeof m.content === "string" ? m.content : (m.content ?? []).map((c) => c.text ?? "").join("")));

test(
  "⚠️ ACC-0103 the real launcher opens a new session with /kiln-start once, and a resume with nothing",
  { skip: hasScript ? false : "needs a pseudo-terminal from util-linux script, which this platform does not have", timeout: 2 * BOUND_MS + 120_000 },
  async () => {
    const sdk = await import(resolvePinnedSdk(ROOT).url);
    const startBody = sdk.parseFrontmatter(readFileSync(join(ROOT, "pi-package", "prompts", "kiln-start.md"), "utf8")).body;
    const offered = (req) => (req.tools ?? []).map((t) => t.function?.name ?? t.name);
    const echo = (req) =>
      offered(req).includes("kiln_preflight")
        ? { toolCalls: [{ name: "kiln_preflight", arguments: { challenge: /[0-9a-f]{32}/.exec(JSON.stringify(req.messages))?.[0] ?? "absent" } }] }
        : { text: FIXTURE_DONE };
    const fixture = await startProviderFixture({ script: [echo] });
    const root = mkdtempSync(join(tmpdir(), "kiln-start-entry-"));
    const dir = join(root, "project");
    const agentDir = join(root, "agent");
    try {
      mkdirSync(dir);
      mkdirSync(agentDir);
      execFileSync("git", ["init", "-q"], { cwd: dir });
      symlinkSync(ROOT, join(dir, ".planning"), "dir");
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
        TERM: "xterm-256color",
      };

      const setup = await run(
        [
          join(ROOT, "bin", "setup.mjs"),
          ...["--project-root", dir, "--name", "Start Entry", "--trust", "approve", "--inspect", "approve"],
          ...["--provider", FIXTURE_PROVIDER, "--model", FIXTURE_MODEL, "--thinking", "off", "--model-use", "approve"],
          ...["--research", "disabled", "--live-model-check", "approve", "--credential-var", FIXTURE_KEY_VAR, "--non-interactive"],
        ],
        { cwd: dir, env }
      );
      assert.equal(setup.status, 0, `${setup.stdout}${setup.stderr}`);
      const afterSetup = fixture.requests.length;
      assert.equal(afterSetup, 1, "setup's live check made other than one request");

      const [first, afterFirst, second] = await withBuildLock(async () => {
        // ⚠️ THE FIRST RUN IS QUIT ONLY AFTER THE PROVIDER HAS ANSWERED THE START TURN AND PI HAS SHOWN THE ANSWER.
        const one = await startInTerminal({
          dir,
          env,
          ready: (out) => fixture.requests.length > afterSetup && out.includes(FIXTURE_DONE),
          afterReadyMs: 1500,
        });
        const count = fixture.requests.length;
        // ⚠️ THE RESUME IS WATCHED FOR QUIET_MS AFTER PI HAS DRAWN THE SESSION, THEN QUIT. Anything sent in that
        // window was sent by nobody the operator could see.
        const two = await startInTerminal({
          dir,
          env,
          ready: (out) => /\[kiln\] session \S+ \(resumed from the record\)/.test(out) && out.includes(FIXTURE_MODEL) && out.lastIndexOf(FIXTURE_DONE) > out.indexOf("resumed from the record"),
          afterReadyMs: QUIET_MS,
        });
        return [one, count, two];
      });

      // ---- the new session ------------------------------------------------------------------------
      const firstOut = first.output;
      assert.match(firstOut, /\[kiln\] ready — identity confirmed/, firstOut);
      const newId = /\[kiln\] session (\S+) \(new, recorded\)/.exec(firstOut)?.[1];
      assert.ok(newId, `the first run did not record a new session: ${firstOut}`);
      assert.ok(firstOut.includes(`new session: Pi opens it with ${START_PROMPT}`), firstOut);
      const turns = fixture.requests.slice(afterSetup, afterFirst);
      assert.equal(turns.length, 1, `the first run made ${turns.length} provider requests, not one: ${firstOut}`);
      const [turn] = turns;
      assert.deepEqual(userText(turn.body), [startBody], "the one user turn is Pi's own expansion of /kiln-start, byte for byte");
      assert.ok(turn.authorized, "the request carried the declared variable's key");
      assert.ok(offered(turn.body).includes("kiln_project_status"), `Kiln's tools were not offered: ${offered(turn.body)}`);
      assert.match(firstOut, /\[kiln\] the agent exited \(code 0\)/, firstOut);
      assert.match(firstOut, /\[kiln\] stopped \(agent-exit\) — stop sent: true, stdin end requested: true, launcher exit observed: true, launcher tree stopped: true/, firstOut);
      assert.equal(first.signal, null, `the first run was killed at its bound: ${firstOut}`);
      assert.equal(first.status, 0, firstOut);
      assert.equal(await answers(port), false, `something still answers on port ${port} after the first run`);

      // ---- the resume --------------------------------------------------------------------------------
      const secondOut = second.output;
      assert.ok(second.quit, `the resumed session was never drawn: ${secondOut}`);
      const resumedId = /\[kiln\] session (\S+) \(resumed from the record\)/.exec(secondOut)?.[1];
      assert.equal(resumedId, newId, "the rerun resumed the exact session the first run recorded");
      assert.equal(secondOut.includes(`opens it with ${START_PROMPT}`), false, secondOut);
      assert.equal(fixture.requests.length, afterFirst, `the resume sent ${fixture.requests.length - afterFirst} request(s) nobody typed`);
      assert.match(secondOut, /\[kiln\] the agent exited \(code 0\)/, secondOut);
      assert.match(secondOut, /\[kiln\] stopped \(agent-exit\) — stop sent: true, stdin end requested: true, launcher exit observed: true, launcher tree stopped: true/, secondOut);
      assert.equal(second.signal, null, `the resume was killed at its bound: ${secondOut}`);
      assert.equal(second.status, 0, secondOut);
      assert.equal(await answers(port), false, `something still answers on port ${port} after the resume`);
    } finally {
      await fixture.close();
      rmSync(root, { recursive: true, force: true });
    }
  }
);
