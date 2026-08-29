/**
 * `npm run handoff` — CMP-0011, against the PM's acceptance bar.
 *
 * ⚠️ **The real project was the negative control until 2026-08-22, and then it passed.** It refused
 * for as long as something real was missing — first eleven unattested criteria, then stage 5's
 * traceability, then stage 9's role slices — and it publishes now because `task` and
 * `acceptance-criterion` were built and the slices exist. **The negative controls did not go away
 * with it**: the refusal, render-failure and validation-failure paths are all exercised against
 * fixtures below, because a publish gate only ever shown succeeding has not been shown to gate.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, readdirSync, existsSync, statSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { publishHandoff, HandoffRefused, swapIntoPlace, validatePackage } from "../lib/handoff/publish.mjs";
import { handoffCompleteness, BLOCKED } from "../lib/handoff/completeness.mjs";
import { canonicalJson, roleSlices, slugify, taskStatus, renderPlanMarkdown, renderPackage, verifySnapshot, hashFiles, SNAPSHOT_PLACEHOLDER } from "../lib/handoff/render.mjs";
import { loadSchemaSet } from "../lib/schema-resolver.mjs";
import { createValidators } from "../lib/validate.mjs";
import { readActivatedTypes } from "../lib/activation.mjs";
import { loadStageDefinitions } from "../lib/stages.mjs";
import { evaluateStageGate } from "../lib/lint.mjs";
import { loadStageAttestations } from "../lib/attestations.mjs";
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
  mkdirSync(join(contentRoot, "data", "evidences"), { recursive: true });
  mkdirSync(join(contentRoot, "stages"), { recursive: true });
  // ⚠️ `evidence` is activated and NO stage produces it. That combination is load-bearing here: it is
  // the only way to reach "an activated type with zero artifacts" now that the handoff composes every
  // stage gate — for a type a stage DOES produce, zero artifacts is a gate failure rather than a
  // rendering case. See the stale-file test below.
  writeFileSync(join(contentRoot, "project.yaml"), "capabilities:\n  artifactTypes:\n    activated: [requirement, component, evidence]\n");

  writeFileSync(
    join(contentRoot, "data", "requirements", "REQ-0001.json"),
    canonicalJson(env("REQ-0001", "requirement", { statement: "The thing must work.", priority: "must" }))
  );
  writeFileSync(
    join(contentRoot, "data", "components", "CMP-0001.json"),
    canonicalJson(env("CMP-0001", "component", { responsibility: "Makes the thing work.", satisfies: ["REQ-0001"], implementedBy: ["lib/thing.mjs"] }))
  );
  writeFileSync(
    join(contentRoot, "data", "evidences", "EVD-0001.json"),
    canonicalJson(env("EVD-0001", "evidence", {
      kind: "experiment", summary: "It worked.", outcome: "success", observedAt: "2026-01-01",
      environment: { execution: "host", facts: { os: "fixture" } },
    }))
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

test("the REAL project's handoff verdict IS the conjunction of its stage gates", () => {
  // ⚠️ THIS TEST HAS FLIPPED POLARITY FOUR TIMES — refuse, refuse, refuse, publish, refuse — and the
  // fourth flip is why it no longer ENCODES a polarity. Each flip was a real movement of the project:
  // eleven unattested criteria, then stage 5's traceability, then stage 9's slices; then the composed
  // gate exposed stage 3's capability gap; then that cleared by deactivating `research-finding`; and
  // now a second decomposition authored REQ-0016..REQ-0020, which trace to no component because stage
  // 5 has not run for the application shell.
  //
  // So the ASSERTION is the invariant — the handoff is ready exactly when no stage is failing, and it
  // names every stage that is — and the project's current state is one line of data below it, which is
  // what a future flip edits. A test whose structure encodes today's answer has to be rewritten every
  // time the plan moves, and a test rewritten that often stops being read.
  const contentRoot = join(ROOT, "planning-content");
  const ctx = { contentRoot, schemas, validators, activated: readActivatedTypes(contentRoot) };
  const c = handoffCompleteness(ctx, { toolRoot: ROOT });

  const defs = loadStageDefinitions(ROOT);
  const gates = Object.values(defs).map((d) =>
    evaluateStageGate(ctx, d.id, { attestations: loadStageAttestations(contentRoot, d.id) })
  );
  const notReady = gates.filter((g) => !g.ready).map((g) => g.stageId);

  // ---- the invariant. This is what the original defect violated: `ready: true` while stage 3 was not.
  assert.equal(
    c.ready,
    notReady.length === 0,
    `handoff ready=${c.ready} but stages not ready: ${JSON.stringify(notReady)}`
  );
  for (const stageId of notReady)
    assert.ok(
      c.blockers.some((b) => b.stageId === stageId),
      `${stageId} is not ready and the handoff does not name it: ${JSON.stringify(c.blockers)}`
    );

  // ---- today's state. Deliberately compact, so a legitimate movement of the plan edits these lines
  // and nothing else. Five movements so far, and every one was caused by authoring work rather than
  // by a defect: stage 5 regressed on the application requirements and recovered on CMP-0012..0020,
  // stage 6 regressed on DEC-0018 and recovered on DEC-0019's validated read contract, and stage 8
  // regressed when TSK-0003..TSK-0014 arrived unjudged.
  assert.deepEqual(notReady, [], "every stage gate is ready; the plan is publishable");
  assert.deepEqual(c.blockers, [], JSON.stringify(c.blockers, null, 2));
  assert.equal(c.ready, true, "with no unready stage the handoff must be ready");

  // ⚠️ READY IS NOT THE SAME AS BUILT, and the package has to keep saying so — a publishable plan
  // that reads as a finished system is the QST-0015 hazard leaving the repository. Two checks,
  // because the two facts move at different rates.
  const read = (dir) =>
    readdirSync(join(contentRoot, "data", dir)).map((f) =>
      JSON.parse(readFileSync(join(contentRoot, "data", dir, f), "utf-8"))
    );
  const comps = read("components").filter((d) => Number(d.id.slice(4)) >= 12);
  assert.equal(comps.length, 9, "the nine application components");

  const shellIds = new Set(comps.map((d) => d.id));
  const withCode = new Set(comps.filter((d) => (d.implementedBy ?? []).length).map((d) => d.id));
  const shellCriteria = read("acceptance-criterions").filter((a) =>
    (a.evaluates ?? []).some((id) => shellIds.has(id))
  );
  assert.equal(shellCriteria.length, 25, "every run-2 criterion, plus ACC-0036 and ACC-0037");

  // INVARIANT 1: a criterion may only be `pass` if every component it evaluates has code. Accepted
  // work that nothing implements is the sharpest form of the QST-0015 hazard — it would put a tick
  // beside a component the package also reports as unimplemented.
  for (const a of shellCriteria.filter((x) => x.outcome === "pass"))
    for (const id of a.evaluates.filter((i) => shellIds.has(i)))
      assert.ok(withCode.has(id), `${a.id} passes but ${id} has no implementedBy`);

  // INVARIANT 2: a `fail` is never shipped QUIETLY — which is not the same as never shipped.
  //
  // ⚠️ THIS CHECK WAS REWRITTEN 2026-08-28, THE FIRST TIME IT FIRED, AND THAT IS THE INTERESTING
  // PART. It used to demand the failed list be empty, so the only ways past it were to flip the
  // outcome, delete the criterion, or add an exemption here — three different ways of erasing a
  // measurement, all of which would have looked like housekeeping in a diff. ACC-0020 failed, its
  // pre-committed fallback was disproved by the same measurement that triggered it, and none of the
  // three was the right answer.
  //
  // So the rule is now what it always meant: a failure may ship once it has been RESOLVED. Retired
  // rather than still standing, naming a successor that exists and is active, and addressed by a
  // decision that says what was concluded. Deleting the criterion still fails this — a missing
  // criterion is not a resolved one — and so does a successor that is itself unresolved.
  const decisions = read("decisions");
  const criteriaById = new Map(read("acceptance-criterions").map((a) => [a.id, a]));

  for (const a of shellCriteria.filter((x) => x.outcome === "fail")) {
    assert.notEqual(
      a.lifecycle,
      "active",
      `${a.id} is failed and still stands. A criterion that is active and failing is an obligation ` +
        `the package would ship as met.`
    );

    const successors = a.supersededBy ?? [];
    assert.ok(
      successors.length > 0,
      `${a.id} is failed and retired but names no successor. That is how a failed measurement ` +
        `becomes a gap nobody can see: the tick disappears and so does the obligation.`
    );

    for (const s of successors) {
      const next = criteriaById.get(s);
      assert.ok(next, `${a.id} names successor ${s}, which does not exist`);
      assert.equal(next.lifecycle, "active", `${a.id}'s successor ${s} does not itself stand`);
      assert.notEqual(
        next.outcome,
        "fail",
        `${a.id} was superseded by ${s}, which is ALSO failing — a chain of retirements is not a resolution`
      );
    }

    assert.ok(
      decisions.some((d) => (d.addresses ?? []).includes(a.id)),
      `${a.id} is failed and retired, and no decision addresses it. Someone has to have written down ` +
        `what was concluded; a supersession with no reasoning is a record of the outcome changing ` +
        `and not of anybody deciding anything.`
    );
  }

  // Today's state, kept explicit so a second failure is a visible edit rather than a silent pass
  // through the rule above.
  assert.deepEqual(
    shellCriteria.filter((a) => a.outcome === "fail").map((a) => a.id),
    ["ACC-0020"],
    "the failed criteria in the package — each one resolved by the rule above"
  );

  // Today's state — two lines to edit as implementation lands.
  assert.deepEqual([...withCode].sort(), ["CMP-0012", "CMP-0013", "CMP-0014", "CMP-0015", "CMP-0016", "CMP-0017", "CMP-0018", "CMP-0019", "CMP-0020"], "components with code");
  assert.deepEqual(
    shellCriteria.filter((a) => a.outcome === "pass").map((a) => a.id).sort(),
    [
      "ACC-0013",
      "ACC-0014",
      "ACC-0015",
      "ACC-0016",
      "ACC-0017",
      "ACC-0018",
      "ACC-0019",
      "ACC-0021",
      "ACC-0022",
      "ACC-0023",
      "ACC-0024",
      "ACC-0025",
      "ACC-0026",
      "ACC-0027",
      "ACC-0028",
      "ACC-0029",
      "ACC-0030",
      "ACC-0031",
      "ACC-0032",
      "ACC-0033",
      "ACC-0034",
      "ACC-0035",
      "ACC-0036",
      "ACC-0037",
    ],
    "criteria evaluated so far"
  );

  // ⚠️ Every refusal must carry the PM's REASON, not just a rule id. A gate that blocks without saying
  // why teaches people to route around it, which is how a gate stops being a gate. Vacuous while
  // nothing blocks -- kept because the next regression is what it exists for, and deleting a check
  // the moment it stops firing is how the check is missing when it matters.
  for (const b of c.blockers)
    assert.ok((b.detail ?? "").length > 120, `${b.stageId} blocks without a substantive reason: ${b.detail}`);

  // ---- and the refusal must be EARNED. A gate blocked because nobody had looked reports the same
  // boolean as one blocked by a recorded verdict, so: nothing here is merely unattested.
  const declared = Object.values(defs).flatMap((d) => (d.exitCriteria ?? []).map((x) => `${d.id}:${x.id}`));
  assert.ok(declared.length >= 12, "the stage set should still declare the criteria this is checking");
  assert.deepEqual(c.blockers.filter((b) => b.reason === BLOCKED.PENDING), [], "no criterion is merely unattested");

  // ⚠️ `research-finding` is DEACTIVATED, not implemented, so stage 3 produces nothing this project has
  // activated and its gate rests on two human attestations — deliberate, and recorded in project.yaml.
  // Asserting it here stops the empty intersection going silent (#107).
  assert.equal(ctx.activated.includes("research-finding"), false);
  assert.deepEqual(defs["03-discovery"].produces, ["research-finding"]);
  const attested = loadStageAttestations(contentRoot, "03-discovery");
  assert.deepEqual(Object.keys(attested).sort(), ["sources-reconciled", "unknowns-resolved"]);
  for (const a of Object.values(attested)) assert.equal(a.result, "satisfied");
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
      "data/components.json", "data/evidences.json", "data/requirements.json", "docs/01-intake.md",
    ]);
    // ⚠️ DEC-0010 and DEC-0011, checked rather than assumed: no site, no aggregate runbook, no slices.
    assert.equal(files.some((f) => f.startsWith("site/")), false, "DEC-0010: no site");
    assert.equal(files.includes("data/runbooks.json"), false, "DEC-0011: no aggregate runbook");
    assert.equal(files.some((f) => /role|slice/i.test(f)), false, "role slices wait for stage 8");
  } finally {
    rmSync(f.base, { recursive: true, force: true });
  }
});

test("a renderer that drops a stage document is REFUSED, and the check is wired in", async () => {
  // ⚠️ The set-equality check has its own unit tests; this is the one that proves it is actually
  // CALLED. Deleting the `stageDocSetProblems(...)` call in publishHandoff passes every test in
  // stage-docs-in-package.test.mjs, because those exercise the function directly.
  const f = completeFixture();
  try {
    const dropStageDocs = (input) => {
      const files = renderPackage(input);
      for (const k of [...files.keys()]) if (k.startsWith("docs/")) files.delete(k);
      return files;
    };
    await assert.rejects(() => publish(f, { render: dropStageDocs }), (e) => {
      assert.ok(e instanceof HandoffRefused, `expected a refusal, got ${e}`);
      assert.match(e.message, /01-intake\.md/, "the refusal names the document that went missing");
      return true;
    });
    assert.equal(existsSync(f.outDir), false, "and nothing was published");
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
    assert.ok(readFileSync(join(f.outDir, "data", "evidences.json"), "utf-8").includes("EVD-0001"));

    rmSync(join(f.contentRoot, "data", "evidences", "EVD-0001.json"));
    // ⚠️ The subject is `evidence` rather than `component` BECAUSE no stage produces evidence. This
    // test used to delete the fixture's only component and passed only because the handoff gate did
    // not compose stage 5. Deleting that component now leaves stage 05-solution-design producing an
    // activated type with no artifacts, which is a refusal and not a rendering question.
    await publish(f);
    const evidences = readFileSync(join(f.outDir, "data", "evidences.json"), "utf-8");
    assert.equal(evidences.includes("EVD-0001"), false, "a deleted artifact must not survive in the package");
    // ⚠️ The file is PRESENT and empty, not absent. An activated type with no artifacts is a
    // different fact from a type that does not apply here, and the package must not collapse them.
    assert.deepEqual(JSON.parse(evidences), []);
  } finally {
    rmSync(f.base, { recursive: true, force: true });
  }
});

test("deleting the last artifact of a type a STAGE produces is a refusal, not an empty file", () => {
  // ⚠️ The other half of the test above, and the reason it had to change. #46's handoff boundary now
  // composes every stage gate, so an activated, stage-produced type with nothing in it blocks the
  // publish rather than rendering as `[]`.
  const f = completeFixture();
  try {
    rmSync(join(f.contentRoot, "data", "components", "CMP-0001.json"));
    const c = handoffCompleteness(f.ctx, { toolRoot: ROOT });
    assert.equal(c.ready, false);
    const b = c.blockers.find((x) => x.ruleId === "gate/no-artifacts-for-stage-type");
    assert.ok(b, `expected a stage-gate blocker; got ${JSON.stringify(c.blockers)}`);
    assert.equal(b.stageId, "05-solution-design");
    assert.equal(b.reason, BLOCKED.STAGE_GATE);
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
    assert.match(c.blockers[0].detail, /has not been evaluated/);
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

/* ------------------------------------------------------ role slices: ACC-0010's actual evaluation */

