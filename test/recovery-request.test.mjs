/**
 * The session recovery request - #178.
 *
 * The extension inside Pi asks; the supervisor decides. What has to hold for the file between them: it is written
 * only in a supervised run, it carries a fixed reason and nothing else, it is read at most once, and a request from
 * another run is never acted on.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { MAX_AUTOMATIC_RECOVERIES, RECOVERY_REASON, RECOVERY_REQUEST_FILE, RECOVERY_TAKE, isAutomaticRecovery, requestRecovery, takeRecoveryRequest } from "../lib/recovery-request.mjs";
import { createRuntimeValidators } from "../lib/runtime-records.mjs";

const RUN = "0123456789abcdef0123456789abcdef";
const OTHER_RUN = "fedcba9876543210fedcba9876543210";
const validators = createRuntimeValidators();

/** A project with a runtime directory and no repository, so nothing there is tracked. */
function project({ runtime = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), "kiln-recovery-"));
  if (runtime) mkdirSync(join(root, ".pi", "runtime"), { recursive: true });
  return { root, runtimeDir: join(root, ".pi", "runtime"), path: join(root, ".pi", "runtime", RECOVERY_REQUEST_FILE), env: { KILN_RUN_ID: RUN, KILN_PROJECT_ROOT: root, KILN_STATE_MODE: "project" } };
}

test("⚠️ a request is written only in a supervised run, and holds a run id, a fixed reason and a time", async () => {
  const p = project();
  try {
    assert.deepEqual(await requestRecovery(RECOVERY_REASON.INPUT_EXCEEDS, { env: p.env, now: () => new Date("2026-10-06T12:00:00.000Z") }), { written: true });
    assert.deepEqual(JSON.parse(readFileSync(p.path, "utf-8")), { recordVersion: 1, runId: RUN, reason: "input-exceeds-context-window", requestedAt: "2026-10-06T12:00:00.000Z" });
    const text = readFileSync(p.path, "utf-8");
    assert.ok(!text.includes(p.root) && !text.includes(homedir()), "the request names a path");
    assert.ok(Buffer.byteLength(text) < 300, "the request is not bounded");

    // No supervisor, no request: nothing would read it.
    for (const env of [{ ...p.env, KILN_RUN_ID: undefined }, { ...p.env, KILN_RUN_ID: "not-a-run-id" }, { ...p.env, KILN_PROJECT_ROOT: undefined }, {}]) {
      rmSync(p.path, { force: true });
      assert.deepEqual(await requestRecovery(RECOVERY_REASON.COMPACTION_FAILED, { env }), { written: false, code: "recovery-not-supervised" });
      assert.equal(existsSync(p.path), false);
    }
    // A reason outside the list is not written, whatever it says.
    assert.deepEqual(await requestRecovery(`delete ${homedir()}`, { env: p.env }), { written: false, code: "recovery-reason-unknown" });
    assert.equal(existsSync(p.path), false);
  } finally {
    rmSync(p.root, { recursive: true, force: true });
  }
});

test("a request that cannot be kept is reported with a code, and never thrown", async () => {
  const none = project({ runtime: false });
  const p = project();
  try {
    assert.deepEqual(await requestRecovery(RECOVERY_REASON.COMPACTION_FAILED, { env: none.env }), { written: false, code: "recovery-state-unavailable" });
    const failing = async () => {
      throw new Error(`EACCES: ${homedir()}`);
    };
    assert.deepEqual(await requestRecovery(RECOVERY_REASON.COMPACTION_FAILED, { env: p.env, writeFile: failing }), { written: false, code: "recovery-request-unwritable" });
  } finally {
    rmSync(none.root, { recursive: true, force: true });
    rmSync(p.root, { recursive: true, force: true });
  }
});

test("⚠️ a request is consumed once, by the run it names", async () => {
  const p = project();
  try {
    assert.deepEqual(takeRecoveryRequest({ runtimeDir: p.runtimeDir, runId: RUN, validators }), { state: RECOVERY_TAKE.NONE });
    await requestRecovery(RECOVERY_REASON.OPERATOR_NEW_SESSION, { env: p.env });
    assert.deepEqual(takeRecoveryRequest({ runtimeDir: p.runtimeDir, runId: RUN, validators }), { state: RECOVERY_TAKE.ACCEPTED, reason: "operator-new-session" });
    assert.equal(existsSync(p.path), false, "the request survived being read");
    assert.deepEqual(takeRecoveryRequest({ runtimeDir: p.runtimeDir, runId: RUN, validators }), { state: RECOVERY_TAKE.NONE }, "it was read twice");
  } finally {
    rmSync(p.root, { recursive: true, force: true });
  }
});

test("⚠️ a stale or malformed request is removed and never acted on", async () => {
  const p = project();
  try {
    // Another run's request: well-formed, and not this run's.
    await requestRecovery(RECOVERY_REASON.INPUT_EXCEEDS, { env: { ...p.env, KILN_RUN_ID: OTHER_RUN } });
    assert.deepEqual(takeRecoveryRequest({ runtimeDir: p.runtimeDir, runId: RUN, validators }), { state: RECOVERY_TAKE.STALE });
    assert.equal(existsSync(p.path), false);

    const good = { recordVersion: 1, runId: RUN, reason: "compaction-failed", requestedAt: "2026-10-06T12:00:00.000Z" };
    const malformed = [
      "{ not json",
      JSON.stringify({ ...good, reason: "start-over" }),
      JSON.stringify({ ...good, runId: "../../elsewhere" }),
      JSON.stringify({ ...good, path: join(homedir(), "x") }),
      JSON.stringify({ ...good, error: "ENOENT: no such file" }),
      JSON.stringify({ ...good, recordVersion: 2 }),
      JSON.stringify({ ...good, note: "x".repeat(4_000) }),
    ];
    for (const text of malformed) {
      writeFileSync(p.path, text);
      assert.deepEqual(takeRecoveryRequest({ runtimeDir: p.runtimeDir, runId: RUN, validators }), { state: RECOVERY_TAKE.INVALID }, text.slice(0, 60));
      assert.equal(existsSync(p.path), false, "a malformed request was left to be read again");
    }
  } finally {
    rmSync(p.root, { recursive: true, force: true });
  }
});

test("the operator's request is not an automatic recovery, the three failures are, and one is allowed per launch", () => {
  assert.equal(isAutomaticRecovery(RECOVERY_REASON.OPERATOR_NEW_SESSION), false);
  for (const reason of [RECOVERY_REASON.COMPACTION_FAILED, RECOVERY_REASON.BOUNDARY_INVALID, RECOVERY_REASON.INPUT_EXCEEDS]) assert.equal(isAutomaticRecovery(reason), true, reason);
  assert.equal(isAutomaticRecovery("anything-else"), false);
  assert.equal(MAX_AUTOMATIC_RECOVERIES, 1);
});
