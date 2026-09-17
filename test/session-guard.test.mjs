/**
 * The one-time guard file: created exclusively, read once without following links, and removed on every path —
 * ACC-0103, F128. Every case uses its own temporary runtime directory.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { GUARD_ENV, GUARD_PROBLEM, createGuardFile, takeGuardFile } from "../lib/session-guard.mjs";

const EXPECTED = { sessionId: "7f3a1c2e-0000-4000-8000-000000000001", file: "/state/sessions/x.jsonl", digest: "ab".repeat(32) };
const fixedBytes = (n) => Buffer.alloc(n, 0x5a);
const NAME = `session-guard-${"5a".repeat(16)}.json`;

function runtime() {
  const root = mkdtempSync(join(tmpdir(), "kiln-guard-"));
  const dir = join(root, "runtime");
  mkdirSync(dir);
  return { root, dir, done: () => rmSync(root, { recursive: true, force: true }) };
}

/**
 * Symbolic links need a privilege on Windows; a case that cannot make one says so rather than passing. A
 * directory link uses a junction there, which needs none.
 */
function trySymlink(target, path, t, type) {
  try {
    symlinkSync(target, path, type);
    return true;
  } catch (e) {
    if (e?.code === "EPERM" || e?.code === "EACCES") {
      t.skip(`cannot create a symbolic link here (${e.code})`);
      return false;
    }
    throw e;
  }
}

test("⚠️ the guard file is created exclusively, owner-only, and removed once", () => {
  const r = runtime();
  try {
    const g = createGuardFile({ runtimeDir: r.dir, expected: EXPECTED, randomBytes: fixedBytes });
    assert.equal(g.ok, true);
    assert.equal(g.path, join(r.dir, NAME));
    assert.deepEqual(JSON.parse(readFileSync(g.path, "utf-8")), { guardVersion: 1, ...EXPECTED });
    if (process.platform !== "win32") assert.equal(statSync(g.path).mode & 0o777, 0o600, "owner read and write only");

    assert.equal(g.remove(), "removed");
    assert.equal(existsSync(g.path), false);
    assert.equal(g.remove(), "already-removed", "idempotent, for the several paths that all clean up");
  } finally {
    r.done();
  }
});

test("⚠️ an existing file at the name is a refusal, never overwritten", () => {
  const r = runtime();
  try {
    writeFileSync(join(r.dir, NAME), "someone else's");
    const g = createGuardFile({ runtimeDir: r.dir, expected: EXPECTED, randomBytes: fixedBytes });
    assert.equal(g.ok, false);
    assert.equal(g.problem, GUARD_PROBLEM.EXISTS);
    assert.equal(readFileSync(join(r.dir, NAME), "utf-8"), "someone else's", "untouched");
  } finally {
    r.done();
  }
});

test("⚠️ a link at the name is a refusal, never something written through", (t) => {
  const r = runtime();
  try {
    const target = join(r.root, "target.txt");
    writeFileSync(target, "the link's target");
    if (!trySymlink(target, join(r.dir, NAME), t)) return;
    const h = createGuardFile({ runtimeDir: r.dir, expected: EXPECTED, randomBytes: fixedBytes });
    assert.equal(h.ok, false);
    assert.equal(readFileSync(target, "utf-8"), "the link's target", "nothing was written through the link");
  } finally {
    r.done();
  }
});

test("⚠️ a runtime directory that is missing or a file is refused", () => {
  const r = runtime();
  try {
    assert.equal(createGuardFile({ runtimeDir: join(r.root, "absent"), expected: EXPECTED, randomBytes: fixedBytes }).problem, GUARD_PROBLEM.NO_RUNTIME_DIR);
    const file = join(r.root, "file");
    writeFileSync(file, "");
    assert.equal(createGuardFile({ runtimeDir: file, expected: EXPECTED, randomBytes: fixedBytes }).problem, GUARD_PROBLEM.NO_RUNTIME_DIR);
  } finally {
    r.done();
  }
});

