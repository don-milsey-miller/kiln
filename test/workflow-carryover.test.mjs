/**
 * What a replaced session hands to the one that replaces it - #178.
 *
 * The record is small and its rules are few. The leaving session writes it, only in a supervised run. The
 * supervisor binds it to the session it recorded in its place. Only that session is told what it says, in the
 * same launch or a later one, until it has answered once. How the extension fills it and words it is covered in
 * `test/pi-package-decision-bundle.test.mjs`.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { CARRYOVER_FILE, CARRYOVER_PENDING_MAX, bindCarryover, clearCarryover, discardUnboundCarryover, readCarryover, writeCarryover } from "../lib/workflow-carryover.mjs";

const RUN = "0123456789abcdef0123456789abcdef";
const OTHER_RUN = "fedcba9876543210fedcba9876543210";
const SESSION = "22222222-2222-4222-8222-222222222222";
const OTHER_SESSION = "33333333-3333-4333-8333-333333333333";
const CREATED = "2026-10-06T12:00:00.000Z";
const NOW = () => new Date(CREATED);
const LAST = { index: 6, kind: "write-stage-note", target: "stage:04-requirement-gaps", status: "completed" };
const PENDING = { source: "assistant-message", text: "Shall I record CSV export as the decision?" };

/** A project with a runtime directory and no repository, so nothing there is tracked. */
function project({ runtime = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), "kiln-carryover-"));
  const runtimeDir = join(root, ".pi", "runtime");
  if (runtime) mkdirSync(runtimeDir, { recursive: true });
  return { root, runtimeDir, path: join(runtimeDir, CARRYOVER_FILE), env: { KILN_RUN_ID: RUN, KILN_PROJECT_ROOT: root, KILN_STATE_MODE: "project" } };
}
const onDisk = (p) => (existsSync(p.path) ? JSON.parse(readFileSync(p.path, "utf-8")) : null);

test("⚠️ a carry-over is written unbound, bound by the supervisor to the replacement session, and told to that session only", async () => {
  const p = project();
  try {
    assert.deepEqual(await writeCarryover({ reason: "operator-new-session", pending: PENDING, lastOperation: LAST }, { env: p.env, now: NOW }), { written: true });
    const written = { recordVersion: 1, runId: RUN, reason: "operator-new-session", createdAt: CREATED, pending: PENDING, lastOperation: LAST };
    assert.deepEqual(onDisk(p), written);
    assert.ok(!readFileSync(p.path, "utf-8").includes(p.root) && !readFileSync(p.path, "utf-8").includes(homedir()), "the record names a path");

    // ⚠️ UNBOUND, IT IS TOLD TO NOBODY.
    assert.equal(readCarryover({ sessionId: SESSION, env: p.env }), null);
    assert.equal(readCarryover({ env: p.env }), null);
    assert.deepEqual(onDisk(p), written, "an unbound record was removed by a read");

    assert.deepEqual(await bindCarryover({ runtimeDir: p.runtimeDir, runId: RUN, sessionId: SESSION }), { bound: true });
    const bound = { ...written, sessionId: SESSION };
    assert.deepEqual(onDisk(p), bound);
    // The session it is bound to reads it, as often as it asks. No other session does, and asking removes nothing.
    assert.deepEqual(readCarryover({ sessionId: SESSION, env: p.env }), bound);
    assert.deepEqual(readCarryover({ sessionId: SESSION, env: p.env }), bound);
    assert.equal(readCarryover({ sessionId: OTHER_SESSION, env: p.env }), null);
    assert.equal(clearCarryover({ sessionId: OTHER_SESSION, env: p.env }), false);
    assert.deepEqual(onDisk(p), bound);

    // ⚠️ A LATER LAUNCH KEEPS IT. Another run's supervisor starts, another run's agent resumes the session, and the
    // record is still that session's.
    assert.equal(discardUnboundCarryover({ runtimeDir: p.runtimeDir }), false);
    assert.deepEqual(readCarryover({ sessionId: SESSION, env: { ...p.env, KILN_RUN_ID: OTHER_RUN } }), bound);
    // A second bind does not move it to another session.
    assert.deepEqual(await bindCarryover({ runtimeDir: p.runtimeDir, runId: RUN, sessionId: OTHER_SESSION }), { bound: false });
    assert.deepEqual(onDisk(p), bound);

    // Removed once the session has answered, and only then.
    assert.equal(clearCarryover({ sessionId: SESSION, env: p.env }), true);
    assert.equal(onDisk(p), null);
  } finally {
    rmSync(p.root, { recursive: true, force: true });
  }
});

