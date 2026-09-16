/**
 * O14: the process table is read once before anything is spawned, or the run refuses.
 *
 * ⚠️ **WHY THIS EXISTS, MEASURED.** CI run 35055338147 instrumented every Windows query's phases. The first
 * query of a run spent 7,114ms between its child starting and that child's first byte, while the child
 * itself started in 13ms and every later query answered in about 300ms. Both trees' first queries unblocked
 * in the same millisecond though they began 450ms apart, and a WMI-free enumeration of the same machine at
 * that same moment took 68ms. The cost is one shared first use of the WMI provider, and it is paid here,
 * before either child exists, rather than inside a teardown an operator is waiting out.
 *
 * ⚠️ **NOTHING HERE TOUCHES A REAL PROCESS TABLE.** Every case injects the reader.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { PROCESS_TABLE_COMMAND, PROCESS_TABLE_TIMEOUT_MS, primeProcessTable } from "../lib/supervisor.mjs";

const LF = String.fromCharCode(10);
/** A reader that answers with the rows it was given, in the shape the production reader returns. */
const answers = (rows) => () => ({ status: 0, stdout: rows.map((r) => r.join(" ")).join(LF) + LF });
const SELF = 4242;

test("⚠️ O14 POSIX is not primed at all: `ps` has no provider to start", async () => {
  let calls = 0;
  const r = await primeProcessTable({
    platform: "linux",
    pid: SELF,
    psRun: () => {
      calls += 1;
      return { status: 0, stdout: "" };
    },
  });

  assert.deepEqual(r, { ran: false, ok: true, verified: false, reason: "not-windows", ms: 0, rows: null });
  assert.equal(calls, 0, "nothing was read");
});

test("⚠️ O14 a Windows table that shows this process with a creation time primes the provider", async () => {
  const seen = [];
  const r = await primeProcessTable({
    platform: "win32",
    pid: SELF,
    psRun: (cmd, args) => {
      seen.push([cmd, args.join(" ")]);
      return answers([
        [1, 0, "133000000000000000"],
        [SELF, 1, "133000000000000001"],
      ])();
    },
  });

  assert.equal(r.ran, true);
  assert.equal(r.ok, true);
  assert.equal(r.verified, true);
  assert.equal(r.reason, null);
  assert.equal(r.rows, 2);
  assert.equal(typeof r.ms, "number");

  // ⚠️ THE PRODUCTION COMMAND, NOT A CHEAPER STAND-IN. Priming a different reader would warm something the
  // run never uses, which is indistinguishable from not priming at all.
  assert.equal(seen.length, 1, "read once");
  assert.equal(seen[0][0], "powershell");
  assert.equal(seen[0][1], PROCESS_TABLE_COMMAND.win32[1].join(" "));
});

test("⚠️ O14 a table that never answers refuses, and says it timed out", async () => {
  const r = await primeProcessTable({
    platform: "win32",
    pid: SELF,
    timeoutMs: 60,
    psRun: () => new Promise(() => {}),
  });

  assert.equal(r.ok, false);
  assert.equal(r.verified, false);
  assert.equal(r.reason, "process-table-timeout");
  assert.equal(r.rows, null);
  assert.ok(r.ms >= 50, `the wait is recorded: ${r.ms}`);
});

test("⚠️ O14 a reader that fails refuses, with the failure classified", async () => {
  const r = await primeProcessTable({ platform: "win32", pid: SELF, psRun: () => ({ status: 1, stdout: "" }) });

  assert.equal(r.ok, false);
  assert.equal(r.reason, "powershell-failed");
  assert.equal(r.rows, null);
});

test("⚠️ O14 a table that cannot show this process refuses, however many rows it has", async () => {
  const r = await primeProcessTable({
    platform: "win32",
    pid: SELF,
    psRun: answers([
      [1, 0, "133000000000000000"],
      [99, 1, "133000000000000002"],
    ]),
  });

  assert.equal(r.ok, false);
  assert.equal(r.verified, false);
  assert.equal(r.reason, "supervisor-not-in-table");
  assert.equal(r.rows, 2, "what it did contain is still reported");
});

test("⚠️ O14 this process without a creation time refuses: a pid alone is not an identity (F116)", async () => {
  const r = await primeProcessTable({
    platform: "win32",
    pid: SELF,
    psRun: answers([
      [1, 0, "133000000000000000"],
      [SELF, 1, "-"],
    ]),
  });

  assert.equal(r.ok, false);
  assert.equal(r.verified, false);
  assert.equal(r.reason, "creation-time-unavailable");
  assert.equal(r.rows, 2);
});

test("⚠️ O14 the table itself is never handed back, so no shutdown can decide from it", async () => {
  const r = await primeProcessTable({
    platform: "win32",
    pid: SELF,
    psRun: answers([
      [SELF, 1, "133000000000000001"],
      [77, SELF, "133000000000000003"],
    ]),
  });

  // ⚠️ A TABLE READ BEFORE THE CHILDREN EXISTED DESCRIBES A MACHINE NONE OF THEM WERE ON. Only the count
  // survives, so nothing downstream can mistake it for a snapshot of this run's trees.
  assert.equal(r.rows, 2);
  assert.deepEqual(Object.keys(r).sort(), ["ms", "ok", "ran", "reason", "rows", "verified"]);
  for (const value of Object.values(r)) assert.ok(value === null || typeof value !== "object", JSON.stringify(r));
  assert.deepEqual(JSON.parse(JSON.stringify(r)), r, "it is plain values, fit for a record");
});

test("⚠️ O14 priming gives up at the existing process-table bound, which is not raised for it", async (t) => {
  // ⚠️ **THE BOUND IS DRIVEN, NOT READ.** Asserting the constant's value proves nothing about what priming
  // waits for: a default of three times the timeout passes that assertion and still holds an operator's
  // launch for thirty seconds. The clock is mocked so the real wait costs nothing.
  t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const settled = [];
    const priming = primeProcessTable({ platform: "win32", pid: SELF, psRun: () => new Promise(() => {}) }).then((r) => {
      settled.push(r);
      return r;
    });

    t.mock.timers.tick(PROCESS_TABLE_TIMEOUT_MS - 1);
    for (let i = 0; i < 5; i++) await Promise.resolve();
    assert.deepEqual(settled, [], "it is still waiting one millisecond before the bound");

    // ⚠️ NOT `await priming`: under a raised bound that never resolves, and a hang is a test that reports
    // nothing after ten minutes. Flushing a fixed number of turns fails fast and says what was wrong.
    t.mock.timers.tick(1);
    for (let i = 0; i < 5; i++) await Promise.resolve();
    assert.equal(settled.length, 1, "it gives up AT the bound, not at a multiple of it");
    assert.equal(settled[0].ok, false);
    assert.equal(settled[0].reason, "process-table-timeout");
  } finally {
    t.mock.timers.reset();
  }
});
