/**
 * The typed tools, by artifact type. One registry, because the lint has to know which types
 * can actually be authored (#94) and inferring that from FILE NAMES is a hidden contract:
 * it broke the moment three tools shared a module, and it broke silently — reporting a
 * capability gap for a type that had a working tool.
 *
 * #88: nothing may write an artifact except through one of these.
 */

import { createRequirement } from "./create-requirement.mjs";
import { createAssertion, createEvidence, createRunbookStep, linkEvidence, unlinkEvidence, reviseArtifact } from "./evidence-tools.mjs";

export const TYPED_TOOLS = {
  requirement: createRequirement,
  assertion: createAssertion,
  evidence: createEvidence,
  "runbook-step": createRunbookStep,
};

/** Operations that MUTATE an existing artifact. Separate from creation because #88 governs
 *  creation and #78 governs update, and a link is a judgement that may need undoing (#101). */
export const MUTATION_TOOLS = { linkEvidence, unlinkEvidence, reviseArtifact };

/** Types that can be authored today. The lint's capability check reads this, not the filesystem. */
export function implementedTypes() {
  return Object.keys(TYPED_TOOLS);
}
