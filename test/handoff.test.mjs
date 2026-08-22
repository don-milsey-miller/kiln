/**
 * `npm run handoff` — CMP-0011, against the PM's acceptance bar.
 *
 * ⚠️ **The decisive test is the negative one, and it runs against the REAL project**: this repo lints
 * clean and must still be refused, because stage 5's `requirements-traced-to-components` is attested
 * `not-satisfied`. Every other test here uses a complete fixture; that one uses the dogfood project,
 * because a publish gate that has only ever been shown succeeding has not been shown to gate.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, readdirSync, existsSync, statSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { publishHandoff, HandoffRefused, swapIntoPlace, validatePackage } from "../lib/handoff/publish.mjs";
import { handoffCompleteness, BLOCKED } from "../lib/handoff/completeness.mjs";
import { canonicalJson } from "../lib/handoff/render.mjs";
import { loadSchemaSet } from "../lib/schema-resolver.mjs";
import { createValidators } from "../lib/validate.mjs";
import { readActivatedTypes } from "../lib/activation.mjs";
import { loadStageDefinitions } from "../lib/stages.mjs";
import { withLock } from "../lib/lock.mjs";
import { LOCK_FILE } from "../lib/tools/create-artifact.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const schemas = loadSchemaSet(join(ROOT, "schemas"));
const validators = createValidators(join(ROOT, "schemas"));

const env = (id, type, extra) => ({ id, type, schemaVersion: 2, reviewStatus: "approved", lifecycle: "active", title: id, ...extra });

/** A content root that is genuinely COMPLETE: every declared exit criterion attested. */
function completeFixture() {
  const base = mkdtempSync(join(tmpdir(), "vpw-ho-"));
  const contentRoot = join(base, "planning-content");
  mkdirSync(join(contentRoot, "data", "requirements"), { recursive: true });
  mkdirSync(join(contentRoot, "data", "components"), { recursive: true });
  mkdirSync(join(contentRoot, "stages"), { recursive: true });
  writeFileSync(join(contentRoot, "project.yaml"), "capabilities:\n  artifactTypes:\n    activated: [requirement, component]\n");

  writeFileSync(
    join(contentRoot, "data", "requirements", "REQ-0001.json"),
    canonicalJson(env("REQ-0001", "requirement", { statement: "The thing must work.", priority: "must" }))
  );
  writeFileSync(
    join(contentRoot, "data", "components", "CMP-0001.json"),
    canonicalJson(env("CMP-0001", "component", { responsibility: "Makes the thing work.", satisfies: ["REQ-0001"], implementedBy: ["lib/thing.mjs"] }))
  );
  // ⚠️ An artifact of a type this project has NOT activated. Without it, removing the renderer's
  // exclusion guard changed nothing and the deactivated-types test was vacuous — which falsification
  // found, because the guard could be deleted with every test still green.
  mkdirSync(join(contentRoot, "data", "decisions"), { recursive: true });
  writeFileSync(
    join(contentRoot, "data", "decisions", "DEC-0001.json"),
    canonicalJson(env("DEC-0001", "decision", { statement: "Not activated here.", rationale: "r", decidedAt: "2026-01-01", alternatives: [] }))
  );
  writeFileSync(join(contentRoot, "stages", "01-intake.md"), "# Stage 1\n\nNarrative.\n");

  // Attest every criterion the real stage set declares, so completeness turns on nothing else.
  const defs = loadStageDefinitions(ROOT);
  mkdirSync(join(contentRoot, "state", "stage-attestations"), { recursive: true });
  for (const def of Object.values(defs)) {
    const criteria = def.exitCriteria ?? [];
    if (!criteria.length) continue;
    const attestations = {};
    for (const c of criteria) attestations[c.id] = { result: "n/a", decidedBy: "fixture", reason: "not applicable to this fixture" };
    writeFileSync(join(contentRoot, "state", "stage-attestations", `${def.id}.json`), canonicalJson({ stageId: def.id, attestations }));
  }

  const ctx = { contentRoot, schemas, validators, activated: readActivatedTypes(contentRoot) };
  return { base, contentRoot, ctx, outDir: join(base, "docs", "plan") };
}

