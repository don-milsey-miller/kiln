/**
 * Bounded shutdown and session resumption — CMP-0037, against ACC-0081 and ACC-0103.
 *
 * ⚠️ **SEVEN OBSERVATIONS, KEPT SEPARATE, BECAUSE THEY FAIL SEPARATELY.** Any one of them standing in
 * for the others is how a shutdown claim stops being testable: a supervisor that asks one tree and
 * not the other looks identical to a correct one on every run where the unasked tree exits anyway,
 * and "we were interrupted" inferred from the processes having gone is unfalsifiable — they exit on
 * their own, constantly, for reasons that have nothing to do with a signal.
 *
 * ⚠️ **THE PLATFORM HALF IS NOT HERE AND CANNOT BE.** `taskkill /T` and a POSIX process group are
 * different mechanisms, and this host runs one of them. What is asserted here is that the right
 * mechanism is chosen per platform and that the observations are recorded; whether a real POSIX
 * group teardown leaves nothing behind is CI's to record, independently, per ACC-0081's sixth
 * clause.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";

import {
  STOP_SIGNALS,
  removeOwnedFiles,
  shutdown,
  stopTree,
  trackDescendants,
  watchForStop,
} from "../lib/supervisor.mjs";
import {
  SESSION,
  SESSION_PROBLEM,
  SESSION_RECORD,
  STORAGE,
  availableSessions,
  planSession,
  sessionDirFor,
} from "../lib/session-record.mjs";

const PROJECT_ID = "abcdef0123456789abcdef0123456789";
const scratch = () => mkdtempSync(join(tmpdir(), "kiln-shut-"));

/**
 * A child that goes when asked, or never — the two cases the grace period exists to tell apart.
 *
 * ⚠️ **`obeys` MAKES THE CAUSAL LINK EXPLICIT, and the first version of this fixture did not.** It
 * exited both children on a shared timer, so the launcher was already gone by the time it was asked
 * and the "it got its own control channel" assertion was measuring a coincidence. A launcher exits
 * BECAUSE its stdin closed; a fixture that exits on its own can pass against a supervisor that never
 * asks it anything.
 */
function child({ pid = 4242, obeys = false, afterMs = 20 } = {}) {
  let exit = null;
  const asked = [];
  const go = () => (exit = 0);
  const obey = () => obeys && setTimeout(go, afterMs);
  return {
    pid,
    get exitCode() {
      return exit;
    },
    signalCode: null,
    stdin: {
      destroyed: false,
      write: () => asked.push("stop"),
      end: () => {
        asked.push("end");
        obey();
      },
    },
    kill: () => {
      asked.push("kill");
      obey();
    },
    once: () => {},
    asked,
    go,
  };
}

/** A `net` server stand-in, so "is the port free" can be both answers without racing a real one. */
function fakeServer(free) {
  const handlers = {};
  return {
    once: (event, cb) => (handlers[event] = cb),
    listen: () => setImmediate(() => (free ? handlers.listening?.() : handlers.error?.({ code: "EADDRINUSE" }))),
    address: () => ({ port: 1 }),
    close: (cb) => cb?.(),
  };
}

/** What the supervisor will pass as `trigger`: a signal if there was one, otherwise Pi finishing. */
const shutdownTrigger = ({ signal = null } = {}) => (signal ? "signal" : "agent-exit");

/**
 * A tiny process table: which pids are alive, and what was signalled at them.
 *
 * ⚠️ **ONE SOURCE OF TRUTH FOR BOTH SIGNALLING AND LIVENESS.** The first version of these tests
 * stubbed `process.kill` to record signals and nothing else, so every pid stayed "alive" forever
 * once `stopTree` began observing descendants — the fake disagreeing with itself. Signals here
 * actually remove pids, which is what lets a surviving descendant be a deliberate case rather than
 * an artefact.
 */
function processTable(alive, { immortal = [] } = {}) {
  const living = new Set(alive);
  const signals = [];
  return {
    signals,
    living,
    kill: (pid, sig) => {
      if (sig === 0) {
        if (!living.has(pid)) {
          const e = new Error("no such process");
          e.code = "ESRCH";
          throw e;
        }
        return true;
      }
      signals.push([pid, sig]);
      if (!immortal.includes(pid)) living.delete(pid);
    },
  };
}

/* ============================================== 1. the signal is its own observation =========== */

test("⚠️ the signal is recorded where it was handled, never inferred from processes exiting", () => {
  // ⚠️ A SUPERVISOR WITH NO HANDLER AT ALL looks identical on every run where the children happened
  // to exit first. The only place "we were interrupted" is true is where the interrupt arrived.
  const bus = new EventEmitter();
  const seen = [];
  const state = watchForStop((sig) => seen.push(sig), { target: bus, signals: ["SIGINT", "SIGTERM"] });

  assert.equal(state.received, null, "nothing has happened yet");
  bus.emit("SIGINT");
  assert.equal(state.received, "SIGINT");
  assert.deepEqual(seen, ["SIGINT"]);

  // ⚠️ A SECOND Ctrl+C DURING A BOUNDED SHUTDOWN MUST NOT RESTART IT.
  bus.emit("SIGTERM");
  assert.equal(state.received, "SIGINT", "the first one still owns the shutdown");
  assert.deepEqual(seen, ["SIGINT"], "and the second starts nothing");

  state.dispose();
  bus.emit("SIGINT");
  assert.deepEqual(seen, ["SIGINT"], "disposal really removes the listeners");
  assert.ok(STOP_SIGNALS.includes("SIGBREAK"), "Windows' Ctrl+Break is in the set");
});

