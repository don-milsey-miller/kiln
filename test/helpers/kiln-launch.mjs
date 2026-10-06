/**
 * The real launcher, in its structured mode, over a project that real setup prepared - #178.
 *
 * `start-kiln.mjs --rpc` after `setup.mjs`, against the scripted loopback provider. The launch checks, the
 * supervisor, the session record and guard, the browser launcher and Pi are all the real ones; only the provider
 * is replaced. A test sends RPC commands on standard input and reads Pi's events from standard output and the
 * supervisor's `[kiln]` notices from standard error.
 */

import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FIXTURE_KEY, FIXTURE_KEY_VAR, FIXTURE_MODEL, FIXTURE_PROVIDER } from "./provider-fixture.mjs";
import { scriptedProvider } from "./pi-session.mjs";
import { removeTestTree } from "./cleanup.mjs";
import { blockText } from "../../lib/project-gitignore.mjs";

const ROOT = join(import.meta.dirname, "..", "..");

async function freePort() {
  const server = createServer();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  await new Promise((r) => server.close(r));
  return port;
}

const run = (args, opts) =>
  new Promise((done) => {
    const child = spawn(process.execPath, args, { ...opts, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("close", (status) => done({ status, out }));
  });

/** Setup's live check: answer its challenge with the preflight tool, as the real fixtures do. */
const preflight = (request) => ({ tool: "kiln_preflight", arguments: { challenge: /[0-9a-f]{32}/.exec(JSON.stringify(request?.messages ?? ""))?.[0] ?? "absent" } });

/**
 * A project set up for real, with the loopback model declaring `contextWindow`.
 *
 * @returns {Promise<object>} `{dir, provider, env, pointer, transcripts, launch, close}`
 */
export async function kilnProject({ contextWindow = 128_000, label = "kiln launch" } = {}) {
  const provider = await scriptedProvider();
  const root = mkdtempSync(join(tmpdir(), "kiln-launch-"));
  const dir = join(root, "project");
  const agentDir = join(root, "agent");
  mkdirSync(dir);
  mkdirSync(agentDir);
  execFileSync("git", ["init", "-q"], { cwd: dir });
  symlinkSync(ROOT, join(dir, ".planning"), process.platform === "win32" ? "junction" : "dir");
  writeFileSync(join(dir, ".gitignore"), blockText());
  writeFileSync(join(agentDir, "auth.json"), "{}");
  writeFileSync(
    join(agentDir, "models.json"),
    JSON.stringify({
      providers: {
        [FIXTURE_PROVIDER]: {
          baseUrl: `http://127.0.0.1:${provider.port}/v1`,
          api: "openai-completions",
          apiKey: `$${FIXTURE_KEY_VAR}`,
          models: [{ id: FIXTURE_MODEL, name: "Kiln Fixture", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow, maxTokens: 4096 }],
        },
      },
    })
  );
  const env = { ...process.env, PI_CODING_AGENT_DIR: agentDir, PLANNING_CONTENT_DIR: join(dir, "planning-content"), PORT: String(await freePort()), [FIXTURE_KEY_VAR]: FIXTURE_KEY, PI_OFFLINE: "1" };

  provider.script.push(preflight);
  const setup = await run(
    [
      join(ROOT, "bin", "setup.mjs"),
      ...["--project-root", dir, "--name", "Kiln Launch", "--trust", "approve", "--inspect", "approve"],
      ...["--provider", FIXTURE_PROVIDER, "--model", FIXTURE_MODEL, "--thinking", "off", "--model-use", "approve"],
      ...["--research", "disabled", "--live-model-check", "approve", "--credential-var", FIXTURE_KEY_VAR, "--non-interactive"],
    ],
    { cwd: dir, env }
  );
  if (setup.status !== 0) throw new Error(`setup failed:\n${setup.out.slice(-3000)}`);

  const runtimeDir = join(dir, ".pi", "runtime");
  const sessionsDir = join(dir, ".pi", "sessions");

  return {
    dir,
    provider,
    env,
    runtimeDir,
    /** The session the project records, or `null`. */
    pointer: () => (existsSync(join(runtimeDir, "kiln-session.json")) ? JSON.parse(readFileSync(join(runtimeDir, "kiln-session.json"), "utf-8")) : null),
    /** Every transcript Pi wrote: its header id and how many user messages it holds. */
    transcripts: () =>
      !existsSync(sessionsDir)
        ? []
        : readdirSync(sessionsDir, { recursive: true })
            .filter((name) => String(name).endsWith(".jsonl"))
            .map((name) => {
              const lines = readFileSync(join(sessionsDir, String(name)), "utf-8").split("\n").filter(Boolean);
              return { id: JSON.parse(lines[0]).id, entries: lines.length, userMessages: lines.filter((line) => line.includes('"role":"user"')).length, bytes: Buffer.byteLength(lines.join("\n")) };
            }),
    /**
     * One run of `start-kiln.mjs --rpc`. `drive` gets `send`, `waitFor` (an RPC event), `said` (a supervisor notice
     * on standard error) and `events`. Standard input is closed when `drive` returns, which ends the run.
     */
    async launch(drive, { boundMs = 4 * 60_000 } = {}) {
      const child = spawn(process.execPath, [join(ROOT, "bin", "start-kiln.mjs"), "--rpc"], { cwd: dir, env, stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => (stdout += d));
      child.stderr.on("data", (d) => (stderr += d));
      const exited = new Promise((done) => child.on("close", (status, signal) => done({ status, signal })));
      const bound = setTimeout(() => child.kill(), boundMs);
      const events = () =>
        stdout.split("\n").filter((line) => line.trim().length > 0).map((line) => {
          try {
            return JSON.parse(line);
          } catch {
            return null;
          }
        }).filter(Boolean);
      const poll = (what, probe, timeoutMs, orExit) =>
        new Promise((resolve, reject) => {
          const started = Date.now();
          const timer = setInterval(() => {
            const found = probe();
            if (found !== undefined && found !== null && found !== false) {
              clearInterval(timer);
              resolve(found);
            } else if (child.exitCode !== null || Date.now() - started > timeoutMs) {
              clearInterval(timer);
              if (orExit && child.exitCode !== null) resolve(null);
              else reject(new Error(`${child.exitCode !== null ? "start-kiln exited" : "timed out"} waiting for ${what}:\n${stdout.slice(-1200)}\n--- stderr ---\n${stderr.slice(-3000)}`));
            }
          }, 100);
        });
      const io = {
        send: (command) => {
          try {
            child.stdin.write(`${JSON.stringify(command)}\n`);
          } catch {
            // The run has already ended; the assertions say what was expected.
          }
        },
        events,
        waitFor: (what, match, { count = 1, timeoutMs = 120_000, orExit = false } = {}) => poll(what, () => events().filter(match)[count - 1], timeoutMs, orExit),
        /** Resolves with the regular expression's match once the supervisor has said it `count` times. */
        said: (pattern, { count = 1, timeoutMs = 120_000 } = {}) =>
          poll(`the supervisor to say ${pattern}`, () => [...stderr.matchAll(new RegExp(pattern, "g"))][count - 1], timeoutMs, false),
        stderr: () => stderr,
      };
      try {
        await drive(io);
      } finally {
        try {
          child.stdin.end();
        } catch {
          // Already closed.
        }
      }
      const exit = await exited;
      clearTimeout(bound);
      return { exit, stdout, stderr, events: events() };
    },
    async close() {
      await provider.close();
      // ⚠️ A CLEANUP FAILURE MUST NOT REPLACE THE TEST'S OWN FAILURE. On Windows a process that has just exited can hold
      // the directory for a moment longer; the removal is retried, and what cannot be removed is reported, not thrown.
      for (let attempt = 0; ; attempt++) {
        try {
          removeTestTree(root, label);
          break;
        } catch (error) {
          if (attempt >= 20) {
            console.error(`[${label}] the fixture could not be removed (${error?.code ?? "unknown"})`);
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
      }
    },
  };
}
