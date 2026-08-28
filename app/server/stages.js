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
 *
 * ⚠️ `readStageDocs` comes from the PUBLISHER (`lib/handoff/publish.mjs`) rather than from a second
 * reader written for the application. It is the module that already owns what a stage document is:
 * it covers `.md` and `.mdx`, ignores dotfiles, and REFUSES anything else rather than skipping it.
 * One implementation, several callers (#47) — and the alternative was a private read in the app that
 * would quietly disagree with the package about which files count.
 */
export { loadStageDefinitions } from "../../lib/stages.mjs";
export { loadStageAttestations } from "../../lib/attestations.mjs";
export { evaluateStageGate } from "../../lib/lint.mjs";
export { readStageDocs } from "../../lib/handoff/publish.mjs";
