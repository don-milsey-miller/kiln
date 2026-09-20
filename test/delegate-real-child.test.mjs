/**
 * One real specialist child, measured — TSK-0053, toward ACC-0076 and ACC-0111.
 *
 * ⚠️ **ONE RUN, SIX FACTS.** Everything else about the runtime is driven by a scripted child, which can
 * show what the code does with a run but not what a real Pi does with the launch protocol. This spawns
 * the pinned agent for real and asserts, from that single run, what the provider received, what the
 * child held, what it reported, and what was left behind.
 *
 * ⚠️ **A LOOPBACK PROVIDER, ON PURPOSE.** A real provider would add a credential, a cost and a source of
 * nondeterminism, and would prove nothing further about the protocol: what is being measured is the
 * launch, the tool registration and the two fd-3 lines, none of which depend on who answers.
 *
 * ⚠️ **CROSS-PLATFORM, AND THE LAUNCH IS WHERE THE PLATFORMS DIFFER.** Path separators, the extension
 * paths handed to `-e`, and the process-tree teardown are all platform-specific, which is exactly why
 * this runs in every cell rather than on one.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { contractFor } from "../lib/specialists/contract.mjs";
import { delegateToSpecialist, loadSupervisorPrimitives } from "../lib/specialists/delegate.mjs";
import { resolvePinnedAgent } from "../lib/pi-runtime.mjs";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const PLANTED = "sk-ant-REALCHILD-PLANTED-3f0c";
const TASK = "State in one sentence what the port office needs from nightly dock-fee reconciliation.";
const EXPECTED_TOOLS = [...contractFor("research").tools].sort();

const chunk = (delta, finish = null) =>
  `data: ${JSON.stringify({ id: "chatcmpl-loopback", object: "chat.completion.chunk", created: 1, model: "loopback-model", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;

/** A provider on the loopback interface that records every request it is sent. */
async function loopback({ answer = true } = {}) {
  const seen = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      try {
        seen.push(JSON.parse(body));
      } catch {
        seen.push(null);
      }
      if (!answer) return; // never replies: the runtime's own bound has to end the child
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "close" });
      res.write(chunk({ role: "assistant", content: "" }));
      res.write(chunk({ content: "The port office needs same-day figures." }));
      res.write(chunk({}, "stop"));
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  return { port: server.address().port, seen, close: () => new Promise((done) => server.close(done)) };
}

const PROVIDER_EXT = (port) => `
export default function (pi) {
  pi.registerProvider("kiln-loopback", {
    baseUrl: "http://127.0.0.1:${port}/v1",
    apiKey: "${PLANTED}",
    api: "openai-completions",
    models: [{ id: "loopback-model", name: "Loopback", reasoning: true, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 1024 }],
  });
}
`;

/**
 * An extension nobody named, left where Pi's discovery would find it.
 *
 * ⚠️ IT WRITES A FILE IF IT EVER RUNS, because a marker on disk is a fact a later assertion can read,
 * where a marker in the transcript would depend on the child choosing to print it.
 */
const PLANTED_EXT = (marker) => `
import { writeFileSync } from "node:fs";
export default function (pi) {
  writeFileSync(${JSON.stringify(marker)}, "a discovered extension ran\\n");
}
`;

/**
 * The workspaces this file's own delegations created.
 *
 * ⚠️ **NOT A SCAN OF THE TEMPORARY DIRECTORY.** `test/delegate.test.mjs` creates workspaces under the
 * same prefix and `node --test` runs the files concurrently, so a scan counts another run's live
 * material as this one's leak. Both files passed alone and failed together until each tracked its own.
 */
const created = new Set();
const workspaces = () => [...created].filter((path) => existsSync(path));