const listFiles = (root, base = root) =>
  readdirSync(root).flatMap((e) => {
    const p = join(root, e);
    return statSync(p).isDirectory() ? listFiles(p, base) : [relative(base, p).replace(/\\/g, "/")];
  });

const publish = (f, extra = {}) => publishHandoff(f.ctx, { outDir: f.outDir, toolRoot: ROOT, toolVersion: "1.2.3", ...extra });

/* ------------------------------------------------ the decisive negative control: the real project */

test("the REAL project is refused, despite a clean lint", () => {
  // ⚠️ This is the test the whole gate exists for. planning-content lints clean today, and stage 5's
  // third criterion is attested not-satisfied — so artifact validity says yes and completeness says no.
  const contentRoot = join(ROOT, "planning-content");
  const ctx = { contentRoot, schemas, validators, activated: readActivatedTypes(contentRoot) };
  const c = handoffCompleteness(ctx, { toolRoot: ROOT });

  assert.equal(c.ready, false, "a clean lint must not be enough to publish");
  const notSatisfied = c.blockers.filter((b) => b.reason === BLOCKED.NOT_SATISFIED);
  assert.ok(
    notSatisfied.some((b) => b.stageId === "05-solution-design" && b.criterion === "requirements-traced-to-components"),
    "stage 5's not-satisfied criterion must be a blocker"
  );
  // ...and the lint itself has nothing to say, which is exactly the gap this predicate closes.
  assert.equal(c.blockers.filter((b) => b.reason === BLOCKED.LINT).length, 0);
});

/* ------------------------------------------------------------------- the fixture path: publishing */

test("a complete project publishes, with only the approved surfaces", async () => {
  const f = completeFixture();
  try {
    const r = await publish(f);
    assert.equal(r.published, true);
    const files = listFiles(f.outDir).sort();

    assert.deepEqual(files, [
      "MANIFEST.json", "PLAN.md", "README.md",
      "data/components.json", "data/requirements.json", "docs/01-intake.md",
    ]);
    // ⚠️ DEC-0010 and DEC-0011, checked rather than assumed: no site, no aggregate runbook, no slices.
    assert.equal(files.some((f) => f.startsWith("site/")), false, "DEC-0010: no site");
    assert.equal(files.includes("data/runbooks.json"), false, "DEC-0011: no aggregate runbook");
    assert.equal(files.some((f) => /role|slice/i.test(f)), false, "role slices wait for stage 8");
  } finally {
    rmSync(f.base, { recursive: true, force: true });
  }
});

test("a deactivated type is ABSENT, not an empty file", async () => {
  const f = completeFixture();
  try {
    await publish(f);
    // `assertion` is not activated in the fixture. An empty assertions.json would imply the question
    // was asked and the answer was "none"; absence says the type does not apply here.
    assert.equal(existsSync(join(f.outDir, "data", "decisions.json")), false, "a DEC-0001 exists and decision is not activated");
    assert.equal(existsSync(join(f.outDir, "data", "assertions.json")), false);
  } finally {
    rmSync(f.base, { recursive: true, force: true });
  }
});

test("two runs over identical input are byte-identical", async () => {
  const f = completeFixture();
  try {
    const first = await publish(f);
    const snapshotFiles = listFiles(f.outDir).sort().map((p) => [p, readFileSync(join(f.outDir, p), "utf-8")]);
    const second = await publish(f);
    assert.equal(second.snapshot, first.snapshot, "the snapshot identity must not move");
    for (const [p, content] of snapshotFiles)
      assert.equal(readFileSync(join(f.outDir, p), "utf-8"), content, `${p} changed between identical runs`);
  } finally {
    rmSync(f.base, { recursive: true, force: true });
  }
});

