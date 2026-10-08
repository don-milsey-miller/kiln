/**
 * A runbook step's class, and the project's threshold for it - #181.
 *
 * `project.yaml` carries a threshold for each class of action. Before #181 nothing read it: the lint chose between
 * two hard-coded rungs on a boolean, so a read-only inspection was held to the rung of a change, whatever the
 * project had configured. This file holds the whole of the replacement: the table's reader, the step's class and
 * where it comes from, the ladder check, the schema, the authoring and revision boundaries, and the lint that puts
 * them together.
 *
 * ⚠️ **EVERYTHING HERE FAILS CLOSED, AND THE TESTS SAY SO CASE BY CASE.** A table that cannot be read, a class that is
 * not one of the three, two fields that contradict each other and a rung nobody recognises each block. None of
 * them falls back to the mildest reading.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { ACTION_CLASSES, POLICY_RUNGS, THRESHOLD_FLOOR, readConfidenceThresholds, resolveActionClass, rungName } from "../lib/action-policy.mjs";
import { CONFIDENCE, mayBecomeInstruction } from "../lib/effective-assertion.mjs";
import { artifactRelPath } from "../lib/layout.mjs";
import { lintProject } from "../lib/lint.mjs";
import { loadSchemaSet } from "../lib/schema-resolver.mjs";
import { createAssertion, createEvidence, createRunbookStep, linkEvidence, reviseArtifact } from "../lib/tools/evidence-tools.mjs";
import { setReviewStatus } from "../lib/tools/review-status.mjs";
import { ValidationError, createValidators } from "../lib/validate.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCHEMAS = join(ROOT, "schemas");
const schemas = loadSchemaSet(SCHEMAS);
const validators = createValidators(SCHEMAS);
const ACTIVATED = ["requirement", "decision", "assertion", "evidence", "question", "runbook-step"];
const DEFAULTS = { informational: 2, mutating: 3, destructive: 4 };
const BLOCKED = { informational: null, mutating: null, destructive: null };

const manifest = (table) => `schemaVersion: 1\nname: fixture\ncapabilities:\n  artifactTypes:\n    activated: [${ACTIVATED.join(", ")}]\n${table}`;
const TABLE = (lines) => `confidence:\n  thresholds:\n${lines.map((line) => `    ${line}\n`).join("")}`;

function project(table = TABLE(["informational: 2", "mutating: 3", "destructive: 4"])) {
  const base = mkdtempSync(join(tmpdir(), "kiln-action-policy-"));
  const contentRoot = join(base, "planning-content");
  mkdirSync(contentRoot, { recursive: true });
  const write = (text) => writeFileSync(join(contentRoot, "project.yaml"), text);
  if (table !== null) write(manifest(table));
  const o = { contentRoot, schemasDir: SCHEMAS, validators, schemas };
  return {
    base,
    contentRoot,
    o,
    policy: (next) => write(manifest(next)),
    read: (id) => JSON.parse(readFileSync(join(contentRoot, artifactRelPath("runbook-step", id)), "utf-8")),
    /** Put a step on disk as a hand edit or an older Kiln would have left it. */
    store: (id, change) => {
      const path = join(contentRoot, artifactRelPath("runbook-step", id));
      writeFileSync(path, JSON.stringify(change(JSON.parse(readFileSync(path, "utf-8"))), null, 2) + "\n");
    },
    lint: () => lintProject({ contentRoot, schemas, validators, activated: ACTIVATED, stageDefinitions: null }).findings,
    remove: () => rmSync(base, { recursive: true, force: true }),
  };
}
const instruction = (findings, id) => findings.filter((f) => f.ruleId.startsWith("instruction/") && (id === undefined || f.artifactId === id));

const TARGET = { facts: { os: "RHEL 10", postgres: "17" } };
const EXPERIMENT = (facts) => ({
  title: "Ran it", kind: "experiment", summary: "Executed the procedure.",
  environment: { execution: "controller", sandboxTier: 2, isolationBoundary: { isolates: ["filesystem", "process", "network-namespace"], doesNotClaim: ["kernel-isolation"] }, facts }, observedAt: "2026-08-18", outcome: "success",
});
const SOURCE = { title: "Vendor documentation", kind: "source", summary: "The documentation says so.", sources: [{ title: "Vendor docs", locator: "https://example.test/docs" }] };
/** A supported assertion at the named rung: 2 from a source, 3 from an experiment, 4 from a matched one. */
async function claim(p, rung, title = "A fact") {
  const ast = await createAssertion({ title, statement: `${title}.`, targetEnvironment: TARGET }, p.o);
  if (rung >= 2) {
    const evidence = await createEvidence(rung === 2 ? SOURCE : EXPERIMENT(rung === 4 ? TARGET.facts : { os: "RHEL 10" }), p.o);
    await linkEvidence(ast.id, evidence.id, "support", p.o);
  }
  return ast.id;
}
const step = (p, actionClass, restsOn, extra = {}) =>
  createRunbookStep({ title: `A ${actionClass} step`, instruction: "Do it.", expectedOutcome: "Done.", actionClass, restsOn, ...(actionClass === "destructive" ? { remediation: "Restore from backup." } : {}), ...extra }, p.o);

