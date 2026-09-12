/**
 * Kiln's registration entry point — TSK-0043 and TSK-0044, CMP-0031 and CMP-0032, against ACC-0063,
 * ACC-0064 and ACC-0065.
 *
 * Pi loads this file when the project is trusted and the package is registered in the project's
 * settings. Loading it is the observable: an untrusted project never reaches this line.
 *
 * ⚠️ **REGISTRATION BUILDS SCHEMAS AND HANDLERS; IT DOES NOT TOUCH THE PROJECT.** Importing and
 * registering may load code and this package's declaration. It must not resolve or read planning
 * content, inspect credentials, write files, spawn processes, or contact a network. Project access
 * begins only when an invoked handler resolves the content root through the shared resolver.
 *
 * ⚠️ **AND `lib/` IS IMPORTED WHEN A HANDLER RUNS, NOT WHEN THE PACKAGE LOADS.** Two reasons, both
 * real: loading must not depend on anything outside this package — the package is loadable on its own
 * and a fixture that copies only `pi-package/` proves it — and an import that ran at load time would
 * be work done for a session that may never call these tools.
 *
 * ⚠️ **THE WRAPPER ADDS A SCHEMA AND A RENDERING, AND NOTHING ELSE.** Every rule these tools apply
 * lives in `lib/`: the lint's findings, the handoff gate's blockers, the content root's resolution.
 * A wrapper that re-derived any of them would be a second answer to a question that already has one.
 *
 * ⚠️ **THE DECLARATION AND THE REGISTRATION MUST AGREE.** `signature.json` names exactly the tools
 * registered below, and `validatePackage` refuses a package where they differ in either direction.
 * A name is added there in the same change that adds its working handler — never before.
 */

import declaration from "../signature.json" with { type: "json" };

/**
 * The signature version this entry point was written against.
 *
 * ⚠️ Authored by hand rather than read from the declaration. Reading it from there would make the
 * two agree by construction and prove nothing.
 */
export const SIGNATURE_VERSION = 1;

/** Deeply frozen, so a consumer cannot edit the declaration it was handed and hand it on. */
const deepFreeze = (value) => {
  if (Array.isArray(value)) return Object.freeze(value.map(deepFreeze));
  if (value !== null && typeof value === "object")
    return Object.freeze(Object.fromEntries(Object.entries(value).map(([k, v]) => [k, deepFreeze(v)])));
  return value;
};

/** What this package declares it owns: the names, and nothing about what they do. */
export const SIGNATURE = deepFreeze(declaration);

/**
 * The project this run is about, resolved when a handler runs.
 *
 * ⚠️ **THE SHARED RESOLVER, NEVER A SECOND RULE.** `resolveContentRoot` refuses to guess and is the
 * one place that decides which project is open; a tool that derived its own would read one project
 * while the operator believed it read another.
 */
async function projectContext() {
  const [{ resolveContentRoot, toolRoot }, { loadSchemaSet }, { createValidators }, { readActivatedTypes }, { join }] =
    await Promise.all([
      import("../../lib/content-root.mjs"),
      import("../../lib/schema-resolver.mjs"),
      import("../../lib/validate.mjs"),
      import("../../lib/activation.mjs"),
      import("node:path"),
    ]);

  const contentRoot = resolveContentRoot();
  const tool = toolRoot();
  const schemasDir = join(tool, "schemas");
  const schemas = loadSchemaSet(schemasDir);
  const validators = createValidators(schemasDir);
  return {
    ctx: { contentRoot, schemas, validators, activated: readActivatedTypes(contentRoot) },
    contentRoot,
    toolRoot: tool,
    // What the typed tools take: the same schemas and validators, not a second set.
    options: { contentRoot, schemasDir, schemas, validators },
  };
}

/**
 * A path as the operator's project knows it.
 *
 * ⚠️ **RELATIVE, ALWAYS.** A result carrying `C:\Users\someone\...` names the machine it ran on, and
 * these results are read by a model, written into transcripts and quoted back. Anything that will not
 * reduce to a path inside the content root is dropped rather than passed on.
 */
