/** Vendor-neutral, task-specific decisioning operations. */

import { invalidDecisioningInput } from "./refusal.mjs";
import {
  ARTIFACT_RELATIONSHIP_CRITERIA,
  ARTIFACT_RELATIONSHIPS,
  TRACE_RELEVANCE,
  TRACE_RELEVANCE_CRITERIA,
  RESEARCH_TRIAGE,
  RESEARCH_TRIAGE_CRITERIA,
  advisoryPolicy,
  toolFamilyCriteria,
} from "./policy.mjs";

const MAX_CANDIDATES = 20;
const nonEmpty = (value) => typeof value === "string" && value.trim().length > 0;
export const DECISIONING_ARTIFACT_TYPES = Object.freeze([
  "acceptance-criterion",
  "api-spec",
  "assertion",
  "component",
  "decision",
  "evidence",
  "question",
  "requirement",
  "runbook-step",
  "schema",
  "task",
  "wireframe",
]);

export const DECISIONING_TOOL_SIGNATURES = Object.freeze({
  kiln_decisioning_capability: {
    description:
      "Report whether the optional semantic decisioning backend is usable. Advisory only; deterministic Kiln rules remain authoritative.",
    input: { type: "object", properties: {}, additionalProperties: false },
  },
  kiln_route_turn: {
    description:
      "Classify the current request into a stage-permitted activity and tool family. The result only narrows attention; it never grants access or changes state.",
    input: {
      type: "object",
      properties: { request: { type: "string", minLength: 1, maxLength: 12000 } },
      required: ["request"],
      additionalProperties: false,
    },
  },
  kiln_compare_artifacts: {
    description:
      "Compare a proposed artifact with existing same-type candidates as distinct, duplicate, overlapping, refining, or contradictory. Advisory only.",
    input: {
      type: "object",
      properties: {
        type: { type: "string", enum: DECISIONING_ARTIFACT_TYPES },
        content: { type: "string", minLength: 1, maxLength: 24000 },
        candidateIds: {
          type: "array",
          minItems: 1,
          maxItems: MAX_CANDIDATES,
          uniqueItems: true,
          items: { type: "string", pattern: "^[A-Z]+-[0-9]{4,}$" },
        },
      },
      required: ["type", "content", "candidateIds"],
      additionalProperties: false,
    },
  },
  kiln_rank_trace_targets: {
    description:
      "Rank structurally legal trace targets by semantic relevance. Advisory only; this never creates a trace or changes graph legality.",
    input: {
      type: "object",
      properties: {
        sourceId: { type: "string", pattern: "^[A-Z]+-[0-9]{4,}$" },
        field: { type: "string", minLength: 1, maxLength: 100 },
        candidateIds: {
          type: "array",
          minItems: 1,
          maxItems: MAX_CANDIDATES,
          uniqueItems: true,
          items: { type: "string", pattern: "^[A-Z]+-[0-9]{4,}$" },
        },
      },
      required: ["sourceId", "field", "candidateIds"],
      additionalProperties: false,
    },
  },
});

function answerIsChoice(answer, allowed) {
  return answer?.type === "choice" && allowed.includes(answer.choice) &&
    Number.isFinite(answer.confidence) && answer.probabilities !== null &&
    typeof answer.probabilities === "object";
}

function answerIsNoul(answer) {
  return answer?.type === "noul" && Number.isFinite(answer.noul) && answer.noul >= 0 && answer.noul <= 1;
}

