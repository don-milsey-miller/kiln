/**
 * The F119 query diagnostic: it must record where a query's time went, and change nothing about the query.
 *
 * ⚠️ **THE POINT OF THESE TESTS IS THE WORD "NOTHING".** The diagnostic replaces the process-table reader in
 * the Windows evidence fixture, so a mistake here would change what the supervisor sees: a wrong shape on
 * timeout would turn a timed-out query into an ordinary failure.
 *
 * Every command here is a short `node -e`, so nothing enumerates or signals a real process.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";

import { createQueryDiagnostic } from "./fixtures/supervisor/query-diagnostic.mjs";
import { PROCESS_TABLE_COMMAND } from "../lib/supervisor.mjs";

/** Rows joined by a newline the CHILD builds, so no real newline ever sits inside its source. */
const prints = (rows) => [process.execPath, ["-e", `process.stdout.write(${JSON.stringify([...rows, ""])}.join(String.fromCharCode(10)))`]];
/** A command that prints a two-row process table and leaves. */
const TABLE = prints(["10 4 133", "11 10 134"]);

test("⚠️ F119 a completed query records every phase, the row count, and returns what the reader would", async () => {
  const d = createQueryDiagnostic();
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
  const d = createQueryDiagnostic({ timeoutMs: 120 });
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
  const d = createQueryDiagnostic();
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
  const d = createQueryDiagnostic();
  const out = await d.psRun(join(tmpdir(), "kiln-no-such-program.exe"), []);

  assert.equal(out.status, 1);
  assert.equal(out.stdout, "");
  const [q] = d.snapshot().queries;
  assert.ok(["spawn-error", "spawn-threw"].includes(q.outcome), q.outcome);
  assert.equal(typeof q.error, "string", "the failure is classified, never a raw message");
  assert.ok(/^[A-Za-z][A-Za-z0-9_]*$/.test(q.error), q.error);
});

test("⚠️ F119 each query is recorded separately, in the order they ran", async () => {
  const d = createQueryDiagnostic();
  await d.psRun(...TABLE);
  await d.psRun(...prints(["12 4 135"]));

  const { queries } = d.snapshot();
  assert.deepEqual(
    queries.map((q) => [q.id, q.rows]),
    [
      ["q1", 2],
      ["q2", 1],
    ]
  );
});

test("⚠️ F119 the snapshot is a copy of plain values, fit for a record", async () => {
  const d = createQueryDiagnostic();
  await d.psRun(...TABLE);
  const snap = d.snapshot();

  assert.equal(JSON.parse(JSON.stringify(snap)).queries[0].rows, 2, "it survives being written to a record");
  snap.queries[0].rows = 99;
  assert.equal(d.snapshot().queries[0].rows, 2, "and a caller's edit does not reach the diagnostic");
});

test("⚠️ F119 the diagnostic offers the platform's own command, so the fixture measures the real route", () => {
  const [cmd, args] = createQueryDiagnostic({ platform: "win32" }).command();
  assert.equal(cmd, "powershell");
  assert.deepEqual(args, PROCESS_TABLE_COMMAND.win32[1], "the production arguments, unchanged");
  assert.equal(createQueryDiagnostic({ platform: "linux" }).command()[0], "ps");
});

test("⚠️ O6 a query records its pid, exit, close and byte counts, and keeps none of its output", async () => {
  // Two-byte characters, so a character count and a byte count disagree.
  const d = createQueryDiagnostic();
  await d.psRun(...prints(["10 4 133 éé"]));
  const [q] = d.snapshot().queries;

  assert.equal(typeof q.pid, "number", "the child's pid");
  for (const phase of ["spawnRequestedMs", "childCreatedMs", "firstStdoutMs", "exitMs", "closeMs"])
    assert.equal(typeof q[phase], "number", `${phase} must be recorded`);
  assert.ok(q.exitMs <= q.closeMs, `exit ${q.exitMs} then close ${q.closeMs}`);
  assert.equal(q.signal, null);
  assert.equal(q.stdoutBytes, Buffer.byteLength("10 4 133 éé\n"), "bytes, not characters");
  assert.equal(q.killRequestedMs, null);

  // ⚠️ NO OUTPUT IN THE RECORD: not a row, not a byte of what the command printed.
  const text = JSON.stringify(d.snapshot());
  assert.equal(text.includes("133"), false, "no process-table row");
  assert.equal(text.includes("é"), false, "no output text");
});