test("a signal that does not exist on this platform disables none of the others", () => {
  // ⚠️ `SIGBREAK` IS WINDOWS-ONLY AND `SIGHUP` IS NOT UNIVERSAL. Failing to register one is not a
  // reason to register none — which a single try around the whole loop would have caused.
  const bus = new EventEmitter();
  const original = bus.on.bind(bus);
  bus.on = (sig, fn) => {
    if (sig === "SIGBREAK") throw new Error("unsupported on this platform");
    return original(sig, fn);
  };
  const seen = [];
  watchForStop((s) => seen.push(s), { target: bus, signals: ["SIGBREAK", "SIGINT"] });
  bus.emit("SIGINT");
  assert.deepEqual(seen, ["SIGINT"]);
});

/* ============================================== 2-4. trees, separately ========================= */

test("each tree is asked, and each exit is observed on its own", async () => {
  const calls = [];
  const run = (cmd, args) => calls.push([cmd, ...args]);

  const win = child({ pid: 11 });
  setTimeout(() => win.go(), 50);
  const w = await stopTree(win, { platform: "win32", run, graceMs: 2000 });
  assert.equal(w.requested, true);
  assert.equal(w.exitObserved, true);
  assert.equal(w.escalated, false);
  // ⚠️ `/T` IS THE POINT: `next start` spawns workers, and signalling the pid alone leaves them on
  // the port. On Windows there is no graceful request to make, so this is request and escalation.
  assert.deepEqual(calls[0], ["taskkill", "/pid", "11", "/T", "/F"]);
  assert.match(w.method, /taskkill \/T/);
});

test("⚠️ a tree that will not go is escalated within the bound and REPORTED as unobserved", async () => {
  const calls = [];
  const immortal = child({ pid: 12 });
  const r = await stopTree(immortal, {
    platform: "win32",
    run: (c, a) => calls.push([c, ...a]),
    graceMs: 150,
    hardMs: 100,
  });

  assert.equal(r.requested, true);
  assert.equal(r.escalated, true);
  // ⚠️ REPORTED, NOT ASSUMED. A tree that still has not gone is said so — the alternative is a
  // shutdown that claims an exit it never saw, which is the failure this whole record exists for.
  assert.equal(r.exitObserved, false);
  assert.equal(calls.length, 2, "asked, then escalated — bounded, and both attempts made");
});

test("on POSIX the request goes to the process GROUP, not the leader alone", async () => {
  // ⚠️ NEGATIVE PID IS THE GROUP. Signalling the leader leaves its children holding the port, which
  // is the same defect `taskkill /T` exists to avoid on the other platform — different mechanism,
  // identical failure, which is why ACC-0081 refuses to let one platform stand for the other.
  const table = processTable([99]);
  const posix = child({ pid: 99 });
  setTimeout(() => posix.go(), 50);
  const r = await stopTree(posix, { platform: "linux", group: true, graceMs: 2000, kill: table.kill });
  assert.deepEqual(table.signals, [[-99, "SIGTERM"]], "the negative pid is the group");
  assert.match(r.method, /SIGTERM to the group/);
  assert.equal(r.exitObserved, true);
  // ⚠️ **THE GROUP IS NO LONGER TRUSTED TO COVER THE TREE, and this assertion is what changed.** It
  // used to read "a group needs no enumeration: the mechanism covers the tree", which is true only
  // of processes that stayed in it — a worker that called `setsid`, or one that was re-parented, is
  // reachable by its own pid alone. The tracked list is resolved and signalled alongside the group
  // rather than instead of it, so the enumeration now happens on this path too.
  assert.deepEqual(r.descendants, [], "the tracked list is resolved even for a group, and here it is empty");
});

test("⚠️ without a group, POSIX signals the process — signalling one would hit the supervisor", async () => {
  // ⚠️ A GROUP ONLY EXISTS IF THE CHILD WAS SPAWNED `detached`. Without it the child sits in THIS
  // process's group, so `kill(-pid)` would signal the supervisor and the operator's shell too. The
  // agent is deliberately not detached: a detached foreground process cannot read the terminal at
  // all — it takes SIGTTIN — which would break the routing ACC-0078 exists to protect.
  const table = processTable([77]);
  const fg = child({ pid: 77 });
  setTimeout(() => fg.go(), 40);
  const r = await stopTree(fg, {
    platform: "linux",
    graceMs: 2000,
    kill: table.kill,
    psRun: () => ({ status: 0, stdout: "77 1\n" }),
  });
  assert.deepEqual(table.signals, [[77, "SIGTERM"]], "the positive pid is this process alone");
  assert.match(r.method, /SIGTERM to the process/);
});

