/**
 * Derived orchestrator state — TSK-0048 (G2), toward ACC-0068.
 *
 * ⚠️ **THE EXPECTATIONS COME FROM THE ENGINES THIS MODULE REUSES.** Where a test needs to know which stage is
 * not ready, or what a gate found, it asks `evaluateStageGate` and `lintProject` directly and compares. The
 * module is judged on what it adds - selection, order, freshness and one next action - not on restating a
 * gate rule the test would then have to restate too.
 *
 * ⚠️ **EVERY FIXTURE CARRIES A DECOY STORED STATUS.** `state/current-stage.json` and a `currentStage` line in
 * `project.yaml` claim the project is complete at Stage 9. A derivation that read either would agree with
 * the decoy instead of the attestations.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs, { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { readActivatedTypes } from "../lib/activation.mjs";
import { evaluateStageGate, lintProject } from "../lib/lint.mjs";
import { NEXT_ACTION, ORCHESTRATOR_STATE_REFUSAL, OrchestratorStateError, deriveOrchestratorState } from "../lib/orchestrator-state.mjs";
import { loadSchemaSet } from "../lib/schema-resolver.mjs";
import { loadStageDefinitions, StageDefinitionError } from "../lib/stages.mjs";
import { createValidators } from "../lib/validate.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const schemas = loadSchemaSet(join(ROOT, "schemas"));
const validators = createValidators(join(ROOT, "schemas"));
const DEFS = loadStageDefinitions(ROOT);
const STAGE_IDS = Object.keys(DEFS).sort();
const criteriaOf = (stageId) => DEFS[stageId].exitCriteria.map((c) => c.id);

const env = (id, type, extra) => ({ id, type, schemaVersion: 2, reviewStatus: "approved", lifecycle: "active", title: id, ...extra });

/**
 * An initialised-looking project: manifest, starter document, a data directory, the decoy stored status, and
 * whatever artifacts and attestations the case gives it.
 */
function project({ activated = [], artifacts = {}, attestations = {} } = {}) {
  const base = mkdtempSync(join(tmpdir(), "kiln-orch-state-"));
  try {
    const contentRoot = join(base, "planning-content");
    mkdirSync(join(contentRoot, "data"), { recursive: true });
    mkdirSync(join(contentRoot, "stages"), { recursive: true });
    mkdirSync(join(contentRoot, "state"), { recursive: true });
    writeFileSync(
      join(contentRoot, "project.yaml"),
      `name: "fixture"\ndescription: "A project."\ncurrentStage: "09-handoff"\ncapabilities:\n  artifactTypes:\n    activated: [${activated.join(", ")}]\n`
    );
    writeFileSync(join(contentRoot, "stages", "01-intake.md"), "# Stage 01 - Intake\n\n> **Starter document.**\n");
    writeFileSync(join(contentRoot, "state", "current-stage.json"), JSON.stringify({ currentStage: "09-handoff", complete: true }));

    for (const [rel, doc] of Object.entries(artifacts)) {
      mkdirSync(dirname(join(contentRoot, rel)), { recursive: true });
      writeFileSync(join(contentRoot, rel), typeof doc === "string" ? doc : JSON.stringify(doc, null, 2));
    }
    for (const [stageId, entries] of Object.entries(attestations)) writeAttestations(contentRoot, stageId, entries);

    const ctx = { contentRoot, schemas, validators, activated: readActivatedTypes(contentRoot) };
    return { base, contentRoot, ctx };
  } catch (e) {
    rmSync(base, { recursive: true, force: true });
    throw e;
  }
}

function writeAttestations(contentRoot, stageId, entries) {
  mkdirSync(join(contentRoot, "state", "stage-attestations"), { recursive: true });
  writeFileSync(join(contentRoot, "state", "stage-attestations", `${stageId}.json`), JSON.stringify({ stageId, attestations: entries }, null, 2));
}

const allNa = (stageId) =>
  Object.fromEntries(criteriaOf(stageId).map((c) => [c, { result: "n/a", decidedBy: "operator", reason: "not needed in this fixture" }]));
const allSatisfied = (stageId) => Object.fromEntries(criteriaOf(stageId).map((c) => [c, { result: "satisfied", decidedBy: "operator" }]));

