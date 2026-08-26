/**
 * The tier-1 controller, tested against the PM's seven acceptance conditions.
 *
 *   1. Every provision or execution path reaches a recorded destroy attempt.
 *   2. Cleanup failure is FORCED and tested, not merely handled nominally.
 *   3. The recorded destroy outcome reflects observation.
 *   4. A retained environment is never labelled destroyed.
 *   5. Fixture B becomes authoritative only when the real controller emits it.
 *   6. The real path emits all four omission states with reasons.
 *   7. Tier 1 continues to state honestly that a venv is dependency isolation, not containment.
 *
 * ⚠️ Condition 2 is the one that is easy to fake. A test that injects a throwing remover proves the
 * error is HANDLED; it does not prove the controller can tell a retained workspace from a destroyed
 * one when the filesystem actually refuses. So the forced case here is real: a live process whose
 * current directory is the workspace, which Windows genuinely will not let you delete.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, rmSync, mkdirSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { runJob, destroyWorkspace, allowlistedEnv, resolveWithin, observeExpectedOutputs } from "../lib/validation/controller.mjs";
import { reapLater, reapWorkspace, installReaper } from "./helpers/reap.mjs";

installReaper();

// ⚠️ Every job in this file goes through `run`, not `runJob` directly. A retained workspace is a
// legitimate outcome the controller reports honestly, and on Windows it is a common one after a
// command is killed — but a test that provokes retention and then walks away leaves the directory
// on disk forever. Thirteen call sites, one of which tidied up, produced 155MB of `vpw-tier1-*`
// residue. `reapWorkspace` returns the result unchanged and registers only what was retained, so
// no assertion below moves and nothing is swept before it has been checked.
const run = (...args) => runJob(...args).then(reapWorkspace);
import { CONTROLLER_RUN } from "./fixtures/environment-fixtures.mjs";
import { createValidators, assertValid } from "../lib/validate.mjs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SCHEMAS = join(dirname(fileURLToPath(import.meta.url)), "..", "schemas");
const validators = createValidators(SCHEMAS);

const JOB = (over = {}) => ({
  tier: 1,
  commands: [["{python}", "-c", "print('hello from the venv')"]],
  timeoutMs: 60_000,
  maxOutputBytes: 100_000,
  capturePlan: {
    facts: ["os", "python-version", "workspace", "venv", "git-commit", "cpu-model", "env:TAVILY_API_KEY"],
    disabled: ["timing"],
  },
  expectedOutputs: [],
  ...over,
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------- 2, 3, 4: destroy reports what was observed */

test("FORCED cleanup failure: a locked workspace is retained, never reported destroyed", async () => {
  const ws = reapLater(mkdtempSync(join(tmpdir(), "vpw-forced-")));
  // Windows will not delete a directory that is a live process's current directory. This is a real
  // refusal by the filesystem, not a stubbed error.
  const holder = spawn(process.execPath, ["-e", "setTimeout(()=>{},20000)"], { cwd: ws, stdio: "ignore" });
  try {
    await sleep(400);
    const result = destroyWorkspace(ws);
    assert.equal(result.outcome, "retained");
    assert.equal(result.retainedPath, ws);
    assert.equal(result.evidencePreserved, true);
    assert.match(result.reason, /EPERM|EBUSY|still present/);
    assert.equal(existsSync(ws), true, "the workspace really is still there");
  } finally {
    holder.kill();
    await sleep(400);
    if (existsSync(ws)) rmSync(ws, { recursive: true, force: true });
  }
});

test("...and the same workspace destroys cleanly once the holder releases it", async () => {
  const ws = reapLater(mkdtempSync(join(tmpdir(), "vpw-forced2-")));
  const holder = spawn(process.execPath, ["-e", "setTimeout(()=>{},20000)"], { cwd: ws, stdio: "ignore" });
  await sleep(400);
  assert.equal(destroyWorkspace(ws).outcome, "retained");
  holder.kill();
  await sleep(400);
  const second = destroyWorkspace(ws);
  assert.equal(second.outcome, "destroyed");
  assert.equal(second.verifiedAbsent, true);
});

test("a removal that reports success while the directory survives is RETAINED", () => {
  // ⚠️ The condition-3 case, and the reason the check is `exists()` rather than `!threw`. `rmSync`
  // with force:true can return without throwing and leave the directory behind; trusting the call
  // instead of the filesystem is exactly how a retained environment gets labelled destroyed.
  const result = destroyWorkspace("C:/nowhere/real", { remove: () => {}, exists: () => true });
  assert.equal(result.outcome, "retained");
  assert.match(result.reason, /reported success and the workspace is still present/);
});

