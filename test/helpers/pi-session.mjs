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
  return { port: server.address().port, requests, script, sent, close: () => new Promise((done) => server.close(done)) };
}

/**
 * The fixture's directories and the arguments and environment a Pi started in it needs.
 *
 * @param {{port: number}} provider
 * @param {{packaged?: boolean, extensions?: string[], manifest?: string}} [options]
 *   `packaged: false` leaves Kiln's package out of the project's settings, for a test that loads the extension
 *   through a wrapper of its own instead. `extensions` are extra `-e` sources, written into the fixture by name.
 */
export async function sessionFixture(provider, { packaged = true, extensions = {}, manifest = "name: session fixture\n" } = {}) {
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
  writeFileSync(join(contentRoot, "stages", "01-intake.md"), "# Stage 01 - Intake\n\nA session fixture.\n");
  if (packaged)
    writeFileSync(join(project, ".pi", "settings.json"), mergeSettingsText(null, { stateMode: STATE_MODE.USER, provider: LOOPBACK_PROVIDER, model: LOOPBACK_MODEL, thinkingLevel: "off", packageEntry: PORTABLE_PACKAGE_ENTRY }));
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
    models: [{ id: "${LOOPBACK_MODEL}", name: "Loopback", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 4096 }],
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
