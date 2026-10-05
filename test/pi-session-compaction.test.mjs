/**
 * An approved decision bundle across a real Pi compaction and a real restart - #173 (F13).
 *
 * `test/pi-package-decision-bundle.test.mjs` calls the `session_before_compact` handler directly, at every
 * operation boundary. That proves what the handler returns. It cannot prove that the pinned Pi calls it,
 * accepts what it returns, persists it, or rebuilds a later session from it. This file runs the pinned CLI
 * twice over one session directory and reads each of those from where it actually lands:
 *
 *   - the compaction entry, from the session file Pi wrote;
 *   - the rebuilt context, from the request body a loopback provider received after the restart;
 *   - the resume, from the project's artifacts and the bundle journal.
 *
 * ⚠️ **THE SCRIPT DECIDES THE CALL, NOT A MODEL.** After the restart the provider answers with a call to
 * the bundle tool carrying the digest it was sent. Whether a real model follows the checkpoint is not
 * judged here; that the checkpoint reaches it, and that following it works with no confirmation, is.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

import { BUNDLE_STAGE, executeDecisionBundle, planDecisionBundle } from "../lib/decision-bundle.mjs";
import { journalLocation, readJournal } from "../lib/decision-bundle-journal.mjs";
import { STATE_MODE } from "../lib/local-state.mjs";
import { PORTABLE_PACKAGE_ENTRY } from "../lib/pi-package-entry.mjs";
import { resolvePinnedAgent, resolvePinnedSdk } from "../lib/pi-runtime.mjs";
import { mergeSettingsText } from "../lib/pi-settings.mjs";
import { loadSchemaSet } from "../lib/schema-resolver.mjs";
import * as stageDocuments from "../lib/stage-documents.mjs";
import { createRequirement } from "../lib/tools/create-requirement.mjs";
import { MUTATION_TOOLS } from "../lib/tools/registry.mjs";
import { createValidators } from "../lib/validate.mjs";
import { piToolAllowlist, withToolAllowlist } from "../bin/start-kiln.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCHEMAS = join(ROOT, "schemas");
const sdk = await import(resolvePinnedSdk(ROOT).url);

const TOOL = "kiln_apply_stage4_decision_bundle";
const PLANTED_KEY = "sk-kiln-LOOPBACK-PLANTED-c173";
const KINDS = ["create-question", "create-decision", "resolve-question", "revise-artifact", "link-trace", "approve-decision", "write-stage-note"];
/** Enough words that a turn is larger than the few tokens this fixture tells Pi to keep. */
const FILLER = "The port office reconciles dock fees against invoices every week. ".repeat(40);

const CREDENTIAL_SHAPED = /(API_?KEY|ACCESS_?KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL|_AUTH)/i;
const childEnvironment = () =>
  Object.fromEntries(Object.entries(process.env).filter(([name]) => !CREDENTIAL_SHAPED.test(name) && !/^(kiln_self_host|planning_content_dir|kiln_project_root|kiln_state_mode)$/i.test(name)));

