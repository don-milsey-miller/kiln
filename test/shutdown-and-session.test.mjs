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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";

import {
  REFUSAL,
  SESSION_ID_FLAG,
  SESSION_SELECTORS,
  STOP_SIGNALS,
  SupervisorRefusal,
  generateSessionId,
  removeOwnedFiles,
  shutdown,
  stopTree,
  trackDescendants,
  watchForStop,
  withSessionPolicy,
} from "../lib/supervisor.mjs";
import {
  SESSION,
  SESSION_PROBLEM,
  RECOVERABLE_PROBLEMS,
  SESSION_NAME_MAX,
  SESSION_RECORD,
  STORAGE,
  availableSessions,
  renderSessionChoices,
  terminalSafeName,
  planSession,
  recordSession,
  sessionDirFor,
} from "../lib/session-record.mjs";
import { resolvePinnedSessionLister } from "../lib/pi-runtime.mjs";

const PROJECT_ID = "abcdef0123456789abcdef0123456789";
const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "supervisor");
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

/** A newline, spelled without an escape so no generator can mangle it. */
const LF = String.fromCharCode(10);

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
  // An empty injected process table: the identity read before any signal must not read this host's table,
  // and must not take a real PowerShell start while the fixture's own timer decides when the tree goes.
  const w = await stopTree(win, { platform: "win32", run, psRun: () => ({ status: 0, stdout: "" }), graceMs: 2000 });
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
    psRun: () => ({ status: 0, stdout: "" }),
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
  const r = await stopTree(posix, { platform: "linux", group: true, graceMs: 2000, kill: table.kill, psRun: () => ({ status: 0, stdout: "" }) });
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

/**
 * ⚠️ **F121: PI NAMES SESSION FILES `<timestamp>_<uuid>.jsonl`, AND THE ID IS NOT THE UUID IN THE NAME.**
 * It is in the file's header. The previous fixtures wrote `sess-7f3a.jsonl`, so a discovery that derived
 * ids by stripping the extension looked correct here and reported every REAL recorded session as gone.
 * These fixtures write the shape Pi writes, with a header id that deliberately differs from the filename.
 */
const PROJECT_CWD = "/projects/kiln";
let stamp = 0;
function sessionFile(dir, { id, cwd = PROJECT_CWD, header = true, name = null }) {
  const uuid = `${String(++stamp).padStart(8, "0")}-1111-4111-8111-111111111111`;
  const file = join(dir, name ?? `2026-09-16T10-00-${String(stamp).padStart(2, "0")}-000Z_${uuid}.jsonl`);
  const lines = [];
  if (header === true) lines.push(JSON.stringify({ type: "session", version: 3, id, timestamp: new Date().toISOString(), cwd }));
  else if (typeof header === "string") lines.push(header);
  lines.push(JSON.stringify({ type: "message", id: "m1", message: { role: "user", content: [{ type: "text", text: "hi" }] } }));
  writeFileSync(file, lines.join("\n") + "\n");
  return { id, file, cwd };
}

/**
 * A stand-in for Pi's lister that behaves the way the measured one does: ids from headers, exact cwd
 * filtering, and malformed or header-less files dropped.
 */
const fakeLister = async (cwd, dir) => {
  const out = [];
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith(".jsonl")) continue;
    let header;
    try {
      header = JSON.parse(readFileSync(join(dir, entry), "utf-8").split("\n")[0]);
    } catch {
      continue;
    }
    if (header?.type !== "session" || typeof header.id !== "string" || header.cwd !== cwd) continue;
    out.push({ id: header.id, path: join(dir, entry), cwd: header.cwd, modified: statSync(join(dir, entry)).mtime });
  }
  return out;
};

function stateRoot({ record, sessions = [], cwd = PROJECT_CWD } = {}) {
  const dir = scratch();
  mkdirSync(join(dir, "runtime"), { recursive: true });
  mkdirSync(join(dir, "sessions"), { recursive: true });
  if (record) writeFileSync(join(dir, SESSION_RECORD), typeof record === "string" ? record : JSON.stringify(record));
  for (const id of sessions) sessionFile(join(dir, "sessions"), { id, cwd });
  return dir;
}
const sessionDirOf = (root) => join(root, "sessions");
const SESSION_ID = "7f3a1c2e-0000-4000-8000-000000000001";
const OTHER_ID = "0older00-0000-4000-8000-000000000002";
const plan = (over = {}) =>
  planSession({ projectId: PROJECT_ID, stateMode: "project", projectRoot: PROJECT_CWD, lister: fakeLister, ...over });
const valid = (over = {}) => ({
  recordVersion: 1,
  projectId: PROJECT_ID,
  sessionId: SESSION_ID,
  stateMode: "project",
  ...over,
});

