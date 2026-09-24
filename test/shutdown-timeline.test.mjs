/**
 * R19: a shutdown record says when each operation ran and when each tree was observed stopped.
 *
 * A Windows shutdown recorded `spentMs: 8092` against an 8,000 ms budget, and its record could not say whether the
 * trees stopped before that mark or what the rest of the time went on. The shutdown now keeps one timeline on one
 * monotonic clock: tracker joins, grace and hard waits, identity reads, signals and `taskkill`, launcher control,
 * owned-file cleanup and the port probe each record a start and an end, and each tree records when its leader's exit
 * and its complete stop were first observed. An operation that did not finish has no end. The timeline decides
 * nothing, and a record already produced cannot be changed by what happens after it.
 *
 * ⚠️ NOTHING HERE STARTS OR SIGNALS A PROCESS. Every call injects `run`, `kill` and `psRun`, backed by one fake table.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { createShutdownTimeline, shutdown, stopTree } from "../lib/supervisor.mjs";

/** A newline, spelled without an escape so no generator can mangle it. */
const LF = String.fromCharCode(10);
const ESRCH = () => Object.assign(new Error("no such process"), { code: "ESRCH" });

/** One fake host: rows are `[pid, ppid, created]`, and every seam reads and changes the same rows. */
function host(rows, { leaders = [] } = {}) {
  const table = new Map(rows.map(([pid, ppid, created]) => [pid, { pid, ppid, created }]));
  let mode = "answers";
  const remove = (pid) => {
    table.delete(pid);
    for (const l of leaders) if (l.pid === pid) l.exitCode = 0;
  };
  return {
    table,
    set: (next) => (mode = next),
    psRun: () => {
      if (mode === "silent") return new Promise(() => {});
      const lines = [...table.values()].map((r) => [r.pid, r.ppid, r.created].filter((x) => x !== undefined).join(" "));
      return { status: 0, stdout: lines.join(LF) + LF };
    },
    run: (cmd, args) => {
      if (cmd === "taskkill") remove(Number(args[args.indexOf("/pid") + 1]));
      return { status: 0, stdout: "" };
    },
    kill: (pid, signal) => {
      if (signal === 0) {
        if (!table.has(Math.abs(pid))) throw ESRCH();
        return true;
      }
      remove(Math.abs(pid));
      return true;
    },
  };
}

const leader = (pid, { exited = false } = {}) => ({ pid, exitCode: exited ? 0 : null, signalCode: null, kill: () => {}, once: () => {} });
const tracked = (identities) => ({
  pids: identities.map(([pid]) => pid),
  identities: identities.map(([pid, created]) => ({ pid, created })),
  enumerated: true,
});
const seams = (h) => ({ run: h.run, kill: h.kill, psRun: h.psRun });

