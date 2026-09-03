/**
 * `linkTrace` / `unlinkTrace` — CMP-0005, and specifically the repair half of QST-0032.
 *
 * ⚠️ **WHAT THIS FILE IS ABOUT: A GUARD THAT REFUSED THE OPERATIONS IT EXISTED TO PERMIT.**
 * `unlinkTrace` validated the target type on removal as well as on addition. So a link written with
 * the wrong target type — the exact thing the lint blocks on — could not be removed by the operation
 * whose job is removing links. Neither could a link to a deleted artifact, nor one to a superseded
 * one. The only route was `reviseArtifact`, which reached those fields solely because ITS guard was
 * a hand-maintained list with holes in it: one defect was the escape hatch for the other.
 *
 * Each case below therefore asserts two things — the link is gone, AND the lint finding it produced
 * has cleared. "The array is shorter" is not the claim; "the graph is repaired" is.
 *
 * ⚠️ **THE ADD PATH IS ASSERTED IN THE SAME FILE, DELIBERATELY.** The fix is an ASYMMETRY, and an
 * asymmetry is only correct while both halves hold. A later simplification that made removal and
 * addition share one validation path would repair nothing and would pass a file that only tested
 * removal.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { linkTrace, unlinkTrace } from "../lib/tools/link-trace.mjs";
import { createRequirement } from "../lib/tools/create-requirement.mjs";
import { createQuestion, createDecision, createComponent, setLifecycle, resolveQuestion, reviseArtifact } from "../lib/tools/evidence-tools.mjs";
import { ValidationError, createValidators } from "../lib/validate.mjs";
import { loadSchemaSet, traceEdges } from "../lib/schema-resolver.mjs";
import { lintProject } from "../lib/lint.mjs";
import { artifactRelPath } from "../lib/layout.mjs";
import { LOCK_FILE } from "../lib/tools/create-artifact.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCHEMAS = join(ROOT, "schemas");
const schemas = loadSchemaSet(SCHEMAS);
const validators = createValidators(SCHEMAS);
const ACTIVATED = ["requirement", "decision", "question", "component", "assertion", "evidence"];

function fresh() {
  const base = mkdtempSync(join(tmpdir(), "vpw-link-"));
  const contentRoot = join(base, "planning-content");
  mkdirSync(contentRoot, { recursive: true });
  return { base, contentRoot, o: { contentRoot, schemasDir: SCHEMAS, validators, schemas } };
}
const ctxOf = (contentRoot) => ({ contentRoot, schemas, validators, activated: ACTIVATED, stageDefinitions: null });
const findings = (contentRoot, ruleId) =>
  lintProject(ctxOf(contentRoot)).findings.filter((f) => f.ruleId === ruleId);
const read = (contentRoot, type, id) =>
  JSON.parse(readFileSync(join(contentRoot, artifactRelPath(type, id)), "utf-8"));

const REQ = { title: "A requirement", statement: "Something the system must do, stated so it can be checked." };
const QST = { title: "A question", statement: "Something nobody has settled yet, recorded rather than carried in someone's head.", resolution: "unanswered" };
// `satisfies` is required by the schema; the tests that need an edge add it with `linkTrace`.
const CMP = { title: "A component", responsibility: "One named unit of the design, and the boundary around it.", satisfies: [] };
const DEC = { title: "A decision", statement: "The option taken, recorded with what it displaced." };

/* ============================================================ wrong target type ================ */

