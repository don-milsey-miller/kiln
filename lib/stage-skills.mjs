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

/**
 * A stage's question-selection rule, when its definition declares one.
 *
 * ⚠️ **OPTIONAL, AND ABSENCE IS NOT A DEFAULT.** Only Stage 1 declares this today. Requiring it would mean
 * authoring a rule for eight stages whose method nobody has settled, which is the inference this module
 * refuses everywhere else; a stage without it simply gets no section.
 *
 * ⚠️ **IT SAYS WHICH QUESTION, NOT WHETHER TO ASK ONE.** Choosing between questioning, authoring, delegating,
 * attesting and exiting is the next-activity field TSK-0071 adds, and every stage still declares it absent.
 */
function readQuestionSelection(stageId, value) {
  if (value === undefined) return null;
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new StageSkillError(stageId, "questionSelection", "must be an object when it is declared at all.");

  const afterAnswer = stringList(stageId, "questionSelection.afterAnswer", value.afterAnswer, { required: true });
  if (afterAnswer.length === 0)
    throw new StageSkillError(stageId, "questionSelection.afterAnswer", "must name at least one step; a rule with no sequence says nothing about what to do.");
  const constraints = stringList(stageId, "questionSelection.constraints", value.constraints, { required: true });
  if (constraints.length === 0)
    throw new StageSkillError(stageId, "questionSelection.constraints", "must name at least one constraint.");

  return {
    rule: line(stageId, "questionSelection.rule", value.rule),
    afterAnswer,
    constraints,
    whenIntakeAbsent: line(stageId, "questionSelection.whenIntakeAbsent", value.whenIntakeAbsent),
    whenIntakeInvalid: line(stageId, "questionSelection.whenIntakeInvalid", value.whenIntakeInvalid),
  };
}

/**
 * The seven a definition declares, read for RENDERABILITY and nothing else - TSK-0071 (ACC-0112).
 *
 * ⚠️ **THE VOCABULARY AND THE CROSS-FIELD RULES BELONG TO THE LOADER, NOT HERE.** Whether an
 * activity is one of the five, whether a delegation's capabilities equal its contract's, whether
 * `delegate` and a declared delegation agree - `lib/stages.mjs` refuses all of that before a definition
 * is returned, and `bin/generate-stage-skills.mjs` loads through it. Repeating those checks here would
 * be a second description of one rule, and the second one is what goes stale. What this function owns
 * is narrower: every value it is about to put into a document is a line the document can carry.
 *
 * ⚠️ **AN EMPTY DECLARATION SURVIVES AS AN EMPTY DECLARATION.** `delegations: []` and
 * `mayMutate: []` are things a stage SAYS, and the skill prints them as such. Dropping the section, or
 * replacing it with a sentence the generator composed, would turn a declaration into an inference.
 */