test("⚠️ R19 the timeline times each operation from one origin, leaves unfinished ones without an end, and hands out copies", () => {
  let t = 1000;
  const tl = createShutdownTimeline({ clock: () => t, origin: 1000 });
  t = 1010;
  const grace = tl.begin("grace-wait", { tree: "agent", ms: 50 });
  t = 1060;
  tl.end(grace, { settled: false });
  t = 1070;
  const read = tl.begin("identity-read", { tree: "agent", timeoutMs: 30 });
  t = 1080;
  const probe = tl.begin("port-probe", { port: 1 });
  t = 1100;
  tl.abandon(read, { error: "process-table-timeout", resolved: false, rows: null });
  tl.end(read, { error: null }); // an abandoned operation is never ended afterwards
  tl.observe("leader-exit-event", { tree: "agent" }, 990);
  t = 1200;
  tl.finalize();

  const first = tl.snapshot();
  const produced = JSON.stringify(first);
  assert.equal(first.origin, "shutdown-start");
  assert.equal(first.finalizedMs, 200);
  assert.deepEqual(first.entries, [
    { id: "grace-wait-1", kind: "grace-wait", tree: "agent", ms: 50, startMs: 10, endMs: 60, abandonedMs: null, durationMs: 50, outcome: { settled: false }, startedAfterFinalize: false, endedAfterFinalize: false },
    { id: "identity-read-2", kind: "identity-read", tree: "agent", timeoutMs: 30, startMs: 70, endMs: null, abandonedMs: 100, durationMs: null, outcome: { error: "process-table-timeout", resolved: false, rows: null }, startedAfterFinalize: false, endedAfterFinalize: false },
    { id: "port-probe-3", kind: "port-probe", port: 1, startMs: 80, endMs: null, abandonedMs: null, durationMs: null, outcome: null, startedAfterFinalize: false, endedAfterFinalize: false },
  ]);
  assert.deepEqual(first.observations, [{ kind: "leader-exit-event", tree: "agent", atMs: -10, afterFinalize: false }]);

  // Activity after the record was produced changes a later snapshot, never the one already taken.
  t = 1300;
  tl.end(probe, { free: true });
  tl.begin("late-activity");
  assert.equal(JSON.stringify(first), produced, "the snapshot already taken is unchanged");
  const later = tl.snapshot();
  assert.equal(later.entries[2].endMs, 300);
  assert.equal(later.entries[2].endedAfterFinalize, true);
  assert.equal(later.entries[3].startedAfterFinalize, true);

  first.entries[0].outcome.settled = true;
  assert.equal(tl.snapshot().entries[0].outcome.settled, false, "and changing a snapshot changes nothing inside the timeline");
});

test("⚠️ R19 a tree's waits, identity read and taskkill are timed in order, with when its leader's exit and its stop were observed", async () => {
  const h = host([[200, 1, "1100"]]);
  const tl = createShutdownTimeline();
  const r = await stopTree(leader(100, { exited: true }), {
    platform: "win32",
    graceMs: 120,
    hardMs: 120,
    identityReadMs: 300,
    tree: "agent",
    timeline: tl,
    knownDescendants: tracked([[200, "1100"]]),
    ...seams(h),
  });
  tl.finalize();
  const { entries } = tl.snapshot();

  assert.deepEqual(
    entries.map((e) => e.kind),
    ["grace-wait", "identity-read", "taskkill", "hard-wait"]
  );
  assert.ok(entries.every((e) => e.tree === "agent"));
  assert.ok(entries.every((e) => e.endMs !== null && e.abandonedMs === null && e.startMs <= e.endMs), JSON.stringify(entries));
  for (let i = 1; i < entries.length; i++) assert.ok(entries[i].startMs >= entries[i - 1].endMs, "one after another");
  const [grace, read, kill, hard] = entries;
  // O12: the wait is what the deadline had left after the verification and termination it precedes,
  // never more than the 120ms configured.
  assert.ok(grace.ms > 0 && grace.ms <= 120, `the wait was bounded by the deadline: ${grace.ms}`);
  assert.deepEqual(grace.outcome, { settled: false });
  // O12: what the read was given is the deadline's, not the 300ms configured: the hard period it
  // precedes is held back from it.
  assert.ok(read.timeoutMs > 0 && read.timeoutMs <= 300, `the read was bounded by the deadline: ${read.timeoutMs}`);
  assert.deepEqual(read.outcome, { error: null, resolved: true, rows: 1 });
  assert.equal(kill.pid, 200);
  assert.deepEqual(kill.args, ["/pid", "200", "/F"]);
  assert.deepEqual(kill.outcome, { status: 0 });
  assert.deepEqual(hard.outcome, { settled: true });

  assert.equal(r.treeStopped, true);
  assert.ok(r.timing.leaderExitObservedMs <= grace.startMs, "the leader had already exited when its tree was reached");
  assert.ok(r.timing.treeStopObservedMs >= kill.endMs && r.timing.treeStopObservedMs <= hard.endMs, JSON.stringify(r.timing));
  assert.equal(r.timeline, undefined, "a shared timeline is not copied into the tree record");
});