const TASK = (id, role, over = {}) => env(id, "task", { statement: "do the thing", role, implements: ["CMP-0001"], fulfils: ["REQ-0001"], acceptedBy: ["ACC-0001"], dependsOn: [], ...over });

const sliceInput = () =>
  new Map([
    ["task", [TASK("TSK-0001", "backend"), TASK("TSK-0002", "frontend", { dependsOn: ["TSK-0001"] }), TASK("TSK-0003", "backend")]],
    ["requirement", [env("REQ-0001", "requirement", { statement: "must work", priority: "must" })]],
    ["acceptance-criterion", [env("ACC-0001", "acceptance-criterion", { statement: "it works", evaluates: ["CMP-0001"], verifies: ["REQ-0001"], outcome: "pass" })]],
    ["component", [env("CMP-0001", "component", { responsibility: "r", satisfies: ["REQ-0001"] })]],
  ]);

test("ACC-0010: a slice carries everything its tasks trace to", () => {
  const slices = new Map(roleSlices(sliceInput()));
  assert.deepEqual([...slices.keys()], ["backend", "frontend"], "roles are COLLECTED from tasks, not from a roster");

  const backend = slices.get("backend");
  // ⚠️ ACC-0001 is `pass`, so both backend tasks are ACCEPTED and neither is outstanding work.
  // The first real package listed finished and unstarted tasks identically, and a recipient
  // following it would have redone completed work — a defect fixture testing never saw, because
  // the fixture had no tasks at all.
  assert.deepEqual(backend.tasks.map((t) => t.id), [], "accepted work is not outstanding work");
  assert.deepEqual(backend.accepted.map((t) => t.id), ["TSK-0001", "TSK-0003"]);
  assert.deepEqual(backend.accepted[0].derivedStatus, { status: "accepted", passed: 1, total: 1 });
  // ⚠️ The criterion is "can start without coming back to ask". A slice listing only task IDs would
  // satisfy the filename and not the requirement, so the traced material must travel WITH it.
  assert.deepEqual(backend.requirements.map((r) => r.id), ["REQ-0001"]);
  assert.deepEqual(backend.acceptanceCriteria.map((a) => a.id), ["ACC-0001"]);
  assert.deepEqual(backend.components.map((c) => c.id), ["CMP-0001"]);
});