/** One real child, with everything the runtime needs and nothing it does not. */
async function realChild({ answer = true, timeoutMs = 90_000 } = {}) {
  const base = mkdtempSync(join(tmpdir(), "kiln-realchild-"));
  const agentDir = join(base, "agent");
  mkdirSync(agentDir, { recursive: true });

  const provider = await loopback({ answer });
  const providerExt = join(base, "provider.js");
  writeFileSync(providerExt, PROVIDER_EXT(provider.port));

  // ⚠️ THE PLANTED EXTENSION GOES WHERE DISCOVERY LOOKS: the agent directory's own settings. If
  // `--no-extensions` were dropped, Pi would load it and the marker would appear.
  const plantedMarker = join(base, "planted-extension-ran.txt");
  const plantedExt = join(base, "planted.js");
  writeFileSync(plantedExt, PLANTED_EXT(plantedMarker));
  writeFileSync(
    join(agentDir, "settings.json"),
    JSON.stringify(
      { defaultProvider: "kiln-loopback", defaultModel: "loopback-model", defaultProjectTrust: "always", packages: [], extensions: [plantedExt], skills: [], prompts: [] },
      null,
      2
    ) + "\n"
  );

  const primitives = await loadSupervisorPrimitives();
  let stdout = "";
  let spawnedArgs = null;

  const result = await delegateToSpecialist(
    {
      role: "research",
      task: TASK,
      toolRoot: REPO,
      agentDir,
      provider: "kiln-loopback",
      model: "loopback-model",
      thinkingLevel: "medium",
      hostRegistry: [...contractFor("research").tools],
      hostEnv: { ...process.env, PI_CODING_AGENT_DIR: agentDir, ANTHROPIC_API_KEY: PLANTED },
      timeoutMs,
    },
    {
      resolveAgent: () => resolvePinnedAgent(REPO),
      trackDescendants: primitives.trackDescendants,
      stopTree: primitives.stopTree,
      extraExtensions: [providerExt],
      spawn: (command, args, options) => {
        spawnedArgs = args;
        created.add(options.cwd);
        const child = spawn(command, args, options);
        child.stdout?.on?.("data", (d) => {
          stdout += d;
        });
        return child;
      },
    }
  );
  await provider.close();

  return {
    result,
    stdout,
    spawnedArgs,
    requests: provider.seen,
    plantedRan: existsSync(plantedMarker),
    leaked: workspaces(),
    cleanup: () => rmSync(base, { recursive: true, force: true }),
  };
}

const flagValue = (args, name) => (args.indexOf(name) < 0 ? undefined : args[args.indexOf(name) + 1]);
const toolNames = (request) => (request?.tools ?? []).map((t) => t?.function?.name ?? t?.name).filter(Boolean).sort();

/* ============================================================ the one measured run ============ */

test("⚠️ ACC-0076 one real specialist child: the role, its tools, its report, its task and its cleanup", { timeout: 180_000 }, async () => {
  const run = await realChild();
  try {
    assert.equal(run.result.ok, true, `the delegation was refused: ${JSON.stringify(run.result)}`);
    assert.equal(run.requests.length, 1, "the child made more than one provider request");
    const request = run.requests[0];

    /* ---- 1. the canonical role replaces Pi's default ---------------------------------------- */
    const system = request.messages.filter((m) => m.role === "developer" || m.role === "system");
    assert.equal(system.length, 1, `system messages: ${JSON.stringify(system.map((m) => m.role))}`);
    const systemText = typeof system[0].content === "string" ? system[0].content : JSON.stringify(system[0].content);
    const canonical = readFileSync(join(REPO, "specialists", "research.md"), "utf-8");

    for (const marker of ["Research specialist", "Input contract", "Responsibilities", "Forbidden actions", "Output schema", "Exit criteria", "Escalation conditions"])
      assert.ok(systemText.includes(marker), `the role definition is missing ${marker}`);
    assert.ok(systemText.includes("Retrieve before you answer"), "the role's own prose did not reach the child");
    // ⚠️ PI'S DEFAULT ACTIVELY CONTRADICTS THE ROLE, telling the child it may read files and run commands.
    for (const pi of ["expert coding assistant", "coding agent harness", "editing code"])
      assert.equal(systemText.includes(pi), false, `Pi's default prompt survived: ${pi}`);
    assert.equal(flagValue(run.spawnedArgs, "--system-prompt"), canonical, "the role definition was rebuilt rather than read");

    /* ---- 2. the provider receives exactly the expected intersection -------------------------- */
    assert.deepEqual(toolNames(request), EXPECTED_TOOLS, "the model was offered something other than the intersection");
    assert.equal(toolNames(request).length, 8);
    for (const builtin of ["bash", "read", "write", "edit", "ls", "grep"])
      assert.equal(toolNames(request).includes(builtin), false, `a built-in tool survived --no-builtin-tools: ${builtin}`);

    /* ---- 3. a planted discovered extension does not load ------------------------------------ */
    assert.equal(run.plantedRan, false, "an extension nobody named was loaded into the child");
    const loaded = run.spawnedArgs.map((a, i) => (a === "-e" ? run.spawnedArgs[i + 1] : null)).filter(Boolean);
    assert.equal(loaded.length, 3, `the retained run loads exactly three: ${JSON.stringify(loaded)}`);
    assert.ok(loaded[0].endsWith(join("pi-package", "extensions", "kiln.js")), loaded[0]);
    assert.ok(loaded[1].endsWith("task-observer.mjs"), loaded[1]);
    assert.ok(loaded[2].endsWith("provider.js"), "the injected test extension is not last");
    for (const isolation of ["--no-extensions", "--no-skills", "--no-context-files", "--no-builtin-tools"])
      assert.ok(run.spawnedArgs.includes(isolation), `missing ${isolation}`);

    /* ---- 4. the child's report matches what was requested ------------------------------------ */
    const observed = run.result.observation;
    assert.equal(observed.childReportAccepted, true, `the child's report was refused: ${observed.childReportReason}`);
    assert.equal(observed.provider, "kiln-loopback");
    assert.equal(observed.model, "loopback-model");
    assert.equal(observed.thinkingLevel, "medium");
    assert.deepEqual([...observed.reportedActiveTools].sort(), EXPECTED_TOOLS, "the child reported holding something else");
    assert.deepEqual([...observed.activeTools].sort(), EXPECTED_TOOLS);
    assert.deepEqual(observed.droppedFromAllowlist, []);

    /* ---- 5. the framed task reached the provider, with stdin closed -------------------------- */
    const user = request.messages.filter((m) => m.role === "user");
    assert.equal(user.length, 1, "the child sent more than the one task");
    const userText = typeof user[0].content === "string" ? user[0].content : JSON.stringify(user[0].content);
    assert.ok(/KILN-TASK nonce=[0-9a-f]{32}/.test(userText), "the framed task did not reach the provider");
    assert.ok(userText.includes("port office"), "the task itself did not reach the provider");
    assert.equal(observed.taskBindingObserved, true, "the binding was not observed");
    // The runtime spawns with fd 0 ignored; a child that had waited on stdin would have timed out.
    assert.equal(observed.timedOut, false);
    assert.equal(observed.aborted, false);

    /* ---- 6. cleanup and teardown ------------------------------------------------------------- */
    assert.deepEqual(run.leaked, [], "the run left temporary material behind");
    assert.equal(observed.treeStopped, true);

    // Nothing planted reached the result.
    const serialised = JSON.stringify(run.result);
    assert.equal(serialised.includes(PLANTED), false, "a credential reached the result");
    assert.equal(/KILN-TASK nonce=/.test(serialised), false, "the frame reached the result");
  } finally {
    run.cleanup();
  }
});

