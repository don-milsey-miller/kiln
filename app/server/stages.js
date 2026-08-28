import "server-only";

/**
 * Read-only access to stage definitions, their recorded attestations, and gate evaluation.
 *
 * ⚠️ `loadStageAttestations` is re-exported and `writeStageAttestation` is NOT, and they live in the
 * same module. `export * from "../../lib/attestations.mjs"` would have exposed a capability that
 * takes the content lock, silently and by default. That is the concrete reason DEC-0021 forbids the
 * wildcard rather than merely discouraging it.
 *
 * ⚠️ `evaluateHandoffGate` is also absent: the first slice shows stage state, and publication
 * readiness is not something a view needs to compute.
 */
export { loadStageDefinitions } from "../../lib/stages.mjs";
export { loadStageAttestations } from "../../lib/attestations.mjs";
export { evaluateStageGate } from "../../lib/lint.mjs";
