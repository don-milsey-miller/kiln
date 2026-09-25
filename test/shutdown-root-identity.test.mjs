/**
 * F118: a tracker query that answers after its root exited is attributed by captured identity, never by timing.
 *
 * CI recorded a Windows query that read the process table while the agent lived, found the agent's real child,
 * and answered 364ms after the agent exited. It was discarded as raced, and a shutdown that had seen everything
 * refused. Such a table is accepted only when its root row carries exactly the creation time captured from an
 * earlier look that completed while the agent was known alive. A pid plus an observed exit time is not identity:
 * the process can exit, its pid be reused, and the exit callback still arrive later. These tests pin that, and that
 * every descendant is still re-checked before it is signalled (F116).
 *
 * ⚠️ NOTHING HERE STARTS OR SIGNALS A PROCESS. Every tracker and shutdown is given its seams.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { stopTree, trackDescendants } from "../lib/supervisor.mjs";

/** A newline, spelled without an escape so no generator can mangle it. */
const LF = String.fromCharCode(10);
const table = (...rows) => ({ status: 0, stdout: rows.join(LF) + LF });
const FILETIME_EPOCH = 116444736000000000n;
const filetime = (ms) => (BigInt(ms) * 10000n + FILETIME_EPOCH).toString();
const T0 = 1_790_000_000_000;
const ROOT = `100 1 ${filetime(T0 - 10)}`;
const CHILD = `200 100 ${filetime(T0 + 50)}`;

const root = () => ({ pid: 100, exitCode: null, signalCode: null });

/**
 * A process-table reader answering each look from the next prepared step: rows at once, or rows released later.
 * Steps are prepared before the tracker starts, because its first look begins as it is created.
 */
function steps() {
  const queue = [];
  return {
    psRun: async () => {
      const step = queue.shift();
      if (!step) throw new Error("no step was prepared for this look");
      if (step.rows) return table(...step.rows);
      await step.held;
      return table(...step.answer);
    },
    now: (...rows) => queue.push({ rows }),
    later: () => {
      let release;
      const step = { held: new Promise((r) => (release = r)), answer: [] };
      step.release = (...rows) => {
        step.answer = rows;
        release();
      };
      queue.push(step);
      return step;
    },
  };
}

const track = (agent, p) => trackDescendants(agent, { platform: "win32", tree: "agent", intervalMs: 60_000, psRun: p.psRun });

test("⚠️ F118 a table answering after the root exited is accepted when it holds the identity captured while the root lived", async () => {
  const agent = root();
  const p = steps();
  p.now(ROOT, CHILD);
  const late = p.later();
  const tracker = track(agent, p);
  await tracker.sample(); // the identity is captured while the root is known alive
  const second = tracker.sample(); // a second look, still running when the root exits
  agent.exitCode = 0;
  late.release(ROOT, CHILD);
  await second;

  const snap = tracker.snapshot();
  assert.deepEqual(snap.looks, { clean: 2, raced: 0, failed: 0, unresolved: 0 }, "the late look counts as clean");
  assert.deepEqual(snap.leader, { pid: 100, created: filetime(T0 - 10) });
  assert.deepEqual(snap.pids, [200]);
  assert.equal(snap.queries[0].rootVerification, "captured");
  const look = snap.queries[1];
  assert.equal(look.classification, "clean");
  assert.equal(look.rootVerification, "verified");
  assert.equal(look.completedAfterRootExit, true, "that it completed after the root exited is recorded");
  assert.equal(look.leaderAliveAtEnd, false);
  await tracker.stop();
});

test("⚠️ F118 without an identity captured while the root lived, a table answering after its exit stays raced", async () => {
  const agent = root();
  const p = steps();
  const only = p.later();
  const tracker = track(agent, p);
  agent.exitCode = 0;
  only.release(ROOT, CHILD); // the rows are genuine, but nothing captured earlier can show that
  await tracker.sample();

  const snap = tracker.snapshot();
  assert.deepEqual(snap.looks, { clean: 0, raced: 1, failed: 0, unresolved: 0 });
  assert.deepEqual(snap.pids, []);
  assert.equal(snap.leader, null, "no identity is taken from a table that answered after the exit");
  assert.equal(snap.queries[0].rootVerification, "identity-not-captured");
  assert.equal(snap.queries[0].classification, "raced");
  await tracker.stop();
});