test("a link written with the wrong target type can be removed, and the lint finding clears", async () => {
  const { base, contentRoot, o } = fresh();
  try {
    const q = await createQuestion(QST, o);
    const r = await createRequirement(REQ, o);
    const c = await createComponent(CMP, o);

    await linkTrace("question", q.id, "blocks", [r.id], o);

    // ⚠️ WRITTEN BEHIND THE TOOL'S BACK ON PURPOSE. `linkTrace` refuses a wrong-type target on the
    // way in — that half works and is asserted below. This reproduces the state the graph can
    // ACTUALLY reach: a component id in `blocks`, however it got there. Refusing to construct it
    // here would mean only testing repairs of damage that cannot occur.
    const path = join(contentRoot, artifactRelPath("question", q.id));
    const doc = JSON.parse(readFileSync(path, "utf-8"));
    writeFileSync(path, JSON.stringify({ ...doc, blocks: [r.id, c.id] }, null, 2) + "\n");

    const before = findings(contentRoot, "trace/wrong-target-type");
    assert.equal(before.length, 1, "the fixture must actually produce the finding being repaired");
    assert.match(before[0].message, /component/);

    const res = await unlinkTrace("question", q.id, "blocks", [c.id], o);

    assert.equal(res.changed, true);
    assert.deepEqual(res.links, [r.id], "the wrong-type link is gone and the valid one survives");
    assert.deepEqual(read(contentRoot, "question", q.id).blocks, [r.id]);
    assert.deepEqual(findings(contentRoot, "trace/wrong-target-type"), [], "the lint finding must clear");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

/* ============================================================ dangling target =================== */

test("a link to a deleted artifact can be removed, and the lint finding clears", async () => {
  const { base, contentRoot, o } = fresh();
  try {
    const c = await createComponent(CMP, o);
    const r1 = await createRequirement(REQ, o);
    const r2 = await createRequirement({ ...REQ, title: "Another requirement" }, o);
    await linkTrace("component", c.id, "satisfies", [r1.id, r2.id], o);

    rmSync(join(contentRoot, artifactRelPath("requirement", r2.id)));

    const before = findings(contentRoot, "trace/target-missing");
    assert.equal(before.length, 1, "the fixture must actually produce the finding being repaired");

    const res = await unlinkTrace("component", c.id, "satisfies", [r2.id], o);

    assert.equal(res.changed, true);
    assert.deepEqual(res.links, [r1.id]);
    assert.deepEqual(findings(contentRoot, "trace/target-missing"), [], "the lint finding must clear");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

/* ============================================================ superseded target ================= */

test("a link to a superseded artifact can be removed, and the lint warning clears", async () => {
  const { base, contentRoot, o } = fresh();
  try {
    const d1 = await createDecision(DEC, o);
    const d2 = await createDecision({ ...DEC, title: "The decision that replaced it" }, o);
    const q = await createQuestion(QST, o);
    await linkTrace("question", q.id, "blocks", [d1.id, d2.id], o);

    await setLifecycle("decision", d1.id, "superseded", { supersededBy: [d2.id], ...o });

    const before = findings(contentRoot, "lifecycle/trace-to-inactive");
    assert.equal(before.length, 1, "the fixture must actually produce the finding being repaired");
    assert.match(before[0].message, new RegExp(d1.id));

    const res = await unlinkTrace("question", q.id, "blocks", [d1.id], o);

    assert.equal(res.changed, true);
    assert.deepEqual(res.links, [d2.id]);
    assert.deepEqual(findings(contentRoot, "lifecycle/trace-to-inactive"), [], "the lint finding must clear");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

/* ============================================================ answeredBy ======================= */

test("answeredBy can be withdrawn, which no operation could previously do", async () => {
  const { base, contentRoot, o } = fresh();
  try {
    const d1 = await createDecision(DEC, o);
    const d2 = await createDecision({ ...DEC, title: "The decision that replaced it" }, o);
    const q = await createQuestion(QST, o);
    await resolveQuestion(q.id, "answered", { answer: "Settled, and here is the shape of it.", answeredBy: [d1.id, d2.id], ...o });
    await setLifecycle("decision", d1.id, "superseded", { supersededBy: [d2.id], ...o });

    assert.equal(findings(contentRoot, "lifecycle/trace-to-inactive").length, 1);

    // ⚠️ THE OPERATION THAT DID NOT EXIST. `resolveQuestion` only ever merges `answeredBy`, so a
    // question answered by a since-superseded decision kept citing it with no way back. This is the
    // case that forced a deliberate exploitation of the companion defect during Phase 1.
    const res = await unlinkTrace("question", q.id, "answeredBy", [d1.id], o);

    assert.equal(res.changed, true);
    assert.deepEqual(res.links, [d2.id]);
    assert.deepEqual(findings(contentRoot, "lifecycle/trace-to-inactive"), []);

    // ...and ADDING one still belongs to `resolveQuestion`, whose guards are the reason it does.
    await assert.rejects(
      () => linkTrace("question", q.id, "answeredBy", [d2.id], o),
      (e) => e instanceof ValidationError && /resolveQuestion/.test(e.message),
      "adding an answer link must still route through the operation that validates it"
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("the fields that DO have a removal operation still route to it", async () => {
  const { base, contentRoot, o } = fresh();
  try {
    const q = await createQuestion(QST, o);
    // `supportedBy`/`refutedBy` have `unlinkEvidence`; `supersededBy` is a lifecycle change. Only
    // `answeredBy` opens up, because only `answeredBy` had nothing.
    for (const [field, expect] of [["supportedBy", /unlinkEvidence/], ["refutedBy", /unlinkEvidence/], ["supersededBy", /setLifecycle/]]) {
      await assert.rejects(
        () => unlinkTrace("assertion", "AST-0001", field, ["EVD-0001"], o),
        (e) => e instanceof ValidationError && expect.test(e.message),
        `${field} must still name its own removal operation`
      );
    }
    assert.ok(q.id);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

/* ============================================================ what removal still refuses ======== */

test("removal still refuses a field the schema does not declare as a trace field", async () => {
  const { base, contentRoot, o } = fresh();
  try {
    const q = await createQuestion(QST, o);

    // ⚠️ THIS IS WHAT STOPS `unlinkTrace` BECOMING A GENERAL ARRAY EDITOR. Loosening the TARGET
    // check does not loosen the FIELD check, and a tool that could empty any array would be a
    // second write path around #88.
    await assert.rejects(
      () => unlinkTrace("question", q.id, "tags", ["anything"], o),
      (e) => e instanceof ValidationError && /not a trace field/.test(e.message)
    );
    await assert.rejects(
      () => unlinkTrace("question", q.id, "notAField", ["anything"], o),
      (e) => e instanceof ValidationError && /has no field/.test(e.message)
    );
    await assert.rejects(
      () => unlinkTrace("question", q.id, "blocks", [], o),
      (e) => e instanceof ValidationError && /at least one target/.test(e.message)
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("adding is unaffected: the target must exist and be of a declared type", async () => {
  const { base, contentRoot, o } = fresh();
  try {
    const q = await createQuestion(QST, o);
    const c = await createComponent(CMP, o);

    await assert.rejects(
      () => linkTrace("question", q.id, "blocks", [c.id], o),
      (e) => e instanceof ValidationError && /may target/.test(e.message),
      "a wrong-type target must still be refused on the way IN"
    );
    await assert.rejects(
      () => linkTrace("question", q.id, "blocks", ["REQ-9999"], o),
      (e) => e instanceof ValidationError && /does not exist/.test(e.message),
      "a dangling target must still be refused on the way IN"
    );
    await assert.rejects(
      () => linkTrace("question", q.id, "blocks", ["not-an-id"], o),
      (e) => e instanceof ValidationError && /not an artifact ID/.test(e.message)
    );
    assert.deepEqual(read(contentRoot, "question", q.id).blocks ?? [], [], "no refused link may have been written");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

/* ============================================================ the write discipline ============== */

test("removal keeps the lock, the fresh read inside it, and the atomic write", async () => {
  const { base, contentRoot, o } = fresh();
  try {
    const c = await createComponent(CMP, o);
    const r1 = await createRequirement(REQ, o);
    const r2 = await createRequirement({ ...REQ, title: "Another requirement" }, o);
    await linkTrace("component", c.id, "satisfies", [r1.id, r2.id], o);

    // ⚠️ FRESH READ INSIDE THE LOCK (#78), asserted by changing the file after the call is
    // constructed but before it runs. A cached read taken earlier would drop the edit; the fresh
    // one preserves it, so the surviving `notes` field is the observation.
    const path = join(contentRoot, artifactRelPath("component", c.id));
    const doc = JSON.parse(readFileSync(path, "utf-8"));
    writeFileSync(path, JSON.stringify({ ...doc, notes: "written between create and unlink" }, null, 2) + "\n");

    await unlinkTrace("component", c.id, "satisfies", [r2.id], o);

    const after = read(contentRoot, "component", c.id);
    assert.equal(after.notes, "written between create and unlink", "the read must happen inside the lock, not before it");
    assert.deepEqual(after.satisfies, [r1.id]);

    // The lock file is released, and no temporary file is left beside the artifact.
    assert.equal(existsSync(join(contentRoot, LOCK_FILE)), false, "the lock must be released");
    const { readdirSync } = await import("node:fs");
    assert.deepEqual(
      readdirSync(dirname(path)).filter((f) => !f.endsWith(".json")),
      [],
      "an atomic write leaves no temporary file behind"
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("removing a link an approved artifact carried marks it amended, and a no-op changes nothing", async () => {
  const { base, contentRoot, o } = fresh();
  try {
    const c = await createComponent(CMP, o);
    const r = await createRequirement(REQ, o);
    await linkTrace("component", c.id, "satisfies", [r.id], o);

    const path = join(contentRoot, artifactRelPath("component", c.id));
    const doc = JSON.parse(readFileSync(path, "utf-8"));
    writeFileSync(path, JSON.stringify({ ...doc, reviewStatus: "approved" }, null, 2) + "\n");

    const noop = await unlinkTrace("component", c.id, "satisfies", ["REQ-9999"], o);
    assert.equal(noop.changed, false, "removing something absent is a no-op");
    assert.equal(read(contentRoot, "component", c.id).reviewStatus, "approved", "a no-op must not amend");

    const res = await unlinkTrace("component", c.id, "satisfies", [r.id], o);
    assert.equal(res.changed, true);
    assert.equal(read(contentRoot, "component", c.id).reviewStatus, "amended", "#16: an approved artifact that changes is amended");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

/* ============================================================ TSK-0070: the derived guard ====== */

/**
 * ⚠️ **THE GUARD IS ENUMERATED FROM THE SCHEMAS, NOT COMPARED AGAINST A LIST WRITTEN HERE.**
 * That is the whole point of the criterion, and writing the expected names into this file would
 * reproduce the original defect one layer up: two hand-maintained lists that must agree, with the
 * test passing while the guard drifted. `traceEdges()` is the same source `linkTrace` validates
 * against, so the two cannot disagree without this failing.
 */
test("every field the schemas declare as a trace field is refused by reviseArtifact", async () => {
  const { base, contentRoot, o } = fresh();
  try {
    // One artifact per type that has trace fields, created through the typed tools.
    const r = await createRequirement(REQ, o);
    const made = {
      question: (await createQuestion(QST, o)).id,
      component: (await createComponent(CMP, o)).id,
      decision: (await createDecision(DEC, o)).id,
      requirement: r.id,
    };

    const edges = traceEdges(schemas).filter((e) => made[e.from]);
    assert.ok(edges.length >= 12, `expected the schemas to declare trace fields on these types, got ${edges.length}`);

    for (const { from, field } of edges) {
      await assert.rejects(
        () => reviseArtifact(from, made[from], { [field]: ["DEC-9999"] }, o),
        (e) => e instanceof ValidationError && /trace field/.test(e.message),
        `${from}.${field} declares x-traceTarget but reviseArtifact accepted it`
      );
    }
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("a trace field added to a schema extends the guard with no code change", async () => {
  const { base, contentRoot } = fresh();
  const schemaDir = join(base, "schemas");
  try {
    // ⚠️ THE PROOF THAT IT IS DERIVED AND NOT COINCIDENTAL. A copy of the real schema set with ONE
    // new trace field on it: if the guard were still a list, this field would be writable, because
    // no list anywhere mentions it.
    cpSync(SCHEMAS, schemaDir, { recursive: true });
    const compSchemaPath = join(schemaDir, "component.schema.json");
    const compSchema = JSON.parse(readFileSync(compSchemaPath, "utf-8"));
    compSchema.properties.inventedLink = {
      type: "array",
      items: { type: "string" },
      "x-materiality": "structural",
      "x-traceTarget": ["requirement"],
    };
    writeFileSync(compSchemaPath, JSON.stringify(compSchema, null, 2) + "\n");

    const localSchemas = loadSchemaSet(schemaDir);
    const localValidators = createValidators(schemaDir);
    const o2 = { contentRoot, schemasDir: schemaDir, validators: localValidators, schemas: localSchemas };

    const c = await createComponent(CMP, o2);
    await assert.rejects(
      () => reviseArtifact("component", c.id, { inventedLink: ["REQ-0001"] }, o2),
      (e) => e instanceof ValidationError && /trace field/.test(e.message),
      "a field declared with x-traceTarget must be refused without anyone editing the guard"
    );

    // ...and a NON-trace field on the same type stays revisable, so the guard is discriminating
    // rather than simply refusing everything.
    const ok = await reviseArtifact("component", c.id, { notes: "still revisable" }, o2);
    assert.equal(ok.artifact.notes, "still revisable");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("implementedBy stays revisable, because it is paths and not links", async () => {
  const { base, contentRoot, o } = fresh();
  try {
    const c = await createComponent(CMP, o);
    // ⚠️ THE DISCRIMINATION THAT A UNION OF FIELD NAMES WOULD HAVE GOT WRONG. `implementedBy` looks
    // like a link and is deliberately not one — the component schema says so: "Paths rather than a
    // trace field on purpose: code is not an artifact." It declares no x-traceTarget, so the derived
    // guard leaves it alone. An earlier account of this defect miscounted it among the unguarded
    // trace fields; there are eight, not nine.
    const res = await reviseArtifact("component", c.id, { implementedBy: ["lib/tools/link-trace.mjs"] }, o);
    assert.deepEqual(res.artifact.implementedBy, ["lib/tools/link-trace.mjs"]);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
