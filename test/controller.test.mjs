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

import { runJob, destroyWorkspace, allowlistedEnv } from "../lib/validation/controller.mjs";
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
  const ws = mkdtempSync(join(tmpdir(), "vpw-forced-"));
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
  const ws = mkdtempSync(join(tmpdir(), "vpw-forced2-"));
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
  const r = await runJob(JOB({ tier: 3 }));
  assert.equal(r.ok, false);
  assert.equal(r.phase, "refused");
  assert.equal(r.destroy.outcome, "nothing-to-destroy");
  assert.match(r.destroy.reason, /no workspace was created/i);
});

test("a provisioning failure records the phase, destroys, and captures nothing dishonestly", async () => {
  const r = await runJob(JOB(), { python: "definitely-not-a-real-interpreter" });
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
  const r = await runJob(JOB({ commands: [["{python}", "-c", "import sys; sys.exit(3)"]] }));
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
    const r = await runJob(JOB({ commands: [["{python}", "-c", "print(1)"]] }), { baseDir: base });
    assert.equal(r.destroy.outcome, "destroyed");
    const { readdirSync } = await import("node:fs");
    assert.deepEqual(readdirSync(base), [], "the workspace must really be gone, not merely reported gone");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

/* -------------------------------- 5, 6, 7: the real path, and fixture B becoming authoritative */

test("the real controller emits all four omission states, with reasons", async () => {
  const r = await runJob(JOB(), { hostEnv: { ...process.env, TAVILY_API_KEY: "tvly-not-a-real-key" } });

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