export function createDecisioningTools(adapter) {
  if (!adapter?.probe || !adapter?.evaluate)
    throw new TypeError("A decisioning adapter must supply probe() and evaluate().");

  async function kiln_decisioning_capability() {
    const probe = await adapter.probe();
    if (probe.ok === false)
      return {
        tool: "kiln_decisioning_capability",
        available: false,
        backend: adapter.name,
        ...probe,
        signatures: DECISIONING_TOOL_SIGNATURES,
      };
    return {
      tool: "kiln_decisioning_capability",
      available: true,
      backend: probe.backend,
      model: probe.model,
      models: probe.models,
      probedLive: true,
      checkedWithoutInference: probe.checkedWithoutInference === true,
      policy: advisoryPolicy,
      signatures: DECISIONING_TOOL_SIGNATURES,
    };
  }

  async function kiln_route_turn(input) {
    if (!nonEmpty(input?.request)) return invalidDecisioningInput("`request` is required.");
    const stage = input?.stage;
    const activities = stage?.permittedActivities;
    const families = stage?.permittedToolFamilies;
    if (!nonEmpty(stage?.id) || !Array.isArray(activities) || activities.length === 0 ||
        !activities.every(nonEmpty) || !Array.isArray(families) || families.length === 0 || !families.every(nonEmpty))
      return invalidDecisioningInput("A current stage with permitted activities and tool families is required.");

    const evaluated = await adapter.evaluate({
      state: {
        user_request: input.request.trim(),
        current_stage: {
          id: stage.id,
          name: stage.name ?? null,
          purpose: stage.purpose ?? null,
          next_activity_rule: stage.nextActivityRule ?? null,
        },
        deterministic_state: {
          blockers: Array.isArray(stage.blockers) ? stage.blockers : [],
          recommended_next_action: stage.nextAction ?? null,
          permitted_activities: activities,
          permitted_tool_families: families,
        },
      },
      questions: {
        activity: {
          type: "choice",
          instructions:
            "Which `permitted_activities` entry best describes the next bounded activity needed for `user_request`? Choose only from the supplied criteria.",
          criteria: Object.fromEntries(activities.map((activity) => [activity, null])),
        },
        tool_family: {
          type: "choice",
          instructions:
            "Which `permitted_tool_families` entry best supports that next activity? This recommendation can narrow attention but cannot grant a tool.",
          criteria: toolFamilyCriteria(families),
        },
        needs_research: {
          type: "noul",
          instructions:
            "Does resolving `user_request` require information not present in the supplied project state and therefore require approved external research?",
        },
        needs_validation: {
          type: "noul",
          instructions:
            "Does resolving `user_request` require executing or observing a declared validation job rather than reasoning from project records alone?",
        },
        needs_operator_decision: {
          type: "noul",
          instructions:
            "Does the next step require an operator answer, approval, activation, review decision, or attestation?",
        },
      },
    });
    if (evaluated.ok === false) return { tool: "kiln_route_turn", ...evaluated };

    const answers = evaluated.answers;
    if (!answerIsChoice(answers?.activity, activities) || !answerIsChoice(answers?.tool_family, families) ||
        !answerIsNoul(answers?.needs_research) || !answerIsNoul(answers?.needs_validation) ||
        !answerIsNoul(answers?.needs_operator_decision))
      return {
        tool: "kiln_route_turn",
        ok: false,
        kind: "capability-unavailable",
        reason: "invalid-response",
        detail: "The decisioning backend returned an answer outside Kiln's permitted routing contract.",
        fallback: "Use Kiln's deterministic next action and Pi's existing reasoning path.",
      };

    return {
      tool: "kiln_route_turn",
      ok: true,
      kind: "advisory-decision",
      backend: evaluated.backend,
      model: evaluated.model,
      stageId: stage.id,
      permittedActivities: activities,
      permittedToolFamilies: families,
      recommendation: {
        activity: answers.activity,
        toolFamily: answers.tool_family,
        needsResearch: answers.needs_research.noul,
        needsValidation: answers.needs_validation.noul,
        needsOperatorDecision: answers.needs_operator_decision.noul,
      },
      deterministicNextAction: stage.nextAction ?? null,
      usage: evaluated.usage ?? null,
      policy: advisoryPolicy,
    };
  }

  async function kiln_compare_artifacts(input) {
    if (!nonEmpty(input?.type) || !nonEmpty(input?.content))
      return invalidDecisioningInput("`type` and non-empty proposed `content` are required.");
    const candidates = input?.candidates;
    if (!Array.isArray(candidates) || candidates.length < 1 || candidates.length > MAX_CANDIDATES)
      return invalidDecisioningInput(`Between 1 and ${MAX_CANDIDATES} candidate artifacts are required.`);
    if (candidates.some((candidate) => !nonEmpty(candidate?.id) || candidate?.type !== input.type ||
        candidate.artifact === null || typeof candidate.artifact !== "object"))
      return invalidDecisioningInput("Every candidate must be a validated artifact of the proposed type.");
    if (new Set(candidates.map((candidate) => candidate.id)).size !== candidates.length)
      return invalidDecisioningInput("Candidate artifact ids must be unique.");

    const questions = Object.fromEntries(candidates.map((candidate, index) => [
      `candidate_${index}`,
      {
        type: "choice",
        instructions: {
          question:
            "What is the semantic relationship of `proposed_artifact` to the candidate in `candidate_index`? Judge meaning, not wording or structural validity.",
          candidate_index: index,
        },
        criteria: ARTIFACT_RELATIONSHIP_CRITERIA,
      },
    ]));
    const evaluated = await adapter.evaluate({
      state: {
        artifact_type: input.type,
        proposed_artifact: input.content.trim(),
        candidates: candidates.map((candidate) => ({ id: candidate.id, artifact: candidate.artifact })),
      },
      questions,
    });
    if (evaluated.ok === false) return { tool: "kiln_compare_artifacts", ...evaluated };

    const comparisons = [];
    for (let index = 0; index < candidates.length; index += 1) {
      const answer = evaluated.answers?.[`candidate_${index}`];
      if (!answerIsChoice(answer, ARTIFACT_RELATIONSHIPS))
        return {
          tool: "kiln_compare_artifacts",
          ok: false,
          kind: "capability-unavailable",
          reason: "invalid-response",
          detail: "The decisioning backend returned an artifact relationship outside Kiln's contract.",
          fallback: "Have Pi or the operator compare the artifacts through the existing reasoning path.",
        };
      comparisons.push({ candidateId: candidates[index].id, relationship: answer });
    }
    comparisons.sort((a, b) => b.relationship.confidence - a.relationship.confidence ||
      a.candidateId.localeCompare(b.candidateId));

    return {
      tool: "kiln_compare_artifacts",
      ok: true,
      kind: "advisory-decision",
      backend: evaluated.backend,
      model: evaluated.model,
      proposedType: input.type,
      comparisons,
      usage: evaluated.usage ?? null,
      policy: advisoryPolicy,
    };
  }

  async function kiln_rank_trace_targets(input) {
    if (!nonEmpty(input?.source?.id) || !nonEmpty(input?.field))
      return invalidDecisioningInput("A validated source artifact and trace `field` are required.");
    const candidates = input?.candidates;
    if (!Array.isArray(candidates) || candidates.length < 1 || candidates.length > MAX_CANDIDATES)
      return invalidDecisioningInput(`Between 1 and ${MAX_CANDIDATES} legal trace candidates are required.`);
    if (candidates.some((candidate) => !nonEmpty(candidate?.id) || !nonEmpty(candidate?.type) ||
        candidate.artifact === null || typeof candidate.artifact !== "object"))
      return invalidDecisioningInput("Every trace candidate must be a validated artifact.");

    const questions = Object.fromEntries(candidates.map((candidate, index) => [
      `candidate_${index}`,
      {
        type: "choice",
        instructions: {
          question:
            "How strongly does the source artifact semantically support the declared trace field relationship to this candidate? Judge meaning only; structural legality is already decided by Kiln.",
          trace_field: input.field,
          candidate_index: index,
        },
        criteria: TRACE_RELEVANCE_CRITERIA,
      },
    ]));
    const evaluated = await adapter.evaluate({
      state: {
        source_artifact: input.source,
        trace_field: input.field,
        structurally_legal_target_types: input.allowedTypes,
        candidates,
      },
      questions,
    });
    if (evaluated.ok === false) return { tool: "kiln_rank_trace_targets", ...evaluated };

    const recommendations = [];
    for (let index = 0; index < candidates.length; index += 1) {
      const answer = evaluated.answers?.[`candidate_${index}`];
      if (!answerIsChoice(answer, TRACE_RELEVANCE))
        return {
          tool: "kiln_rank_trace_targets",
          ok: false,
          kind: "capability-unavailable",
          reason: "invalid-response",
          detail: "The decisioning backend returned trace relevance outside Kiln's contract.",
          fallback: "Have Pi or the operator choose among the structurally legal trace targets.",
        };
      recommendations.push({ candidateId: candidates[index].id, candidateType: candidates[index].type, assessment: answer });
    }
    recommendations.sort((a, b) => b.assessment.confidence - a.assessment.confidence ||
      a.candidateId.localeCompare(b.candidateId));
    return {
      tool: "kiln_rank_trace_targets",
      ok: true,
      kind: "advisory-decision",
      backend: evaluated.backend,
      model: evaluated.model,
      sourceId: input.source.id,
      field: input.field,
      legalCandidateIds: candidates.map((candidate) => candidate.id),
      recommendations,
      usage: evaluated.usage ?? null,
      policy: advisoryPolicy,
    };
  }

  async function kiln_filter_research_results(input) {
    if (!nonEmpty(input?.question)) return invalidDecisioningInput("A research `question` is required.");
    const results = input?.results;
    if (!Array.isArray(results) || results.length < 1 || results.length > MAX_CANDIDATES)
      return invalidDecisioningInput(`Between 1 and ${MAX_CANDIDATES} retrieved research results are required.`);
    if (results.some((result) => !nonEmpty(result?.id) || !nonEmpty(result?.url) || !nonEmpty(result?.snippet)))
      return invalidDecisioningInput("Every research result requires a stable id, URL, and non-empty snippet.");

    const questions = Object.fromEntries(results.map((result, index) => [
      `result_${index}`,
      {
        type: "choice",
        instructions: {
          question:
            "How should this already-authorized research result be triaged for downstream reasoning? Compare it with the other candidates when judging duplication.",
          result_index: index,
        },
        criteria: RESEARCH_TRIAGE_CRITERIA,
      },
    ]));
    const evaluated = await adapter.evaluate({ state: { research_question: input.question.trim(), results }, questions });
    if (evaluated.ok === false) return { tool: "kiln_filter_research_results", ...evaluated };

    const assessments = [];
    for (let index = 0; index < results.length; index += 1) {
      const answer = evaluated.answers?.[`result_${index}`];
      if (!answerIsChoice(answer, RESEARCH_TRIAGE))
        return {
          tool: "kiln_filter_research_results",
          ok: false,
          kind: "capability-unavailable",
          reason: "invalid-response",
          detail: "The decisioning backend returned research triage outside Kiln's contract.",
          fallback: "Return every authorized research result to the existing reasoning path.",
        };
      assessments.push({ resultId: results[index].id, assessment: answer });
    }
    const selectedIds = assessments
      .filter(({ assessment }) => !["duplicate", "irrelevant"].includes(assessment.choice))
      .map(({ resultId }) => resultId);
    return {
      tool: "kiln_filter_research_results",
      ok: true,
      kind: "advisory-decision",
      backend: evaluated.backend,
      model: evaluated.model,
      selectedIds,
      assessments,
      originalCount: results.length,
      selectedCount: selectedIds.length,
      usage: evaluated.usage ?? null,
      policy: advisoryPolicy,
    };
  }

  return {
    kiln_decisioning_capability,
    kiln_route_turn,
    kiln_compare_artifacts,
    kiln_rank_trace_targets,
    kiln_filter_research_results,
  };
}
