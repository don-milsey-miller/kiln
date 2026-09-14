/**
 * F119: every descendant-tracker query leaves a record.
 *
 * CI twice recorded a Windows tree whose only query was `unresolved` when the shutdown stopped waiting, and nothing
 * said when that query started, whether the leader was alive, or how long it had run. Each query now records its
 * timing on a monotonic clock, the leader's state at start and completion, what it returned, how the process-table
 * program ended, and how it was classified. The records are diagnostic: these tests also pin that every count,
 * join and classification is exactly what it was before them.
 *
 * ⚠️ NOTHING HERE STARTS OR SIGNALS A PROCESS. Every tracker is given `psRun` and a fake clock.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { stopTree, trackDescendants } from "../lib/supervisor.mjs";

/** A newline, spelled without an escape so no generator can mangle it. */
const LF = String.fromCharCode(10);
const table = (...rows) => ({ status: 0, stdout: rows.join(LF) + LF });
const agentChild = () => ({ pid: 100, exitCode: null, signalCode: null });
const tick = () => new Promise((r) => setImmediate(r));

function fakeClock(start = 1000) {
  let t = start;
  return { now: () => t, advance: (ms) => (t += ms) };
}

test("⚠️ F119 a completed query records its timing, the leader's state, what it returned and how the process ended", async () => {
  const clock = fakeClock();
  const agent = agentChild();
  const tracker = trackDescendants(agent, {
    tree: "agent",
    clock: clock.now,
    intervalMs: 60_000,
    psRun: async () => {
      clock.advance(700);
      return table("100 1 1000", "200 100 1100");
    },
  });
  await tracker.sample();
  clock.advance(300);
  const origin = clock.now(); // the shutdown begins 300ms after the query answered
  agent.exitCode = 0;
  await tracker.stop();

  const snap = tracker.snapshot({ origin });
  assert.deepEqual(snap.looks, { clean: 1, raced: 0, failed: 0, unresolved: 0 }, "the counts are what they always were");
  assert.deepEqual(snap.queries, [
    {
      id: "agent-1",
      tree: "agent",
      look: 1,
      startMs: -1000,
      endMs: -300,
      durationMs: 700,
      leaderAliveAtStart: true,
      leaderAliveAtEnd: true,
      descendants: [200],
      identities: [{ pid: 200, created: "1100" }],
      unverifiable: [],
      process: { status: 0, timedOut: false, signal: null, error: null },
      error: null,
      classification: "clean",
      discarded: false,
      discardReason: null,
      unresolvedAtFinalize: false,
      completedAfterFinalize: false,
      lateOutcome: null,
      completedAfterRootExit: false,
      rootRow: { pid: 100, created: "1000" },
      rootVerification: "captured",
    },
  ]);
  assert.deepEqual(snap.queryTiming, { origin: "shutdown-start", trackingStartedMs: -1000, finalizedMs: 0 });
});

test("⚠️ F119 a query still in flight when the shutdown stops waiting is recorded unresolved, with no end", async () => {
  const clock = fakeClock();
  const launcher = agentChild();
  const tracker = trackDescendants(launcher, { tree: "launcher", clock: clock.now, intervalMs: 60_000, psRun: () => new Promise(() => {}) });
  clock.advance(500);
  const origin = clock.now();
  launcher.exitCode = 0;
  await tracker.stop({ joinMs: 30 });

  const snap = tracker.snapshot({ origin });
  assert.deepEqual(snap.looks, { clean: 0, raced: 0, failed: 0, unresolved: 1 }, "the counts are what they always were");
  assert.equal(snap.queries.length, 1);
  const [q] = snap.queries;
  assert.equal(q.id, "launcher-1");
  assert.equal(q.startMs, -500, "it started 500ms before the shutdown");
  assert.equal(q.endMs, null);
  assert.equal(q.durationMs, null);
  assert.equal(q.leaderAliveAtStart, true);
  assert.equal(q.leaderAliveAtEnd, null, "it never completed, so nothing was seen at completion");
  assert.equal(q.process, null);
  assert.equal(q.classification, "unresolved");
  assert.equal(q.discarded, true);
  assert.equal(q.discardReason, "unresolved-at-finalize");
  assert.equal(q.unresolvedAtFinalize, true);
  assert.equal(snap.queryTiming.finalizedMs, 0);
});

