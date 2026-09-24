/**
 * O12: one absolute deadline, and every operation bounded by what is left of it.
 *
 * The budget used to describe a teardown rather than limit it. Waiting periods were shares of the time
 * remaining, so they scaled, but the work between them was not bounded at all: an identity read took its
 * own two seconds and each `taskkill` its own spawn, from whatever was left after a grace period had
 * already been assigned as if nothing followed it. Two Windows runs were recorded at 8,092ms and 8,071ms
 * against a budget of 8,000, both of them entirely the unreserved reads and kills, and both reported
 * `withinBudget: false` beside `complete: true`.
 *
 * Every allowance now comes from one deadline: tracker joins, grace and hard periods, identity reads,
 * terminations, owned-file cleanup and the port probe. An operation the deadline cannot cover is not
 * started, is named, and its teardown is not complete.
 *
 * ⚠️ **NOTHING HERE CAN SIGNAL A REAL PROCESS.** Every call injects `run`, `kill`, `psRun` and the server,
 * all backed by fakes, so a signal changes a fake and nothing else.
 *
 * ⚠️ **F119 IS NOT ADDRESSED HERE AND IS NOT CLAIMED TO BE.** A process table that answers slowly, or not
 * at all, is a separate defect; what this file fixes is the teardown spending more time than it declared.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  waitUntil,
  createShutdownDeadline,
  createTableBroker,
  identityFloor,
  shutdown,
  stopTree,
  waitFloor,
  IDENTITY_READ_MIN_MS,
  KILL_TIMEOUT_MS,
  SHUTDOWN_MIN_PHASE_MS,
  SHUTDOWN_TAIL_RESERVE_MS,
  WAIT_SLACK_MS,
} from "../lib/supervisor.mjs";

/** A newline, spelled without an escape so no generator can mangle it. */
const LF = String.fromCharCode(10);
const ESRCH = () => Object.assign(new Error("no such process"), { code: "ESRCH" });

/** A deadline whose clock this test moves by hand: no allowance here depends on wall time. */
const fixed = (atMs, nowMs = 0) => {
  let now = nowMs;
  const clock = createShutdownDeadline({ at: atMs, now: () => now });
  return { clock, tick: (ms) => (now += ms) };
};

const leader = (pid, { exited = false } = {}) => ({ pid, exitCode: exited ? 0 : null, signalCode: null, kill: () => {}, once: () => {} });
const tracked = (identities) => ({
  pids: identities.map(([pid]) => pid),
  identities: identities.map(([pid, created]) => ({ pid, created })),
  leader: { pid: 100, created: "1000" },
  enumerated: true,
});

/** One fake host: rows a read can see, signals a kill records, and an immortal set that ignores them. */
function host(rows, { immortal = [], slow = 0 } = {}) {
  const table = new Map(rows.map(([pid, ppid, created]) => [pid, { pid, ppid, created }]));
  const calls = [];
  const signals = [];
  const remove = (pid) => (immortal.includes(pid) ? undefined : table.delete(pid));
  return {
    table,
    calls,
    signals,
    psRun: () => {
      const answer = { status: 0, stdout: [...table.values()].map((r) => `${r.pid} ${r.ppid} ${r.created}`).join(LF) + LF };
      // A table that takes longer than the allowance it was given is what a bounded read has to survive.
      return slow ? new Promise((resolve) => setTimeout(() => resolve(answer), slow)) : answer;
    },
    run: (cmd, args) => {
      calls.push([cmd, ...args]);
      if (cmd === "taskkill") remove(Number(args[args.indexOf("/pid") + 1]));
      return { status: 0, stdout: "" };
    },
    kill: (pid, signal) => {
      const p = Math.abs(pid);
      if (signal === 0) {
        if (!table.has(p)) throw ESRCH();
        return true;
      }
      signals.push([p, signal]);
      remove(p);
      return true;
    },
  };
}