const derive = (f, opts = {}) => deriveOrchestratorState(f.ctx, { toolRoot: ROOT, ...opts });

/** The first stage the existing gate says is not ready, asked of the gate itself. */
function firstNotReadyByGate(f) {
  const lint = lintProject({ ...f.ctx, stageDefinitions: DEFS });
  for (const id of STAGE_IDS) {
    const raw = join(f.contentRoot, "state", "stage-attestations", `${id}.json`);
    const attestations = fs.existsSync(raw) ? JSON.parse(readFileSync(raw, "utf8")).attestations : {};
    const gate = evaluateStageGate(f.ctx, id, { lint, stageDefinitions: DEFS, attestations });
    if (!gate.ready) return { id, gate };
  }
  return null;
}

function snapshot(root) {
  const out = {};
  const walk = (p) => {
    for (const name of readdirSync(p).sort()) {
      const full = join(p, name);
      const st = statSync(full);
      out[full] = st.isDirectory() ? { dir: true, mtimeMs: st.mtimeMs } : { bytes: readFileSync(full).toString("base64"), mtimeMs: st.mtimeMs };
      if (st.isDirectory()) walk(full);
    }
  };
  walk(root);
  return out;
}

/** No absolute path of the fixture, the temporary directory or the home directory appears anywhere in a result. */
function assertNoMachinePath(result, f) {
  const text = JSON.stringify(result);
  for (const root of [f.base, f.contentRoot, resolve(tmpdir()), homedir()]) {
    for (const spelling of [root, root.replace(/\\/g, "/"), JSON.stringify(root).slice(1, -1)])
      assert.equal(text.includes(spelling), false, `the result contains a machine path: ${spelling}`);
  }
}

/* ============================================================================ selection */

test("⚠️ ACC-0068 a fresh project is fresh and selects Stage 1, whatever its starter documents and decoy status say", () => {
  const f = project();
  try {
    const state = derive(f);
    assert.equal(state.fresh, true);
    assert.equal(state.complete, false);
    assert.deepEqual(state.currentStage, { id: "01-intake", name: DEFS["01-intake"].name, decidedBy: DEFS["01-intake"].decidedBy });
    assert.deepEqual(
      state.blockers.map((b) => [b.source, b.ruleId, b.criterion]),
      criteriaOf("01-intake").map((c) => ["gate", "gate/criterion-pending-human", c]),
      "every Stage 1 criterion is pending, in definition order"
    );
    assert.deepEqual(state.nextAction, {
      kind: NEXT_ACTION.WORK_TOWARD_CRITERION,
      stageId: "01-intake",
      ruleId: "gate/criterion-pending-human",
      artifactId: null,
      path: null,
      criterion: criteriaOf("01-intake")[0],
      type: null,
    });
    assertNoMachinePath(state, f);
  } finally {
    rmSync(f.base, { recursive: true, force: true });
  }
});

test("⚠️ ACC-0068 a partly completed project selects the first stage its gate reports not ready", () => {
  const f = project({ attestations: { "01-intake": allSatisfied("01-intake"), "02-intent-decomposition": allNa("02-intent-decomposition") } });
  try {
    const state = derive(f);
    const byGate = firstNotReadyByGate(f);
    assert.equal(state.fresh, false, "attestations make it non-fresh");
    assert.equal(state.currentStage.id, byGate.id);
    assert.equal(state.currentStage.id, "03-discovery");
    assert.deepEqual(
      state.blockers.map((b) => b.criterion),
      byGate.gate.gateFindings.map((g) => g.details.criterion),
      "the blockers are that gate's own findings"
    );
  } finally {
    rmSync(f.base, { recursive: true, force: true });
  }
});

