/**
 * A real Pi session over a consumer-shaped fixture, against a provider on the loopback interface - #177.
 *
 * The fixture is the one `test/pi-session-orchestrator.test.mjs` builds: a project whose `.planning` holds a copy of
 * this checkout's `lib/`, `schemas/`, `stages/` and `pi-package/`, the repository's dependencies through a link
 * above the project, a trusted project, and a probe extension that registers the provider. What differs per test
 * is how Pi is started - in a pseudo-terminal or over pipes - and what the provider is scripted to answer.
 *
 * ⚠️ **THE PROVIDER IS THE ONLY THING REPLACED.** It records every request, bills nothing and reaches nowhere.
 */

import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { STATE_MODE } from "../../lib/local-state.mjs";
import { PORTABLE_PACKAGE_ENTRY } from "../../lib/pi-package-entry.mjs";
import { resolvePinnedAgent, resolvePinnedSdk } from "../../lib/pi-runtime.mjs";
import { mergeSettingsText } from "../../lib/pi-settings.mjs";
import { piToolAllowlist, withToolAllowlist } from "../../bin/start-kiln.mjs";

const ROOT = join(import.meta.dirname, "..", "..");
export const LOOPBACK_PROVIDER = "kiln-loopback";
export const LOOPBACK_MODEL = "loopback-model";
const PLANTED_KEY = "sk-kiln-LOOPBACK-PLANTED-s177";

const CREDENTIAL_SHAPED = /(API_?KEY|ACCESS_?KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL|_AUTH)/i;

const chunk = (delta, finish = null) =>
  `data: ${JSON.stringify({ id: "chatcmpl-loopback", object: "chat.completion.chunk", created: 1, model: LOOPBACK_MODEL, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;

/**
 * A provider that answers each request with the next scripted reply, and "Noted." once the script is spent.
 *
 * A reply is `{text}`, `{tool, arguments}`, or `{stream: string[], everyMs}`, which sends one content chunk per
 * entry. `payloadBytes` is the total of content bytes sent, so a test can compare output against what was new.
 */
export async function scriptedProvider() {
  const requests = [];
  const script = [];
  const sent = { payloadBytes: 0, chunks: 0 };
  const limit = { chars: null, tokens: null };
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      let parsed = null;
      try {
        parsed = JSON.parse(body);
      } catch {
        // Recorded as null; the assertions say what was expected.
      }
      requests.push(parsed);
      // ⚠️ A CONTEXT LIMIT, WHEN A TEST SETS ONE. A request whose messages are larger than `limit.chars` is refused
      // the way a real provider refuses it, and consumes no scripted reply: the retry gets the reply instead.
      const chars = (parsed?.messages ?? []).filter((m) => m.role !== "system" && m.role !== "developer").reduce((n, m) => n + JSON.stringify(m.content ?? "").length, 0);
      if (parsed) Object.defineProperty(parsed, "messageChars", { value: chars, enumerable: false });
      if (limit.chars !== null && chars > limit.chars) {
        if (parsed) Object.defineProperty(parsed, "refused", { value: true, enumerable: false });
        res.writeHead(400, { "content-type": "application/json" });
        return res.end(JSON.stringify({ error: { message: `This model's maximum context length is ${limit.tokens} tokens. However, your messages resulted in ${Math.round(chars / 4)} tokens. Please reduce the length of the messages.`, type: "invalid_request_error", code: "context_length_exceeded" } }));
      }
      const reply = script.shift() ?? { text: "Noted." };
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "close" });
      const finish = (reason) => {
        res.write(chunk({}, reason));
        res.write("data: [DONE]\n\n");
        res.end();
      };
      if (reply.tool) {
        res.write(chunk({ role: "assistant", content: "" }));
        res.write(chunk({ tool_calls: [{ index: 0, id: `call_${requests.length}`, type: "function", function: { name: reply.tool, arguments: JSON.stringify(reply.arguments ?? {}) } }] }));
        return finish("tool_calls");
      }
      res.write(chunk({ role: "assistant", content: "" }));
      const parts = reply.stream ?? [reply.text];
      let index = 0;
      const next = () => {
        if (index >= parts.length) return finish("stop");
        sent.payloadBytes += Buffer.byteLength(parts[index]);
        sent.chunks++;
        res.write(chunk({ content: parts[index++] }));
        if (reply.everyMs) timer = setTimeout(next, reply.everyMs);
        else next();
      };
      let timer = null;
      res.on("close", () => clearTimeout(timer));
      next();
    });
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  return { port: server.address().port, requests, script, sent, limit, close: () => new Promise((done) => server.close(done)) };
}