test("⚠️ R19 an identity read the shutdown stopped waiting for is abandoned, and an unverified tree has no stop time", async () => {
  const h = host([[200, 1, "1100"]]);
  h.set("silent");
  // The escalation period is what the two reads are drawn from (O12), so it is wide enough for both:
  // a deadline with nothing left refuses a read rather than abandoning one, which is a different fact.
  const r = await stopTree(leader(100, { exited: true }), {
    platform: "win32",
    graceMs: 60,
    hardMs: 200,
    identityReadMs: 80,
    tree: "agent",
    knownDescendants: tracked([[200, "1100"]]),
    ...seams(h),
  });

  const reads = r.timeline.entries.filter((e) => e.kind === "identity-read");
  assert.deepEqual(
    r.timeline.entries.map((e) => e.kind),
    ["grace-wait", "identity-read", "identity-read"],
    "nothing was signalled"
  );
  for (const read of reads) {
    assert.equal(read.endMs, null, "a read that never answered did not finish");
    assert.equal(typeof read.abandonedMs, "number");
    assert.equal(read.durationMs, null);
    assert.deepEqual(read.outcome, { error: "process-table-timeout", resolved: false, rows: null });
  }
  assert.equal(r.treeStopped, false);
  assert.equal(r.timing.treeStopObservedMs, null);
  assert.equal(typeof r.timing.leaderExitObservedMs, "number");
  assert.equal(typeof r.timeline.finalizedMs, "number", "a private timeline is finalized and copied into the record");
});

test("⚠️ R19 POSIX signals are timed one by one, deepest first, then the live leader", async () => {
  const agent = leader(100);
  const h = host(
    [
      [100, 1, "1000"],
      [200, 100, "1100"],
      [300, 200, "1200"],
    ],
    { leaders: [agent] }
  );
  const r = await stopTree(agent, {
    platform: "linux",
    graceMs: 200,
    hardMs: 100,
    identityReadMs: 300,
    tree: "agent",
    knownDescendants: tracked([
      [300, "1200"],
      [200, "1100"],
    ]),
    ...seams(h),
  });

  const entries = r.timeline.entries;
  assert.deepEqual(
    entries.map((e) => [e.kind, e.pid ?? null, e.signal ?? null]),
    [
      ["identity-read", null, null],
      ["signal", 300, "SIGTERM"],
      ["signal", 200, "SIGTERM"],
      ["signal", 100, "SIGTERM"],
      ["grace-wait", null, null],
    ]
  );
  assert.ok(entries.filter((e) => e.kind === "signal").every((e) => e.endMs !== null && e.outcome.error === null));
  assert.ok(r.timing.leaderExitObservedMs >= entries[3].endMs, "the leader's exit was observed after it was signalled");
  assert.equal(r.treeStopped, true);
});

test("⚠️ R19 a tree whose leader stopped but whose unverified descendant still runs records no stop time", async () => {
  // The leader ignores SIGTERM and goes on SIGKILL; the tracked child has no recorded identity and is never signalled.
  const agent = leader(100);
  const table = new Map([
    [100, { pid: 100, ppid: 1, created: "1000" }],
    [200, { pid: 200, ppid: 100, created: "1100" }],
  ]);
  const r = await stopTree(agent, {
    platform: "linux",
    graceMs: 80,
    hardMs: 200,
    identityReadMs: 300,
    tree: "agent",
    knownDescendants: { pids: [200], enumerated: true },
    run: () => ({ status: 0, stdout: "" }),
    kill: (pid, signal) => {
      if (signal === 0) {
        if (!table.has(Math.abs(pid))) throw ESRCH();
        return true;
      }
      if (pid === 100 && signal === "SIGKILL") {
        table.delete(100);
        agent.exitCode = 0;
      }
      return true;
    },
    psRun: () => ({ status: 0, stdout: [...table.values()].map((row) => `${row.pid} ${row.ppid} ${row.created}`).join(LF) + LF }),
  });

  assert.equal(r.escalated, true);
  assert.equal(r.exitObserved, true);
  assert.deepEqual(r.descendantsUnverified, [200]);
  assert.equal(r.treeStopped, false);
  assert.equal(typeof r.timing.leaderExitObservedMs, "number", "the leader's exit was observed");
  assert.equal(r.timing.treeStopObservedMs, null, "but the tree was never stopped, so it has no stop time");
});