test("⚠️ F119 a query that answers after the shutdown record was produced cannot change that record", async () => {
  let release;
  const held = new Promise((r) => (release = r));
  const clock = fakeClock();
  const agent = agentChild();
  const tracker = trackDescendants(agent, {
    tree: "agent",
    clock: clock.now,
    intervalMs: 60_000,
    psRun: async () => {
      await held;
      return table("100 1 1000", "200 100 1100");
    },
  });
  const origin = clock.now();
  await tracker.stop({ joinMs: 30 }); // the query outlives the join
  const record = await stopTree(
    { pid: 100, exitCode: 0, signalCode: null },
    {
      platform: "linux",
      graceMs: 20,
      hardMs: 20,
      identityReadMs: 50,
      knownDescendants: tracker.snapshot({ origin }),
      run: () => ({ status: 0, stdout: "" }),
      kill: () => {
        throw Object.assign(new Error("gone"), { code: "ESRCH" });
      },
      psRun: () => table(),
    }
  );
  const produced = JSON.parse(JSON.stringify(record));
  assert.equal(record.descendantQueries[0].classification, "unresolved", "the record carries the query as the shutdown saw it");

  agent.exitCode = 0; // the leader goes, then the late answer arrives
  clock.advance(900);
  release();
  for (let i = 0; i < 50 && tracker.snapshot().queries[0].endMs === null; i++) await tick();

  assert.deepEqual(JSON.parse(JSON.stringify(record)), produced, "the shutdown record is unchanged by the late answer");
  const later = tracker.snapshot({ origin });
  const [q] = later.queries;
  assert.equal(q.classification, "unresolved", "the classification the shutdown acted on stands");
  assert.equal(q.completedAfterFinalize, true);
  assert.equal(q.durationMs, 900);
  assert.deepEqual(q.lateOutcome, { classification: "raced", discardReason: "leader-exited-before-completion" });
  assert.deepEqual(later.looks, { clean: 0, raced: 1, failed: 0, unresolved: 1 }, "and the late answer is counted exactly as it was before");
});

test("⚠️ F119 a query the leader did not survive is recorded as raced, with what its table returned", async () => {
  let release;
  const held = new Promise((r) => (release = r));
  const clock = fakeClock();
  const agent = agentChild();
  const tracker = trackDescendants(agent, {
    tree: "agent",
    clock: clock.now,
    intervalMs: 60_000,
    psRun: async () => {
      await held;
      return table("100 1 1000", "200 100 1100");
    },
  });
  clock.advance(1200);
  agent.exitCode = 0;
  release();
  await tracker.sample();

  const snap = tracker.snapshot();
  assert.deepEqual(snap.looks, { clean: 0, raced: 1, failed: 0, unresolved: 0 });
  assert.deepEqual(snap.pids, [], "a raced answer still adds nothing to the tracked tree");
  const [q] = snap.queries;
  assert.equal(q.classification, "raced");
  assert.equal(q.discarded, true);
  assert.equal(q.discardReason, "leader-exited-before-completion");
  assert.equal(q.leaderAliveAtStart, true);
  assert.equal(q.leaderAliveAtEnd, false);
  assert.deepEqual(q.descendants, [200], "what the discarded table related to the leader is kept in the record (F118)");
  assert.equal(q.durationMs, 1200);
  assert.equal(snap.queryTiming.origin, "tracking-start", "without a shutdown origin, times are from tracking start");
  await tracker.stop();
});

test("⚠️ F119 a query whose table could not be read is recorded as failed, with how the program ended", async () => {
  const clock = fakeClock();
  const agent = agentChild();
  const timedOut = Object.assign(new Error("timed out"), { killed: true, signal: "SIGTERM", code: null });
  let call = 0;
  const tracker = trackDescendants(agent, {
    tree: "agent",
    platform: "linux",
    clock: clock.now,
    intervalMs: 60_000,
    psRun: async () => (++call === 1 ? { status: 1, stdout: "" } : { status: 1, stdout: "", error: timedOut }),
  });
  await tracker.sample();
  await tracker.sample();

  const snap = tracker.snapshot();
  assert.deepEqual(snap.looks, { clean: 0, raced: 0, failed: 2, unresolved: 0 });
  const [exited, killed] = snap.queries;
  assert.equal(exited.classification, "failed");
  assert.equal(exited.discarded, true);
  assert.equal(exited.discardReason, "table-unreadable");
  assert.equal(exited.error, "ps-failed");
  assert.deepEqual(exited.process, { status: 1, timedOut: false, signal: null, error: null });
  assert.equal(killed.id, "agent-2");
  assert.equal(killed.process.timedOut, true, "a query killed by its timeout says so");
  assert.equal(killed.process.signal, "SIGTERM");
  agent.exitCode = 0;
  await tracker.stop();
});

test("⚠️ F119 a query that drops unverifiable candidates is recorded with what it kept and what it dropped", async () => {
  const agent = agentChild();
  const tracker = trackDescendants(agent, {
    tree: "agent",
    clock: fakeClock().now,
    intervalMs: 60_000,
    psRun: () => table("100 1 1000", "200 100", "300 100 1200"),
  });
  await tracker.sample();

  const snap = tracker.snapshot();
  assert.deepEqual(snap.looks, { clean: 0, raced: 0, failed: 1, unresolved: 0 }, "still counted failed, as before");
  assert.deepEqual(snap.pids, [300], "and the verified candidate is still tracked, as before");
  const [q] = snap.queries;
  assert.equal(q.classification, "failed");
  assert.equal(q.discarded, false);
  assert.equal(q.discardReason, "unverifiable-candidates-dropped");
  assert.deepEqual(q.unverifiable, [200]);
  assert.deepEqual(q.descendants, [300]);
  agent.exitCode = 0;
  await tracker.stop();
});