test("⚠️ O12 an allowance is never more than what was asked for, nor more than the deadline still has", () => {
  const { clock, tick } = fixed(1000);
  assert.equal(clock.remainingMs(), 1000);
  assert.equal(clock.allow(400).ms, 400, "less than what is left is given in full");
  assert.equal(clock.allow(4000).ms, 1000, "more than what is left is cut to the deadline");

  tick(800);
  assert.equal(clock.remainingMs(), 200);
  assert.equal(clock.allow(4000).ms, 200);

  tick(500);
  assert.equal(clock.remainingMs(), 0, "a deadline that has passed has nothing left, never a negative amount");
  assert.deepEqual(clock.allow(100), { ms: 0, granted: false, reason: "deadline-reached", remainingMs: 0 });
});

test("⚠️ O12 a reserve is held back from every allowance, and a standing one from all of them", () => {
  const { clock } = fixed(1000);
  assert.equal(clock.allow(1000, { reserveMs: 300 }).ms, 700, "what follows this operation keeps its share");

  clock.reserveFor(200);
  assert.equal(clock.allow(1000).ms, 800, "the standing reserve applies with no reserve of its own");
  assert.equal(clock.allow(1000, { reserveMs: 300 }).ms, 500, "and adds to one that is given");

  clock.reserveFor(0);
  assert.equal(clock.allow(1000).ms, 1000, "releasing it hands the time back");
});

test("⚠️ O12 an operation whose minimum the deadline cannot cover is refused, with the reason", () => {
  const { clock, tick } = fixed(1000);
  assert.equal(clock.allow(2000, { minMs: 600 }).ms, 1000, "a minimum it can cover is granted, up to what is left");

  tick(500);
  const refused = clock.allow(2000, { minMs: 600 });
  assert.deepEqual(refused, { ms: 0, granted: false, reason: "insufficient-time", remainingMs: 500 });

  // A minimum never exceeds what the operation asked for: a 50ms wait needs 50ms, not a floor.
  assert.equal(clock.allow(50, { minMs: 600 }).granted, true);
  assert.equal(clock.allow(50, { minMs: 600 }).ms, 50);
});

test("⚠️ O12 a reserve never starves the operation it is held back from, and never overruns the deadline", () => {
  // Reserving more than is left would delete the operation entirely; it yields to the minimum instead.
  const { clock } = fixed(1000);
  assert.equal(clock.allow(900, { reserveMs: 5000, minMs: 400 }).ms, 400, "the minimum survives an impossible reserve");
  assert.equal(clock.allow(900, { reserveMs: 5000, floorMs: 250 }).ms, 250, "so does one floor of waiting");
  assert.equal(clock.allow(900, { reserveMs: 5000 }).granted, false, "an operation with neither gives way");

  // And the yielding stops at the deadline: what is left cannot cover the minimum, so nothing is
  // started rather than something too short to do its job.
  const short = fixed(300).clock;
  assert.deepEqual(short.allow(900, { reserveMs: 5000, minMs: 400 }), {
    ms: 0,
    granted: false,
    reason: "insufficient-time",
    remainingMs: 300,
  });
});

test("⚠️ O12 both floors come from the whole budget, so neither read nor wait can crowd the other out", () => {
  assert.equal(identityFloor(8000), IDENTITY_READ_MIN_MS, "a real teardown gives a read what a real read costs");
  assert.equal(waitFloor(8000), SHUTDOWN_MIN_PHASE_MS);
  // A teardown configured shorter than one read gets proportionate floors rather than refusals it
  // could never satisfy, and the two together never exceed the budget they came from.
  for (const budget of [40, 200, 350, 1000, 8000, 60000]) {
    assert.ok(identityFloor(budget) >= 1 && waitFloor(budget) >= 1, `floors stay positive at ${budget}`);
    assert.ok(identityFloor(budget) + waitFloor(budget) <= budget, `floors fit inside ${budget}`);
  }
});