test("⚠️ R19 the whole shutdown record carries one finalized timeline, and later activity cannot change it", async () => {
  const agent = leader(100, { exited: true });
  const launcher = {
    pid: 300,
    exitCode: null,
    signalCode: null,
    stdin: { destroyed: false, write: () => {}, end: () => setTimeout(() => (launcher.exitCode = 0), 10) },
    kill: () => {},
    once: () => {},
  };
  const h = host([
    [200, 1, "1100"],
    [950, 1, "950"],
  ]);
  const handlers = {};
  const server = {
    once: (event, cb) => (handlers[event] = cb),
    listen: () => setImmediate(() => handlers.listening?.()),
    address: () => ({ port: 1 }),
    close: (cb) => cb?.(),
  };
  const tl = createShutdownTimeline();
  const r = await shutdown({
    agent,
    launcher,
    agentDescendants: tracked([[200, "1100"]]),
    launcherDescendants: tracked([[950, "950"]]),
    port: 1,
    createServerImpl: () => server,
    platform: "win32",
    // O12: one deadline covers both trees, the control channel, the cleanup and the probe, so the
    // fixture gives the teardown enough of one to do all five.
    graceMs: 400,
    hardMs: 200,
    timeline: tl,
    ...seams(h),
  });

  assert.equal(r.complete, true, JSON.stringify(r.unfinished));
  assert.equal(r.budget.withinBudget, true);
  assert.deepEqual(r.unfinished, []);
  const entries = r.timeline.entries;
  // ⚠️ O1 (F130): THE TREES STOP SIDE BY SIDE, so their entries interleave. Each tree's own sequence is fixed, and the
  // cleanup and the probe still come after both.
  const of = (...trees) => entries.filter((e) => trees.includes(e.tree ?? null)).map((e) => e.kind);
  assert.deepEqual(of("agent"), ["grace-wait", "identity-read", "taskkill", "hard-wait"]);
  assert.deepEqual(of("launcher", "launcher-control"), ["launcher-control", "grace-wait", "grace-wait", "identity-read", "taskkill", "hard-wait"]);
  assert.deepEqual(entries.slice(-2).map((e) => e.kind), ["owned-file-cleanup", "port-probe"]);
  assert.equal(entries.length, 12, JSON.stringify(entries.map((e) => [e.kind, e.tree ?? null])));
  assert.ok(entries.every((e) => e.endMs !== null && e.startMs <= e.endMs), JSON.stringify(entries));
  assert.deepEqual(entries.at(-1).outcome, { free: true, timedOut: false }, "the probe answered inside its own bound (O12)");
  assert.ok(r.timeline.finalizedMs >= entries.at(-1).endMs, "the record is finalized after its last operation");
  assert.ok(r.launcherTree.timing.treeStopObservedMs <= entries.at(-2).startMs, "and both stopped before cleanup began");
  assert.equal(typeof r.launcher.exitObservedMs, "number", "the launcher's own exit was observed");

  const produced = JSON.stringify(r);
  tl.end(tl.begin("late-activity"));
  tl.observe("late-observation");
  assert.equal(JSON.stringify(r), produced, "activity after the record was produced does not change it");
  const later = tl.snapshot();
  assert.equal(later.entries.at(-1).startedAfterFinalize, true);
  assert.equal(later.observations.at(-1).afterFinalize, true);
});