test("⚠️ ACC-0068 a stage attested n/a is ready exactly when the gate says so, and an unjustified n/a is not", () => {
  const justified = project({ attestations: { "01-intake": allNa("01-intake") } });
  const unjustified = project({
    attestations: { "01-intake": { ...allNa("01-intake"), [criteriaOf("01-intake")[1]]: { result: "n/a", decidedBy: "operator" } } },
  });
  try {
    assert.equal(derive(justified).currentStage.id, firstNotReadyByGate(justified).id);
    assert.equal(derive(justified).currentStage.id, "02-intent-decomposition", "justified n/a lets Stage 1 pass");

    const state = derive(unjustified);
    assert.equal(state.currentStage.id, firstNotReadyByGate(unjustified).id);
    assert.equal(state.currentStage.id, "01-intake");
    assert.equal(state.blockers[0].ruleId, "gate/attestation-unjustified");
    assert.equal(state.nextAction.kind, NEXT_ACTION.RAISE_WITH_OPERATOR, "a flawed attestation is the operator's to correct");
  } finally {
    rmSync(justified.base, { recursive: true, force: true });
    rmSync(unjustified.base, { recursive: true, force: true });
  }
});

test("⚠️ ACC-0068 an unsatisfied criterion comes before the unevaluated ones, and recommends revisiting it", () => {
  const [first, second, third] = criteriaOf("01-intake");
  const f = project({ attestations: { "01-intake": { [third]: { result: "not-satisfied", decidedBy: "operator", reason: "constraints missing" } } } });
  try {
    const state = derive(f);
    assert.equal(state.currentStage.id, "01-intake");
    assert.deepEqual(state.blockers[0].ruleId, "gate/criterion-not-satisfied");
    assert.equal(state.blockers[0].criterion, third);
    assert.deepEqual(state.blockers.slice(1).map((b) => b.criterion), [first, second, criteriaOf("01-intake")[3]], "the rest keep definition order");
    assert.equal(state.nextAction.kind, NEXT_ACTION.REVISIT_CRITERION);
    assert.equal(state.nextAction.criterion, third);
  } finally {
    rmSync(f.base, { recursive: true, force: true });
  }
});

test("⚠️ ACC-0068 an unevaluated criterion recommends working toward it, and no next action attests or approves", () => {
  for (const kind of Object.values(NEXT_ACTION)) assert.doesNotMatch(kind, /attest|approv/i, `${kind} names an operator decision`);

  const f = project({ attestations: { "01-intake": allNa("01-intake") } });
  try {
    const state = derive(f);
    assert.equal(state.blockers.every((b) => b.ruleId === "gate/criterion-pending-human"), true);
    assert.equal(state.nextAction.kind, NEXT_ACTION.WORK_TOWARD_CRITERION);
    assert.equal(state.nextAction.criterion, criteriaOf("02-intent-decomposition")[0]);
  } finally {
    rmSync(f.base, { recursive: true, force: true });
  }
});

test("⚠️ ACC-0068 an activated type nothing can author is a capability gap, recommended before any criterion", () => {
  const attestations = Object.fromEntries(["01-intake", "02-intent-decomposition", "03-discovery", "04-requirement-gaps"].map((s) => [s, allNa(s)]));
  const f = project({ activated: ["api-spec"], attestations });
  try {
    const state = derive(f);
    const byGate = firstNotReadyByGate(f);
    assert.equal(state.currentStage.id, byGate.id);
    assert.equal(state.currentStage.id, "05-solution-design");
    assert.equal(state.blockers[0].ruleId, "gate/type-not-implemented");
    assert.equal(state.blockers[0].type, "api-spec");
    assert.ok(state.blockers[0].missing.includes("typed tool"));
    assert.deepEqual(state.nextAction, {
      kind: NEXT_ACTION.RECORD_CAPABILITY_GAP,
      stageId: "05-solution-design",
      ruleId: "gate/type-not-implemented",
      artifactId: null,
      path: null,
      criterion: null,
      type: "api-spec",
    });
  } finally {
    rmSync(f.base, { recursive: true, force: true });
  }
});

