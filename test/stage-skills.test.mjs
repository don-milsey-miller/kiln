/**
 * The stage-skill generator's pure half — TSK-0046, against ACC-0066.
 *
 * ⚠️ **NO FILE IS WRITTEN AND NONE IS READ BACK.** This slice is the function from definitions to
 * skill text. The command that writes it, the check that compares it and the packaged files are
 * later slices; what is proven here is that the text they will write is right, and is the same text
 * every time.
 *
 * ⚠️ **PI READS THE FRONTMATTER, NOT THIS FILE.** A generated name and description are asserted by
 * parsing them with the pinned runtime's own root-exported `parseFrontmatter`, so an escaping mistake
 * that a regex would miss is caught the way Pi would meet it.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { loadStageDefinitions } from "../lib/stages.mjs";
import { resolvePinnedSdk } from "../lib/pi-runtime.mjs";
import {
  StageSkillError,
  generateStageSkills,
  isStageSkillName,
  stageSkillName,
  stageSkillPath,
} from "../lib/stage-skills.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const { parseFrontmatter } = await import(resolvePinnedSdk(ROOT).url);

const DEFINITIONS = loadStageDefinitions(ROOT);

/** The nine identities ACC-0066 names, written out so the test does not agree with itself. */
const EXPECTED = Object.freeze([
  "kiln-stage-01-intake",
  "kiln-stage-02-intent-decomposition",
  "kiln-stage-03-discovery",
  "kiln-stage-04-requirement-gaps",
  "kiln-stage-05-solution-design",
  "kiln-stage-06-risk-feasibility",
  "kiln-stage-07-acceptance-criteria",
  "kiln-stage-08-implementation-plan",
  "kiln-stage-09-handoff",
]);

/**
 * A minimal definition that satisfies every in-scope field, for the refusal and escaping cases.
 *
 * ⚠️ **IT DECLARES THE SEVEN BECAUSE A DEFINITION DOES (TSK-0071).** A fixture missing them would
 * refuse for that, and every case below would pass on a refusal about the wrong field.
 */
const minimal = (over = {}) => ({
  id: "01-sample",
  name: "Sample",
  decidedBy: "User",
  produces: ["requirement"],
  producesProse: "A sample stage.",
  exitCriteria: [{ id: "sample-done", describe: "The sample is done.", mechanised: false }],
  purpose: "To be a sample.",
  method: { summary: "Sample something.", steps: ["Sample it."] },
  nextActivity: { rule: "Sample, then exit.", activities: ["author", "attest", "exit"], constraints: ["Sample only once."] },
  delegations: [],
  mutationBoundary: { mayMutate: ["writeStageAttestation"], mayNotTouch: ["Anything else."] },
  approvalBoundary: { approves: "The sample.", requires: ["The sample exists."] },
  completionSummary: { format: "One line.", includes: ["What was sampled."] },
  ...over,
});

