/**
 * The launcher's cleanup, observed — TSK-0013, CMP-0020, ACC-0032 and ACC-0033.
 *
 * ⚠️ THE HEARTBEAT COMES FIRST, AND IT IS THE DIFFERENCE BETWEEN A TEST AND A CEREMONY. The file
 * watcher is created lazily, on the first `/events` subscription — nothing starts it at boot. A test
 * that launched the application and stopped it would therefore observe the flawless teardown of a
 * watcher that never existed, and would go on passing if the watcher were never released at all. So
 * this subscribes, waits for a NAMED heartbeat frame, and only then terminates: the thing being
 * cleaned up is known to have been there.
 *
 * ⚠️ EVERY POST-CONDITION IS AN OBSERVATION, NEVER THE ABSENCE OF AN ERROR. ACC-0032 inherits that
 * rule from the tier-1 controller, where a removal reported success while the directory survived.
 * So: the pid is probed, the port is bound, and the run directory is `existsSync`-ed. A launcher
 * that exited cleanly having cleaned up nothing passes none of them.
 *
 * ⚠️ IT IS SLOW BECAUSE IT IS REAL: a production build and a started server. There is no fast proxy
 * for "stopping it leaves nothing behind" that would still be about the thing being claimed.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { withBuildLock } from "./helpers/build-lock.mjs";

const execFileP = promisify(execFile);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 4413;
const HOST = "127.0.0.1";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Alive? Signal 0 asks the question without sending anything. */
function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM"; // exists but is not ours
  }
}

/** Free? Answered by binding it, which is the only answer that is not a guess. */
function portFree(port) {
  return new Promise((done) => {
    const probe = createServer();
    probe.once("error", () => done(false));
    probe.once("listening", () => probe.close(() => done(true)));
    probe.listen(port, HOST);
  });
}

async function killTree(pid) {
  if (!pid || !pidAlive(pid)) return;
  try {
    if (process.platform === "win32") await execFileP("taskkill", ["/pid", String(pid), "/T", "/F"]);
    else process.kill(pid, "SIGKILL");
  } catch {
    /* already gone */
  }
}

/** Read the launcher's own lines out of its output. */
const runDirFrom = (log) => (log.match(/\[vpw\] run directory: (.+)/) ?? [])[1]?.trim() ?? null;
const contentRootFrom = (log) => (log.match(/\[vpw\] planning content root: (.+)/) ?? [])[1]?.trim() ?? null;

/**
 * Start the launcher, wait until it is ready, and hand back what the test needs to observe it.
 * `extraEnv` is how the falsification disables termination.
 */
async function launch(extraEnv = {}, port = PORT) {
  let log = "";
  const proc = spawn(process.execPath, [join(ROOT, "bin", "start-shell.mjs")], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), PLANNING_CONTENT_DIR: join(ROOT, "planning-content"), ...extraEnv },
    stdio: ["pipe", "pipe", "pipe"],
  });
  proc.stdout.on("data", (b) => (log += String(b)));
  proc.stderr.on("data", (b) => (log += String(b)));

  const until = Date.now() + 300_000;
  while (Date.now() < until && !/\[vpw\] ready/.test(log)) {
    if (proc.exitCode !== null) throw new Error(`the launcher exited early:\n${log}`);
    await sleep(500);
  }
  if (!/\[vpw\] ready/.test(log)) throw new Error(`the launcher never became ready:\n${log.slice(-3000)}`);
  return { proc, log: () => log };
}

/**
 * ⚠️ SUBSCRIBE AND WAIT FOR A NAMED HEARTBEAT. Read incrementally and release: an event stream never
 * finishes, so awaiting the body would hang until the timeout and report a working stream as a
 * failure. Returns once a `heartbeat` frame has actually been seen.
 */
async function observeHeartbeat() {
  const controller = new AbortController();
  const res = await fetch(`http://${HOST}:${PORT}/events`, {
    signal: controller.signal,
    headers: { accept: "text/event-stream" },
  });
  assert.equal(res.headers.get("content-type"), "text/event-stream; charset=utf-8");

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline && !/event: heartbeat/.test(text)) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  controller.abort();
  try {
    await reader.cancel();
  } catch {
    /* the abort already tore it down */
  }
  return text;
}

test("⚠️ stopping the launcher leaves nothing behind, after a watcher is known to have existed", async (t) => {
  t.diagnostic("a real build and a real server; this takes a few minutes");
  // ⚠️ Exclusive use of `.next` for the whole run: the launcher builds into it and serves from it,
  // and `shell-smoke` deletes it before its own build.
  await withBuildLock(() => cleanupCheck(t));
});

