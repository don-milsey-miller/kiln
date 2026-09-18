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

import { CLOSE_WAIT_MS, COMPANION_RESULT, COMPANION_TIMEOUT_MS, createQueryDiagnostic } from "./fixtures/supervisor/query-diagnostic.mjs";
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

test("\u26a0\ufe0f A8 each companion is a separate process, timed by its own markers", { skip: process.platform !== "win32" && "starts PowerShell" }, async () => {
  const d = createQueryDiagnostic();
  assert.deepEqual(await d.companions({ force: true }), { ran: true, reason: null });
  const { companions } = d.snapshot();

  // \u26a0\ufe0f THE RECORD TRAVELS WITH EVERY FAILURE. A probe that hits its bound on a loaded host is the finding;
  // an assertion that printed only `undefined` would throw away the timings the probe was run to get.
  const shown = (label) => `${label}${String.fromCharCode(10)}${JSON.stringify(companions, null, 1)}`;

  assert.deepEqual(
    companions.map((c) => c.id),
    ["powershell-start", "native-call-defined", "query-run"],
    shown("the three probes, in order")
  );

  // \u26a0\ufe0f SEQUENTIAL: each begins only after the one before it ENDED, so none times another's contention. A
  // companion ends at its close, or at its own bound when a slow host makes it overrun \u2014 which is exactly the
  // case these probes exist for, so the check is against whichever came first rather than against the close.
  for (let i = 1; i < companions.length; i++) {
    const before = companions[i - 1];
    const ended = before.timedOutMs ?? before.closeMs;
    assert.equal(typeof ended, "number", shown(`${before.id} ended`));
    assert.ok(ended <= companions[i].spawnRequestedMs, shown(`${companions[i].id} started after ${before.id} ended`));
  }

  // \u26a0\ufe0f A BOUNDED TIMEOUT IS AN ANSWER, A FAILED SPAWN IS NOT. `timed-out` says the phase is slower than the
  // bound, which is what these probes measure; `failed` says the probe never ran, which explains nothing.
  for (const c of companions) {
    assert.ok([COMPANION_RESULT.COMPLETED, COMPANION_RESULT.TIMED_OUT].includes(c.result), shown(`${c.id} ended as ${c.result}`));
    assert.equal(typeof c.pid, "number", shown(`${c.id} has a pid`));
    if (c.result === COMPANION_RESULT.TIMED_OUT) {
      assert.equal(typeof c.timedOutMs, "number", shown(`${c.id} records when its bound was reached`));
      assert.equal(typeof c.killRequestedMs, "number", shown(`${c.id} records the kill it asked for`));
      continue;
    }
    // Whatever a completed probe reached, it reached in order, and it reached its end.
    assert.equal(typeof c.markers.entry, "number", shown(`${c.id} reached its first statement`));
    assert.equal(typeof c.markers.done, "number", shown(`${c.id} reached its end`));
    const times = Object.values(c.markers);
    assert.deepEqual(times, [...times].sort((a, b) => a - b), shown(`${c.id}'s markers are in order`));
  }

  // The phases each completed probe adds over the one before it.
  const [, defined, query] = companions;
  if (defined.result === COMPANION_RESULT.COMPLETED)
    assert.equal(typeof defined.markers.defined, "number", shown("the native call defined in memory"));
  if (query.result === COMPANION_RESULT.COMPLETED) {
    for (const phase of ["entry", "defined", "beforeQuery", "afterQuery"]) assert.equal(typeof query.markers[phase], "number", shown(phase));
    assert.ok(query.rows > 10, shown(`the probe walked a whole table: ${query.rows}`));
  }

  // \u26a0\ufe0f A COUNT, NEVER A ROW: nothing a process table said survives into the record.
  const text = JSON.stringify(companions);
  assert.equal(/"\d+ \d+ \d+"/.test(text), false, "no process-table row");
  assert.equal(text.includes("ntdll"), false, "and no script text");
});

/* ================================= the companion classification, on injected children ========================= */

/**
 * A child this test drives, in place of PowerShell.
 *
 * \u26a0\ufe0f **INJECTED, SO THE CLASSIFICATION IS TESTED ON EVERY PLATFORM AND ON EVERY RUN.** The real probes start a
 * real interpreter, so what they end as depends on the host; these say what each ending MEANS, deterministically.
 */
function scriptedCompanions(plan) {
  let call = 0;
  return () => {
    const step = plan[Math.min(call++, plan.length - 1)];
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.pid = 4000 + call;
    child.kill = () => true;
    queueMicrotask(() => {
      child.emit("spawn");
      if (step.silent) return; // never speaks, never closes: its bound is the only thing that ends it
      for (const line of step.lines) child.stdout.emit("data", Buffer.from(`${line}${String.fromCharCode(10)}`));
      child.emit("exit", 0, null);
      child.emit("close", 0, null);
    });
    return child;
  };
}