test("⚠️ ACC-0068 a project-wide lint error blocks the first stage it reaches, and comes first with a relative path", () => {
  const f = project({
    activated: ["requirement"],
    attestations: { "01-intake": allNa("01-intake") },
    artifacts: {
      // Stored under one id and declaring another, with a whitespace-only statement: two lint errors from
      // ONE record, which lint emits storage-first and the canonical order puts content-first. Their order
      // therefore depends on the sort, never on how a filesystem lists directories.
      "data/requirements/REQ-0001.json": env("REQ-0002", "requirement", { statement: "   ", priority: "must" }),
      "data/requirements/REQ-0003.json": "{ not json",
    },
  });
  try {
    const state = derive(f);
    const byGate = firstNotReadyByGate(f);
    assert.equal(state.fresh, false);
    assert.equal(state.currentStage.id, "01-intake", "Stage 1 is attested, and the lint error still blocks it");
    assert.equal(state.currentStage.id, byGate.id);

    const lintBlockers = state.blockers.filter((b) => b.source === "lint");
    assert.equal(lintBlockers.length, byGate.gate.blockingArtifactFindings.length, "every blocking lint finding, and only those");
    assert.ok(lintBlockers.length >= 2, "the fixture produces more than one lint blocker, so their order means something");
    const firstGate = state.blockers.findIndex((b) => b.source === "gate");
    assert.ok(firstGate === -1 || firstGate === lintBlockers.length, "every lint blocker comes before every gate blocker");
    for (const b of lintBlockers) assert.match(b.path, /^data\/requirements\/REQ-000[13]\.json$/, "paths are relative to the content root");

    // Field by field, by code unit: path, then rule, then artifact. (The message breaks remaining ties inside
    // the module and is not in the result, so it cannot be compared here.)
    const byUnit = (x, y) => (x < y ? -1 : x > y ? 1 : 0);
    const keyOf = (b) => [b.path ?? "", b.ruleId ?? "", b.artifactId ?? ""];
    const sorted = [...lintBlockers].sort((a, b) => {
      const ka = keyOf(a);
      const kb = keyOf(b);
      for (let i = 0; i < ka.length; i++) if (byUnit(ka[i], kb[i]) !== 0) return byUnit(ka[i], kb[i]);
      return 0;
    });
    assert.deepEqual(lintBlockers, sorted, "lint blockers are in path, rule, artifact and message order");
    assert.notDeepEqual(
      byGate.gate.blockingArtifactFindings.map((g) => `${g.path} ${g.ruleId}`),
      lintBlockers.map((b) => `${b.path} ${b.ruleId}`),
      "the fixture's lint order really differs from the canonical order, so the sort is exercised"
    );
    assert.equal(lintBlockers[0].ruleId, "content/hollow-value", "within one record, rule order decides");
    assert.equal(state.nextAction.kind, NEXT_ACTION.RESOLVE_FINDING);
    assert.equal(state.nextAction.path, lintBlockers[0].path);
    assertNoMachinePath(state, f);
  } finally {
    rmSync(f.base, { recursive: true, force: true });
  }
});

test("⚠️ ACC-0068 lint blockers precede the stage's own gate findings, and decide the next action", () => {
  const f = project({
    activated: ["requirement"],
    artifacts: { "data/requirements/REQ-0001.json": env("REQ-0002", "requirement", { statement: "The thing must work.", priority: "must" }) },
  });
  try {
    const state = derive(f);
    const lintCount = state.blockers.filter((b) => b.source === "lint").length;
    const gateCount = state.blockers.filter((b) => b.source === "gate").length;
    assert.equal(state.currentStage.id, "01-intake");
    assert.ok(lintCount >= 1 && gateCount === criteriaOf("01-intake").length, `both kinds are present: ${lintCount} lint, ${gateCount} gate`);
    assert.deepEqual(
      state.blockers.map((b) => b.source),
      [...Array(lintCount).fill("lint"), ...Array(gateCount).fill("gate")],
      "every lint blocker comes before every gate finding"
    );
    assert.equal(state.nextAction.kind, NEXT_ACTION.RESOLVE_FINDING, "an invalid artifact is dealt with before any criterion");
  } finally {
    rmSync(f.base, { recursive: true, force: true });
  }
});

test("⚠️ ACC-0068 a typed artifact alone makes a project non-fresh", () => {
  const f = project({
    activated: ["requirement"],
    artifacts: { "data/requirements/REQ-0001.json": env("REQ-0001", "requirement", { statement: "The thing must work.", priority: "must" }) },
  });
  try {
    assert.equal(fs.existsSync(join(f.contentRoot, "state", "stage-attestations")), false, "no attestation exists");
    const state = derive(f);
    assert.equal(state.fresh, false, "an artifact with no attestation is still not fresh");
    assert.equal(state.currentStage.id, "01-intake");
  } finally {
    rmSync(f.base, { recursive: true, force: true });
  }
});