/* ------------------------------------------------------------------ the threshold table */

test("⚠️ #181 the table is read from project.yaml: custom, partial and absent policies", () => {
  const cases = [
    ["the scaffold's own table", TABLE(["informational: 2", "mutating: 3", "destructive: 4"]), DEFAULTS],
    ["every class raised", TABLE(["informational: 3", "mutating: 4", "destructive: 5"]), { informational: 3, mutating: 4, destructive: 5 }],
    ["one class given: the others take their defaults", TABLE(["destructive: 5"]), { ...DEFAULTS, destructive: 5 }],
    ["rung 5 for every class", TABLE(["informational: 5", "mutating: 5", "destructive: 5"]), { informational: 5, mutating: 5, destructive: 5 }],
    ["no confidence section", "", DEFAULTS],
    ["a confidence section with no thresholds", "confidence:\n  note: none\n", DEFAULTS],
    ["an empty table", "confidence:\n  thresholds:\n", DEFAULTS],
    ["the inline form", "confidence:\n  thresholds: { informational: 2, mutating: 4, destructive: 4 }\n", { ...DEFAULTS, mutating: 4 }],
    ["comments, blank lines and a key after the table", `confidence:\n  # how sure\n  thresholds:   # per class\n    informational: 3   # raised\n\n    mutating: 3\n    destructive: 4\nother:\n  informational: 1\n`, { ...DEFAULTS, informational: 3 }],
    ["Windows line endings", TABLE(["informational: 2", "mutating: 4", "destructive: 4"]).replaceAll("\n", "\r\n"), { ...DEFAULTS, mutating: 4 }],
    ["quoted class names", TABLE(['"informational": 2', "'mutating': 3", "destructive: 4"]), DEFAULTS],
    ["tabs for indentation", "confidence:\n\tthresholds:\n\t\tinformational: 3\n", { ...DEFAULTS, informational: 3 }],
  ];
  for (const [name, table, expected] of cases) {
    const p = project(table);
    try {
      assert.deepEqual(readConfidenceThresholds(p.contentRoot), { thresholds: expected, problems: [] }, name);
    } finally {
      p.remove();
    }
  }
  // No manifest at all is a project that has configured nothing.
  const bare = project(null);
  try {
    assert.deepEqual(readConfidenceThresholds(bare.contentRoot), { thresholds: DEFAULTS, problems: [] });
  } finally {
    bare.remove();
  }
  assert.deepEqual(THRESHOLD_FLOOR, DEFAULTS);
});