const relativeTo = (root, path) => {
  if (typeof path !== "string" || path.length === 0) return null;
  const normalised = path.split("\\").join("/");
  const base = root.split("\\").join("/").replace(/\/+$/, "");

  // Absolute, and inside the project: reduce it.
  if (normalised.startsWith(`${base}/`)) return normalised.slice(base.length + 1);

  // ⚠️ ALREADY RELATIVE, WHICH IS WHAT THE LINT PRODUCES. An earlier version required every path to
  // be absolute and turned all of them into `null` — dropping the one field the result exists to
  // carry, silently, because the fixture it was tested against had no findings.
  if (!/^([A-Za-z]:)?\//.test(normalised) && !normalised.split("/").includes("..")) return normalised;

  // Absolute and outside the project, or climbing out of it: not this result's to carry.
  return null;
};

/**
 * Text with this machine taken out of it.
 *
 * ⚠️ **A MESSAGE CAN CARRY A PATH TOO.** Sanitising only the `path` field would leave
 * `C:\Users\someone\...` sitting inside a finding's prose, which is the same disclosure by another
 * route. What belongs to the project is reduced to its relative form; anything else that looks like
 * an absolute path is replaced rather than passed on.
 */
const scrub = (text, root) => {
  if (typeof text !== "string" || text.length === 0) return text ?? null;
  const base = root.split("\\").join("/").replace(/\/+$/, "");
  let out = text.split("\\").join("/");
  if (base.length > 0) out = out.split(`${base}/`).join("").split(base).join(".");
  return out.replace(/(?:[A-Za-z]:)?\/(?:[\w.@~ -]+\/)+[\w.@~ -]*/g, "<path>");
};

/** A refusal a model can act on, with no exception text and no machine path in it. */
const refusal = (code, message) => ({ ok: false, code, message });

/**
 * The creation tools, as an explicit table.
 *
 * ⚠️ **WRITTEN OUT, NEVER DERIVED FROM THE NAME.** `kiln_create_acceptance_criterion` maps to
 * `acceptance-criterion` and `kiln_create_runbook_step` to `runbook-step`: a rule that turned one
 * into the other would also turn a future `kiln_create_api_spec` into `api-spec`, quietly, for a type
 * nobody registered. A wrong row here is a wrong tool, and a wrong row is visible.
 */
const CREATION_TOOLS = Object.freeze([
  { name: "kiln_create_requirement", type: "requirement", noun: "requirement" },
  { name: "kiln_create_assertion", type: "assertion", noun: "assertion" },
  { name: "kiln_create_evidence", type: "evidence", noun: "evidence record" },
  { name: "kiln_create_runbook_step", type: "runbook-step", noun: "runbook step" },
  { name: "kiln_create_question", type: "question", noun: "open question" },
  { name: "kiln_create_decision", type: "decision", noun: "decision" },
  { name: "kiln_create_component", type: "component", noun: "component" },
  { name: "kiln_create_acceptance_criterion", type: "acceptance-criterion", noun: "acceptance criterion" },
  { name: "kiln_create_task", type: "task", noun: "task" },
]);


/**
 * The mutation tools, as an explicit table.
 *
 * ⚠️ **EACH ROW NAMES ITS REGISTRY ENTRY, AND SAYS HOW THAT ENTRY IS CALLED.** The eight operations do
 * not share a signature — linking evidence takes a polarity, revising takes a change set, resolving a
 * question takes what settled it — so the adapter cannot guess. A row is a wire name, the entry it
 * delegates to, the parameters a model may send, and the one line that turns the second into the third.
 *
 * ⚠️ **`reviseArtifact` IS NOT A ROUTE TO TRACE FIELDS, AND THAT IS THE REGISTRY'S RULE, NOT THIS
 * TABLE'S.** `linkTrace`, `unlinkTrace`, `linkEvidence` and `resolveQuestion` exist because a
 * judgement about what points at what needs its own operation; the reviser refuses those fields
 * itself, and the wrapper simply does not paper over the refusal.
 */
const MUTATION_TOOL_TABLE = Object.freeze([
  {
    name: "kiln_link_evidence",
    entry: "linkEvidence",
    label: "Kiln link evidence",
    description: "Link an evidence record to an assertion as supporting or refuting it.",
    parameters: {
      type: "object",
      properties: {
        assertion: { type: "string", pattern: "^[A-Z]{3}-[0-9]{4}$", description: "An artifact id, such as REQ-0001." },
        evidence: { type: "string", pattern: "^[A-Z]{3}-[0-9]{4}$", description: "An artifact id, such as REQ-0001." },
        polarity: { type: "string", enum: ["support", "refute"], description: "Whether the evidence supports or refutes the assertion." },
      },
      required: ["assertion", "evidence", "polarity"],
      additionalProperties: false,
    },
    call: (fn, p, options) => fn(p.assertion, p.evidence, p.polarity, options),
  },
  {
    name: "kiln_unlink_evidence",
    entry: "unlinkEvidence",
    label: "Kiln unlink evidence",
    description: "Remove an evidence link from an assertion. A link is a judgement, and a judgement may be withdrawn.",
    parameters: {
      type: "object",
      properties: {
        assertion: { type: "string", pattern: "^[A-Z]{3}-[0-9]{4}$", description: "An artifact id, such as REQ-0001." },
        evidence: { type: "string", pattern: "^[A-Z]{3}-[0-9]{4}$", description: "An artifact id, such as REQ-0001." },
        polarity: { type: "string", enum: ["support", "refute"], description: "Which side the link was recorded on." },
      },
      required: ["assertion", "evidence", "polarity"],
      additionalProperties: false,
    },
    call: (fn, p, options) => fn(p.assertion, p.evidence, p.polarity, options),
  },
  {
    name: "kiln_revise_artifact",
    entry: "reviseArtifact",
    label: "Kiln revise artifact",
    description:
      "Change an artifact's own fields. Identity, lifecycle and review status are not revisable here, " +
      "and trace fields have their own operations.",
    parameters: {
      type: "object",
      properties: {
        type: { type: "string", description: "The artifact's type, such as requirement or evidence." },
        id: { type: "string", pattern: "^[A-Z]{3}-[0-9]{4}$", description: "An artifact id, such as REQ-0001." },
        changes: { type: "object", description: "The fields to change, as that type's schema defines them." },
      },
      required: ["type", "id", "changes"],
      additionalProperties: false,
    },
    call: (fn, p, options) => fn(p.type, p.id, p.changes, options),
  },
  {
    name: "kiln_set_lifecycle",
    entry: "setLifecycle",
    label: "Kiln set lifecycle",
    description: "Mark an artifact active, superseded or retired. Superseding requires naming what replaced it.",
    parameters: {
      type: "object",
      properties: {
        type: { type: "string", description: "The artifact's type." },
        id: { type: "string", pattern: "^[A-Z]{3}-[0-9]{4}$", description: "An artifact id, such as REQ-0001." },
        lifecycle: { type: "string", enum: ["active", "superseded", "retired"] },
        supersededBy: { type: "array", items: { type: "string", pattern: "^[A-Z]{3}-[0-9]{4}$", description: "An artifact id, such as REQ-0001." }, description: "What replaced it. Required when superseding." },
      },
      required: ["type", "id", "lifecycle"],
      additionalProperties: false,
    },
    call: (fn, p, options) => fn(p.type, p.id, p.lifecycle, { ...options, supersededBy: p.supersededBy }),
  },
  {
    name: "kiln_resolve_question",
    entry: "resolveQuestion",
    label: "Kiln resolve question",
    description:
      "Settle an open question as answered, deferred or moot. Answering requires the answer, what " +
      "settled it, or both.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", pattern: "^[A-Z]{3}-[0-9]{4}$", description: "An artifact id, such as REQ-0001." },
        resolution: { type: "string", enum: ["answered", "deferred", "moot"] },
        answer: { type: "string", description: "What the answer is." },
        answeredBy: { type: "array", items: { type: "string", pattern: "^[A-Z]{3}-[0-9]{4}$", description: "An artifact id, such as REQ-0001." }, description: "What settled it." },
      },
      required: ["id", "resolution"],
      additionalProperties: false,
    },
    call: (fn, p, options) => fn(p.id, p.resolution, { ...options, answer: p.answer, answeredBy: p.answeredBy }),
  },
  {
    name: "kiln_link_trace",
    entry: "linkTrace",
    label: "Kiln link trace",
    description: "Add references to one of an artifact's trace fields.",
    parameters: {
      type: "object",
      properties: {
        type: { type: "string", description: "The artifact's type." },
        id: { type: "string", pattern: "^[A-Z]{3}-[0-9]{4}$", description: "An artifact id, such as REQ-0001." },
        field: { type: "string", description: "The trace field, such as evaluates or acceptedBy." },
        targets: { type: "array", items: { type: "string", pattern: "^[A-Z]{3}-[0-9]{4}$", description: "An artifact id, such as REQ-0001." }, minItems: 1 },
      },
      required: ["type", "id", "field", "targets"],
      additionalProperties: false,
    },
    call: (fn, p, options) => fn(p.type, p.id, p.field, p.targets, options),
  },
  {
    name: "kiln_unlink_trace",
    entry: "unlinkTrace",
    label: "Kiln unlink trace",
    description: "Remove references from one of an artifact's trace fields.",
    parameters: {
      type: "object",
      properties: {
        type: { type: "string", description: "The artifact's type." },
        id: { type: "string", pattern: "^[A-Z]{3}-[0-9]{4}$", description: "An artifact id, such as REQ-0001." },
        field: { type: "string", description: "The trace field." },
        targets: { type: "array", items: { type: "string", pattern: "^[A-Z]{3}-[0-9]{4}$", description: "An artifact id, such as REQ-0001." }, minItems: 1 },
      },
      required: ["type", "id", "field", "targets"],
      additionalProperties: false,
    },
    call: (fn, p, options) => fn(p.type, p.id, p.field, p.targets, options),
  },
  {
    name: "kiln_set_review_status",
    entry: "setReviewStatus",
    label: "Kiln set review status",
    description: "Move an artifact through review: draft, in-review, approved or amended.",
    parameters: {
      type: "object",
      properties: {
        type: { type: "string", description: "The artifact's type." },
        id: { type: "string", pattern: "^[A-Z]{3}-[0-9]{4}$", description: "An artifact id, such as REQ-0001." },
        reviewStatus: { type: "string", enum: ["draft", "in-review", "approved", "amended"] },
      },
      required: ["type", "id", "reviewStatus"],
      additionalProperties: false,
    },
    call: (fn, p, options) => fn(p.type, p.id, p.reviewStatus, options),
  },
]);