const SPEAKS = { lines: ["m:entry", "m:defined", "m:beforeQuery", "m:afterQuery", "rows:151", "m:done"] };
const SILENT = { silent: true };

test("\u26a0\ufe0f A8 a probe that answers is completed, and its markers are read in the order they arrived", async () => {
  const d = createQueryDiagnostic({ platform: "win32", spawnImpl: scriptedCompanions([SPEAKS]) });
  assert.deepEqual(await d.companions({ force: true, timeoutMs: 2000 }), { ran: true, reason: null });

  const { companions } = d.snapshot();
  assert.equal(companions.length, 3);
  for (const c of companions) {
    assert.equal(c.result, COMPANION_RESULT.COMPLETED, `${c.id}: ${c.result}`);
    assert.equal(c.outcome, "exit");
    assert.equal(c.timedOutMs, null, "a probe that answered did not time out");
    assert.equal(c.killRequestedMs, null, "and was never killed");
    for (const phase of ["entry", "defined", "beforeQuery", "afterQuery", "done"]) assert.equal(typeof c.markers[phase], "number", `${c.id}: ${phase}`);
    const times = ["entry", "defined", "beforeQuery", "afterQuery", "done"].map((p) => c.markers[p]);
    assert.deepEqual(times, [...times].sort((a, b) => a - b), `${c.id}: the phases are out of order`);
    assert.equal(c.rows, 151, "the row count the probe reported");
  }
});

test("\u26a0\ufe0f A8 a probe that reaches its bound stays a timeout, and is never read as an answer", async () => {
  const d = createQueryDiagnostic({ platform: "win32", spawnImpl: scriptedCompanions([SILENT]) });
  const started = Date.now();
  await d.companions({ force: true, timeoutMs: 80 });
  const spent = Date.now() - started;
  assert.ok(spent < 5000, `the probes were waited out: ${spent}ms`);

  for (const c of d.snapshot().companions) {
    // \u26a0\ufe0f NOT `completed`, AND NOT `failed`. The probe ran and the phase outlasted the bound: that is the
    // measurement, and reporting it as either of the others would lose it.
    assert.equal(c.result, COMPANION_RESULT.TIMED_OUT, `${c.id}: ${c.result}`);
    assert.equal(c.outcome, "timeout");
    assert.equal(typeof c.timedOutMs, "number");
    assert.equal(typeof c.killRequestedMs, "number");
    assert.equal(c.killSent, true, "the probe was asked to stop");
    assert.deepEqual(c.markers, {}, "a silent probe reported no phase");
  }
});

test("\u26a0\ufe0f A8 a probe that times out does not stop the ones after it", async () => {
  // \u26a0\ufe0f THE FIRST PHASE IS THE ONE MOST LIKELY TO STALL, and the phases after it are what say whether the cost
  // is startup alone. Abandoning the run there would throw away the comparison the probes exist to make.
  const d = createQueryDiagnostic({ platform: "win32", spawnImpl: scriptedCompanions([SILENT, SPEAKS, SPEAKS]) });
  await d.companions({ force: true, timeoutMs: 80 });

  const { companions } = d.snapshot();
  assert.deepEqual(
    companions.map((c) => [c.id, c.result]),
    [
      ["powershell-start", COMPANION_RESULT.TIMED_OUT],
      ["native-call-defined", COMPANION_RESULT.COMPLETED],
      ["query-run", COMPANION_RESULT.COMPLETED],
    ],
    "an early timeout changed what the later probes reported"
  );
  // Still sequential: the second began only after the first had reached its bound.
  assert.ok(companions[0].timedOutMs <= companions[1].spawnRequestedMs);
  assert.ok(companions[1].closeMs <= companions[2].spawnRequestedMs);

  // ⚠️ WHAT A FAILURE WOULD PRINT: the phases, and nothing the child said. This is the record an assertion
  // carries, so it has to be both useful and safe to put in a log.
  const record = JSON.stringify(companions, null, 1);
  for (const field of ["spawnRequestedMs", "timedOutMs", "closeMs", "result", "markers"])
    assert.ok(record.includes(field), `the printed record omits ${field}`);
  assert.equal(record.includes("m:"), false, "a raw line the child wrote reached the record");
  assert.equal(/"\d+ \d+ \d+"/.test(record), false, "a process-table row reached the record");

  // The bounds these probes run under, pinned: raising one would stop them measuring what they exist for.
  assert.equal(COMPANION_TIMEOUT_MS, 5000);
  assert.equal(CLOSE_WAIT_MS, 3000);
});