test("⚠️ ACC-0076 a real child that is never answered is stopped, and leaves nothing behind", { timeout: 180_000 }, async () => {
  // ⚠️ THE PROVIDER NEVER REPLIES, so the child waits inside its model turn and only the runtime's bound
  // can end it. This is the identity-aware teardown against a real process tree, on both platforms.
  const run = await realChild({ answer: false, timeoutMs: 4000 });
  try {
    assert.equal(run.result.ok, false);
    assert.equal(run.result.code, "timed-out");
    assert.equal(run.result.observation.timedOut, true);
    assert.equal(run.result.observation.treeStopped, true, "the tree was not confirmed stopped");
    assert.deepEqual(run.leaked, [], "a timed-out run left temporary material behind");
    assert.equal(run.plantedRan, false);
  } finally {
    run.cleanup();
  }
});

test("⚠️ production launches exactly two explicit extensions, and names no test one", async () => {
  // ⚠️ **THE SEAM IS INJECTION ONLY.** It is not a request field and appears in no model-facing schema,
  // so a production call passes nothing and the list is the package and the observer alone.
  let spawnedArgs = null;
  await delegateToSpecialist(
    {
      role: "research",
      task: TASK,
      toolRoot: REPO,
      agentDir: join(tmpdir(), "kiln-realchild-absent"),
      provider: "kiln-loopback",
      model: "loopback-model",
      thinkingLevel: "medium",
      hostRegistry: [...contractFor("research").tools],
      hostEnv: { PATH: process.env.PATH ?? "", HOME: tmpdir() },
      timeoutMs: 1500,
    },
    {
      resolveAgent: () => ({ command: process.execPath, args: ["-e", "setTimeout(() => {}, 50)"] }),
      trackDescendants: (await loadSupervisorPrimitives()).trackDescendants,
      stopTree: (await loadSupervisorPrimitives()).stopTree,
      spawn: (command, args, options) => {
        spawnedArgs = args;
        created.add(options.cwd);
        return spawn(command, ["-e", "setTimeout(() => {}, 50)"], options);
      },
    }
  );

  const loaded = spawnedArgs.map((a, i) => (a === "-e" ? spawnedArgs[i + 1] : null)).filter(Boolean);
  // The agent's own `-e` is part of the resolved command here, so the tail is what the runtime adds.
  const added = loaded.slice(-2);
  assert.equal(added.length, 2, JSON.stringify(loaded));
  assert.ok(added[0].endsWith(join("pi-package", "extensions", "kiln.js")), added[0]);
  assert.ok(added[1].endsWith("task-observer.mjs"), added[1]);
  assert.equal(loaded.some((p) => p.endsWith("provider.js")), false, "a test extension reached a production launch");
  assert.deepEqual(workspaces(), [], "a workspace survived");
});
