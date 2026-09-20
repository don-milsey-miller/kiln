/**
 * #34 — ONE `stages/` definition set. The app renders from it, the skills derive from it,
 * and — added 2026-08-18 — the gate reads *what a stage produces* from it and from nowhere
 * else.
 *
 * The ownership line, stated once so nothing has to re-derive it:
 *
 *     stages/  defines what a STAGE produces.
 *     schemas/ defines what an ARTIFACT is.
 *
 * `x-stage` on a schema is DERIVED METADATA for discoverability — never an authority. The
 * gate must not infer the pipeline from it, because two hand-maintained descriptions of one
 * pipeline will disagree, and the disagreement surfaces as the agent working confidently to
 * exit criteria the app isn't checking. That is #34's own sentence, and inferring produced
 * types from schema annotations would have walked straight into it.
 *
 * The definitions do not exist yet. This module therefore returns null rather than guessing,
 * which is what keeps `evaluateStageGate` fail-closed.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, basename } from "node:path";
import { toolRoot } from "./content-root.mjs";
import { ROLES, canonicalCapabilitiesFor } from "./specialists/roster.mjs";
import { NON_CREATION_WRITE_OPERATIONS } from "./tool-wire-names.mjs";

export const STAGES_DIR = "stages";

export class StageDefinitionError extends Error {
  constructor(message) {
    super(message);
    this.name = "StageDefinitionError";
  }
}

/** Where the definition set lives: tool-side (#69), not in a project's content. */
export function stagesDir(root = toolRoot()) {
  return join(root, STAGES_DIR);
}


/* ======================================================= the seven declared fields (TSK-0071) */

/**
 * The activities a stage may choose between, in the order they happen.
 *
 * ⚠️ **THE ORDER IS SEMANTIC, NOT ALPHABETICAL (D53).** A stage's list is a duplicate-free
 * SUBSEQUENCE of this one, so `["question", "attest", "exit"]` is valid and `["exit", "author"]` is
 * not. Sorting the list instead would accept a stage claiming it exits before it authors.
 */
export const STAGE_ACTIVITIES = Object.freeze(["question", "author", "delegate", "attest", "exit"]);

/** Each declared field and the exact key set it may have. `null` means the field is not an object. */
const DECLARED_FIELDS = Object.freeze({
  purpose: null,
  method: ["summary", "steps"],
  nextActivity: ["rule", "activities", "constraints"],
  delegations: null,
  mutationBoundary: ["mayMutate", "mayNotTouch"],
  approvalBoundary: ["approves", "requires"],
  completionSummary: ["format", "includes"],
});

/**
 * ⚠️ **EVERY REFUSAL NAMES THE STAGE AND THE FIELD.** A definition set is nine files; a message
 * saying only that something is malformed sends the reader through all of them.
 */
function refuse(stageId, field, why) {
  throw new StageDefinitionError(`${stageId} · ${field}: ${why}`);
}

/**
 * ⚠️ **A LINE BREAK WOULD CHANGE THE GENERATED DOCUMENT'S SHAPE.** A value that ends a list item
 * and starts a heading is no longer the value that was declared, so it is refused rather than reflowed.
 */
const isLine = (value) => typeof value === "string" && value.trim().length > 0 && !/[\r\n]/.test(value);

function requireLine(stageId, field, value) {
  if (!isLine(value)) refuse(stageId, field, "must be a single non-empty line, and no default is supplied for it.");
  return value;
}

function requireUnique(stageId, field, list) {
  const seen = new Set();
  for (const item of list) {
    if (seen.has(item)) refuse(stageId, field, `repeats ${JSON.stringify(item)}; a repeated entry is declared twice and read once.`);
    seen.add(item);
  }
}

function requireSorted(stageId, field, list) {
  for (let i = 1; i < list.length; i += 1)
    if (list[i - 1] > list[i]) refuse(stageId, field, `is not sorted: ${JSON.stringify(list[i])} follows ${JSON.stringify(list[i - 1])}.`);
}