/**
 * The fixture's directories and the arguments and environment a Pi started in it needs.
 *
 * @param {{port: number}} provider
 * @param {{packaged?: boolean, extensions?: object, manifest?: string, contextWindow?: number, settings?: object}} [options]
 *   `contextWindow` is the loopback model's declared window; `settings` are extra keys for the project's Pi settings.
 *   `packaged: false` leaves Kiln's package out of the project's settings, for a test that loads the extension
 *   through a wrapper of its own instead. `extensions` are extra `-e` sources, written into the fixture by name.
 */
export async function sessionFixture(provider, { packaged = true, extensions = {}, manifest = "name: session fixture\n", contextWindow = 128000, settings = {}, stageDocument = "# Stage 01 - Intake\n\nA session fixture.\n" } = {}) {
  const sdk = await import(resolvePinnedSdk(ROOT).url);
  const base = mkdtempSync(join(tmpdir(), "kiln-pi-session-"));
  const project = join(base, "project");
  const tool = join(project, ".planning");
  const contentRoot = join(project, "planning-content");
  const agentDir = join(base, "agent");
  const home = join(base, "home");
  const probe = join(base, "probe", "probe.js");
  const modules = join(base, "node_modules");
  const pidFile = join(base, "pi.pid");

  for (const dir of [join(project, ".pi"), tool, join(contentRoot, "stages"), agentDir, home, dirname(probe)]) mkdirSync(dir, { recursive: true });
  for (const dir of ["lib", "schemas", "stages", "pi-package", "specialists"]) cpSync(join(ROOT, dir), join(tool, dir), { recursive: true });
  cpSync(join(ROOT, "package.json"), join(tool, "package.json"));
  symlinkSync(join(ROOT, "node_modules"), modules, "junction");

  writeFileSync(join(contentRoot, "project.yaml"), manifest);
  writeFileSync(join(contentRoot, "stages", "01-intake.md"), stageDocument);
  if (packaged)
    writeFileSync(
      join(project, ".pi", "settings.json"),
      JSON.stringify({ ...JSON.parse(mergeSettingsText(null, { stateMode: STATE_MODE.USER, provider: LOOPBACK_PROVIDER, model: LOOPBACK_MODEL, thinkingLevel: "off", packageEntry: PORTABLE_PACKAGE_ENTRY })), ...settings }, null, 2)
    );
  new sdk.ProjectTrustStore(agentDir).set(project, true);

  // ⚠️ THE PROBE REGISTERS THE PROVIDER AND WRITES PI'S PROCESS ID, AND REGISTERS NO TOOL. The id lets a test end
  // the process directly: killing through a pseudo-terminal has node-pty enumerate a console that is closing.
  writeFileSync(
    probe,
    `import { writeFileSync } from "node:fs";
export default function (pi) {
  writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
  pi.registerProvider("${LOOPBACK_PROVIDER}", {
    baseUrl: "http://127.0.0.1:${provider.port}/v1",
    apiKey: "$KILN_LOOPBACK_KEY",
    api: "openai-completions",
    models: [{ id: "${LOOPBACK_MODEL}", name: "Loopback", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: ${contextWindow}, maxTokens: 4096 }],
  });
}
`
  );
  const extra = [];
  for (const [name, source] of Object.entries(extensions)) {
    const path = join(dirname(probe), name);
    writeFileSync(path, typeof source === "function" ? source({ tool }) : source);
    extra.push(path);
  }

  const agent = withToolAllowlist(resolvePinnedAgent(ROOT), await piToolAllowlist(ROOT));
  const env = {
    ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !CREDENTIAL_SHAPED.test(name) && !/^(kiln_|planning_content_dir$)/i.test(name))),
    HOME: home,
    USERPROFILE: home,
    PI_CODING_AGENT_DIR: agentDir,
    PLANNING_CONTENT_DIR: contentRoot,
    KILN_LOOPBACK_KEY: PLANTED_KEY,
    PI_OFFLINE: "1",
  };
  const args = ["--session-dir", join(base, "sessions"), ...[probe, ...extra].flatMap((path) => ["-e", path]), "--provider", LOOPBACK_PROVIDER, "--model", LOOPBACK_MODEL, "--offline"];

  return {
    base,
    project,
    tool,
    contentRoot,
    agent,
    args,
    env,
    pidFile,
    remove() {
      // ⚠️ THE LINK FIRST, ON ITS OWN, so the recursive removal below cannot follow it into the repository.
      if (existsSync(modules) && lstatSync(modules).isSymbolicLink()) unlinkSync(modules);
      else if (existsSync(modules)) throw new Error("the fixture's node_modules is not the link this helper made; nothing is removed");
      rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
    },
  };
}

