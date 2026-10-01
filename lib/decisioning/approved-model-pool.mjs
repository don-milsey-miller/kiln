/**
 * Guarded prototype for issue #71. Nothing here changes the active single-model launch path.
 * A future integration may call `recommendApprovedModel` only after its persisted pool, host grants,
 * and per-entry compatibility records implement the representation documented alongside this file.
 */

import { advisoryPolicy } from "./policy.mjs";
import { invalidDecisioningInput } from "./refusal.mjs";

export const MODEL_POOL_VERSION = 1;
export const MODEL_TASK_CLASSES = Object.freeze(["planning", "research", "validation", "delegation"]);

const nonEmpty = (value) => typeof value === "string" && value.trim().length > 0;
const plain = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const canonical = (value) => {
  if (Array.isArray(value)) return value.map(canonical);
  if (plain(value)) return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
};
const same = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
const exactKeys = (value, keys) => plain(value) && Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");

function validEntry(entry) {
  return exactKeys(entry, ["id", "provider", "model", "thinkingLevel", "taskClasses", "capabilities"]) &&
    /^[a-z][a-z0-9-]{0,63}$/.test(entry.id ?? "") && nonEmpty(entry.provider) && nonEmpty(entry.model) &&
    nonEmpty(entry.thinkingLevel) && Array.isArray(entry.taskClasses) && entry.taskClasses.length > 0 &&
    entry.taskClasses.every((value) => MODEL_TASK_CLASSES.includes(value)) &&
    new Set(entry.taskClasses).size === entry.taskClasses.length && Array.isArray(entry.capabilities) &&
    entry.capabilities.every((value) => /^[a-z][a-z0-9-]{0,63}$/.test(value)) &&
    new Set(entry.capabilities).size === entry.capabilities.length;
}

/** Validate the proposed committed, non-secret representation. Credentials and consent cannot fit. */
export function validateApprovedModelPool(pool) {
  if (!exactKeys(pool, ["recordVersion", "entries"]) || pool.recordVersion !== MODEL_POOL_VERSION ||
      !Array.isArray(pool.entries) || pool.entries.length === 0 || !pool.entries.every(validEntry) ||
      new Set(pool.entries.map((entry) => entry.id)).size !== pool.entries.length)
    throw new TypeError("The approved model pool must contain unique, closed, version-1 non-secret entries.");
  return pool;
}

const identity = (entry) => ({
  provider: entry.provider,
  model: entry.model,
  thinkingLevel: entry.thinkingLevel,
});

/**
 * Deterministically narrow a pool before Jev sees it. Every survivor has:
 *  - an individual positive host-local approval for the exact pool identity and credential route;
 *  - a passed host-local proof whose complete key equals the key recomputed for this launch; and
 *  - every task class and capability required by the caller's already-authorized operation.
 */
export function deriveApprovedModelCandidates({
  pool,
  approvals,
  compatibility,
  taskClass,
  requiredCapabilities = [],
}) {
  validateApprovedModelPool(pool);
  if (!MODEL_TASK_CLASSES.includes(taskClass)) throw new TypeError("The task class is not Kiln-defined.");
  if (!Array.isArray(requiredCapabilities) || !requiredCapabilities.every(nonEmpty) ||
      new Set(requiredCapabilities).size !== requiredCapabilities.length)
    throw new TypeError("Required capabilities must be unique non-empty identifiers.");
  if (!Array.isArray(approvals) || !Array.isArray(compatibility))
    throw new TypeError("Host-local approvals and compatibility proofs are required.");

  const approvalById = new Map(approvals.map((approval) => [approval?.poolEntryId, approval]));
  const proofById = new Map(compatibility.map((proof) => [proof?.poolEntryId, proof]));
  return pool.entries.filter((entry) => {
    if (!entry.taskClasses.includes(taskClass) || requiredCapabilities.some((capability) => !entry.capabilities.includes(capability)))
      return false;
    const approval = approvalById.get(entry.id);
    if (!approval?.granted || !same(approval.identity, identity(entry)) || !nonEmpty(approval.credentialRoute)) return false;
    const proof = proofById.get(entry.id);
    return proof?.result?.outcome === "passed" && plain(proof.key) && plain(proof.expectedKey) &&
      same(proof.key, proof.expectedKey) && same(
        { provider: proof.key.provider, model: proof.key.model, thinkingLevel: proof.key.thinkingLevel },
        identity(entry)
      );
  }).map((entry) => ({ ...entry, taskClasses: [...entry.taskClasses], capabilities: [...entry.capabilities] }));
}

const answerIsChoice = (answer, allowed) => answer?.type === "choice" && allowed.includes(answer.choice) &&
  Number.isFinite(answer.confidence) && plain(answer.probabilities);

/** Advisory prototype. It cannot launch a model or create consent, billing authority, or compatibility. */
export async function recommendApprovedModel(input, adapter) {
  if (!adapter?.evaluate) throw new TypeError("A decisioning adapter with evaluate() is required.");
  if (!nonEmpty(input?.task)) return invalidDecisioningInput("A non-empty bounded `task` is required.");
  let candidates;
  try {
    candidates = deriveApprovedModelCandidates(input);
  } catch (error) {
    return invalidDecisioningInput(error.message);
  }
  if (candidates.length === 0)
    return {
      tool: "kiln_route_approved_model",
      ok: false,
      kind: "capability-unavailable",
      reason: "no-approved-compatible-model",
      detail: "No individually approved, currently compatible model satisfies the deterministic task constraints.",
      fallback: "Use Kiln's existing single-model selection without substitution.",
    };
  if (candidates.length === 1)
    return {
      tool: "kiln_route_approved_model",
      ok: true,
      kind: "deterministic-model-route",
      candidateIds: [candidates[0].id],
      recommendation: { choice: candidates[0].id, reason: "only-approved-compatible-candidate" },
      executionAuthorized: false,
      billingAuthorizationCreated: false,
      policy: advisoryPolicy,
    };

  const ids = candidates.map((candidate) => candidate.id);
  const evaluated = await adapter.evaluate({
    state: {
      bounded_task: input.task.trim(),
      task_class: input.taskClass,
      required_capabilities: input.requiredCapabilities,
      approved_compatible_models: candidates,
    },
    questions: {
      model_pool_entry: {
        type: "choice",
        instructions:
          "Which already-approved, compatibility-proven pool entry best fits this bounded task? Choose only an entry id. This cannot authorize execution or billing.",
        criteria: Object.fromEntries(candidates.map((candidate) => [
          candidate.id,
          `${candidate.provider} ${candidate.model} at ${candidate.thinkingLevel}; capabilities: ${candidate.capabilities.join(", ") || "none"}.`,
        ])),
      },
    },
  });
  if (evaluated.ok === false) return { tool: "kiln_route_approved_model", ...evaluated };
  const recommendation = evaluated.answers?.model_pool_entry;
  if (!answerIsChoice(recommendation, ids))
    return {
      tool: "kiln_route_approved_model",
      ok: false,
      kind: "capability-unavailable",
      reason: "invalid-response",
      detail: "The decisioning backend returned a model outside the approved compatible candidate set.",
      fallback: "Use Kiln's existing single-model selection without substitution.",
    };
  return {
    tool: "kiln_route_approved_model",
    ok: true,
    kind: "advisory-model-route",
    backend: evaluated.backend,
    model: evaluated.model,
    candidateIds: ids,
    recommendation,
    executionAuthorized: false,
    billingAuthorizationCreated: false,
    usage: evaluated.usage ?? null,
    policy: advisoryPolicy,
  };
}
