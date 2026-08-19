import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { loadSchemaSet } from "../lib/schema-resolver.mjs";
import { createValidators } from "../lib/validate.mjs";
import { lintProject, evaluateStageGate, evaluateHandoffGate, SEVERITY } from "../lib/lint.mjs";
import { createRequirement } from "../lib/tools/create-requirement.mjs";
import { artifactDir } from "../lib/layout.mjs";
import { loadStageDefinitions } from "../lib/stages.mjs";
import { readActivatedTypes } from "../lib/activation.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCHEMAS = join(ROOT, "schemas");
const schemas = loadSchemaSet(SCHEMAS);
const validators = createValidators(SCHEMAS);
const ACTIVATED = ["requirement", "decision", "schema", "api-spec"];

// #34/#90: what a stage produces comes from stages/, never from the schemas' x-stage.
const STAGE_DEFS = {
  "02-intent-decomposition": { id: "02-intent-decomposition", produces: ["requirement"] },
  "05-solution-design": { id: "05-solution-design", produces: ["schema", "api-spec"] },
};


function fresh() {
  const base = mkdtempSync(join(tmpdir(), "vpw-lint-"));
  const contentRoot = join(base, "planning-content");
  mkdirSync(join(contentRoot, artifactDir("requirement")), { recursive: true });
  return { base, contentRoot, ctx: { contentRoot, schemas, validators, activated: ACTIVATED } };
}

const GOOD = { title: "Nightly replication", statement: "The system must replicate the customer table nightly." };
const ids = (f) => f.map((x) => x.ruleId).sort();
const write = (contentRoot, rel, obj) =>
  writeFileSync(join(contentRoot, rel), typeof obj === "string" ? obj : JSON.stringify(obj, null, 2) + "\n");

/* ---------------------------------------------------------------- clean state */