test("ACC-0010: a cross-role dependency is visible to the blocked role", () => {
  // ⚠️ The case one real role cannot exercise. A recipient reading a "self-sufficient" slice while
  // silently waiting on another team has been handed a slice that lies by omission.
  const slices = new Map(roleSlices(sliceInput()));
  assert.deepEqual(slices.get("frontend").blockedByOtherRoles, [{ task: "TSK-0001", role: "backend" }]);
  assert.deepEqual(slices.get("backend").blockedByOtherRoles, [], "a dependency within your own role is not a block from elsewhere");
});

test("ACC-0010: with no tasks there are no slices, and no empty slice files", () => {
  // A role exists exactly when a task is assigned to it (#18). No tasks, no roles, nothing to emit.
  assert.deepEqual(roleSlices(new Map([["task", []]])), []);
});

test("slice filenames are stable and filesystem-safe", () => {
  assert.equal(slugify("technical writer"), "technical-writer");
  assert.equal(slugify("Back End / API"), "back-end-api");
});

test("task status is derived, and a task with no criteria is `unaccountable`", () => {
  const criteria = new Map([
    ["ACC-0001", { id: "ACC-0001", outcome: "pass" }],
    ["ACC-0002", { id: "ACC-0002", outcome: "not-evaluated" }],
  ]);
  assert.deepEqual(taskStatus({ acceptedBy: ["ACC-0001"] }, criteria), { status: "accepted", passed: 1, total: 1 });
  assert.deepEqual(taskStatus({ acceptedBy: ["ACC-0001", "ACC-0002"] }, criteria), { status: "outstanding", passed: 1, total: 2 });
  // ⚠️ A third state, not a synonym for outstanding: an outstanding task has a finish line nobody
  // has crossed, and this one has no finish line at all. The publish gate refuses on it.
  assert.deepEqual(taskStatus({ acceptedBy: [] }, criteria), { status: "unaccountable", passed: 0, total: 0 });
});