test("⚠️ #181 a table that does not say what was meant blocks the class; it never defaults around a mistake", () => {
  const cases = [
    // Not a rung: the class is blocked and the others stand.
    ["zero", ["informational: 0"], { ...DEFAULTS, informational: null }, [{ problem: "not-a-rung", key: "informational", value: "0" }]],
    ["six", ["destructive: 6"], { ...DEFAULTS, destructive: null }, [{ problem: "not-a-rung", key: "destructive", value: "6" }]],
    ["a rung's name", ["informational: source-supported"], { ...DEFAULTS, informational: null }, [{ problem: "not-a-rung", key: "informational", value: "source-supported" }]],
    ["a fraction", ["mutating: 3.5"], { ...DEFAULTS, mutating: null }, [{ problem: "not-a-rung", key: "mutating", value: "3.5" }]],
    ["a negative", ["mutating: -3"], { ...DEFAULTS, mutating: null }, [{ problem: "not-a-rung", key: "mutating", value: "-3" }]],
    ["a quoted number", ['mutating: "3"'], { ...DEFAULTS, mutating: null }, [{ problem: "not-a-rung", key: "mutating", value: '"3"' }]],
    ["nothing", ["mutating:"], { ...DEFAULTS, mutating: null }, [{ problem: "not-a-rung", key: "mutating", value: "" }]],
    // ⚠️ BELOW THE FLOOR: a project may raise a threshold and may never lower one.
    ["informational lowered to 1", ["informational: 1"], { ...DEFAULTS, informational: null }, [{ problem: "below-floor", key: "informational", value: "1", floor: 2 }]],
    ["mutating lowered to 2", ["mutating: 2"], { ...DEFAULTS, mutating: null }, [{ problem: "below-floor", key: "mutating", value: "2", floor: 3 }]],
    ["destructive lowered to 3", ["destructive: 3"], { ...DEFAULTS, destructive: null }, [{ problem: "below-floor", key: "destructive", value: "3", floor: 4 }]],
    // A class given twice says two things, even when they agree.
    ["a duplicate", ["mutating: 3", "mutating: 4"], { ...DEFAULTS, mutating: null }, [{ problem: "duplicate-class", key: "mutating" }]],
    ["a duplicate that agrees", ["destructive: 4", "destructive: 4"], { ...DEFAULTS, destructive: null }, [{ problem: "duplicate-class", key: "destructive" }]],
    // ⚠️ A KEY THAT IS NOT A CLASS BLOCKS EVERY CLASS: it is most likely one of them misspelled, and which is not known.
    ["a misspelled class", ["informatonal: 2", "mutating: 3", "destructive: 4"], BLOCKED, [{ problem: "unknown-class", key: "informatonal" }]],
    ["a class Kiln does not have", ["informational: 2", "readonly: 1"], BLOCKED, [{ problem: "unknown-class", key: "readonly" }]],
    ["a class in capitals", ["Informational: 2"], BLOCKED, [{ problem: "unknown-class", key: "Informational" }]],
    // Several problems are each reported.
    ["two problems", ["informational: 9", "destructive: 2"], { ...DEFAULTS, informational: null, destructive: null }, [{ problem: "not-a-rung", key: "informational", value: "9" }, { problem: "below-floor", key: "destructive", value: "2", floor: 4 }]],
  ];
  for (const [name, lines, thresholds, problems] of cases) {
    const p = project(TABLE(lines));
    try {
      assert.deepEqual(readConfidenceThresholds(p.contentRoot), { thresholds, problems }, name);
    } finally {
      p.remove();
    }
  }
  for (const [name, table] of [
    ["two confidence sections", `${TABLE(["informational: 2"])}${TABLE(["informational: 3"])}`],
    ["two tables in one section", "confidence:\n  thresholds:\n    informational: 2\n  thresholds:\n    informational: 3\n"],
    ["an entry that is not a pair", TABLE(["informational"])],
    ["an inline value that is not a table", "confidence:\n  thresholds: 3\n"],
  ]) {
    const p = project(table);
    try {
      assert.deepEqual(readConfidenceThresholds(p.contentRoot), { thresholds: BLOCKED, problems: [{ problem: "malformed-table" }] }, name);
    } finally {
      p.remove();
    }
  }
});

/* ------------------------------------------------------------------ the step's class */

test("⚠️ #181 a step's class: declared, or read conservatively from the legacy field, or none at all", () => {
  for (const actionClass of ACTION_CLASSES) assert.deepEqual(resolveActionClass({ actionClass }), { actionClass, source: "declared" });
  // ⚠️ THE THREE LEGACY SHAPES. Nothing before #181 recorded that a step only inspects, so none is assumed to.
  assert.deepEqual(resolveActionClass({ destructive: true }), { actionClass: "destructive", source: "legacy-destructive" });
  assert.deepEqual(resolveActionClass({ destructive: false }), { actionClass: "mutating", source: "legacy-default" });
  assert.deepEqual(resolveActionClass({}), { actionClass: "mutating", source: "legacy-default" });
  // Tags and wording are not policy.
  assert.deepEqual(resolveActionClass({ destructive: false, tags: ["informational"], instruction: "Only inspect; read-only." }), { actionClass: "mutating", source: "legacy-default" });
  // Both fields, saying one thing.
  assert.deepEqual(resolveActionClass({ actionClass: "destructive", destructive: true }), { actionClass: "destructive", source: "declared" });
  assert.deepEqual(resolveActionClass({ actionClass: "informational", destructive: false }), { actionClass: "informational", source: "declared" });
  assert.deepEqual(resolveActionClass({ actionClass: "mutating", destructive: false }), { actionClass: "mutating", source: "declared" });
  // ⚠️ CONTRADICTION AND AN UNKNOWN CLASS RESOLVE TO NOTHING.
  for (const doc of [{ actionClass: "informational", destructive: true }, { actionClass: "mutating", destructive: true }, { actionClass: "destructive", destructive: false }])
    assert.deepEqual(resolveActionClass(doc), { actionClass: null, source: "conflict" }, JSON.stringify(doc));
  for (const doc of [{ actionClass: "read-only" }, { actionClass: "Informational" }, { actionClass: "" }, { actionClass: null }, { actionClass: 2 }, { actionClass: ["informational"] }, { destructive: "yes" }, { destructive: null }, { destructive: 1 }])
    assert.deepEqual(resolveActionClass(doc), { actionClass: null, source: "unknown" }, JSON.stringify(doc));
});