test("⚠️ O12 a grace period is what is left after the verification and termination it precedes", async () => {
  // The tree cannot settle on its own, so the wait runs for exactly what it was allowed.
  const h = host([[200, 1, "1100"]], { immortal: [200] });
  const { clock } = { clock: createShutdownDeadline({ at: Date.now() + 4000 }) };
  const r = await stopTree(leader(100, { exited: true }), {
    platform: "win32",
    graceMs: 4000,
    hardMs: 1000,
    deadline: clock,
    tree: "agent",
    knownDescendants: tracked([[200, "1100"]]),
    run: h.run,
    kill: h.kill,
    psRun: h.psRun,
  });

  const grace = r.timeline.entries.find((e) => e.kind === "grace-wait");
  const read = r.timeline.entries.find((e) => e.kind === "identity-read");
  assert.ok(grace.ms < 4000, `the wait gave way to what follows it: ${grace.ms}`);
  assert.ok(grace.ms >= waitFloor(5000), `and kept its floor: ${grace.ms}`);
  assert.ok(read.timeoutMs >= identityFloor(5000), `the read it reserved for got its floor: ${read.timeoutMs}`);
  assert.ok(r.timeline.entries.some((e) => e.kind === "taskkill"), "and the termination it reserved for happened");
});

test("⚠️ O12 a waiting period ends when its allowance does, not one poll later", async () => {
  // ⚠️ **A WAIT THAT POLLS PAST ITS ALLOWANCE SPENDS SOMEONE ELSE'S TIME.** A period that always slept a
  // whole 50ms poll would run past its allowance and eat the verification reserved after it. What is
  // proved is what the loop ASKS for, on a clock this test moves: no sleep is ever requested past what is
  // left. How late a real timer then fires is the operating system's, and a Windows CI runner fired a
  // 25ms timer 31ms late (F120); the shutdown record measures that, and this test no longer bets on it.
  let now = 0;
  const slept = [];
  const sleep = async (ms) => {
    slept.push({ ms, left: 37 - now });
    now += ms;
  };

  // An allowance shorter than one poll, for something that never happens.
  const never = await waitUntil(() => false, 37, { now: () => now, sleep });
  assert.equal(never, false, "an allowance that runs out is reported as not settled");
  assert.deepEqual(slept.map((s) => s.ms), [37], "one sleep, of exactly what was left, not a whole poll");
  assert.equal(now, 37, "and the wait ends at its allowance, to the millisecond");

  // A longer one polls, and the last sleep is cut to what remains.
  now = 0;
  slept.length = 0;
  const longer = await waitUntil(() => false, 120, { now: () => now, sleep: async (ms) => (slept.push({ ms }), (now += ms)) });
  assert.equal(longer, false);
  assert.deepEqual(slept.map((s) => s.ms), [50, 50, 20], "whole polls, then only the remainder");
  assert.equal(now, 120);

  // Something that settles is looked at first, and the wait stops the moment it is seen.
  now = 0;
  let calls = 0;
  const soon = await waitUntil(() => ++calls >= 3, 1000, { now: () => now, sleep: async (ms) => (now += ms) });
  assert.equal(soon, true);
  assert.equal(calls, 3, "checked before sleeping, then after each poll");
  assert.equal(now, 100, "and no time is spent after it settled");

  // Already settled: no sleep at all, and no allowance spent.
  now = 0;
  let asleep = 0;
  assert.equal(await waitUntil(() => true, 1000, { now: () => now, sleep: async () => (asleep += 1) }), true);
  assert.equal(asleep, 0);

  // A clock that jumps past the end while asleep (a stalled event loop) ends the wait, and never asks for
  // a negative or zero sleep on the way.
  now = 0;
  slept.length = 0;
  const stalled = await waitUntil(() => false, 100, { now: () => now, sleep: async (ms) => (slept.push({ ms }), (now += ms + 500)) });
  assert.equal(stalled, false);
  assert.deepEqual(slept.map((s) => s.ms), [50], "one poll, then the deadline had already passed");
});

test("⚠️ O12 the identity floor a teardown passes down is the one its trees refuse against", async () => {
  // ⚠️ THE FLOOR IS THE WHOLE TEARDOWN'S, NOT THIS TREE'S SHARE OF WHAT IS LEFT. Derived from the
  // share, the second tree — the one most likely to be short of time — would hold the smallest floor
  // and accept the shortest read, which is the one least able to answer.
  const h = host([[200, 1, "1100"]], { immortal: [200] });
  const clock = createShutdownDeadline({ at: Date.now() + 400 });
  const r = await stopTree(leader(100, { exited: true }), {
    platform: "win32",
    graceMs: 100,
    hardMs: 100,
    identityReadMs: 2000,
    // A whole teardown of 3,600ms: its reads are worth starting at 900, not at this tree's 100.
    identityFloorMs: 900,
    deadline: clock,
    tree: "agent",
    knownDescendants: tracked([[200, "1100"]]),
    run: h.run,
    kill: h.kill,
    psRun: h.psRun,
  });

  assert.ok(
    r.unfinished.some((u) => u.operation === "identity-read" && u.reason === "insufficient-time"),
    `400ms cannot cover a 900ms floor, so no read was started: ${JSON.stringify(r.unfinished)}`
  );
  assert.deepEqual(h.calls, [], "and nothing was terminated on an identity nobody read");
  assert.equal(r.treeStopped, false);
});

