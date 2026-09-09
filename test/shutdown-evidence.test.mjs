/**
 * ACC-0081's platform evidence, taken by running the real thing — CMP-0037.
 *
 * ⚠️ **THIS FILE IS THE EVIDENCE, AND IT IS EVIDENCE BECAUSE NOTHING IN IT IS A STAND-IN FOR THE
 * MECHANISM.** Every other supervisor test injects `spawn`, `kill`, `run` or `psRun` so it can
 * observe a decision without starting anything. Those prove the supervisor decides correctly given
 * an answer; they cannot prove the answer. Here the children are real processes, the grandchildren
 * are real processes that outlive their parents, the port is a real port, the file removed at the
 * end is one a real run created, and the enumeration and the kill are whatever this platform
 * actually provides — `ps` and `kill` on POSIX, `Get-CimInstance Win32_Process` and `taskkill` on
 * Windows, where `wmic` is absent from build 26200 and the CIM query is what production uses.
 *
 * ⚠️ **AND IT RECORDS PER PLATFORM RATHER THAN LETTING ONE STAND FOR THE OTHER (clause 7).** CI runs
 * the suite on `ubuntu-latest` and `windows-latest` independently, so each reports for itself; the
 * observation is written to a file under the run's own directory and asserted here. The platforms
 * differ in the only mechanism that matters: there is no graceful signal on Windows, and on POSIX a
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
import { probePort, pidAlive, runFilePath, SHUTDOWN_MIN_PHASE_MS } from "../lib/supervisor.mjs";
import { IGNORE_RULES, blockText } from "../lib/project-gitignore.mjs";

installReaper();

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURES = join(ROOT, "test", "fixtures", "supervisor");
const PROJECT_ID = "abcdef0123456789abcdef0123456789";
const execFileAsync = promisify(execFile);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * A project the supervisor will accept: a repository, a committed record, the ignore block, and the
 * runtime directory setup creates.
 *
 * ⚠️ **THE STRANGER IN THE RUNTIME DIRECTORY IS HALF OF CLAUSE 6.** "Its own file is gone" is
 * satisfied by a shutdown that empties the directory, which is the failure the criterion is worded
 * against — another Kiln may be running in this project right now, and its live-run file has the
 * same name shape. So a file this run did not create is put there first and must still be there.
 */
function project() {
  const dir = reapLater(mkdtempSync(join(tmpdir(), "kiln-evidence-")));
  mkdirSync(join(dir, ".git"), { recursive: true });
  mkdirSync(join(dir, ".pi", "runtime"), { recursive: true });
  writeFileSync(join(dir, ".pi", "kiln.json"), JSON.stringify({ recordVersion: 1, projectId: PROJECT_ID }, null, 2) + "\n");
  writeFileSync(join(dir, ".gitignore"), blockText("\n", IGNORE_RULES), "utf-8");
  writeFileSync(strangerIn(dir), "not this run's\n", "utf-8");
  return dir;
}

const strangerIn = (dir) => join(dir, ".pi", "runtime", `run-${"ab".repeat(16)}.json`);
// ⚠️ THE BOM IS STRIPPED, because PowerShell 5.1's `Out-File -Encoding utf8` writes one and
// `JSON.parse` refuses it. A harness that reported "invalid JSON" here would be blaming the
// observation for the way it was written down.
const readJson = (p) => JSON.parse(stripBom(readFileSync(p, "utf-8")));
const stripBom = (text) => (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);

/** Wait for a file to appear, so "the child got that far" is observed rather than assumed. */
async function until(path, ms = 30_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (existsSync(path)) return readJson(path);
    await sleep(25);
  }
  assert.fail(`${path} never appeared`);
}

/** Wait for whichever of these appears first, so a refusal does not have to be waited out. */
async function untilAny(paths, ms = 60_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    for (const p of paths) if (existsSync(p)) return p;
    await sleep(25);
  }
  assert.fail(`none of ${paths.join(", ")} appeared`);
}