test("⚠️ F118 control: with the exit callback delayed, a reused pid created before that callback is rejected", async () => {
  const agent = root();
  const p = steps();
  p.now(ROOT, CHILD); // identity captured while the root lives
  const beforeCallback = p.later();
  const afterCallback = p.later();
  const tracker = track(agent, p);
  await tracker.sample();

  // The root really exits at T0+3000, but its exit callback is delayed until T0+3500, so Node still reports it alive.
  // In between, pid 100 is reused by a process created at T0+3100, with a child of its own.
  const reused = [`100 1 ${filetime(T0 + 3100)}`, `250 100 ${filetime(T0 + 3200)}`];
  const answeredBeforeCallback = tracker.sample();
  beforeCallback.release(...reused);
  await answeredBeforeCallback;

  const answeredAfterCallback = tracker.sample(); // started before the callback
  agent.exitCode = 0; // the delayed callback arrives
  afterCallback.release(...reused);
  await answeredAfterCallback;

  const snap = tracker.snapshot();
  assert.deepEqual(snap.looks, { clean: 1, raced: 2, failed: 0, unresolved: 0 }, "both answers about the reused pid are rejected");
  assert.deepEqual(snap.pids, [200], "the reused process's child is never tracked");
  assert.deepEqual(snap.leader, { pid: 100, created: filetime(T0 - 10) }, "and the captured identity is not replaced");
  assert.equal(snap.queries[1].rootVerification, "mismatch");
  assert.equal(snap.queries[1].leaderAliveAtEnd, true, "Node still reported the root alive when that answer arrived");
  assert.equal(snap.queries[2].rootVerification, "mismatch");
  assert.equal(snap.queries[2].completedAfterRootExit, true);
  await tracker.stop();
});

test("⚠️ F118 control: a pid reused within milliseconds of the spawn is not the root, so a late table about it stays raced", async () => {
  // Pi exits 1ms after `spawn()` returns, its pid is reused 2ms later, and the new process has a child. A rule that
  // took any row created close to the spawn as the root would accept this one; nothing about the late table ties it
  // to the original process, so it is not attributed. Only an identity captured by a verified look while the root
  // lived, or one tied to the original process, can make a late table about this pid.
  const spawnedAt = T0;
  const agent = root();
  const p = steps();
  const only = p.later();
  const tracker = track(agent, p);
  agent.exitCode = 0; // exited 1ms after the spawn returned
  only.release(`100 1 ${filetime(spawnedAt + 3)}`, `260 100 ${filetime(spawnedAt + 4)}`); // pid 100 reused 2ms later
  await tracker.sample();

  const snap = tracker.snapshot();
  assert.deepEqual(snap.looks, { clean: 0, raced: 1, failed: 0, unresolved: 0 });
  assert.deepEqual(snap.pids, [], "the reusing process's child is never tracked");
  assert.equal(snap.leader, null, "and no identity is taken from it");
  assert.equal(snap.queries[0].classification, "raced");
  await tracker.stop();
});

test("⚠️ F118 after the root exits, a table without its row or its creation time stays raced", async () => {
  for (const [name, rows] of [
    ["the root's row is absent", [CHILD]],
    ["the root's row has no creation time", ["100 1", CHILD]],
  ]) {
    const agent = root();
    const p = steps();
    p.now(ROOT, CHILD);
    const late = p.later();
    const tracker = track(agent, p);
    await tracker.sample();
    const second = tracker.sample();
    agent.exitCode = 0;
    late.release(...rows);
    await second;
    const snap = tracker.snapshot();
    assert.deepEqual(snap.looks, { clean: 1, raced: 1, failed: 0, unresolved: 0 }, name);
    assert.equal(snap.queries[1].rootVerification, "unavailable", name);
    await tracker.stop();
  }
});

test("⚠️ F118 an accepted late table does not bypass F116: its descendant is re-checked before any signal", async () => {
  const agent = root();
  const p = steps();
  p.now(ROOT, CHILD);
  const late = p.later();
  const tracker = track(agent, p);
  await tracker.sample();
  const second = tracker.sample();
  agent.exitCode = 0;
  late.release(ROOT, CHILD);
  await second;
  await tracker.stop();
  const known = tracker.snapshot();
  assert.deepEqual(known.pids, [200]);

  // By the shutdown, pid 200 belongs to a different process.
  const calls = [];
  const r = await stopTree(agent, {
    platform: "win32",
    graceMs: 100,
    hardMs: 100,
    identityReadMs: 300,
    knownDescendants: known,
    run: (cmd, args) => (calls.push([cmd, ...args]), { status: 0, stdout: "" }),
    kill: (pid, sig) => {
      if (sig === 0 && pid === 200) return true;
      throw Object.assign(new Error("gone"), { code: "ESRCH" });
    },
    psRun: () => table(`200 1 ${filetime(T0 + 9000)}`),
  });
  assert.deepEqual(calls, [], "nothing is signalled");
  assert.ok(r.identity.withheld.some((w) => w.pid === 200 && w.reason === "identity-changed"), JSON.stringify(r.identity.withheld));
});
