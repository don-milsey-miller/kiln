/** Vendor-neutral, task-specific decisioning operations. */

import { invalidDecisioningInput } from "./refusal.mjs";
import {
  ARTIFACT_RELATIONSHIP_CRITERIA,
  ARTIFACT_RELATIONSHIPS,
  TRACE_RELEVANCE,
  TRACE_RELEVANCE_CRITERIA,
  RESEARCH_TRIAGE,
  RESEARCH_TRIAGE_CRITERIA,
  EVIDENCE_RELATIONSHIPS,
  EVIDENCE_RELATIONSHIP_CRITERIA,
  PLANNING_CONCERNS,
  PLANNING_CONCERN_CRITERIA,
  PROPOSAL_CONCERNS,
  PROPOSAL_CONCERN_CRITERIA,
  SPECIALIST_RESULT_ASSESSMENTS,
  SPECIALIST_RESULT_ASSESSMENT_CRITERIA,
  INTAKE_UNCERTAINTIES,
  INTAKE_UNCERTAINTY_CRITERIA,
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
  kiln_prioritize_intake_uncertainty: {
    description:
      "Select the highest-impact unresolved intake uncertainty from Kiln's finite categories. Advisory only; Pi writes the question and no stage gate changes.",
    input: {
      type: "object",
      properties: { context: { type: "string", minLength: 1, maxLength: 12000 } },
      required: ["context"],
      additionalProperties: false,
    },
  },
  kiln_route_specialist: {
    description:
      "Recommend a specialist role from the roles the current stage already permits. Advisory only; this never authorizes or starts delegation.",
    input: {
      type: "object",
      properties: { task: { type: "string", minLength: 1, maxLength: 32000 } },
      required: ["task"],
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
  kiln_verify_evidence_relationship: {
    description:
      "Assess whether canonically linked evidence supports, contradicts, or says nothing about an assertion. Advisory only; recorded evidence links remain authoritative.",
    input: {
      type: "object",
      properties: {
        assertionId: { type: "string", pattern: "^AST-[0-9]{4,}$" },
        evidenceId: { type: "string", pattern: "^EVD-[0-9]{4,}$" },
      },
      required: ["assertionId", "evidenceId"],
      additionalProperties: false,
    },
  },
  kiln_semantic_review: {
    description:
      "Review validated planning artifacts for bounded semantic-quality concerns. Separate from deterministic lint, advisory only, and never gate-capable.",
    input: {
      type: "object",
      properties: {
        artifactIds: {
          type: "array",
          minItems: 1,
          maxItems: MAX_CANDIDATES,
          uniqueItems: true,
          items: { type: "string", pattern: "^[A-Z]+-[0-9]{4,}$" },
        },
      },
      required: ["artifactIds"],
      additionalProperties: false,
    },
  },
  kiln_review_proposal: {
    description:
      "Review a stage-permitted material change before it is presented for operator approval. Advisory only; this cannot mutate state or record approval.",
    input: {
      type: "object",
      properties: {
        operation: { type: "string", pattern: "^(create|mutate):[a-z][a-zA-Z0-9-]*$" },
        proposal: { type: "string", minLength: 1, maxLength: 24000 },
        targetIds: { type: "array", maxItems: MAX_CANDIDATES, uniqueItems: true, items: { type: "string", pattern: "^[A-Z]+-[0-9]{4,}$" } },
        contextIds: { type: "array", maxItems: MAX_CANDIDATES, uniqueItems: true, items: { type: "string", pattern: "^[A-Z]+-[0-9]{4,}$" } },
      },
      required: ["operation", "proposal"],
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

  async function kiln_prioritize_intake_uncertainty(input) {
    if (!nonEmpty(input?.context) || input?.stage?.id !== "01-intake")
      return invalidDecisioningInput("Non-empty intake context and the authoritative 01-intake stage are required.");
    const evaluated = await adapter.evaluate({
      state: {
        intake_context: input.context.trim(),
        current_stage: {
          id: input.stage.id,
          purpose: input.stage.purpose ?? null,
          blockers: Array.isArray(input.stage.blockers) ? input.stage.blockers : [],
          recommended_next_action: input.stage.nextAction ?? null,
        },
      },
      questions: {
        highest_impact_uncertainty: {
          type: "choice",
          instructions:
            "Which Kiln-defined uncertainty category is the highest-impact unresolved area to clarify next? Select only a category; do not write or answer the operator question.",
          criteria: INTAKE_UNCERTAINTY_CRITERIA,
        },
      },
    });
    if (evaluated.ok === false) return { tool: "kiln_prioritize_intake_uncertainty", ...evaluated };
    const assessment = evaluated.answers?.highest_impact_uncertainty;
    if (!answerIsChoice(assessment, INTAKE_UNCERTAINTIES))
      return {
        tool: "kiln_prioritize_intake_uncertainty",
        ok: false,
        kind: "capability-unavailable",
        reason: "invalid-response",
        detail: "The decisioning backend returned an uncertainty category outside Kiln's contract.",
        fallback: "Have Pi identify the next intake uncertainty through its existing reasoning path.",
      };
    return {
      tool: "kiln_prioritize_intake_uncertainty",
      ok: true,
      kind: "advisory-intake-priority",
      backend: evaluated.backend,
      model: evaluated.model,
      stageId: input.stage.id,
      categories: INTAKE_UNCERTAINTIES,
      recommendation: assessment,
      questionText: null,
      stageGateEffect: "none",
      fallback: "Pi may use its existing reasoning path when this confidence is insufficient for the current context.",
      usage: evaluated.usage ?? null,
      policy: advisoryPolicy,
    };
  }

  async function kiln_route_specialist(input) {
    if (!nonEmpty(input?.task)) return invalidDecisioningInput("A non-empty specialist `task` is required.");
    const roles = input?.permittedRoles;
    if (!Array.isArray(roles) || roles.length < 2 || !roles.every(nonEmpty) || new Set(roles).size !== roles.length)
      return invalidDecisioningInput("At least two unique, stage-permitted specialist roles are required.");
    const criteria = input?.roleCriteria;
    if (criteria === null || typeof criteria !== "object" || roles.some((role) => !nonEmpty(criteria[role])))
      return invalidDecisioningInput("Every permitted specialist role requires a Kiln-derived criterion.");
    const evaluated = await adapter.evaluate({
      state: {
        specialist_task: input.task.trim(),
        current_stage: input.stage,
        permitted_specialist_roles: roles,
      },
      questions: {
        specialist_role: {
          type: "choice",
          instructions:
            "Which already-permitted specialist role best fits this bounded task? Choose only from the supplied roles. This recommendation does not authorize or start delegation.",
          criteria: Object.fromEntries(roles.map((role) => [role, criteria[role]])),
        },
      },
    });
    if (evaluated.ok === false) return { tool: "kiln_route_specialist", ...evaluated };
    const recommendation = evaluated.answers?.specialist_role;
    if (!answerIsChoice(recommendation, roles))
      return {
        tool: "kiln_route_specialist",
        ok: false,
        kind: "capability-unavailable",
        reason: "invalid-response",
        detail: "The decisioning backend returned a specialist role outside Kiln's permitted set.",
        fallback: "Use the existing Pi routing path over the stage-permitted specialist roles.",
      };
    return {
      tool: "kiln_route_specialist",
      ok: true,
      kind: "advisory-specialist-route",
      backend: evaluated.backend,
      model: evaluated.model,
      stageId: input.stage?.id ?? null,
      permittedRoles: roles,
      recommendation,
      delegationAuthorized: false,
      fallback: "Pi may use its existing routing path when this confidence is insufficient for the current task.",
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

  async function kiln_verify_evidence_relationship(input) {
    if (!nonEmpty(input?.assertion?.id) || !nonEmpty(input?.evidence?.id) ||
        !["support", "refute"].includes(input?.recordedRelationship))
      return invalidDecisioningInput("A validated, canonically linked assertion/evidence pair is required.");
    const evaluated = await adapter.evaluate({
      state: {
        assertion: input.assertion,
        evidence: input.evidence,
        recorded_relationship: input.recordedRelationship,
      },
      questions: {
        semantic_relationship: {
          type: "choice",
          instructions:
            "Based only on the supplied content, does this evidence support the assertion, contradict it, or say nothing material about it? Do not change the recorded relationship.",
          criteria: EVIDENCE_RELATIONSHIP_CRITERIA,
        },
      },
    });
    if (evaluated.ok === false) return { tool: "kiln_verify_evidence_relationship", ...evaluated };
    const assessment = evaluated.answers?.semantic_relationship;
    if (!answerIsChoice(assessment, EVIDENCE_RELATIONSHIPS))
      return {
        tool: "kiln_verify_evidence_relationship",
        ok: false,
        kind: "capability-unavailable",
        reason: "invalid-response",
        detail: "The decisioning backend returned an evidence relationship outside Kiln's contract.",
        fallback: "Review the recorded evidence relationship through the existing Pi/operator path.",
      };
    const expected = input.recordedRelationship === "support" ? "supports" : "contradicts";
    const matchesRecorded = assessment.choice === expected;
    return {
      tool: "kiln_verify_evidence_relationship",
      ok: true,
      kind: "advisory-decision",
      backend: evaluated.backend,
      model: evaluated.model,
      assertionId: input.assertion.id,
      evidenceId: input.evidence.id,
      recordedRelationship: input.recordedRelationship,
      assessment,
      matchesRecorded,
      reviewRecommended: !matchesRecorded,
      usage: evaluated.usage ?? null,
      policy: advisoryPolicy,
    };
  }

  async function kiln_semantic_review(input) {
    const artifacts = input?.artifacts;
    if (!Array.isArray(artifacts) || artifacts.length < 1 || artifacts.length > MAX_CANDIDATES)
      return invalidDecisioningInput(`Between 1 and ${MAX_CANDIDATES} validated artifacts are required.`);
    if (artifacts.some((entry) => !nonEmpty(entry?.id) || !nonEmpty(entry?.type) ||
        entry.artifact === null || typeof entry.artifact !== "object"))
      return invalidDecisioningInput("Every semantic-review artifact must be validated and typed.");
    const questions = Object.fromEntries(artifacts.map((artifact, index) => [
      `artifact_${index}`,
      {
        type: "choice",
        instructions: {
          question:
            "What is the single most material semantic-quality concern in this validated planning artifact? Choose clear when none is material. Structural validity and gate status are outside this review.",
          artifact_index: index,
          artifact_type: artifact.type,
        },
        criteria: PLANNING_CONCERN_CRITERIA,
      },
    ]));
    const evaluated = await adapter.evaluate({ state: { artifacts }, questions });
    if (evaluated.ok === false) return { tool: "kiln_semantic_review", ...evaluated };
    const assessments = [];
    for (let index = 0; index < artifacts.length; index += 1) {
      const answer = evaluated.answers?.[`artifact_${index}`];
      if (!answerIsChoice(answer, PLANNING_CONCERNS))
        return {
          tool: "kiln_semantic_review",
          ok: false,
          kind: "capability-unavailable",
          reason: "invalid-response",
          detail: "The decisioning backend returned a semantic concern outside Kiln's contract.",
          fallback: "Use deterministic lint and the existing Pi/operator review path.",
        };
      assessments.push({ artifactId: artifacts[index].id, artifactType: artifacts[index].type, assessment: answer });
    }
    return {
      tool: "kiln_semantic_review",
      ok: true,
      kind: "advisory-semantic-review",
      backend: evaluated.backend,
      model: evaluated.model,
      assessments,
      findings: assessments.filter((entry) => entry.assessment.choice !== "clear"),
      gateEffect: "none",
      usage: evaluated.usage ?? null,
      policy: advisoryPolicy,
    };
  }

  async function kiln_review_proposal(input) {
    if (!nonEmpty(input?.proposal) || !nonEmpty(input?.operation) || !nonEmpty(input?.stage?.id))
      return invalidDecisioningInput("A deterministically permitted operation, proposal, and current stage are required.");
    const evaluated = await adapter.evaluate({
      state: {
        operation: input.operation,
        proposal: input.proposal.trim(),
        current_stage: input.stage,
        target_artifacts: input.targetArtifacts ?? [],
        project_context: input.contextArtifacts ?? [],
      },
      questions: {
        proposal_concern: {
          type: "choice",
          instructions:
            "What is the single most material semantic concern to surface before the operator reviews this deterministically permitted proposal? Choose clear when none is material. Never approve or execute the proposal.",
          criteria: PROPOSAL_CONCERN_CRITERIA,
        },
      },
    });
    if (evaluated.ok === false) return { tool: "kiln_review_proposal", ...evaluated };
    const assessment = evaluated.answers?.proposal_concern;
    if (!answerIsChoice(assessment, PROPOSAL_CONCERNS))
      return {
        tool: "kiln_review_proposal",
        ok: false,
        kind: "capability-unavailable",
        reason: "invalid-response",
        detail: "The decisioning backend returned a proposal concern outside Kiln's contract.",
        fallback: "Present the proposal through the existing operator-approval path.",
      };
    return {
      tool: "kiln_review_proposal",
      ok: true,
      kind: "advisory-proposal-review",
      backend: evaluated.backend,
      model: evaluated.model,
      operation: input.operation,
      stageId: input.stage.id,
      assessment,
      concerns: assessment.choice === "clear" ? [] : [assessment],
      mayMutate: false,
      approvalRecorded: false,
      usage: evaluated.usage ?? null,
      policy: advisoryPolicy,
    };
  }

  /**
   * Review only a mechanically accepted specialist result. This operation is intentionally not a
   * model-facing tool: the delegation wrapper supplies the actual task, output and observations so a
   * caller cannot substitute friendlier evidence for the run that just completed.
   */
  async function kiln_verify_specialist_result(input) {
    if (!nonEmpty(input?.task) || !nonEmpty(input?.role) || !nonEmpty(input?.output) ||
        input?.observation === null || typeof input?.observation !== "object")
      return invalidDecisioningInput("A delegated task, specialist role, output, and observed run facts are required.");
    const evaluated = await adapter.evaluate({
      state: {
        delegated_task: input.task.trim(),
        specialist_role: input.role,
        specialist_output: input.output.trim(),
        observed_run_facts: input.observation,
      },
      questions: {
        specialist_result: {
          type: "choice",
          instructions:
            "Assess the specialist output against the delegated task and observed run facts. Mechanical acceptance is already settled; identify the single most material semantic concern, if any.",
          criteria: SPECIALIST_RESULT_ASSESSMENT_CRITERIA,
        },
      },
    });
    if (evaluated.ok === false) return { tool: "kiln_verify_specialist_result", ...evaluated };
    const assessment = evaluated.answers?.specialist_result;
    if (!answerIsChoice(assessment, SPECIALIST_RESULT_ASSESSMENTS))
      return {
        tool: "kiln_verify_specialist_result",
        ok: false,
        kind: "capability-unavailable",
        reason: "invalid-response",
        detail: "The decisioning backend returned a specialist-result assessment outside Kiln's contract.",
        fallback: "Use the mechanically accepted specialist result through the existing Pi review path.",
      };
    return {
      tool: "kiln_verify_specialist_result",
      ok: true,
      kind: "advisory-specialist-verification",
      backend: evaluated.backend,
      model: evaluated.model,
      role: input.role,
      assessment,
      reviewRecommended: assessment.choice !== "aligned",
      mechanicalAcceptancePreserved: true,
      usage: evaluated.usage ?? null,
      policy: advisoryPolicy,
    };
  }

  return {
    kiln_decisioning_capability,
    kiln_route_turn,
    kiln_prioritize_intake_uncertainty,
    kiln_route_specialist,
    kiln_compare_artifacts,
    kiln_rank_trace_targets,
    kiln_filter_research_results,
    kiln_verify_evidence_relationship,
    kiln_semantic_review,
    kiln_review_proposal,
    kiln_verify_specialist_result,
  };
}