/**
 * Run one observed shutdown and return its record.
 *
 * `mode` is `natural` (Pi finishes on its own) or `interrupt` (the operator's interrupt, delivered
 * once both trees and both grandchildren are up).
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
  const argv = [
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
  ];

  if (mode === "interrupt" && process.platform === "win32") return viaConsoleEvent({ dir, out, argv, paths });

  const child = execFile(process.execPath, argv);
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
  return { record: readJson(out), paths, dir, delivery: { how: "signal" } };
}

/**
 * The Windows interrupt, generated as a real console control event.
 *
 * ⚠️ **`child.kill("SIGINT")` IS NOT AN INTERRUPT ON WINDOWS AND THIS IS WHY THE ROUTE EXISTS.**
 * Measured: it is `TerminateProcess` — the target's handler never runs and it dies reporting
 * `SIGKILL`. What an operator's Ctrl+C or Ctrl+Break delivers is a CONSOLE CONTROL EVENT to every
 * process attached to the console, which no Node API can generate. `GenerateConsoleCtrlEvent` can,
 * so a small PowerShell harness allocates a PRIVATE console, starts the supervisor in it, and sends
 * `CTRL_BREAK_EVENT` — which Node surfaces as `SIGBREAK`, one of the signals the supervisor watches.
 *
 * ⚠️ **IT IS CTRL+BREAK AND NOT CTRL+C, AND THAT LIMIT IS MEASURED.** Both were tried against a
 * child handling each: the Ctrl+Break handler ran and the Ctrl+C handler never did, because a
 * process started from PowerShell inherits Ctrl+C disabled and nothing can clear that from outside.
 * So this cell observes the SIGBREAK path — the same handler, the same shutdown, the trigger
 * recorded as what it was — and the SIGINT DELIVERY itself is observed only by the POSIX cell.
 *
 * ⚠️ **AND THE EVENT REACHES THE PROCESS TABLE PROGRAM TOO, which is how a real defect surfaced.**
 * PowerShell answers Ctrl+Break by breaking into its debugger, so the CIM query the supervisor had
 * in flight never returned; six runs hung on it. The shutdown now bounds that query and the join —
 * `PROCESS_TABLE_TIMEOUT_MS` — and the look is recorded as unresolved rather than waited for.
 *
 * ⚠️ **AND IT REFUSES RATHER THAN SENDING INTO A SHARED CONSOLE.** Group 0 means "everything in my
 * console"; sent from a process still attached to the test runner's console it would interrupt the
 * test run. The harness proves the console is private — `GetConsoleProcessList` naming only itself
 * and the supervisor — before sending, and reports the observation unmade if it cannot.
 */
