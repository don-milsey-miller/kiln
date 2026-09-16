/**
 * The F119 query diagnostic: it must record where a query's time went, and change nothing about the query.
 *
 * ⚠️ **THE POINT OF THESE TESTS IS THE WORD "NOTHING".** The diagnostic replaces the process-table reader in
 * the Windows evidence fixture, so a mistake here would change what the supervisor sees: a wrong shape on
 * timeout would turn a timed-out query into an ordinary failure, and a probe result leaking into the return
 * value would feed Toolhelp identities into a shutdown. Both are asserted against directly.
 *
 * Every command here is a short `node -e`, so nothing enumerates or signals a real process.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn as realSpawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createQueryDiagnostic, compileToolhelp, CSC_PATH } from "./fixtures/supervisor/query-diagnostic.mjs";

const dir = () => mkdtempSync(join(tmpdir(), "kiln-f119-diag-"));
/** Rows joined by a newline the CHILD builds, so no real newline ever sits inside its source. */
const prints = (rows) => [process.execPath, ["-e", `process.stdout.write(${JSON.stringify([...rows, ""])}.join(String.fromCharCode(10)))`]];
/** A command that prints a two-row process table and leaves. */
const TABLE = prints(["10 4 133", "11 10 134"]);
/** No probe: these tests are about the reader, and a compiler is not always there. */
const noProbe = () => ({ available: false, reason: "compile-skipped-by-test" });

test("⚠️ F119 a completed query records every phase, the row count, and returns what the reader would", async () => {
  const d = createQueryDiagnostic({ dir: dir(), compile: noProbe });
  const out = await d.psRun(...TABLE);

  // The shape the production reader returns, unchanged: the supervisor parses this exactly as before.
  assert.equal(out.status, 0);
  assert.match(out.stdout, /^10 4 133/);
  assert.equal(out.error, undefined);

  const [q] = d.snapshot().queries;
  assert.equal(q.id, "q1");
  assert.equal(q.outcome, "exit");
  assert.equal(q.exitCode, 0);
  assert.equal(q.rows, 2, "the rows a table reader would have parsed");
  assert.ok(q.stdoutBytes > 0);
  assert.equal(q.stderrBytes, 0);
  assert.equal(q.timedOutMs, null, "a query that answered did not time out");
  assert.equal(q.error, null);

  // ⚠️ THE PHASES, IN ORDER. This is the whole point: a query that spent its time before the child existed is
  // a different defect from one that spent it waiting for the first byte.
  for (const phase of ["spawnRequestedMs", "childCreatedMs", "firstStdoutMs", "exitedMs"])
    assert.equal(typeof q[phase], "number", `${phase} must be recorded`);
  assert.ok(q.spawnRequestedMs <= q.childCreatedMs, `requested ${q.spawnRequestedMs} then created ${q.childCreatedMs}`);
  assert.ok(q.childCreatedMs <= q.firstStdoutMs, `created ${q.childCreatedMs} then first byte ${q.firstStdoutMs}`);
  assert.ok(q.firstStdoutMs <= q.exitedMs, `first byte ${q.firstStdoutMs} then exit ${q.exitedMs}`);
});

test("⚠️ F119 a query that outlasts the timeout is killed and reported exactly as the production reader reports it", async () => {
  // The bound is a seam here only so the test is quick; the fixture uses PROCESS_TABLE_TIMEOUT_MS unchanged.
  const d = createQueryDiagnostic({ dir: dir(), compile: noProbe, timeoutMs: 120 });
  const started = Date.now();
  const out = await d.psRun(process.execPath, ["-e", "setTimeout(() => {}, 60000)"]);
  const spent = Date.now() - started;

  assert.ok(spent < 5000, `the query was not waited out: ${spent}ms`);
  // ⚠️ THIS EXACT SHAPE IS WHAT `trackDescendants` CLASSIFIES AS A TIMED-OUT QUERY. Anything else would
  // change a classification, which the diagnostic is forbidden to do.
  assert.equal(out.status, 1);
  assert.equal(out.stdout, "");
  assert.equal(out.error.killed, true);
  assert.equal(out.error.signal, "SIGTERM");

  const [q] = d.snapshot().queries;
  assert.equal(q.outcome, "timeout");
  assert.equal(typeof q.timedOutMs, "number");
  assert.equal(q.exitedMs, null, "a query that was killed did not finish");
  assert.equal(q.rows, null, "and parsed nothing");
});

test("⚠️ F119 a failing query records its exit code and its first stderr byte, and returns no rows", async () => {
  const d = createQueryDiagnostic({ dir: dir(), compile: noProbe });
  const out = await d.psRun(process.execPath, ["-e", "process.stderr.write('broken'); process.exit(3)"]);

  assert.equal(out.status, 3);
  assert.equal(out.stdout, "");

  const [q] = d.snapshot().queries;
  assert.equal(q.outcome, "non-zero-exit");
  assert.equal(q.exitCode, 3);
  assert.equal(typeof q.firstStderrMs, "number");
  assert.ok(q.stderrBytes > 0);
  assert.equal(q.rows, 0);
});