test("the publish gate refuses a task with no acceptance criteria", () => {
  const f = completeFixture();
  try {
    mkdirSync(join(f.contentRoot, "data", "tasks"), { recursive: true });
    writeFileSync(
      join(f.contentRoot, "data", "tasks", "TSK-0001.json"),
      canonicalJson(env("TSK-0001", "task", { statement: "do it", role: "backend", implements: ["CMP-0001"], fulfils: ["REQ-0001"] }))
    );
    const ctx = { ...f.ctx, activated: [...f.ctx.activated, "task"] };
    const c = handoffCompleteness(ctx, { toolRoot: ROOT });
    assert.equal(c.ready, false);
    assert.equal(c.blockers[0].reason, BLOCKED.TASK_UNACCOUNTABLE);
    assert.match(c.blockers[0].detail, /nothing in the\s+package can say when it is done|no acceptance criteria/);
  } finally {
    rmSync(f.base, { recursive: true, force: true });
  }
});

test("PLAN.md keeps retired artifacts out of the plan and names them in their own section", () => {
  const byType = new Map([
    ["requirement", [
      env("REQ-0001", "requirement", { statement: "current", priority: "must" }),
      { ...env("REQ-0002", "requirement", { statement: "withdrawn", priority: "must" }), lifecycle: "retired" },
    ]],
  ]);
  const plan = renderPlanMarkdown(byType, new Map());
  // ⚠️ The first real package rendered a RETIRED requirement as an ordinary must-have while the JSON
  // said lifecycle: retired — a human/machine parity break REQ-0011 forbids.
  const requirementsSection = plan.slice(plan.indexOf("## Requirements"), plan.indexOf("## Retired"));
  assert.ok(requirementsSection.includes("REQ-0001"));
  assert.equal(requirementsSection.includes("REQ-0002"), false, "a retired requirement is not part of the current plan");
  // ...and it is not silently dropped either, which would break parity in the other direction.
  assert.ok(plan.includes("## Retired and superseded"));
  assert.match(plan, /REQ-0002.*retired/);
});

