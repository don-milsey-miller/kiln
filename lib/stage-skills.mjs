/**
 * The stage-skill generator — CMP-0033, TSK-0046, against ACC-0066.
 *
 * One packaged skill per canonical stage definition, so that who decides a stage, what it produces
 * and when it may be exited are written once, in `stages/*.json`, and never maintained a second time
 * in prose an agent reads.
 *
 * ⚠️ **PURE, AND THAT IS THE WHOLE DESIGN OF THIS FILE.** Definitions in, `{ path: content }` out. No
 * filesystem, no environment, no clock, no randomness. The write mode and the check mode that come
 * later call this same function and differ only in what they do with its answer, so a check can never
 * compare against output a different code path would have produced.
 *
 * ⚠️ **ONLY WHAT THE DEFINITION CARRIES, UNDER THE NAME IT CARRIES IT.** The decision owner, the outputs
 * and the exit criteria come from `stages/*.json` verbatim. A stage's purpose, its method, how to choose
 * the next activity, its allowed delegations, its mutation and approval boundaries and its completion
 * summary are NOT written here, because no definition declares them yet; TSK-0071 adds them to the
 * definitions first. A template that supplied them would read exactly like a definition that did.
 *
 * ⚠️ **`producesProse` IS OUTPUT PROSE, AND IT STAYS OUTPUT PROSE (F88).** It says what a stage emits,
 * not what the stage is for. Printing it under a Purpose heading would be the same inference by another
 * route - a field relabelled to stand in for one that does not exist - so it is rendered under Outputs.
 *
 * ⚠️ **A MISSING FIELD IS A REFUSAL, NEVER A DEFAULT,** for the same reason.
 *
 * ⚠️ **THE GENERATOR OWNS `kiln-stage-*` AND NOTHING ELSE.** `kiln-planning` is handwritten.
 * `isStageSkillName` is the one statement of that boundary, so nothing downstream decides it again.
 */

import { byCodeUnit, yamlString } from "./project-scaffold.mjs";

export const STAGE_SKILL_PREFIX = "kiln-stage-";
export const SKILLS_DIR = "skills";
export const SKILL_FILE = "SKILL.md";

/** Pi's skill-name rules, as its loader enforces them: lowercase alphanumerics in hyphen-separated runs. */
const PI_SKILL_NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const PI_SKILL_NAME_MAX = 64;
const PI_DESCRIPTION_MAX = 1024;

/** A stage id as the definitions spell them: a two-digit ordinal, then a hyphenated slug. */
const STAGE_ID = /^[0-9]{2}(-[a-z0-9]+)+$/;

export class StageSkillError extends Error {
  constructor(stageId, field, message) {
    super(`${stageId ?? "<unknown stage>"}: ${field}: ${message}`);
    this.name = "StageSkillError";
    this.stageId = stageId ?? null;
    this.field = field;
  }
}

/** The packaged skill name for a stage. */
export const stageSkillName = (stageId) => `${STAGE_SKILL_PREFIX}${stageId}`;

/** Where that skill lives, relative to the package root, with `/` separators on every platform. */
export const stageSkillPath = (stageId) => `${SKILLS_DIR}/${stageSkillName(stageId)}/${SKILL_FILE}`;

/**
 * Whether a skill name is one this generator owns.
 *
 * ⚠️ **THE BOUNDARY BETWEEN GENERATED AND HANDWRITTEN.** Only a well-formed `kiln-stage-<stage-id>`
 * name is the generator's. `kiln-planning`, a consumer's own skill, and a name that merely starts with
 * the prefix are not, so no later check may call them orphaned and no later write may remove them.
 */
export function isStageSkillName(name) {
  if (typeof name !== "string" || !name.startsWith(STAGE_SKILL_PREFIX)) return false;
  return STAGE_ID.test(name.slice(STAGE_SKILL_PREFIX.length));
}

/** A single-line, non-empty string, or a refusal naming the stage and the field. */
function line(stageId, field, value) {
  if (typeof value !== "string" || value.trim().length === 0)
    throw new StageSkillError(stageId, field, "must be a non-empty string, and no default is supplied for it.");
  // ⚠️ A NEWLINE WOULD CHANGE THE DOCUMENT'S SHAPE. A value that ends a list item and starts a heading
  // is no longer the value that was declared, so it is refused rather than reflowed.
  if (/[\r\n]/.test(value)) throw new StageSkillError(stageId, field, "must be a single line; a line break would change the skill's structure.");
  return value;
}

function stringList(stageId, field, value, { required }) {
  if (value === undefined && !required) return [];
  if (!Array.isArray(value)) throw new StageSkillError(stageId, field, "must be an array.");
  return value.map((item, index) => line(stageId, `${field}[${index}]`, item));
}

