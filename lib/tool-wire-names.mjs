/**
 * The wire name each typed operation is offered under — TSK-0051 (S11, D45).
 *
 * A registry entry and the tool name a model calls are two different things. `createArtifact` is
 * reached as `kiln_create_evidence`, `reviseArtifact` as `kiln_revise_artifact`, and the second is not
 * derivable from the first: `acceptance-criterion` becomes `kiln_create_acceptance_criterion` and
 * `runbook-step` becomes `kiln_create_runbook_step`, while a rule that turned one into the other would
 * also invent a name for a type nobody registered. So the pairs are written out.
 *
 * ⚠️ **THIS LIVES IN `lib/` BECAUSE `lib/` MUST NOT IMPORT THE PACKAGE.** A specialist's tool list is
 * derived from `lib/specialists/contract.mjs`, which needs these names; reaching into
 * `pi-package/extensions/kiln.js` for them would invert the dependency and make the library unusable
 * without the package.
 *
 * ⚠️ **THE PACKAGE CANNOT IMPORT THIS ONE EITHER, AND THE REASON IS MEASURED.** `kiln.js` must load
 * with nothing but `pi-package/` present — a fixture copies only that directory and asks Pi to load it —
 * so an import running at registration time would make the package unloadable on its own. Its tables
 * therefore still spell these names out, and `test/tool-wire-names.test.mjs` asserts the two statements
 * agree exactly, in both directions. That is the same trade the research and validation tool signatures
 * already make: two independent statements a test compares, rather than one statement agreeing with
 * itself.
 */

/** Artifact type to the tool that creates it. */
export const CREATE_TOOL_NAMES = Object.freeze({
  "acceptance-criterion": "kiln_create_acceptance_criterion",
  assertion: "kiln_create_assertion",
  component: "kiln_create_component",
  decision: "kiln_create_decision",
  evidence: "kiln_create_evidence",
  question: "kiln_create_question",
  requirement: "kiln_create_requirement",
  "runbook-step": "kiln_create_runbook_step",
  task: "kiln_create_task",
});

/** Registry entry to the tool that performs it. */
export const MUTATION_TOOL_NAMES = Object.freeze({
  linkEvidence: "kiln_link_evidence",
  linkTrace: "kiln_link_trace",
  resolveQuestion: "kiln_resolve_question",
  reviseArtifact: "kiln_revise_artifact",
  setLifecycle: "kiln_set_lifecycle",
  setReviewStatus: "kiln_set_review_status",
  unlinkEvidence: "kiln_unlink_evidence",
  unlinkTrace: "kiln_unlink_trace",
});

/** The tool that activates an artifact type. Project-level, so it is neither a create nor a mutation. */
export const TYPE_ACTIVATION_TOOL_NAME = "kiln_set_type_activation";

export class UnknownOperationError extends Error {
  constructor(kind, operation) {
    super(`No ${kind} tool is registered for ${JSON.stringify(operation)}.`);
    this.name = "UnknownOperationError";
    this.kind = kind;
    this.operation = operation;
  }
}

/**
 * The tool that creates this artifact type.
 *
 * ⚠️ **REFUSES RATHER THAN GUESSING.** A caller asking for a type with no tool is asking for a name
 * nothing registers, and returning a constructed one would put it into a role's allowlist, where it
 * would silently narrow the child's real tool set to nothing at intersection time.
 */
export function createToolName(type) {
  const name = CREATE_TOOL_NAMES[type];
  if (!name) throw new UnknownOperationError("create", type);
  return name;
}

/** The tool that performs this mutation entry. Refuses an unknown entry, for the reason above. */
export function mutationToolName(entry) {
  const name = MUTATION_TOOL_NAMES[entry];
  if (!name) throw new UnknownOperationError("mutation", entry);
  return name;
}