test("a first run with nothing recorded and nothing stored starts, and says so", async () => {
  const root = stateRoot();
  try {
    const p = await plan({ stateRoot: root, sessionDir: sessionDirOf(root) });
    assert.equal(p.action, SESSION.START);
    assert.equal(p.problem, SESSION_PROBLEM.MISSING);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("⚠️ a later run resumes the EXACT recorded session, named in the plan", async () => {
  // ⚠️ "THE AGENT STARTED" IS NOT "THE SESSION RESUMED". A brand-new unrelated session starts just
  // as successfully, and the two are indistinguishable to an operator until the context is missing.
  // What is asserted is the identifier, which is the only thing that differs.
  const root = stateRoot({ record: valid(), sessions: [SESSION_ID, OTHER_ID] });
  try {
    const p = await plan({ stateRoot: root, sessionDir: sessionDirOf(root) });
    assert.equal(p.action, SESSION.RESUME);
    assert.equal(p.sessionId, SESSION_ID, "the stored one, not the newest and not any other");
    assert.notEqual(p.sessionId, OTHER_ID);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("⚠️ every way a record can fail becomes a question, never a silent fresh start", async () => {
  // ⚠️ EACH OF THESE HAS AN OBVIOUS CHEAP ANSWER — start a new session — and that answer silently
  // discards the thing the operator came back for.
  const cases = [
    ["{ not json", SESSION_PROBLEM.UNREADABLE],
    [JSON.stringify({ recordVersion: 1 }), SESSION_PROBLEM.INVALID],
    [JSON.stringify(valid({ stateMode: "elsewhere" })), SESSION_PROBLEM.INVALID],
    // ⚠️ A STATE ROOT CAN BE SHARED OR COPIED, so a record whose every field is valid can still
    // belong to another project — the one route where nothing else would catch it.
    [JSON.stringify(valid({ projectId: "f".repeat(32) })), SESSION_PROBLEM.FOREIGN],
    [JSON.stringify(valid({ sessionId: "vanished-0000-4000-8000-000000000009" })), SESSION_PROBLEM.GONE],
  ];
  for (const [record, problem] of cases) {
    const root = stateRoot({ record, sessions: [SESSION_ID] });
    try {
      const p = await plan({ stateRoot: root, sessionDir: sessionDirOf(root) });
      assert.equal(p.action, SESSION.ASK, `${problem} must ask`);
      assert.equal(p.problem, problem);
      assert.equal(p.recoverable, true, `${problem} is resolved by choosing`);
      assert.deepEqual(
        p.available.sessions.map((s) => s.id),
        [SESSION_ID],
        "and offer what is actually there"
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("a missing record with sessions present asks rather than starting over them", async () => {
  // ⚠️ THE ONE CASE WHERE STARTING FRESH DISCARDS NOTHING is no record AND no sessions. With sessions
  // sitting there, a lost record is a question about which one, not permission to ignore them.
  const root = stateRoot({ sessions: ["aaaa1111-0000-4000-8000-00000000000a", "bbbb2222-0000-4000-8000-00000000000b"] });
  try {
    const p = await plan({ stateRoot: root, sessionDir: sessionDirOf(root) });
    assert.equal(p.action, SESSION.ASK);
    assert.equal(p.problem, SESSION_PROBLEM.MISSING);
    assert.deepEqual(
      p.available.sessions.map((s) => s.id).sort(),
      ["aaaa1111-0000-4000-8000-00000000000a", "bbbb2222-0000-4000-8000-00000000000b"]
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("available sessions are read from the directory, newest first", async () => {
  const root = stateRoot({ sessions: ["one11111-0000-4000-8000-00000000000c", "two22222-0000-4000-8000-00000000000d"] });
  const look = (dir) => availableSessions(dir, { lister: fakeLister, projectRoot: PROJECT_CWD });
  try {
    const list = await look(sessionDirOf(root));
    assert.equal(list.state, STORAGE.LISTED);
    assert.deepEqual(
      list.sessions.map((s) => s.id).sort(),
      ["one11111-0000-4000-8000-00000000000c", "two22222-0000-4000-8000-00000000000d"]
    );

    // ⚠️ "I COULD NOT LOOK" IS NOT "THERE IS NOTHING THERE", AND THESE USED TO BE ONE ANSWER. All
    // three collapsed into an empty list, and an empty list with no record reads as a first run —
    // which starts fresh over sessions nobody could enumerate.
    assert.equal((await look(join(root, "nope"))).state, STORAGE.ABSENT, "an absent directory IS an answer");
    assert.equal((await look(undefined)).state, STORAGE.ABSENT);
    const file = join(root, "a-file");
    writeFileSync(file, "not a directory");
    assert.equal((await look(file)).state, STORAGE.NOT_A_DIRECTORY);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("⚠️ the listing keeps what the picker shows, and never a session's text", async () => {
  // ⚠️ PI'S LISTING CARRIES EACH SESSION'S FIRST MESSAGE AND FULL TEXT. A transcript can hold a pasted
  // credential, and nothing Kiln prints or records needs either, so neither is copied.
  const root = stateRoot();
  mkdirSync(sessionDirOf(root), { recursive: true });
  const created = new Date(Date.UTC(2026, 8, 14, 10, 5));
  const modified = new Date(Date.UTC(2026, 8, 16, 9, 0));
  const lister = async () => [
    {
      id: SESSION_ID,
      path: join(sessionDirOf(root), `x_${SESSION_ID}.jsonl`),
      cwd: PROJECT_CWD,
      name: "planning",
      created,
      modified,
      messageCount: 12,
      firstMessage: "my token is SECRET-FIRST",
      allMessagesText: "SECRET-ALL",
      parentSessionPath: "/elsewhere",
    },
  ];
  try {
    const listed = await availableSessions(sessionDirOf(root), { lister, projectRoot: PROJECT_CWD });
    assert.deepEqual(listed.sessions, [
      {
        id: SESSION_ID,
        path: join(sessionDirOf(root), `x_${SESSION_ID}.jsonl`),
        name: "planning",
        createdMs: created.getTime(),
        modifiedMs: modified.getTime(),
        messageCount: 12,
      },
    ]);
    assert.equal(JSON.stringify(listed).includes("SECRET"), false, "no message text survives the listing");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("⚠️ a session name cannot drive the terminal it is printed on", () => {
  const E = String.fromCharCode(0x1b);
  const BEL = String.fromCharCode(0x07);
  const cases = [
    ["plain name", "plain name"],
    [`a${E}[31mred${E}[0m`, "ared"],
    [`${E}[2J${E}[Hcleared`, "cleared"],
    [`x${E}]0;window title${BEL}y`, "xy"],
    [`x${E}]8;;http://example.test${E}\\link${E}]8;;${E}\\`, "xlink"],
    [`unterminated${E}]0;never ends`, "unterminated"],
    [`dcs${E}Pq#payload${E}\\done`, "dcsdone"],
    [`eight${String.fromCharCode(0x9b)}31mbit`, "eightbit"],
    [`osc8${String.fromCharCode(0x9d)}0;t${String.fromCharCode(0x9c)}bit`, "osc8bit"],
    ["line1\r\nline2\tz", "line1 line2 z"],
    [`bell${BEL} null${String.fromCharCode(0)} del${String.fromCharCode(0x7f)} c1${String.fromCharCode(0x85)}x`, "bell null del c1 x"],
    [`bidi${String.fromCharCode(0x202e)}evil${String.fromCharCode(0x2066)}`, "bidievil"],
    [`lone${E}`, "lone"],
    [`${E}[2J`, null],
    ["   ", null],
    [42, null],
  ];
  for (const [input, expected] of cases) assert.equal(terminalSafeName(input), expected, JSON.stringify(input));

  const long = terminalSafeName("n".repeat(200));
  assert.equal(Array.from(long).length, SESSION_NAME_MAX, "capped");
  assert.ok(long.endsWith("..."));
  assert.equal(terminalSafeName("e".repeat(SESSION_NAME_MAX)), "e".repeat(SESSION_NAME_MAX), "a name at the cap is kept whole");

  // Every character that can reach the terminal is printable, whatever the input.
  let hostile = "";
  for (let cp = 0; cp < 0x100; cp++) hostile += String.fromCharCode(cp);
  hostile += String.fromCharCode(0x2028, 0x2029, 0x202a, 0x202e, 0x2066, 0x2069, 0x061c, 0x200e, 0x200f);
  for (const ch of terminalSafeName(hostile, 1000)) {
    const cp = ch.codePointAt(0);
    assert.ok(cp >= 0x20 && cp !== 0x7f && !(cp >= 0x80 && cp <= 0x9f), `code point ${cp.toString(16)} survived`);
  }
});

test("⚠️ the choices are numbered lines with no id, no path and no message text", () => {
  const E = String.fromCharCode(0x1b);
  const lines = renderSessionChoices([
    {
      id: SESSION_ID,
      path: "/home/someone/.pi/sessions/x.jsonl",
      name: `plan${E}[1mning`,
      createdMs: Date.UTC(2026, 8, 14, 10, 5),
      modifiedMs: Date.UTC(2026, 8, 16, 9, 0),
      messageCount: 12,
    },
    { id: OTHER_ID, path: "/p", name: null, createdMs: 0, modifiedMs: 0, messageCount: 1 },
    { id: "third", path: "/q", name: "x", createdMs: 1, modifiedMs: 1, messageCount: null },
  ]);
  assert.deepEqual(lines, [
    "  1. planning | created 2026-09-14 10:05 UTC | modified 2026-09-16 09:00 UTC | 12 messages",
    "  2. (unnamed) | created unknown | modified unknown | 1 message",
    "  3. x | created 1970-01-01 00:00 UTC | modified 1970-01-01 00:00 UTC | message count unknown",
  ]);
  const text = lines.join("");
  for (const leak of [SESSION_ID, OTHER_ID, "/home", "/p", "/q", "third"]) assert.equal(text.includes(leak), false, leak);
});

test("⚠️ storage that could not be inspected asks; it never authorises a fresh start", async () => {
  // ⚠️ THE DEFECT: with no record and a session directory that is really a FILE, availability was an
  // empty list and the plan was START — a fresh session begun over storage nobody could read.
  const root = scratch();
  try {
    mkdirSync(join(root, "runtime"), { recursive: true });
    writeFileSync(join(root, "sessions"), "I am a regular file");
    const p = await plan({ stateRoot: root });
    assert.equal(p.action, SESSION.ASK, "uncertainty asks");
    assert.equal(p.problem, SESSION_PROBLEM.STORAGE_UNREADABLE);
    assert.equal(p.available.state, STORAGE.NOT_A_DIRECTORY);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("⚠️ a session recorded under a different state mode is a question, not a resume", async () => {
  // ⚠️ THE MODE DECIDES WHICH STORE THE ID REFERS TO. A record written under project-local state and
  // read while running `--local-state user` names a session in the other store — and every field
  // along that route is individually valid, so nothing else would have caught it.
  const root = stateRoot({ record: valid({ stateMode: "user" }), sessions: [SESSION_ID] });
  try {
    const p = await plan({ stateRoot: root, sessionDir: sessionDirOf(root) });
    assert.equal(p.action, SESSION.ASK);
    assert.equal(p.problem, SESSION_PROBLEM.MODE_CHANGED);

    // ...and it resumes when the modes agree, so the check is about the mode and not the record.
    const same = await plan({ stateRoot: root, stateMode: "user", sessionDir: sessionDirOf(root) });
    assert.equal(same.action, SESSION.RESUME);
    assert.equal(same.sessionId, SESSION_ID);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the session directory is derived, so the existence check cannot be skipped", async () => {
  // ⚠️ AS AN OPTIONAL ARGUMENT ITS ABSENCE SILENTLY SKIPPED THE EXISTENCE CHECK: the caller who
  // forgot it got a resume with no proof the session was there.
  const root = stateRoot({ record: valid({ sessionId: "vanished-0000-4000-8000-00000000000e" }), sessions: [SESSION_ID] });
  try {
    assert.equal(sessionDirFor(root), join(root, "sessions"));
    const p = await plan({ stateRoot: root });
    assert.equal(p.action, SESSION.ASK, "no override, and the vanished session is still caught");
    assert.equal(p.problem, SESSION_PROBLEM.GONE);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * ⚠️ **THE CONTROL F121 NEEDED, AND THIS ONE USES PI'S OWN LISTER.** Everything above drives a stand-in.
 * The defect was that Kiln derived session ids by stripping a filename's extension, while Pi keeps the id
 * in each file's header — so every real recorded session would have been reported as one that no longer
 * exists, and fixtures named `sess-7f3a.jsonl` could never show it. These files are named the way Pi names
 * them, and the header id is deliberately NOT the uuid in the name.
 */
test("⚠️ a lister that could not answer is not an empty store, and never a first run", async () => {
  // ⚠️ **"I COULD NOT LOOK" IS NOT "THERE IS NOTHING THERE", AND THE LISTER IS THE SECOND WAY TO LEARN IT.**
  // The directory inspection above catches an absent or unreadable path; this catches the case where the
  // path is a fine directory and PI could not read it — a permissions failure, a store mid-write, a lister
  // that threw for its own reasons. Treated as an empty list, with no record present, it reads as a first
  // run: Kiln would start a fresh session over sessions nobody could enumerate.
  const root = stateRoot({ sessions: [SESSION_ID] });
  const threw = async () => {
    throw Object.assign(new Error("denied"), { code: "EACCES" });
  };
  try {
    const listed = await availableSessions(sessionDirOf(root), { lister: threw, projectRoot: PROJECT_CWD });
    assert.equal(listed.state, STORAGE.UNREADABLE, "a lister that threw reported nothing, not nothing there");
    assert.equal(listed.code, "EACCES", "and why it could not answer is kept");
    assert.deepEqual(listed.sessions, []);

    const p = await plan({ stateRoot: root, sessionDir: sessionDirOf(root), lister: threw });
    assert.equal(p.action, SESSION.ASK, "uncertainty asks; it never authorises a fresh start");
    assert.equal(p.problem, SESSION_PROBLEM.STORAGE_UNREADABLE);

    // ⚠️ AND THE RECORD IS NOT WRITTEN OVER A STORE THAT COULD NOT BE READ.
    const out = await recordSession({
      stateRoot: root,
      projectId: PROJECT_ID,
      stateMode: "project",
      projectRoot: PROJECT_CWD,
      lister: threw,
      sessionId: "fresh-0000-4000-8000-000000000010",
    });
    assert.equal(out.ok, false, "a fresh session is not recorded over an unreadable store");
    assert.equal(out.problem, SESSION_PROBLEM.STORAGE_UNREADABLE);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("⚠️ F121 ids come from each session's header, through Pi's own lister, never from the filename", async () => {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
  const lister = await resolvePinnedSessionLister(repoRoot);
  const root = scratch();
  const sessions = join(root, "sessions");
  const mine = join(root, "mine");
  const theirs = join(root, "theirs");
  try {
    mkdirSync(join(root, "runtime"), { recursive: true });
    mkdirSync(sessions, { recursive: true });
    mkdirSync(mine, { recursive: true });
    mkdirSync(theirs, { recursive: true });

    const header = (id, cwd) => JSON.stringify({ type: "session", version: 3, id, timestamp: new Date().toISOString(), cwd });
    const msg = JSON.stringify({ type: "message", id: "m1", message: { role: "user", content: [{ type: "text", text: "hi" }] } });
    const HEADER_ID = "99999999-9999-4999-8999-999999999999";
    const NAME_UUID = "11111111-1111-4111-8111-111111111111";
    // The id in the name and the id in the header disagree, which is the whole defect in one file.
    writeFileSync(join(sessions, `2026-09-16T10-00-00-000Z_${NAME_UUID}.jsonl`), [header(HEADER_ID, mine), msg].join("\n") + "\n");
    // Another project's session, in the same flat directory.
    writeFileSync(join(sessions, "2026-09-16T10-05-00-000Z_22222222-2222-4222-8222-222222222222.jsonl"), [header("88888888-8888-4888-8888-888888888888", theirs), msg].join("\n") + "\n");
    // A malformed header, and one with no header at all.
    writeFileSync(join(sessions, "2026-09-16T10-10-00-000Z_33333333-3333-4333-8333-333333333333.jsonl"), ["{ not json", msg].join("\n") + "\n");
    writeFileSync(join(sessions, "2026-09-16T10-15-00-000Z_44444444-4444-4444-8444-444444444444.jsonl"), msg + "\n");

    const listed = await availableSessions(sessions, { lister, projectRoot: mine });
    assert.equal(listed.state, STORAGE.LISTED);
    assert.deepEqual(
      listed.sessions.map((x) => x.id),
      [HEADER_ID],
      "the header's id, not the filename's uuid, and only this project's"
    );

    // A record naming the HEADER id resumes; one naming the FILENAME uuid is a session that is not there.
    const record = (sessionId) => writeFileSync(join(root, SESSION_RECORD), JSON.stringify({ recordVersion: 1, projectId: PROJECT_ID, sessionId, stateMode: "project" }));
    record(HEADER_ID);
    const resumed = await planSession({ stateRoot: root, projectId: PROJECT_ID, stateMode: "project", projectRoot: mine, lister, sessionDir: sessions });
    assert.equal(resumed.action, SESSION.RESUME);
    assert.equal(resumed.sessionId, HEADER_ID);

    record(NAME_UUID);
    const gone = await planSession({ stateRoot: root, projectId: PROJECT_ID, stateMode: "project", projectRoot: mine, lister, sessionDir: sessions });
    assert.equal(gone.action, SESSION.ASK, "a filename-derived id names no session Pi knows");
    assert.equal(gone.problem, SESSION_PROBLEM.GONE);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("⚠️ the session this run starts is recorded before Pi is spawned, and validated first", async () => {
  const root = stateRoot();
  try {
    const written = await recordSession({
      stateRoot: root,
      projectId: PROJECT_ID,
      stateMode: "project",
      projectRoot: PROJECT_CWD,
      lister: fakeLister,
      sessionId: SESSION_ID,
    });
    assert.equal(written.ok, true);
    assert.equal(written.action, SESSION.START);
    assert.equal(written.sessionId, SESSION_ID);

    const doc = JSON.parse(readFileSync(join(root, SESSION_RECORD), "utf-8"));
    assert.equal(doc.sessionId, SESSION_ID);
    assert.equal(doc.projectId, PROJECT_ID);
    assert.equal(doc.stateMode, "project");
    assert.equal(doc.recordVersion, 1);
    // ⚠️ A MODE AND AN ID, NEVER A PATH: the state root is rederived, so a moved project resumes nothing
    // belonging elsewhere.
    assert.equal(JSON.stringify(doc).includes(root), false, "no absolute path is stored");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("⚠️ a record that would not validate is never written, and the caller is told why", async () => {
  // ⚠️ **AN INVALID RECORD IS NOT A PRIVATE MISTAKE; IT IS THE NEXT RUN'S QUESTION.** `planSession` answers
  // INVALID for a record that fails its schema, so writing one would leave the operator unable to resume
  // the session they came back for — and the fault would surface a run later, far from its cause.
  const root = stateRoot();
  // A validator that refuses whatever it is handed, standing in for a schema the document fails.
  // ⚠️ THE SHAPE THE VALIDATOR ACTUALLY HAS: `assertValidRecord` calls it and reads a boolean, with the
  // reasons on `.errors`. A stub that threw would pass this test for the wrong reason.
  const refuses = { "kiln-session": Object.assign(() => false, { errors: [{ message: "refused by the test" }] }) };
  try {
    const out = await recordSession({
      stateRoot: root,
      projectId: PROJECT_ID,
      stateMode: "project",
      projectRoot: PROJECT_CWD,
      lister: fakeLister,
      sessionId: SESSION_ID,
      validators: refuses,
    });

    assert.equal(out.ok, false, "an invalid record is refused rather than written");
    assert.equal(out.problem, SESSION_PROBLEM.INVALID);
    assert.equal(existsSync(join(root, SESSION_RECORD)), false, "and nothing reached the disk");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("⚠️ a run that loses the race adopts the recorded session rather than overwriting it", async () => {
  // ⚠️ TWO FIRST RUNS STARTING TOGETHER BOTH SAW "no record" BEFORE THE LOCK EXISTED, and the second
  // would overwrite the first — leaving a live conversation that nothing points at.
  const root = stateRoot({ sessions: [SESSION_ID] });
  try {
    writeFileSync(join(root, SESSION_RECORD), JSON.stringify({ recordVersion: 1, projectId: PROJECT_ID, sessionId: SESSION_ID, stateMode: "project" }));
    const mine = "cccc3333-0000-4000-8000-00000000000f";
    const out = await recordSession({
      stateRoot: root,
      projectId: PROJECT_ID,
      stateMode: "project",
      projectRoot: PROJECT_CWD,
      lister: fakeLister,
      sessionId: mine,
    });
    assert.equal(out.ok, true);
    assert.equal(out.action, SESSION.RESUME);
    assert.equal(out.sessionId, SESSION_ID, "the winner's session, not this run's fresh id");
    assert.equal(JSON.parse(readFileSync(join(root, SESSION_RECORD), "utf-8")).sessionId, SESSION_ID, "and the record is untouched");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("⚠️ a missing runtime directory is reported, and the supervisor creates nothing", async () => {
  // ⚠️ MAKING THE LAYOUT IS SETUP'S WORK, under the lock that owns it. A launch that created one would be
  // the second writer of a directory tree with exactly one owner.
  const root = scratch();
  try {
    mkdirSync(join(root, "sessions"), { recursive: true });
    const out = await recordSession({
      stateRoot: root,
      projectId: PROJECT_ID,
      stateMode: "project",
      projectRoot: PROJECT_CWD,
      lister: fakeLister,
      sessionId: SESSION_ID,
    });
    assert.equal(out.ok, false);
    assert.equal(out.problem, SESSION_PROBLEM.NO_RUNTIME_DIR);
    assert.equal(existsSync(join(root, "runtime")), false, "nothing was created");
    assert.equal(existsSync(join(root, SESSION_RECORD)), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("⚠️ Kiln names the session, and refuses every other way of choosing one", async () => {
  // ⚠️ ONLY ONE THING MAY DECIDE THE SESSION. Any second selector means the record and the running session
  // can disagree, which is the failure ACC-0103 exists to rule out.
  const chosen = withSessionPolicy({ command: "pi", args: ["--print"] }, SESSION_ID, { A: "1" });
  assert.deepEqual(chosen.args, ["--print", SESSION_ID_FLAG, SESSION_ID]);
  assert.deepEqual(chosen.env, { A: "1" });

  for (const flag of SESSION_SELECTORS) {
    assert.throws(
      () => withSessionPolicy({ command: "pi", args: ["--print", flag, "x"] }, SESSION_ID, {}),
      (e) => e instanceof SupervisorRefusal && e.reason === REFUSAL.SESSION_SELECTOR_CONFLICT,
      `${flag} must be refused`
    );
    assert.throws(
      () => withSessionPolicy({ command: "pi", args: [`${flag}=x`] }, SESSION_ID, {}),
      (e) => e instanceof SupervisorRefusal && e.reason === REFUSAL.SESSION_SELECTOR_CONFLICT,
      `${flag}= must be refused`
    );
  }

  // A generated id is what a first run passes, and it is the shape Pi uses for its own.
  const id = generateSessionId((n) => Buffer.alloc(n, 7));
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
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
      launcherDescendants: { pids: [950], identities: [{ pid: 950, created: "950" }], enumerated: true },
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
      // The worker's identity is re-read before it is classified or signalled, so the table has to show it.
      psRun: () => ({ status: 0, stdout: "950 1 950\n" }),
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
    psRun: () => ({ status: 0, stdout: "  1 0 1\n100 1 100\n200 100 200\n300 200 300\n" }),
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
    psRun: () => ({ status: 0, stdout: ++looks === 1 ? "100 1 100\n200 100 200\n" : "200 1 200\n" }),
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
    psRun: () => ({ status: 0, stdout: "100 1 100\n200 100 200\n" }),
    graceMs: 200,
    hardMs: 150,
  });

  assert.equal(r.agent.exitObserved, true, "every process record about the leader says it went");
  assert.ok(r.notObserved.includes("agent-descendants-survived"));
  assert.equal(r.complete, false);
});

test("⚠️ a session record that exists but cannot be read is a question, not a first run", async () => {
  // ⚠️ `existsSync` ANSWERS FALSE FOR A RECORD THAT IS THERE AND CANNOT BE OPENED — a permissions
  // problem, a broken link — and false was the one answer that could authorise starting fresh.
  // Only ENOENT means "no record"; the record is read rather than asked about.
  const root = scratch();
  try {
    mkdirSync(join(root, "runtime"), { recursive: true });
    mkdirSync(join(root, "sessions"), { recursive: true });
    // A DIRECTORY where the record belongs: it exists, and reading it fails with EISDIR/EPERM.
    mkdirSync(join(root, SESSION_RECORD), { recursive: true });

    const p = await plan({ stateRoot: root });
    assert.equal(p.action, SESSION.ASK, "an unreadable record must not authorise a fresh start");
    // ⚠️ NOT THE CORRUPT-JSON PROBLEM: a record that could not be opened may be valid, and nothing replaces it.
    assert.equal(p.problem, SESSION_PROBLEM.INACCESSIBLE);
    assert.equal(p.recoverable, false);
    assert.equal(RECOVERABLE_PROBLEMS.includes(SESSION_PROBLEM.INACCESSIBLE), false);
    assert.equal(RECOVERABLE_PROBLEMS.includes(SESSION_PROBLEM.STORAGE_UNREADABLE), false);
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
  const tracker = trackDescendants(agent, { psRun: () => ({ status: 0, stdout: "100 1 100\n200 100 200\n" }) });
  await tracker.sample();
  const known = tracker.snapshot();
  assert.deepEqual(known.pids, [200], "the relationship was visible while the parent was alive");
  agent.go(); // Pi exits on its own
  await tracker.stop();

  const r = await stopTree(agent, {
    platform: "linux",
    graceMs: 200,
    hardMs: 150,
    kill: table.kill,
    knownDescendants: known,
    // ⚠️ AFTER THE FACT `ps` SHOWS NOTHING: 200 is init's child now.
    psRun: () => ({ status: 0, stdout: "200 1 200\n" }),
  });

  assert.equal(r.exitObserved, true, "the leader really had gone");
  assert.equal(r.requested, false, "a tree already gone is recorded as such, not asked");
  assert.deepEqual(r.descendants, [200], "but its known descendants are still observed");
  assert.deepEqual(r.descendantsSurviving, [200]);
  assert.equal(r.treeStopped, false, "so this is NOT a stopped tree");
});

test("a tracked tree whose children all went is a clean stop", async () => {
  // ⚠️ **THE SAMPLE IS AWAITED, AND SO IS THE STOP.** Neither was: the first look is asynchronous,
  // so the snapshot was taken before it settled and `known.pids` was EMPTY — the test then asserted
  // that a tree with no known descendants had no survivors, which is true of any tree at all and
  // would have passed against a tracker that never looked. The un-awaited `stop()` also left a query
  // running past the end of the test.
  const table = processTable([100, 200]);
  const agent = child({ pid: 100 });
  const tracker = trackDescendants(agent, { psRun: () => ({ status: 0, stdout: "100 1 100\n200 100 200\n" }) });
  await tracker.sample();
  const known = tracker.snapshot();
  assert.deepEqual(known.pids, [200], "the child was tracked while its parent lived");
  table.living.delete(200); // the child finished with its parent
  agent.go();
  await tracker.stop();

  const r = await stopTree(agent, { platform: "linux", graceMs: 200, kill: table.kill, knownDescendants: known });
  assert.equal(r.treeStopped, true, "nothing survived, so the tree really is stopped");
  assert.deepEqual(r.descendantsSurviving, []);
});

test("⚠️ STOP JOINS A QUERY ALREADY IN FLIGHT, rather than walking away from it", async () => {
  // Reproduced: with the exited-leader return placed BEFORE the in-flight check, a leader that died
  // during an interval query made `stop()` return at once — so the shutdown read and acted on a
  // snapshot that the query, settling a moment later, was about to change. An exited leader is a
  // reason not to START a query; it is not a reason to abandon the one whose answer is about to be
  // doubted, because the record is supposed to describe every look this tracker took.
  //
  // The second query is held open deliberately, so the ordering is the thing under test rather than
  // a timing that happens to work.
  const child = { pid: 100, exitCode: null, signalCode: null };
  let release;
  const held = new Promise((r) => (release = r));
  let calls = 0;

  const tracker = trackDescendants(child, {
    intervalMs: 20,
    psRun: async () => {
      calls += 1;
      if (calls === 1) return { status: 0, stdout: "100 1 100" + LF + "200 100 200" + LF };
      await held;
      return { status: 0, stdout: "200 1 200" + LF }; // 200 has been re-parented: no children to relate
    },
  });

  await new Promise((r) => setTimeout(r, 60)); // the interval starts a second query
  child.exitCode = 0; // and the leader dies while it is running
  setTimeout(release, 60);

  await tracker.stop();
  const snap = tracker.snapshot();
  assert.equal(snap.looks.raced, 1, "the snapshot the shutdown uses must already count the look that raced");
  assert.deepEqual(snap.pids, [200], "and the raced answer must not have removed what a live look found");
  assert.equal(snap.enumerated, true, "a live look was made, so the enumeration was made");
});

test("⚠️ A TREE WHOSE ONLY LOOK RACED IS REPORTED UNMADE, not as an empty tree", async () => {
  // ⚠️ THE HALF THAT KEEPS THE LENIENCY HONEST. A raced look is discarded rather than treated as a
  // failure, which is right only while some look succeeded: if the leader died during the FIRST
  // query, nothing ever saw its children, and an empty list would be the claim clause 7 forbids —
  // a tree reported childless by a look that could not have seen a child.
  const child = { pid: 100, exitCode: null, signalCode: null };
  let release;
  const held = new Promise((r) => (release = r));
  const tracker = trackDescendants(child, {
    intervalMs: 10_000,
    psRun: async () => {
      await held;
      return { status: 0, stdout: "200 1 200" + LF };
    },
  });

  await new Promise((r) => setTimeout(r, 30));
  child.exitCode = 0;
  setTimeout(release, 20);
  await tracker.stop();

  const snap = tracker.snapshot();
  assert.equal(snap.enumerated, false, "no look survived the leader, so the enumeration was NOT made");
  assert.deepEqual(snap.pids, [], "and nothing is claimed about the tree");
  assert.equal(snap.looks.clean, 0);
});

test("⚠️ A PROCESS TABLE THAT NEVER ANSWERS DOES NOT HANG THE SHUTDOWN", async () => {
  // ⚠️ **MEASURED, NOT IMAGINED.** An operator's Ctrl+Break on Windows reaches every process in the
  // console — including the PowerShell this supervisor runs to read the process table — and
  // PowerShell answers Ctrl+Break by breaking into its debugger, so the query never returns. Six
  // supervisors were left hung on exactly that, each holding a wedged `powershell` child, in the
  // middle of the shutdown ACC-0081 requires to be BOUNDED. Joining an in-flight query is right;
  // waiting for one that never comes back is a hung terminal.
  //
  // Asserted as a DEADLINE, because a hang has no failing assertion of its own.
  const child = { pid: 100, exitCode: null, signalCode: null };
  const tracker = trackDescendants(child, { intervalMs: 10_000, psRun: () => new Promise(() => {}) });

  const started = Date.now();
  await tracker.stop({ joinMs: 300 });
  assert.ok(Date.now() - started < 5000, "stop() must give up on a query that never answers");

  const snap = tracker.snapshot();
  assert.equal(snap.looks.unresolved, 1, "and say that a look was left unresolved");
  assert.equal(snap.enumerated, false, "no look completed, so nothing was enumerated");
});

test("⚠️ A JOIN WITH NOTHING ELSE IN THE EVENT LOOP STILL ENDS, in its own process", async () => {
  // ⚠️ **FOUND BY CI, ON NODE 22, ON BOTH PLATFORMS.** The bound that ends a join was created
  // with an unreffed timer, copied from the poll above it - where unreffing is right, because a
  // diagnostic must not keep a process alive. Here it is exactly backwards: the timer is the only
  // thing that ENDS the join, so unreffed it is no live handle at all. With nothing else pending,
  // node decides the loop has drained and the shutdown STOPS THERE - mid-teardown, no file cleanup,
  // no record, no refusal, and in isolation `exit=13, unsettled top-level await`.
  //
  // ⚠️ **AND IT HAS TO BE A SEPARATE PROCESS.** Inside this suite there is always other work
  // pending, which holds the loop open and resolves the join for reasons that have nothing to do
  // with the join - which is why node 24's runner passed it and node 22's did not. Run alone, the
  // observation is the same on every version.
  const { stdout, code } = await new Promise((resolve) => {
    execFile(process.execPath, [join(FIXTURES, "join-alone.mjs")], { timeout: 20_000 }, (error, out) =>
      resolve({ stdout: out, code: error?.code ?? 0 })
    );
  });

  assert.equal(code, 0, `the join must end rather than the process draining out from under it: ${stdout}`);
  const seen = JSON.parse(stdout.trim());
  assert.equal(seen.resolved, true, "stop() resolved");
  assert.equal(seen.looks.unresolved, 1, "and the query that never answered is recorded as unresolved");
});

test("⚠️ A LOOK THAT FAILS LATER DOES NOT UNMAKE ONE THAT SUCCEEDED", async () => {
  // The same reasoning as the raced look, and the same measured cause: an interrupt reaches the
  // process table program too. A query it cancelled is a look that failed, and treating it as "this
  // tree was never enumerated" would report the ordinary interrupted run as incomplete while the
  // tree it names was enumerated, reached and stopped.
  const child = { pid: 100, exitCode: null, signalCode: null };
  let call = 0;
  const tracker = trackDescendants(child, {
    intervalMs: 10_000,
    psRun: async () => (++call === 1 ? { status: 0, stdout: "100 1 100" + LF + "200 100 200" + LF } : { status: 1, stdout: "" }),
  });
  await tracker.sample();
  await tracker.sample();

  const snap = tracker.snapshot();
  assert.equal(snap.enumerated, true, "a look was made, and a later failure does not unmake it");
  assert.deepEqual(snap.pids, [200], "what the good look found is still what will be stopped");
  assert.equal(snap.looks.failed, 1, "and the failure is recorded rather than forgiven silently");
  await tracker.stop();
});

test("the tracker keeps the UNION, so a child seen once is not lost by a later poll", async () => {
  // ⚠️ KEEPING ONLY THE LAST SAMPLE would lose anything that started and finished between two polls
  // — and, worse, anything present at the first look and re-parented before the second.
  const agent = child({ pid: 100 });
  let look = 0;
  const tracker = trackDescendants(agent, {
    psRun: () => ({ status: 0, stdout: ++look === 1 ? "100 1 100\n200 100 200\n" : "100 1 100\n300 100 300\n" }),
  });
  // ⚠️ **THE SAMPLE IS AWAITED NOW, because reading a process table is I/O and on Windows it costs a
  // PowerShell start.** A synchronous poll at that price left the supervisor blocked a large share
  // of the time, which is an operator's Ctrl+C sitting unhandled.
  await tracker.sample();
  await tracker.sample();
  assert.deepEqual(tracker.snapshot().pids.sort(), [200, 300], "both, not just the latest");
  await tracker.stop();
});