test("⚠️ O6 a timed-out query records the kill request, then the signal and the close", async () => {
  const d = createQueryDiagnostic({ timeoutMs: 120 });
  await d.psRun(process.execPath, ["-e", "setTimeout(() => {}, 60000)"]);
  const until = Date.now() + 10_000;
  while (d.snapshot().queries[0].closeMs === null && Date.now() < until) await new Promise((r) => setTimeout(r, 20));
  const [q] = d.snapshot().queries;

  assert.equal(q.outcome, "timeout");
  assert.equal(typeof q.killRequestedMs, "number");
  assert.equal(q.killSent, true);
  assert.ok(q.timedOutMs <= q.killRequestedMs);
  assert.equal(typeof q.closeMs, "number", "the child's close is still recorded after the timeout answered");
  assert.ok(q.killRequestedMs <= q.closeMs);
  assert.ok(q.signal !== null || q.exitCode !== null, "how it ended");
  assert.equal(q.exitedMs, null, "and it is still not reported as a query that finished");
});

test("⚠️ O6 the diagnostic starts the command the way the production reader does", async () => {
  let seen;
  const d = createQueryDiagnostic({
    spawnImpl: (cmd, args, options) => {
      seen = options;
      throw Object.assign(new Error("stop here"), { code: "ESTOP" });
    },
  });
  await d.psRun("powershell", []);
  assert.equal(seen.env.LC_ALL, "C", "the pinned locale");
  assert.equal(seen.windowsHide, undefined, "no hidden window, as execFile's default");
});

test("⚠️ A7 the record waits, within a bound, for a killed child to close", async () => {
  const d = createQueryDiagnostic({ timeoutMs: 120 });
  await d.psRun(process.execPath, ["-e", "setTimeout(() => {}, 60000)"]);
  assert.equal(d.snapshot().queries[0].outcome, "timeout");

  assert.equal(await d.settle(5000), true, "the child closed within the wait");
  const [q] = d.snapshot().queries;
  assert.equal(typeof q.closeMs, "number", "so the record carries its close");
  assert.ok(q.signal !== null || q.exitCode !== null, "and how it ended");
  assert.equal(q.exitedMs, null, "the answer it already gave is unchanged");
});

test("⚠️ A7 settling gives up at its bound rather than waiting a child out", async () => {
  // ⚠️ AN INJECTED CHILD THAT NEVER CLOSES. A real one cannot stand in for this on Windows, where a
  // termination request is not something a process can decline.
  const never = () => {
    const child = new EventEmitter();
    child.pid = 4242;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => true;
    return child;
  };
  const d = createQueryDiagnostic({ timeoutMs: 60, spawnImpl: never });
  await d.psRun("powershell", []);
  const started = Date.now();
  const settled = await d.settle(300);
  const spent = Date.now() - started;

  assert.equal(settled, false, "a child that will not go is reported unsettled");
  assert.ok(spent < 3000, `the wait is bounded: ${spent}ms`);
});

test("⚠️ A8 the companions run only after a real timeout, and only on Windows", async () => {
  const d = createQueryDiagnostic({ platform: "win32" });
  assert.deepEqual(await d.companions(), { ran: false, reason: "no-timeout" }, "a healthy run explains nothing");
  assert.deepEqual(await createQueryDiagnostic({ platform: "linux" }).companions({ force: true }), { ran: false, reason: "not-windows" });
});

test("⚠️ A8 each companion is a separate process, timed by its own markers", { skip: process.platform !== "win32" && "starts PowerShell" }, async () => {
  const d = createQueryDiagnostic();
  assert.deepEqual(await d.companions({ force: true }), { ran: true, reason: null });
  const { companions } = d.snapshot();

  assert.deepEqual(
    companions.map((c) => c.id),
    ["powershell-start", "native-call-defined", "query-run"]
  );
  // ⚠️ SEQUENTIAL: each begins only after the one before it ENDED, so none times another's contention. A
  // companion ends at its close, or at its own bound when a slow host makes it overrun — which is exactly the
  // case these probes exist for, so the check is against whichever came first rather than against the close.
  for (let i = 1; i < companions.length; i++) {
    const before = companions[i - 1];
    const ended = before.timedOutMs ?? before.closeMs;
    assert.equal(typeof ended, "number", `${before.id} ended`);
    assert.ok(ended <= companions[i].spawnRequestedMs, `${companions[i].id} started after ${before.id} ended`);
  }

  const [start, defined, query] = companions;
  assert.equal(typeof start.markers.entry, "number", "PowerShell reaching its first statement");
  assert.equal(typeof defined.markers.defined, "number", "the native call defined in memory");
  for (const phase of ["entry", "defined", "beforeQuery", "afterQuery"]) assert.equal(typeof query.markers[phase], "number", phase);
  assert.ok(query.rows > 10, `the probe walked a whole table: ${query.rows}`);
  for (const c of companions) assert.equal(typeof c.pid, "number");

  // ⚠️ A COUNT, NEVER A ROW: nothing a process table said survives into the record.
  const text = JSON.stringify(companions);
  assert.equal(/"\d+ \d+ \d+"/.test(text), false, "no process-table row");
  assert.equal(text.includes("ntdll"), false, "and no script text");
});
