/**
 * `/kiln-start` in a real trusted Pi session, observed at the provider - TSK-0048 (G5), toward ACC-0068.
 *
 * ⚠️ **WHAT THE SESSION IS GIVEN, READ FROM WHAT THE PROVIDER RECEIVES.** ACC-0068 accepts only what Kiln
 * deterministically supplies (D14). The hook's return value, the template file and a handler's result are each one
 * step short of that: the pinned CLI decides what reaches a model. So a loopback provider records every request body,
 * and each claim is checked against those bodies: the expanded `/kiln-start` text, the Stage 1 skill in the system
 * prompt, and the tool message after the one status call.
 *
 * ⚠️ **THE SCRIPT DECIDES THE CALL, NOT THE MODEL, AND NOTHING HERE JUDGES A REPLY.** The first request is answered
 * with a call to `kiln_project_status` and the second with a stop. What a real model does with these instructions is
 * ACC-0114's, judged by a person against a recorded turn.
 *
 * ⚠️ **A TOOL COPY WITH ITS OWN `lib/`, AND THE REPOSITORY'S DEPENDENCIES THROUGH A LINK OUTSIDE THE PROJECT.**
 * `kiln_project_status` and the hook import `lib/` beside the package, as a consumer's `.planning/` would provide.
 * `node_modules` is linked at the fixture root, above the project, so module resolution finds it and no fingerprint
 * of the project walks it. The link is removed on its own before the fixture is, so a recursive removal never
 * reaches the repository's dependencies.
 *
 * ⚠️ **NO CLEAN-EXIT CLAIM (F82).** The session is stopped once the agent settles, as the capability session is.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir, tmpdir, userInfo } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

import { resolvePinnedAgent, resolvePinnedSdk } from "../lib/pi-runtime.mjs";
import { STATE_MODE } from "../lib/local-state.mjs";
import { PORTABLE_PACKAGE_ENTRY } from "../lib/pi-package-entry.mjs";
import { mergeSettingsText } from "../lib/pi-settings.mjs";
import { yamlString } from "../lib/project-scaffold.mjs";
import { piToolAllowlist, withToolAllowlist } from "../bin/start-kiln.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const sdk = await import(resolvePinnedSdk(ROOT).url);

const SKILL = "kiln-stage-01-intake";
const PLANTED_KEY = "sk-kiln-LOOPBACK-PLANTED-g5a1";
const PROJECT_NAME = "Harbour Ledger ⚠️ Café";
const PROJECT_DESCRIPTION = "Reconciles dock fees against invoices, for the port office.";
const STAGE_ONE_DOCUMENT = "# Stage 01 - Intake\n\nThe port office wants dock fees reconciled. Café ⚠️ 🔥\n";
const OVERRIDE = (body) => ["---", `name: ${SKILL}`, "description: A consumer override of Stage 1.", "---", "", body, ""].join("\n");
const FOOTER_AT_END = /\n<!-- kiln:stage-context:end length=(\d+) -->$/;
const OPENING = "\n\n<!-- kiln:stage-context:begin -->\n";

const CREDENTIAL_SHAPED = /(API_?KEY|ACCESS_?KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL|_AUTH)/i;
const childEnvironment = () =>
  Object.fromEntries(Object.entries(process.env).filter(([name]) => !CREDENTIAL_SHAPED.test(name) && !/^(kiln_self_host|planning_content_dir)$/i.test(name)));

/** Every file under a root as relative path -> content hash and modification time. */
function fingerprint(root) {
  const out = new Map();
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.set(relative(root, full).split(sep).join("/"), `${createHash("sha256").update(readFileSync(full)).digest("hex")}:${statSync(full).mtimeMs}`);
    }
  };
  if (existsSync(root)) walk(root);
  return out;
}
const changed = (before, after) => [...new Set([...before.keys(), ...after.keys()])].filter((n) => before.get(n) !== after.get(n)).sort();

