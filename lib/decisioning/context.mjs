/** Build bounded decisioning state from Kiln's existing authoritative readers. */

import { deriveOrchestratorState } from "../orchestrator-state.mjs";
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