test("a removal that throws while the directory IS gone is destroyed, and says so", () => {
  const result = destroyWorkspace("C:/nowhere/real", {
    remove: () => { throw Object.assign(new Error("nope"), { code: "EBUSY" }); },
    exists: () => false,
  });
  assert.equal(result.outcome, "destroyed");
  assert.match(result.note, /verifiably gone/);
});

/* ---------------------------------------------- 1: every path reaches a recorded destroy attempt */

test("a job refused before provisioning still records a destroy outcome", async () => {
  const r = await run(JOB({ tier: 3 }));
  assert.equal(r.ok, false);
  assert.equal(r.phase, "refused");
  assert.equal(r.destroy.outcome, "nothing-to-destroy");
  assert.match(r.destroy.reason, /no workspace was created/i);
});

test("a provisioning failure records the phase, destroys, and captures nothing dishonestly", async () => {
  const r = await run(JOB(), { python: "definitely-not-a-real-interpreter" });
  assert.equal(r.ok, false);
  assert.equal(r.phase, "provision");
  assert.ok(r.destroy, "a failed provision must still reach destroy");
  assert.equal(r.destroy.outcome, "destroyed");
  // ⚠️ It does not report empty facts as if they were observed: the capture plan never ran.
  assert.deepEqual(r.environment.facts, {});
  assert.equal(r.environment.omissions[0].state, "not-captured");
  assert.match(r.environment.omissions[0].reason, /never ran/);
});

test("an execution failure is recorded with its exit status, and still destroys", async () => {
  const r = await run(JOB({ commands: [["{python}", "-c", "import sys; sys.exit(3)"]] }));
  assert.equal(r.executions[0].exitStatus, 3);
  assert.equal(r.destroy.outcome, "destroyed");
  assert.equal(r.ok, true, "the run completed; the COMMAND failed, and those are different facts");
});