test("⚠️ ACC-0068 when every stage gate is ready the project is complete, with no current stage and no next action", () => {
  const f = project({ attestations: Object.fromEntries(STAGE_IDS.map((s) => [s, allNa(s)])) });
  try {
    assert.equal(firstNotReadyByGate(f), null, "the gate itself calls every stage ready");
    assert.deepEqual(derive(f), { fresh: false, complete: true, currentStage: null, blockers: [], nextAction: null });
  } finally {
    rmSync(f.base, { recursive: true, force: true });
  }
});

test("⚠️ F103 no finding message crosses into the result, so planted credentials and absolute paths stay out of it", () => {
  const SECRET = "sk-ant-api03-PLANTED-CREDENTIAL-0000000000";
  const WINDOWS_PATH = "C:\\Users\\operator\\secrets\\token.txt";
  const POSIX_PATH = "/home/operator/secrets/token.txt";

  const f = project({
    activated: ["requirement"],
    artifacts: {
      // Lint quotes a parse error, and the parse error quotes the file.
      "data/requirements/REQ-0009.json": `${SECRET} ${POSIX_PATH} ${WINDOWS_PATH.replace(/\\/g, "\\\\")} {`,
    },
  });
  const fixturePath = join(f.base, "planted", "absolute.txt");
  const [firstCriterion, ...rest] = DEFS["01-intake"].exitCriteria;
  // The gate quotes a criterion's description in its message.
  const planted = {
    ...DEFS,
    "01-intake": {
      ...DEFS["01-intake"],
      exitCriteria: [{ ...firstCriterion, describe: `Leaks ${SECRET} from ${WINDOWS_PATH}, ${POSIX_PATH} and ${fixturePath}.` }, ...rest],
    },
  };
  try {
    // The planted text really is in what the engines report, so its absence below means something.
    const lint = lintProject({ ...f.ctx, stageDefinitions: planted });
    const gate = evaluateStageGate(f.ctx, "01-intake", { lint, stageDefinitions: planted, attestations: {} });
    const engineText = JSON.stringify([gate.blockingArtifactFindings, gate.gateFindings]);
    assert.ok(engineText.includes(SECRET), "the engines' own messages carry the planted credential");
    assert.ok(engineText.includes(fixturePath.replace(/\\/g, "\\\\")) || engineText.includes(fixturePath), "and the planted absolute path");

    const state = derive(f, { stageDefinitions: planted });
    assert.equal(state.currentStage.id, "01-intake");
    assert.ok(state.blockers.some((b) => b.source === "lint") && state.blockers.some((b) => b.criterion === firstCriterion.id), "both planted sources are among the blockers");

    const text = JSON.stringify(state);
    for (const planted of [SECRET, WINDOWS_PATH, WINDOWS_PATH.replace(/\\/g, "\\\\"), POSIX_PATH, fixturePath, fixturePath.replace(/\\/g, "\\\\")])
      assert.equal(text.includes(planted), false, `the result carries planted text: ${planted}`);
    for (const b of state.blockers)
      assert.deepEqual(Object.keys(b).sort(), ["artifactId", "criterion", "missing", "path", "ruleId", "severity", "source", "stageId", "type"], "a blocker holds structured fields only");
    assertNoMachinePath(state, f);
  } finally {
    rmSync(f.base, { recursive: true, force: true });
  }
});

/* ============================================================================ derivation discipline */

test("⚠️ ACC-0068 repeated calls return identical data, change no bytes or modification times, and follow a state change", () => {
  const f = project();
  try {
    const before = snapshot(f.base);
    const results = [derive(f), derive(f), derive(f)];
    assert.deepEqual(results[1], results[0]);
    assert.deepEqual(results[2], results[0]);
    assert.deepEqual(snapshot(f.base), before, "deriving wrote, touched or created nothing");

    // Nothing was cached: the next call reads the attestation the operator just recorded.
    writeAttestations(f.contentRoot, "01-intake", allNa("01-intake"));
    const after = derive(f);
    assert.equal(after.fresh, false);
    assert.equal(after.currentStage.id, "02-intent-decomposition");
  } finally {
    rmSync(f.base, { recursive: true, force: true });
  }
});