/* ------------------------------------------------------------------ the ladder */

test("⚠️ #181 the whole ladder: five rungs may be required, four can be held, and an unknown rung refuses", () => {
  assert.deepEqual(POLICY_RUNGS, [...CONFIDENCE, "production-validated"]);
  assert.deepEqual([1, 2, 3, 4, 5].map(rungName), POLICY_RUNGS);
  for (const notARung of [0, 6, -1, 2.5, "2", null, undefined, NaN]) assert.equal(rungName(notARung), null, String(notARung));

  for (const [required, minimumConfidence] of POLICY_RUNGS.entries())
    for (const [held, confidence] of CONFIDENCE.entries()) {
      const decision = mayBecomeInstruction({ verdict: "supported", confidence }, { minimumConfidence });
      assert.equal(decision.allowed, held >= required, `${confidence} against ${minimumConfidence}`);
      if (!decision.allowed) assert.equal(decision.because, "below-threshold");
    }
  // ⚠️ RUNG 5 IS KNOWN AND UNREACHABLE: every confidence Kiln can derive is below it, and the reason says so.
  for (const confidence of CONFIDENCE) {
    const decision = mayBecomeInstruction({ verdict: "supported", confidence }, { minimumConfidence: "production-validated" });
    assert.deepEqual([decision.allowed, decision.because], [false, "below-threshold"]);
    assert.ok(decision.detail.endsWith("No evidence Kiln records can reach that rung."));
  }
  // ⚠️ THE DEFECT: a minimum that is not on the ladder used to allow everything, `unverified` included.
  for (const minimumConfidence of ["no-such-rung", "Production-Validated", "", 2, 5, null, {}])
    for (const confidence of CONFIDENCE)
      assert.deepEqual(
        (({ allowed, because }) => [allowed, because])(mayBecomeInstruction({ verdict: "supported", confidence }, { minimumConfidence })),
        [false, "threshold-unknown"],
        `${confidence} against ${JSON.stringify(minimumConfidence)}`
      );
  // And a confidence that is not on the ladder is not ranked either, whatever is required.
  for (const confidence of ["production-validated", "certain", undefined, 4])
    for (const minimumConfidence of POLICY_RUNGS) assert.equal(mayBecomeInstruction({ verdict: "supported", confidence }, { minimumConfidence }).because, "confidence-unknown");
  // The default minimum, and the verdicts that block at any rung, are as they were.
  assert.equal(mayBecomeInstruction({ verdict: "supported", confidence: "source-supported" }).because, "below-threshold");
  assert.equal(mayBecomeInstruction({ verdict: "supported", confidence: "experimentally-validated" }).allowed, true);
  for (const verdict of ["contested", "refuted", "unresolved"]) assert.equal(mayBecomeInstruction({ verdict, confidence: "environment-matched" }, { minimumConfidence: "unverified" }).because, verdict);
});

/* ------------------------------------------------------------------ the schema */

test("⚠️ #181 the schema: three classes, the destructive floor for both ways of being destructive, and no contradiction", () => {
  const valid = validators["runbook-step"];
  const base = { id: "RBS-0001", type: "runbook-step", schemaVersion: 1, title: "t", reviewStatus: "draft", lifecycle: "active", instruction: "Do", expectedOutcome: "Done" };
  assert.ok(valid(base), JSON.stringify(valid.errors));

  for (const actionClass of ["informational", "mutating"]) assert.ok(valid({ ...base, actionClass }), actionClass);
  for (const actionClass of ["read-only", "Informational", "", null, 2]) assert.equal(valid({ ...base, actionClass }), false, `actionClass ${JSON.stringify(actionClass)} was accepted`);

  // #58's floor, for a declared destructive step and for a legacy one alike.
  for (const how of [{ actionClass: "destructive" }, { destructive: true }, { actionClass: "destructive", destructive: true }]) {
    assert.equal(valid({ ...base, ...how }), false, `${JSON.stringify(how)} with no remediation`);
    assert.equal(valid({ ...base, ...how, remediation: "Restore", restsOn: [] }), false, `${JSON.stringify(how)} with no backing claim`);
    assert.equal(valid({ ...base, ...how, restsOn: ["AST-0001"] }), false, `${JSON.stringify(how)} with a claim and no remediation`);
    assert.ok(valid({ ...base, ...how, remediation: "Restore", restsOn: ["AST-0001"] }), JSON.stringify(how));
  }
  // A step that is not destructive owes neither.
  for (const how of [{ actionClass: "informational" }, { actionClass: "mutating" }, { destructive: false }, { actionClass: "mutating", destructive: false }]) assert.ok(valid({ ...base, ...how }), JSON.stringify(how));

  // ⚠️ A STORED STEP THAT CARRIES BOTH FIELDS MUST NOT CONTRADICT ITSELF.
  const whole = { remediation: "Restore", restsOn: ["AST-0001"] };
  for (const conflict of [{ actionClass: "informational", destructive: true }, { actionClass: "mutating", destructive: true }, { actionClass: "destructive", destructive: false }])
    assert.equal(valid({ ...base, ...whole, ...conflict }), false, `${JSON.stringify(conflict)} was accepted`);
  assert.equal(valid({ ...base, destructive: "yes" }), false);
});