test("the reported destroy is checked against the DISK, not against the report", async () => {
  // ⚠️ This test exists because its absence was found by falsification: replacing the whole destroy
  // call in runJob() with a hardcoded `{outcome: "destroyed"}` passed every other test in this file.
  // They all read the RECORD, which is precisely the thing a lying implementation controls. Watching
  // the filesystem is the only assertion a false report cannot satisfy.
  const base = mkdtempSync(join(tmpdir(), "vpw-base-"));
  try {
    const r = await run(JOB({ commands: [["{python}", "-c", "print(1)"]] }), { baseDir: base });
    assert.equal(r.destroy.outcome, "destroyed");
    const { readdirSync } = await import("node:fs");
    assert.deepEqual(readdirSync(base), [], "the workspace must really be gone, not merely reported gone");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

/* -------------------------------- 5, 6, 7: the real path, and fixture B becoming authoritative */

test("the real controller emits all four omission states, with reasons", async () => {
  const r = await run(JOB(), { hostEnv: { ...process.env, TAVILY_API_KEY: "tvly-not-a-real-key" } });

  assert.equal(r.ok, true);
  assert.equal(r.phase, "complete");
  assert.match(r.executions[0].stdout, /hello from the venv/);
  assert.equal(r.destroy.outcome, "destroyed");

  const byState = Object.fromEntries(r.environment.omissions.map((o) => [o.state, o]));
  for (const state of ["not-captured", "not-observable", "unavailable", "redacted"]) {
    assert.ok(byState[state], `the real path must emit ${state}`);
    assert.ok(byState[state].reason?.length > 10, `${state} must carry a reason`);
  }
  // Each state came from a DIFFERENT cause, which is what makes them distinguishable rather than
  // four labels for "missing".
  assert.equal(byState["not-captured"].fact, "timing", "explicitly disabled by the capture plan");
  assert.equal(byState["not-observable"].fact, "cpu-model", "no collector exists");
  assert.equal(byState["unavailable"].fact, "git-commit", "collection ran; the fact was absent");
  assert.equal(byState["redacted"].fact, "env:TAVILY_API_KEY", "obtained, then suppressed");

  // 7: tier 1 states what it is, in the record itself.
  assert.equal(r.environment.execution, "controller");
  assert.equal(r.environment.sandboxTier, 1);
  assert.deepEqual(r.environment.isolationBoundary.isolates, ["python-dependencies"]);
  assert.deepEqual(r.environment.isolationBoundary.doesNotClaim, [
    "containment-of-hostile-code", "host-filesystem-denial", "network-isolation",
  ]);

  // 5: fixture B is authoritative only if the real controller emits its shape.
  assert.deepEqual(
    Object.keys(r.environment.facts).sort(),
    Object.keys(CONTROLLER_RUN.facts).sort(),
    "fixture B's facts must be what the controller actually produces"
  );
  assert.deepEqual(
    r.environment.omissions.map((o) => `${o.fact}:${o.state}`).sort(),
    CONTROLLER_RUN.omissions.map((o) => `${o.fact}:${o.state}`).sort(),
    "fixture B's omissions must be what the controller actually produces"
  );

  // ...and the record it emits validates as evidence, which is the only test that matters for
  // whether any of this can be recorded at all.
  assertValid(validators, "evidence", {
    id: "EVD-9999", type: "evidence", schemaVersion: 2, reviewStatus: "draft", lifecycle: "active",
    title: "T", kind: "experiment", summary: "s", outcome: "success", observedAt: "2026-08-22",
    environment: r.environment,
  }, "controller output as evidence");
});

/* ------------------------------------------------------------------ the allowlisted environment */

test("the child environment is allowlisted, not inherited", () => {
  // ⚠️ DEC-0005: tier 1 supplies no credentials. A run that inherited process.env would inherit
  // every secret the PM happens to have exported, and the boundary would be a sentence.
  const env = allowlistedEnv({ PATH: "/bin", TAVILY_API_KEY: "tvly-secret", AWS_SECRET_ACCESS_KEY: "x", TEMP: "/tmp" });
  assert.deepEqual(Object.keys(env).sort(), ["PATH", "TEMP"]);
  assert.equal(JSON.stringify(env).includes("tvly-secret"), false);
});


/* ------------------------------------------------ containment: the workspace is the whole territory */

test("resolveWithin refuses every path that leaves the workspace, and allows the ones that do not", () => {
  const B = String.fromCharCode(92);
  const ws = mkdtempSync(join(tmpdir(), "vpw-within-"));
  try {
    assert.equal(resolveWithin(ws, "a.txt"), join(ws, "a.txt"));
    assert.equal(resolveWithin(ws, "sub/dir/a.txt"), join(ws, "sub", "dir", "a.txt"));

    for (const bad of ["../escaped.txt", "../../escaped.txt", "a/../../escaped.txt", "/etc/passwd", "C:/Windows/x", B + "x"])
      assert.throws(() => resolveWithin(ws, bad), /must stay inside the workspace|outside the workspace/, bad);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("a job declaring an escaping input is refused, and the escape target is never created", async () => {
  // ⚠️ The assertion that matters is the SECOND one. Checking only the refusal record would pass
  // against an implementation that refused and wrote the file anyway, which is precisely the class of
  // false report the destroy path is built around.
  const base = mkdtempSync(join(tmpdir(), "vpw-escape-"));
  const target = join(base, "escaped.txt");
  try {
    const r = await run(JOB({ inputs: { "../escaped.txt": "pwned" } }), { baseDir: base });
    assert.equal(r.ok, false);
    assert.equal(r.phase, "refused");
    assert.equal(r.reason, "path-escapes-workspace");
    assert.equal(r.destroy.outcome, "nothing-to-destroy");
    assert.equal(existsSync(target), false, "the file outside the workspace must not exist");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("a declared input lands inside the workspace, including in a subdirectory", async () => {
  const r = await run(
    JOB({
      inputs: { "data/in.txt": "forty-two" },
      commands: [["{python}", "-c", "print(open('data/in.txt').read())"]],
    })
  );
  assert.equal(r.ok, true);
  assert.match(r.executions[0].stdout, /forty-two/);
});

/* --------------------------------------------- expected outputs: the declaration is finally checked */

test("a produced expected output is observed, and satisfies the declaration", async () => {
  const r = await run(
    JOB({
      commands: [["{python}", "-c", "open('result.json','w').write('{}')"]],
      expectedOutputs: ["result.json"],
    })
  );
  assert.equal(r.ok, true);
  assert.equal(r.outputsSatisfied, true);
  assert.deepEqual(r.expectedOutputs, [{ path: "result.json", observed: true, present: true, bytes: 2, satisfied: true }]);
});

test("a job that produces NOTHING no longer reports a clean completed run", async () => {
  // ⚠️ This is the defect in one assertion. `expectedOutputs` was a required declaration that nothing
  // read, so this job — which declares a result and produces none — was recorded exactly like one that
  // succeeded. `ok` still describes the LIFECYCLE, which did complete; `outputsSatisfied` describes
  // the RESULT, and the two are separate on purpose.
  const r = await run(JOB({ commands: [["{python}", "-c", "print('did nothing')"]], expectedOutputs: ["result.json"] }));
  assert.equal(r.ok, true, "the controller's own lifecycle completed");
  assert.equal(r.outputsSatisfied, false, "and the job did not produce what it declared");
  assert.equal(r.expectedOutputs[0].present, false);
  assert.equal(r.expectedOutputs[0].observed, true, "we LOOKED and it was absent");
  assert.match(r.expectedOutputs[0].reason, /did not produce its declared result/);
});

test("an output that exists but is emptier than declared is present and NOT satisfied", async () => {
  const r = await run(
    JOB({
      commands: [["{python}", "-c", "open('result.json','w').write('')"]],
      expectedOutputs: [{ path: "result.json", minBytes: 1 }],
    })
  );
  assert.equal(r.expectedOutputs[0].present, true);
  assert.equal(r.expectedOutputs[0].satisfied, false);
  assert.match(r.expectedOutputs[0].reason, /below the declared minimum/);
  assert.equal(r.outputsSatisfied, false);
});

test("a run that never reached observation reports outputs as UNOBSERVED, not as absent", async () => {
  const r = await run(JOB({ expectedOutputs: ["result.json"] }), { python: "definitely-not-a-real-interpreter" });
  assert.equal(r.phase, "provision");
  assert.equal(r.expectedOutputs[0].observed, false, "nothing looked for it");
  assert.equal(r.expectedOutputs[0].satisfied, false);
  assert.match(r.expectedOutputs[0].reason, /never looked for/);
});

test("a job declaring no outputs is vacuously satisfied, because it promised nothing", async () => {
  const r = await run(JOB());
  assert.deepEqual(r.expectedOutputs, []);
  assert.equal(r.outputsSatisfied, true);
});

test("observeExpectedOutputs refuses to look outside the workspace even when handed a bad spec", () => {
  const ws = mkdtempSync(join(tmpdir(), "vpw-obs-"));
  try {
    const [o] = observeExpectedOutputs(ws, { expectedOutputs: ["../../etc/passwd"] });
    assert.equal(o.satisfied, false);
    assert.match(o.reason, /must stay inside the workspace/);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

/* ------------------------------------------------- the ceiling bounds the JOB, not each command in it */

test("the approved timeout bounds the whole execution phase, not every command separately", async () => {
  // ⚠️ Four sleeps of 900ms under a 2000ms ceiling. Per-command timeouts would let all four run —
  // 3.6s against an approved 2s — and every one of them would be "within the timeout". One shared
  // deadline stops the run at the figure that was actually authorised.
  const job = JOB({
    timeoutMs: 2_000,
    commands: Array.from({ length: 4 }, () => ["{python}", "-c", "import time; time.sleep(0.9)"]),
  });
  const r = await run(job);

  const spent = r.executions.reduce((a, e) => a + e.durationMs, 0);
  assert.ok(spent <= job.timeoutMs + 600, `execution spent ${spent}ms against a ${job.timeoutMs}ms ceiling`);
  assert.ok(
    r.executions.some((e) => e.killed || e.timedOut) || r.executions.length < 4,
    `the shared deadline must stop the run: ${JSON.stringify(r.executions.map((e) => [e.durationMs, e.exitStatus, e.killed]))}`
  );
  // The record says what bounded it, rather than leaving a reader to infer it from the declaration.
  assert.equal(r.limits.executionDeadlineMs, 2_000);

  // ⚠️ NOT asserted as `destroyed`. Killing a command leaves the workspace momentarily locked on
  // Windows, and the controller reports `retained` rather than pretending otherwise — condition 4,
  // arriving here as a side effect of the subject under test. The deadline is what this test is
  // about, so it insists only that the destroy attempt was recorded and observed.
  assert.ok(["destroyed", "retained"].includes(r.destroy.outcome), r.destroy.outcome);
  // Whether the directory comes back is not what this test asserts, and the tidying up is no longer
  // written here: `run` registered any retained path with the reaper, which sweeps after every
  // assertion in the file has been evaluated.
});
