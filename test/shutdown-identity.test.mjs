/**
 * F116: a pid is not an identity.
 *
 * Kiln's shutdown used to signal remembered pids. Once a process is gone its pid can belong to anyone, and
 * a controlled Windows reproduction showed a stale tracked pid being sent `taskkill /T /F`, ending an
 * unrelated process and its child while the record still said the tree had stopped. The shutdown now
 * tracks (pid, creation time), re-checks it immediately before classifying a process as alive and before
 * every signal, sends nothing it cannot verify, and never walks a tree from an agent that has exited.
 *
 * ⚠️ **NOTHING HERE CAN SIGNAL A REAL PROCESS.** Every call injects `run`, `kill` and `psRun`, all backed by
 * one fake process table, so a signal changes the fake and nothing else. The real-Windows reproduction is
 * local evidence, deliberately not a suite test: it starts processes and sends real `taskkill`.
 *
 * ⚠️ **A SMALL WINDOW REMAINS, AND NO TEST HERE CLAIMS OTHERWISE.** Between the identity check and the
 * signal, a verified process can exit and its pid be reused. Only a job object or a signal sent through a
 * handle to the verified process would close it.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { PROCESS_TABLE_COMMAND, parseProcessTable, shutdown, stopTree, trackDescendants } from "../lib/supervisor.mjs";

/** A newline, spelled without an escape so no generator can mangle it. */
const LF = String.fromCharCode(10);
const ESRCH = () => Object.assign(new Error("no such process"), { code: "ESRCH" });
const FAST = { graceMs: 150, hardMs: 150, identityReadMs: 300 };

/**
 * One fake host. Rows are `[pid, ppid, created]`; `run`, `kill` and `psRun` all read and change the same rows.
 *
 * ⚠️ `taskkill /T` IS MODELLED THE WAY WINDOWS DOES IT: by parent id alone, with no idea whose children they
 * are. A fake that knew better would hide the failure this file exists for.
 */
function host(rows, { immortal = [] } = {}) {
  const table = new Map(rows.map(([pid, ppid, created]) => [pid, { pid, ppid, created }]));
  const calls = [];
  const signals = [];
  const leaders = [];
  let mode = "answers";
  const remove = (pid) => {
    if (immortal.includes(pid)) return;
    table.delete(pid);
    for (const l of leaders) if (l.pid === pid) l.exitCode = 0;
  };
  return {
    table,
    calls,
    signals,
    adopt: (leader) => (leaders.push(leader), leader),
    set: (next) => (mode = next),
    psRun: () => {
      if (mode === "silent") return new Promise(() => {});
      if (mode === "unavailable") return { status: 1, stdout: "" };
      const lines = [...table.values()].map((r) => [r.pid, r.ppid, r.created].filter((x) => x !== undefined).join(" "));
      return { status: 0, stdout: lines.join(LF) + LF };
    },
    run: (cmd, args) => {
      calls.push([cmd, ...args]);
      if (cmd !== "taskkill") return { status: 1, stdout: "" };
      const pid = Number(args[args.indexOf("/pid") + 1]);
      if (args.includes("/T")) {
        const reach = [pid];
        for (let i = 0; i < reach.length; i++)
          for (const r of table.values()) if (r.ppid === reach[i] && !reach.includes(r.pid)) reach.push(r.pid);
        reach.forEach(remove);
      } else remove(pid);
      return { status: 0, stdout: "" };
    },
    kill: (pid, signal) => {
      if (signal === 0) {
        if (!table.has(Math.abs(pid))) throw ESRCH();
        return true;
      }
      signals.push([pid, signal]);
      remove(Math.abs(pid));
      return true;
    },
  };
}

const leader = (pid, { exited = false } = {}) => ({ pid, exitCode: exited ? 0 : null, signalCode: null, kill: () => {}, once: () => {} });
const tracked = (identities, leaderIdentity = { pid: 100, created: "1000" }) => ({
  pids: identities.map(([pid]) => pid),
  identities: identities.map(([pid, created]) => ({ pid, created })),
  leader: leaderIdentity,
  enumerated: true,
});
const seams = (h) => ({ run: h.run, kill: h.kill, psRun: h.psRun });
const addressed = (h, pid) => h.calls.some((c) => c[c.indexOf("/pid") + 1] === String(pid)) || h.signals.some(([p]) => Math.abs(p) === pid);

