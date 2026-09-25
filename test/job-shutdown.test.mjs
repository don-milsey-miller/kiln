/**
 * The job-mode teardown, against a job whose answers the test chooses — F130 mechanism 2 (TSK-0058), PROTOTYPE.
 *
 * What is under test is the supervisor's side: what it asks the job, in what order, what it records, and that a job
 * it could not observe or could not empty is never reported as a stopped tree. The host itself is tested against the
 * real Windows API in test/windows-job.test.mjs.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { createShutdownDeadline, stopJobTree } from "../lib/supervisor.mjs";

const leader = ({ exited = true, pid = 100 } = {}) => ({ pid, exitCode: exited ? 0 : null, signalCode: null });

/** A job whose list answers come from `lists`, in order; `terminate` answers `ended`. */
function fakeJob({ lists, ended = { ok: true, pids: [] } }) {
  const asked = [];
  let i = 0;
  const next = () => lists[Math.min(i++, lists.length - 1)];
  return {
    asked,
    list: async () => (asked.push("list"), next()),
    terminate: async () => (asked.push("terminate"), ended),
    release: async () => (asked.push("release"), { ok: true }),
  };
}

test("⚠️ F130 a survivor the job still holds after the agent exits is ended with the job, and the tree is then stopped", async () => {
  const job = fakeJob({ lists: [{ ok: true, pids: [300] }, { ok: true, pids: [] }], ended: { ok: true, pids: [300] } });
  const r = await stopJobTree(leader(), job, { graceMs: 1000, hardMs: 1000 });
  assert.deepEqual(job.asked, ["list", "terminate", "list", "release"]);
  assert.deepEqual(r.descendants, [300], "the survivor is named as the tree's descendant");
  assert.equal(r.escalated, true);
  assert.equal(r.job.terminated, true);
  assert.deepEqual(r.job.remaining, []);
  assert.deepEqual(r.descendantsSurviving, []);
  assert.equal(r.descendantsEnumerated, true);
  assert.equal(r.treeStopped, true);
  assert.deepEqual(
    r.timeline.entries.map((e) => e.kind),
    ["job-list", "job-terminate", "hard-wait", "job-release"]
  );
});

test("⚠️ F130 an empty job needs nothing ended, and the tree is stopped", async () => {
  const job = fakeJob({ lists: [{ ok: true, pids: [] }] });
  const r = await stopJobTree(leader(), job, { graceMs: 1000, hardMs: 1000 });
  assert.deepEqual(job.asked, ["list", "release"]);
  assert.equal(r.escalated, false);
  assert.equal(r.treeStopped, true);
});

test("⚠️ F130 a job whose list cannot be read is an unmade observation, never an empty tree", async () => {
  const job = fakeJob({ lists: [{ ok: false, error: "host-timeout" }] });
  const r = await stopJobTree(leader(), job, { graceMs: 1000, hardMs: 1000 });
  assert.equal(r.descendantsEnumerated, false);
  assert.equal(r.treeStopped, false);
});

test("⚠️ F130 a job that does not empty leaves a named survivor, and the tree is not stopped", async () => {
  const job = fakeJob({ lists: [{ ok: true, pids: [300] }, { ok: true, pids: [300] }], ended: { ok: true, pids: [300] } });
  const r = await stopJobTree(leader(), job, { graceMs: 200, hardMs: 300 });
  assert.deepEqual(r.descendantsSurviving, [300]);
  assert.equal(r.treeStopped, false);
});

test("⚠️ F130 a deadline that cannot pay for the list names it, and the tree is not stopped", async () => {
  const clock = createShutdownDeadline({ at: Date.now() - 1 });
  const job = fakeJob({ lists: [{ ok: true, pids: [] }] });
  const r = await stopJobTree(leader(), job, { deadline: clock });
  assert.deepEqual(job.asked, [], "nothing was asked that the deadline could not cover");
  assert.ok(r.unfinished.some((u) => u.operation === "job-list"), JSON.stringify(r.unfinished));
  assert.equal(r.treeStopped, false);
});

test("⚠️ F130 a leader still running is given its grace before the job is listed", async () => {
  const agent = leader({ exited: false });
  setTimeout(() => (agent.exitCode = 0), 100);
  const job = fakeJob({ lists: [{ ok: true, pids: [] }] });
  const r = await stopJobTree(agent, job, { graceMs: 2000, hardMs: 1000 });
  assert.equal(r.exitObserved, true);
  assert.equal(r.treeStopped, true);
  assert.equal(r.timeline.entries[0].kind, "grace-wait");
});
