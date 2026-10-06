/**
 * One real delegation from a clean consumer, with spaces in the checkout path - #176.
 *
 * v26.9.0 refused every `kiln_delegate` with `child-executable-not-found`, on an installation whose setup
 * preflight had just run the same pinned agent. The reported checkout sat under a directory with ordinary
 * Windows spelling, so this fixture keeps a space in every level of the path: the base, the project and
 * therefore the clone, the agent directory and the temporary directory a child is started in.
 *
 * ⚠️ **A REAL CLONE, A REAL INSTALL, A REAL CHILD.** The tracked files of this checkout are committed to a
 * scratch repository and cloned into `<project>/.planning`, as a consumer gets them. The clone's own setup
 * bootstrap installs its locked dependencies. The package's wrapper is then called with nothing injected, and
 * it starts the pinned agent as a child process.
 *
 * ⚠️ **THE ONLY THING REPLACED IS THE PROVIDER.** The isolated agent directory's `models.json` names a provider on
 * the loopback interface with a placeholder key, so nothing billable can be reached and no credential exists.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { FIXTURE_KEY, FIXTURE_MODEL, FIXTURE_PROVIDER, modelsJson, startProviderFixture } from "./helpers/provider-fixture.mjs";
import { removeTestTree } from "./helpers/cleanup.mjs";

const ROOT = join(import.meta.dirname, "..");
/** The clone's locked install happens inside this bound. */
const LONG_MS = 12 * 60_000;
const ANSWER = "CONSUMER-DELEGATION-ANSWER-4d1f: the plan needs one owner per decision.";
const TASK = "State in one sentence what this plan needs most.";

const git = (args, cwd) => execFileSync("git", args, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] });

/** A Git repository holding this checkout's tracked files as they are on disk, committed once. */
function trackedSnapshot(into) {
  mkdirSync(into, { recursive: true });
  for (const f of git(["ls-files", "-z"], ROOT).split("\0").filter(Boolean)) {
    const from = join(ROOT, f);
    if (!existsSync(from) || !statSync(from).isFile()) continue;
    mkdirSync(dirname(join(into, f)), { recursive: true });
    copyFileSync(from, join(into, f));
  }
  git(["init", "-q"], into);
  git(["add", "-A"], into);
  git(["-c", "user.name=Kiln Consumer", "-c", "user.email=consumer@kiln.invalid", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "tracked snapshot"], into);
  return into;
}

function node(args, { cwd, env, boundMs }) {
  return new Promise((done) => {
    const child = spawn(process.execPath, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    const bound = setTimeout(() => child.kill(), boundMs);
    child.on("close", (status, signal) => {
      clearTimeout(bound);
      done({ status, signal, stdout, stderr });
    });
  });
}

const text = (m) => (typeof m.content === "string" ? m.content : (m.content ?? []).map((c) => c.text ?? "").join(""));

test("⚠️ #176 a clean consumer clone in a path with spaces delegates once, for real, through the package's own wrapper", { timeout: LONG_MS + 5 * 60_000 }, async () => {
  const fixture = await startProviderFixture({ script: [{ text: ANSWER }] });
  const base = mkdtempSync(join(tmpdir(), "kiln consumer delegation "));
  const project = join(base, "client project");
  const toolRoot = join(project, ".planning");
  const agentDir = join(base, "agent dir");
  try {
    for (const path of [base, project, toolRoot, agentDir]) assert.ok(path.includes(" "), `the fixture path has no space in it: ${path}`);

    const source = trackedSnapshot(join(base, "tool source"));
    mkdirSync(project);
    mkdirSync(agentDir);
    git(["init", "-q"], project);
    git(["clone", "-q", source, ".planning"], project);
    assert.equal(existsSync(join(toolRoot, "node_modules")), false, "the clone arrived with dependencies; this is not a clean consumer");

    // The consumer layout's own content root, beside the clone.
    mkdirSync(join(project, "planning-content"));
    writeFileSync(join(project, "planning-content", "project.yaml"), "name: consumer delegation\n");

    // ⚠️ THE KEY IS WRITTEN INLINE, BECAUSE A DELEGATED CHILD IS NOT HANDED THE HOST'S VARIABLES. Its environment is
    // built name by name, so a `$VARIABLE` reference would resolve to nothing in the child. It is a placeholder.
    const models = modelsJson(fixture.url);
    models.providers[FIXTURE_PROVIDER].apiKey = FIXTURE_KEY;
    writeFileSync(join(agentDir, "auth.json"), "{}");
    writeFileSync(join(agentDir, "models.json"), JSON.stringify(models));

    const env = { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1" };
    // ⚠️ THE CONTENT ROOT IS THE CONSUMER LAYOUT'S, resolved beside the clone as an operator gets it.
    delete env.PLANNING_CONTENT_DIR;
    env.KILN_CONSUMER_DELEGATION = JSON.stringify({ toolRoot, role: "planning", task: TASK, provider: FIXTURE_PROVIDER, model: FIXTURE_MODEL });

    // The driver is copied beside the project, so it imports only from the clone it is told about.
    const driver = join(base, "delegate once.mjs");
    copyFileSync(join(ROOT, "test", "fixtures", "consumer", "delegate-once.mjs"), driver);
    const run = await node([driver], { cwd: project, env, boundMs: LONG_MS });
    const printed = /KILN_CONSUMER_RESULT (.+)/.exec(run.stdout);
    assert.ok(printed, `the delegation driver did not finish (status ${run.status}, signal ${run.signal}):\n${run.stdout.slice(-2000)}\n${run.stderr.slice(-3000)}`);
    const outcome = JSON.parse(printed[1]);

    // The clone installed its own locked dependencies, and setup's resolver found the pinned agent in them.
    assert.equal(outcome.installed, true, "the clone's dependencies were not installed by its own bootstrap");
    const pinned = JSON.parse(readFileSync(join(toolRoot, "package.json"), "utf-8")).dependencies["@earendil-works/pi-coding-agent"];
    assert.equal(outcome.preflightVersion, pinned);

    // ⚠️ THE REGRESSION: the delegation that follows that preflight starts the same agent and returns its answer.
    const { result } = outcome;
    assert.notEqual(result.code, "child-executable-not-found", `the wrapper could not find the executable the preflight had just resolved: ${JSON.stringify(result)}`);
    assert.equal(result.ok, true, `the delegation was refused: ${JSON.stringify(result)}`);
    assert.equal(result.role, "planning");
    assert.equal(result.output, ANSWER);
    assert.equal(result.observed.taskBindingObserved, true);
    assert.equal(result.observed.provider, FIXTURE_PROVIDER);
    assert.equal(result.observed.model, FIXTURE_MODEL);

    // One authorised request reached the loopback provider, carrying the role and the task; nothing else left.
    const completions = fixture.requests.filter((r) => r.path === "/v1/chat/completions");
    assert.equal(completions.length, 1, `the child made ${completions.length} provider requests`);
    assert.equal(completions[0].authorized, true);
    const messages = completions[0].body.messages;
    assert.ok(messages.filter((m) => m.role === "system" || m.role === "developer").map(text).join("\n").includes("Planning specialist"), "the role definition did not reach the child");
    assert.ok(messages.filter((m) => m.role === "user").map(text).join("\n").includes(TASK), "the task did not reach the child");

    // No path of this machine is in what a model would be shown.
    for (const leaked of [base, base.split("\\").join("/"), "node_modules"]) assert.equal(JSON.stringify(result).includes(leaked), false, `the result carries ${leaked}`);
  } finally {
    await fixture.close();
    await removeTestTree(base);
  }
});