test("DEC-0015: unapproved executable content blocks the publish", () => {
  const f = completeFixture();
  try {
    mkdirSync(join(f.contentRoot, "data", "runbook-steps"), { recursive: true });
    const step = env("RBS-0001", "runbook-step", { instruction: "run it", expectedOutcome: "it ran", restsOn: ["AST-0001"] });
    writeFileSync(join(f.contentRoot, "data", "runbook-steps", "RBS-0001.json"), canonicalJson({ ...step, reviewStatus: "draft" }));
    const ctx = { ...f.ctx, activated: [...f.ctx.activated, "runbook-step"] };

    const blocked = handoffCompleteness(ctx, { toolRoot: ROOT });
    assert.ok(blocked.blockers.some((b) => b.reason === BLOCKED.UNAPPROVED_EXECUTABLE && b.artifactId === "RBS-0001"));

    // ⚠️ `amended` passes as well as `approved`: #16 makes amended mean "was approved, then changed",
    // which is a reviewed artifact with a flag on it rather than an unreviewed one.
    for (const status of ["approved", "amended"]) {
      writeFileSync(join(f.contentRoot, "data", "runbook-steps", "RBS-0001.json"), canonicalJson({ ...step, reviewStatus: status }));
      const ok = handoffCompleteness(ctx, { toolRoot: ROOT });
      assert.deepEqual(ok.blockers.filter((b) => b.reason === BLOCKED.UNAPPROVED_EXECUTABLE), [], status);
    }
  } finally {
    rmSync(f.base, { recursive: true, force: true });
  }
});