test("⚠️ F119 a command that cannot start is recorded rather than thrown at the supervisor", async () => {
  const d = createQueryDiagnostic({ dir: dir(), compile: noProbe });
  const out = await d.psRun(join(dir(), "no-such-program.exe"), []);

  assert.equal(out.status, 1);
  assert.equal(out.stdout, "");
  const [q] = d.snapshot().queries;
  assert.ok(["spawn-error", "spawn-threw"].includes(q.outcome), q.outcome);
  assert.equal(typeof q.error, "string", "the failure is classified, never a raw message");
  assert.ok(/^[A-Za-z][A-Za-z0-9_]*$/.test(q.error), q.error);
});

test("⚠️ F119 with no compiler the probe is recorded as unavailable, with its reason, and never silently skipped", async () => {
  const d = createQueryDiagnostic({
    dir: dir(),
    compile: (target, opts) => compileToolhelp(target, { ...opts, csc: join(target, "nowhere", "csc.exe") }),
  });
  await d.psRun(...TABLE);
  const snap = d.snapshot();

  assert.equal(snap.toolhelp.available, false);
  assert.ok(["csc-not-found", "not-windows"].includes(snap.toolhelp.reason), JSON.stringify(snap.toolhelp));
  assert.deepEqual(snap.probes, [], "no probe ran");
  assert.deepEqual(snap.ownedByProbe, [], "and nothing is claimed about identities it never read");
  assert.equal(snap.queries.length, 1, "the query itself still ran");
});

test("⚠️ F119 the probe runs beside the first queries only, and what it reads never reaches the caller", async () => {
  // A stand-in probe: it prints a table whose rows differ from the query's, so a leak would be visible.
  const probeRows = ["10 4 999", "12 10 998", ""].join(String.fromCharCode(10));
  const d = createQueryDiagnostic({
    dir: dir(),
    probeFirst: 2,
    owned: () => [10, 12, 99],
    compile: () => ({ available: true, exe: process.execPath, compileMs: 1 }),
    spawnImpl: (cmd, args, opts) => {
      // The probe is the call with no arguments; give it its own table.
      const real = args.length ? args : ["-e", `process.stdout.write(${JSON.stringify(probeRows)})`];
      return realSpawn(cmd, real, opts);
    },
  });

  const first = await d.psRun(...TABLE);
  const second = await d.psRun(...TABLE);
  const third = await d.psRun(...TABLE);
  // ⚠️ NOTHING THE PROBE SAW IS IN WHAT THE SUPERVISOR GETS BACK.
  for (const out of [first, second, third]) assert.equal(out.stdout.includes("999"), false, out.stdout);

  await new Promise((r) => setTimeout(r, 200));
  const snap = d.snapshot();
  assert.equal(snap.queries.length, 3);
  assert.equal(snap.probes.length, 2, "two queries got a probe, the third did not");
  assert.deepEqual(
    snap.probes.map((p) => p.beside),
    ["q1", "q2"]
  );

  // The comparison covers this run's own pids and says plainly which the probe did not see.
  const [{ owned }] = snap.ownedByProbe;
  assert.deepEqual(
    owned.map((o) => [o.pid, o.found]),
    [
      [10, true],
      [12, true],
      [99, false],
    ]
  );
  assert.equal(owned[0].created, "999", "the probe's own reading, recorded as its own");
  assert.equal(owned[2].ppid, null, "a pid it never saw carries nothing");
});

test("⚠️ F119 the snapshot is a copy of plain values, and the probe's table is not in it", async () => {
  const d = createQueryDiagnostic({ dir: dir(), compile: noProbe });
  await d.psRun(...TABLE);
  const snap = d.snapshot();

  assert.equal(JSON.parse(JSON.stringify(snap)).queries[0].rows, 2, "it survives being written to a record");
  assert.equal("table" in snap.queries[0], false);
  for (const p of snap.probes) assert.equal("table" in p, false);
});

test("⚠️ F119 the diagnostic offers the platform's own command, so the fixture measures the real route", () => {
  const d = createQueryDiagnostic({ dir: dir(), platform: "win32", compile: noProbe });
  const [cmd, args] = d.command();
  assert.equal(cmd, "powershell");
  assert.ok(args.join(" ").includes("Get-CimInstance Win32_Process"), args.join(" "));

  const posix = createQueryDiagnostic({ dir: dir(), platform: "linux", compile: noProbe });
  assert.equal(posix.command()[0], "ps");
  assert.ok(CSC_PATH.endsWith("csc.exe"));
});