test("the package carries an identity and no wall-clock time", async () => {
  const f = completeFixture();
  try {
    const r = await publish(f);
    const manifest = JSON.parse(readFileSync(join(f.outDir, "MANIFEST.json"), "utf-8"));
    assert.match(manifest.snapshot, /^[0-9a-f]{16}$/);
    assert.equal(manifest.toolVersion, "1.2.3");
    assert.equal(manifest.snapshot, r.snapshot);
    // ⚠️ A timestamp would make two identical plans look different, which is the opposite of what a
    // version identifier is for. Checked on the GENERATED files only — artifacts carry authored dates.
    for (const p of ["MANIFEST.json", "README.md"]) {
      const text = readFileSync(join(f.outDir, p), "utf-8");
      assert.equal(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(text), false, `${p} contains a timestamp`);
    }
  } finally {
    rmSync(f.base, { recursive: true, force: true });
  }
});

test("removed source material does not survive as a stale file", async () => {
  const f = completeFixture();
  try {
    await publish(f);
    assert.ok(readFileSync(join(f.outDir, "data", "components.json"), "utf-8").includes("CMP-0001"));

    rmSync(join(f.contentRoot, "data", "components", "CMP-0001.json"));
    // The component is gone, so the requirement it satisfied is now an orphan — but the fixture's
    // criteria are all n/a, so completeness still passes and the package must simply lose the file.
    await publish(f);
    const components = readFileSync(join(f.outDir, "data", "components.json"), "utf-8");
    assert.equal(components.includes("CMP-0001"), false, "a deleted artifact must not survive in the package");
    // ⚠️ The file is PRESENT and empty, not absent. An activated type with no artifacts is a
    // different fact from a type that does not apply here, and the package must not collapse them.
    assert.deepEqual(JSON.parse(components), []);
  } finally {
    rmSync(f.base, { recursive: true, force: true });
  }
});

/* --------------------------------------------------------- refusal and failure preserve the past */

test("a refusal writes nothing and leaves the previous package byte-identical", async () => {
  const f = completeFixture();
  try {
    await publish(f);
    const before = listFiles(f.outDir).sort().map((p) => [p, readFileSync(join(f.outDir, p), "utf-8")]);

    // Make it incomplete: one criterion attested not-satisfied.
    const path = join(f.contentRoot, "state", "stage-attestations", "05-solution-design.json");
    const doc = JSON.parse(readFileSync(path, "utf-8"));
    doc.attestations["data-model-approved"] = { result: "not-satisfied", decidedBy: "test", reason: "deliberately blocked" };
    writeFileSync(path, canonicalJson(doc));

    await assert.rejects(() => publish(f), HandoffRefused);

    const after = listFiles(f.outDir).sort().map((p) => [p, readFileSync(join(f.outDir, p), "utf-8")]);
    assert.deepEqual(after, before, "the previous package must survive a refusal untouched");
  } finally {
    rmSync(f.base, { recursive: true, force: true });
  }
});

test("a rendering failure also leaves the previous package intact, and leaves no temp behind", async () => {
  const f = completeFixture();
  try {
    await publish(f);
    const before = listFiles(f.outDir).sort().map((p) => [p, readFileSync(join(f.outDir, p), "utf-8")]);

    await assert.rejects(
      () => publish(f, { render: () => { throw new Error("renderer exploded"); } }),
      /renderer exploded/
    );

    assert.deepEqual(listFiles(f.outDir).sort().map((p) => [p, readFileSync(join(f.outDir, p), "utf-8")]), before);
    const leftovers = readdirSync(join(f.base, "docs")).filter((e) => e.startsWith(".handoff-tmp-") || e.includes(".previous-"));
    assert.deepEqual(leftovers, [], "no temporary or backup directory may survive");
  } finally {
    rmSync(f.base, { recursive: true, force: true });
  }
});