function readDeclaredFields(stageId, def) {
  // ⚠️ **AN EMPTY LIST HERE WOULD RENDER AS A HEADING WITH NOTHING UNDER IT.** `stringList` accepts
  // one, because `outputsNotYetTyped` may legitimately be empty. These six may not: a Method with no
  // steps, or a Boundaries section naming nothing it must not touch, is a hole the reader cannot see.
  // `delegations`, `mayMutate` and a delegation's `capabilities` are the three that MAY be empty, and
  // they are rendered as `[]` rather than omitted.
  const nonEmpty = (field, value) => {
    const list = stringList(stageId, field, value, { required: true });
    if (list.length === 0) throw new StageSkillError(stageId, field, "must name at least one entry; a heading with nothing under it states nothing.");
    return list;
  };
  const object = (field, value) => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) throw new StageSkillError(stageId, field, "must be an object.");
    return value;
  };
  const method = object("method", def.method);
  const nextActivity = object("nextActivity", def.nextActivity);
  const mutationBoundary = object("mutationBoundary", def.mutationBoundary);
  const approvalBoundary = object("approvalBoundary", def.approvalBoundary);
  const completionSummary = object("completionSummary", def.completionSummary);

  if (!Array.isArray(def.delegations)) throw new StageSkillError(stageId, "delegations", "must be an array.");

  return {
    purpose: line(stageId, "purpose", def.purpose),
    method: {
      summary: line(stageId, "method.summary", method.summary),
      steps: nonEmpty("method.steps", method.steps),
    },
    nextActivity: {
      rule: line(stageId, "nextActivity.rule", nextActivity.rule),
      activities: nonEmpty("nextActivity.activities", nextActivity.activities),
      constraints: nonEmpty("nextActivity.constraints", nextActivity.constraints),
    },
    delegations: def.delegations.map((delegation, index) => {
      const field = `delegations[${index}]`;
      object(field, delegation);
      return {
        role: line(stageId, `${field}.role`, delegation.role),
        capabilities: stringList(stageId, `${field}.capabilities`, delegation.capabilities, { required: true }),
      };
    }),
    mutationBoundary: {
      mayMutate: stringList(stageId, "mutationBoundary.mayMutate", mutationBoundary.mayMutate, { required: true }),
      mayNotTouch: nonEmpty("mutationBoundary.mayNotTouch", mutationBoundary.mayNotTouch),
    },
    approvalBoundary: {
      approves: line(stageId, "approvalBoundary.approves", approvalBoundary.approves),
      requires: nonEmpty("approvalBoundary.requires", approvalBoundary.requires),
    },
    completionSummary: {
      format: line(stageId, "completionSummary.format", completionSummary.format),
      includes: nonEmpty("completionSummary.includes", completionSummary.includes),
    },
  };
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
    questionSelection: readQuestionSelection(stageId, def.questionSelection),
    ...readDeclaredFields(stageId, def),
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
  // ⚠️ **IT NAMES WHAT THE SKILL NOW CARRIES.** The old sentence promised the decision owner, the
  // outputs and the exit criteria, which was the whole document then and is a third of it now. A
  // description that undersells the skill is a description Pi uses to not load it.
  const text =
    `Kiln planning stage ${stage.stageId.slice(0, 2)}, ${stage.title}: its purpose, method, next activity, allowed ` +
    `delegations, mutation and approval boundaries, completion summary, decision owner, outputs and exit criteria ` +
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
    "## Purpose",
    "",
    stage.purpose,
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
    )
  );


  // ⚠️ **THE SEVEN DECLARED FIELDS, EACH AS THE DEFINITION WROTE IT.** The headings and the two
  // labels below are this generator's only contribution; every substantive line is the definition's.
  lines.push(
    "",
    "## Method",
    "",
    stage.method.summary,
    "",
    ...stage.method.steps.map((step, i) => `${i + 1}. ${step}`),
    "",
    "## Next activity",
    "",
    stage.nextActivity.rule,
    "",
    "Activities this stage may choose between, in order:",
    "",
    ...stage.nextActivity.activities.map((activity) => `- \`${activity}\``),
    "",
    "Always:",
    "",
    ...stage.nextActivity.constraints.map((constraint) => `- ${constraint}`),
    "",
    "## Delegations"
  );

  // ⚠️ **AN EMPTY DECLARATION IS PRINTED AS `[]`, AND NOTHING IS ADDED TO IT (F59).** An earlier
  // version wrote "this stage delegates to no specialist" beside it. That sentence is a conclusion the
  // GENERATOR drew from an empty list, which is the inference ACC-0112 forbids: the instruction a stage
  // carries has to be one its definition supplied. `[]` is what the definition says, so `[]` is what the
  // skill shows, and a stage that delegates nowhere still reads differently from one that forgot to say.
  if (stage.delegations.length === 0) lines.push("", "`[]`");
  else
    lines.push(
      "",
      ...stage.delegations.map((delegation) => `- \`${delegation.role}\` — requires ${delegation.capabilities.length === 0 ? "`[]`" : delegation.capabilities.map((c) => `\`${c}\``).join(", ")}`)
    );

  lines.push("", "## Boundaries", "", "This stage may perform these non-creation operations:");
  if (stage.mutationBoundary.mayMutate.length === 0) lines.push("", "`[]`");
  else lines.push("", ...stage.mutationBoundary.mayMutate.map((operation) => `- \`${operation}\``));

  lines.push(
    "",
    "It must not touch:",
    "",
    ...stage.mutationBoundary.mayNotTouch.map((what) => `- ${what}`),
    "",
    `Approving this stage approves: ${stage.approvalBoundary.approves}`,
    "",
    "Approval requires:",
    "",
    ...stage.approvalBoundary.requires.map((requirement) => `- ${requirement}`),
    "",
    "## Completion summary",
    "",
    stage.completionSummary.format,
    "",
    "It states:",
    "",
    ...stage.completionSummary.includes.map((item) => `- ${item}`)
  );

  // ⚠️ **EVERY LINE HERE IS THE DEFINITION'S OWN.** The headings and the four labels below are this generator's
  // only contribution; a rule reworded on its way into a skill is a rule nobody authored.
  if (stage.questionSelection) {
    const q = stage.questionSelection;
    lines.push(
      "",
      "## Choosing the next question",
      "",
      q.rule,
      "",
      "After an answer:",
      "",
      ...q.afterAnswer.map((step, i) => `${i + 1}. ${step}`),
      "",
      "Always:",
      "",
      ...q.constraints.map((constraint) => `- ${constraint}`),
      "",
      `If this stage's intake is reported \`absent\`: ${q.whenIntakeAbsent}`,
      `If it is reported \`invalid\`: ${q.whenIntakeInvalid}`
    );
  }

  // ⚠️ **THERE IS NO `## Not in this skill` SECTION ANY MORE, AND THERE MUST NOT BE (ACC-0112).**
  // It existed to say that the seven were undeclared. They are declared, every one of them is rendered
  // above, and a section still announcing their absence would be the skill contradicting itself.

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
