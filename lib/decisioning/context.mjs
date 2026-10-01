/** Build bounded decisioning state from Kiln's existing authoritative readers. */

import { deriveOrchestratorState } from "../orchestrator-state.mjs";
import { effectiveSchema } from "../schema-resolver.mjs";
import { loadStageDefinitions } from "../stages.mjs";
import { permittedToolFamilies } from "./policy.mjs";

export function currentRoutingContext(ctx, { toolRoot, stageDefinitions } = {}) {
  const definitions = stageDefinitions ?? loadStageDefinitions(toolRoot);
  const orchestration = deriveOrchestratorState(ctx, {
    ...(toolRoot ? { toolRoot } : {}),
    ...(stageDefinitions ? { stageDefinitions } : {}),
  });
  if (orchestration.complete) return { complete: true };

  const definition = definitions?.[orchestration.currentStage.id];
  if (!definition) throw new Error("The current stage has no authoritative definition.");
  return {
    complete: false,
    id: orchestration.currentStage.id,
    name: orchestration.currentStage.name,
    purpose: definition.purpose,
    nextActivityRule: definition.nextActivity.rule,
    permittedActivities: [...definition.nextActivity.activities],
    permittedToolFamilies: permittedToolFamilies(definition),
    blockers: orchestration.blockers,
    nextAction: orchestration.nextAction,
  };
}

/** Envelope and review metadata are not part of semantic equivalence; retain authored domain fields. */
export function semanticArtifactView(artifact) {
  if (artifact === null || typeof artifact !== "object" || Array.isArray(artifact)) return artifact;
  const omitted = new Set([
    "schemaVersion",
    "reviewStatus",
    "lifecycle",
    "createdAt",
    "updatedAt",
  ]);
  return Object.fromEntries(
    Object.entries(artifact)
      .filter(([key]) => !omitted.has(key))
      .map(([key, value]) => [key, value])
  );
}

export function readComparisonCandidates({ type, candidateIds }, ctx, reader, options = {}) {
  if (!Array.isArray(candidateIds)) throw new TypeError("candidateIds must be an array");
  return candidateIds.map((id) => {
    const record = reader.readArtifact({ id }, ctx, options);
    if (record.type !== type)
      throw new TypeError(`${id} is a ${record.type}, not the proposed ${type} type.`);
    return { id, type, artifact: semanticArtifactView(record.artifact) };
  });
}

/** Read only candidates the source trace field can legally target; no semantic result can widen this set. */
export function readTraceCandidates({ sourceId, field, candidateIds }, ctx, reader, options = {}) {
  if (!Array.isArray(candidateIds) || candidateIds.length === 0)
    throw new TypeError("candidateIds must be a non-empty array");
  if (new Set(candidateIds).size !== candidateIds.length)
    throw new TypeError("candidateIds must be unique");
  const source = reader.readArtifact({ id: sourceId }, ctx, options);
  const property = effectiveSchema(ctx.schemas, source.type).properties?.[field];
  const allowedTypes = property?.["x-traceTarget"];
  if (!Array.isArray(allowedTypes) || allowedTypes.length === 0)
    throw new TypeError(`${source.type}.${field} is not a declared trace field.`);
  const candidates = candidateIds.map((id) => {
    const candidate = reader.readArtifact({ id }, ctx, options);
    if (!allowedTypes.includes(candidate.type))
      throw new TypeError(`${id} is not a legal target for ${source.type}.${field}.`);
    return { id, type: candidate.type, artifact: semanticArtifactView(candidate.artifact) };
  });
  return {
    source: { id: sourceId, type: source.type, artifact: semanticArtifactView(source.artifact) },
    field,
    allowedTypes: [...allowedTypes],
    candidates,
  };
}

export function readEvidenceRelationship({ assertionId, evidenceId }, ctx, reader, options = {}) {
  const assertion = reader.readArtifact({ id: assertionId }, ctx, options);
  const evidence = reader.readArtifact({ id: evidenceId }, ctx, options);
  if (assertion.type !== "assertion" || evidence.type !== "evidence")
    throw new TypeError("Evidence verification requires an assertion id and an evidence id.");
  const supports = (assertion.artifact.supportedBy ?? []).includes(evidenceId);
  const refutes = (assertion.artifact.refutedBy ?? []).includes(evidenceId);
  if (supports === refutes)
    throw new TypeError(supports
      ? "The evidence is recorded as both supporting and refuting the assertion."
      : "The evidence is not canonically linked to the assertion.");
  return {
    assertion: { id: assertionId, artifact: semanticArtifactView(assertion.artifact) },
    evidence: { id: evidenceId, artifact: semanticArtifactView(evidence.artifact) },
    recordedRelationship: supports ? "support" : "refute",
  };
}

export function readSemanticReviewArtifacts({ artifactIds }, ctx, reader, options = {}) {
  if (!Array.isArray(artifactIds) || artifactIds.length === 0)
    throw new TypeError("artifactIds must be a non-empty array");
  if (new Set(artifactIds).size !== artifactIds.length)
    throw new TypeError("artifactIds must be unique");
  return artifactIds.map((id) => {
    const record = reader.readArtifact({ id }, ctx, options);
    return { id, type: record.type, artifact: semanticArtifactView(record.artifact) };
  });
}

export function currentProposalContext({ operation, targetIds = [], contextIds = [] }, ctx, reader, { toolRoot } = {}) {
  if (typeof operation !== "string") throw new TypeError("operation is required");
  const routing = currentRoutingContext(ctx, { toolRoot });
  if (routing.complete) throw new TypeError("No mutation is permitted after every stage is complete.");
  const definitions = loadStageDefinitions(toolRoot);
  const definition = definitions[routing.id];
  const [kind, name, extra] = operation.split(":");
  if (extra !== undefined || !name) throw new TypeError("operation must be create:<type> or mutate:<operation>.");
  const permitted = kind === "create"
    ? (definition.produces ?? []).includes(name)
    : kind === "mutate" && (definition.mutationBoundary?.mayMutate ?? []).includes(name);
  if (!permitted) throw new TypeError(`${operation} is not permitted by stage ${routing.id}.`);
  const ids = [...new Set([...targetIds, ...contextIds])];
  const artifacts = ids.length ? readSemanticReviewArtifacts({ artifactIds: ids }, ctx, reader) : [];
  const byId = new Map(artifacts.map((artifact) => [artifact.id, artifact]));
  return {
    operation,
    stage: { id: routing.id, name: routing.name, purpose: routing.purpose },
    targetArtifacts: targetIds.map((id) => byId.get(id)),
    contextArtifacts: contextIds.map((id) => byId.get(id)),
  };
}
