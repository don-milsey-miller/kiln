/**
 * The typed tools, by artifact type. One registry, because the lint has to know which types
 * can actually be authored (#94) and inferring that from FILE NAMES is a hidden contract:
 * it broke the moment three tools shared a module, and it broke silently — reporting a
 * capability gap for a type that had a working tool.
 *
 * #88: nothing may write an artifact except through one of these.
 */

import { createRequirement } from "./create-requirement.mjs";
import { setTypeActivation } from "./activate-type.mjs";
import { linkTrace, unlinkTrace } from "./link-trace.mjs";
import { setReviewStatus } from "./review-status.mjs";
import { createAssertion, createEvidence, createRunbookStep, createQuestion, createDecision, createComponent, createAcceptanceCriterion, createTask, linkEvidence, unlinkEvidence, reviseArtifact, setLifecycle, resolveQuestion } from "./evidence-tools.mjs";

export const TYPED_TOOLS = {
  requirement: createRequirement,
  assertion: createAssertion,
  evidence: createEvidence,
  "runbook-step": createRunbookStep,
  question: createQuestion,
  decision: createDecision,
  component: createComponent,
  "acceptance-criterion": createAcceptanceCriterion,
  task: createTask,
};

/** Operations that MUTATE an existing artifact. Separate from creation because #88 governs
 *  creation and #78 governs update, and a link is a judgement that may need undoing (#101). */
export const MUTATION_TOOLS = { linkEvidence, unlinkEvidence, reviseArtifact, setLifecycle, resolveQuestion, linkTrace, unlinkTrace, setReviewStatus };

/**
 * Operations on PROJECT-LEVEL state rather than on an artifact.
 *
 * ⚠️ A separate category on purpose. MUTATION_TOOLS is documented as operations that mutate an
 * existing artifact, and the manifest is not an artifact — filing activation there would blur two
 * kinds of thing into one list, which is the blurring #125's implementation note refused for a
 * different reason. Activation is also governed differently: #39 makes it a PM approval, and #95
 * keeps it separate from catalogue membership.
 */
export const PROJECT_TOOLS = { setTypeActivation };

/** Types that can be authored today. The lint's capability check reads this, not the filesystem. */
export function implementedTypes() {
  return Object.keys(TYPED_TOOLS);
}