/** A non-empty array of distinct lines. An empty list is refused rather than treated as "none stated". */
function requireLines(stageId, field, value) {
  if (!Array.isArray(value)) refuse(stageId, field, "must be an array.");
  if (value.length === 0) refuse(stageId, field, "must name at least one entry; an empty list is silence, not a declaration.");
  value.forEach((item, index) => requireLine(stageId, `${field}[${index}]`, item));
  requireUnique(stageId, field, value);
  return value;
}

/**
 * An object with EXACTLY these keys.
 *
 * ⚠️ **AN UNKNOWN KEY IS A REFUSAL (D55).** A key nothing reads looks authored and is never
 * carried anywhere, so a shadow field would sit in a canonical definition claiming to say something.
 */
function requireObject(stageId, field, value, keys) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) refuse(stageId, field, "must be an object, and no default is supplied for it.");
  const actual = Object.keys(value);
  for (const key of keys) if (!actual.includes(key)) refuse(stageId, `${field}.${key}`, "is missing, and no default is supplied for it.");
  for (const key of actual) if (!keys.includes(key)) refuse(stageId, `${field}.${key}`, `is not a key this field declares; it would be accepted and never read. Declared: ${keys.join(", ")}.`);
  return value;
}

/**
 * Check the seven a definition must declare - TSK-0071, toward ACC-0112.
 *
 * ⚠️ **THE LOADER REFUSES; IT NEVER FILLS IN.** A stage skill that says "delegate as appropriate"
 * because its definition was silent reads exactly like one whose definition said so, so a missing field
 * has to stop the load rather than acquire a default here or in the generator.
 *
 * ⚠️ **NO CANONICAL PROSE LIVES IN THIS FILE.** The approval sentence and the summary format are
 * content the definitions declare, not schema. Pinning their wording here would make nine definitions
 * unable to say anything else, and would put the methodology inside the loader.
 */