/**
 * A refusal built from whatever the typed tool threw.
 *
 * ⚠️ **THE CODE COMES FROM THE ERROR'S OWN NAME, and the text is scrubbed.** A validation message
 * names fields and schema rules, which is what a model needs; it must not name this machine.
 */
const REFUSAL_CODES = Object.freeze({
  ValidationError: "invalid-artifact",
  ArtifactExistsError: "artifact-exists",
});

/**
 * The same idea for the operations that are not about an artifact.
 *
 * ⚠️ **`invalid-artifact` WOULD BE A WRONG ANSWER HERE.** Activation writes the project manifest and
 * an attestation is planning state; neither has an artifact to be invalid. A model told its artifact
 * was rejected would look for one to correct, and there is none.
 */
const PROJECT_REFUSAL_CODES = Object.freeze({ ValidationError: "invalid-request" });

/** Pi wants a string to show; the structured result travels beside it as details. */
const rendered = (result) => ({ output: JSON.stringify(result, null, 2), details: result });

/**
 * @param {object} pi  Pi's extension API.
 * @param {{lintProject?: Function, handoffCompleteness?: Function}} [deps]  the implementations these
 *   wrappers call. Pi passes one argument, so production always takes the lazy imports below; the only
 *   caller that passes a second is a test that needs to control what a dependency returns, because what
 *   this wrapper must do with a path is its own responsibility whatever the lint hands it.
 */