/**
 * ⚠️ THE EXPENSIVE LAUNCH IS RUN SUPERVISED, so propagation is proved end to end without a second
 * build. These are the values the supervisor would generate; the application must answer with
 * exactly them, which is the whole of what "propagates the identity to the application" means.
 */
const SUP_RUN = "3f2e1d0c9b8a77665544332211009988";
const SUP_PROJECT = "aabbccddeeff00112233445566778899";

async function cleanupCheck(t) {

  const { proc, log } = await launch({ KILN_RUN_ID: SUP_RUN, KILN_PROJECT_ID: SUP_PROJECT });
  const runDir = runDirFrom(log());
  assert.ok(runDir, "the launcher must report its run directory");
  // ⚠️ The pid comes from the launcher's own run record rather than from its output. The record is
  // what a cleanup test would have to read in practice, so reading it here checks the same thing an
  // operator would rely on — and it is the only place the owned child is named.
  const run = JSON.parse(readFileSync(join(runDir, "run.json"), "utf-8"));
  const childPid = run.pid ?? null;
  assert.equal(run.port, PORT, "the run record must describe the run that is actually happening");
  assert.equal(run.contentRoot, contentRootFrom(log()), "and must agree with what was printed");

  try {
    // ---- ACC-0033: one command, and the view responds without further steps.
    const home = await (await fetch(`http://${HOST}:${PORT}/`, { signal: AbortSignal.timeout(20_000) })).text();
    assert.match(home, /data-vpw-route="\/"/, "the project view must respond after the single command");
    assert.match(home, /data-vpw-stages=/, "and its reading panel must have resolved, not just its shell");

    // ---- the content root is absolute and was PRINTED, so an operator can see which one it is.
    const printed = contentRootFrom(log());
    assert.ok(printed, "the launcher must print the resolved content root");
    assert.ok(
      /^([A-Za-z]:[\\/]|\/)/.test(printed),
      `the printed content root must be absolute, got ${JSON.stringify(printed)}`
    );
    assert.match(home, /data-vpw-diagnostics=/, "the page reporting that root must have rendered");

    // ---- the child is real, and it is the thing holding the port.
    assert.ok(childPid, "the launcher must record the pid of the child it owns");
    assert.ok(pidAlive(childPid), "the recorded child must actually be running");
    assert.equal(await portFree(PORT), false, "something must be listening while it runs");

    // ---- the identity reached the APPLICATION, which is the only place it can be observed.
    // ⚠️ ASSERTED THROUGH THE HEALTH RESPONSE, not through the launcher's log. The launcher printing
    // a run ID proves it parsed one; only the child answering with it proves it was propagated.
    assert.match(log(), new RegExp(`supervised run ${SUP_RUN}`), "the launcher must say which run it is serving");
    const health = await fetch(`http://${HOST}:${PORT}/health/kiln`, { signal: AbortSignal.timeout(20_000) });
    assert.equal(health.status, 200, "the supervised application must report an identity");
    assert.deepEqual(await health.json(), {
      service: "kiln",
      protocol: "kiln.health/1",
      runId: SUP_RUN,
      projectId: SUP_PROJECT,
      build: JSON.parse(readFileSync(join(ROOT, "package.json"), "utf-8")).version,
    });

    // ---- ⚠️ THE PRECONDITION. Without this the cleanup below is the teardown of nothing.
    const frames = await observeHeartbeat();
    assert.match(frames, /event: heartbeat/, "a watcher must be known to exist before cleanup is claimed");

    // ---- the launcher's own temp directory exists to be cleaned up.
    assert.equal(existsSync(runDir), true, "it must exist while it runs, or its removal proves nothing");
  } finally {
    // ⚠️ STOPPED THROUGH STDIN, NOT A SIGNAL, AND THE REASON IS MEASURED. On Windows
    // `process.kill(pid, "SIGTERM")` is `TerminateProcess`: the launcher dies instantly, no handler
    // runs, and its cleanup never happens — the first version of this test did exactly that and
    // watched two run directories survive. A signal is the operator's path (Ctrl+C reaches the
    // process everywhere); stdin is the one a supervising process can actually use.
    proc.stdin.write("stop\n");
  }

  // ---- and now the observations ACC-0032 asks for.
  const askedAt = Date.now();
  const until = askedAt + 30_000;
  while (Date.now() < until && proc.exitCode === null) await sleep(200);
  assert.notEqual(proc.exitCode, null, "the launcher must exit when asked, not hang");
  const tookMs = Date.now() - askedAt;

  // ⚠️ THE THREE OBSERVATIONS BELOW CANNOT, ON THIS PLATFORM, TELL WHO DID THE KILLING — MEASURED.
  // With child termination commented out of the launcher entirely, the child was still gone 500ms
  // after the launcher exited: Windows reaps it when its parent goes. So "the child PID is gone"
  // is necessary and NOT sufficient, and a cleanup test resting on it alone would pass against a
  // launcher that terminates nothing. That is the same defect the review-write concurrency test had.
  //
  // What DOES distinguish the two is whether the launcher observed its own child exit. When it
  // terminates the child it sees the exit and says `stopped.`; when it does not, it waits out the
  // grace period, escalates, and says `stopped, but the child did not report exiting.` Both the
  // message and the time are asserted, because each fails on its own.
  const out = log();
  assert.match(out, /\[vpw\] stopped\.$/m, "the launcher must confirm it saw its child exit");
  assert.ok(
    !/did not report exiting/.test(out),
    "the launcher waited out its grace period without its child going — it is not terminating it"
  );
  assert.ok(tookMs < 8000, `stopping took ${tookMs}ms; a launcher that kills its child does not wait out the grace period`);

  await sleep(1500);

  assert.equal(pidAlive(childPid), false, `the child (${childPid}) survived the launcher`);
  assert.equal(await portFree(PORT), true, `something is still listening on ${PORT}`);
  assert.equal(existsSync(runDir), false, `the launcher's run directory survived: ${runDir}`);

  // ⚠️ And no OTHER launcher directory either — a launcher that cleaned up the one it reported while
  // leaving siblings behind would pass the line above and still litter.
  const strays = readdirSync(tmpdir()).filter((n) => n.startsWith("vpw-launch-"));
  assert.deepEqual(strays, [], `launcher temp directories survived: ${strays.join(", ")}`);
}