/* ============================================== 5. only what this invocation created =========== */

test("⚠️ only files this invocation created are removed, proved by one it did not", () => {
  const dir = scratch();
  try {
    const ours = join(dir, "run-abc.json");
    const theirs = join(dir, "kiln-session.json");
    const alsoTheirs = join(dir, "notes.md");
    for (const f of [ours, theirs, alsoTheirs]) writeFileSync(f, "x");

    const r = removeOwnedFiles([ours]);
    assert.deepEqual(r.removed, [ours]);
    assert.deepEqual(r.failed, []);
    // ⚠️ THE SURVIVING FILES ARE THE ASSERTION. "Ours is gone" is true of a glob that took everything
    // — and the session record is exactly what a glob over a runtime directory would take.
    assert.equal(existsSync(theirs), true, "the session record must survive its own invocation");
    assert.equal(existsSync(alsoTheirs), true);
    assert.equal(existsSync(ours), false);

    // A file already gone is not a failure; a file that cannot be removed is reported, not thrown.
    assert.deepEqual(removeOwnedFiles([ours]), { removed: [], failed: [] });
    assert.equal(removeOwnedFiles([dir]).failed.length, 1, "a directory in the list is reported");
    assert.equal(existsSync(dir), true, "and is not destroyed to make the removal succeed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/* ============================================== the whole shutdown, composed =================== */

/**
 * A process lister that succeeds and finds nothing.
 *
 * ⚠️ **THE WIN32 FIXTURES DID NOT NEED THIS UNTIL THE ENUMERATION REACHED WINDOWS, and that is the
 * point rather than an inconvenience.** Descendants used to be resolved inside the POSIX branch
 * only, so on Windows no tree was ever enumerated and `descendantsEnumerated` stayed null — which
 * `notObserved` reads as "nothing to report". ACC-0081 requires each platform's observation to
 * include a known descendant of each tree; Windows was quietly meeting that by not looking.
 */
const NO_DESCENDANTS = () => ({ status: 0, stdout: "" });

test("shutdown keeps all seven observations, and one going does not stand for the other", async () => {
  const dir = scratch();
  try {
    const ours = join(dir, "run-1.json");
    const theirs = join(dir, "kiln-session.json");
    writeFileSync(ours, "{}");
    writeFileSync(theirs, "{}");

    const agent = child({ pid: 21 });
    setTimeout(() => agent.go(), 40);
    // ⚠️ THE LAUNCHER EXITS BECAUSE ITS STDIN WAS CLOSED, which is the contract it was built to
    // answer — not on a timer that would have made the assertion below a coincidence.
    const launcher = child({ pid: 22, obeys: true });

    const r = await shutdown({
      agent,
      launcher,
      ownedFiles: [ours],
      signal: "SIGINT",
      port: 1,
      createServerImpl: () => fakeServer(true),
      platform: "win32",
      run: () => {},
      psRun: NO_DESCENDANTS,
      graceMs: 2000,
    });

    assert.equal(r.signal, "SIGINT", "the signal travels with the result");
    assert.equal(r.trigger, "signal", "and the trigger is DERIVED from it, never supplied beside it");
    assert.deepEqual(r.notObserved, [], "everything the criterion asks for was observed");
    assert.equal(r.agent.requested, true, "the agent tree was asked");
    assert.equal(r.agent.exitObserved, true, "and its exit seen");
    assert.equal(r.launcher.sentStop, true, "the launcher got its own control channel first");
    assert.equal(r.launcher.endRequested, true);
    assert.equal(r.launcher.exitObserved, true, "and its exit seen INDEPENDENTLY of the agent's");
    // ⚠️ THE TREE IS OBSERVED EVEN ON THE POLITE PATH NOW. It used to be skipped whenever the
    // launcher answered its control channel, which is exactly when a surviving worker went unseen.
    assert.equal(r.launcherTree.treeStopped, true, "the tree is observed stopped, not assumed");
    assert.deepEqual(r.launcherTree.descendantsSurviving, [], "and nothing was left behind");
    assert.deepEqual(r.files.removed, [ours]);
    assert.equal(existsSync(theirs), true);
    assert.equal(r.complete, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("⚠️ a launcher that ignores its control channel is escalated, and the run is not complete", async () => {
  const agent = child({ pid: 31 });
  setTimeout(() => agent.go(), 30);
  const deaf = child({ pid: 32 }); // never exits, whatever it is asked

  const r = await shutdown({
    agent,
    launcher: deaf,
    port: 1,
    createServerImpl: () => fakeServer(true),
    platform: "win32",
    run: () => {},
    psRun: NO_DESCENDANTS,
    graceMs: 120,
    hardMs: 80,
  });

  assert.equal(r.agent.exitObserved, true);
  assert.equal(r.launcher.exitObserved, false, "the polite path did not work");
  assert.equal(r.launcherTree.escalated, true, "so the tree treatment was tried");
  assert.equal(r.launcherTree.exitObserved, false, "and it still did not go");
  // ⚠️ THE AGENT'S CLEAN EXIT DOES NOT MAKE THE SHUTDOWN COMPLETE. That substitution is the one this
  // criterion's third clause exists to forbid.
  assert.equal(r.complete, false);
});

/* ============================================== ACC-0103: the EXACT session ==================== */

function stateRoot({ record, sessions = [] } = {}) {
  const dir = scratch();
  mkdirSync(join(dir, "runtime"), { recursive: true });
  mkdirSync(join(dir, "sessions"), { recursive: true });
  if (record) writeFileSync(join(dir, SESSION_RECORD), typeof record === "string" ? record : JSON.stringify(record));
  for (const s of sessions) writeFileSync(join(dir, "sessions", `${s}.jsonl`), "{}\n");
  return dir;
}
const sessionDirOf = (root) => join(root, "sessions");
const valid = (over = {}) => ({
  recordVersion: 1,
  projectId: PROJECT_ID,
  sessionId: "sess-7f3a",
  stateMode: "project",
  ...over,
});

test("a first run with nothing recorded and nothing stored starts, and says so", () => {
  const root = stateRoot();
  try {
    const p = planSession({ stateRoot: root, projectId: PROJECT_ID, stateMode: "project", sessionDir: sessionDirOf(root) });
    assert.equal(p.action, SESSION.START);
    assert.equal(p.problem, SESSION_PROBLEM.MISSING);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("⚠️ a later run resumes the EXACT recorded session, named in the plan", () => {
  // ⚠️ "THE AGENT STARTED" IS NOT "THE SESSION RESUMED". A brand-new unrelated session starts just
  // as successfully, and the two are indistinguishable to an operator until the context is missing.
  // What is asserted is the identifier, which is the only thing that differs.
  const root = stateRoot({ record: valid(), sessions: ["sess-7f3a", "sess-older"] });
  try {
    const p = planSession({ stateRoot: root, projectId: PROJECT_ID, stateMode: "project", sessionDir: sessionDirOf(root) });
    assert.equal(p.action, SESSION.RESUME);
    assert.equal(p.sessionId, "sess-7f3a", "the stored one, not the newest and not any other");
    assert.notEqual(p.sessionId, "sess-older");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("⚠️ every way a record can fail becomes a question, never a silent fresh start", () => {
  // ⚠️ EACH OF THESE HAS AN OBVIOUS CHEAP ANSWER — start a new session — and that answer silently
  // discards the thing the operator came back for.
  const cases = [
    ["{ not json", SESSION_PROBLEM.UNREADABLE],
    [JSON.stringify({ recordVersion: 1 }), SESSION_PROBLEM.INVALID],
    [JSON.stringify(valid({ stateMode: "elsewhere" })), SESSION_PROBLEM.INVALID],
    // ⚠️ A STATE ROOT CAN BE SHARED OR COPIED, so a record whose every field is valid can still
    // belong to another project — the one route where nothing else would catch it.
    [JSON.stringify(valid({ projectId: "f".repeat(32) })), SESSION_PROBLEM.FOREIGN],
    [JSON.stringify(valid({ sessionId: "sess-vanished" })), SESSION_PROBLEM.GONE],
  ];
  for (const [record, problem] of cases) {
    const root = stateRoot({ record, sessions: ["sess-7f3a"] });
    try {
      const p = planSession({ stateRoot: root, projectId: PROJECT_ID, stateMode: "project", sessionDir: sessionDirOf(root) });
      assert.equal(p.action, SESSION.ASK, `${problem} must ask`);
      assert.equal(p.problem, problem);
      assert.deepEqual(
        p.available.sessions.map((s) => s.id),
        ["sess-7f3a"],
        "and offer what is actually there"
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("a missing record with sessions present asks rather than starting over them", () => {
  // ⚠️ THE ONE CASE WHERE STARTING FRESH DISCARDS NOTHING is no record AND no sessions. With sessions
  // sitting there, a lost record is a question about which one, not permission to ignore them.
  const root = stateRoot({ sessions: ["sess-a", "sess-b"] });
  try {
    const p = planSession({ stateRoot: root, projectId: PROJECT_ID, stateMode: "project", sessionDir: sessionDirOf(root) });
    assert.equal(p.action, SESSION.ASK);
    assert.equal(p.problem, SESSION_PROBLEM.MISSING);
    assert.deepEqual(
      p.available.sessions.map((s) => s.id).sort(),
      ["sess-a", "sess-b"]
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("available sessions are read from the directory, newest first", () => {
  const root = stateRoot({ sessions: ["one", "two"] });
  try {
    const list = availableSessions(sessionDirOf(root));
    assert.equal(list.state, STORAGE.LISTED);
    assert.deepEqual(
      list.sessions.map((s) => s.id).sort(),
      ["one", "two"]
    );

    // ⚠️ "I COULD NOT LOOK" IS NOT "THERE IS NOTHING THERE", AND THESE USED TO BE ONE ANSWER. All
    // three collapsed into an empty list, and an empty list with no record reads as a first run —
    // which starts fresh over sessions nobody could enumerate.
    assert.equal(availableSessions(join(root, "nope")).state, STORAGE.ABSENT, "an absent directory IS an answer");
    assert.equal(availableSessions(undefined).state, STORAGE.ABSENT);
    const file = join(root, "a-file");
    writeFileSync(file, "not a directory");
    assert.equal(availableSessions(file).state, STORAGE.NOT_A_DIRECTORY);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("⚠️ storage that could not be inspected asks; it never authorises a fresh start", () => {
  // ⚠️ THE DEFECT: with no record and a session directory that is really a FILE, availability was an
  // empty list and the plan was START — a fresh session begun over storage nobody could read.
  const root = scratch();
  try {
    mkdirSync(join(root, "runtime"), { recursive: true });
    writeFileSync(join(root, "sessions"), "I am a regular file");
    const p = planSession({ stateRoot: root, projectId: PROJECT_ID, stateMode: "project" });
    assert.equal(p.action, SESSION.ASK, "uncertainty asks");
    assert.equal(p.problem, SESSION_PROBLEM.STORAGE_UNREADABLE);
    assert.equal(p.available.state, STORAGE.NOT_A_DIRECTORY);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("⚠️ a session recorded under a different state mode is a question, not a resume", () => {
  // ⚠️ THE MODE DECIDES WHICH STORE THE ID REFERS TO. A record written under project-local state and
  // read while running `--local-state user` names a session in the other store — and every field
  // along that route is individually valid, so nothing else would have caught it.
  const root = stateRoot({ record: valid({ stateMode: "user" }), sessions: ["sess-7f3a"] });
  try {
    const p = planSession({
      stateRoot: root,
      projectId: PROJECT_ID,
      stateMode: "project",
      sessionDir: sessionDirOf(root),
    });
    assert.equal(p.action, SESSION.ASK);
    assert.equal(p.problem, SESSION_PROBLEM.MODE_CHANGED);

    // ...and it resumes when the modes agree, so the check is about the mode and not the record.
    const same = planSession({
      stateRoot: root,
      projectId: PROJECT_ID,
      stateMode: "user",
      sessionDir: sessionDirOf(root),
    });
    assert.equal(same.action, SESSION.RESUME);
    assert.equal(same.sessionId, "sess-7f3a");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the session directory is derived, so the existence check cannot be skipped", () => {
  // ⚠️ AS AN OPTIONAL ARGUMENT ITS ABSENCE SILENTLY SKIPPED THE EXISTENCE CHECK: the caller who
  // forgot it got a resume with no proof the session was there.
  const root = stateRoot({ record: valid({ sessionId: "sess-vanished" }), sessions: ["sess-7f3a"] });
  try {
    assert.equal(sessionDirFor(root), join(root, "sessions"));
    const p = planSession({ stateRoot: root, projectId: PROJECT_ID, stateMode: "project" });
    assert.equal(p.action, SESSION.ASK, "no override, and the vanished session is still caught");
    assert.equal(p.problem, SESSION_PROBLEM.GONE);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

for (const platform of ["linux", "win32"])
  test(`⚠️ a launcher that exits politely leaving a tracked worker is NOT a complete shutdown (${platform})`, async () => {
    // Reproduced: the launcher accepted `stop` and exited, a tracked worker stayed alive, the port
    // rebound, and shutdown returned `complete: true` with `launcherEscalation: null`. The tree was
    // only examined when the LEADER failed to exit — so the ordinary, polite path never looked at
    // the descendants tracked while it lived. An exited leader is not a stopped tree, which the
    // agent side already knew and the launcher side did not.
    //
    // Both platforms, because the mechanism differs and ACC-0081 refuses to let one stand for the
    // other: `taskkill /T` walks a tree from a root that must still exist, and a POSIX group does
    // not contain a worker that left it.
    const alive = new Set([950]);
    const targeted = [];
    const launcher = child({ pid: 900, obeys: true });
    const agent = child({ pid: 901 });
    setTimeout(() => agent.go(), 20);

    const r = await shutdown({
      agent,
      launcher,
      agentDescendants: { pids: [], enumerated: true },
      launcherDescendants: { pids: [950], enumerated: true },
      port: 1,
      createServerImpl: () => fakeServer(true),
      platform,
      graceMs: 200,
      hardMs: 100,
      kill: (pid, sig) => {
        if (sig === 0) {
          if (alive.has(Math.abs(pid))) return true;
          const e = new Error("gone");
          e.code = "ESRCH";
          throw e;
        }
        targeted.push(Math.abs(pid));
        return true;
      },
      run: (cmd, args) => {
        if (cmd === "taskkill") targeted.push(Number(args[args.indexOf("/pid") + 1]));
        return { status: 0, stdout: "" };
      },
      psRun: NO_DESCENDANTS,
    });

    assert.equal(r.launcher.exitObserved, true, "the control channel did see the leader go");
    assert.equal(r.launcherTree.treeStopped, false, "but the TREE was not stopped, and that is a separate fact");
    assert.deepEqual(r.launcherTree.descendantsSurviving, [950]);
    assert.ok(r.notObserved.includes("launcher-descendants-survived"), "and it is named");
    assert.equal(r.complete, false, "a surviving worker is not a complete shutdown, however free the port is");

    // ⚠️ AND THE SURVIVOR WAS ACTUALLY ASKED TO GO, after its parent had exited. On Windows that
    // needs its own pid: `taskkill /pid <parent> /T` has no tree to walk once the parent is gone.
    assert.ok(targeted.includes(950), `the tracked survivor must be targeted directly on ${platform}`);
  });

test("⚠️ the port is its own observation, and an occupied one is not a complete shutdown", async () => {
  // ⚠️ EVERY OTHER RECORD HERE IS ABOUT A PROCESS. `exitCode` says the leader is gone and says
  // nothing about a worker still listening, which is the state the criterion's "the port is free"
  // clause exists to catch — and which nothing tested until now.
  const agent = child({ pid: 41 });
  setTimeout(() => agent.go(), 30);
  const launcher = child({ pid: 42, obeys: true });

  const free = await shutdown({
    agent,
    launcher,
    port: 1,
    platform: "win32",
    run: () => {},
    psRun: NO_DESCENDANTS,
    graceMs: 2000,
    createServerImpl: () => fakeServer(true),
  });
  assert.equal(free.portFree, true);
  assert.equal(free.complete, true);

  const agent2 = child({ pid: 43 });
  setTimeout(() => agent2.go(), 30);
  const launcher2 = child({ pid: 44, obeys: true });
  const held = await shutdown({
    agent: agent2,
    launcher: launcher2,
    port: 1,
    platform: "win32",
    run: () => {},
    psRun: NO_DESCENDANTS,
    graceMs: 2000,
    createServerImpl: () => fakeServer(false),
  });
  assert.equal(held.portFree, false, "something is still listening");
  assert.equal(held.agent.exitObserved, true, "even though every process record says it went");
  assert.equal(held.launcher.exitObserved, true);
  assert.equal(held.complete, false, "so the shutdown is not complete");
});

test("the trigger says whether this was a signal or Pi finishing", async () => {
  // ⚠️ ON A NORMAL PI EXIT THERE IS NO SIGNAL, and requiring one would mean fabricating the
  // observation. The trigger distinguishes the two rather than making a signal a precondition of a
  // clean shutdown — and an already-exited tree is recorded as exited, not as one that was asked.
  assert.equal(shutdownTrigger({}), "agent-exit");
  assert.equal(shutdownTrigger({ signal: "SIGINT" }), "signal");

  const gone = child({ pid: 51 });
  gone.go(); // Pi finished on its own; there is nothing to ask
  const r = await shutdown({
    agent: gone,
    launcher: child({ pid: 52, obeys: true }),
    port: 1,
    createServerImpl: () => fakeServer(true),
    platform: "win32",
    run: () => {},
    psRun: NO_DESCENDANTS,
  });
  assert.equal(r.trigger, "agent-exit", "the default trigger is Pi finishing");
  assert.equal(r.signal, null, "and no signal is invented to fill the record");
  assert.equal(r.agent.requested, false, "an already-exited tree is not asked");
  assert.equal(r.agent.exitObserved, true, "it is recorded as already gone");
});

/* ============================================== the contradictions and the omissions =========== */

test("⚠️ a shutdown that never checked the port is partial, not complete", async () => {
  // ⚠️ `portFree !== false` TREATED AN OMITTED OBSERVATION AS A PASSED ONE — the criterion's
  // mandatory rebinding clause quietly skipped whenever nobody passed a port. What could not be
  // observed is now named, and naming anything makes the result partial.
  const agent = child({ pid: 61 });
  agent.go();
  const r = await shutdown({ agent, launcher: child({ pid: 62, obeys: true }), platform: "win32", run: () => {} });

  assert.equal(r.portFree, null, "nothing was asked about the port");
  assert.deepEqual(r.notObserved, ["port"], "and that is recorded rather than passed over");
  assert.equal(r.complete, false, "an unobserved observation is not a satisfied one");
});

test("⚠️ the trigger is derived, so it cannot contradict the signal", async () => {
  // ⚠️ TWO INDEPENDENTLY WRITABLE COPIES OF ONE FACT: `{trigger: "agent-exit", signal: "SIGINT"}`
  // was accepted and returned unchanged — a record contradicting itself, which is worse than either
  // half alone. `trigger` is no longer an input.
  const withSignal = await shutdown({
    agent: (() => {
      const a = child({ pid: 63 });
      a.go();
      return a;
    })(),
    launcher: child({ pid: 64, obeys: true }),
    signal: "SIGINT",
    trigger: "agent-exit", // ignored: there is nowhere for it to go
    port: 1,
    createServerImpl: () => fakeServer(true),
    platform: "win32",
    run: () => {},
    psRun: NO_DESCENDANTS,
  });
  assert.equal(withSignal.trigger, "signal", "the signal decides, and the supplied trigger is discarded");
  assert.equal(withSignal.signal, "SIGINT");
});

test("⚠️ a foreground agent's DESCENDANTS are signalled, because it can have no group", async () => {
  // ⚠️ SIGNALLING THE AGENT ALONE IS NOT STOPPING THE AGENT'S TREE. A Pi child can outlive its
  // parent, and `detached` — the thing that would make a group targetable — is unavailable to a
  // foreground process, which must stay in the terminal's group to read from it.
  const table = processTable([100, 200, 300]);
  const fg = child({ pid: 100 });
  setTimeout(() => fg.go(), 40);

  const r = await stopTree(fg, {
    platform: "linux",
    graceMs: 2000,
    kill: table.kill,
    psRun: () => ({ status: 0, stdout: "  1 0\n100 1\n200 100\n300 200\n" }),
  });

  assert.deepEqual(r.descendants, [300, 200], "deepest first, so a parent cannot re-parent them away");
  assert.equal(r.descendantsEnumerated, true);
  assert.deepEqual(
    table.signals,
    [
      [300, "SIGTERM"],
      [200, "SIGTERM"],
      [100, "SIGTERM"],
    ],
    "every descendant, then the agent itself"
  );
  assert.deepEqual(r.descendantsSurviving, [], "and every one of them observed gone");
  assert.equal(r.treeStopped, true);
  assert.match(r.method, /descendants/);
});

test("⚠️ a descendant that survives its parent is escalated, and the tree is not reported stopped", async () => {
  // ⚠️ **THE LEADER EXITING IS NOT THE TREE STOPPING.** Waiting on `exitCode` alone reported a
  // stopped tree the moment the parent went — while an enumerated descendant was still running, and
  // with escalation skipped because the only thing being watched had already exited. A survivor is
  // exactly what "the tree was stopped" is supposed to rule out.
  const table = processTable([100, 200], { immortal: [200] });
  const fg = child({ pid: 100 });
  setTimeout(() => fg.go(), 30); // the parent goes promptly; the child does not

  // ⚠️ **`ps` ANSWERS DIFFERENTLY ONCE THE PARENT IS GONE**, which is why the snapshot has to be
  // kept. On the second look 200 has been re-parented and is no longer a descendant of anything
  // this call knows about — so a re-enumerating implementation escalates at an empty list and the
  // survivor is never signalled.
  let looks = 0;
  const r = await stopTree(fg, {
    platform: "linux",
    graceMs: 200,
    hardMs: 150,
    kill: table.kill,
    psRun: () => ({ status: 0, stdout: ++looks === 1 ? "100 1\n200 100\n" : "200 1\n" }),
  });

  assert.equal(r.exitObserved, true, "the leader really did exit");
  assert.equal(r.escalated, true, "and escalation still happened, because a descendant had not");
  assert.deepEqual(r.descendantsSurviving, [200]);
  assert.equal(r.treeStopped, false, "so the tree is NOT reported stopped");
  // ⚠️ THE SNAPSHOT IS REUSED. Re-enumerating after the parent went would no longer show 200 as a
  // descendant of anything this call knows about, and the survivor would be escalated at nothing.
  assert.deepEqual(
    table.signals.filter(([pid, sig]) => pid === 200 && sig === "SIGKILL"),
    [[200, "SIGKILL"]],
    "the survivor is escalated even though its parent has gone"
  );
});

test("a surviving descendant makes the whole shutdown partial, whatever the exit codes say", async () => {
  const table = processTable([100, 200], { immortal: [200] });
  const agent = child({ pid: 100 });
  setTimeout(() => agent.go(), 30);

  const r = await shutdown({
    agent,
    launcher: child({ pid: 300, obeys: true }),
    port: 1,
    createServerImpl: () => fakeServer(true),
    platform: "linux",
    kill: table.kill,
    psRun: () => ({ status: 0, stdout: "100 1\n200 100\n" }),
    graceMs: 200,
    hardMs: 150,
  });

  assert.equal(r.agent.exitObserved, true, "every process record about the leader says it went");
  assert.ok(r.notObserved.includes("agent-descendants-survived"));
  assert.equal(r.complete, false);
});

test("⚠️ a session record that exists but cannot be read is a question, not a first run", () => {
  // ⚠️ `existsSync` ANSWERS FALSE FOR A RECORD THAT IS THERE AND CANNOT BE OPENED — a permissions
  // problem, a broken link — and false was the one answer that could authorise starting fresh.
  // Only ENOENT means "no record"; the record is read rather than asked about.
  const root = scratch();
  try {
    mkdirSync(join(root, "runtime"), { recursive: true });
    mkdirSync(join(root, "sessions"), { recursive: true });
    // A DIRECTORY where the record belongs: it exists, and reading it fails with EISDIR/EPERM.
    mkdirSync(join(root, SESSION_RECORD), { recursive: true });

    const p = planSession({ stateRoot: root, projectId: PROJECT_ID, stateMode: "project" });
    assert.equal(p.action, SESSION.ASK, "an unreadable record must not authorise a fresh start");
    assert.equal(p.problem, SESSION_PROBLEM.UNREADABLE);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("⚠️ a signal-started shutdown is owned work, not fire-and-forget", async () => {
  // ⚠️ `void onStop(signal)` CAPTURED NEITHER A SYNCHRONOUS THROW NOR THE RETURNED PROMISE, so a
  // shutdown that failed became an unhandled rejection and the run loop had nothing to await.
  // First-signal-wins has to mean one OWNED completion, not one started one.
  const bus = new EventEmitter();
  let resolveStop;
  const ok = watchForStop(() => new Promise((r) => (resolveStop = r)), { target: bus, signals: ["SIGINT"] });

  // ⚠️ **ASSERTED BEFORE ANY SIGNAL, WHICH IS THE WHOLE DEFECT.** `completion` was null until a
  // handler ran, so a run loop that set up `Promise.race([agentExit, completion])` at start-up raced
  // against `null` — and a race against null resolves immediately, defeating the race in exactly the
  // arrangement it exists for. Asserting after the emit could never have caught that.
  assert.ok(ok.completion instanceof Promise, "the run loop has something to race from the start");
  let settledEarly = false;
  void Promise.race([ok.completion, Promise.resolve("nothing yet")]).then((v) => (settledEarly = v !== "nothing yet"));
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(settledEarly, false, "and it stays pending until a signal actually arrives");

  bus.emit("SIGINT");
  resolveStop("done");
  assert.equal(await ok.completion, "done");

  // A rejection reaches whoever awaits it AND is recorded, so an un-awaited one cannot crash the
  // process in the middle of a teardown.
  const bad = new EventEmitter();
  const failing = watchForStop(async () => {
    throw Object.assign(new Error("secret /home/alice/key"), { code: "EACCES" });
  }, { target: bad, signals: ["SIGINT"] });
  bad.emit("SIGINT");
  await assert.rejects(() => failing.completion);
  assert.equal(failing.error, "EACCES", "classified, never the message");

  // A synchronous throw is captured the same way rather than escaping the handler.
  const sync = new EventEmitter();
  const thrower = watchForStop(() => {
    throw new Error("immediately");
  }, { target: sync, signals: ["SIGINT"] });
  sync.emit("SIGINT");
  await assert.rejects(() => thrower.completion);
  assert.equal(thrower.error, "Error");
});

test("⚠️ Pi exiting with a live child is not a stopped tree — the ordinary shutdown path", async () => {
  // ⚠️ **THIS IS THE NORMAL END OF A RUN.** Pi finishes on its own, so the shutdown reaches the agent
  // with the leader already gone — and `stopTree` returned `treeStopped: true` there without
  // enumerating anything or sending a signal. `ps` cannot help after the fact either: a surviving
  // child has been re-parented and is related to nothing this supervisor can name. The snapshot has
  // to have been taken while the leader was alive.
  const table = processTable([100, 200], { immortal: [200] });
  const agent = child({ pid: 100 });

  // Tracked while it lives, exactly as the run loop will.
  const tracker = trackDescendants(agent, { psRun: () => ({ status: 0, stdout: "100 1\n200 100\n" }) });
  const known = tracker.snapshot();
  assert.deepEqual(known.pids, [200], "the relationship was visible while the parent was alive");
  agent.go(); // Pi exits on its own
  tracker.stop();

  const r = await stopTree(agent, {
    platform: "linux",
    graceMs: 200,
    hardMs: 150,
    kill: table.kill,
    knownDescendants: known,
    // ⚠️ AFTER THE FACT `ps` SHOWS NOTHING: 200 is init's child now.
    psRun: () => ({ status: 0, stdout: "200 1\n" }),
  });

  assert.equal(r.exitObserved, true, "the leader really had gone");
  assert.equal(r.requested, false, "a tree already gone is recorded as such, not asked");
  assert.deepEqual(r.descendants, [200], "but its known descendants are still observed");
  assert.deepEqual(r.descendantsSurviving, [200]);
  assert.equal(r.treeStopped, false, "so this is NOT a stopped tree");
});

test("a tracked tree whose children all went is a clean stop", async () => {
  const table = processTable([100, 200]);
  const agent = child({ pid: 100 });
  const tracker = trackDescendants(agent, { psRun: () => ({ status: 0, stdout: "100 1\n200 100\n" }) });
  const known = tracker.snapshot();
  table.living.delete(200); // the child finished with its parent
  agent.go();
  tracker.stop();

  const r = await stopTree(agent, { platform: "linux", graceMs: 200, kill: table.kill, knownDescendants: known });
  assert.equal(r.treeStopped, true, "nothing survived, so the tree really is stopped");
  assert.deepEqual(r.descendantsSurviving, []);
});

test("the tracker keeps the UNION, so a child seen once is not lost by a later poll", () => {
  // ⚠️ KEEPING ONLY THE LAST SAMPLE would lose anything that started and finished between two polls
  // — and, worse, anything present at the first look and re-parented before the second.
  const agent = child({ pid: 100 });
  let look = 0;
  const tracker = trackDescendants(agent, {
    psRun: () => ({ status: 0, stdout: ++look === 1 ? "100 1\n200 100\n" : "100 1\n300 100\n" }),
  });
  tracker.sample();
  assert.deepEqual(tracker.snapshot().pids.sort(), [200, 300], "both, not just the latest");
  tracker.stop();
});