test("⚠️ O12 a termination is bounded by what is left, and carries that bound to the tool it runs", async () => {
  const h = host([[200, 1, "1100"]]);
  const timeouts = [];
  await stopTree(leader(100, { exited: true }), {
    platform: "win32",
    graceMs: 4000,
    hardMs: 1000,
    tree: "agent",
    knownDescendants: tracked([[200, "1100"]]),
    run: (cmd, args, opts) => (timeouts.push(opts?.timeout ?? null), h.run(cmd, args)),
    kill: h.kill,
    psRun: h.psRun,
  });

  assert.equal(timeouts.length, 1, "one descendant, one termination");
  assert.ok(timeouts[0] > 0 && timeouts[0] <= KILL_TIMEOUT_MS, `the tool was given a bound: ${timeouts[0]}`);
});

test("⚠️ O12 a deadline with nothing left sends no signal, names the operation, and fails closed", async () => {
  // The read that would authorise the kill cannot be started, so nothing is signalled: F116's rule
  // that an unverified pid is never a target is what makes running out of time safe.
  const h = host([[200, 1, "1100"]], { immortal: [200] });
  const spent = createShutdownDeadline({ at: Date.now() - 1 });
  const r = await stopTree(leader(100, { exited: true }), {
    platform: "win32",
    graceMs: 4000,
    hardMs: 1000,
    deadline: spent,
    tree: "agent",
    knownDescendants: tracked([[200, "1100"]]),
    run: h.run,
    kill: h.kill,
    psRun: h.psRun,
  });

  assert.deepEqual(h.calls, [], "nothing was terminated");
  assert.deepEqual(h.signals, [], "nothing was signalled");
  assert.ok(h.table.has(200), "and the process nobody could verify is untouched");
  assert.deepEqual(
    r.unfinished.map((u) => [u.operation, u.reason]),
    [
      ["identity-read", "deadline-reached"],
      ["identity-read", "deadline-reached"],
    ],
    JSON.stringify(r.unfinished)
  );
  assert.deepEqual(r.descendantsUnverified, [200]);
  assert.ok(
    r.identity.withheld.every((w) => w.reason === "shutdown-deadline-reached"),
    JSON.stringify(r.identity.withheld)
  );
  assert.equal(r.treeStopped, false, "and the tree is not reported stopped");
  assert.equal(r.timing.treeStopObservedMs, null);
});

test("⚠️ O12 a read the deadline cut short times out rather than overrunning it", async () => {
  // The table answers, but later than the allowance the deadline could give it.
  const h = host([[200, 1, "1100"]], { immortal: [200], slow: 3000 });
  const started = Date.now();
  const r = await stopTree(leader(100, { exited: true }), {
    platform: "win32",
    graceMs: 300,
    hardMs: 300,
    tree: "agent",
    knownDescendants: tracked([[200, "1100"]]),
    run: h.run,
    kill: h.kill,
    psRun: h.psRun,
  });
  const spent = Date.now() - started;

  // ⚠️ THE WHOLE TEARDOWN, NOT ONLY THE READ. A read that took its own configured timeout would
  // finish well before the table answered and still have spent more than the teardown was given.
  assert.ok(spent <= 600 + WAIT_SLACK_MS * 4, `the teardown stayed inside its own 600ms: ${spent}ms`);
  assert.ok(spent < 3000, `the teardown did not wait for the table: ${spent}ms`);
  assert.deepEqual(h.calls, [], "an unread identity is never a target");
  assert.equal(r.treeStopped, false, "and the tree fails closed");
  const reads = r.timeline.entries.filter((e) => e.kind === "identity-read");
  assert.ok(reads.length >= 1);
  assert.ok(
    reads.every((e) => e.endMs === null && typeof e.abandonedMs === "number"),
    "a read that never answered has no end"
  );
});