test("the MANIFEST states the approval basis rather than implying it", async () => {
  const f = completeFixture();
  try {
    await publish(f);
    const manifest = JSON.parse(readFileSync(join(f.outDir, "MANIFEST.json"), "utf-8"));
    assert.match(manifest.approval.package, /STAGE level/);
    assert.match(manifest.approval.artifacts, /NOT a publication gate/);
    assert.deepEqual(manifest.approval.executableContentRequiresApproval, ["runbook-step", "task"]);
    // The counts are what let a consumer check the claim instead of taking it.
    assert.ok(Object.values(manifest.approval.reviewStatusCounts).reduce((a, b) => a + b, 0) > 0);
  } finally {
    rmSync(f.base, { recursive: true, force: true });
  }
});

/* ------------------------------------- QST-0016: normalized whole-package hashing (#146) */

test("the snapshot covers MANIFEST.json and README.md, not only the content files", async () => {
  // ⚠️ THE TEST THE OLD SCHEME COULD NOT PASS. It hashed everything EXCEPT those two, so adding the
  // `approval` block to MANIFEST.json changed the package and left the snapshot at
  // b218b4a525c6176b — two different packages under one identity. Found by republishing and
  // noticing the hash had not moved, which is the same class of check as watching the disk rather
  // than the report.
  const f = completeFixture();
  try {
    const before = await publish(f);
    const manifest = JSON.parse(readFileSync(join(f.outDir, "MANIFEST.json"), "utf-8"));

    // Every file, including the two self-referential ones, is inside the hash.
    const files = new Map(listFiles(f.outDir).map((p) => [p, readFileSync(join(f.outDir, p), "utf-8")]));
    assert.ok(files.has("MANIFEST.json") && files.has("README.md"));
    const check = verifySnapshot(files);
    assert.equal(check.ok, true, `recorded ${check.recorded} but recomputed ${check.recomputed}`);
    assert.equal(check.recorded, before.snapshot);

    // ⚠️ Verification MUST normalize first. Hashing the package as-published — without putting the
    // placeholder back — hashes bytes the renderer never hashed, and can never agree.
    const naive = hashFiles(files);
    assert.notEqual(naive, check.recorded, "an unnormalized recompute must not accidentally match");
  } finally {
    rmSync(f.base, { recursive: true, force: true });
  }
});