test("the launcher refuses a content root that does not exist, rather than guessing", async () => {
  // #70's rule at the launcher: the application would otherwise fall back to its own directory and
  // read a different project's content while reporting success.
  const missing = join(tmpdir(), "vpw-does-not-exist-9e1f");
  const r = await execFileP(process.execPath, [join(ROOT, "bin", "start-shell.mjs")], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT + 1), PLANNING_CONTENT_DIR: missing },
  }).catch((e) => e);

  assert.equal(r.code, 2, "a missing content root must be a refusal with its own exit code");
  assert.match(String(r.stderr), /no planning content at/, "and must say which path it looked at");
  assert.match(String(r.stderr), /PLANNING_CONTENT_DIR/, "and how to fix it");
});

test("Next is started directly, so the pid the launcher holds IS the server's", () => {
  // Through `npm run`, the launcher would hold an npm process and "terminate the child" would mean
  // terminating something that merely started the server — on Windows a `.cmd` shim whose child does
  // not reliably receive a forwarded signal.
  const src = readFileSync(join(ROOT, "bin", "start-shell.mjs"), "utf-8");
  const startSpawn = src.slice(src.indexOf("const child = spawn("), src.indexOf("writeFileSync("));
  assert.match(startSpawn, /process\.execPath/, "the server child is spawned with Node directly");
  assert.match(startSpawn, /"start", "--hostname", HOST/, "with loopback bound explicitly");
  assert.ok(!/npm/.test(startSpawn), "no npm process between the launcher and the server");
  assert.ok(!/shell:start|run"/.test(startSpawn), "and no npm script indirection");
});

test("⚠️ closing the supplied stdin stops the launcher, exactly as `stop` does", async (t) => {
  t.diagnostic("a second real start; the build is warm by now");
  // ⚠️ **EOF IS THE OTHER HALF OF THE SUPERVISOR'S SHUTDOWN, AND IT IS THE ONE THAT ALWAYS ARRIVES.**
  // A supervisor that dies cannot send `stop`; the operating system closes its pipes regardless. A
  // launcher that only handled the message would survive its supervisor and keep the port.
  await withBuildLock(async () => {
    const { proc, log } = await launch({ PORT: String(PORT + 2) }, PORT + 2);
    const runDir = runDirFrom(log());
    assert.ok(runDir && existsSync(runDir), "the run directory must exist before EOF proves it is removed");

    // ⚠️ **THE SECOND REAL START MUST NOT REINSTALL, AND THIS IS WHERE THAT WAS CAUGHT.** `npm
    // install` touches `package-lock.json`, and the old check compared it to the `node_modules`
    // DIRECTORY mtime — which reinstalling the same tree never moves. So one install made every
    // later start reinstall, two minutes a time, until this test timed out waiting for readiness.
    // The launcher's own words are the evidence: it says which branch it took.
    assert.match(log(), /dependencies present; skipping install/, "a warm checkout must not reinstall");
    const childPid = JSON.parse(readFileSync(join(runDir, "run.json"), "utf-8")).pid;

    proc.stdin.end(); // no message at all — just the close

    const until = Date.now() + 30_000;
    while (Date.now() < until && proc.exitCode === null) await sleep(200);
    assert.notEqual(proc.exitCode, null, "the launcher must exit when its stdin closes");
    assert.match(log(), /stdin closed/, "and must say that is why");
    assert.match(log(), /\[vpw\] stopped\.$/m, "having seen its own child exit");

    await sleep(1500);
    assert.equal(pidAlive(childPid), false, `the child (${childPid}) survived stdin closing`);
    assert.equal(existsSync(runDir), false, "and the run directory went with it");
  });
});

/* ============================================== TSK-0056: what the launcher owes a supervisor === */

/**
 * ⚠️ THESE REFUSALS COST NOTHING TO TEST, because they happen before install and build. That
 * ordering is deliberate on both sides: a launcher that validated its inputs after a two-minute
 * build would report a typo two minutes late.
 */
const refuses = async (env, why) => {
  const r = await execFileP(process.execPath, [join(ROOT, "bin", "start-shell.mjs")], {
    cwd: ROOT,
    env: { ...process.env, PLANNING_CONTENT_DIR: join(ROOT, "planning-content"), ...env },
    timeout: 60_000,
  }).catch((e) => e);
  assert.equal(r.code, 2, `${why}: expected a refusal, got ${r.code ?? "success"}`);
  return String(r.stderr ?? "");
};

test("a port that is not a port is refused before anything is built", async () => {
  // ⚠️ `Number("abc")` IS NaN, AND IT USED TO REACH `--port` AS THE STRING "NaN" — a shell that
  // fails to start for a reason printed nowhere.
  for (const PORT_VALUE of ["abc", "0", "65536", "3000 ", "0x0BB8", "-1"]) {
    const err = await refuses({ PORT: PORT_VALUE }, `PORT=${JSON.stringify(PORT_VALUE)}`);
    assert.match(err, /PORT must be/, "and must say what a port is");
    assert.ok(!err.includes(PORT_VALUE) || /^[0-9]+$/.test(PORT_VALUE), "without echoing a non-numeric value");
  }
});

test("⚠️ a partial or malformed supervisor identity refuses instead of starting standalone", async () => {
  // ⚠️ STARTING ANYWAY IS THE WORST OPTION: the supervisor's health poll would never match, and the
  // operator would be shown a readiness timeout whose cause is two processes away.
  const cases = [
    [{ KILN_RUN_ID: SUP_RUN }, "only the run id"],
    [{ KILN_PROJECT_ID: SUP_PROJECT }, "only the project id"],
    [{ KILN_RUN_ID: "nope", KILN_PROJECT_ID: SUP_PROJECT }, "a malformed run id"],
    [{ KILN_RUN_ID: SUP_RUN, KILN_PROJECT_ID: SUP_PROJECT.toUpperCase() }, "the wrong case"],
  ];
  for (const [env, why] of cases) {
    const err = await refuses(env, why);
    assert.match(err, /KILN_RUN_ID|KILN_PROJECT_ID/, "the refusal must name the variable");
    assert.match(err, /standalone/, "and say how to run without a supervisor");
  }

  // ⚠️ AND IT NAMES THE VARIABLE, NEVER ITS VALUE — this text is an emitted log line (REQ-0024).
  const leaked = await refuses({ KILN_RUN_ID: "/home/someone/secret", KILN_PROJECT_ID: SUP_PROJECT }, "a path");
  assert.ok(!leaked.includes("/home/someone/secret"), "a diagnostic must not become a disclosure");
});

test("⚠️ the application is given no stdin at all, so it cannot read the launcher's", () => {
  // ⚠️ IT WAS `stdio: "inherit"`, which hands the child whatever this process was given: standalone
  // that is the operator's terminal, and under the supervisor it is the private pipe the launcher's
  // own stop control arrives on. Either way a second reader on that handle steals bytes from the
  // reader meant to have them. The application needs no stdin, so it is given none — which makes
  // the guarantee structural rather than a question of who reads first.
  const src = readFileSync(join(ROOT, "bin", "start-shell.mjs"), "utf-8");
  const startSpawn = src.slice(src.indexOf("const child = spawn("), src.indexOf("writeFileSync("));
  assert.match(startSpawn, /stdio: \["ignore", "inherit", "inherit"\]/);
  assert.ok(!/stdio: "inherit"/.test(startSpawn), "inheriting stdio hands the child the launcher's stdin");
});
