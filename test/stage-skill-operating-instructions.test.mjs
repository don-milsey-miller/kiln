/**
 * The seven declared fields, carried into every stage skill — TSK-0071, toward ACC-0112.
 *
 * ⚠️ **HEADINGS ARE THE GENERATOR'S; SUBSTANCE IS THE DEFINITION'S.** A rule reworded on its way into a
 * skill is a rule nobody authored. The exact-rendering test below takes one definition and asserts every
 * authored value appears in the generated document verbatim, including the values that are easiest to
 * paraphrase: each delegated capability, both boundary lists, and both completion-summary fields.
 *
 * ⚠️ **STALENESS IS MEASURED WITHOUT REGENERATING.** Each case changes one field to another
 * loader-valid value, leaves the generated file exactly as it is, and asks `checkStageSkills`. A test
 * that regenerated first would be asking whether the generator is deterministic, which is a different
 * question and one nothing here is about.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { STAGES_DIR, loadStageDefinitions } from "../lib/stages.mjs";
import { generateStageSkills } from "../lib/stage-skills.mjs";
import { DRIFT, checkStageSkills } from "../lib/stage-skills-files.mjs";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const STAGE = "03-discovery";
const SKILL = "kiln-stage-03-discovery";
const SHIPPED = loadStageDefinitions(REPO);

const skillFor = (id) => generateStageSkills(SHIPPED).find((s) => s.stageId === id).content;

/** Everything under one heading or label, up to the next heading. */
function section(content, heading) {
  const from = content.indexOf(heading);
  if (from < 0) return "";
  const rest = content.slice(from + heading.length);
  const next = rest.search(/^## /m);
  return next < 0 ? rest : rest.slice(0, next);
}

/**
 * A private copy of `stages/` and `pi-package/skills/`, so a case can edit a definition without
 * touching the repository and without the next case reading what this one wrote.
 */
function inCopiedTree(run) {
  const root = mkdtempSync(join(tmpdir(), "kiln-stageskill-"));
  try {
    cpSync(join(REPO, STAGES_DIR), join(root, STAGES_DIR), { recursive: true });
    cpSync(join(REPO, "pi-package", "skills"), join(root, "pi-package", "skills"), { recursive: true });
    return run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/**
 * Change one field of one definition to another value the LOADER still accepts, then ask whether the
 * untouched generated skill is stale.
 */
function staleAfter(mutate, { id = STAGE, skill = SKILL } = {}) {
  return inCopiedTree((root) => {
    const path = join(root, STAGES_DIR, `${id}.json`);
    const def = JSON.parse(readFileSync(path, "utf8"));
    mutate(def);
    writeFileSync(path, `${JSON.stringify(def, null, 2)}\n`);

    // ⚠️ THE DEFINITION IS STILL VALID. A case that broke the loader would prove nothing about drift.
    assert.ok(loadStageDefinitions(root)[id], `${id}: the edited definition no longer loads`);

    const result = checkStageSkills(root);
    const stale = result.drift.filter((d) => d.kind === DRIFT.STALE);
    assert.deepEqual(
      stale.map((d) => d.skill),
      [skill],
      `expected exactly ${skill} to be stale, got ${JSON.stringify(result.drift)}`
    );
    return result;
  });
}

/* ============================================================ exact rendering ================= */

test("⚠️ ACC-0112 every authored value reaches the skill, verbatim", () => {
  const def = SHIPPED[STAGE];
  const content = skillFor(STAGE);

  // Purpose, method, next activity.
  assert.ok(content.includes(def.purpose), "purpose");
  assert.ok(content.includes(def.method.summary), "method.summary");
  for (const step of def.method.steps) assert.ok(content.includes(step), `method.steps: ${step}`);
  assert.ok(content.includes(def.nextActivity.rule), "nextActivity.rule");
  for (const activity of def.nextActivity.activities) assert.ok(content.includes(`\`${activity}\``), `activity: ${activity}`);
  for (const constraint of def.nextActivity.constraints) assert.ok(content.includes(constraint), `constraint: ${constraint}`);

  // ⚠️ EACH CAPABILITY BY NAME. A rendering that printed the role and summarised its capabilities as
  // "its declared tools" would pass a laxer test and tell the reader nothing they could check.
  for (const delegation of def.delegations) {
    assert.ok(content.includes(`\`${delegation.role}\``), `delegation role: ${delegation.role}`);
    for (const capability of delegation.capabilities) assert.ok(content.includes(`\`${capability}\``), `capability: ${capability}`);
  }

  // Both boundary lists, entry by entry.
  for (const operation of def.mutationBoundary.mayMutate) assert.ok(content.includes(`\`${operation}\``), `mayMutate: ${operation}`);
  for (const what of def.mutationBoundary.mayNotTouch) assert.ok(content.includes(what), `mayNotTouch: ${what}`);
  assert.ok(content.includes(def.approvalBoundary.approves), "approvalBoundary.approves");
  for (const requirement of def.approvalBoundary.requires) assert.ok(content.includes(requirement), `requires: ${requirement}`);

  // Both completion-summary fields.
  assert.ok(content.includes(def.completionSummary.format), "completionSummary.format");
  for (const item of def.completionSummary.includes) assert.ok(content.includes(item), `includes: ${item}`);

  // The six headings are the generator's, and they are all present.
  for (const heading of ["## Purpose", "## Method", "## Next activity", "## Delegations", "## Boundaries", "## Completion summary"])
    assert.ok(content.includes(heading), heading);
});

test("⚠️ ACC-0112 every shipped skill carries its own definition's seven", () => {
  for (const [id, def] of Object.entries(SHIPPED)) {
    const content = readFileSync(join(REPO, "pi-package", "skills", `kiln-stage-${id}`, "SKILL.md"), "utf8");
    assert.ok(content.includes(def.purpose), `${id}: purpose`);
    assert.ok(content.includes(def.method.summary), `${id}: method.summary`);
    assert.ok(content.includes(def.nextActivity.rule), `${id}: nextActivity.rule`);
    assert.ok(content.includes(def.approvalBoundary.approves), `${id}: approvalBoundary.approves`);
    assert.ok(content.includes(def.completionSummary.format), `${id}: completionSummary.format`);
    for (const delegation of def.delegations) for (const capability of delegation.capabilities) assert.ok(content.includes(`\`${capability}\``), `${id}: ${capability}`);
  }
});

/* ============================================================ empty declarations ============== */

test("⚠️ ACC-0112 an empty declaration is printed as exactly `[]`, with nothing added to it", () => {
  // ⚠️ **THE GENERATOR MAY NOT EXPLAIN AN EMPTY LIST (F59).** An earlier version wrote "this stage
  // delegates to no specialist" beside the `[]`. That reads like an instruction and is a conclusion the
  // generator drew, which is the inference ACC-0112 forbids. The section must be there, `[]` must be
  // there, and nothing else may be.
  const none = skillFor("07-acceptance-criteria");
  assert.deepEqual(SHIPPED["07-acceptance-criteria"].delegations, []);
  assert.ok(none.includes("## Delegations"), "the section was dropped");
  assert.equal(section(none, "## Delegations").trim(), "`[]`", "the empty delegations rendering is not exactly `[]`");

  // No shipped stage has an empty `mayMutate`, so the other empty branch is exercised directly.
  const bare = JSON.parse(JSON.stringify(SHIPPED["07-acceptance-criteria"]));
  bare.mutationBoundary.mayMutate = [];
  const content = generateStageSkills({ [bare.id]: bare })[0].content;
  assert.ok(content.includes("## Boundaries"), "the section was dropped");
  const operations = section(content, "This stage may perform these non-creation operations:");
  assert.equal(operations.slice(0, operations.indexOf("It must not touch:")).trim(), "`[]`", "the empty mayMutate rendering is not exactly `[]`");

  // ⚠️ NO SENTENCE ANYWHERE. Neither the generator nor any shipped skill may carry the old prose.
  const generator = readFileSync(join(REPO, "lib", "stage-skills.mjs"), "utf8");
  for (const inferred of ["delegates to no specialist", "changes nothing that already exists", "works alone", "read-only"])
    assert.equal(generator.includes(`"\`[]\` — this stage ${inferred}`), false, `the generator still explains an empty list: ${inferred}`);
  for (const id of Object.keys(SHIPPED))
    for (const inferred of ["delegates to no specialist", "changes nothing that already exists"])
      assert.equal(skillFor(id).includes(inferred), false, `${id}: ${inferred}`);
});

/* ============================================================ the removal ===================== */

test("⚠️ ACC-0112 no skill still announces that the seven are undeclared", () => {
  // ⚠️ **THE SECTION AND ITS SENTENCE ARE BOTH GONE.** `## Not in this skill` existed only to say these
  // fields were missing; a document that renders them and still says they are absent contradicts itself.
  // The heading is pinned as a STRING LITERAL, so the comment recording why it went does not trip this.
  const generator = readFileSync(join(REPO, "lib", "stage-skills.mjs"), "utf8");
  assert.equal(generator.includes('"## Not in this skill"'), false, "the generator can still emit the section");
  assert.equal(generator.includes("const deferred"), false, "the deferred phrase is still composed");
  assert.equal(generator.includes("how to choose the next question or activity"), false, "the deferred sentence survives");
  assert.equal(generator.includes("does not declare them yet"), false, "the deferred sentence survives");

  // And no freshly generated skill contains it either, which is the fact that actually matters.
  for (const id of Object.keys(SHIPPED)) assert.equal(skillFor(id).includes("Not in this skill"), false, `${id}: the generator still emits it`);

  for (const id of Object.keys(SHIPPED)) {
    const content = readFileSync(join(REPO, "pi-package", "skills", `kiln-stage-${id}`, "SKILL.md"), "utf8");
    assert.equal(content.includes("Not in this skill"), false, `${id}: the section survives on disk`);
    assert.equal(content.includes("does not declare them yet"), false, `${id}: the sentence survives on disk`);
  }
});

/* ============================================================ the description ================= */

test("⚠️ ACC-0112 the widened description names what the skill carries and fits Pi's bound", () => {
  // ⚠️ **MEASURED, NOT ASSUMED.** Pi does not load a description over 1024 characters, and the sentence
  // grew by naming six more things. The longest shipped description is asserted against the real bound.
  const MAX = 1024;
  let longest = 0;
  for (const id of Object.keys(SHIPPED)) {
    const content = skillFor(id);
    const match = content.match(/^description: "(.*)"$/m);
    assert.ok(match, `${id}: no description line`);
    const description = match[1];
    longest = Math.max(longest, description.length);
    assert.ok(description.length <= MAX, `${id}: ${description.length} characters exceeds ${MAX}`);
    for (const promised of ["purpose", "method", "next activity", "allowed delegations", "mutation and approval boundaries", "completion summary"])
      assert.ok(description.includes(promised), `${id}: the description does not name ${promised}`);
    assert.ok(description.includes(`current stage is ${id}`), `${id}: the description does not say when to use it`);
  }
  assert.ok(longest < MAX, `the longest description is ${longest}`);
  assert.ok(longest > 200, `the descriptions did not widen: longest is ${longest}`);
});

/* ============================================================ staleness, per field ============ */

test("⚠️ ACC-0112 changing any one of the seven makes the generated skill stale, and names it", () => {
  // Each case edits one field to another value the loader accepts and leaves the skill on disk alone.
  staleAfter((def) => (def.purpose = "A different purpose, authored for this case."));
  staleAfter((def) => (def.method.summary = "A different summary."));
  staleAfter((def) => def.method.steps.push("One more step nobody had written."));
  staleAfter((def) => (def.nextActivity.rule = "A different rule."));
  // ⚠️ STILL A VALID SUBSEQUENCE, and still consistent with `delegations` and `writeStageDocument`.
  staleAfter((def) => (def.nextActivity.activities = ["question", "delegate", "attest", "exit"]));
  staleAfter((def) => def.nextActivity.constraints.push("One more constraint."));
});

test("⚠️ ACC-0112 the remaining fields make it stale too", () => {
  staleAfter((def) => {
    def.mutationBoundary.mayMutate.push("setLifecycle");
    def.mutationBoundary.mayMutate.sort();
  });
  staleAfter((def) => def.mutationBoundary.mayNotTouch.push("One more thing it must not touch."));
  staleAfter((def) => (def.approvalBoundary.approves = "Something else entirely."));
  staleAfter((def) => def.approvalBoundary.requires.push("One more precondition."));
  staleAfter((def) => (def.completionSummary.format = "A different format, in one line."));
  staleAfter((def) => def.completionSummary.includes.push("One more thing it states."));

  // A delegation's capabilities cannot change without the contract changing, so the delegation case is
  // the role list itself: dropping it, with `delegate` dropped alongside so the definition stays valid.
  staleAfter((def) => {
    def.delegations = [];
    def.nextActivity.activities = def.nextActivity.activities.filter((a) => a !== "delegate");
  });
});

test("⚠️ ACC-0112 an untouched tree is not stale, so every case above measured a real change", () => {
  const result = inCopiedTree((root) => checkStageSkills(root));
  assert.deepEqual(result.drift, [], `a pristine copy reported drift: ${JSON.stringify(result.drift)}`);
});