const chunk = (delta, finish = null) =>
  `data: ${JSON.stringify({ id: "chatcmpl-loopback", object: "chat.completion.chunk", created: 1, model: "loopback-model", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;

/** A loopback provider that records every request. `script` holds the next replies; with none left it says "Noted." */
async function scriptedProvider() {
  const requests = [];
  const script = [];
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
      if (reply.tool) {
        res.write(chunk({ role: "assistant", content: "" }));
        res.write(chunk({ tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: reply.tool, arguments: JSON.stringify(reply.arguments) } }] }));
        res.write(chunk({}, "tool_calls"));
      } else {
        res.write(chunk({ role: "assistant", content: reply.text }));
        res.write(chunk({}, "stop"));
      }
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  return { port: server.address().port, requests, script, close: () => new Promise((done) => server.close(done)) };
}

const PROBE_SOURCE = (port) => `
import { appendFileSync } from "node:fs";
export default function (pi) {
  pi.registerProvider("kiln-loopback", {
    baseUrl: "http://127.0.0.1:${port}/v1",
    apiKey: "$KILN_LOOPBACK_KEY",
    api: "openai-completions",
    models: [{ id: "loopback-model", name: "Loopback", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 1024 }],
  });
  pi.on("tool_execution_end", (e) => appendFileSync(process.env.KILN_EVENTS_OUT, JSON.stringify({ toolName: e.toolName, isError: e.isError === true }) + "\\n"));
}
`;

/** A consumer project whose tool copy has its own `lib/`, with one approved requirement and a Stage 4 document. */
async function fixture() {
  const base = mkdtempSync(join(tmpdir(), "kiln-compaction-session-"));
  const project = join(base, "project");
  const tool = join(project, ".planning");
  const contentRoot = join(project, "planning-content");
  const paths = { base, project, tool, contentRoot, agentDir: join(base, "agent"), home: join(base, "home"), sessions: join(base, "sessions"), probe: join(base, "probe", "probe.js"), events: join(base, "events.jsonl"), modules: join(base, "node_modules") };

  for (const dir of [join(project, ".pi", "runtime"), tool, join(contentRoot, "stages"), paths.agentDir, paths.home, dirname(paths.probe)]) mkdirSync(dir, { recursive: true });
  for (const dir of ["lib", "schemas", "stages", "pi-package"]) cpSync(join(ROOT, dir), join(tool, dir), { recursive: true });
  cpSync(join(ROOT, "package.json"), join(tool, "package.json"));
  symlinkSync(join(ROOT, "node_modules"), paths.modules, "junction");

  writeFileSync(join(contentRoot, "project.yaml"), "name: fixture\ncapabilities:\n  artifactTypes:\n    activated: [requirement, decision, question]\n  sandboxTiers:\n    active:\n      - 1\n");
  writeFileSync(
    join(contentRoot, "stages", `${BUNDLE_STAGE}.md`),
    `# Stage 04 - Requirement Gaps\n\n${stageDocuments.intakeSection()}\n${stageDocuments.WORKING_NOTES_HEADING}\n\n${stageDocuments.WORKING_NOTES_PLACEHOLDER}\n`
  );
  // ⚠️ A FEW TOKENS KEPT, so three short turns are enough for Pi to have something to compact.
  const settings = JSON.parse(mergeSettingsText(null, { stateMode: STATE_MODE.USER, provider: "kiln-loopback", model: "loopback-model", thinkingLevel: "off", packageEntry: PORTABLE_PACKAGE_ENTRY }));
  writeFileSync(join(project, ".pi", "settings.json"), JSON.stringify({ ...settings, compaction: { enabled: false, reserveTokens: 1024, keepRecentTokens: 200 } }, null, 2));
  new sdk.ProjectTrustStore(paths.agentDir).set(project, true);
  return paths;
}

function removeFixture(fx) {
  // ⚠️ THE LINK FIRST, ON ITS OWN, so the recursive removal below cannot follow it into the repository.
  if (existsSync(fx.modules) && lstatSync(fx.modules).isSymbolicLink()) unlinkSync(fx.modules);
  else if (existsSync(fx.modules)) throw new Error("the fixture's node_modules is not the link this test made; nothing is removed");
  rmSync(fx.base, { recursive: true, force: true });
}

/** Approve a full bundle and stop it after two operations, as an interrupted tool call leaves it. */
async function unfinishedBundle(fx) {
  const schemas = loadSchemaSet(SCHEMAS);
  const validators = createValidators(SCHEMAS);
  const base = { contentRoot: fx.contentRoot, schemasDir: SCHEMAS, schemas, validators };
  const requirement = await createRequirement({ title: "Export results", statement: "The system exports results.", priority: "must" }, base);

  const controller = new AbortController();
  let done = 0;
  const stopAfterTwo = (fn) => async (...args) => {
    const result = await fn(...args);
    if (args.at(-1)?.dryRun !== true && ++done === 2) controller.abort();
    return result;
  };
  const { TYPED_TOOLS } = await import("../lib/tools/registry.mjs");
  const options = {
    ...base,
    journal: journalLocation({ projectRoot: fx.project }),
    reviewedBy: "operator via a test",
    currentStage: async () => BUNDLE_STAGE,
    signal: controller.signal,
    TYPED_TOOLS: { ...TYPED_TOOLS, question: stopAfterTwo(TYPED_TOOLS.question), decision: stopAfterTwo(TYPED_TOOLS.decision) },
    MUTATION_TOOLS,
  };
  const planned = await planDecisionBundle(
    {
      question: { title: "Export format", statement: "REAL-SESSION-QUESTION Which export formats are in scope?" },
      decision: { title: "CSV only", statement: "Export supports CSV only in the first release.", rationale: "It is what the operator asked for." },
      answer: "CSV only.",
      revisions: [{ type: "requirement", id: requirement.id, changes: { statement: "The system exports results as CSV." } }],
      links: [{ action: "link", type: "requirement", id: requirement.id, field: "openQuestions", targets: ["$question"] }],
      stageNote: { action: "append-working-note", subsection: "export-format", title: "Export format", content: "Decided: CSV only.", expectedRevision: stageDocuments.readWorkingNotes(fx.contentRoot, BUNDLE_STAGE).revision },
    },
    options
  );
  const stopped = await executeDecisionBundle(planned.plan, options);
  assert.equal(stopped.code, "bundle-interrupted");
  assert.equal(stopped.checkpoint.firstIncomplete, 2);
  return { digest: stopped.checkpoint.digest, checkpoint: stopped.checkpoint, requirementId: requirement.id };
}