/** One definition, checked field by field, reduced to exactly what this generator may emit. */
function readDefinition(key, def) {
  const stageId = def?.id ?? key;
  if (typeof stageId !== "string" || !STAGE_ID.test(stageId))
    throw new StageSkillError(String(stageId), "id", "must be a two-digit ordinal followed by a lowercase hyphenated slug, such as 01-intake.");

  const name = stageSkillName(stageId);
  if (!PI_SKILL_NAME.test(name) || name.length > PI_SKILL_NAME_MAX)
    throw new StageSkillError(stageId, "id", `produces the skill name ${name}, which Pi would not load.`);

  if (!Array.isArray(def.exitCriteria) || def.exitCriteria.length === 0)
    throw new StageSkillError(stageId, "exitCriteria", "must be a non-empty array; a stage with no exit criteria cannot say when it is finished.");

  return {
    stageId,
    name,
    title: line(stageId, "name", def.name),
    decisionOwner: line(stageId, "decidedBy", def.decidedBy),
    // ⚠️ NAMED FOR WHAT THE FIELD IS (F88): what the stage produces, described in prose.
    outputProse: line(stageId, "producesProse", def.producesProse),
    produces: stringList(stageId, "produces", def.produces, { required: true }),
    notYetTyped: stringList(stageId, "outputsNotYetTyped", def.outputsNotYetTyped, { required: false }),
    exitCriteria: def.exitCriteria.map((criterion, index) => {
      const field = `exitCriteria[${index}]`;
      if (criterion === null || typeof criterion !== "object") throw new StageSkillError(stageId, field, "must be an object.");
      return {
        id: line(stageId, `${field}.id`, criterion.id),
        describe: line(stageId, `${field}.describe`, criterion.describe),
        mechanised: criterion.mechanised === true,
      };
    }),
  };
}

/** The description Pi keeps in context for every skill, so it says precisely when this one applies. */
function describe(stage) {
  const text =
    `Kiln planning stage ${stage.stageId.slice(0, 2)}, ${stage.title}: its decision owner, outputs and exit criteria ` +
    `as the canonical stage definition declares them. Use when the project's current stage is ${stage.stageId}.`;
  if (text.length > PI_DESCRIPTION_MAX)
    throw new StageSkillError(stage.stageId, "description", `would be ${text.length} characters; Pi does not load a description over ${PI_DESCRIPTION_MAX}.`);
  return text;
}

function render(stage) {
  const lines = [
    "---",
    `name: ${yamlString(stage.name)}`,
    `description: ${yamlString(describe(stage))}`,
    "---",
    "",
    // ⚠️ THE ONLY METADATA, AND NONE OF IT VARIES: no timestamp, no tool version, no machine. Output
    // that changed with the clock would make every check stale.
    `<!-- Generated by lib/stage-skills.mjs from stages/${stage.stageId}.json. Do not edit this file: edit the stage definition and regenerate. -->`,
    "",
    `# Stage ${stage.stageId.slice(0, 2)} — ${stage.title}`,
    "",
    "## Decision owner",
    "",
    stage.decisionOwner,
    "",
    "## Outputs",
    "",
    stage.outputProse,
    "",
  ];

  if (stage.produces.length === 0) lines.push("This stage produces no typed artifact.");
  else lines.push("Typed artifacts this stage produces:", "", ...stage.produces.map((type) => `- \`${type}\``));

  if (stage.notYetTyped.length > 0) lines.push("", "Outputs the definition names that have no artifact type yet:", "", ...stage.notYetTyped.map((output) => `- ${output}`));

  lines.push(
    "",
    "## Exit criteria",
    "",
    ...stage.exitCriteria.map(
      (c) => `- \`${c.id}\` — ${c.describe} ${c.mechanised ? "(checked by the application)" : "(evaluated by a person and recorded as an attestation)"}`
    ),
    "",
    "## Not in this skill",
    "",
    "This stage's purpose, its method, how to choose the next question or activity, its allowed delegations, its mutation and approval boundaries and its completion summary are not stated here, because its canonical definition does not declare them yet."
  );

  // ⚠️ LF, AND EXACTLY ONE TRAILING NEWLINE, on every platform.
  return `${lines.join("\n")}\n`;
}

/**
 * Every packaged stage skill the definitions call for.
 *
 * @param {Record<string, object>} definitions  what `loadStageDefinitions` returns
 * @returns {ReadonlyArray<Readonly<{stageId: string, name: string, path: string, content: string}>>}
 *   sorted by skill name in code-unit order, so the answer never depends on how the input was built
 */
export function generateStageSkills(definitions) {
  if (definitions === null || typeof definitions !== "object" || Array.isArray(definitions))
    throw new StageSkillError(null, "definitions", "must be the stage definition set; there is nothing to generate from.");

  const stages = Object.entries(definitions).map(([key, def]) => readDefinition(key, def));

  const seen = new Set();
  for (const stage of stages) {
    if (seen.has(stage.name)) throw new StageSkillError(stage.stageId, "id", `is declared twice, so ${stage.name} would be generated twice.`);
    seen.add(stage.name);
  }

  return Object.freeze(
    stages
      .sort((a, b) => byCodeUnit(a.name, b.name))
      .map((stage) => Object.freeze({ stageId: stage.stageId, name: stage.name, path: stageSkillPath(stage.stageId), content: render(stage) }))
  );
}