for (const platform of ["win32", "linux"]) {
  test(`⚠️ F116 a reused agent pid is never signalled, and its new holder's children are not ours (${platform})`, async () => {
    // Our agent 100, created at 1000, has exited. Its pid now belongs to an unrelated process created at 5000,
    // which has a child 150 of its own. 200 is our agent's real child and is still running. 250 was also our
    // child, created at 1150; its pid now belongs to a process created at 7000. The survivor forces an
    // escalation, and the escalation must still pass over 250.
    const h = host([
      [100, 1, "5000"],
      [150, 100, "5100"],
      [200, 100, "1100"],
      [250, 1, "7000"],
    ]);
    const known = tracked([
      [250, "1150"],
      [200, "1100"],
    ]);
    const r = await stopTree(leader(100, { exited: true }), { platform, ...FAST, knownDescendants: known, ...seams(h) });

    assert.ok(h.table.has(100) && h.table.has(150), "the process holding the old pid, and its child, are untouched");
    assert.equal(addressed(h, 100), false, "nothing is addressed to the exited agent's pid");
    assert.equal(addressed(h, 150), false, "nor to the new holder's child");
    assert.equal(addressed(h, 250), false, "nor, during an escalation, to a tracked pid whose identity changed");
    assert.ok(h.table.has(250));
    assert.ok(
      r.identity.withheld.some((w) => w.pid === 250 && w.phase === "escalation" && w.reason === "identity-changed"),
      `and why it was passed over is recorded: ${JSON.stringify(r.identity.withheld)}`
    );
    assert.ok(!h.calls.some((c) => c.includes("/T")), "and no tree kill runs at all");
    assert.equal(r.identity.leaderSignalled, false);
    if (platform === "win32") assert.deepEqual(h.calls, [["taskkill", "/pid", "200", "/F"]]);
    else assert.deepEqual(h.signals, [[200, "SIGKILL"]]);
    assert.deepEqual(r.descendantsSurviving, []);
    assert.equal(r.treeStopped, true);
  });

  test(`⚠️ F116 a reused child pid is not signalled, and the reason is recorded (${platform})`, async () => {
    // 200 was our agent's child, created at 1100. The pid now belongs to a process created at 9000.
    const h = host([[200, 1, "9000"]]);
    const r = await stopTree(leader(100, { exited: true }), { platform, ...FAST, knownDescendants: tracked([[200, "1100"]]), ...seams(h) });

    assert.deepEqual(h.calls, [], "no taskkill");
    assert.deepEqual(h.signals, [], "no signal");
    assert.ok(h.table.has(200), "the process now holding 200 is untouched");
    assert.ok(
      r.identity.withheld.some((w) => w.pid === 200 && w.state === "changed" && w.reason === "identity-changed"),
      `the reason is explicit: ${JSON.stringify(r.identity.withheld)}`
    );
    assert.deepEqual(r.descendantsSurviving, [], "the process that was tracked is gone; 200 is not ours any more");
    assert.deepEqual(r.descendantsUnverified, []);
    assert.equal(r.treeStopped, true);
  });

  test(`⚠️ F116 matching identities are stopped one at a time, deepest first, and /T is used only on a live agent (${platform})`, async () => {
    const live = host([
      [100, 1, "1000"],
      [200, 100, "1100"],
      [300, 200, "1200"],
    ]);
    const agent = live.adopt(leader(100));
    const known = tracked([
      [300, "1200"],
      [200, "1100"],
    ]);
    const r = await stopTree(agent, { platform, ...FAST, knownDescendants: known, ...seams(live) });
    if (platform === "win32")
      assert.deepEqual(live.calls, [
        ["taskkill", "/pid", "300", "/F"],
        ["taskkill", "/pid", "200", "/F"],
        ["taskkill", "/pid", "100", "/T", "/F"],
      ]);
    else
      assert.deepEqual(live.signals, [
        [300, "SIGTERM"],
        [200, "SIGTERM"],
        [100, "SIGTERM"],
      ]);
    assert.equal(r.identity.leaderSignalled, true);
    assert.equal(r.treeStopped, true);

    const gone = host([
      [200, 1, "1100"],
      [300, 200, "1200"],
    ]);
    const r2 = await stopTree(leader(100, { exited: true }), { platform, ...FAST, knownDescendants: known, ...seams(gone) });
    if (platform === "win32")
      assert.deepEqual(gone.calls, [
        ["taskkill", "/pid", "300", "/F"],
        ["taskkill", "/pid", "200", "/F"],
      ]);
    else
      assert.deepEqual(gone.signals, [
        [300, "SIGKILL"],
        [200, "SIGKILL"],
      ]);
    assert.equal(r2.identity.leaderSignalled, false);
    assert.equal(r2.treeStopped, true);
  });

  test(`⚠️ F116 an identity that cannot be verified sends nothing and fails closed (${platform})`, async () => {
    const cases = [
      { name: "the process table is unavailable", reason: "process-table-unavailable", mode: "unavailable", rows: [[200, 1, "1100"]], known: tracked([[200, "1100"]]) },
      { name: "the process table never answers", reason: "process-table-timeout", mode: "silent", rows: [[200, 1, "1100"]], known: tracked([[200, "1100"]]) },
      { name: "no identity was ever recorded", reason: "identity-not-recorded", rows: [[200, 1, "1100"]], known: { pids: [200], enumerated: true } },
      { name: "the table has no creation time", reason: "creation-time-unavailable", rows: [[200, 1]], known: tracked([[200, "1100"]]) },
    ];
    for (const c of cases) {
      const h = host(c.rows);
      if (c.mode) h.set(c.mode);
      const started = Date.now();
      const r = await stopTree(leader(100, { exited: true }), { platform, ...FAST, knownDescendants: c.known, ...seams(h) });

      assert.deepEqual(h.calls, [], `${c.name}: no taskkill`);
      assert.deepEqual(h.signals, [], `${c.name}: no signal`);
      assert.ok(
        r.identity.withheld.some((w) => w.pid === 200 && w.state === "unverifiable" && w.reason === c.reason),
        `${c.name}: the reason is explicit: ${JSON.stringify(r.identity.withheld)}`
      );
      assert.deepEqual(r.descendantsUnverified, [200], `${c.name}: named as unverified`);
      assert.deepEqual(r.descendantsSurviving, [], `${c.name}: neither claimed as a survivor of ours`);
      assert.equal(r.treeStopped, false, `${c.name}: nor as stopped`);
      assert.ok(Date.now() - started < 5000, `${c.name}: and the wait for identity is bounded`);
    }
  });
}

