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

/**
 * Every tool name Kiln registers, and what each one IS — TSK-0054 (F40, F41).
 *
 * ⚠️ **A NAME THE CHILD SENDS IS NOT A NAME KILN KNOWS.** `toolName` on a `tool_execution_start`
 * event is whatever the child put there. Resolving it through this table is what lets a caller be
 * told which canonical operation ran without the child's own string ever being copied anywhere.
 *
 * ⚠️ **READ-ONLY TOOLS ARE LISTED, NOT INFERRED.** A name absent from every table below is unknown,
 * and unknown fails closed. Inferring "probably a read" from a prefix would make a tool Kiln has
 * never heard of look harmless.
 */
export const READ_ONLY_TOOL_NAMES = Object.freeze([
  "kiln_capability",
  "kiln_project_status",
  "kiln_lint",
  "kiln_read_stage_attestations",
  "kiln_delegate",
  "research_capability",
  "research_search",
  "research_fetch",
  "validation_capability",
  "validation_run",
]);

/** Writes that are neither a typed creation nor a registry mutation, but are still writes. */
export const OTHER_WRITE_TOOL_NAMES = Object.freeze(["kiln_write_stage_attestation", "kiln_write_stage_document", TYPE_ACTIVATION_TOOL_NAME]);

const CREATE_BY_NAME = new Map(Object.entries(CREATE_TOOL_NAMES).map(([type, name]) => [name, type]));
const MUTATE_BY_NAME = new Map(Object.entries(MUTATION_TOOL_NAMES).map(([entry, name]) => [name, entry]));

/**
 * What a tool name IS, as one of four answers.
 *
 *  - `{ kind: "create", create }`   a typed creation, which `mayWrite` can judge
 *  - `{ kind: "mutate", mutate }`   a registry mutation, which `mayWrite` can judge
 *  - `{ kind: "write" }`            a write outside both registries; no role declares one
 *  - `{ kind: "read" }`             a read; no boundary applies
 *  - `null`                          Kiln does not know this name
 */
export function toolOperation(name) {
  if (typeof name !== "string" || name.length === 0) return null;
  const create = CREATE_BY_NAME.get(name);
  if (create !== undefined) return { kind: "create", create };
  const mutate = MUTATE_BY_NAME.get(name);
  if (mutate !== undefined) return { kind: "mutate", mutate };
  if (OTHER_WRITE_TOOL_NAMES.includes(name)) return { kind: "write" };
  if (READ_ONLY_TOOL_NAMES.includes(name)) return { kind: "read" };
  return null;
}

/** Every name Kiln knows, in any capacity. A `tool_execution_start` naming anything else is unreadable. */
export const KNOWN_TOOL_NAMES = Object.freeze([
  ...Object.values(CREATE_TOOL_NAMES),
  ...Object.values(MUTATION_TOOL_NAMES),
  ...OTHER_WRITE_TOOL_NAMES,
  ...READ_ONLY_TOOL_NAMES,
].sort());

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