export const textOf = (content) => (typeof content === "string" ? content : (content ?? []).filter((part) => part.type === "text").map((part) => part.text).join("\n"));

/** The tool result messages of a provider request, parsed. */
export const toolResults = (request) => (request?.messages ?? []).filter((m) => m.role === "tool").map((m) => JSON.parse(textOf(m.content)));

/**
 * One run of Pi in RPC mode over pipes, in a fixture. `drive` sends commands and waits on the events Pi prints.
 *
 * Every event is stamped with when it arrived, so a test can say how long something took.
 *
 * @param {object} fx a `sessionFixture`
 * @param {(io: {send: Function, waitFor: Function, events: Function}) => Promise<void>} drive
 * @param {{args?: string[], env?: object, agent?: object}} [options] `args` are extra arguments, such as `--continue`
 * @returns {Promise<{stdout: string, stderr: string, events: object[], exit: {code: number|null, signal: string|null}}>}
 */
export async function rpcSession(fx, drive, { args = [], env = {}, agent = null } = {}) {
  const { spawn } = await import("node:child_process");
  const { withRpcMode } = await import("../../bin/start-kiln.mjs");
  const command = withRpcMode(agent ?? fx.agent);
  const child = spawn(command.command, [...command.args, ...fx.args, ...args], { cwd: fx.project, env: { ...fx.env, ...env }, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  let buffered = "";
  let exit = null;
  const events = [];
  const waiters = [];
  const settle = () => {
    for (const waiter of [...waiters]) {
      const found = events.filter(waiter.match)[waiter.count - 1];
      if (found === undefined && exit === null) continue;
      waiters.splice(waiters.indexOf(waiter), 1);
      clearTimeout(waiter.timer);
      if (found !== undefined) waiter.resolve(found);
      else if (waiter.orExit) waiter.resolve(null);
      else waiter.reject(new Error(`Pi exited while waiting for ${waiter.what}.\n${stdout.slice(-1500)}\n${stderr.slice(-2000)}`));
    }
  };
  child.stdout.on("data", (data) => {
    stdout += data;
    buffered += data;
    let at;
    while ((at = buffered.indexOf("\n")) !== -1) {
      const line = buffered.slice(0, at).trim();
      buffered = buffered.slice(at + 1);
      if (line.length === 0) continue;
      try {
        events.push(Object.assign(JSON.parse(line), { arrivedAt: Date.now() }));
      } catch {
        // Not a protocol line; `stdout` keeps it for an assertion to find.
      }
    }
    settle();
  });
  child.stderr.on("data", (data) => (stderr += data));
  const closed = new Promise((done) => child.on("exit", (code, signal) => ((exit = { code, signal }), settle(), done())));
  const io = {
    send: (message) => child.stdin.write(`${JSON.stringify(message)}\n`),
    events: () => events,
    /** Resolves with the `count`-th event matching `match`. With `orExit`, resolves `null` if Pi exits first. */
    waitFor: (what, match, { count = 1, orExit = false, timeoutMs = 90_000 } = {}) =>
      new Promise((resolve, reject) => {
        const waiter = { what, match, count, orExit, resolve, reject };
        waiter.timer = setTimeout(() => {
          waiters.splice(waiters.indexOf(waiter), 1);
          reject(new Error(`Timed out waiting for ${what}.\n${stdout.slice(-1500)}\n${stderr.slice(-2000)}`));
        }, timeoutMs);
        waiters.push(waiter);
        settle();
      }),
    exited: () => closed,
  };
  try {
    await drive(io);
  } finally {
    if (exit === null) child.kill();
    await closed;
  }
  return { stdout, stderr, events, exit };
}