test("a change confined to the MANIFEST moves the snapshot", () => {
  // Rendered twice from identical content, with one difference the OLD scheme would have hidden
  // entirely: a different tool version, which appears only in MANIFEST.json and README.md.
  const records = [{ doc: { id: "REQ-0001", type: "requirement", statement: "s", lifecycle: "active", reviewStatus: "draft", title: "t" } }];
  const a = renderPackage({ records, activated: ["requirement"], toolVersion: "1.0.0", stageDocs: new Map() });
  const b = renderPackage({ records, activated: ["requirement"], toolVersion: "2.0.0", stageDocs: new Map() });
  assert.deepEqual(a.get("data/requirements.json"), b.get("data/requirements.json"), "the content files are identical");
  assert.notEqual(
    JSON.parse(a.get("MANIFEST.json")).snapshot,
    JSON.parse(b.get("MANIFEST.json")).snapshot,
    "a package that differs only in its manifest must not share an identity"
  );
});

test("identical input still produces an identical snapshot", () => {
  const records = [{ doc: { id: "REQ-0001", type: "requirement", statement: "s", lifecycle: "active", reviewStatus: "draft", title: "t" } }];
  const mk = () => renderPackage({ records, activated: ["requirement"], toolVersion: "1.0.0", stageDocs: new Map() });
  assert.equal(JSON.parse(mk().get("MANIFEST.json")).snapshot, JSON.parse(mk().get("MANIFEST.json")).snapshot);
  // ...and the placeholder never survives into the published package.
  for (const [path, text] of mk()) assert.equal(text.includes(SNAPSHOT_PLACEHOLDER), false, `${path} still holds the placeholder`);
});