/** One streamed chunk in the shape the pinned openai-completions client reads. */
const chunk = (delta, finish = null) =>
  `data: ${JSON.stringify({ id: "chatcmpl-loopback", object: "chat.completion.chunk", created: 1, model: "loopback-model", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;

/** A provider on the loopback interface that records every request and calls `kiln_project_status` once. */
async function scriptedProvider() {
  const requests = [];
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
      requests.push({ url: req.url ?? "", remote: req.socket.remoteAddress, authorization: req.headers.authorization ?? null, body: parsed });
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "close" });
      if (requests.length === 1) {
        res.write(chunk({ role: "assistant", content: "" }));
        res.write(chunk({ tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "kiln_project_status", arguments: "{}" } }] }));
        res.write(chunk({}, "tool_calls"));
      } else {
        res.write(chunk({ role: "assistant", content: "done" }));
        res.write(chunk({}, "stop"));
      }
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  return { address: server.address(), requests, close: () => new Promise((done) => server.close(done)) };
}

/** The probe: registers the loopback provider and records every tool execution by name. It registers no tool. */
const PROBE_SOURCE = (port) => `
import { appendFileSync } from "node:fs";
export default function (pi) {
  pi.registerProvider("kiln-loopback", {
    baseUrl: "http://127.0.0.1:${port}/v1",
    apiKey: "$KILN_LOOPBACK_KEY",
    api: "openai-completions",
    models: [{ id: "loopback-model", name: "Loopback", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 1024 }],
  });
  pi.on("tool_execution_start", (e) => appendFileSync(process.env.KILN_EVENTS_OUT, JSON.stringify({ phase: "start", toolName: e.toolName }) + "\\n"));
  pi.on("tool_execution_end", (e) => appendFileSync(process.env.KILN_EVENTS_OUT, JSON.stringify({ phase: "end", toolName: e.toolName, isError: e.isError === true }) + "\\n"));
}
`;

/**
 * One real `/kiln-start` session over a fresh consumer fixture.
 *
 * @param {{overrides?: string[]}} options  override bodies written in order before the session starts, so the last is
 *   an edit of the ones before it
 */
async function kilnStartSession({ overrides = [] } = {}) {
  const base = mkdtempSync(join(tmpdir(), "kiln-orchestrator-session-"));
  const project = join(base, "project");
  const tool = join(project, ".planning");
  const contentRoot = join(project, "planning-content");
  const agentDir = join(base, "agent");
  const home = join(base, "home");
  const sessions = join(base, "sessions");
  const probe = join(base, "probe", "probe.js");
  const events = join(base, "events.jsonl");
  const modules = join(base, "node_modules");
  const provider = await scriptedProvider();
  let child = null;

  try {
    for (const dir of [join(project, ".pi"), tool, join(contentRoot, "data"), join(contentRoot, "stages"), join(contentRoot, "skills-overrides"), agentDir, home, dirname(probe)])
      mkdirSync(dir, { recursive: true });
    for (const dir of ["lib", "schemas", "stages", "pi-package"]) cpSync(join(ROOT, dir), join(tool, dir), { recursive: true });
    cpSync(join(ROOT, "package.json"), join(tool, "package.json"));
    symlinkSync(join(ROOT, "node_modules"), modules, "junction");

    writeFileSync(join(contentRoot, "project.yaml"), `name: ${yamlString(PROJECT_NAME)}\ndescription: ${yamlString(PROJECT_DESCRIPTION)}\n`);
    writeFileSync(join(contentRoot, "stages", "01-intake.md"), STAGE_ONE_DOCUMENT);
    writeFileSync(join(contentRoot, "skills-overrides", ".gitkeep"), "");
    for (const body of overrides) {
      mkdirSync(join(contentRoot, "skills-overrides", SKILL), { recursive: true });
      writeFileSync(join(contentRoot, "skills-overrides", SKILL, "SKILL.md"), OVERRIDE(body));
    }
    writeFileSync(
      join(project, ".pi", "settings.json"),
      mergeSettingsText(null, { stateMode: STATE_MODE.USER, provider: "kiln-loopback", model: "loopback-model", thinkingLevel: "off", packageEntry: PORTABLE_PACKAGE_ENTRY })
    );
    new sdk.ProjectTrustStore(agentDir).set(project, true);
    writeFileSync(join(agentDir, "kiln-agent-sentinel.txt"), "agent sentinel\n");
    writeFileSync(join(home, "kiln-home-sentinel.txt"), "home sentinel\n");
    writeFileSync(probe, PROBE_SOURCE(provider.address.port));

    const expected = {
      packagedSkill: readFileSync(join(tool, "pi-package", "skills", SKILL, "SKILL.md"), "utf8"),
      startBody: sdk.parseFrontmatter(readFileSync(join(tool, "pi-package", "prompts", "kiln-start.md"), "utf8")).body,
      allowlist: await piToolAllowlist(ROOT),
    };

    // ⚠️ TAKEN ONCE THE FIXTURE IS COMPLETE AND BEFORE THE SESSION STARTS.
    const before = { project: fingerprint(project), agent: fingerprint(agentDir), home: fingerprint(home) };

    const agent = withToolAllowlist(resolvePinnedAgent(ROOT), expected.allowlist);
    child = spawn(
      agent.command,
      [...agent.args, "--session-dir", sessions, "-e", probe, "--provider", "kiln-loopback", "--model", "loopback-model", "--mode", "rpc", "--offline"],
      {
        cwd: project,
        env: {
          ...childEnvironment(),
          HOME: home,
          USERPROFILE: home,
          PI_CODING_AGENT_DIR: agentDir,
          PLANNING_CONTENT_DIR: contentRoot,
          KILN_EVENTS_OUT: events,
          KILN_LOOPBACK_KEY: PLANTED_KEY,
          PI_OFFLINE: "1",
        },
        stdio: ["pipe", "pipe", "pipe"],
      }
    );

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      stdout += d;
      // ⚠️ SETTLE AND STOP (F82): stopped once the agent settles, with no claim about the exit status.
      if (stdout.includes('"type":"agent_settled"')) child.kill();
    });
    child.stderr.on("data", (d) => (stderr += d));
    // ⚠️ THE SLASH COMMAND ITSELF, so Pi's own prompt expansion produces the text the provider receives.
    child.stdin.write(`${JSON.stringify({ id: "1", type: "prompt", message: "/kiln-start" })}\n`);

    const exit = await new Promise((done) => {
      const timer = setTimeout(() => {
        child.kill();
        done({ code: null, signal: "timeout" });
      }, 90000);
      child.on("exit", (code, signal) => {
        clearTimeout(timer);
        done({ code, signal });
      });
    });
    child = null;

    const agentAfter = fingerprint(agentDir);
    return {
      expected,
      exit,
      settled: stdout.includes('"type":"agent_settled"'),
      requests: provider.requests,
      providerAddress: provider.address,
      executions: existsSync(events) ? readFileSync(events, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [],
      projectChanges: changed(before.project, fingerprint(project)),
      agentSentinelChanges: changed(before.agent, new Map([...agentAfter].filter(([n]) => before.agent.has(n)))),
      agentAdded: [...agentAfter.keys()].filter((n) => !before.agent.has(n)).sort(),
      agentAddedCarriesKey: [...agentAfter.keys()].filter((n) => !before.agent.has(n)).some((n) => readFileSync(join(agentDir, n), "utf8").includes(PLANTED_KEY)),
      homeChanges: changed(before.home, fingerprint(home)),
      stderrSignal: /error|cannot|failed|refus/i.test(stderr),
      diagnostic: `exit ${JSON.stringify(exit)}\n${stdout.slice(-2000)}\n${stderr.slice(-2000)}`,
      paths: [base, project, tool, contentRoot, agentDir, home, homedir()],
    };
  } finally {
    if (child) child.kill();
    await provider.close();
    // ⚠️ THE LINK FIRST, ON ITS OWN, so the recursive removal below cannot follow it into the repository.
    if (existsSync(modules) && lstatSync(modules).isSymbolicLink()) unlinkSync(modules);
    else if (existsSync(modules)) throw new Error("the fixture's node_modules is not the link this test made; nothing is removed");
    rmSync(base, { recursive: true, force: true });
  }
}

/** The one Kiln frame at the end of a system prompt, as its payload. */
function framePayload(systemPrompt) {
  const footer = FOOTER_AT_END.exec(systemPrompt);
  assert.ok(footer, "the system prompt ends with a Kiln footer");
  const start = footer.index - Number(footer[1]);
  assert.equal(systemPrompt.slice(start - OPENING.length, start), OPENING, "the footer's length places the opening exactly");
  assert.equal(systemPrompt.split("<!-- kiln:stage-context:begin -->").length, 2, "exactly one frame");
  return systemPrompt.slice(start, footer.index);
}

/** No absolute path in any spelling a model could be sent: as written, with forward slashes, or JSON-escaped. */
function assertNoPath(text, paths, label) {
  for (const path of paths)
    for (const spelling of new Set([path, path.split("\\").join("/"), JSON.stringify(path).slice(1, -1)]))
      assert.equal(text.includes(spelling), false, `${label} carries a fixture or home path`);
  assert.equal(/[A-Za-z]:(\\\\|\\|\/)/.test(text), false, `${label} carries a drive-lettered path`);
  assert.equal(/\/(home|Users)\//.test(text), false, `${label} carries a home directory`);
}

const textOf = (content) => (typeof content === "string" ? content : content.filter((part) => part.type === "text").map((part) => part.text).join("\n"));

/** Everything both cases must show; returns the frame payload and the status the provider was sent. */
function assertKilnStart(run) {
  const { expected, requests } = run;
  assert.ok(run.settled, `the agent never settled: ${run.diagnostic}`);
  assert.equal(run.stderrSignal, false, `the session reported a problem: ${run.diagnostic}`);

  // ⚠️ THE SEQUENCE: two requests, the second after the one status call, both to the loopback provider.
  assert.equal(requests.length, 2, `the scripted provider was asked ${requests.length} times`);
  assert.equal(run.providerAddress.address, "127.0.0.1", "the provider listens on the loopback interface only");
  for (const request of requests) {
    assert.equal(request.url, "/v1/chat/completions");
    assert.match(request.remote, /^(::ffff:)?127\.0\.0\.1$/, "a request arrived from off the loopback interface");
    assert.equal(request.authorization, `Bearer ${PLANTED_KEY}`, "the only key the provider saw is the planted, non-credential one");
    assert.deepEqual(request.body.tools.map((t) => t.function.name).sort(), [...expected.allowlist].sort(), "the request offers exactly the declared tools");
  }
  const [first, second] = requests.map((r) => r.body.messages);

  // ⚠️ REQUEST 1: THE EXPANDED /kiln-start AND THE STAGE 1 SKILL.
  assert.deepEqual(first.map((m) => m.role), ["system", "user"]);
  const startText = textOf(first[1].content);
  assert.equal(startText, expected.startBody, "the user turn is Pi's own expansion of /kiln-start, byte for byte");
  for (const instruction of [
    "Call `kiln_project_status` first, before anything else, and work from what it returns.",
    "- For the fresh Stage 1 turn, follow the injected stage skill's question-selection rule.",
    "- Propose no architecture, no set of requirements and no solution.",
    "- Call no tool that creates, revises, links or otherwise changes planning content.",
  ])
    assert.ok(startText.includes(instruction), `the start instructions lack: ${instruction}`);

  const systemPrompt = first[0].content;
  const payload = framePayload(systemPrompt);
  assert.ok(payload.startsWith("Kiln stage context: the current stage is 01-intake"), payload.slice(0, 120));
  // ⚠️ KILN'S FRAME, NOT PI'S BASE PROMPT (R12). Pi's own base prompt names the working directory and its install's
  // documentation paths; that text is Pi's, and what this criterion covers is what Kiln adds.
  assertNoPath(payload, run.paths, "the Kiln frame");

  // ⚠️ REQUEST 2: THE SAME CONTEXT, ONE FRAME, AND THE STATUS AS THE TOOL MESSAGE.
  assert.deepEqual(second.map((m) => m.role), ["system", "user", "assistant", "tool"]);
  assert.equal(second[0].content, systemPrompt, "the second turn's system prompt is byte-identical, with no second frame");
  assert.deepEqual(second[1], first[1]);
  assert.deepEqual(second[2].tool_calls.map((c) => c.function.name), ["kiln_project_status"]);
  const toolMessage = second[3];
  assert.equal(toolMessage.tool_call_id, second[2].tool_calls[0].id);
  assert.notEqual(toolMessage.content, "(no tool output)", "the provider was sent no tool output (F114)");
  const status = JSON.parse(toolMessage.content);
  assert.equal(status.ok, true);
  assert.equal(status.project.name, PROJECT_NAME, "the provider received the project's exact name");
  assert.equal(status.project.description, PROJECT_DESCRIPTION, "the provider received the project's exact description");
  assert.deepEqual(status.stageOneDocument, { stageId: "01-intake", path: "stages/01-intake.md", text: STAGE_ONE_DOCUMENT, truncated: false });
  assert.equal(status.orchestration.fresh, true, "a project with no typed artifacts and no attestations is fresh");
  assert.equal(status.orchestration.currentStage.id, "01-intake");
  assertNoPath(toolMessage.content, run.paths, "the tool message");

  // ⚠️ ONLY THE STATUS TOOL RAN, AND NOTHING WAS CHANGED.
  assert.deepEqual(run.executions, [{ phase: "start", toolName: "kiln_project_status" }, { phase: "end", toolName: "kiln_project_status", isError: false }]);
  assert.deepEqual(run.projectChanges, [], "the session changed a project, settings or package file");
  assert.deepEqual(run.agentSentinelChanges, [], "the session changed trust or the agent sentinel");
  assert.deepEqual(run.homeChanges, [], "the session changed the home sentinel");
  assert.equal(run.agentAddedCarriesKey, false, "Pi stored the planted key in the agent directory");

  return payload;
}

test("⚠️ ACC-0068 /kiln-start in a real trusted session sends the provider the packaged Stage 1 skill, the start instructions, and after the one status call the project's identity and Stage 1 document", async () => {
  const run = await kilnStartSession();
  const payload = assertKilnStart(run);
  assert.ok(payload.endsWith(`<stage-skill name="${SKILL}">\n${run.expected.packagedSkill}\n</stage-skill>`), "the packaged Stage 1 skill's exact bytes end the frame");

  // ⚠️ AND THE RULE TRAVELLED WITH IT. /kiln-start sends the fresh turn to the skill's question-selection
  // rule, so a skill reaching the provider without one would send the model to an instruction that is not
  // there. Asserted on the PACKAGED skill only: an override is the consumer's, and may say anything.
  assert.ok(payload.includes("Choose each question from the current `kiln_project_status.intake` state by information value and blocking impact: ask the single question whose answer would most reduce the highest-impact uncertainty preventing Stage 1 from understanding the operator's request."), "the packaged Stage 1 skill reached the provider without its question-selection rule");
});

test("⚠️ ACC-0068 with a consumer override edited before the session, the provider receives exactly the edited bytes, not the earlier override or the packaged skill", async () => {
  const run = await kilnStartSession({ overrides: ["CONSUMER-OVERRIDE-BEFORE-EDIT", "CONSUMER-OVERRIDE-EDITED Café ⚠️"] });
  const payload = assertKilnStart(run);
  assert.ok(payload.endsWith(`<stage-skill name="${SKILL}">\n${OVERRIDE("CONSUMER-OVERRIDE-EDITED Café ⚠️")}\n</stage-skill>`), "the edited override's exact bytes end the frame");
  for (const request of run.requests) {
    const systemPrompt = request.body.messages[0].content;
    assert.equal(systemPrompt.includes("CONSUMER-OVERRIDE-BEFORE-EDIT"), false, "the override as it was before the edit reached the provider");
    assert.equal(systemPrompt.includes(run.expected.packagedSkill), false, "the packaged Stage 1 skill reached the provider");
  }
});