test("⚠️ O12 a verified identity whose deadline expires before the signal is not signalled, and is named", async () => {
  // The identity is read successfully; the deadline passes while that read is happening. The pid is
  // ours and is alive, and it is still not signalled: what the deadline cannot pay for is not sent.
  const h = host([[200, 1, "1100"]], { immortal: [200] });
  let now = 0;
  const clock = createShutdownDeadline({ at: 1000, now: () => now });
  const r = await stopTree(leader(100, { exited: true }), {
    platform: "win32",
    graceMs: 1000,
    hardMs: 1000,
    identityReadMs: 400,
    deadline: clock,
    tree: "agent",
    knownDescendants: tracked([[200, "1100"]]),
    run: h.run,
    kill: h.kill,
    // Reading the table is what spends the rest of the deadline.
    psRun: () => ((now = 1000), h.psRun()),
  });

  assert.deepEqual(h.calls, [], "nothing was terminated after the deadline passed");
  assert.deepEqual(
    r.unfinished.map((u) => [u.operation, u.reason]),
    [
      ["terminate", "deadline-reached"],
      // And everything after it: the period that would have observed the kill, and the read that
      // would have classified what was left. Each is named where it was refused.
      ["hard-wait", "deadline-reached"],
      ["identity-read", "deadline-reached"],
    ],
    JSON.stringify(r.unfinished)
  );
  assert.equal(r.identity.leaderSignalled, false, "an exited leader was never a target either");
  assert.equal(r.treeStopped, false);
});

/** A launcher that takes its stop message, and a fake server the probe can bind. */
const politeLauncher = (pid) => {
  const c = { pid, exitCode: null, signalCode: null, kill: () => {}, once: () => {} };
  c.stdin = { destroyed: false, write: () => {}, end: () => setTimeout(() => (c.exitCode = 0), 5) };
  return c;
};
const fakeServer = (free) => {
  const handlers = {};
  return {
    once: (event, cb) => (handlers[event] = cb),
    listen: () => setImmediate(() => (free ? handlers.listening?.() : handlers.error?.(Object.assign(new Error("in use"), { code: "EADDRINUSE" })))),
    address: () => ({ port: 1 }),
    close: (cb) => cb?.(),
  };
};

test("⚠️ O1 the two trees' grace periods run side by side, each leaving its own verification, termination and the tail", async () => {
  // ⚠️ **THE TREES NO LONGER QUEUE BEHIND EACH OTHER (F130).** The agent's grace used to be taken first and held
  // back the launcher's whole teardown, which is how a loaded Windows host left the launcher's identity read too
  // little time. Now both stop at once: each wait leaves room for its own read, its termination and the tail, and
  // the two waits overlap.
  //
  // Both trees settle at once here: what is asserted is the ALLOWANCE the deadline handed out, which
  // is arithmetic over the budget and not a measurement of anything.
  const r = await shutdown({
    agent: leader(100, { exited: true }),
    launcher: leader(300, { exited: true }),
    // Tracked, and already gone: the tree settles immediately and still has descendants to verify.
    agentDescendants: tracked([[200, "1100"]]),
    launcherDescendants: tracked([[950, "950"]]),
    port: 1,
    createServerImpl: () => fakeServer(true),
    platform: "win32",
    graceMs: 6000,
    hardMs: 2000,
    run: () => ({ status: 0, stdout: "" }),
    kill: () => {
      throw ESRCH();
    },
    psRun: () => ({ status: 0, stdout: "" }),
  });

  const treeReserveMs = identityFloor(8000) + SHUTDOWN_MIN_PHASE_MS + WAIT_SLACK_MS;
  const grace = (tree) => r.timeline.entries.find((e) => e.kind === "grace-wait" && e.tree === tree);
  for (const tree of ["agent", "launcher"])
    assert.ok(
      grace(tree).ms > 0 && grace(tree).ms <= r.budget.ms - treeReserveMs - SHUTDOWN_TAIL_RESERVE_MS,
      `the ${tree} tree's wait left its own verification, termination and the tail: ${grace(tree).ms} of ${r.budget.ms}`
    );
  assert.equal(r.complete, true, JSON.stringify(r.unfinished));
});

