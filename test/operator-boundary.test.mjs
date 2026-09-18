/**
 * The operator-boundary audit file — TSK-0050 (S6), toward ACC-0070.
 *
 * ⚠️ **THE HOSTILE INPUT HERE IS THE TARGET, AND IT IS SILENTLY DROPPED RATHER THAN ESCAPED.** A refused
 * attempt carries whatever arguments the model sent. None of them may reach the file: not a path, not a
 * sentence, not a credential. What the file keeps is that an attempt happened, which identifiers it
 * named, and that authorisation was not granted.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  BOUNDARY_OPERATION,
  BOUNDARY_RECORD_REFUSAL,
  BOUNDARY_REFUSAL_CODE,
  BOUNDARY_STATE,
  BoundaryRecordError,
  FILE_VERSION,
  MAX_REFUSALS,
  OPERATOR_ACTOR,
  OPERATOR_BOUNDARY_FILE,
  cleanTarget,
  operatorBoundaryPath,
  readBoundaryRefusals,
  recordBoundaryRefusal,
} from "../lib/operator-boundary.mjs";
import { withLock } from "../lib/lock.mjs";
import { LOCK_FILE } from "../lib/tools/create-artifact.mjs";

const SECRET = "sk-ant-api03-OPERATORBOUNDARYPLANTED00000";

function project() {
  const base = mkdtempSync(join(tmpdir(), "kiln-boundary-"));
  const contentRoot = join(base, "planning-content");
  mkdirSync(join(contentRoot, "state"), { recursive: true });
  return { base, contentRoot, path: join(contentRoot, OPERATOR_BOUNDARY_FILE) };
}

const read = (path) => JSON.parse(readFileSync(path, "utf8"));

const attest = (extra = {}) => ({
  operation: BOUNDARY_OPERATION.ATTEST_STAGE,
  target: { stageId: "01-intake", criterion: "request-understood" },
  ...extra,
});

// --------------------------------------------------------------------------------- the record itself

test("a refusal is recorded with the operation, the code and the validated target", async () => {
  const fx = project();
  try {
    const written = await recordBoundaryRefusal(fx.contentRoot, attest({ now: "2026-09-18T10:00:00.000Z" }));
    assert.deepEqual(written, {
      occurredAt: "2026-09-18T10:00:00.000Z",
      operation: "write-stage-attestation",
      code: BOUNDARY_REFUSAL_CODE,
      target: { stageId: "01-intake", criterion: "request-understood" },
    });

    const file = read(fx.path);
    assert.equal(file.version, FILE_VERSION);
    assert.deepEqual(file.refusals, [written]);
  } finally {
    rmSync(fx.base, { recursive: true, force: true });
  }
});

test("every refusal carries one code, whatever refused it", async () => {
  const fx = project();
  try {
    for (const operation of Object.values(BOUNDARY_OPERATION))
      await recordBoundaryRefusal(fx.contentRoot, { operation, target: {} });
    const codes = new Set(read(fx.path).refusals.map((r) => r.code));
    assert.deepEqual([...codes], [BOUNDARY_REFUSAL_CODE], "no second code may claim a distinction Pi does not expose");
  } finally {
    rmSync(fx.base, { recursive: true, force: true });
  }
});

test("an unknown operation is a defect and is never written down", async () => {
  const fx = project();
  try {
    await assert.rejects(
      () => recordBoundaryRefusal(fx.contentRoot, { operation: "delete-everything", target: {} }),
      (e) => e instanceof TypeError && /Unknown operator-boundary operation/.test(e.message)
    );
    assert.equal(readBoundaryRefusals(fx.contentRoot).state, BOUNDARY_STATE.ABSENT);
  } finally {
    rmSync(fx.base, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------------------------ what may enter a target

test("a target field that does not match its pattern is dropped, not stored and not escaped", async () => {
  const fx = project();
  try {
    await recordBoundaryRefusal(fx.contentRoot, {
      operation: BOUNDARY_OPERATION.SET_TYPE_ACTIVATION,
      target: {
        type: "component",
        action: "activate",
        // Every one of these is a shape the patterns refuse.
        stageId: "D:\\visual-project-workflow\\planning-content",
        criterion: "Because the operator said so, honestly",
        artifactId: "../../etc/passwd",
        artifactType: SECRET,
      },
    });

    const [entry] = read(fx.path).refusals;
    assert.deepEqual(entry.target, { type: "component", action: "activate" });

    const text = readFileSync(fx.path, "utf8");
    for (const needle of [SECRET, "visual-project-workflow", "passwd", "honestly", "\\", "/etc"])
      assert.ok(!text.includes(needle), `the audit file must not contain ${JSON.stringify(needle)}`);
  } finally {
    rmSync(fx.base, { recursive: true, force: true });
  }
});

test("an unknown target key cannot be written even when it looks like an identifier", async () => {
  const fx = project();
  try {
    await recordBoundaryRefusal(fx.contentRoot, {
      operation: BOUNDARY_OPERATION.SET_REVIEW_STATUS,
      target: { artifactType: "task", artifactId: "TSK-0050", reason: "approved-by-me", decidedBy: "the-operator" },
    });
    assert.deepEqual(Object.keys(read(fx.path).refusals[0].target).sort(), ["artifactId", "artifactType"]);
  } finally {
    rmSync(fx.base, { recursive: true, force: true });
  }
});

test("cleanTarget refuses a long value, a non-string and a non-object", () => {
  assert.deepEqual(cleanTarget({ criterion: "c".repeat(65) }), {}, "65 characters is past the blunt bound");
  assert.deepEqual(cleanTarget({ criterion: "c".repeat(64) }), { criterion: "c".repeat(64) });
  assert.deepEqual(cleanTarget({ criterion: 12, action: true, type: null }), {});
  for (const value of [null, undefined, "activate", 7, ["type"]]) assert.deepEqual(cleanTarget(value), {});
});

test("a refusal with nothing recordable is still a refusal", async () => {
  const fx = project();
  try {
    const written = await recordBoundaryRefusal(fx.contentRoot, { operation: BOUNDARY_OPERATION.ATTEST_STAGE, target: { stageId: "Stage One" } });
    assert.deepEqual(written.target, {});
    assert.equal(readBoundaryRefusals(fx.contentRoot).total, 1);
  } finally {
    rmSync(fx.base, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------------------------------------- the bound

test("the file keeps the newest 100 refusals and drops the oldest", async () => {
  const fx = project();
  try {
    // ⚠️ PINNED TO THE LITERAL. Everything below is written in terms of `MAX_REFUSALS`, so without this
    // line the test moves with the constant and a widened bound passes unnoticed.
    assert.equal(MAX_REFUSALS, 100, "the bound is 100 entries; widening it is a decision, not a refactor");

    for (let n = 0; n < MAX_REFUSALS + 5; n += 1)
      await recordBoundaryRefusal(fx.contentRoot, attest({ now: `2026-09-18T10:${String(n % 60).padStart(2, "0")}:00.000Z`, target: { criterion: `c${n}` } }));

    const { state, total, refusals } = readBoundaryRefusals(fx.contentRoot);
    assert.equal(state, BOUNDARY_STATE.RECORDED);
    assert.equal(total, MAX_REFUSALS);
    assert.equal(refusals.length, MAX_REFUSALS);
    assert.equal(refusals[0].target.criterion, "c5", "the five oldest are gone");
    assert.equal(refusals.at(-1).target.criterion, `c${MAX_REFUSALS + 4}`, "the newest is kept");
  } finally {
    rmSync(fx.base, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------------------------------- the four states

test("an absent file, an empty list and a written list are three states, not one", async () => {
  const fx = project();
  try {
    assert.deepEqual(readBoundaryRefusals(fx.contentRoot), { state: BOUNDARY_STATE.ABSENT, total: 0, refusals: [] });

    writeFileSync(fx.path, JSON.stringify({ version: FILE_VERSION, refusals: [] }, null, 2) + "\n");
    assert.deepEqual(readBoundaryRefusals(fx.contentRoot), { state: BOUNDARY_STATE.EMPTY, total: 0, refusals: [] });

    await recordBoundaryRefusal(fx.contentRoot, attest());
    assert.equal(readBoundaryRefusals(fx.contentRoot).state, BOUNDARY_STATE.RECORDED);
  } finally {
    rmSync(fx.base, { recursive: true, force: true });
  }
});

test("a file this module could not have written reads as invalid", () => {
  const fx = project();
  const good = { occurredAt: "2026-09-18T10:00:00.000Z", operation: "set-review-status", code: BOUNDARY_REFUSAL_CODE, target: { artifactId: "TSK-0050" } };
  const cases = [
    ["not JSON at all", "{{{"],
    ["an array envelope", JSON.stringify([good])],
    ["a future version", JSON.stringify({ version: FILE_VERSION + 1, refusals: [] })],
    ["refusals that are not a list", JSON.stringify({ version: FILE_VERSION, refusals: { 0: good } })],
    ["more entries than the bound", JSON.stringify({ version: FILE_VERSION, refusals: Array.from({ length: MAX_REFUSALS + 1 }, () => good) })],
    ["an invented code", JSON.stringify({ version: FILE_VERSION, refusals: [{ ...good, code: "operator-said-no" }] })],
    ["an invented operation", JSON.stringify({ version: FILE_VERSION, refusals: [{ ...good, operation: "publish-everything" }] })],
    ["an extra field on an entry", JSON.stringify({ version: FILE_VERSION, refusals: [{ ...good, reason: "because" }] })],
    ["a target that was never cleaned", JSON.stringify({ version: FILE_VERSION, refusals: [{ ...good, target: { artifactId: "TSK-0050", note: "see D:/somewhere" } }] })],
    ["a timestamp that is not an instant", JSON.stringify({ version: FILE_VERSION, refusals: [{ ...good, occurredAt: "yesterday" }] })],
  ];
  try {
    for (const [why, text] of cases) {
      writeFileSync(fx.path, text);
      assert.deepEqual(readBoundaryRefusals(fx.contentRoot), { state: BOUNDARY_STATE.INVALID, total: 0, refusals: [] }, why);
    }
  } finally {
    rmSync(fx.base, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------- D37: the record may fail, the refusal stands

test("an invalid file is refused rather than replaced, and its bytes survive", async () => {
  const fx = project();
  try {
    writeFileSync(fx.path, "{ this is not the file we wrote }");
    const before = readFileSync(fx.path);
    const beforeStat = statSync(fx.path);

    await assert.rejects(
      () => recordBoundaryRefusal(fx.contentRoot, attest()),
      (e) => e instanceof BoundaryRecordError && e.code === BOUNDARY_RECORD_REFUSAL.UNREADABLE
    );

    assert.deepEqual(readFileSync(fx.path), before, "an audit file is never silently overwritten");
    assert.equal(statSync(fx.path).mtimeMs, beforeStat.mtimeMs);
  } finally {
    rmSync(fx.base, { recursive: true, force: true });
  }
});

test("a storage failure raises the typed error and keeps the cause out of its message", async () => {
  // ⚠️ A FILE WHERE `state/` BELONGS. The audit file is then absent rather than unreadable, so the read
  // succeeds and it is the WRITE that cannot happen — which is the path this test exists for. Making the
  // audit file itself a directory would exercise the reader instead, and does: that is the test above.
  const base = mkdtempSync(join(tmpdir(), "kiln-boundary-"));
  const contentRoot = join(base, "planning-content");
  mkdirSync(contentRoot, { recursive: true });
  writeFileSync(join(contentRoot, "state"), "not a directory\n");
  try {
    const error = await recordBoundaryRefusal(contentRoot, attest()).then(
      () => null,
      (e) => e
    );
    assert.ok(error instanceof BoundaryRecordError, `expected a BoundaryRecordError, got ${error?.name}: ${error?.message}`);
    assert.equal(error.code, BOUNDARY_RECORD_REFUSAL.UNWRITABLE);
    assert.equal(error.message, BOUNDARY_RECORD_REFUSAL.UNWRITABLE, "the message is the code, never the filesystem's sentence");
    assert.ok(!error.message.includes(contentRoot), "no absolute path may reach the message");
    assert.ok(error.cause, "the cause is kept for a developer");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("a lock that cannot be acquired is the same typed refusal, not a raw LockError", async () => {
  const fx = project();
  try {
    // ⚠️ THE SAME PROCESS ALREADY HOLDS IT. `withLock` refuses a nested acquisition of a lock this async
    // context holds, and refuses it immediately, so this proves the conversion without waiting out a
    // real acquisition timeout.
    const error = await withLock(join(fx.contentRoot, LOCK_FILE), async () =>
      recordBoundaryRefusal(fx.contentRoot, attest()).then(
        () => null,
        (e) => e
      )
    );

    assert.ok(error instanceof BoundaryRecordError, `expected a BoundaryRecordError, got ${error?.name}: ${error?.message}`);
    assert.equal(error.code, BOUNDARY_RECORD_REFUSAL.UNWRITABLE);
    assert.equal(error.message, BOUNDARY_RECORD_REFUSAL.UNWRITABLE);
    assert.ok(!error.message.includes(fx.contentRoot), "the lock's absolute path may not reach the message");
    assert.equal(error.cause?.name, "LockError", "the lock's own error is kept as the cause");
    assert.equal(readBoundaryRefusals(fx.contentRoot).state, BOUNDARY_STATE.ABSENT, "nothing was written");
  } finally {
    rmSync(fx.base, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------------------------------- shared-state care

test("refusals recorded together are all kept", async () => {
  const fx = project();
  try {
    await Promise.all(
      Array.from({ length: 8 }, (_, n) => recordBoundaryRefusal(fx.contentRoot, attest({ target: { criterion: `c${n}` } })))
    );
    const { total, refusals } = readBoundaryRefusals(fx.contentRoot);
    assert.equal(total, 8, "the lock is what makes a concurrent append safe");
    assert.deepEqual(refusals.map((r) => r.target.criterion).sort(), ["c0", "c1", "c2", "c3", "c4", "c5", "c6", "c7"]);
  } finally {
    rmSync(fx.base, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------------------------------------- the actor

test("the actor is Kiln's own constant and names no person", () => {
  assert.equal(OPERATOR_ACTOR, "operator via Pi UI");
  assert.ok(!/[A-Z]{3}-\d/.test(OPERATOR_ACTOR));
});

test("the file sits under state/, beside the attestations it guards", () => {
  assert.equal(OPERATOR_BOUNDARY_FILE, join("state", "operator-boundary-refusals.json"));
  assert.equal(operatorBoundaryPath("/tmp/root"), join("/tmp/root", "state", "operator-boundary-refusals.json"));
  assert.throws(() => operatorBoundaryPath(""), TypeError);
});