/** Everything under one heading, up to the next one. */
function section(content, heading) {
  const from = content.indexOf(heading);
  if (from < 0) return "";
  const rest = content.slice(from + heading.length);
  const next = rest.search(/^## /m);
  return next < 0 ? rest : rest.slice(0, next);
}

/** Expect a refusal that names the stage and the field, and nothing generated. */
const refuses = (definitions, stageId, field) =>
  assert.throws(
    () => generateStageSkills(definitions),
    (e) => e instanceof StageSkillError && e.stageId === stageId && e.field === field,
    `expected a refusal naming ${stageId} and ${field}`
  );

test("⚠️ ACC-0066 the real definitions generate exactly the nine kiln-stage identities, at their paths", () => {
  const skills = generateStageSkills(DEFINITIONS);

  assert.deepEqual(skills.map((s) => s.name), [...EXPECTED], "exactly these nine, in code-unit order");
  for (const skill of skills) {
    assert.equal(skill.name, stageSkillName(skill.stageId));
    assert.equal(skill.path, `skills/${skill.name}/SKILL.md`, "package-relative, forward slashes");
    assert.equal(skill.path, stageSkillPath(skill.stageId));
    assert.ok(Object.hasOwn(DEFINITIONS, skill.stageId), `${skill.name} has no definition behind it`);
  }
  assert.equal(Object.isFrozen(skills), true);
  for (const skill of skills) assert.equal(Object.isFrozen(skill), true);
});

test("⚠️ ACC-0066 each skill carries its definition's decision owner, outputs and exit criteria, verbatim", () => {
  for (const skill of generateStageSkills(DEFINITIONS)) {
    const def = DEFINITIONS[skill.stageId];
    const { body } = parseFrontmatter(skill.content);

    assert.ok(body.includes(`## Outputs\n\n${def.producesProse}\n`), `${skill.name}: output prose under Outputs`);
    assert.ok(body.includes(`## Decision owner\n\n${def.decidedBy}\n`), `${skill.name}: decision owner`);
    assert.ok(body.includes(`# Stage ${skill.stageId.slice(0, 2)} — ${def.name}`), `${skill.name}: title`);

    if (def.produces.length === 0) assert.ok(body.includes("This stage produces no typed artifact."), `${skill.name}: no outputs`);
    for (const type of def.produces) assert.ok(body.includes(`- \`${type}\``), `${skill.name}: output ${type}`);
    for (const output of def.outputsNotYetTyped ?? []) assert.ok(body.includes(`- ${output}`), `${skill.name}: untyped output ${output}`);

    // ⚠️ IN DEFINITION ORDER. An agent reading criteria is reading a checklist, and the definition's
    // order is the authored one.
    let cursor = -1;
    for (const criterion of def.exitCriteria) {
      const at = body.indexOf(`- \`${criterion.id}\` — ${criterion.describe}`);
      assert.ok(at > cursor, `${skill.name}: criterion ${criterion.id} missing or out of order`);
      cursor = at;
    }
  }
});

test("⚠️ ACC-0066 nothing a definition does not declare is written as if it did", () => {
  const discovery = generateStageSkills(DEFINITIONS).find((s) => s.stageId === "03-discovery");

  // ⚠️ CANDIDATES ARE NOT OUTPUTS. `producesCandidates` records what a reader might infer and the gate
  // does NOT enforce; carrying it into the skill would tell an agent to produce something unchecked.
  for (const candidate of DEFINITIONS["03-discovery"].producesCandidates ?? []) {
    assert.equal(discovery.content.includes(candidate.from), false, "a produces candidate reached the skill");
    assert.equal(discovery.content.includes(candidate.note), false);
  }

  // ⚠️ **THE SECTIONS ARE EXACTLY WHAT THE DEFINITION CALLS FOR, IN ORDER (TSK-0071).** The six that
  // ACC-0112 adds are now unconditional, because every definition declares all seven; `## Choosing the
  // next question` remains conditional, because only a definition that declares the rule gets it. A
  // template supplying either would read exactly like a definition that did.
  const BASE = [
    "## Purpose",
    "## Decision owner",
    "## Outputs",
    "## Exit criteria",
    "## Method",
    "## Next activity",
    "## Delegations",
    "## Boundaries",
    "## Completion summary",
  ];
  for (const skill of generateStageSkills(DEFINITIONS)) {
    const declares = DEFINITIONS[skill.stageId].questionSelection !== undefined;
    assert.deepEqual(
      skill.content.match(/^## .*$/gm),
      declares ? [...BASE, "## Choosing the next question"] : BASE,
      `${skill.name}: exactly the generated sections its definition calls for, in order`
    );

    // ⚠️ **NOTHING STILL ANNOUNCES THE SEVEN AS ABSENT.** The section existed only to say they were
    // undeclared; a document that renders them and still says they are missing contradicts itself.
    assert.equal(skill.content.includes("Not in this skill"), false, `${skill.name}: the deferred section survives`);
    assert.equal(skill.content.includes("does not declare them yet"), false, `${skill.name}: the deferred sentence survives`);
  }
});

/* ============================================================ the question rule (TSK-0049, toward ACC-0069) */

/** Everything under `## Choosing the next question`, up to the next heading. */
function questionSection(content) {
  const from = content.indexOf("## Choosing the next question");
  if (from === -1) return null;
  const rest = content.slice(from);
  const next = rest.indexOf(`${String.fromCharCode(10)}## `, 1);
  return next === -1 ? rest : rest.slice(0, next);
}

test("⚠️ ACC-0069 the canonical question rule reaches the skill, every line of it and nothing else", () => {
  const intake = generateStageSkills(DEFINITIONS).find((s) => s.stageId === "01-intake");
  const declared = DEFINITIONS["01-intake"].questionSelection;
  const section = questionSection(intake.content);
  assert.ok(section, "Stage 1's skill has no question-selection section");

  // ⚠️ VERBATIM, BOTH WAYS. Every declared line appears exactly once, and the section contains no sentence
  // the definition did not declare: a rule reworded on its way into a skill is a rule nobody authored.
  const strings = [declared.rule, ...declared.afterAnswer, ...declared.constraints, declared.whenIntakeAbsent, declared.whenIntakeInvalid];
  for (const text of strings) assert.equal(section.split(text).length - 1, 1, `not carried exactly once: ${text.slice(0, 60)}`);

  const LABELS = new Set(["## Choosing the next question", "", "After an answer:", "Always:"]);
  const contributed = section
    .split(String.fromCharCode(10))
    .filter((l) => !LABELS.has(l))
    .map((l) => l.replace(/^\d+\. /, "").replace(/^- /, "").replace(/^If this stage's intake is reported `absent`: /, "").replace(/^If it is reported `invalid`: /, ""));
  assert.deepEqual(
    contributed.filter((l) => l.length > 0).sort(),
    [...strings].sort(),
    "the section carries a line the definition did not declare"
  );

  // The sequence is the definition's order: record, lint, re-read, then ask.
  declared.afterAnswer.forEach((step, i) => assert.ok(section.includes(`${i + 1}. ${step}`), `step ${i + 1} is out of order or reworded`));
  assert.ok(section.indexOf(declared.afterAnswer[0]) < section.indexOf(declared.afterAnswer[1]));
  assert.ok(section.indexOf(declared.afterAnswer[1]) < section.indexOf(declared.afterAnswer[2]));
  assert.ok(section.indexOf(declared.afterAnswer[2]) < section.indexOf(declared.afterAnswer[3]));

  // The tools the rule names are the ones that do those things.
  for (const tool of ["kiln_write_stage_document", "kiln_lint", "kiln_project_status"])
    assert.ok(section.includes(`\`${tool}\``), `the rule does not name ${tool}`);

  // ⚠️ AND THE OTHER EIGHT STAGES GET NOTHING. Only Stage 1's method has been settled.
  for (const skill of generateStageSkills(DEFINITIONS))
    if (skill.stageId !== "01-intake") assert.equal(questionSection(skill.content), null, `${skill.name} was given a rule nobody declared`);
});

test("⚠️ ACC-0069 a question rule that is not one is refused, naming the stage and the field", () => {
  const withRule = (questionSelection) => ({ "01-intake": { ...DEFINITIONS["01-intake"], questionSelection } });
  const good = DEFINITIONS["01-intake"].questionSelection;

  for (const [label, value, field] of [
    ["not an object", "ask a good question", "questionSelection"],
    ["an array", [good.rule], "questionSelection"],
    ["null", null, "questionSelection"],
    ["no rule", { ...good, rule: undefined }, "questionSelection.rule"],
    ["an empty rule", { ...good, rule: "   " }, "questionSelection.rule"],
    ["a rule over two lines", { ...good, rule: `ask${String.fromCharCode(10)}something` }, "questionSelection.rule"],
    ["no sequence", { ...good, afterAnswer: undefined }, "questionSelection.afterAnswer"],
    ["an empty sequence", { ...good, afterAnswer: [] }, "questionSelection.afterAnswer"],
    ["a step that is not a string", { ...good, afterAnswer: [1, 2] }, "questionSelection.afterAnswer[0]"],
    ["no constraints", { ...good, constraints: undefined }, "questionSelection.constraints"],
    ["an empty constraint list", { ...good, constraints: [] }, "questionSelection.constraints"],
    ["no absent behaviour", { ...good, whenIntakeAbsent: undefined }, "questionSelection.whenIntakeAbsent"],
    ["no invalid behaviour", { ...good, whenIntakeInvalid: undefined }, "questionSelection.whenIntakeInvalid"],
  ])
    assert.throws(
      () => generateStageSkills(withRule(value)),
      (e) => e instanceof StageSkillError && e.stageId === "01-intake" && e.field === field,
      label
    );
});


test("⚠️ F88 producesProse stays output prose, and purpose is the definition's own", () => {
  // ⚠️ **THE FIRST GENERATOR PRINTED `producesProse` UNDER PURPOSE.** That field says what a stage
  // EMITS; relabelling it is inference by another route, and it is refused for the same reason a
  // template default is. Now that a purpose exists, the check is sharper: the two both appear, each
  // under its own heading, and neither is the other.
  for (const skill of generateStageSkills(DEFINITIONS)) {
    const def = DEFINITIONS[skill.stageId];
    const purposeSection = section(skill.content, "## Purpose");
    const outputsSection = section(skill.content, "## Outputs");

    assert.ok(purposeSection.includes(def.purpose), `${skill.name}: the purpose section does not carry the declared purpose`);
    assert.equal(purposeSection.includes(def.producesProse), false, `${skill.name}: producesProse was relabelled as purpose`);
    assert.ok(outputsSection.includes(def.producesProse), `${skill.name}: producesProse is not under Outputs`);
    assert.notEqual(def.purpose, def.producesProse, `${skill.name}: the definition itself repeats producesProse`);

    // ⚠️ ONCE, AND IN ONE PLACE. Rendered twice it would read as two separate statements.
    assert.equal(skill.content.split(def.producesProse).length - 1, 1, `${skill.name}: producesProse is rendered more than once`);
  }
});

test("⚠️ ACC-0066 generation is byte-deterministic: same definitions, same bytes, whatever the input order or working directory", () => {
  const first = generateStageSkills(DEFINITIONS);
  const second = generateStageSkills(DEFINITIONS);
  assert.deepEqual(second, first, "a second run differs");

  // ⚠️ THE ANSWER MUST NOT DEPEND ON HOW THE INPUT WAS BUILT. Stages inserted in reverse, and every
  // definition's keys reversed, produce the same bytes.
  const reversed = Object.fromEntries(
    Object.entries(DEFINITIONS)
      .reverse()
      .map(([id, def]) => [id, Object.fromEntries(Object.entries(def).reverse())])
  );
  assert.deepEqual(generateStageSkills(reversed), first, "input order changed the output");

  // Nor on where the process happens to be standing.
  const elsewhere = mkdtempSync(join(tmpdir(), "kiln-stage-skills-cwd-"));
  const cwd = process.cwd();
  try {
    process.chdir(elsewhere);
    assert.deepEqual(generateStageSkills(DEFINITIONS), first, "the working directory changed the output");
  } finally {
    process.chdir(cwd);
    rmSync(elsewhere, { recursive: true, force: true });
  }

  for (const skill of first) {
    assert.equal(skill.content.includes("\r"), false, `${skill.name}: a carriage return`);
    assert.ok(skill.content.endsWith("\n") && !skill.content.endsWith("\n\n"), `${skill.name}: not exactly one trailing newline`);
    assert.equal(/\d{4}-\d{2}-\d{2}T\d{2}:/.test(skill.content), false, `${skill.name}: a timestamp`);
    for (const machine of [ROOT, homedir(), tmpdir()])
      for (const spelling of [machine, machine.split("\\").join("/")])
        assert.equal(skill.content.includes(spelling), false, `${skill.name}: carries ${spelling}`);
  }
});

test("⚠️ ACC-0066 Pi's own frontmatter parser reads exactly the generated name and a loadable description", () => {
  for (const skill of generateStageSkills(DEFINITIONS)) {
    const { frontmatter, body } = parseFrontmatter(skill.content);

    assert.deepEqual(Object.keys(frontmatter), ["name", "description"], `${skill.name}: frontmatter keys`);
    assert.equal(frontmatter.name, skill.name);
    // Pi's rules, as its loader applies them.
    assert.match(frontmatter.name, /^[a-z0-9]+(-[a-z0-9]+)*$/);
    assert.ok(frontmatter.name.length <= 64);
    assert.equal(typeof frontmatter.description, "string");
    assert.ok(frontmatter.description.length > 0 && frontmatter.description.length <= 1024, `${skill.name}: description length`);
    assert.ok(frontmatter.description.includes(skill.stageId), `${skill.name}: the description does not say when it applies`);
    // ⚠️ IT NOW NAMES A PURPOSE BECAUSE THE DEFINITION DECLARES ONE (TSK-0071). The old assertion
    // guarded against a description promising a field nothing carried; the guard is now the other way.
    assert.match(frontmatter.description, /its purpose, method, next activity/, `${skill.name}: the description does not name what the skill carries`);

    // The generated header names its source and says not to edit.
    assert.ok(body.startsWith(`<!-- Generated by lib/stage-skills.mjs from stages/${skill.stageId}.json. Do not edit this file`), `${skill.name}: header`);
  }
});

test("⚠️ ACC-0066 YAML and Markdown metacharacters in a definition survive into the frontmatter exactly", () => {
  const awkward = 'Agent → "user" confirms: #1 \\ back\'slash — done';
  const [skill] = generateStageSkills({ "01-sample": minimal({ name: awkward, decidedBy: awkward }) });
  const { frontmatter, body } = parseFrontmatter(skill.content);

  assert.equal(frontmatter.name, "kiln-stage-01-sample");
  assert.ok(frontmatter.description.includes(awkward), `the description lost characters: ${frontmatter.description}`);
  assert.deepEqual(Object.keys(frontmatter), ["name", "description"], "a metacharacter added or split a frontmatter key");
  assert.ok(body.includes(`## Decision owner\n\n${awkward}\n`));
});

test("⚠️ ACC-0066 a definition missing an in-scope field is refused, naming the stage and the field, with no default", () => {
  const without = (field) => {
    const def = minimal();
    delete def[field];
    return { [def.id]: def };
  };

  refuses(without("decidedBy"), "01-sample", "decidedBy");
  refuses(without("producesProse"), "01-sample", "producesProse");
  refuses(without("name"), "01-sample", "name");
  refuses(without("produces"), "01-sample", "produces");
  refuses(without("exitCriteria"), "01-sample", "exitCriteria");

  refuses({ "01-sample": minimal({ decidedBy: "   " }) }, "01-sample", "decidedBy");
  refuses({ "01-sample": minimal({ exitCriteria: [] }) }, "01-sample", "exitCriteria");
  refuses({ "01-sample": minimal({ exitCriteria: [{ describe: "No id." }] }) }, "01-sample", "exitCriteria[0].id");
  refuses({ "01-sample": minimal({ exitCriteria: [{ id: "no-describe" }] }) }, "01-sample", "exitCriteria[0].describe");
  refuses({ "01-sample": minimal({ produces: "requirement" }) }, "01-sample", "produces");
  refuses({ "01-sample": minimal({ outputsNotYetTyped: [""] }) }, "01-sample", "outputsNotYetTyped[0]");

  // ⚠️ A LINE BREAK WOULD CHANGE THE DOCUMENT'S STRUCTURE, so it is refused rather than reflowed.
  refuses({ "01-sample": minimal({ producesProse: "First line.\n## Injected heading" }) }, "01-sample", "producesProse");
  refuses({ "01-sample": minimal({ exitCriteria: [{ id: "x", describe: "a\r\nb" }] }) }, "01-sample", "exitCriteria[0].describe");
});

test("⚠️ ACC-0066 an id that would not be a loadable Pi skill name is refused, and so is a duplicate", () => {
  refuses({ "Intake": minimal({ id: "Intake" }) }, "Intake", "id");
  refuses({ "1-intake": minimal({ id: "1-intake" }) }, "1-intake", "id");
  refuses({ "01--intake": minimal({ id: "01--intake" }) }, "01--intake", "id");
  refuses({ "01-intake-": minimal({ id: "01-intake-" }) }, "01-intake-", "id");
  refuses({ "01-a": minimal({ id: "01-a" }), "01-a-copy": minimal({ id: "01-a" }) }, "01-a", "id");
  assert.throws(() => generateStageSkills(null), StageSkillError);
  assert.throws(() => generateStageSkills([]), StageSkillError);
});

test("⚠️ ACC-0112 the generator refuses a declared field it cannot render, naming the stage and the field", () => {
  // ⚠️ **THE LOADER REFUSES FIRST IN PRODUCTION, AND THAT IS NOT A REASON TO SKIP THIS.**
  // `generateStageSkills` takes a definition SET, not a loaded one, and a caller that built it another
  // way would otherwise render a document with a hole in it. These cases call the generator directly.
  refuses({ "01-sample": minimal({ purpose: undefined }) }, "01-sample", "purpose");
  refuses({ "01-sample": minimal({ purpose: "two\nlines" }) }, "01-sample", "purpose");
  refuses({ "01-sample": minimal({ method: undefined }) }, "01-sample", "method");
  refuses({ "01-sample": minimal({ method: { summary: "", steps: ["x"] } }) }, "01-sample", "method.summary");
  refuses({ "01-sample": minimal({ method: { summary: "s", steps: [] } }) }, "01-sample", "method.steps");
  refuses({ "01-sample": minimal({ method: { summary: "s", steps: "not a list" } }) }, "01-sample", "method.steps");
  refuses({ "01-sample": minimal({ nextActivity: undefined }) }, "01-sample", "nextActivity");
  refuses({ "01-sample": minimal({ nextActivity: { rule: "r", activities: [], constraints: ["c"] } }) }, "01-sample", "nextActivity.activities");
  refuses({ "01-sample": minimal({ nextActivity: { rule: "r", activities: ["exit"], constraints: [] } }) }, "01-sample", "nextActivity.constraints");
  refuses({ "01-sample": minimal({ delegations: undefined }) }, "01-sample", "delegations");
  refuses({ "01-sample": minimal({ delegations: "research" }) }, "01-sample", "delegations");
  refuses({ "01-sample": minimal({ delegations: [{ role: "", capabilities: [] }] }) }, "01-sample", "delegations[0].role");
  refuses({ "01-sample": minimal({ mutationBoundary: undefined }) }, "01-sample", "mutationBoundary");
  refuses({ "01-sample": minimal({ mutationBoundary: { mayMutate: ["x"], mayNotTouch: [] } }) }, "01-sample", "mutationBoundary.mayNotTouch");
  refuses({ "01-sample": minimal({ approvalBoundary: undefined }) }, "01-sample", "approvalBoundary");
  refuses({ "01-sample": minimal({ approvalBoundary: { approves: "a", requires: [] } }) }, "01-sample", "approvalBoundary.requires");
  refuses({ "01-sample": minimal({ completionSummary: undefined }) }, "01-sample", "completionSummary");
  refuses({ "01-sample": minimal({ completionSummary: { format: "f", includes: [] } }) }, "01-sample", "completionSummary.includes");

  // ⚠️ AN EMPTY LIST IS FINE WHERE THE DEFINITION MAY DECLARE ONE. `delegations` and `mayMutate` are
  // the two, and refusing them here would contradict the loader that accepts them.
  const bare = minimal({ delegations: [], mutationBoundary: { mayMutate: [], mayNotTouch: ["Anything."] } });
  assert.ok(generateStageSkills({ "01-sample": bare })[0].content.includes("## Boundaries"));
});

test("⚠️ ACC-0066 a description Pi would not load is refused rather than truncated", () => {
  // ⚠️ **THE BOUND IS PI'S, AND IT IS MEASURED HERE RATHER THAN ASSUMED.** The sentence grew when it
  // started naming all seven fields, so the guard has to be driven past 1024 characters by something.
  // A long stage name does it, and truncating instead would ship a description Pi silently drops.
  const short = generateStageSkills({ "01-sample": minimal() })[0].content.match(/^description: "(.*)"$/m)[1];
  assert.ok(short.length < 1024, `the baseline description is already ${short.length}`);

  const long = minimal({ name: "S".repeat(1024) });
  refuses({ "01-sample": long }, "01-sample", "description");

  // Just under the bound still generates, so the refusal is a bound and not a blanket.
  const fits = minimal({ name: "S".repeat(1024 - short.length + "Sample".length) });
  const description = generateStageSkills({ "01-sample": fits })[0].content.match(/^description: "(.*)"$/m)[1];
  assert.equal(description.length, 1024, `boundary description is ${description.length}`);
});

test("⚠️ ACC-0066 the generator owns kiln-stage-* names and no other, so kiln-planning is never its to judge", () => {
  for (const name of EXPECTED) assert.equal(isStageSkillName(name), true, name);

  for (const name of ["kiln-planning", "kiln-stage", "kiln-stage-", "kiln-stage-intake", "kiln-stage-1-intake", "stage-01-intake", "my-kiln-stage-01-intake", "KILN-STAGE-01-INTAKE", undefined, null, 7])
    assert.equal(isStageSkillName(name), false, String(name));
});

test("⚠️ ACC-0066 the generator is pure: no filesystem, environment, clock or randomness in its source", () => {
  const source = readFileSync(join(ROOT, "lib", "stage-skills.mjs"), "utf-8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

  for (const forbidden of [/node:fs/, /\bprocess\s*\./, /\bDate\b/, /Math\.random/, /\bimport\s*\(/, /readFile|writeFile|mkdir|readdir/])
    assert.equal(forbidden.test(source), false, `the generator's source matches ${forbidden}`);
  const imports = [...source.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(imports, ["./project-scaffold.mjs"], "the generator imports something other than the shared YAML and ordering helpers");
});