test("⚠️ O1 (F130) a read requested while another is running joins it, so one table answers both trees", async () => {
  // Both trees keep a live descendant through their grace periods, which end together, and the table is slow.
  const h = host(
    [
      [200, 1, "1100"],
      [950, 1, "950"],
    ],
    { slow: 300 }
  );
  let reads = 0;
  const r = await shutdown({
    agent: leader(100, { exited: true }),
    launcher: politeLauncher(300),
    agentDescendants: tracked([[200, "1100"]]),
    launcherDescendants: tracked([[950, "950"]]),
    port: 1,
    createServerImpl: () => fakeServer(true),
    platform: "win32",
    graceMs: 1000,
    hardMs: 1500,
    run: h.run,
    kill: h.kill,
    psRun: (...a) => (reads++, h.psRun(...a)),
  });

  const grace = (tree) => r.timeline.entries.find((e) => e.kind === "grace-wait" && e.tree === tree);
  assert.ok(grace("launcher").startMs < grace("agent").endMs, "the launcher's wait began while the agent's was still running");
  const escalationReads = r.timeline.entries.filter((e) => e.kind === "identity-read");
  assert.deepEqual(escalationReads.map((e) => e.tree).sort(), ["agent", "launcher"], JSON.stringify(escalationReads));
  assert.equal(escalationReads.filter((e) => e.outcome.joined === true).length, 1, "the second tree's read joined the first");
  assert.equal(reads, 1, "one process table answered both trees");
  assert.equal(r.complete, true, JSON.stringify(r.unfinished));
  assert.deepEqual(r.agent.descendantsSurviving, []);
  assert.deepEqual(r.launcherTree.descendantsSurviving, []);
});

test("⚠️ O1 (F130) a table that has already answered is never handed out again", async () => {
  const h = host([[200, 1, "1100"]]);
  let reads = 0;
  const tables = createTableBroker({ run: (...a) => (reads++, h.psRun(...a)), platform: "win32" });
  const first = await tables.read(1000);
  const second = await tables.read(1000);
  assert.equal(reads, 2, "each read after the last one answered is a new read");
  assert.equal(first.joined, undefined);
  assert.equal(second.joined, undefined);
});

test("⚠️ O12 a completed shutdown is always inside the budget it declares", async () => {
  const h = host([
    [200, 1, "1100"],
    [950, 1, "950"],
  ]);
  const r = await shutdown({
    agent: leader(100, { exited: true }),
    launcher: politeLauncher(300),
    agentDescendants: tracked([[200, "1100"]]),
    launcherDescendants: tracked([[950, "950"]]),
    port: 1,
    createServerImpl: () => fakeServer(true),
    platform: "win32",
    graceMs: 500,
    hardMs: 200,
    run: h.run,
    kill: h.kill,
    psRun: h.psRun,
  });

  assert.equal(r.complete, true, JSON.stringify(r.unfinished));
  assert.equal(r.budget.withinBudget, true);
  assert.ok(r.budget.spentMs <= r.budget.ms, `${r.budget.spentMs} of ${r.budget.ms}`);
  assert.deepEqual(r.unfinished, []);
  // Every operation ended inside the deadline, not merely the sum of them.
  for (const e of r.timeline.entries) assert.ok((e.endMs ?? e.abandonedMs) <= r.budget.ms, `${e.id} ran past the deadline`);
});