export default function register(pi, deps = {}) {
  // ⚠️ ONE SHAPE, NINE ROWS. Each tool differs only in which registry entry it delegates to, so the
  // adapter is written once: a per-tool copy is nine places for one rule to drift.
  for (const { name, type, noun } of CREATION_TOOLS)
    pi?.registerTool?.({
      name,
      label: `Kiln create ${noun}`,
      description:
        `Create a ${noun} in this project's planning content. The fields are validated against the ` +
        `${type} schema; id, type, schemaVersion, reviewStatus and lifecycle are assigned by Kiln and ` +
        `must not be supplied.`,
      parameters: {
        type: "object",
        properties: {
          artifact: {
            type: "object",
            description: `The ${noun}'s own fields, as the ${type} schema defines them.`,
          },
        },
        required: ["artifact"],
        additionalProperties: false,
      },
      execute: async (_toolCallId, params) => {
        let context;
        try {
          context = await projectContext();
        } catch (e) {
          return rendered(refusal("no-content-root", `This project's planning content could not be resolved (${e?.code ?? "unresolved"}).`));
        }

        // ⚠️ THROUGH THE REGISTRY, WHICH IS THE ONLY LEGAL WRITER. Nothing here allocates an id,
        // validates, takes a lock or touches a file: every one of those already happens behind this call.
        const typedTools = deps.TYPED_TOOLS ?? (await import("../../lib/tools/registry.mjs")).TYPED_TOOLS;
        const create = typedTools[type];
        if (typeof create !== "function")
          return rendered(refusal("unknown-artifact-type", `This project has no typed tool for a ${type}.`));

        try {
          const made = await create(params?.artifact, context.options);
          return rendered({
            ok: true,
            id: made.id,
            type,
            path: relativeTo(context.contentRoot, made.path),
          });
        } catch (e) {
          // ⚠️ RETURNED, NOT THROWN: a refusal is an answer the model can act on.
          return rendered(refusal(REFUSAL_CODES[e?.name] ?? "refused", scrub(e?.message ?? String(e), context.contentRoot)));
        }
      },
    });

  // ⚠️ THE SAME SHAPE AGAIN: resolve, delegate, render. What differs per row is the call line above.
  for (const { name, entry, label, description, parameters, call } of MUTATION_TOOL_TABLE)
    pi?.registerTool?.({
      name,
      label,
      description,
      parameters,
      execute: async (_toolCallId, params) => {
        let context;
        try {
          context = await projectContext();
        } catch (e) {
          return rendered(refusal("no-content-root", `This project's planning content could not be resolved (${e?.code ?? "unresolved"}).`));
        }

        const mutationTools = deps.MUTATION_TOOLS ?? (await import("../../lib/tools/registry.mjs")).MUTATION_TOOLS;
        const operation = mutationTools[entry];
        if (typeof operation !== "function")
          return rendered(refusal("unknown-operation", `This project has no ${entry} operation.`));

        try {
          const result = await call(operation, params ?? {}, context.options);
          return rendered({
            ok: true,
            id: result?.artifact?.id ?? result?.id ?? params?.id ?? null,
            type: result?.artifact?.type ?? params?.type ?? null,
            path: relativeTo(context.contentRoot, result?.path ?? null),
            changedFields: Array.isArray(result?.changedFields) ? result.changedFields.map((c) => c?.field ?? String(c)) : null,
          });
        } catch (e) {
          return rendered(refusal(REFUSAL_CODES[e?.name] ?? "refused", scrub(e?.message ?? String(e), context.contentRoot)));
        }
      },
    });


  /**
   * The package's own declaration, handed back exactly as it was authored.
   *
   * ⚠️ **RETURNED, NOT REBUILT.** The result IS `SIGNATURE` - the frozen object this module imported
   * from `signature.json` - and not a copy assembled from it. A consumer's whole use for this tool is
   * to compare what a session reports against what the package ships, and a wrapper that re-derived
   * the document would be comparing its own reconstruction. Nothing is added, filtered or reordered
   * in transit, which is also why the result is the declaration itself rather than a declaration
   * wrapped in a status envelope: an envelope is something to unwrap, and unwrapping is where a
   * field goes missing.
   *
   * ⚠️ **IT RESOLVES NO PROJECT, AND THAT IS THE POINT.** This answers a question about the package,
   * which is the same answer in every project and in none. Reaching for a content root would make a
   * static document depend on where the session happens to be standing, and would give this tool a
   * failure mode it has no reason to have.
   */
  pi?.registerTool?.({
    name: "kiln_capability",
    label: "Kiln capability",
    description:
      "Return this Kiln package's versioned signature declaration: the extensions, skills, prompts " +
      "and tools it owns. Reads nothing and changes nothing.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    execute: async () => rendered(SIGNATURE),
  });

  pi?.registerTool?.({
    name: "kiln_project_status",
    label: "Kiln project status",
    description:
      "Report whether this project's planning content is ready to hand off: the artifact count, and " +
      "every blocker standing in the way. Reads only; changes nothing.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    execute: async () => {
      let context;
      try {
        context = await projectContext();
      } catch (e) {
        return rendered(refusal("no-content-root", `This project's planning content could not be resolved (${e?.code ?? "unresolved"}).`));
      }

      const handoffCompleteness =
        deps.handoffCompleteness ?? (await import("../../lib/handoff/completeness.mjs")).handoffCompleteness;
      const completeness = handoffCompleteness(context.ctx, { toolRoot: context.toolRoot });

      return rendered({
        ok: true,
        ready: completeness.ready === true,
        artifactCount: completeness.artifactCount ?? 0,
        blockers: (completeness.blockers ?? []).map((b) => ({
          reason: b.reason ?? null,
          detail: typeof b.detail === "string" ? scrub(b.detail, context.contentRoot) : null,
          ruleId: b.ruleId ?? null,
        })),
      });
    },
  });

  pi?.registerTool?.({
    name: "kiln_lint",
    label: "Kiln lint",
    description:
      "Run Kiln's planning lint over this project's artifacts and return every finding, with the " +
      "artifact and file each belongs to. Reads only; changes nothing.",
    parameters: {
      type: "object",
      properties: {
        // ⚠️ THE LINT'S OWN THREE. An earlier version offered `info`, which no rule emits, and omitted
        // `advisory`, which several do — so a model could ask for a severity that always returns
        // nothing, and could not ask for one that exists.
        severity: {
          type: "string",
          enum: ["error", "warning", "advisory"],
          description: "Return only findings at this severity.",
        },
      },
      additionalProperties: false,
    },
    execute: async (_toolCallId, params) => {
      let context;
      try {
        context = await projectContext();
      } catch (e) {
        return rendered(refusal("no-content-root", `This project's planning content could not be resolved (${e?.code ?? "unresolved"}).`));
      }

      const lintProject = deps.lintProject ?? (await import("../../lib/lint.mjs")).lintProject;
      const { findings, records } = lintProject(context.ctx);
      const wanted = typeof params?.severity === "string" ? params.severity : null;

      const selected = (findings ?? []).filter((f) => wanted === null || f.severity === wanted);
      return rendered({
        ok: true,
        artifactCount: (records ?? []).length,
        findingCount: selected.length,
        findings: selected.map((f) => ({
          ruleId: f.ruleId ?? null,
          severity: f.severity ?? null,
          message: typeof f.message === "string" ? scrub(f.message, context.contentRoot) : null,
          artifactId: f.id ?? f.artifactId ?? null,
          // ⚠️ RELATIVE OR ABSENT. A finding whose path lies outside the content root names something
          // this result has no business carrying.
          path: relativeTo(context.contentRoot, f.path ?? f.file ?? null),
        })),
      });
    },
  });

  /**
   * Activation, which is an approval rather than an edit.
   *
   * ⚠️ **`approvedBy` IS REQUIRED ON THE WIRE BECAUSE IT IS REQUIRED BY THE OPERATION.** Activation is
   * a PM approval, and the operation refuses without a name; a wrapper that supplied a default would be
   * signing the approval on somebody else's behalf. The schema asks for it so the model asks the
   * operator.
   *
   * ⚠️ **`toolRoot` IS PASSED, AND THAT IS NOT DECORATION.** Activation validates reachability against
   * the stage definitions, which live under the tool root; without it the operation cannot tell whether
   * any stage produces the type, and refuses rather than guessing.
   */
  pi?.registerTool?.({
    name: "kiln_set_type_activation",
    label: "Kiln set type activation",
    description:
      "Activate or deactivate an artifact type for this project. Activation is a PM approval and " +
      "records who gave it. It validates the type against the catalogue, its schema, its typed tool " +
      "and the stage that produces it; it never edits the catalogue, the schemas or the stages.",
    parameters: {
      type: "object",
      properties: {
        type: { type: "string", description: "The artifact type, such as component or task." },
        action: { type: "string", enum: ["activate", "deactivate"] },
        approvedBy: { type: "string", description: "Who approved this change. Recorded in the project manifest." },
        reason: { type: "string", description: "Why it was approved. Recorded beside the approval." },
      },
      required: ["type", "action", "approvedBy"],
      additionalProperties: false,
    },
    execute: async (_toolCallId, params) => {
      let context;
      try {
        context = await projectContext();
      } catch (e) {
        return rendered(refusal("no-content-root", `This project's planning content could not be resolved (${e?.code ?? "unresolved"}).`));
      }

      const projectTools = deps.PROJECT_TOOLS ?? (await import("../../lib/tools/registry.mjs")).PROJECT_TOOLS;
      const setTypeActivation = projectTools?.setTypeActivation;
      if (typeof setTypeActivation !== "function")
        return rendered(refusal("unknown-operation", "This project has no setTypeActivation operation."));

      try {
        const result = await setTypeActivation(params?.type, params?.action, {
          ...context.options,
          toolRoot: context.toolRoot,
          approvedBy: params?.approvedBy,
          reason: params?.reason,
        });
        return rendered({
          ok: true,
          type: result?.type ?? params?.type ?? null,
          action: result?.action ?? params?.action ?? null,
          changed: result?.changed === true,
          activated: Array.isArray(result?.activated) ? result.activated : [],
          // ⚠️ Named for what it is. The operation reports `reason` on a no-op, and the input has a
          // `reason` of its own meaning why the change was approved; one word for both would read as
          // agreement between two unrelated things.
          noChangeBecause: result?.changed === true ? null : (result?.reason ?? null),
        });
      } catch (e) {
        return rendered(refusal(PROJECT_REFUSAL_CODES[e?.name] ?? "refused", scrub(e?.message ?? String(e), context.contentRoot)));
      }
    },
  });

  /**
   * The stage attestations, read and written.
   *
   * ⚠️ **NOT THROUGH THE TYPED REGISTRY, BECAUSE AN ATTESTATION IS NOT AN ARTIFACT.** It is planning
   * state that gates a stage transition: no id, no schema, no lifecycle. The registry governs
   * artifacts, and filing these there would make two different kinds of thing look like one.
   *
   * ⚠️ **THERE IS NO "ACKNOWLEDGED" RESULT, AND THE WRAPPER DOES NOT ADD ONE.** The three the operation
   * accepts are the three a human gate can return; seeing a criterion is not a verdict on it.
   */
  pi?.registerTool?.({
    name: "kiln_read_stage_attestations",
    label: "Kiln read stage attestations",
    description:
      "Return the recorded human evaluations for one stage's exit criteria. Reads only; changes nothing.",
    parameters: {
      type: "object",
      properties: {
        stage: { type: "string", pattern: "^[0-9]{2}-[a-z0-9-]+$", description: "A stage id, such as 03-discovery." },
      },
      required: ["stage"],
      additionalProperties: false,
    },
    execute: async (_toolCallId, params) => {
      let context;
      try {
        context = await projectContext();
      } catch (e) {
        return rendered(refusal("no-content-root", `This project's planning content could not be resolved (${e?.code ?? "unresolved"}).`));
      }

      const attestations = deps.attestations ?? (await import("../../lib/attestations.mjs"));
      try {
        const recorded = attestations.loadStageAttestations(context.contentRoot, params?.stage);
        const entries = Object.entries(recorded ?? {});
        return rendered({
          ok: true,
          stage: params?.stage ?? null,
          path: relativeTo(context.contentRoot, attestations.stageAttestationsPath(context.contentRoot, params?.stage)),
          count: entries.length,
          attestations: entries.map(([criterion, value]) => ({
            criterion,
            result: value?.result ?? null,
            decidedBy: value?.decidedBy ?? null,
            reason: typeof value?.reason === "string" ? scrub(value.reason, context.contentRoot) : null,
          })),
        });
      } catch (e) {
        return rendered(refusal(PROJECT_REFUSAL_CODES[e?.name] ?? "refused", scrub(e?.message ?? String(e), context.contentRoot)));
      }
    },
  });

  pi?.registerTool?.({
    name: "kiln_write_stage_attestation",
    label: "Kiln write stage attestation",
    description:
      "Record one human evaluation of a stage exit criterion: satisfied, not-satisfied, or n/a with a " +
      "reason. It must say who decided it.",
    parameters: {
      type: "object",
      properties: {
        stage: { type: "string", pattern: "^[0-9]{2}-[a-z0-9-]+$", description: "A stage id, such as 03-discovery." },
        criterion: { type: "string", pattern: "^[a-z0-9-]+$", description: "The exit criterion's id, such as unknowns-resolved." },
        result: { type: "string", enum: ["satisfied", "not-satisfied", "n/a"] },
        decidedBy: { type: "string", description: "Who evaluated it." },
        reason: { type: "string", description: "Why. Required when the result is n/a." },
      },
      required: ["stage", "criterion", "result", "decidedBy"],
      additionalProperties: false,
    },
    execute: async (_toolCallId, params) => {
      let context;
      try {
        context = await projectContext();
      } catch (e) {
        return rendered(refusal("no-content-root", `This project's planning content could not be resolved (${e?.code ?? "unresolved"}).`));
      }

      const attestations = deps.attestations ?? (await import("../../lib/attestations.mjs"));
      try {
        const written = await attestations.writeStageAttestation(context.contentRoot, params?.stage, params?.criterion, {
          result: params?.result,
          decidedBy: params?.decidedBy,
          reason: params?.reason,
        });
        return rendered({
          ok: true,
          stage: params?.stage ?? null,
          criterion: params?.criterion ?? null,
          result: written?.result ?? null,
          decidedBy: written?.decidedBy ?? null,
          reason: typeof written?.reason === "string" ? scrub(written.reason, context.contentRoot) : null,
          path: relativeTo(context.contentRoot, attestations.stageAttestationsPath(context.contentRoot, params?.stage)),
        });
      } catch (e) {
        return rendered(refusal(PROJECT_REFUSAL_CODES[e?.name] ?? "refused", scrub(e?.message ?? String(e), context.contentRoot)));
      }
    },
  });
}