test("an artifact written by the typed tool lints clean", async () => {
  const { base, contentRoot, ctx } = fresh();
  try {
    await createRequirement(GOOD, { contentRoot, schemasDir: SCHEMAS, validators });
    const { findings } = lintProject(ctx);
    assert.deepEqual(findings, [], `expected no findings, got ${JSON.stringify(findings, null, 2)}`);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

/* ------------------------------------------- LAYER 1: prevent — schema-invalid */

test("LAYER 1 (prevent): a schema-invalid file on disk is caught as schema/invalid", () => {
  const { base, contentRoot, ctx } = fresh();
  try {
    // The typed tool could not have produced this. It arrived by hand.
    write(contentRoot, "data/requirements/REQ-0001.json", {
      id: "REQ-0001", type: "requirement", schemaVersion: 1,
      reviewStatus: "draft", lifecycle: "active", title: "T",
      // no statement, and an unknown property
      owner: "someone",
    });
    const { findings } = lintProject(ctx);
    assert.ok(ids(findings).includes("schema/invalid"), ids(findings).join(", "));
    assert.ok(findings.every((f) => f.ruleId !== "schema/invalid" || f.severity === SEVERITY.ERROR));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

/* --------------------------- LAYER 2: detect — schema-valid, repository-invalid */

test("LAYER 2 (detect): a valid artifact in the wrong directory", async () => {
  const { base, contentRoot, ctx } = fresh();
  try {
    const { path } = await createRequirement(GOOD, { contentRoot, schemasDir: SCHEMAS, validators });
    mkdirSync(join(contentRoot, artifactDir("decision")), { recursive: true });
    renameSync(join(contentRoot, path), join(contentRoot, "data/decisions/REQ-0001.json"));

    const { findings } = lintProject(ctx);
    const rules = ids(findings);
    assert.ok(rules.includes("storage/type-mismatch-directory"), rules.join(", "));
    assert.ok(rules.includes("storage/prefix-mismatch-type") === false, "prefix agrees with type; must not fire");
    // Crucially: the file itself is still schema-valid.
    assert.ok(!rules.includes("schema/invalid"), "the file is legal JSON for its type — that is the point");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("LAYER 2 (detect): id does not match filename", async () => {
  const { base, contentRoot, ctx } = fresh();
  try {
    await createRequirement(GOOD, { contentRoot, schemasDir: SCHEMAS, validators });
    renameSync(
      join(contentRoot, "data/requirements/REQ-0001.json"),
      join(contentRoot, "data/requirements/REQ-0008.json")
    );
    const rules = ids(lintProject(ctx).findings);
    assert.ok(rules.includes("storage/id-mismatch-filename"), rules.join(", "));
    assert.ok(!rules.includes("schema/invalid"), "still schema-valid");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("LAYER 2 (detect): a trace link to an activated type that does not exist", () => {
  const { base, contentRoot, ctx } = fresh();
  try {
    write(contentRoot, "data/requirements/REQ-0001.json", {
      id: "REQ-0001", type: "requirement", schemaVersion: 1, reviewStatus: "draft",
      lifecycle: "active", title: "T", statement: "S", derivedFrom: ["REQ-0099"],
    });
    const findings = lintProject(ctx).findings;
    const missing = findings.find((f) => f.ruleId === "trace/target-missing");
    assert.ok(missing, ids(findings).join(", "));
    assert.equal(missing.severity, SEVERITY.ERROR);
    assert.equal(missing.details.ref, "REQ-0099");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("#75: a link to a NON-activated type is advisory, not an error", () => {
  const { base, contentRoot, ctx } = fresh();
  try {
    write(contentRoot, "data/requirements/REQ-0001.json", {
      id: "REQ-0001", type: "requirement", schemaVersion: 1, reviewStatus: "draft",
      lifecycle: "active", title: "T", statement: "S", evidencedBy: ["EVD-0001"],
    });
    const findings = lintProject(ctx).findings;
    const adv = findings.find((f) => f.ruleId === "trace/target-not-activated");
    assert.ok(adv, ids(findings).join(", "));
    assert.equal(adv.severity, SEVERITY.ADVISORY);
    assert.equal(findings.filter((f) => f.severity === SEVERITY.ERROR).length, 0, "must not block");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("LAYER 2 (detect): duplicate IDs across files", () => {
  const { base, contentRoot, ctx } = fresh();
  try {
    const doc = { id: "REQ-0001", type: "requirement", schemaVersion: 1, reviewStatus: "draft", lifecycle: "active", title: "T", statement: "S" };
    write(contentRoot, "data/requirements/REQ-0001.json", doc);
    write(contentRoot, "data/requirements/REQ-0002.json", doc);
    const rules = ids(lintProject(ctx).findings);
    assert.ok(rules.includes("storage/duplicate-id"), rules.join(", "));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("LAYER 2 (detect): whitespace-only and placeholder content the schema cannot see", () => {
  const { base, contentRoot, ctx } = fresh();
  try {
    write(contentRoot, "data/requirements/REQ-0001.json", {
      id: "REQ-0001", type: "requirement", schemaVersion: 1, reviewStatus: "draft",
      lifecycle: "active", title: "   ", statement: "TODO: work out what this actually requires",
    });
    const findings = lintProject(ctx).findings;
    const rules = ids(findings);
    assert.ok(rules.includes("content/hollow-value"), rules.join(", "));
    assert.ok(rules.includes("content/placeholder-marker"), rules.join(", "));
    assert.ok(!rules.includes("schema/invalid"), "minLength passes — that is why these rules exist");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("LAYER 2 (detect): an active artifact tracing to a retired one", () => {
  const { base, contentRoot, ctx } = fresh();
  try {
    write(contentRoot, "data/requirements/REQ-0001.json", {
      id: "REQ-0001", type: "requirement", schemaVersion: 1, reviewStatus: "approved",
      lifecycle: "retired", title: "Old", statement: "Superseded thinking.",
    });
    write(contentRoot, "data/requirements/REQ-0002.json", {
      id: "REQ-0002", type: "requirement", schemaVersion: 1, reviewStatus: "draft",
      lifecycle: "active", title: "New", statement: "Rests on the old one.", derivedFrom: ["REQ-0001"],
    });
    const findings = lintProject(ctx).findings;
    const f = findings.find((x) => x.ruleId === "lifecycle/trace-to-inactive");
    assert.ok(f, ids(findings).join(", "));
    assert.equal(f.details.targetLifecycle, "retired");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("the lint does NOT restate schema rules it already enforces", () => {
  const { base, contentRoot, ctx } = fresh();
  try {
    // superseded without supersededBy is a SCHEMA violation (the allOf conditional).
    mkdirSync(join(contentRoot, artifactDir("decision")), { recursive: true });
    write(contentRoot, "data/decisions/DEC-0001.json", {
      id: "DEC-0001", type: "decision", schemaVersion: 1, reviewStatus: "approved",
      lifecycle: "superseded", title: "T", statement: "S",
    });
    const rules = ids(lintProject(ctx).findings);
    assert.ok(rules.includes("schema/invalid"), "the schema should catch it");
    assert.ok(!rules.some((r) => r.startsWith("lifecycle/superseded")), "the lint must not duplicate the schema rule");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

/* ------------------ LAYER 3: gate — individually valid, collectively incomplete */

test("LAYER 3 (gate): valid artifacts can still fail a stage gate", async () => {
  const { base, contentRoot, ctx } = fresh();
  try {
    await createRequirement(GOOD, { contentRoot, schemasDir: SCHEMAS, validators });

    // Every artifact is valid — the artifact lint is clean.
    assert.deepEqual(lintProject(ctx).findings, []);

    // Stage 5 produces `schema` and `api-spec`; neither exists. Nothing is INVALID.
    const gate = evaluateStageGate(ctx, "05-solution-design", { stageDefinitions: STAGE_DEFS });
    assert.equal(gate.blockingArtifactFindings.length, 0, "no artifact is bad");
    assert.deepEqual(
      gate.gateFindings.map((f) => f.details.type).sort(),
      ["api-spec", "schema"],
      "the collection is not ready to advance"
    );
    // ⚠️ Both have schemas but no typed tool, so #94 classifies them as capability gaps rather
    // than as unfinished planning. The point of the layer-3 test survives — every artifact is
    // valid and the stage still cannot advance — and the REASON is now stated accurately.
    assert.ok(
      gate.gateFindings.every((f) => f.ruleId === "gate/type-not-implemented"),
      gate.gateFindings.map((f) => f.ruleId).join(", ")
    );
    assert.ok(gate.gateFindings.every((f) => f.details.missing.includes("typed tool")));

    // Stage 2 produces `requirement`, and one exists.
    const stage2 = evaluateStageGate(ctx, "02-intent-decomposition", { stageDefinitions: STAGE_DEFS });
    assert.deepEqual(stage2.gateFindings, []);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("LAYER 3 (gate): a gate with no declared criteria says so rather than passing", async () => {
  const { base, contentRoot, ctx } = fresh();
  try {
    await createRequirement(GOOD, { contentRoot, schemasDir: SCHEMAS, validators });
    const gate = evaluateStageGate(ctx, "02-intent-decomposition", { stageDefinitions: null });
    assert.equal(gate.stageDefinitionsFound, false, "#34's stage definitions do not exist yet");
    assert.equal(gate.criteriaDeclared, false);
    assert.equal(gate.ready, false, "must not report ready on criteria it has never seen");
    assert.deepEqual(gate.gateFindings, [], "and must not INFER produced types from x-stage (#90)");

    const withCriteria = evaluateStageGate(ctx, "02-intent-decomposition", {
      stageDefinitions: STAGE_DEFS,
      criteria: [{ id: "every-requirement-testable", describe: "Every requirement is testable.", check: () => true }],
    });
    assert.equal(withCriteria.criteriaDeclared, true);
    assert.equal(withCriteria.ready, true);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("the three layers produce distinguishable outcomes", async () => {
  const { base, contentRoot, ctx } = fresh();
  try {
    await createRequirement(GOOD, { contentRoot, schemasDir: SCHEMAS, validators });          // clean
    write(contentRoot, "data/requirements/REQ-0002.json", { id: "REQ-0002", type: "requirement", schemaVersion: 1, reviewStatus: "draft", lifecycle: "active", title: "T" }); // layer 1
    write(contentRoot, "data/requirements/REQ-0009.json", { id: "REQ-0003", type: "requirement", schemaVersion: 1, reviewStatus: "draft", lifecycle: "active", title: "T", statement: "S" }); // layer 2

    const gate = evaluateStageGate(ctx, "05-solution-design", { stageDefinitions: STAGE_DEFS });
    const rules = new Set(gate.allFindings.map((f) => f.ruleId));

    assert.ok(rules.has("schema/invalid"), "layer 1 missing");
    assert.ok(rules.has("storage/id-mismatch-filename"), "layer 2 missing");
    assert.ok(gate.gateFindings.length > 0, "layer 3 missing");
    // And they are separable by caller, not by reading prose.
    assert.notEqual(gate.gateFindings[0].ruleId, "schema/invalid");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("every finding is structured data with a stable shape (#47's three callers)", () => {
  const { base, contentRoot, ctx } = fresh();
  try {
    write(contentRoot, "data/requirements/REQ-0001.json", { id: "REQ-0001", type: "requirement", schemaVersion: 1, reviewStatus: "draft", lifecycle: "active", title: "T" });
    const { findings } = lintProject(ctx);
    assert.ok(findings.length > 0);
    for (const f of findings) {
      assert.deepEqual(Object.keys(f).sort(), ["artifactId", "details", "message", "path", "ruleId", "severity"]);
      assert.ok(Object.values(SEVERITY).includes(f.severity));
      assert.equal(typeof f.ruleId, "string");
      assert.ok(f.ruleId.includes("/"), "ruleId should be namespaced by family");
    }
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("unparseable JSON is a finding, not a crash", () => {
  const { base, contentRoot, ctx } = fresh();
  try {
    write(contentRoot, "data/requirements/REQ-0001.json", "{ not json");
    const findings = lintProject(ctx).findings;
    assert.equal(findings.length, 1);
    assert.equal(findings[0].ruleId, "artifact/unparseable");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("#46: the handoff gate blocks on errors and reports advisories without blocking", () => {
  const { base, contentRoot, ctx } = fresh();
  try {
    write(contentRoot, "data/requirements/REQ-0001.json", {
      id: "REQ-0001", type: "requirement", schemaVersion: 1, reviewStatus: "approved",
      lifecycle: "active", title: "T", statement: "S", evidencedBy: ["EVD-0001"],
    });
    const gate = evaluateHandoffGate(ctx);
    assert.equal(gate.ready, true, "an advisory must not block the handoff");
    assert.equal(gate.advisories.length, 1);

    write(contentRoot, "data/requirements/REQ-0002.json", { id: "REQ-0002", type: "requirement", schemaVersion: 1, reviewStatus: "draft", lifecycle: "active", title: "T" });
    assert.equal(evaluateHandoffGate(ctx).ready, false, "an error must block");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

/* ------------------------------------------------- #90: stages/ owns the pipeline */

test("#90: the gate does NOT infer produced types from x-stage", async () => {
  const { base, contentRoot, ctx } = fresh();
  try {
    // No stage definitions. Stage 5's schemas carry x-stage: 05-solution-design, and no
    // schema or api-spec artifact exists — the old inference would have fired here.
    const gate = evaluateStageGate(ctx, "05-solution-design", { stageDefinitions: null });
    assert.equal(gate.stageDefinitionsFound, false);
    assert.deepEqual(gate.gateFindings, [], "produced types must come from stages/ or from nowhere");
    assert.equal(gate.ready, false, "and it still refuses to report ready");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("#90: x-stage disagreeing with stages/ is an error, and stages/ is the authority", () => {
  const { base, contentRoot, ctx } = fresh();
  try {
    const wrong = { "02-intent-decomposition": { id: "02-intent-decomposition", produces: ["requirement", "schema"] } };
    const { findings } = lintProject({ ...ctx, stageDefinitions: wrong });
    const d = findings.filter((f) => f.ruleId.startsWith("stage/x-stage"));
    // schema.schema.json says x-stage 05-solution-design, which these defs do not contain:
    // #90's strengthened invariant catches the UNRESOLVABLE case before the disagreement one.
    const s = d.find((f) => f.details.type === "schema");
    assert.ok(s, JSON.stringify(findings, null, 2));
    assert.equal(s.ruleId, "stage/x-stage-unresolvable");
    assert.ok(d.every((f) => f.severity === SEVERITY.ERROR));
    // requirement IS claimed by these defs but stage 2 also claims schema, so requirement agrees.
    assert.ok(!d.some((f) => f.details.type === "requirement"));

    // And with defs that agree, nothing fires.
    const right = {
      "02-intent-decomposition": { id: "02-intent-decomposition", produces: ["requirement"] },
      "04-requirement-gaps": { id: "04-requirement-gaps", produces: ["decision", "question"] },
      "05-solution-design": { id: "05-solution-design", produces: ["schema", "api-spec"] },
      // assertion and evidence are cross-cutting (#25) and carry no x-stage, so no stage
      // claims them and none may. runbook-step is stage 9's, promoted when it was built.
      "09-handoff": { id: "09-handoff", produces: ["runbook", "runbook-step"] },
    };
    const ok = lintProject({ ...ctx, stageDefinitions: right }).findings;
    assert.deepEqual(ok.filter((f) => f.ruleId.startsWith("stage/x-stage")), []);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("#90: the real stages/ definitions agree with every schema's x-stage", () => {
  // Not a fixture — the nine definitions on disk against the four real schemas. This is the
  // invariant #90 asks for: every x-stage resolves to an existing stage AND agrees with it.
  const { base, contentRoot, ctx } = fresh();
  try {
    const findings = lintProject(ctx).findings;
    assert.deepEqual(
      findings.filter((f) => f.ruleId.startsWith("stage/")),
      [],
      "the shipped stage definitions disagree with the shipped schemas"
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("#93: a human-only criterion is ATTESTED, not acknowledged", async () => {
  const { base, contentRoot, ctx } = fresh();
  try {
    await createRequirement(GOOD, { contentRoot, schemasDir: SCHEMAS, validators });
    const gate = evaluateStageGate(ctx, "02-intent-decomposition");
    assert.ok(gate.pendingHumanCriteria.length > 0, "stage 2 has human-judgement criteria");
    assert.equal(gate.ready, false, "unevaluated criteria must not pass");
    assert.ok(gate.gateFindings.some((f) => f.ruleId === "gate/criterion-pending-human"));

    // Seeing a criterion is not judging it: there is no "acknowledged" result at all.
    const bogus = evaluateStageGate(ctx, "02-intent-decomposition", {
      attestations: Object.fromEntries(gate.pendingHumanCriteria.map((id) => [id, { result: "acknowledged" }])),
    });
    assert.ok(bogus.gateFindings.some((f) => f.ruleId === "gate/attestation-malformed"), "acknowledgement must not be a result");
    assert.equal(bogus.ready, false);

    const noEvaluator = evaluateStageGate(ctx, "02-intent-decomposition", {
      attestations: Object.fromEntries(gate.pendingHumanCriteria.map((id) => [id, { result: "satisfied" }])),
    });
    assert.ok(
      noEvaluator.gateFindings.some((f) => f.ruleId === "gate/attestation-malformed" && /decidedBy/.test(f.message)),
      "a verdict without an evaluator is not a recorded human decision"
    );
    assert.equal(noEvaluator.ready, false);

    // Evaluated and found true.
    const satisfied = evaluateStageGate(ctx, "02-intent-decomposition", {
      attestations: Object.fromEntries(
        gate.pendingHumanCriteria.map((id) => [id, { result: "satisfied", decidedBy: "pm", reason: "Reviewed REQ-0001." }])
      ),
    });
    assert.deepEqual(satisfied.pendingHumanCriteria, []);
    assert.deepEqual(satisfied.gateFindings, [], JSON.stringify(satisfied.gateFindings, null, 2));
    assert.equal(satisfied.ready, true, "an evaluated, satisfied stage may advance");

    // Evaluated and found false is a DIFFERENT outcome from never evaluated.
    const failed = evaluateStageGate(ctx, "02-intent-decomposition", {
      attestations: { ...Object.fromEntries(gate.pendingHumanCriteria.map((id) => [id, { result: "satisfied", decidedBy: "pm" }])),
        "every-requirement-testable": { result: "not-satisfied", decidedBy: "pm", reason: "REQ-0001 has no observable pass condition." } },
    });
    assert.ok(failed.gateFindings.some((f) => f.ruleId === "gate/criterion-not-satisfied"));
    assert.equal(failed.ready, false);

    // n/a needs a reason, per #45's shape.
    const naNoReason = evaluateStageGate(ctx, "02-intent-decomposition", {
      attestations: { ...Object.fromEntries(gate.pendingHumanCriteria.map((id) => [id, { result: "satisfied", decidedBy: "pm" }])),
        "scope-boundary-drawn": { result: "n/a", decidedBy: "pm" } },
    });
    assert.ok(naNoReason.gateFindings.some((f) => f.ruleId === "gate/attestation-unjustified"));

    const naWithReason = evaluateStageGate(ctx, "02-intent-decomposition", {
      attestations: { ...Object.fromEntries(gate.pendingHumanCriteria.map((id) => [id, { result: "satisfied", decidedBy: "pm" }])),
        "scope-boundary-drawn": { result: "n/a", decidedBy: "pm", reason: "Single-surface project; no boundary to draw." } },
    });
    assert.equal(naWithReason.ready, true);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("#92: stage definitions enforce only what the source table NAMES", () => {
  const defs = JSON.parse(JSON.stringify(STAGE_DEFS)); // unused; read the real files instead
  const real = loadStageDefinitions(ROOT);
  // "explicit non-goals" is an output; scope-boundary is a catalogue type someone inferred.
  assert.deepEqual(real["02-intent-decomposition"].produces, ["requirement"]);
  assert.ok(real["02-intent-decomposition"].producesCandidates.some((c) => c.type === "scope-boundary"));
  assert.deepEqual(real["08-implementation-plan"].produces, ["task"]);
  assert.ok(real["08-implementation-plan"].producesCandidates.some((c) => c.type === "role-assignment"));
  // Every candidate carries where it came from, so the inference is visible.
  for (const d of Object.values(real))
    for (const c of d.producesCandidates) {
      assert.ok(c.from, `${d.id}: candidate ${c.type} has no provenance`);
      assert.ok(c.note, `${d.id}: candidate ${c.type} has no note`);
    }
});

test("#94: against the REAL activation set, an unimplemented type is a capability gap", () => {
  // The previous version of this test ran with activated = every type that has a schema, so it
  // could never see the case it claimed to cover. Use what the PM actually approved.
  const { base, contentRoot, ctx } = fresh();
  try {
    const activated = readActivatedTypes(join(ROOT, "planning-content"));
    assert.ok(activated.length >= 8, `expected the approved set, got ${JSON.stringify(activated)}`);
    assert.ok(activated.includes("research-finding"), "the approved set should include an unimplemented type");

    const real = { ...ctx, activated };
    const gate = evaluateStageGate(real, "03-discovery");
    const byRule = (id) => gate.gateFindings.filter((f) => f.ruleId === id);

    const gap = byRule("gate/type-not-implemented").find((f) => f.details.type === "research-finding");
    assert.ok(gap, JSON.stringify(gate.gateFindings, null, 2));
    assert.equal(gap.severity, SEVERITY.ERROR);
    assert.deepEqual(gap.details.missing, ["schema", "typed tool"]);

    // ...and the two never fire together for the same type.
    assert.equal(
      byRule("gate/no-artifacts-for-stage-type").filter((f) => f.details.type === "research-finding").length,
      0,
      "a type that cannot exist must not also be reported as having no artifacts"
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("#94: a partial capability gap names only what is missing", () => {
  const { base, contentRoot, ctx } = fresh();
  try {
    // ⚠️ No type in the REAL activation set is a partial gap any more — decision gained its typed
    // tool, and schema/api-spec have schemas but are not activated so the gate skips them. The
    // partial case is constructed rather than borrowed, because borrowing it from live content is
    // what made this test go stale the moment the gap was closed.
    const activated = ["requirement", "schema", "question"];
    const defs = { "05-solution-design": { id: "05-solution-design", produces: ["schema", "api-spec"] } };
    const gate = evaluateStageGate({ ...ctx, activated }, "05-solution-design", { stageDefinitions: defs });

    // schema HAS a schema and no typed tool: only the tool is missing.
    const partial = gate.gateFindings.find((f) => f.ruleId === "gate/type-not-implemented" && f.details.type === "schema");
    assert.deepEqual(partial?.details.missing, ["typed tool"], JSON.stringify(gate.gateFindings));

    // api-spec is not activated here, so it reports nothing at all.
    assert.equal(gate.gateFindings.some((f) => f.details.type === "api-spec"), false);

    // And the both-missing case still has a home: runbook, from the real definitions.
    const g9 = evaluateStageGate({ ...ctx, activated: readActivatedTypes(join(ROOT, "planning-content")) }, "09-handoff");
    const rb = g9.gateFindings.find((f) => f.ruleId === "gate/type-not-implemented" && f.details.type === "runbook");
    assert.deepEqual(rb?.details.missing, ["schema", "typed tool"]);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("#94: an implemented, activated type with no artifacts still reports no-artifacts", () => {
  const { base, contentRoot, ctx } = fresh();
  try {
    // requirement has both a schema and a typed tool; this content root is empty.
    const gate = evaluateStageGate({ ...ctx, activated: ["requirement"] }, "02-intent-decomposition");
    const f = gate.gateFindings.find((x) => x.ruleId === "gate/no-artifacts-for-stage-type");
    assert.ok(f, "the ordinary unfinished-work finding must survive");
    assert.equal(f.details.type, "requirement");
    assert.equal(gate.gateFindings.filter((x) => x.ruleId === "gate/type-not-implemented").length, 0);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("#39: one reader for the approved activation set, shared by the CLI and the tests", () => {
  const activated = readActivatedTypes(join(ROOT, "planning-content"));
  assert.deepEqual(
    [...activated].sort(),
    ["assertion", "decision", "evidence", "question", "requirement", "research-finding", "runbook", "runbook-step"],
    "should match what stage 2 approved in project.yaml"
  );
  assert.ok(!activated.includes("schema") && !activated.includes("api-spec"), "stage 2 deliberately did not activate these");
  assert.deepEqual(readActivatedTypes(tmpdir()), [], "absent manifest yields no activation, never a guess");
});

test("#107: a stage may not claim to produce a type the catalogue does not contain", () => {
  const { base, contentRoot, ctx } = fresh();
  try {
    // The quiet contradiction: a type dropped from #38 but left in a stage's produces[].
    // Deactivating it would make the gate skip it while the methodology still claims it.
    const orphaned = {
      "03-discovery": { id: "03-discovery", produces: ["research-finding", "field-notebook"] },
    };
    const f = lintProject({ ...ctx, stageDefinitions: orphaned }).findings
      .filter((x) => x.ruleId === "stage/produces-unknown-type");
    assert.equal(f.length, 1, JSON.stringify(f));
    assert.equal(f[0].details.type, "field-notebook");
    assert.equal(f[0].severity, SEVERITY.ERROR);

    // The real definitions must not trip it.
    assert.deepEqual(
      lintProject(ctx).findings.filter((x) => x.ruleId === "stage/produces-unknown-type"),
      []
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