async function viaConsoleEvent({ dir, out, argv, paths }) {
  const plan = join(dir, "ctrl-break-plan.json");
  const result = join(dir, "ctrl-break-result.json");
  const trigger = join(dir, "ctrl-break-trigger");
  const log = join(dir, "supervisor.log");
  writeFileSync(plan, JSON.stringify({ exe: process.execPath, args: argv, trigger, result, log }) + "\n", "utf-8");

  const ps = execFile("powershell", [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    join(FIXTURES, "ctrl-break.ps1"),
    "-Plan",
    plan,
  ]);
  reapLater(ps);
  const finished = new Promise((resolve) => ps.once("exit", (code) => resolve(code)));

  // Either both trees come up — and then the event is sent — or the harness reports it could not.
  const first = await untilAny([paths.agentChild, result]);
  if (first !== result) {
    await until(paths.launcherChild);
    await sleep(3500); // the Windows tracker polls every 3s; let one land with the children present
    writeFileSync(trigger, "go\n", "utf-8");
  }

  await finished;
  const delivery = existsSync(result) ? { how: "console-ctrl-event", ...readJson(result) } : { how: "console-ctrl-event" };
  // ⚠️ THE SUPERVISOR'S OWN LOG IS CARRIED BACK. On this route nothing is capturing its output, and a
  // cell that failed with neither a record nor a log is a cell nobody can act on.
  if (existsSync(log)) delivery.log = readFileSync(log, "utf-8").trimEnd().split("'+NL+'");
  return { record: existsSync(out) ? readJson(out) : null, paths, dir, delivery };
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

for (const mode of ["natural", "interrupt"]) {
  test(`⚠️ PLATFORM EVIDENCE (${process.platform}, ${mode}): both trees stopped, each with a known descendant`, async (t) => {
    const { record, paths, dir, delivery } = await observe(mode);

    // ⚠️ **AN OBSERVATION THAT COULD NOT BE MADE IS RECORDED AS UNMADE, NEVER APPROXIMATED.** The
    // console harness refuses to send into a console it does not own, and on a runner where it
    // cannot get a private one there is no way to deliver a real interrupt at all. Driving the
    // supervisor's signal seam instead would observe the handler and not the delivery, and would
    // report a platform result this platform did not give.
    if (!record && delivery.refusal)
      return t.skip(
        `the Windows interrupt could not be delivered safely here: ${delivery.refusal}. ` +
          `ACC-0081's interrupt observation is UNMADE on this run and is reported as unmade.`
      );

    assert.ok(record, "the run must record an observation whether it completed or refused");

    // ⚠️ THE RECORD IS PRINTED SO A CI LOG CARRIES IT. The assertions below are the gate; this is
    // what a person reads when one of them fails on a platform they do not have.
    console.log(`\n[evidence ${process.platform}/${mode}]\n${JSON.stringify({ delivery, ...record }, null, 2)}\n`);

    if (delivery.how === "console-ctrl-event") {
      assert.equal(delivery.isolated, true, "the event must have gone to a console holding only the supervisor");
      assert.equal(delivery.sent, true, "GenerateConsoleCtrlEvent must have reported success");
    }

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
    assert.deepEqual(record.shutdown.notObserved, [], "every observation was made");
    assert.equal(record.shutdown.complete, true);

    // ⚠️ **CLAUSE 6, BOTH WAYS.** `files.failed === []` is true of a shutdown that removed nothing,
    // so it is not asked on its own: the file this run created is named, is in what was removed, and
    // is gone — and the file it did not create is still there, byte for byte. The stranger is named
    // like a run file on purpose. A shutdown that globbed the runtime directory would pass every
    // other assertion here.
    const mine = runFilePath(join(dir, ".pi", "runtime"), record.runId);
    assert.deepEqual(record.shutdown.files.removed, [mine], "(6) exactly this invocation's file");
    assert.deepEqual(record.shutdown.files.failed, [], "(6) and nothing it owned was left behind");
    assert.equal(existsSync(mine), false, "(6) the run's own file is gone from the disk, not only from the record");
    assert.equal(readFileSync(strangerIn(dir), "utf-8"), "not this run's\n", "(6) a file it did not create survives");

    // ⚠️ **AND IT WAS BOUNDED END TO END, WHICH IS WHAT "WITHIN THEIR GRACE PERIODS" MEANS.** Every step was
    // separately bounded before and their sum was not: two descendant joins at the process table's
    // own timeout, then a grace and a hard period per tree, each started when its own step began.
    // The budget is one deadline taken at the trigger; what it can legitimately exceed is the floor
    // under each of the three waiting periods, which exists so a kill always has time to be observed.
    // Clause 4 asks for escalation that is bounded; the statement asks for trees stopped within their
    // grace periods, and a teardown whose steps are each bounded separately satisfies neither.
    const budget = record.shutdown.budget;
    const ceiling = budget.ms + 6 * SHUTDOWN_MIN_PHASE_MS;
    assert.ok(
      budget.spentMs <= ceiling,
      `(4) the teardown must fit one budget: spent ${budget.spentMs}ms of ${budget.ms}ms, ceiling ${ceiling}ms`
    );

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
  // the list was empty or never taken. This asserts each known descendant was actually SEEN, which is
  // what clause 7 means by including a known descendant rather than only the leader's exit code.
  //
  // ⚠️ **BOTH TREES, BECAUSE THEY ARE ENUMERATED BY DIFFERENT ROUTES.** The launcher is a process
  // group leader on POSIX and the agent cannot be; asking only the agent's would leave the launcher
  // side resting on the group kill having reached something nobody looked for.
  const { record, paths } = await observe("natural");
  const agentChild = readJson(paths.agentChild).pid;
  const launcherChild = readJson(paths.launcherChild).pid;

  assert.ok(
    record.shutdown.agent.descendants?.includes(agentChild),
    `the agent's real descendant ${agentChild} must appear in what was enumerated: ` +
      JSON.stringify(record.shutdown.agent.descendants)
  );
  assert.ok(
    record.shutdown.launcherTree.descendants?.includes(launcherChild),
    `the launcher's real descendant ${launcherChild} must appear in what was enumerated: ` +
      JSON.stringify(record.shutdown.launcherTree.descendants)
  );
});

test("the platform's own tools are what was used, and they are present here", async () => {
  // Named so a failure on a stripped runner reads as "this image has no `ps`" rather than as a
  // supervisor defect. The evidence above is only meaningful where these exist.
  const [cmd, args] = process.platform === "win32" ? ["cmd", ["/c", "where", "taskkill"]] : ["sh", ["-c", "command -v ps"]];
  const { stdout } = await execFileAsync(cmd, args);
  assert.ok(stdout.trim().length > 0, `this platform's process tool was not found: ${cmd} ${args.join(" ")}`);
});