test("⚠️ ACC-0068 the project is linted once per call, and that pass is shared by every stage gate", () => {
  const f = project({ attestations: Object.fromEntries(STAGE_IDS.slice(0, 4).map((s) => [s, allNa(s)])) });
  const dataDir = resolve(f.contentRoot, "data");
  const original = fs.readdirSync;
  let dataReads = 0;
  fs.readdirSync = function (path, ...rest) {
    if (typeof path === "string" && resolve(path) === dataDir) dataReads++;
    return original.call(this, path, ...rest);
  };
  syncBuiltinESMExports();
  try {
    const state = derive(f);
    assert.equal(state.currentStage.id, "05-solution-design", "five stage gates ran");
    assert.equal(dataReads, 1, "the artifacts were listed once, not once per stage");
  } finally {
    fs.readdirSync = original;
    syncBuiltinESMExports();
    rmSync(f.base, { recursive: true, force: true });
  }
});

test("⚠️ ACC-0068 stage order is canonical whatever order the definitions arrive in", () => {
  const f = project({ attestations: { "01-intake": allNa("01-intake") } });
  try {
    const reversed = Object.fromEntries([...STAGE_IDS].reverse().map((id) => [id, DEFS[id]]));
    assert.deepEqual(Object.keys(reversed)[0], "09-handoff", "the fixture really is reversed");
    assert.deepEqual(derive(f, { stageDefinitions: reversed }), derive(f, { stageDefinitions: DEFS }));
    assert.equal(derive(f, { stageDefinitions: reversed }).currentStage.id, "02-intent-decomposition");
  } finally {
    rmSync(f.base, { recursive: true, force: true });
  }
});

/* ============================================================================ refusals */

test("⚠️ ACC-0068 malformed or inconsistent inputs are refused by the existing boundaries", () => {
  const f = project();
  try {
    // The attestation loader's own refusal, unchanged.
    mkdirSync(join(f.contentRoot, "state", "stage-attestations"), { recursive: true });
    writeFileSync(join(f.contentRoot, "state", "stage-attestations", "02-intent-decomposition.json"), JSON.stringify({ stageId: "03-discovery", attestations: {} }));
    assert.throws(() => derive(f), /declare "03-discovery", expected "02-intent-decomposition"/);
    rmSync(join(f.contentRoot, "state", "stage-attestations"), { recursive: true });

    // The stage loader's own refusal, unchanged.
    const brokenTool = mkdtempSync(join(tmpdir(), "kiln-orch-stages-"));
    try {
      mkdirSync(join(brokenTool, "stages"));
      writeFileSync(join(brokenTool, "stages", "01-intake.json"), JSON.stringify({ id: "01-intake", exitCriteria: [] }));
      assert.throws(() => deriveOrchestratorState(f.ctx, { toolRoot: brokenTool }), StageDefinitionError);
    } finally {
      rmSync(brokenTool, { recursive: true, force: true });
    }

    // No definitions, or an empty set: nothing can be current, and nothing is complete (F104).
    for (const [label, stageDefinitions] of [
      ["null", null],
      ["an empty set", {}],
    ])
      assert.throws(
        () => deriveOrchestratorState(f.ctx, { stageDefinitions }),
        (e) => e instanceof OrchestratorStateError && e.reason === ORCHESTRATOR_STATE_REFUSAL.NO_DEFINITIONS,
        `${label} must refuse as missing definitions`
      );

    // A stage the gate calls not ready while reporting nothing: no next action can honestly be chosen.
    const undeclared = { ...DEFS, "01-intake": { ...DEFS["01-intake"], exitCriteria: undefined } };
    assert.throws(
      () => deriveOrchestratorState(f.ctx, { stageDefinitions: undeclared }),
      (e) => e instanceof OrchestratorStateError && e.reason === ORCHESTRATOR_STATE_REFUSAL.UNEXPLAINED_GATE && e.detail.stageId === "01-intake"
    );
  } finally {
    rmSync(f.base, { recursive: true, force: true });
  }
});