test("⚠️ a runtime directory that is a link is refused", (t) => {
  const r = runtime();
  try {
    const link = join(r.root, "link");
    if (!trySymlink(r.dir, link, t, "junction")) return;
    assert.equal(createGuardFile({ runtimeDir: link, expected: EXPECTED, randomBytes: fixedBytes }).problem, GUARD_PROBLEM.NO_RUNTIME_DIR);
  } finally {
    r.done();
  }
});

test("⚠️ the guard takes the expectation once: the variable goes, the file goes, the values arrive", () => {
  const r = runtime();
  try {
    const g = createGuardFile({ runtimeDir: r.dir, expected: EXPECTED, randomBytes: fixedBytes });
    const env = { [GUARD_ENV]: g.path, OTHER: "kept" };
    const took = takeGuardFile(env);
    assert.deepEqual(took, { ok: true, expected: EXPECTED });
    assert.equal(GUARD_ENV in env, false, "no process started afterwards inherits the path");
    assert.equal(env.OTHER, "kept");
    assert.equal(existsSync(g.path), false, "read once, then gone");
    assert.equal(g.remove(), "absent", "and the supervisor's cleanup finds nothing left to do");

    const again = { [GUARD_ENV]: g.path };
    assert.equal(takeGuardFile(again).ok, false, "a second read has nothing to take");
    assert.equal(GUARD_ENV in again, false);
    assert.equal(takeGuardFile({}).problem, GUARD_PROBLEM.NOT_NAMED);
  } finally {
    r.done();
  }
});

test("⚠️ a guard file that is invalid or oversized fails, and is still removed", () => {
  const r = runtime();
  try {
    const invalid = join(r.dir, "invalid.json");
    writeFileSync(invalid, "{ not json");
    const env1 = { [GUARD_ENV]: invalid };
    assert.equal(takeGuardFile(env1).problem, GUARD_PROBLEM.INVALID);
    assert.equal(existsSync(invalid), false);
    assert.equal(GUARD_ENV in env1, false);

    const wrongShape = join(r.dir, "shape.json");
    writeFileSync(wrongShape, JSON.stringify({ guardVersion: 1, ...EXPECTED, digest: "not-a-digest" }));
    assert.equal(takeGuardFile({ [GUARD_ENV]: wrongShape }).problem, GUARD_PROBLEM.INVALID);
    assert.equal(existsSync(wrongShape), false);

    const big = join(r.dir, "big.json");
    writeFileSync(big, "x".repeat(64 * 1024));
    assert.equal(takeGuardFile({ [GUARD_ENV]: big }).problem, GUARD_PROBLEM.CHANGED);
    assert.equal(existsSync(big), false);
  } finally {
    r.done();
  }
});

test("⚠️ a guard file that is a link is not read, and its target is not deleted", (t) => {
  const r = runtime();
  try {
    const target = join(r.root, "target.json");
    writeFileSync(target, JSON.stringify({ guardVersion: 1, ...EXPECTED }));
    const link = join(r.dir, "link.json");
    if (!trySymlink(target, link, t)) return;
    assert.equal(takeGuardFile({ [GUARD_ENV]: link }).problem, GUARD_PROBLEM.NOT_A_FILE);
    assert.equal(existsSync(target), true, "the link's target is neither read as a guard nor deleted");
  } finally {
    r.done();
  }
});

test("⚠️ cleanup never deletes a file that replaced the guard file at the same name", () => {
  const r = runtime();
  try {
    const g = createGuardFile({ runtimeDir: r.dir, expected: EXPECTED, randomBytes: fixedBytes });
    unlinkSync(g.path);
    writeFileSync(g.path, "a different file, now at the same name");
    assert.equal(g.remove(), "replaced");
    assert.equal(readFileSync(g.path, "utf-8"), "a different file, now at the same name");
  } finally {
    r.done();
  }
});