/* ------------------------------------------------------------------ the lint */

test("⚠️ #181 the reported case: eight tagged, source-supported inspections are blocked as legacy steps, and pass once each is classified", async () => {
  const p = project();
  try {
    const ids = [];
    for (let i = 1; i <= 8; i++) {
      const created = await step(p, "mutating", [await claim(p, 2, `Setting ${i} is reported without being changed`)], { tags: ["informational"] });
      // As the reporting project stored them: `destructive: false`, the word in a tag, and no class.
      p.store(created.id, ({ actionClass, ...doc }) => ({ ...doc, destructive: false }));
      ids.push(created.id);
    }
    // The same kind of claim under a change and under a destructive step.
    const mutating = await step(p, "mutating", [await claim(p, 2, "Restarting is safe")]);
    const destructive = await step(p, "destructive", [await claim(p, 2, "The directory is disposable")]);

    // ⚠️ BEFORE CLASSIFICATION, EXACTLY THE EIGHT FINDINGS THE ISSUE REPORTS. A tag was never policy.
    const before = instruction(p.lint());
    assert.equal(before.filter((f) => ids.includes(f.artifactId)).length, 8);
    for (const f of before.filter((x) => ids.includes(x.artifactId))) {
      assert.equal(f.ruleId, "instruction/rests-on-below-threshold");
      assert.deepEqual(
        [f.details.actionClass, f.details.actionClassSource, f.details.configuredThreshold, f.details.requiredConfidence, f.details.confidence],
        ["mutating", "legacy-default", 3, "experimentally-validated", "source-supported"]
      );
    }

    // Each is classified by an explicit revision. Nothing is migrated for them.
    for (const id of ids) await reviseArtifact("runbook-step", id, { actionClass: "informational" }, p.o);
    const after = instruction(p.lint());
    assert.deepEqual(after.filter((f) => ids.includes(f.artifactId)), [], "a source-supported inspection is still blocked at an informational threshold of 2");

    // ⚠️ AND THE CHANGE AND THE DESTRUCTIVE STEP ARE STILL BLOCKED, each at its own class's rung.
    const m = after.filter((f) => f.artifactId === mutating.id);
    const d = after.filter((f) => f.artifactId === destructive.id);
    assert.deepEqual([m.length, d.length, after.length], [1, 1, 2]);
    assert.deepEqual([m[0].details.actionClass, m[0].details.actionClassSource, m[0].details.configuredThreshold, m[0].details.requiredConfidence, m[0].details.confidence], ["mutating", "declared", 3, "experimentally-validated", "source-supported"]);
    assert.deepEqual([d[0].details.actionClass, d[0].details.actionClassSource, d[0].details.configuredThreshold, d[0].details.requiredConfidence, d[0].details.confidence], ["destructive", "declared", 4, "environment-matched", "source-supported"]);
    assert.ok(m[0].message.includes("The step is mutating (declared), and this project's threshold for that class is rung 3, experimentally-validated."));
    assert.deepEqual(p.lint().filter((f) => f.ruleId.startsWith("manifest/")), []);
  } finally {
    p.remove();
  }
});

