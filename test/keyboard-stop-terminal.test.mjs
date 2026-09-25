/**
 * The keyboard stop in a real POSIX terminal — F130, TSK-0058, ACC-0081's third trigger, measured with nothing replaced.
 *
 * ⚠️ **ONE CTRL+C, TYPED INTO A PSEUDO-TERMINAL, DURING A TURN.** The real `bin/start-kiln.mjs` runs under util-linux
 * `script`, which gives Pi a terminal on both ends, so Pi is interactive, holds the terminal in raw mode, and receives
 * Ctrl+C as the byte 0x03 — exactly as an operator's key arrives. The provider fixture holds the start turn open, the
 * byte is written once the turn has reached it, and nothing else is sent.
 *
 * ⚠️ **WHAT IS OBSERVED.** The supervisor must record the stop as `keyboard` (never a signal), print its completed
 * shutdown — the summary line is printed only for a shutdown observed complete within its budget, and anything else is
 * a refusal with status 2 — leave with status 1 within the eight-second deadline of the key, and leave the port free.
 * Windows is observed in Windows Terminal and recorded in TSK-0058; this is the POSIX platform's observation.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FIXTURE_DONE, FIXTURE_KEY, FIXTURE_KEY_VAR, FIXTURE_MODEL, FIXTURE_PROVIDER, modelsJson, startProviderFixture } from "./helpers/provider-fixture.mjs";
import { withBuildLock } from "./helpers/build-lock.mjs";
import { blockText } from "../lib/project-gitignore.mjs";

const ROOT = join(import.meta.dirname, "..");
/** The bound on the whole run: launch checks, the shell's build and start, Pi, and the supervisor's teardown. */
const BOUND_MS = 5 * 60_000;
/** ACC-0081's shutdown deadline, from the key. */
const DEADLINE_MS = 8000;
/** What `script` and process exit may add after the supervisor's own deadline, before the test sees the close. */
const EXIT_SLACK_MS = 2000;

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

test(
  "⚠️ F130 ACC-0081 one Ctrl+C typed into a POSIX terminal during a turn stops both trees as a keyboard stop, within the deadline",
  { skip: hasScript ? false : "needs a pseudo-terminal from util-linux script, which this platform does not have", timeout: BOUND_MS + 120_000 },
  async () => {
    // The canary is answered; the start turn is held until the run ends, so the key lands while it is in flight.
    const offered = (req) => (req.tools ?? []).map((t) => t.function?.name ?? t.name);
    let turnAt = null;
    let release;
    const released = new Promise((r) => (release = r));
    const step = async (req) => {
      if (offered(req).includes("kiln_preflight"))
        return { toolCalls: [{ name: "kiln_preflight", arguments: { challenge: /[0-9a-f]{32}/.exec(JSON.stringify(req.messages))?.[0] ?? "absent" } }] };
      turnAt ??= Date.now();
      await Promise.race([released, new Promise((r) => setTimeout(r, 60_000))]);
      return { text: FIXTURE_DONE };
    };
    const fixture = await startProviderFixture({ script: Array.from({ length: 10 }, () => step) });
    const root = mkdtempSync(join(tmpdir(), "kiln-keyboard-terminal-"));
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
        // No startup downloads of fd and ripgrep (test/kiln-start-entry.test.mjs).
        PI_OFFLINE: "1",
      };

      const setup = await run(
        [
          join(ROOT, "bin", "setup.mjs"),
          ...["--project-root", dir, "--name", "Keyboard Stop", "--trust", "approve", "--inspect", "approve"],
          ...["--provider", FIXTURE_PROVIDER, "--model", FIXTURE_MODEL, "--thinking", "off", "--model-use", "approve"],
          ...["--research", "disabled", "--live-model-check", "approve", "--credential-var", FIXTURE_KEY_VAR, "--non-interactive"],
        ],
        { cwd: dir, env }
      );
      assert.equal(setup.status, 0, `${setup.stdout}${setup.stderr}`);

      const ran = await withBuildLock(
        () =>
          new Promise((done) => {
            const command = [process.execPath, join(ROOT, "bin", "start-kiln.mjs")].map(quote).join(" ");
            const child = spawn("script", ["-qfec", command, "/dev/null"], { cwd: dir, env, stdio: ["pipe", "pipe", "pipe"] });
            let output = "";
            let keyAt = null;
            const onData = (d) => (output += d);
            child.stdout.on("data", onData);
            child.stderr.on("data", onData);
            // ⚠️ THE KEY GOES IN ONE SECOND AFTER THE TURN REACHED THE PROVIDER, while the provider still holds it.
            const watcher = setInterval(() => {
              if (keyAt !== null || turnAt === null || Date.now() - turnAt < 1000) return;
              keyAt = Date.now();
              child.stdin.write("\x03");
            }, 50);
            const bound = setTimeout(() => child.kill("SIGKILL"), BOUND_MS);
            child.on("close", (status, signal) => {
              clearInterval(watcher);
              clearTimeout(bound);
              done({ status, signal, output: plain(output), keyAt, closedAt: Date.now() });
            });
          })
      );
      release();
      const out = ran.output;
      console.log(`[keyboard terminal] turn ${turnAt ? "held" : "never reached the provider"}; key to close ${ran.keyAt ? ran.closedAt - ran.keyAt : "n/a"} ms`);

      assert.ok(turnAt !== null, `the start turn never reached the provider: ${out}`);
      assert.ok(ran.keyAt !== null, `Ctrl+C was never typed: ${out}`);
      assert.equal(ran.signal, null, `the run was killed at its bound: ${out}`);
      assert.match(out, /\[kiln\] stopped by Ctrl\+C at the keyboard/, out);
      assert.match(out, /\[kiln\] stopped \(keyboard\) — stop sent: true, stdin end requested: true, launcher exit observed: true, launcher tree stopped: true/, out);
      assert.equal(/interrupted by SIG/.test(out), false, "no signal is recorded for a key");
      assert.equal(ran.status, 1, `a keyboard stop leaves with 1, and a shutdown not observed complete with 2: ${out}`);
      assert.ok(ran.closedAt - ran.keyAt <= DEADLINE_MS + EXIT_SLACK_MS, `the run ended ${ran.closedAt - ran.keyAt} ms after the key`);
      assert.equal(await answers(port), false, `something still answers on port ${port}`);
    } finally {
      release?.();
      await fixture.close();
      rmSync(root, { recursive: true, force: true, maxRetries: 17, retryDelay: 100 });
    }
  }
);
