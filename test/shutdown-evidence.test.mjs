/**
 * ACC-0081's platform evidence, taken by running the real thing — CMP-0037.
 *
 * ⚠️ **THIS FILE IS THE EVIDENCE, AND IT IS EVIDENCE BECAUSE NOTHING IN IT IS A STAND-IN FOR THE
 * MECHANISM.** Every other supervisor test injects `spawn`, `kill`, `run` or `psRun` so it can
 * observe a decision without starting anything. Those prove the supervisor decides correctly given
 * an answer; they cannot prove the answer. Here the children are real processes, the grandchildren
 * are real processes that outlive their parents, the port is a real port, and the enumeration and
 * the kill are whatever this platform actually provides — `ps` and `kill` on POSIX, `wmic`/`ps` and
 * `taskkill` on Windows.
 *
 * ⚠️ **AND IT RECORDS PER PLATFORM RATHER THAN LETTING ONE STAND FOR THE OTHER (clause 7).** CI runs
 * the suite on `ubuntu-latest` and `windows-latest` independently, so each reports for itself; the
 * observation is written to a file under the run's own directory and asserted here. The platforms
 * differ in the only mechanism that matters: there is no graceful request on Windows, and on POSIX a
 * process group can be targeted only for a child spawned as a group leader — which the foreground
 * agent cannot be, since a detached process cannot read the terminal. So the agent's descendants
 * must be enumerated and signalled individually on both, and the launcher's group form exists only
 * on one.
 *
 * ⚠️ **A KNOWN DESCENDANT OF EACH TREE, NOT ONLY THE LEADERS' EXIT CODES.** Each child spawns a
 * grandchild that does not die with it and handles no signal. Every implementation passes a test
 * whose descendants die on their own, including one that signals only the leader — so these do not.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { installReaper, reapLater } from "./helpers/reap.mjs";
import { probePort, pidAlive } from "../lib/supervisor.mjs";
import { IGNORE_RULES, blockText } from "../lib/project-gitignore.mjs";

installReaper();

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURES = join(ROOT, "test", "fixtures", "supervisor");
const PROJECT_ID = "abcdef0123456789abcdef0123456789";
const execFileAsync = promisify(execFile);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A project the supervisor will accept: a repository, a committed record, and the ignore block. */
function project() {
  const dir = reapLater(mkdtempSync(join(tmpdir(), "kiln-evidence-")));
  mkdirSync(join(dir, ".git"), { recursive: true });
  mkdirSync(join(dir, ".pi"), { recursive: true });
  writeFileSync(join(dir, ".pi", "kiln.json"), JSON.stringify({ recordVersion: 1, projectId: PROJECT_ID }, null, 2) + "\n");
  writeFileSync(join(dir, ".gitignore"), blockText("\n", IGNORE_RULES), "utf-8");
  return dir;
}

const readJson = (p) => JSON.parse(readFileSync(p, "utf-8"));

/** Wait for a file to appear, so "the child got that far" is observed rather than assumed. */
async function until(path, ms = 30_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (existsSync(path)) return readJson(path);
    await sleep(25);
  }
  assert.fail(`${path} never appeared`);
}

/**
 * Run one observed shutdown and return its record.
 *
 * `mode` is `natural` (Pi finishes on its own) or `interrupt` (the operator's Ctrl+C, delivered to
 * the supervisor process once both trees and both grandchildren are up).
 */
async function observe(mode) {
  const dir = project();
  const out = join(dir, "evidence.json");
  const paths = {
    launcher: join(dir, "launcher.json"),
    launcherChild: join(dir, "launcher-child.json"),
    agent: join(dir, "agent.json"),
    agentChild: join(dir, "agent-child.json"),
    ready: join(dir, "ready"),
  };
  const { port } = await probePort(0);

  const child = execFile(process.execPath, [
    join(FIXTURES, "shutdown-evidence.mjs"),
    dir,
    out,
    String(port),
    mode,
    paths.launcher,
    paths.launcherChild,
    paths.agent,
    paths.agentChild,
    paths.ready,
  ]);
  reapLater(child);

  const finished = new Promise((resolve) => child.once("exit", (code) => resolve(code)));

  // ⚠️ THE INTERRUPT WAITS FOR BOTH GRANDCHILDREN. Signalling before they exist would measure a
  // shutdown of two leaves, which is the shape that passes whatever the implementation does.
  if (mode === "interrupt") {
    await until(paths.agentChild);
    await until(paths.launcherChild);
    await sleep(600); // let the trackers sample at least once with the children present
    child.kill("SIGINT");
  }

  await finished;
  assert.ok(existsSync(out), "the run must record an observation whether it completed or refused");
  return { record: readJson(out), paths, dir };
}

/** A pid that is gone stays gone; a survivor is what this whole criterion is about. */
async function goneWithin(pid, ms = 15_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (!pidAlive(pid)) return true;
    await sleep(100);
  }
  return false;
}