test("⚠️ F116 one second apart is ambiguous on POSIX, whose start times are whole seconds, and a different process on Windows", async () => {
  // POSIX `lstart` counts from a boot time derived from the wall clock, so a clock step can move the same
  // process by a second between reads. Treating that as a different process would pass over a real
  // survivor and report the tree stopped. A FILETIME has no such rounding, so any difference is real.
  for (const [platform, state, reason] of [
    ["linux", "unverifiable", "creation-time-ambiguous"],
    ["win32", "changed", "identity-changed"],
  ]) {
    const h = host([[200, 1, "2100"]]);
    const r = await stopTree(leader(100, { exited: true }), { platform, ...FAST, knownDescendants: tracked([[200, "1100"]]), ...seams(h) });
    assert.deepEqual(h.calls, [], `${platform}: no taskkill`);
    assert.deepEqual(h.signals, [], `${platform}: no signal`);
    assert.ok(
      r.identity.withheld.some((w) => w.pid === 200 && w.state === state && w.reason === reason),
      `${platform}: ${JSON.stringify(r.identity.withheld)}`
    );
    assert.equal(r.treeStopped, platform === "win32", `${platform}: only a real difference lets the tree count as stopped`);
  }
});

test("⚠️ F116 an unverifiable descendant makes the whole shutdown partial, and is named", async () => {
  const h = host([[200, 1, "1100"]]);
  h.set("unavailable");
  const launcher = {
    pid: 300,
    exitCode: null,
    signalCode: null,
    stdin: { destroyed: false, write: () => {}, end: () => setTimeout(() => (launcher.exitCode = 0), 10) },
    kill: () => {},
    once: () => {},
  };
  const handlers = {};
  const server = {
    once: (event, cb) => (handlers[event] = cb),
    listen: () => setImmediate(() => handlers.listening?.()),
    address: () => ({ port: 1 }),
    close: (cb) => cb?.(),
  };
  const r = await shutdown({
    agent: leader(100, { exited: true }),
    launcher,
    agentDescendants: tracked([[200, "1100"]]),
    launcherDescendants: { pids: [], identities: [], enumerated: true },
    port: 1,
    createServerImpl: () => server,
    platform: "win32",
    graceMs: 150,
    hardMs: 150,
    ...seams(h),
  });

  assert.deepEqual(h.calls, [], "nothing was signalled");
  assert.ok(r.notObserved.includes("agent-descendants-unverified"), JSON.stringify(r.notObserved));
  assert.equal(r.complete, false);
});