test("⚠️ #181 all three classes against default, raised and rung-5 policies, each premise at each rung", async () => {
  const p = project();
  try {
    // One step of each class on a claim at each rung a claim can hold.
    const steps = [];
    for (const actionClass of ACTION_CLASSES)
      for (const rung of [1, 2, 3, 4]) {
        // A destructive step's premise must exist; an unverified one is still an assertion.
        const created = await step(p, actionClass, [await claim(p, rung, `${actionClass} at ${rung}`)]);
        steps.push({ id: created.id, actionClass, rung });
      }
    const blockedUnder = (thresholds) => {
      const findings = instruction(p.lint());
      for (const s of steps) {
        const mine = findings.filter((f) => f.artifactId === s.id);
        // Rung 1 is an assertion nothing bears on: it blocks as unresolved at any threshold.
        const expected = s.rung === 1 ? "instruction/rests-on-unresolved" : s.rung < thresholds[s.actionClass] ? "instruction/rests-on-below-threshold" : null;
        assert.deepEqual(mine.map((f) => f.ruleId), expected ? [expected] : [], `${s.actionClass} on a rung-${s.rung} claim under ${JSON.stringify(thresholds)}`);
        for (const f of mine) {
          // ⚠️ EVERY BLOCKING FINDING CARRIES THE FIVE.
          assert.deepEqual(
            [f.details.actionClass, f.details.actionClassSource, f.details.configuredThreshold, f.details.requiredConfidence, f.details.confidence],
            [s.actionClass, "declared", thresholds[s.actionClass], POLICY_RUNGS[thresholds[s.actionClass] - 1], CONFIDENCE[s.rung - 1]]
          );
          assert.equal(f.details.destructive, s.actionClass === "destructive");
        }
      }
    };
    blockedUnder(DEFAULTS);

    p.policy(TABLE(["informational: 3", "mutating: 4", "destructive: 4"]));
    blockedUnder({ informational: 3, mutating: 4, destructive: 4 });

    p.policy(TABLE(["mutating: 4"]));
    blockedUnder({ ...DEFAULTS, mutating: 4 });

    p.policy("");
    blockedUnder(DEFAULTS);

    // ⚠️ RUNG 5: nothing Kiln records reaches it, so every destructive step blocks, and says why.
    p.policy(TABLE(["destructive: 5"]));
    blockedUnder({ ...DEFAULTS, destructive: 5 });
    const top = instruction(p.lint()).find((f) => f.details.actionClass === "destructive" && f.details.confidence === "environment-matched");
    assert.deepEqual([top.details.configuredThreshold, top.details.requiredConfidence], [5, "production-validated"]);
    assert.ok(top.message.includes("No evidence Kiln records can reach that rung."));
  } finally {
    p.remove();
  }
});

test("⚠️ #181 a policy that cannot be read blocks the class with a finding on the manifest and one on each step", async () => {
  const p = project();
  try {
    const informational = await step(p, "informational", [await claim(p, 4, "An inspection")]);
    const mutating = await step(p, "mutating", [await claim(p, 4, "A change")]);
    const destructive = await step(p, "destructive", [await claim(p, 4, "A deletion")]);
    assert.deepEqual(instruction(p.lint()), [], "three steps on matched claims are blocked under the default policy");

    const check = (table, blockedClasses, problems) => {
      p.policy(table);
      const findings = p.lint();
      const onManifest = findings.filter((f) => f.ruleId === "manifest/confidence-threshold-invalid");
      assert.deepEqual(onManifest.map((f) => f.details.problem), problems, table);
      for (const f of onManifest) assert.deepEqual([f.severity, f.path, f.artifactId], ["error", "project.yaml", null]);
      for (const [created, actionClass] of [[informational, "informational"], [mutating, "mutating"], [destructive, "destructive"]]) {
        const mine = instruction(findings, created.id);
        if (!blockedClasses.includes(actionClass)) {
          assert.deepEqual(mine, [], `${actionClass} was blocked by a problem with another class`);
          continue;
        }
        assert.deepEqual(mine.map((f) => [f.ruleId, f.severity]), [["instruction/threshold-policy-invalid", "error"]], actionClass);
        assert.deepEqual(mine[0].details, { actionClass, actionClassSource: "declared", configuredThreshold: null, requiredConfidence: null, confidence: null });
      }
      return onManifest;
    };

    assert.ok(check(TABLE(["informational: 1"]), ["informational"], ["below-floor"])[0].message.includes("informational: 1 is below the floor of 2"));
    check(TABLE(["mutating: three"]), ["mutating"], ["not-a-rung"]);
    check(TABLE(["destructive: 4", "destructive: 5"]), ["destructive"], ["duplicate-class"]);
    check(TABLE(["informational: 0", "destructive: 9"]), ["informational", "destructive"], ["not-a-rung", "not-a-rung"]);
    // A misspelled class and an unreadable table block all three.
    assert.ok(check(TABLE(["informatonal: 2"]), ACTION_CLASSES, ["unknown-class"])[0].message.includes('"informatonal" is not an action class'));
    check(`${TABLE(["mutating: 3"])}${TABLE(["mutating: 4"])}`, ACTION_CLASSES, ["malformed-table"]);
    // Corrected, nothing is blocked and nothing is reported.
    check(TABLE(["informational: 2", "mutating: 3", "destructive: 4"]), [], []);
  } finally {
    p.remove();
  }
});