test("completeness is evaluated by publish itself, not accepted from the caller", async () => {
  const f = completeFixture();
  try {
    // ⚠️ There is no parameter through which a caller can assert readiness — the only way to publish
    // is to BE ready when publish looks. Passing a stale verdict is impossible by construction, which
    // is stronger than checking a freshness flag.
    const path = join(f.contentRoot, "state", "stage-attestations", "05-solution-design.json");
    const doc = JSON.parse(readFileSync(path, "utf-8"));
    doc.attestations["data-model-approved"] = { result: "not-satisfied", decidedBy: "test", reason: "blocked" };
    writeFileSync(path, canonicalJson(doc));

    await assert.rejects(() => publish(f, { ready: true, completeness: { ready: true } }), HandoffRefused);
  } finally {
    rmSync(f.base, { recursive: true, force: true });
  }
});

test("publishing takes the content lock, so a concurrent writer cannot land mid-snapshot", async () => {
  const f = completeFixture();
  try {
    let publishFinished = false;
    const lockPath = join(f.contentRoot, LOCK_FILE);
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    // ⚠️ The lock is held on a signal this test controls. An earlier version awaited the publish
    // promise from INSIDE the lock, which deadlocked until the 10s acquisition timeout — the lock
    // could not be released until publish finished, and publish could not start until it was.
    let release;
    const signal = new Promise((r) => { release = r; });
    const held = withLock(lockPath, () => signal);
    await sleep(150); // let the lock be acquired

    const running = publish(f).then(() => { publishFinished = true; });
    await sleep(400);
    // The gate evaluation and the input snapshot must happen under the SAME lock. If publish did not
    // take it, it would have finished by now — the fixture publishes in milliseconds.
    assert.equal(publishFinished, false, "publish must WAIT for the content lock");

    release();
    await held;
    await running;
    assert.equal(publishFinished, true, "and must complete once the lock is free");
  } finally {
    rmSync(f.base, { recursive: true, force: true });
  }
});

/* ---------------------------------------------------------------------- the predicate's own rules */

test("`n/a` passes and an unattested criterion blocks", () => {
  const f = completeFixture();
  try {
    assert.equal(handoffCompleteness(f.ctx, { toolRoot: ROOT }).ready, true, "all n/a is complete: someone looked");

    rmSync(join(f.contentRoot, "state", "stage-attestations", "01-intake.json"));
    const c = handoffCompleteness(f.ctx, { toolRoot: ROOT });
    assert.equal(c.ready, false);
    assert.ok(c.blockers.every((b) => b.reason === BLOCKED.PENDING));
    assert.match(c.blockers[0].detail, /Nobody has looked/);
  } finally {
    rmSync(f.base, { recursive: true, force: true });
  }
});

test("an absent stage definition set fails closed", () => {
  const f = completeFixture();
  try {
    const bare = mkdtempSync(join(tmpdir(), "vpw-bare-"));
    const c = handoffCompleteness(f.ctx, { toolRoot: bare });
    assert.equal(c.ready, false);
    assert.equal(c.blockers[0].reason, BLOCKED.NO_DEFINITIONS);
    rmSync(bare, { recursive: true, force: true });
  } finally {
    rmSync(f.base, { recursive: true, force: true });
  }
});

/* ------------------------------------------- gaps found by falsification, closed with real tests */

test("canonicalJson sorts keys, so the package is canonical and not merely repeatable", () => {
  // ⚠️ Reversing the key order still produced identical output on two runs, so the determinism test
  // could not see it. Repeatable and canonical are different properties: the first survives any
  // stable order, the second is what makes two different machines agree on the same bytes.
  // ⚠️ Three keys, not two. `{b, a}` was the first fixture and it was useless: its REVERSE is also
  // sorted, so an implementation that reversed instead of sorting passed. A two-element case cannot
  // distinguish sorting from reversing, and falsification is what showed it.
  assert.equal(canonicalJson({ c: 1, a: 2, b: 3 }), ['{', '  "a": 2,', '  "b": 3,', '  "c": 1', "}", ""].join("\n"));
  const nested = JSON.parse(canonicalJson([{ z: 1, y: { d: 1, c: 2, e: 3 } }]));
  assert.deepEqual(Object.keys(nested[0]), ["y", "z"]);
  assert.deepEqual(Object.keys(nested[0].y), ["c", "d", "e"]);
});