/**
 * ⚠️ **THE INTERRUPT PATH IS OBSERVABLE ON POSIX AND NOT ON WINDOWS, AND THAT IS RECORDED RATHER
 * THAN WORKED AROUND.** Measured here: `child.kill("SIGINT")` on Windows is `TerminateProcess` — the
 * target's handler never runs and it dies with `signal: SIGINT` and no chance to write anything; a
 * self-signal exits 1 the same way. What an operator's Ctrl+C actually delivers there is a CONSOLE
 * CONTROL EVENT to the foreground process group, which is not a signal to a pid and which a test
 * harness cannot generate without `GenerateConsoleCtrlEvent`.
 *
 * So this platform's interrupt observation is UNMADE, and ACC-0081 is explicit about what that
 * means: an observation that was not made is recorded as unmade, never treated as one that passed.
 * Faking it — driving the supervisor's signal seam directly — would observe the handler and not the
 * delivery, and would report a platform result the platform did not give.
 */
const INTERRUPT_OBSERVABLE = process.platform !== "win32";

for (const mode of ["natural", "interrupt"]) {
  test(`⚠️ PLATFORM EVIDENCE (${process.platform}, ${mode}): both trees stopped, each with a known descendant`, async (t) => {
    if (mode === "interrupt" && !INTERRUPT_OBSERVABLE)
      return t.skip(
        "windows delivers no handleable signal to another process: kill('SIGINT') is TerminateProcess, " +
          "and an operator's Ctrl+C is a console control event this harness cannot generate. " +
          "ACC-0081's interrupt observation is UNMADE on this platform and must come from the POSIX cell."
      );

    const { record, paths } = await observe(mode);

    // ⚠️ THE RECORD IS PRINTED SO A CI LOG CARRIES IT. The assertions below are the gate; this is
    // what a person reads when one of them fails on a platform they do not have.
    console.log(`\n[evidence ${process.platform}/${mode}]\n${JSON.stringify(record, null, 2)}\n`);

    const launcherChild = readJson(paths.launcherChild).pid;
    const agentChild = readJson(paths.agentChild).pid;
    assert.ok(launcherChild > 0 && agentChild > 0, "each tree really had a descendant");

    assert.equal(record.ok, true, `the shutdown must complete: ${record.refusal ?? ""}`);
    assert.equal(record.trigger, mode === "interrupt" ? "signal" : "agent-exit");
    if (mode === "interrupt") assert.match(record.shutdown.signal ?? "", /^SIG/, "recorded where it was handled");
    else assert.equal(record.shutdown.signal, null, "no signal is fabricated for a run that had none");

    // The seven, each asked for separately.
    assert.equal(record.shutdown.agent.treeStopped, true, "(2,3) the agent tree");
    assert.equal(record.shutdown.launcherTree.treeStopped, true, "(2,3) the launcher tree");
    assert.deepEqual(record.shutdown.agent.descendantsSurviving, [], "(4) nothing of the agent's left");
    assert.deepEqual(record.shutdown.launcherTree.descendantsSurviving, [], "(4) nothing of the launcher's left");
    assert.notEqual(record.shutdown.agent.descendantsEnumerated, false, "(7) the agent's tree was enumerated");
    assert.notEqual(record.shutdown.launcherTree.descendantsEnumerated, false, "(7) the launcher's tree was enumerated");
    assert.equal(record.shutdown.portFree, true, "(5) the port accepts a fresh bind");
    assert.deepEqual(record.shutdown.files.failed, [], "(6) nothing this run owned was left behind");
    assert.deepEqual(record.shutdown.notObserved, [], "every observation was made");
    assert.equal(record.shutdown.complete, true);

    // ⚠️ **AND THE DESCENDANTS ARE CHECKED AGAINST THE OPERATING SYSTEM, not against the record.**
    // Everything above is the supervisor's account of itself. This is the independent one: the two
    // grandchildren were real processes with real pids, and they are not running now.
    assert.equal(await goneWithin(launcherChild), true, `the launcher's descendant ${launcherChild} is still alive`);
    assert.equal(await goneWithin(agentChild), true, `the agent's descendant ${agentChild} is still alive`);
  });
}

test("⚠️ the enumeration really ran on this platform, rather than finding nothing to do", async () => {
  // ⚠️ A GUARD ON THE EVIDENCE ITSELF. Every assertion above is satisfied by an implementation that
  // enumerates nothing and reports an empty tree — `descendantsSurviving: []` reads the same whether
  // the list was empty or never taken. This asserts the descendant was actually SEEN, which is what
  // clause 7 means by including a known descendant rather than only the leader's exit code.
  const { record, paths } = await observe("natural");
  const agentChild = readJson(paths.agentChild).pid;

  assert.ok(
    record.shutdown.agent.descendants?.includes(agentChild),
    `the agent's real descendant ${agentChild} must appear in what was enumerated: ` +
      JSON.stringify(record.shutdown.agent.descendants)
  );
});

test("the platform's own tools are what was used, and they are present here", async () => {
  // Named so a failure on a stripped runner reads as "this image has no `ps`" rather than as a
  // supervisor defect. The evidence above is only meaningful where these exist.
  const [cmd, args] = process.platform === "win32" ? ["cmd", ["/c", "where", "taskkill"]] : ["sh", ["-c", "command -v ps"]];
  const { stdout } = await execFileAsync(cmd, args);
  assert.ok(stdout.trim().length > 0, `this platform's process tool was not found: ${cmd} ${args.join(" ")}`);
});