test("⚠️ a carry-over no supervisor bound is never bound by a later run, and is removed when the next launch starts", async () => {
  const p = project();
  try {
    // Another run's supervisor does not bind it: the session it would name did not replace the writer.
    await writeCarryover({ reason: "operator-new-session", pending: PENDING }, { env: p.env });
    assert.deepEqual(await bindCarryover({ runtimeDir: p.runtimeDir, runId: OTHER_RUN, sessionId: SESSION }), { bound: false });
    assert.equal(onDisk(p), null);

    await writeCarryover({ reason: "operator-new-session", pending: PENDING }, { env: p.env });
    assert.equal(discardUnboundCarryover({ runtimeDir: p.runtimeDir }), true);
    assert.equal(onDisk(p), null);
    assert.equal(discardUnboundCarryover({ runtimeDir: p.runtimeDir }), false);

    // A bind that cannot be written leaves nothing unbound behind.
    await writeCarryover({ reason: "operator-new-session", pending: PENDING }, { env: p.env });
    const failing = async () => {
      throw new Error(`EACCES: ${homedir()}`);
    };
    assert.deepEqual(await bindCarryover({ runtimeDir: p.runtimeDir, runId: RUN, sessionId: SESSION, writeFile: failing }), { bound: false });
    assert.equal(onDisk(p), null);
    // A session id that is not one is not written.
    await writeCarryover({ reason: "operator-new-session", pending: PENDING }, { env: p.env });
    assert.deepEqual(await bindCarryover({ runtimeDir: p.runtimeDir, runId: RUN, sessionId: join(homedir(), "x") }), { bound: false });
    assert.equal(onDisk(p), null);
    assert.deepEqual(await bindCarryover({ runtimeDir: p.runtimeDir, runId: RUN, sessionId: SESSION }), { bound: false });
  } finally {
    rmSync(p.root, { recursive: true, force: true });
  }
});

test("⚠️ the pending text is bounded, and a record outside the schema is never written", async () => {
  const p = project();
  try {
    const long = "word ".repeat(4_000);
    assert.deepEqual(await writeCarryover({ reason: "compaction-failed", pending: { source: "assistant-message", text: long } }, { env: p.env }), { written: true });
    assert.equal(onDisk(p).pending.text, long.slice(0, CARRYOVER_PENDING_MAX));
    // Nothing pending is a record without the field, not an empty one.
    assert.deepEqual(await writeCarryover({ reason: "compaction-failed", pending: { source: "assistant-message", text: "" } }, { env: p.env }), { written: true });
    assert.deepEqual(Object.keys(onDisk(p)).sort(), ["createdAt", "reason", "recordVersion", "runId"]);

    rmSync(p.path);
    for (const carry of [
      { reason: `delete ${homedir()}` },
      { reason: "operator-new-session", pending: { source: "operator-input", text: "x" } },
      // An operation is identifiers and a status: its arguments, and anything free-form, are refused.
      { reason: "operator-new-session", lastOperation: { ...LAST, args: { statement: "approved wording" } } },
      { reason: "operator-new-session", lastOperation: { ...LAST, target: join(homedir(), "notes.md") } },
      { reason: "operator-new-session", lastOperation: { ...LAST, status: "approved" } },
      { reason: "operator-new-session", lastOperation: { ...LAST, code: `ENOENT: ${homedir()}` } },
    ]) {
      assert.deepEqual(await writeCarryover(carry, { env: p.env }), { written: false, code: "carryover-invalid" }, JSON.stringify(carry));
      assert.equal(existsSync(p.path), false);
    }
    // No supervisor: nothing is written.
    for (const env of [{ ...p.env, KILN_RUN_ID: undefined }, { ...p.env, KILN_RUN_ID: "not-a-run-id" }, { ...p.env, KILN_PROJECT_ROOT: undefined }, {}]) {
      assert.deepEqual(await writeCarryover({ reason: "operator-new-session" }, { env }), { written: false, code: "carryover-not-supervised" });
      assert.equal(existsSync(p.path), false);
    }
  } finally {
    rmSync(p.root, { recursive: true, force: true });
  }
});

test("a carry-over that cannot be kept is reported with a code, and one that is not a record is removed unread", async () => {
  const none = project({ runtime: false });
  const p = project();
  try {
    assert.deepEqual(await writeCarryover({ reason: "operator-new-session" }, { env: none.env }), { written: false, code: "carryover-state-unavailable" });
    const failing = async () => {
      throw new Error(`EACCES: ${homedir()}`);
    };
    assert.deepEqual(await writeCarryover({ reason: "operator-new-session" }, { env: p.env, writeFile: failing }), { written: false, code: "carryover-unwritable" });

    const valid = { recordVersion: 1, runId: RUN, sessionId: SESSION, reason: "operator-new-session", createdAt: CREATED };
    const invalid = [
      "{ not json",
      JSON.stringify({ ...valid, approved: true }),
      JSON.stringify({ ...valid, sessionId: "../elsewhere" }),
      JSON.stringify({ ...valid, pending: { source: "assistant-message", text: "x".repeat(CARRYOVER_PENDING_MAX + 1) } }),
      JSON.stringify({ ...valid, pad: "x".repeat(40_000) }),
    ];
    for (const text of invalid) {
      writeFileSync(p.path, text);
      assert.equal(readCarryover({ sessionId: SESSION, env: p.env }), null, text.slice(0, 60));
      assert.equal(existsSync(p.path), false, "a record that is not valid was left in place");
      writeFileSync(p.path, text);
      assert.equal(discardUnboundCarryover({ runtimeDir: p.runtimeDir }), true);
      writeFileSync(p.path, text);
      assert.deepEqual(await bindCarryover({ runtimeDir: p.runtimeDir, runId: RUN, sessionId: SESSION }), { bound: false });
      assert.equal(existsSync(p.path), false);
    }
  } finally {
    rmSync(none.root, { recursive: true, force: true });
    rmSync(p.root, { recursive: true, force: true });
  }
});
