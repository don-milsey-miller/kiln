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

/** A minimal definition that satisfies every in-scope field, for the refusal and escaping cases. */
const minimal = (over = {}) => ({
  id: "01-sample",
  name: "Sample",
  decidedBy: "User",
  produces: ["requirement"],
  producesProse: "A sample stage.",
  exitCriteria: [{ id: "sample-done", describe: "The sample is done.", mechanised: false }],
  ...over,
});

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

  // The deferred fields are named as absent, and nowhere described as present.
  for (const skill of generateStageSkills(DEFINITIONS)) {
    assert.deepEqual(
      skill.content.match(/^## .*$/gm),
      ["## Decision owner", "## Outputs", "## Exit criteria", "## Not in this skill"],
      `${skill.name}: exactly the four generated sections, in order`
    );
    assert.match(skill.content, /## Not in this skill\n\nThis stage's purpose, its method, .*are not stated here, because its canonical definition does not declare them yet\.\n$/);
    assert.equal(/^## (Purpose|Method|Next|Delegation|Mutation|Approval|Completion)/m.test(skill.content), false, `${skill.name}: a deferred field has a section`);
  }
});

test("⚠️ F88 producesProse stays output prose: rendered once, inside Outputs, and never relabelled as purpose", () => {
  // ⚠️ **A FIELD RELABELLED IS A FIELD INFERRED.** `producesProse` says what a stage emits. The first
  // generator printed it under Purpose, which told an agent what the stage is FOR on the strength of a
  // field that never said so. Wherever it appears, it must sit inside the Outputs section, and the only
  // place the word purpose may appear is the sentence saying the definition does not declare one.
  for (const skill of generateStageSkills(DEFINITIONS)) {
    const def = DEFINITIONS[skill.stageId];
    const { body } = parseFrontmatter(skill.content);

    assert.equal(body.split(def.producesProse).length - 1, 1, `${skill.name}: the output prose appears other than exactly once`);

    const outputs = body.indexOf("\n## Outputs\n");
    const next = body.indexOf("\n## ", outputs + 1);
    const at = body.indexOf(def.producesProse);
    assert.ok(outputs !== -1 && at > outputs && at < next, `${skill.name}: the output prose is not inside the Outputs section`);

    // Exactly one mention, and it is the sentence saying the definition declares no purpose.
    const mentions = [...skill.content.matchAll(/purpose/gi)].map((m) => m.index);
    const sentence = "This stage's purpose, its method";
    assert.equal(mentions.length, 1, `${skill.name}: purpose is mentioned ${mentions.length} times`);
    assert.equal(mentions[0], skill.content.indexOf(sentence) + "This stage's ".length, `${skill.name}: purpose is mentioned somewhere other than the not-declared sentence`);
  }

  // And a definition whose prose is shaped like a purpose statement is still printed as output prose.
  const [skill] = generateStageSkills({ "01-sample": minimal({ producesProse: "The purpose of this stage is to decide everything." }) });
  assert.ok(skill.content.includes("## Outputs\n\nThe purpose of this stage is to decide everything.\n"));
  assert.equal(/^## Purpose/m.test(skill.content), false);
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
    assert.equal(/purpose/i.test(frontmatter.description), false, `${skill.name}: the description claims a purpose the definition does not declare`);

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
