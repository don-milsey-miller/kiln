/**
 * F122: the Windows process table, read without WMI.
 *
 * ⚠️ **WHY THE ROUTE CHANGED, MEASURED.** The CIM query's first use of the WMI provider stalled for 7,114ms in
 * CI run 35055338147. The launch preflight was added to pay that cost before any child existed, and in run
 * 35097288227 the primed read itself exceeded the 10,000ms bound and the launch was refused. The recorded rule
 * was that one more primed timeout retires WMI, so the table is now read with `NtQuerySystemInformation`.
 *
 * ⚠️ **THE REAL READS ARE THE POINT.** Every other process-table test injects the reader. These run the
 * production command against this machine, because an offset read one field over produces a table that parses
 * perfectly and names the wrong parent or the wrong creation time.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";

import {
  PROCESS_TABLE_COMMAND,
  descendantsOfAsync,
  primeProcessTable,
  readProcessTable,
} from "../lib/supervisor.mjs";

const WINDOWS = process.platform === "win32";
const onlyWindows = { skip: !WINDOWS && "reads the real Windows process table" };
/** FILETIME counts 100ns intervals from 1601; the Unix epoch is 11,644,473,600 seconds later. */
const filetimeToMs = (created) => Number(BigInt(created) / 10000n) - 11_644_473_600_000;
/** Generous against CI clocks, and still far closer than any wrong field would land. */
const CLOCK_SLACK_MS = 5_000;

test("⚠️ F122 the Windows process table uses no WMI and no compiler", () => {
  const [cmd, args] = PROCESS_TABLE_COMMAND.win32;
  const text = args.join(" ");
  assert.equal(cmd, "powershell");
  assert.doesNotMatch(text, /Get-CimInstance|Get-WmiObject|Win32_Process|winmgmts|wmic/i, "no WMI route");
  assert.doesNotMatch(text, /Add-Type|csc/i, "no compilation");
  assert.match(text, /NtQuerySystemInformation/);
  assert.ok(!text.includes('"'), "no double quote to be mangled by the Windows command line");
});

test("⚠️ F122 the real table shows this process with its real parent and creation time", onlyWindows, async () => {
  const read = await readProcessTable();
  assert.equal(read.error, null);
  const self = read.rows.get(process.pid);
  assert.ok(self, "this process is in the table");
  assert.equal(self.ppid, process.ppid, "the parent field is the parent");

  const startedMs = Date.now() - process.uptime() * 1000;
  assert.ok(self.created, "a creation time was read");
  assert.ok(
    Math.abs(filetimeToMs(self.created) - startedMs) < CLOCK_SLACK_MS,
    `the creation field is this process's start: ${new Date(filetimeToMs(self.created)).toISOString()} against ${new Date(startedMs).toISOString()}`
  );
});

test("⚠️ F122 every real process except the idle process has a creation time", onlyWindows, async () => {
  const read = await readProcessTable();
  assert.equal(read.error, null);
  assert.ok(read.rows.size > 10, `a whole table, not a truncated one: ${read.rows.size} rows`);
  const missing = [...read.rows.values()].filter((r) => r.created === null && r.pid !== 0).map((r) => r.pid);
  assert.deepEqual(missing, [], "the kernel reports creation times without opening any process");
});

test("⚠️ F122 a child spawned now is found as a descendant, with the identity it was created with", onlyWindows, async () => {
  const before = Date.now();
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { stdio: "ignore" });
  try {
    await new Promise((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    const found = await descendantsOfAsync(process.pid);
    assert.equal(found.error, null);
    const identity = found.identities.find((d) => d.pid === child.pid);
    assert.ok(identity, `the child ${child.pid} was enumerated: ${JSON.stringify(found.pids)}`);
    assert.ok(
      Math.abs(filetimeToMs(identity.created) - before) < CLOCK_SLACK_MS,
      "its creation time is when it was spawned"
    );
  } finally {
    child.kill();
  }
});

test("⚠️ F122 the launch preflight verifies this process through the production reader", onlyWindows, async () => {
  const r = await primeProcessTable();
  assert.equal(r.ran, true);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.verified, true);
});
