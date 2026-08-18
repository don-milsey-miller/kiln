import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

import { createRequirement, ArtifactExistsError, LOCK_FILE, artifactPath } from "../lib/tools/create-requirement.mjs";
import { readHighWaterMarks, counterPath, AllocationError } from "../lib/id-allocator.mjs";
import { ValidationError, createValidators } from "../lib/validate.mjs";
import { withLock, LockError } from "../lib/lock.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCHEMAS = join(ROOT, "schemas");
const validators = createValidators(SCHEMAS);

function freshContentRoot() {
  const base = mkdtempSync(join(tmpdir(), "vpw-write-"));
  const contentRoot = join(base, "planning-content");
  mkdirSync(contentRoot, { recursive: true });
  return { base, contentRoot };
}

const OPTS = (contentRoot) => ({ contentRoot, schemasDir: SCHEMAS, validators });
const GOOD = { title: "Nightly replication", statement: "The system must replicate the customer table nightly." };
const marksOf = (r) => readHighWaterMarks(r).REQ ?? 0;

test("happy path: creates the artifact, consumes exactly one ID, and it validates", async () => {
  const { base, contentRoot } = freshContentRoot();
  try {
    const before = marksOf(contentRoot);
    const { id, path, artifact } = await createRequirement(GOOD, OPTS(contentRoot));

    assert.equal(id, "REQ-0001");
    assert.equal(marksOf(contentRoot), before + 1, "should consume exactly one ID");

    const onDisk = JSON.parse(readFileSync(join(contentRoot, path), "utf-8"));
    assert.deepEqual(onDisk, artifact);
    assert.equal(onDisk.reviewStatus, "draft");
    assert.equal(onDisk.lifecycle, "active");
    assert.ok(validators.requirement(onDisk), "the artifact the tool wrote must itself validate");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("malformed caller input consumes no ID and writes nothing", async () => {
  const { base, contentRoot } = freshContentRoot();
  try {
    const bad = [
      {},                                              // no statement
      { ...GOOD, statement: "" },                      // empty statement
      { ...GOOD, priority: { na: true } },             // n/a without a reason (#45)
      { ...GOOD, derivedFrom: "REQ-0002" },            // trace link not an array
      { ...GOOD, verifiedBy: ["XXX-0001"] },           // unknown ID prefix
      { ...GOOD, owner: "someone" },                   // unknown property
      { ...GOOD, id: "REQ-9999" },                     // caller cannot supply tool-owned fields
      { ...GOOD, lifecycle: "retired" },
      null, "a string", ["an array"],
    ];
    for (const input of bad) {
      await assert.rejects(() => createRequirement(input, OPTS(contentRoot)), ValidationError, `accepted ${JSON.stringify(input)}`);
    }
    assert.equal(marksOf(contentRoot), 0, "no ID should have been consumed");
    assert.ok(!existsSync(join(contentRoot, "data")), "nothing should have been written");
    assert.ok(!existsSync(join(contentRoot, LOCK_FILE)), "lock must not be left behind");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("failure AFTER allocation leaves a gap and never reuses the ID (#83)", async () => {
  const { base, contentRoot } = freshContentRoot();
  try {
    await createRequirement(GOOD, OPTS(contentRoot)); // REQ-0001

    // Make the write fail after the ID is allocated: a directory where the file must go.
    mkdirSync(join(contentRoot, artifactPath("REQ-0002")), { recursive: true });
    await assert.rejects(() => createRequirement(GOOD, OPTS(contentRoot)));

    assert.equal(marksOf(contentRoot), 2, "the counter stays consumed — no rollback (#83)");

    rmSync(join(contentRoot, artifactPath("REQ-0002")), { recursive: true, force: true });
    const next = await createRequirement(GOOD, OPTS(contentRoot));
    assert.equal(next.id, "REQ-0003", "must skip the burnt number rather than reuse it");
    assert.ok(!existsSync(join(contentRoot, LOCK_FILE)), "lock released on the throwing path");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("a pre-existing destination is never overwritten, even when the allocator says the ID is new", async () => {
  const { base, contentRoot } = freshContentRoot();
  try {
    await createRequirement(GOOD, OPTS(contentRoot)); // REQ-0001
    const dest = join(contentRoot, artifactPath("REQ-0001"));
    const original = readFileSync(dest, "utf-8");

    // Abnormal state: the high-water mark reverted behind the content.
    writeFileSync(counterPath(contentRoot), JSON.stringify({ REQ: 0 }, null, 2) + "\n");

    await assert.rejects(() => createRequirement(GOOD, OPTS(contentRoot)), ArtifactExistsError);
    assert.equal(readFileSync(dest, "utf-8"), original, "existing artifact must be untouched");
    assert.ok(!existsSync(join(contentRoot, LOCK_FILE)), "lock released");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("a corrupt counter refuses to allocate rather than guessing", async () => {
  const { base, contentRoot } = freshContentRoot();
  try {
    writeFileSync(counterPath(contentRoot), "{ not json");
    await assert.rejects(() => createRequirement(GOOD, OPTS(contentRoot)), AllocationError);
    writeFileSync(counterPath(contentRoot), JSON.stringify({ REQ: -3 }));
    await assert.rejects(() => createRequirement(GOOD, OPTS(contentRoot)), AllocationError);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("concurrent creates in SEPARATE PROCESSES receive different IDs (#78 + #83)", async () => {
  const { base, contentRoot } = freshContentRoot();
  try {
    const N = 6;
    const script = join(base, "one.mjs");
    // On Windows an absolute path in an ESM import must be a file:// URL.
    const toolUrl = pathToFileURL(join(ROOT, "lib", "tools", "create-requirement.mjs")).href;
    writeFileSync(
      script,
      `import { createRequirement } from ${JSON.stringify(toolUrl)};\n` +
        `const r = await createRequirement({ title: "t", statement: "s" }, ` +
        `{ contentRoot: ${JSON.stringify(contentRoot)}, schemasDir: ${JSON.stringify(SCHEMAS)} });\n` +
        `process.stdout.write(r.id);\n`
    );

    // execFile, NOT execFileSync: a synchronous spawn inside Promise.all runs the children
    // one after another, which would pass this test without ever exercising contention.
    const run = promisify(execFile);
    const results = await Promise.all(Array.from({ length: N }, () => run(process.execPath, [script])));
    const ids = results.map((r) => r.stdout.trim());

    assert.equal(new Set(ids).size, N, `IDs collided: ${ids.join(", ")}`);
    assert.equal(marksOf(contentRoot), N);
    assert.equal(readdirSync(join(contentRoot, "data", "requirements")).length, N);
    assert.ok(!existsSync(join(contentRoot, LOCK_FILE)), "lock released by every process");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("#72: a failed rename leaves the previous file intact and no temp behind", async () => {
  const { base, contentRoot } = freshContentRoot();
  try {
    const first = await createRequirement(GOOD, OPTS(contentRoot));
    const dest = join(contentRoot, first.path);
    const original = readFileSync(dest, "utf-8");

    // A directory at the destination makes rename fail for REQ-0002 while REQ-0001 stands.
    mkdirSync(join(contentRoot, artifactPath("REQ-0002")), { recursive: true });
    await assert.rejects(() => createRequirement(GOOD, OPTS(contentRoot)));

    assert.equal(readFileSync(dest, "utf-8"), original, "unrelated artifact must be untouched");
    const strays = readdirSync(join(contentRoot, "data", "requirements")).filter((f) => f.includes("vpw-tmp"));
    assert.deepEqual(strays, [], `temp files left behind: ${strays.join(", ")}`);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("#78: the lock is released when the guarded function throws", async () => {
  const { base, contentRoot } = freshContentRoot();
  const lockPath = join(contentRoot, LOCK_FILE);
  try {
    await assert.rejects(() => withLock(lockPath, () => { throw new Error("boom"); }), /boom/);
    assert.ok(!existsSync(lockPath), "lock left behind after a throw");
    await withLock(lockPath, () => {}); // and it can be taken again
    assert.ok(!existsSync(lockPath));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("#78: a held lock blocks and then times out rather than proceeding", async () => {
  const { base, contentRoot } = freshContentRoot();
  const lockPath = join(contentRoot, LOCK_FILE);
  try {
    let inner;
    await withLock(lockPath, async () => {
      inner = await assert.rejects(
        () => withLock(lockPath, () => "should not run", { maxWaitMs: 60, retryMs: 5, staleMs: 10_000 }),
        LockError
      );
    });
    assert.ok(!existsSync(lockPath));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("#78: a stale lock owned by a dead process is broken, a live one is not", async () => {
  const { base, contentRoot } = freshContentRoot();
  const lockPath = join(contentRoot, LOCK_FILE);
  try {
    // Dead owner: a pid that cannot exist, with an old mtime forced by staleMs: 0.
    writeFileSync(lockPath, JSON.stringify({ pid: 2 ** 30, hostname: (await import("node:os")).hostname(), acquiredAt: "2020-01-01T00:00:00Z" }));
    const got = await withLock(lockPath, () => "broke it", { staleMs: 0, maxWaitMs: 500 });
    assert.equal(got, "broke it");

    // Live owner: this very process. Must NOT be broken.
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, hostname: (await import("node:os")).hostname(), acquiredAt: "2020-01-01T00:00:00Z" }));
    await assert.rejects(() => withLock(lockPath, () => "nope", { staleMs: 0, maxWaitMs: 100 }), LockError);
    rmSync(lockPath, { force: true });
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("#70: the tool refuses a content root that does not exist", async () => {
  await assert.rejects(
    () => createRequirement(GOOD, { schemasDir: SCHEMAS, validators, env: { PLANNING_CONTENT_DIR: join(tmpdir(), "vpw-nope-never") } }),
    /No planning content root/
  );
});