test("⚠️ #181 legacy steps lint conservatively, and a step with no usable class is blocked however good its claim", async () => {
  const p = project();
  try {
    const legacy = async (shape, rung) => {
      const created = await step(p, "destructive", [await claim(p, rung, `Legacy ${JSON.stringify(shape)} at ${rung}`)]);
      p.store(created.id, ({ actionClass, ...doc }) => ({ ...doc, ...shape }));
      return created.id;
    };
    // The three shapes a step written before #181 can have, each on a source-supported and on an experimental claim.
    const absentLow = await legacy({}, 2);
    const absentOk = await legacy({}, 3);
    const falseLow = await legacy({ destructive: false }, 2);
    const falseOk = await legacy({ destructive: false }, 3);
    const trueLow = await legacy({ destructive: true }, 3);
    const trueOk = await legacy({ destructive: true }, 4);

    let findings = p.lint();
    assert.deepEqual(findings.filter((f) => f.ruleId === "schema/invalid"), [], "a legacy step no longer satisfies the schema");
    for (const id of [absentOk, falseOk, trueOk]) assert.deepEqual(instruction(findings, id), [], id);
    for (const [id, source, threshold] of [[absentLow, "legacy-default", 3], [falseLow, "legacy-default", 3], [trueLow, "legacy-destructive", 4]]) {
      const [f, ...rest] = instruction(findings, id);
      assert.deepEqual([f.ruleId, rest.length, f.details.actionClassSource, f.details.configuredThreshold, f.details.actionClass], ["instruction/rests-on-below-threshold", 0, source, threshold, threshold === 4 ? "destructive" : "mutating"]);
    }
    // ⚠️ NEVER INFORMATIONAL: lowering nothing, an informational threshold of 2 does not reach a legacy step.
    assert.ok(instruction(findings, falseLow)[0].details.requiredConfidence === "experimentally-validated");

    // ⚠️ HAND-EDITED CONTRADICTIONS AND UNKNOWN CLASSES, on a claim good enough for anything.
    const conflicted = async (fields) => {
      const created = await step(p, "destructive", [await claim(p, 4, `Hand edit ${JSON.stringify(fields)}`)]);
      p.store(created.id, (doc) => ({ ...doc, ...fields }));
      return created.id;
    };
    const conflicts = [await conflicted({ actionClass: "informational", destructive: true }), await conflicted({ actionClass: "mutating", destructive: true }), await conflicted({ actionClass: "destructive", destructive: false })];
    const unknowns = [await conflicted({ actionClass: "read-only" }), await conflicted({ actionClass: "Informational" })];
    findings = p.lint();
    for (const id of [...conflicts, ...unknowns]) {
      // Refused twice over: by the schema, and by the lint for a reader who looks only at instruction safety.
      assert.equal(findings.filter((f) => f.artifactId === id && f.ruleId === "schema/invalid").length, 1, id);
      const mine = instruction(findings, id);
      assert.deepEqual(mine.map((f) => [f.ruleId, f.severity]), [[conflicts.includes(id) ? "instruction/action-class-conflict" : "instruction/action-class-unknown", "error"]], id);
      assert.deepEqual(
        [mine[0].details.actionClass, mine[0].details.actionClassSource, mine[0].details.configuredThreshold, mine[0].details.requiredConfidence, mine[0].details.confidence],
        [null, conflicts.includes(id) ? "conflict" : "unknown", null, null, null]
      );
    }
    assert.equal(instruction(findings, conflicts[0])[0].details.legacyDestructive, true);
    assert.equal(instruction(findings, unknowns[0])[0].details.declaredActionClass, "read-only");
  } finally {
    p.remove();
  }
});

/* ------------------------------------------------------------------ authoring and revision */

test("⚠️ #181 a new step must say its class, cannot be given the legacy field, and stores only the class", async () => {
  const p = project();
  try {
    const ast = await claim(p, 4);
    const input = { title: "Inspect", instruction: "Read the setting.", expectedOutcome: "It is printed.", restsOn: [ast] };
    await assert.rejects(() => createRunbookStep(input, p.o), (e) => e instanceof ValidationError && e.message.includes("must declare `actionClass`"));
    for (const actionClass of ["", null, undefined, 3]) await assert.rejects(() => createRunbookStep({ ...input, actionClass }, p.o), ValidationError, String(actionClass));
    await assert.rejects(() => createRunbookStep({ ...input, actionClass: "read-only" }, p.o), ValidationError);
    // The legacy field is not an authoring field, with or without a class beside it.
    await assert.rejects(() => createRunbookStep({ ...input, destructive: false }, p.o), ValidationError);
    await assert.rejects(() => createRunbookStep({ ...input, actionClass: "destructive", destructive: true, remediation: "Restore" }, p.o), ValidationError);
    // #58's floor at the same boundary.
    await assert.rejects(() => createRunbookStep({ ...input, actionClass: "destructive" }, p.o), /remediation|Invalid/);

    for (const actionClass of ACTION_CLASSES) {
      const created = await step(p, actionClass, [ast]);
      assert.equal(created.artifact.actionClass, actionClass);
      assert.equal("destructive" in p.read(created.id), false, "a new step wrote the legacy field");
    }

    // What the model is shown is the same contract.
    const advertised = JSON.parse(readFileSync(join(ROOT, "pi-package", "artifact-authoring-schemas.json"), "utf-8"))["runbook-step"];
    assert.ok(advertised.required.includes("actionClass"));
    assert.deepEqual(advertised.properties.actionClass.enum, ["informational", "mutating", "destructive"]);
    assert.equal("destructive" in advertised.properties, false, "the legacy field is still advertised to an author");
  } finally {
    p.remove();
  }
});