test("a swap that fails halfway restores the previous package", () => {
  // ⚠️ This branch had never run. Nothing could make the first rename succeed and the second fail,
  // so "put it back exactly as it was" was a comment rather than a behaviour.
  const base = mkdtempSync(join(tmpdir(), "vpw-swap-"));
  try {
    const outDir = join(base, "plan");
    const temp = join(base, "temp");
    mkdirSync(outDir);
    mkdirSync(temp);
    writeFileSync(join(outDir, "old.txt"), "previous package");

    const moves = [];
    const rename = (from, to) => {
      moves.push([from, to]);
      if (moves.length === 2) throw Object.assign(new Error("swap failed"), { code: "EPERM" });
      renameSync(from, to);
    };
    assert.throws(() => swapIntoPlace(temp, outDir, rename), /swap failed/);

    assert.equal(moves.length, 3, "the failed move must be followed by a restore");
    assert.equal(existsSync(outDir), true, "the previous package must be back");
    assert.equal(readFileSync(join(outDir, "old.txt"), "utf-8"), "previous package");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("validatePackage reads the DISK, so a corrupted write is caught", () => {
  // ⚠️ Disabling the validation call broke no test: nothing made the on-disk package differ from what
  // was rendered. Checking the validator directly gives that guard something to prove.
  const base = mkdtempSync(join(tmpdir(), "vpw-val-"));
  try {
    const files = new Map([["a.json", '{"x":1}\n'], ["b.md", "hello\n"]]);
    for (const [rel, content] of files) writeFileSync(join(base, rel), content);
    assert.deepEqual(validatePackage(base, files), [], "a faithful package has no problems");

    writeFileSync(join(base, "a.json"), '{"x":1'); // truncated mid-write
    const truncated = validatePackage(base, files);
    assert.ok(truncated.some((p) => /a\.json differs/.test(p)));
    assert.ok(truncated.some((p) => /a\.json is not valid JSON/.test(p)));

    writeFileSync(join(base, "a.json"), '{"x":1}\n');
    writeFileSync(join(base, "extra.txt"), "not expected");
    assert.ok(validatePackage(base, files).some((p) => /unexpected files/.test(p)), "a stray file is a problem");

    rmSync(join(base, "b.md"));
    assert.ok(validatePackage(base, files).some((p) => /b\.md was not written/.test(p)));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("publish itself refuses when the written package differs from what was rendered", async () => {
  const f = completeFixture();
  try {
    await publish(f);
    const before = listFiles(f.outDir).sort().map((p) => [p, readFileSync(join(f.outDir, p), "utf-8")]);

    // ⚠️ A REAL collision rather than a stub: two paths differing only in case. On a case-insensitive
    // filesystem the second write overwrites the first, so the first file's content no longer matches
    // what was rendered — and the validator is the only thing standing between that and a published
    // package that silently lost a file. No new seam was needed to reach it.
    const collide = (input) => {
      const files = new Map();
      files.set("data/Requirements.json", '["first"]\n');
      files.set("data/requirements.json", '["second"]\n');
      files.set("MANIFEST.json", '{"snapshot":"deadbeefdeadbeef"}\n');
      return files;
    };

    await assert.rejects(() => publish(f, { render: collide }), (e) => {
      assert.ok(e instanceof HandoffRefused, `expected a refusal, got ${e}`);
      assert.match(e.message, /failed validation/);
      return true;
    });

    assert.deepEqual(
      listFiles(f.outDir).sort().map((p) => [p, readFileSync(join(f.outDir, p), "utf-8")]),
      before,
      "a package that failed validation must never replace the previous one"
    );
  } finally {
    rmSync(f.base, { recursive: true, force: true });
  }
});
