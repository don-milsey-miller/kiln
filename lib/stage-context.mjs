/**
 * The current stage's skill, exactly as Pi resolved it - TSK-0048 (G4), toward ACC-0068 (D11).
 *
 * ⚠️ **PI'S LOADED SKILLS ARE THE AUTHORITY.** The session's own `systemPromptOptions.skills` already records which
 * file Pi resolved for every skill name, a consumer override included. This module never looks for package or
 * override directories itself: a second discovery could pick a different file from the one the session loaded.
 *
 * ⚠️ **ONE MATCH OR A REFUSAL.** The current stage is derived through G2 (`deriveOrchestratorState`) and mapped
 * through `stageSkillName`. No loaded skill of that name, more than one, or a file that cannot be read each end in a
 * stable code; nothing is guessed and no other stage's skill stands in.
 *
 * ⚠️ **CODES, NEVER ERROR TEXT.** A failure is reported by a code the caller writes into an authored message. An
 * error's own message - a loader quoting an absolute path, a parse excerpt - is kept only as a cause.
 */

import { readFileSync } from "node:fs";

import { TOOL_CONTENT_REFUSED } from "./orchestrator-root.mjs";
import { deriveOrchestratorState } from "./orchestrator-state.mjs";
import { toProjectStatusRefusal } from "./project-status.mjs";
import { stageSkillName } from "./stage-skills.mjs";

export const STAGE_CONTEXT_REFUSAL = Object.freeze({
  SKILL_MISSING: "stage-skill-missing",
  SKILL_AMBIGUOUS: "stage-skill-ambiguous",
  SKILL_UNREADABLE: "stage-skill-unreadable",
});

export class StageContextError extends Error {
  constructor(code, { cause } = {}) {
    super(code, cause === undefined ? undefined : { cause });
    this.name = "StageContextError";
    this.code = code;
  }
}

/** A stable code for any failure while building the stage context. */
export function stageContextCode(error) {
  if (error instanceof StageContextError) return error.code;
  if (error?.code === TOOL_CONTENT_REFUSED) return TOOL_CONTENT_REFUSED;
  if (error?.name === "ContentRootError") return "no-content-root";
  return toProjectStatusRefusal(error).code;
}

/**
 * The derived current stage and the complete content of its loaded skill, or completion.
 *
 * @param {{contentRoot: string, schemas: object, validators: object, activated: string[]}} ctx
 * @param {{toolRoot?: string, skills?: Array<{name: string, filePath: string}>}} options
 * @returns {{complete: true} | {complete: false, stage: {id: string, name: string|null, decidedBy: string|null}, skillName: string, content: string}}
 */
export function resolveStageContext(ctx, { toolRoot, skills } = {}) {
  const state = deriveOrchestratorState(ctx, { toolRoot });
  if (state.complete) return { complete: true };

  const skillName = stageSkillName(state.currentStage.id);
  const matches = (Array.isArray(skills) ? skills : []).filter((skill) => skill?.name === skillName);
  if (matches.length === 0) throw new StageContextError(STAGE_CONTEXT_REFUSAL.SKILL_MISSING);
  if (matches.length > 1) throw new StageContextError(STAGE_CONTEXT_REFUSAL.SKILL_AMBIGUOUS);

  let content;
  try {
    const { filePath } = matches[0];
    if (typeof filePath !== "string" || filePath.length === 0) throw new TypeError("the loaded skill names no file");
    content = readFileSync(filePath, "utf8");
  } catch (cause) {
    throw new StageContextError(STAGE_CONTEXT_REFUSAL.SKILL_UNREADABLE, { cause });
  }
  return { complete: false, stage: state.currentStage, skillName, content };
}