/**
 * One run of the pinned CLI in RPC mode. `drive` sends commands and waits on what Pi prints.
 *
 * @returns {Promise<{lines: object[], stderr: string}>} every JSON line Pi printed
 */
async function piSession(fx, provider, extraArgs, drive) {
  writeFileSync(fx.probe, PROBE_SOURCE(provider.port));
  const agent = withToolAllowlist(resolvePinnedAgent(ROOT), await piToolAllowlist(ROOT));
  const child = spawn(agent.command, [...agent.args, "--session-dir", fx.sessions, "-e", fx.probe, "--provider", "kiln-loopback", "--model", "loopback-model", "--mode", "rpc", "--offline", ...extraArgs], {
    cwd: fx.project,
    env: {
      ...childEnvironment(),
      HOME: fx.home,
      USERPROFILE: fx.home,
      PI_CODING_AGENT_DIR: fx.agentDir,
      PLANNING_CONTENT_DIR: fx.contentRoot,
      // What Kiln's supervisor sets, and how the extension finds the journal.
      KILN_PROJECT_ROOT: fx.project,
      KILN_STATE_MODE: "project",
      KILN_EVENTS_OUT: fx.events,
      KILN_LOOPBACK_KEY: PLANTED_KEY,
      PI_OFFLINE: "1",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });

  const lines = [];
  const waiters = [];
  let buffered = "";
  let stderr = "";
  let exited = false;
  const settle = () => {
    for (const waiter of [...waiters]) {
      const found = waiter.find();
      if (found !== undefined || exited) {
        waiters.splice(waiters.indexOf(waiter), 1);
        clearTimeout(waiter.timer);
        if (found !== undefined) waiter.resolve(found);
        else waiter.reject(new Error(`Pi exited while waiting for ${waiter.what}.\n${stderr.slice(-2000)}`));
      }
    }
  };
  child.stdout.on("data", (data) => {
    buffered += data;
    let at;
    while ((at = buffered.indexOf("\n")) !== -1) {
      const line = buffered.slice(0, at).trim();
      buffered = buffered.slice(at + 1);
      if (line.length === 0) continue;
      try {
        lines.push(JSON.parse(line));
      } catch {
        // Not a protocol line.
      }
    }
    settle();
  });
  child.stderr.on("data", (data) => (stderr += data));
  const closed = new Promise((done) => child.on("exit", () => ((exited = true), settle(), done())));

  const io = {
    send: (command) => child.stdin.write(`${JSON.stringify(command)}\n`),
    /** Resolves with the `count`-th line matching `match`. */
    waitFor: (what, match, count = 1) =>
      new Promise((resolve, reject) => {
        const waiter = { what, resolve, reject, find: () => lines.filter(match)[count - 1] };
        waiter.timer = setTimeout(() => {
          waiters.splice(waiters.indexOf(waiter), 1);
          reject(new Error(`Timed out waiting for ${what}.\n${JSON.stringify(lines.slice(-6))}\n${stderr.slice(-2000)}`));
        }, 90_000);
        waiters.push(waiter);
        settle();
      }),
  };
  try {
    await drive(io);
  } finally {
    child.kill();
    await closed;
  }
  return { lines, stderr };
}

const settled = (line) => line.type === "agent_settled";
const textOf = (content) => (typeof content === "string" ? content : (content ?? []).filter((part) => part.type === "text").map((part) => part.text).join("\n"));
const sessionEntries = (fx) =>
  readdirSync(fx.sessions, { recursive: true })
    .filter((name) => String(name).endsWith(".jsonl"))
    .flatMap((name) => readFileSync(join(fx.sessions, String(name)), "utf-8").split("\n").filter(Boolean).map((line) => JSON.parse(line)));

test("⚠️ #173 an approved bundle survives a real Pi compaction and restart, and resumes with no confirmation", async () => {
  const fx = await fixture();
  const provider = await scriptedProvider();
  try {
    const bundle = await unfinishedBundle(fx);

    /* ---------------- session one: three turns, then a compaction Pi itself runs ---------------- */
    let compactResponse;
    const first = await piSession(fx, provider, [], async (io) => {
      for (const [index, said] of ["OPERATOR-TURN-ONE", "OPERATOR-TURN-TWO", "OPERATOR-TURN-THREE"].entries()) {
        io.send({ id: `p${index}`, type: "prompt", message: `${said} ${FILLER}` });
        await io.waitFor(`turn ${index + 1} to settle`, settled, index + 1);
      }
      io.send({ id: "compact", type: "compact" });
      compactResponse = await io.waitFor("the compact response", (line) => line.type === "response" && line.command === "compact");
    });
    assert.equal(compactResponse.success, true, JSON.stringify(compactResponse));

    // ⚠️ THE FRAME REACHED THE PROVIDER BEFORE ANY COMPACTION: every turn was told the bundle is unfinished.
    const system = textOf(provider.requests[0].messages.find((m) => m.role === "system" || m.role === "developer").content);
    assert.ok(system.includes(`Approved decision bundle: ${bundle.digest} (authorized).`), "the stage frame did not carry the checkpoint");

    // ⚠️ THE ENTRY PI PERSISTED, read from the session file rather than from the handler's return value.
    const compactions = sessionEntries(fx).filter((entry) => entry.type === "compaction");
    assert.equal(compactions.length, 1, "Pi wrote exactly one compaction entry");
    const [entry] = compactions;
    assert.equal(entry.fromHook ?? entry.fromExtension, true, "the entry is recorded as supplied by an extension");
    assert.deepEqual(entry.details, {
      kilnCheckpoint: {
        checkpointVersion: 1,
        stage: BUNDLE_STAGE,
        digest: bundle.digest,
        status: "authorized",
        ids: { question: "QST-0001", decision: "DEC-0001" },
        firstIncomplete: 2,
        operations: KINDS.map((kind, index) => ({ index, kind, target: bundle.checkpoint.operations[index].target, status: index < 2 ? "completed" : "pending" })),
      },
    });
    assert.ok(entry.summary.includes("Current question: REAL-SESSION-QUESTION Which export formats are in scope?"));
    assert.ok(entry.summary.includes("First incomplete operation: 3. resolve-question QST-0001 (pending)."));
    assert.ok(entry.summary.includes(`Next action: call ${TOOL} with only resumeDigest set to that digest.`));
    assert.ok(entry.summary.includes("OPERATOR-TURN-ONE"), "what the operator said in a discarded turn is kept");
    // The boundary is one Pi chose: an entry of this session, and not the first, so something was compacted.
    const ids = sessionEntries(fx).map((e) => e.id);
    assert.ok(ids.indexOf(entry.firstKeptEntryId) > 0, "firstKeptEntryId is not an entry Pi wrote");
    assert.ok(Number.isFinite(entry.tokensBefore) && entry.tokensBefore > 0);
    // ⚠️ WHAT KILN SUPPLIED. Pi adds fields of its own to the entry, its system-prompt snapshot among them, and those are not Kiln's.
    const supplied = JSON.stringify({ summary: entry.summary, details: entry.details });
    for (const forbidden of [PLANTED_KEY, fx.base, fx.base.split("\\").join("/"), homedir()]) assert.ok(!supplied.includes(forbidden), `the summary or details carry ${forbidden}`);

    // Nothing ran: a compaction changes no artifact and the journal is as it was.
    assert.equal(readJournal(journalLocation({ projectRoot: fx.project })).journal.status, "authorized");

    /* ---------------- session two: a new process, continuing the same session ---------------- */
    const before = provider.requests.length;
    provider.script.push({ tool: TOOL, arguments: { resumeDigest: entry.details.kilnCheckpoint.digest } }, { text: "Resumed." });
    const second = await piSession(fx, provider, ["--continue"], async (io) => {
      io.send({ id: "resume", type: "prompt", message: "Please continue." });
      await io.waitFor("the resumed turn to settle", settled);
    });

    // ⚠️ THE REBUILT CONTEXT, read from what the provider received after the restart.
    const rebuilt = provider.requests[before];
    const conversation = rebuilt.messages.filter((m) => m.role !== "system" && m.role !== "developer").map((m) => textOf(m.content)).join("\n");
    assert.ok(conversation.includes(`Approved decision bundle: ${bundle.digest} (authorized).`), "the restarted session was not rebuilt from the compaction summary");
    assert.ok(conversation.includes("Current question: REAL-SESSION-QUESTION"));
    assert.ok(!conversation.includes(`OPERATOR-TURN-ONE ${FILLER}`), "the compacted turn is no longer sent verbatim");

    // The tool ran once, without error, and its result went back to the provider as an action-completed.
    const executions = readFileSync(fx.events, "utf-8").trim().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(executions, [{ toolName: TOOL, isError: false }]);
    const toolMessage = provider.requests[before + 1].messages.find((m) => m.role === "tool");
    const result = JSON.parse(textOf(toolMessage.content));
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.status, "action-completed");
    assert.deepEqual(result.changed.map((c) => c.operation), KINDS);

    // ⚠️ NO CONFIRMATION WAS ASKED, in either session: RPC mode prints every dialog request it makes.
    for (const run of [first, second])
      assert.deepEqual(run.lines.filter((line) => line.type === "extension_ui_request" && line.method === "confirm"), [], "a confirmation dialog was opened");

    // And the project is where the approved bundle leaves it, with nothing created twice.
    const read = (dir, id) => JSON.parse(readFileSync(join(fx.contentRoot, "data", dir, `${id}.json`), "utf-8"));
    assert.equal(read("questions", "QST-0001").resolution, "answered");
    assert.equal(read("decisions", "DEC-0001").reviewStatus, "approved");
    assert.equal(read("requirements", bundle.requirementId).statement, "The system exports results as CSV.");
    assert.deepEqual(readdirSync(join(fx.contentRoot, "data", "questions")), ["QST-0001.json"]);
    assert.deepEqual(readdirSync(join(fx.contentRoot, "data", "decisions")), ["DEC-0001.json"]);
    assert.equal(readJournal(journalLocation({ projectRoot: fx.project })).journal.status, "completed");
  } finally {
    await provider.close();
    removeFixture(fx);
  }
});