test("⚠️ #181 a revision that sets the class removes the legacy field, reports both as structural, and resets approval", async () => {
  const p = project();
  try {
    const legacy = async (shape) => {
      const created = await step(p, "destructive", [await claim(p, 4, `Legacy ${JSON.stringify(shape)}`)]);
      p.store(created.id, ({ actionClass, ...doc }) => ({ ...doc, ...shape }));
      await setReviewStatus("runbook-step", created.id, "approved", { ...p.o, reviewedBy: "a test" });
      assert.equal(p.read(created.id).reviewStatus, "approved");
      return created.id;
    };

    // ⚠️ RECLASSIFYING IS WHAT THE REVISION IS FOR: the old value does not constrain the new one.
    for (const [shape, actionClass] of [[{ destructive: true }, "informational"], [{ destructive: true }, "destructive"], [{ destructive: false }, "destructive"], [{ destructive: false }, "informational"], [{ destructive: true }, "mutating"]]) {
      const id = await legacy(shape);
      const revised = await reviseArtifact("runbook-step", id, { actionClass }, p.o);
      const stored = p.read(id);
      assert.equal(stored.actionClass, actionClass);
      assert.equal("destructive" in stored, false, `the legacy field survived a revision to ${actionClass}`);
      assert.deepEqual(
        revised.changedFields,
        [{ field: "actionClass", materiality: "structural", amends: true }, { field: "destructive", materiality: "structural", amends: true, removed: true }],
        `${JSON.stringify(shape)} to ${actionClass}`
      );
      assert.deepEqual([revised.amends, revised.stream, stored.reviewStatus], [true, "change-feed", "amended"]);
      assert.ok(validators["runbook-step"](stored));
    }

    // A legacy step with no field has nothing to remove: one structural change.
    const bare = await legacy({});
    assert.deepEqual((await reviseArtifact("runbook-step", bare, { actionClass: "informational" }, p.o)).changedFields, [{ field: "actionClass", materiality: "structural", amends: true }]);

    // ⚠️ NOTHING IS MIGRATED BY THE WAY: a revision of something else leaves a legacy step a legacy step.
    const untouched = await legacy({ destructive: true });
    const noted = await reviseArtifact("runbook-step", untouched, { notes: "Checked with the operator." }, p.o);
    assert.deepEqual(noted.changedFields.map((c) => c.field), ["notes"]);
    assert.deepEqual([p.read(untouched).destructive, "actionClass" in p.read(untouched), p.read(untouched).reviewStatus], [true, false, "approved"]);

    // The legacy field itself is never written again, and a class Kiln does not have is not accepted.
    await assert.rejects(() => reviseArtifact("runbook-step", untouched, { destructive: false }, p.o), (e) => e instanceof ValidationError && e.message.includes("legacy field"));
    await assert.rejects(() => reviseArtifact("runbook-step", untouched, { actionClass: "informational", destructive: false }, p.o), ValidationError);
    await assert.rejects(() => reviseArtifact("runbook-step", untouched, { actionClass: "read-only" }, p.o), ValidationError);
    // A destructive class still owes remediation when the step has none.
    const plain = await step(p, "mutating", [await claim(p, 4, "No remediation")]);
    await assert.rejects(() => reviseArtifact("runbook-step", plain.id, { actionClass: "destructive" }, p.o), ValidationError);
    assert.equal(p.read(plain.id).actionClass, "mutating");
    // A dry run changes nothing on disk and reports what it would do.
    const dry = await reviseArtifact("runbook-step", untouched, { actionClass: "destructive" }, { ...p.o, dryRun: true });
    assert.deepEqual(dry.changedFields.map((c) => c.field), ["actionClass", "destructive"]);
    assert.equal(p.read(untouched).destructive, true);
  } finally {
    p.remove();
  }
});
