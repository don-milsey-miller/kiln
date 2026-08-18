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
    const agrees = xStage === null ? producedBy.length === 0 : producedBy.length === 1 && producedBy[0] === xStage;
    if (!agrees) out.push({ type, xStage, producedBy });
  }
  return out;
}

/** What a stage produces — from the definitions, never from schema annotations. */
export function producedBy(defs, stageId) {
  if (!defs) return null;
  const def = defs[stageId];
  if (!def) throw new StageDefinitionError(`No stage definition for ${JSON.stringify(stageId)}.`);
  return def.produces;
}