test("⚠️ F116 without a tracked identity, an exited agent's pid is not walked into someone else's tree", async () => {
  // Nothing was tracked, and the exited agent's pid now belongs to a process with a child of its own.
  const h = host([
    [100, 1, "5000"],
    [150, 100, "5100"],
  ]);
  const r = await stopTree(leader(100, { exited: true }), { platform: "win32", ...FAST, ...seams(h) });

  assert.deepEqual(r.descendants, [], "no child is taken from a pid that may be someone else's");
  assert.deepEqual(h.calls, []);
  assert.ok(h.table.has(150));
});

test("⚠️ F116 a stale parent id is not parentage, and each descendant is tracked with its creation time", async () => {
  // 200 names 100 as its parent but was created before 100 existed: its parent was an earlier holder of the pid.
  const agent = { pid: 100, exitCode: null, signalCode: null };
  const rows = ["100 1 1000", "200 100 900", "300 100 1100", "400 300 1200"];
  const tracker = trackDescendants(agent, { intervalMs: 60_000, psRun: () => ({ status: 0, stdout: rows.join(LF) + LF }) });
  await tracker.sample();
  const snap = tracker.snapshot();
  assert.deepEqual(snap.pids, [400, 300]);
  assert.deepEqual(snap.identities, [
    { pid: 400, created: "1200" },
    { pid: 300, created: "1100" },
  ]);
  assert.deepEqual(snap.leader, { pid: 100, created: "1000" });
  assert.equal(snap.looks.clean, 1);
  agent.exitCode = 0;
  await tracker.stop();
});

test("⚠️ F116 a candidate child without a creation time is not tracked, and the look is not clean", async () => {
  const agent = { pid: 100, exitCode: null, signalCode: null };
  const tracker = trackDescendants(agent, { intervalMs: 60_000, psRun: () => ({ status: 0, stdout: "100 1 1000" + LF + "200 100" + LF }) });
  await tracker.sample();
  const snap = tracker.snapshot();
  assert.deepEqual(snap.pids, []);
  assert.equal(snap.looks.failed, 1);
  assert.equal(snap.enumerated, false);
  agent.exitCode = 0;
  await tracker.stop();
});

test("⚠️ F116 every process-table row carries a creation time, on both platforms", () => {
  assert.ok(PROCESS_TABLE_COMMAND.posix[1].join(" ").includes("lstart"), "POSIX asks ps for the start time");
  assert.match(PROCESS_TABLE_COMMAND.win32[1].join(" "), /ReadInt64\(\$e, 0x20\)/, "Windows reads the kernel's creation time");

  const rows = parseProcessTable(
    ["  7     1 Mon Sep 14 12:00:00 2026", "8 7 Fri Sep  4 09:05:07 2026", "9 8 134337279036604340", "10 9 -", "11 10"].join(LF)
  );
  assert.equal(rows.get(7).created, String(Date.parse("Mon Sep 14 12:00:00 2026")));
  assert.equal(rows.get(8).created, String(Date.parse("Fri Sep 4 09:05:07 2026")), "lstart pads single-digit days");
  assert.equal(rows.get(9).created, "134337279036604340", "a FILETIME is kept exactly, past 2^53");
  assert.equal(rows.get(10).created, null, "an unreadable creation time is null");
  assert.equal(rows.get(11).created, null, "and so is a missing one");
});