test("⚠️ O12 a port probe that does not answer is bounded, and its port is recorded unobserved", async () => {
  // The bind never completes. Unbounded, this was the one step of a teardown that could outlast the
  // deadline by any amount — a hung terminal in place of a hung application.
  const handlers = {};
  const slowServer = {
    once: (event, cb) => (handlers[event] = cb),
    listen: () => setTimeout(() => handlers.listening?.(), 3000).unref?.(),
    address: () => ({ port: 1 }),
    close: (cb) => cb?.(),
  };
  const started = Date.now();
  const r = await shutdown({
    agent: leader(100, { exited: true }),
    launcher: leader(300, { exited: true }),
    agentDescendants: { pids: [], identities: [], enumerated: true },
    launcherDescendants: { pids: [], identities: [], enumerated: true },
    port: 1,
    createServerImpl: () => slowServer,
    platform: "win32",
    graceMs: 500,
    hardMs: 200,
    run: () => ({ status: 0, stdout: "" }),
    kill: () => true,
    psRun: () => ({ status: 0, stdout: "" }),
  });
  const spent = Date.now() - started;

  assert.ok(spent <= 700 + WAIT_SLACK_MS * 4, `the teardown did not wait on the bind: ${spent}ms`);
  assert.equal(r.portFree, null, "an unanswered probe is unobserved, never a free port");
  assert.ok(r.notObserved.includes("port"));
  assert.deepEqual(
    r.unfinished.map((u) => [u.operation, u.reason]),
    [["port-probe", "port-probe-timeout"]],
    JSON.stringify(r.unfinished)
  );
  assert.equal(r.complete, false);
});

test("⚠️ O12 a deadline reached before the cleanup and the probe names them, and the result is not complete", async () => {
  const h = host([[950, 1, "950"]]);
  const removed = [];
  const r = await shutdown({
    agent: null,
    launcher: leader(300, { exited: true }),
    launcherDescendants: { pids: [], identities: [], enumerated: true },
    ownedFiles: ["a-file-this-test-never-creates"],
    port: 1,
    createServerImpl: () => (removed.push("probed"), fakeServer(true)),
    // The trigger's deadline has already passed when the teardown begins.
    deadline: Date.now() - 1,
    platform: "win32",
    graceMs: 500,
    hardMs: 200,
    run: h.run,
    kill: h.kill,
    psRun: h.psRun,
  });

  assert.deepEqual(
    r.unfinished.map((u) => u.operation),
    ["owned-file-cleanup", "port-probe"],
    JSON.stringify(r.unfinished)
  );
  assert.ok(r.unfinished.every((u) => u.reason === "deadline-reached"));
  assert.deepEqual(removed, [], "the probe was never started");
  assert.equal(r.portFree, null, "so the port is unobserved rather than guessed");
  assert.ok(r.notObserved.includes("port"));
  assert.deepEqual(r.files, { removed: [], failed: [] });
  assert.equal(r.complete, false, "a teardown that ran out of deadline is not a complete one");
});

test("⚠️ O12 an overrun cannot be reported as a complete shutdown", async () => {
  // ⚠️ EVERY OTHER OBSERVATION IS PERFECT HERE, AND THAT IS THE POINT. Both trees stopped, nothing was
  // left unfinished, the port rebound — and the teardown took longer than the budget it declares. The
  // overrun used to be a number recorded beside `complete: true` and read by nothing.
  let probed = false;
  const now = () => (probed ? 99_000 : 0);
  const r = await shutdown({
    agent: leader(100, { exited: true }),
    launcher: leader(300, { exited: true }),
    agentDescendants: { pids: [], identities: [], enumerated: true },
    launcherDescendants: { pids: [], identities: [], enumerated: true },
    port: 1,
    // The last operation of the teardown is what pushes its clock past the deadline.
    createServerImpl: () => ((probed = true), fakeServer(true)),
    platform: "win32",
    graceMs: 500,
    hardMs: 200,
    now,
    run: () => ({ status: 0, stdout: "" }),
    kill: () => true,
    psRun: () => ({ status: 0, stdout: "" }),
  });

  assert.equal(r.agent.treeStopped, true);
  assert.equal(r.launcherTree.treeStopped, true);
  assert.equal(r.portFree, true);
  assert.deepEqual(r.unfinished, [], "nothing was refused: the deadline passed inside an operation");
  assert.deepEqual(r.notObserved, []);
  assert.ok(r.budget.spentMs > r.budget.ms, `the teardown overran: ${r.budget.spentMs} of ${r.budget.ms}`);
  assert.equal(r.budget.withinBudget, false);
  assert.equal(r.complete, false, "and an overrun is never complete, whatever else it managed");
});