test("⚠️ #173 with no bundle in flight, a real Pi compaction still carries Kiln's stage checkpoint", async () => {
  const fx = await fixture();
  const provider = await scriptedProvider();
  try {
    provider.script.push({ text: "Noted." }, { text: "Noted." }, { text: "PENDING-PROPOSAL Shall I record CSV as the only export format?" });
    let compactResponse;
    await piSession(fx, provider, [], async (io) => {
      for (const [index, said] of ["OPERATOR-TURN-ONE", "OPERATOR-TURN-TWO", "OPERATOR-TURN-THREE"].entries()) {
        io.send({ id: `p${index}`, type: "prompt", message: `${said} ${FILLER}` });
        await io.waitFor(`turn ${index + 1} to settle`, settled, index + 1);
      }
      io.send({ id: "compact", type: "compact" });
      compactResponse = await io.waitFor("the compact response", (line) => line.type === "response" && line.command === "compact");
    });
    assert.equal(compactResponse.success, true, JSON.stringify(compactResponse));

    const [entry] = sessionEntries(fx).filter((e) => e.type === "compaction");
    assert.ok(entry, "Pi wrote no compaction entry");
    // This fixture has attested nothing, so Kiln's own derivation puts it at Stage 1.
    assert.equal(entry.details.kilnCheckpoint.stage, "01-intake");
    assert.equal(entry.details.kilnCheckpoint.status, "none");
    assert.deepEqual(Object.keys(entry.details.kilnCheckpoint).sort(), ["checkpointVersion", "pending", "stage", "status"]);
    assert.ok(entry.summary.includes("Stage: 01-intake"));
    assert.ok(entry.summary.includes("No approved decision bundle is in flight."));
    assert.ok(entry.summary.includes("OPERATOR-TURN-ONE"));

    // The open proposal survives one way or the other: copied into the summary, or kept verbatim after it.
    provider.script.push({ text: "Noted." });
    const before = provider.requests.length;
    await piSession(fx, provider, ["--continue"], async (io) => {
      io.send({ id: "next", type: "prompt", message: "Yes." });
      await io.waitFor("the next turn to settle", settled);
    });
    const conversation = provider.requests[before].messages.filter((m) => m.role !== "system" && m.role !== "developer").map((m) => textOf(m.content)).join("\n");
    assert.ok(conversation.includes("PENDING-PROPOSAL Shall I record CSV as the only export format?"), `the open proposal was lost (pending: ${entry.details.kilnCheckpoint.pending})`);
    assert.ok(conversation.includes("No approved decision bundle is in flight."));
  } finally {
    await provider.close();
    removeFixture(fx);
  }
});