function checkDeclaredFields(stageId, def) {
  for (const field of Object.keys(DECLARED_FIELDS)) if (!(field in def)) refuse(stageId, field, "is missing, and no default is supplied for it.");

  // ⚠️ PURPOSE IS REQUIRED WHETHER OR NOT `producesProse` IS PRESENT (F88). `producesProse` describes
  // what a stage EMITS; borrowing it is inference by another route, refused like a template default.
  requireLine(stageId, "purpose", def.purpose);
  if (def.purpose === def.producesProse)
    refuse(stageId, "purpose", "repeats `producesProse`, which says what this stage emits rather than what it is for.");

  requireObject(stageId, "method", def.method, DECLARED_FIELDS.method);
  requireLine(stageId, "method.summary", def.method.summary);
  requireLines(stageId, "method.steps", def.method.steps);

  requireObject(stageId, "nextActivity", def.nextActivity, DECLARED_FIELDS.nextActivity);
  requireLine(stageId, "nextActivity.rule", def.nextActivity.rule);
  const activities = def.nextActivity.activities;
  if (!Array.isArray(activities)) refuse(stageId, "nextActivity.activities", "must be an array.");
  if (activities.length === 0) refuse(stageId, "nextActivity.activities", "must name at least one activity; a stage that may do nothing cannot proceed.");
  let reached = -1;
  for (const activity of activities) {
    const at = STAGE_ACTIVITIES.indexOf(activity);
    if (at < 0) refuse(stageId, "nextActivity.activities", `names ${JSON.stringify(activity)}, which is not one of ${STAGE_ACTIVITIES.join(", ")}.`);
    if (at <= reached)
      refuse(stageId, "nextActivity.activities", `names ${JSON.stringify(activity)} out of order or twice; the list is a duplicate-free subsequence of ${STAGE_ACTIVITIES.join(", ")}.`);
    reached = at;
  }
  requireLines(stageId, "nextActivity.constraints", def.nextActivity.constraints);

  // ⚠️ A DELEGATION IS CHECKED AGAINST THE CONTRACT, NEVER DERIVED FROM IT. The definition states
  // the role and its capabilities independently, so a definition and a contract that drift apart are a
  // refusal rather than a silent rewrite of whichever one was read second.
  const delegations = def.delegations;
  if (!Array.isArray(delegations)) refuse(stageId, "delegations", "must be an array, and `[]` when the stage delegates nowhere.");
  const rolesSeen = [];
  delegations.forEach((delegation, index) => {
    const field = `delegations[${index}]`;
    requireObject(stageId, field, delegation, ["role", "capabilities"]);
    if (!ROLES.includes(delegation.role)) refuse(stageId, `${field}.role`, `names ${JSON.stringify(delegation.role)}, which is not one of ${ROLES.join(", ")}.`);
    if (rolesSeen.includes(delegation.role)) refuse(stageId, `${field}.role`, `repeats ${JSON.stringify(delegation.role)}; one entry per role.`);
    rolesSeen.push(delegation.role);

    const declared = delegation.capabilities;
    if (!Array.isArray(declared)) refuse(stageId, `${field}.capabilities`, "must be an array, and `[]` when the role's contract requires none.");
    declared.forEach((name, at) => requireLine(stageId, `${field}.capabilities[${at}]`, name));
    requireUnique(stageId, `${field}.capabilities`, declared);
    requireSorted(stageId, `${field}.capabilities`, declared);
    const required = canonicalCapabilitiesFor(delegation.role);
    if (declared.length !== required.length || declared.some((name, at) => name !== required[at]))
      refuse(stageId, `${field}.capabilities`, `declares ${JSON.stringify(declared)}, and the ${delegation.role} contract requires ${JSON.stringify(required)}.`);
  });

  // ⚠️ CREATION IS `produces` AND IS NOT RESTATED HERE. This names what a stage may CHANGE.
  requireObject(stageId, "mutationBoundary", def.mutationBoundary, DECLARED_FIELDS.mutationBoundary);
  const mayMutate = def.mutationBoundary.mayMutate;
  if (!Array.isArray(mayMutate)) refuse(stageId, "mutationBoundary.mayMutate", "must be an array, and `[]` when the stage changes nothing.");
  mayMutate.forEach((operation, index) => {
    if (!NON_CREATION_WRITE_OPERATIONS.includes(operation))
      refuse(
        stageId,
        `mutationBoundary.mayMutate[${index}]`,
        `names ${JSON.stringify(operation)}, which is not a canonical non-creation operation. Creation is declared by \`produces\`. Known: ${NON_CREATION_WRITE_OPERATIONS.join(", ")}.`
      );
  });
  requireUnique(stageId, "mutationBoundary.mayMutate", mayMutate);
  requireSorted(stageId, "mutationBoundary.mayMutate", mayMutate);
  requireLines(stageId, "mutationBoundary.mayNotTouch", def.mutationBoundary.mayNotTouch);

  requireObject(stageId, "approvalBoundary", def.approvalBoundary, DECLARED_FIELDS.approvalBoundary);
  requireLine(stageId, "approvalBoundary.approves", def.approvalBoundary.approves);
  requireLines(stageId, "approvalBoundary.requires", def.approvalBoundary.requires);

  requireObject(stageId, "completionSummary", def.completionSummary, DECLARED_FIELDS.completionSummary);
  requireLine(stageId, "completionSummary.format", def.completionSummary.format);
  requireLines(stageId, "completionSummary.includes", def.completionSummary.includes);

  // ⚠️ **TWO FIELDS DESCRIBING ONE PERMISSION MUST NOT CONTRADICT EACH OTHER.** Each pair below is
  // an iff, not an implication, because either half alone would let a definition say a thing in one
  // place and unsay it in another - and the generated skill would carry both.
  const allows = (activity) => activities.includes(activity);
  if (allows("delegate") !== delegations.length > 0)
    refuse(
      stageId,
      "delegations",
      allows("delegate")
        ? "is empty while `nextActivity.activities` allows `delegate`; a stage that may delegate names where to."
        : "names a delegation while `nextActivity.activities` does not allow `delegate`."
    );
  if (allows("question") !== mayMutate.includes("writeStageDocument"))
    refuse(
      stageId,
      "mutationBoundary.mayMutate",
      allows("question")
        ? "omits `writeStageDocument` while `nextActivity.activities` allows `question`; an answer that cannot be recorded is not a question this stage can ask."
        : "allows `writeStageDocument` while `nextActivity.activities` does not allow `question`; that operation records an operator's answer to one."
    );
  if (allows("attest") && !mayMutate.includes("writeStageAttestation"))
    refuse(stageId, "mutationBoundary.mayMutate", "omits `writeStageAttestation` while `nextActivity.activities` allows `attest`; an attestation that cannot be written is not one.");
}

/**
 * Load the stage definition set, or null when it does not exist.
 *
 * @returns {null | Record<string, {id: string, produces: string[], exitCriteria?: Array<{id: string, describe: string}>}>}
 */
export function loadStageDefinitions(root = toolRoot()) {
  const dir = stagesDir(root);
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  if (files.length === 0) return null;

  const defs = {};
  for (const f of files) {
    const def = JSON.parse(readFileSync(join(dir, f), "utf-8"));
    const id = def.id ?? basename(f, ".json");
    if (!Array.isArray(def.produces))
      throw new StageDefinitionError(`${f}: a stage definition must declare \`produces\` as an array of artifact types.`);
    checkDeclaredFields(id, def);
    defs[id] = { ...def, id };
  }
  return defs;
}

/**
 * Check that every schema's `x-stage` agrees with the stage that claims to produce it.
 * Only meaningful once the definitions exist; returns [] otherwise, because there is nothing
 * to disagree with yet.
 *
 * @returns {Array<{type: string, xStage: string|null, producedBy: string[]}>} disagreements
 */
export function stageAnnotationDisagreements(schemaSet, defs) {
  if (!defs) return [];
  const out = [];
  for (const [type, schema] of Object.entries(schemaSet.types)) {
    const xStage = schema["x-stage"] ?? null;
    const producedBy = Object.values(defs)
      .filter((d) => d.produces.includes(type))
      .map((d) => d.id)
      .sort();
    // #90's strengthened invariant: an x-stage must RESOLVE to a real definition first —
    // a partial stages/ must never look like a complete authority.
    if (xStage !== null && !(xStage in defs)) {
      out.push({ type, xStage, producedBy, reason: "unresolvable" });
      continue;
    }
    const agrees = xStage === null ? producedBy.length === 0 : producedBy.length === 1 && producedBy[0] === xStage;
    if (!agrees) out.push({ type, xStage, producedBy, reason: "disagrees" });
  }
  return out;
}

/**
 * Types a stage claims to produce that are not in #38's catalogue at all.
 *
 * ⚠️ This is the mechanical half of #107. Removing a type from the catalogue while leaving it
 * in a stage's `produces[]` leaves the METHODOLOGY still claiming an output the product has
 * decided does not exist — and because the gate skips unactivated types, nothing would say so.
 * Deactivating is not deleting: the three authorities move together or they disagree quietly.
 */
export function producesUnknownTypes(schemaSet, defs) {
  if (!defs) return [];
  const known = Object.keys(schemaSet.common.$defs?.typePrefixes?.const ?? {});
  const out = [];
  for (const def of Object.values(defs))
    for (const type of def.produces ?? [])
      if (!known.includes(type)) out.push({ stageId: def.id, type });
  return out;
}

/** What a stage produces — from the definitions, never from schema annotations. */
export function producedBy(defs, stageId) {
  if (!defs) return null;
  const def = defs[stageId];
  if (!def) throw new StageDefinitionError(`No stage definition for ${JSON.stringify(stageId)}.`);
  return def.produces;
}
