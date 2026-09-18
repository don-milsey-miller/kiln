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
async function projectContext(deps = {}) {
  const [{ resolveContentRoot, toolRoot }, { assertOrchestratorContentRoot }, { loadSchemaSet }, { createValidators }, { readActivatedTypes }, { join }] =
    await Promise.all([
      import("../../lib/content-root.mjs"),
      import("../../lib/orchestrator-root.mjs"),
      import("../../lib/schema-resolver.mjs"),
      import("../../lib/validate.mjs"),
      import("../../lib/activation.mjs"),
      import("node:path"),
    ]);

  const contentRoot = resolveContentRoot();
  // ⚠️ `deps.toolRoot` exists for tests, which need a tool root they may safely let a handler near; Pi passes
  // no second argument to `register`, so production always takes the tool root this module lives in.
  const tool = deps.toolRoot ?? toolRoot();
  // ⚠️ THE TOOL'S OWN CONTENT IS REFUSED HERE, BEFORE ANY SCHEMA, ACTIVATION, ARTIFACT OR DOCUMENT IS READ (ACC-0071).
  assertOrchestratorContentRoot({ contentRoot, toolRoot: tool });
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
 * The research tools this host can offer, built when one is first called.
 *
 * ⚠️ **BUILT ON INVOCATION, LIKE EVERYTHING ELSE HERE.** Constructing the adapter at registration
 * would import `lib/` into a package that must load with nothing but itself present, and would do
 * work for a session that may never ask a research question.
 *
 * ⚠️ **THE ADAPTER IS INJECTED INTO THE LIBRARY, NOT CHOSEN BY IT.** Which backend answers is
 * `lib/research/`'s decision to expose and this file's to pass on; no vendor name appears here, for
 * the same reason none appears in the library's own contract.
 */
async function defaultResearchTools() {
  const [{ createResearchTools }, { createTavilyAdapter }] = await Promise.all([
    import("../../lib/research/tools.mjs"),
    import("../../lib/research/tavily-adapter.mjs"),
  ]);
  return createResearchTools(createTavilyAdapter());
}

/**
 * The validation tools this host can offer, built when one is first called - for the reasons the
 * research tools are: the package must load on its own, and a session may never validate anything.
 */
async function defaultValidationTools() {
  const { createValidationTools } = await import("../../lib/validation/tools.mjs");
  return createValidationTools();
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
 * What every project-bound handler returns when the content root is the tool's own - ACC-0071, D13.
 *
 * ⚠️ **TWO SURFACES.** The model receives this fixed result: a stable code and two placeholders, never a path.
 * The operator is told the canonical absolute paths through the UI, once, when the invocation has one. Without a
 * UI nothing is written to a terminal stream - the launcher's own refusal is the operator's surface there.
 */
function toolContentRefused(error, ctx) {
  if (error?.code !== "tool-content-refused") return null;
  if (ctx?.hasUI === true && typeof ctx.ui?.notify === "function") {
    try {
      ctx.ui.notify(String(error.message), "error");
    } catch {
      // A UI that cannot show the notice changes nothing about the refusal.
    }
  }
  return rendered({ ok: false, code: "tool-content-refused", contentRoot: "<content-root>", toolRoot: "<tool-root>" });
}

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
 * The research tools, as an explicit table.
 *
 * ⚠️ **THE NAMES ARE UNPREFIXED, AND THAT IS A CONTRACT RATHER THAN AN OVERSIGHT.**
 * `lib/specialists/contract.mjs` requires `research_capability`, `research_search` and
 * `research_fetch` BY KEY, reads their measured signatures from those keys, and `verifyChild` checks
 * a child's registry against them. A `kiln_` prefix here would break the specialist contract and the
 * signature check to satisfy a naming habit nobody wrote down.
 *
 * ⚠️ **THE SCHEMAS ARE WRITTEN OUT, AND A TEST HOLDS THEM TO THE MEASURED ONES.** They cannot be
 * imported: this entry point must load with nothing but the package present - a fixture copies only
 * `pi-package/` and asks Pi to load it - so reaching into `lib/` at registration would make the
 * package unloadable on its own. Declaring them here and asserting deep equality against
 * `RESEARCH_TOOL_SIGNATURES` in a test is the same trade the signature version already makes: two
 * independent statements that a test compares, rather than one statement agreeing with itself.
 */
const RESEARCH_TOOL_TABLE = Object.freeze([
  {
    name: "research_capability",
    label: "Research capability",
    description:
      "Report whether research is usable on this host, proven by a live backend probe. Returns available:false with a distinct reason when it is not.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "research_search",
    label: "Research search",
    description:
      "Discover candidate sources for a question. Returns titles, URLs and snippets. DISCOVERY ONLY - not evidence, and not an answer.",
    parameters: {
      type: "object",
      properties: { query: { type: "string", minLength: 1 }, maxResults: { type: "integer", minimum: 1, maximum: 20 } },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "research_fetch",
    label: "Research fetch",
    description:
      "Retrieve one public web page as text, through the public-web boundary. Rejects non-HTTP(S) schemes, URL credentials, private and link-local destinations, oversized bodies and unsupported media types, and revalidates every redirect.",
    parameters: {
      type: "object",
      properties: { url: { type: "string" }, maxBytes: { type: "integer", minimum: 1024 } },
      required: ["url"],
      additionalProperties: false,
    },
  },
]);

/**
 * The validation tools, as an explicit table.
 *
 * ⚠️ **UNPREFIXED FOR THE SAME REASON AS THE RESEARCH TOOLS.** `lib/specialists/contract.mjs` requires
 * `validation_capability` and `validation_run` by key, and `verifyChild` checks a child's registry
 * against those keys.
 *
 * ⚠️ **WRITTEN OUT, AND HELD TO `VALIDATION_TOOL_SIGNATURES` BY A TEST.** Importing them would reach
 * into `lib/` at registration, which a package that must load on its own cannot do.
 */
const VALIDATION_TOOL_TABLE = Object.freeze([
  {
    name: "validation_capability",
    label: "Validation capability",
    description:
      "Report whether this host can run tier-1 validation, proven by executing the interpreter. Returns available:false with a reason when it cannot.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "validation_run",
    label: "Validation run",
    description:
      "Run one DECLARED validation job under the controller: provision -> execute -> observe -> destroy. Refuses jobs above the approved ceiling before provisioning. Returns an observation record, never a verdict.",
    parameters: {
      type: "object",
      properties: {
        tier: { type: "integer", minimum: 1, maximum: 3 },
        commands: { type: "array", items: { type: "array", items: { type: "string" } } },
        timeoutMs: { type: "integer", minimum: 1 },
        maxOutputBytes: { type: "integer", minimum: 1 },
        capturePlan: { type: "object" },
        expectedOutputs: {
          type: "array",
          items: {
            oneOf: [
              { type: "string", minLength: 1 },
              {
                type: "object",
                properties: { path: { type: "string", minLength: 1 }, minBytes: { type: "integer", minimum: 0 } },
                required: ["path"],
                additionalProperties: false,
              },
            ],
          },
        },
        inputs: { type: "object", additionalProperties: { type: "string" } },
        requires: { type: "object" },
      },
      required: ["tier", "commands", "timeoutMs", "maxOutputBytes", "capturePlan", "expectedOutputs"],
      additionalProperties: false,
    },
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

/**
 * A result as Pi carries it: the rendering as model-visible text content, and the structured result beside it.
 *
 * ⚠️ **`content` IS THE ONLY PART A MODEL SEES (F114).** Pi builds the provider's tool message from `content`
 * alone; a result without it reached every model as `(no tool output)`, while `details` still looked complete
 * to anything reading `tool_execution_end`. `output` and `details` are kept exactly as they were.
 */
const rendered = (result) => {
  const output = JSON.stringify(result, null, 2);
  return { content: [{ type: "text", text: output }], output, details: result };
};

/**
 * A validation result as a model may see it.
 *
 * ⚠️ **THIS IS THE DISCLOSURE BOUNDARY, AND THE CONTROLLER IS DELIBERATELY NOT.** `lib/validation/`
 * keeps precise internal paths in what it returns - the workspace a provisioning failure names, the
 * directory a failed cleanup left behind, a traceback's file - because those are diagnostics the
 * controller's own callers need. What reaches a model is decided here. A consumer that bypassed this
 * boundary and showed a controller result to a model, or persisted it, would need its own rendering;
 * the controller is not changed to anticipate one that does not exist.
 *
 * ⚠️ **A COPY, NEVER AN EDIT.** The controller's object is left exactly as it was returned, so the
 * diagnostic record still exists for whatever called the controller to keep.
 *
 * ⚠️ **THE WORKSPACE FIRST, BY ITS EXACT ROOT, SO WHAT FOLLOWS IT SURVIVES.** A traceback naming
 * `<tmp>/vpw-tier1-Ab3dEf/check.py` is useful as `<workspace>/check.py` and useless as `<path>`. The
 * root is known exactly two ways - the retained path when cleanup failed, and the controller's own
 * `vpw-tier1-` workspace under the temporary directory - and each is matched in every separator
 * spelling a string can carry: raw, forward-slashed, and JSON-escaped. Only then does the general
 * scrub run, over what is left, and it cannot reach back into what was already rendered.
 *
 * ⚠️ **CREDENTIALS ARE KEPT OUT UPSTREAM, NOT REDACTED HERE.** This entry point may not read the
 * environment at all - its purity is a tested property of the package - so it has no credential
 * values to look for. The controller runs every job in an allowlisted environment that supplies
 * none, and the tests plant a credential and assert it reaches no rendered result.
 */
const WORKSPACE_PREFIX = "vpw-tier1-";
const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const SEPARATOR = String.raw`[\\/]+`;
/**
 * Where a path stops: a separator, whitespace, a quote, markup, or the punctuation prose puts after a
 * path - `, ; ( ) :` - and the placeholder this renderer holds rendered text behind. Without the
 * punctuation, `home is C:\Users\someone, node is ...` would not match its root and would fall to the
 * backstop, which would swallow the comma.
 */
const STOPS = String.raw`\s"'<>|*?:,;()\u0001`;
/**
 * Where a segment ends: at a separator, a stop, the end of the text, or a full stop that is itself
 * followed by one. `C:\Users\someone` must not match inside `someone2`, and `...retained at
 * C:\...\vpw-tier1-Ab3dEf.` must keep its sentence's period rather than read it as part of the name -
 * while `check.py` and `.venv` keep theirs, because a period followed by more of the name is not an end.
 */
const END_AHEAD = String.raw`(?=[\\/${STOPS}]|\.(?:[${STOPS}]|$)|$)`;
const SEGMENT_END = END_AHEAD;
/** Whatever relative path follows a root, stopping where a path cannot continue. */
const TAIL = String.raw`((?:[\\/]+[^\\/${STOPS}]+?${END_AHEAD})*)`;
const DRIVE_PATH = new RegExp(String.raw`(?<![A-Za-z0-9])[A-Za-z]:[\\/][^${STOPS}]*?${END_AHEAD}`, "g");
const POSIX_PATH = new RegExp(String.raw`(?<![\w.~\/:\u0001-])\/(?:[^${STOPS}\/]+\/)+[^${STOPS}\/]*?${END_AHEAD}`, "g");

/** A root as a pattern matching it in any separator spelling, ending where the segment ends. */
const rootPattern = (root) =>
  root
    .split(/[\\/]+/)
    .filter((segment, index) => segment.length > 0 || index === 0)
    .map(escapeRegExp)
    .join(SEPARATOR);

async function renderValidationResult(result) {
  const { homedir, tmpdir } = await import("node:os");
  const flags = process.platform === "win32" ? "gi" : "g";

  const workspaceRoots = [];
  const retained = result?.destroy?.retainedPath;
  if (typeof retained === "string" && retained.length > 0)
    workspaceRoots.push(new RegExp(rootPattern(retained) + SEGMENT_END + TAIL, flags));
  workspaceRoots.push(
    new RegExp(rootPattern(tmpdir()) + SEPARATOR + escapeRegExp(WORKSPACE_PREFIX) + "[A-Za-z0-9]{6}" + SEGMENT_END + TAIL, flags)
  );
  // ⚠️ THE INTERPRETER, THE TEMPORARY DIRECTORY AND HOME, longest-first, before the backstop: each is
  // named whole, so a path with a space in it is not left half-rendered by a pattern that stops at one.
  const machineRoots = [process.execPath, tmpdir(), homedir()]
    .filter((root) => typeof root === "string" && root.length > 1)
    .sort((a, b) => b.length - a.length)
    .map((root) => new RegExp(rootPattern(root) + SEGMENT_END + TAIL, flags));

  const render = (text) => {
    const held = [];
    const hold = (value) => `\u0001${held.push(value) - 1}\u0001`;
    let out = text;
    for (const pattern of workspaceRoots)
      out = out.replace(pattern, (_match, tail) => hold(`<workspace>${(tail ?? "").replace(/[\\/]+/g, "/")}`));
    for (const pattern of machineRoots) out = out.replace(pattern, () => hold("<path>"));
    out = out.replace(DRIVE_PATH, "<path>").replace(POSIX_PATH, "<path>");
    return out.replace(/\u0001(\d+)\u0001/g, (_match, index) => held[Number(index)]);
  };

  const copy = (value) => {
    if (typeof value === "string") return render(value);
    if (Array.isArray(value)) return value.map(copy);
    if (value !== null && typeof value === "object")
      return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, copy(inner)]));
    return value;
  };
  return copy(result);
}

/**
 * Anything `kiln_project_status` returns, as a model may see it - G3a, F101, F103, F105.
 *
 * ⚠️ **EVERY STRING VALUE, RECURSIVELY; NO PROPERTY NAME.** A result's shape is this file's own, and its keys
 * are what a caller reads by; the values are where project-authored text, identifiers and loader output
 * arrive. Path fields are reduced to the content root, or to `null`, before this runs.
 *
 * ⚠️ **ROOTS FIRST, BY THEIR EXACT SPELLING, THEN CREDENTIALS, THEN THE PATH BACKSTOP.** The content root and
 * the tool root become `<content-root>` and `<tool-root>` with their relative tail kept, because
 * `<content-root>/data/notes.md` still tells a model something; the interpreter, the temporary directory and
 * home become `<path>`. Credential-shaped text becomes `<credential>`. Whatever still looks like an absolute
 * path becomes `<path>`.
 *
 * ⚠️ **CREDENTIAL REDACTION HERE IS PATTERN-BASED, AND THAT HAS TWO LIMITS.** This entry point may not read the
 * environment, so it cannot compare against the credentials this machine actually holds. It recognises the
 * formats below - common provider key prefixes, JSON web tokens, private-key blocks, and long unbroken runs of
 * letters and digits together - and nothing else, so a credential in another format passes. And it will
 * redact legitimate text that happens to match: a 40-character commit hash, a long base64 value, an opaque id.
 */
const CREDENTIAL = "<credential>";
const CREDENTIAL_PATTERNS = Object.freeze([
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  /\bsk-[A-Za-z0-9][A-Za-z0-9_-]{15,}/g,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bxox[abeprs]-[A-Za-z0-9-]{10,}/g,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{35}/g,
  /\btvly-[A-Za-z0-9_-]{16,}/g,
]);
/** A long unbroken run, redacted only when it mixes letters and digits. Hyphens and slashes end it, so ids and relative paths survive. */
const LONG_RUN = /[A-Za-z0-9_+=]{32,}/g;

/**
 * Absolute paths in text, removed fail-closed - G3a.
 *
 * ⚠️ **ONCE A PATH HAS STARTED, IT RUNS TO THE NEXT HARD DELIMITER.** Nothing about a path's own text says where
 * it ends: folders and file names can hold spaces and dots, and a file name need not have an extension. Every
 * attempt to infer the end from the words left a trailing piece behind - `Documents\x.txt`, ` notes`. So a
 * recognised start consumes everything up to a quote or backtick, a line break, `,` `;` `)` `]` `}`, or `< > |`.
 * A space, a tab, a dot and a colon never end a path.
 *
 * ⚠️ **THE STARTS.** A drive letter and a separator; two or more separators, which is a UNC path, a
 * forward-slash UNC path, a JSON-escaped one, or a `\\?\` extended path; a single slash before a non-space,
 * which is a POSIX path of any depth, `/secret` included; and a single backslash before a path character, which
 * is a Windows path from the root of the current drive, `\Users\someone\x.txt`. None of them may follow a letter,
 * a digit or another path character, so `and/or`, `A\B`, `1/2`, `2026/09/13` and the `//` and paths of a URL are
 * not starts, and a backslash straight before a delimiter - an escaped quote - is not one either.
 *
 * ⚠️ **ACCEPTED LIMITATION: PROSE ATTACHED TO AN UNQUOTED PATH IS REMOVED WITH IT.** `See C:\x.txt and more.`
 * becomes `See <path>`. This is a model-facing boundary, and a readable sentence is worth less than a leaked
 * path. Quoting a path, or following it with a delimiter, keeps what comes after.
 *
 * ⚠️ **NOT THE VALIDATION RENDERER'S PATTERNS.** Its `DRIVE_PATH` and `POSIX_PATH` stop at a space, and
 * `DRIVE_PATH` at its first separator (F110). They belong to that wrapper and are left as they are.
 */
const isSeparator = (ch) => ch === "\\" || ch === "/";
const isHardDelimiter = (ch) => /["'`\r\n,;)\]}<>|]/.test(ch) || ch.charCodeAt(0) === 1;

/** The index of the next hard delimiter at or after `from`, or the end of the text. */
function pathEnd(text, from) {
  let i = from;
  while (i < text.length && !isHardDelimiter(text[i])) i += 1;
  return i;
}

/** `text` with each match of a root pattern, and everything after it up to a hard delimiter, handed to `replace`. */
function replaceRoot(text, pattern, replace) {
  pattern.lastIndex = 0;
  let out = "";
  let last = 0;
  for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) {
    const rootEnd = match.index + match[0].length;
    const tailEnd = pathEnd(text, rootEnd);
    out += text.slice(last, match.index) + replace(text.slice(rootEnd, tailEnd));
    last = tailEnd;
    pattern.lastIndex = Math.max(tailEnd, match.index + 1);
  }
  return out + text.slice(last);
}

const PATH_STARTS = Object.freeze([
  /(?<![A-Za-z0-9])[A-Za-z]:[\\/]/g,
  /(?<![\w:\\\/.~-])(?:\\{2,}|\/{2,})(?=[^\s\\\/])/g,
  /(?<![\w.~\/\\:-])\/(?=[^\s\/\\])/g,
  /(?<![\w:\\\/.~-])\\(?=[^\s\\\/"'`\r\n,;)\]}<>|])/g,
]);

/** `text` with every absolute path no known root accounted for replaced by `<path>`, through its delimiter. */
function replaceUnknownPaths(text) {
  let out = "";
  let last = 0;
  let at = 0;
  for (;;) {
    let next = null;
    for (const start of PATH_STARTS) {
      start.lastIndex = at;
      const match = start.exec(text);
      if (match && (next === null || match.index < next.index)) next = match;
    }
    if (next === null) break;
    // A separator straight after a held rendering continues that rendering; it is not a new path.
    if (text.charCodeAt(next.index - 1) === 1) {
      at = next.index + 1;
      continue;
    }
    const end = pathEnd(text, next.index);
    out += `${text.slice(last, next.index)}<path>`;
    last = end;
    at = end;
  }
  return out + text.slice(last);
}

/**
 * What follows a kept root (the content root, the tool root): the separators joining it, then the rest of that
 * run of text with every absolute path and credential in it removed, and its separators written as `/`.
 */
function cleanRootTail(tail) {
  const joining = /^[\\/]*/.exec(tail)[0];
  const rest = redactCredentials(replaceUnknownPaths(tail.slice(joining.length)));
  return (joining.length > 0 ? "/" : "") + rest.replace(/[\\/]+/g, "/");
}

const redactCredentials = (text) => {
  let out = text;
  for (const pattern of CREDENTIAL_PATTERNS) out = out.replace(pattern, CREDENTIAL);
  return out.replace(LONG_RUN, (run) => (/[A-Za-z]/.test(run) && /\d/.test(run) ? CREDENTIAL : run));
};

async function renderForModel(value, { contentRoot = null, toolRoot = null } = {}) {
  const { homedir, tmpdir } = await import("node:os");
  const flags = process.platform === "win32" ? "gi" : "g";

  // ⚠️ LONGEST ROOT FIRST, so a content root inside the temporary directory is named as the content root.
  const roots = [
    ...[
      [contentRoot, "<content-root>"],
      [toolRoot, "<tool-root>"],
    ].map(([root, label]) => ({ root, label, keepTail: true })),
    ...[process.execPath, tmpdir(), homedir()].map((root) => ({ root, label: "<path>", keepTail: false })),
  ]
    .filter(({ root }) => typeof root === "string" && root.length > 1)
    .sort((a, b) => b.root.length - a.root.length)
    .map(({ root, label, keepTail }) => ({ pattern: new RegExp(rootPattern(root) + SEGMENT_END, flags), label, keepTail }));

  const render = (text) => {
    const held = [];
    const hold = (rendered) => `\u0001${held.push(rendered) - 1}\u0001`;
    let out = text;
    for (const { pattern, label, keepTail } of roots)
      out = replaceRoot(out, pattern, (tail) => hold(keepTail ? `${label}${cleanRootTail(tail)}` : label));
    // ⚠️ PATHS BEFORE CREDENTIALS, so a credential inside a path goes with the path rather than splitting it.
    out = replaceUnknownPaths(out);
    out = redactCredentials(out);
    return out.replace(/\u0001(\d+)\u0001/g, (_match, index) => held[Number(index)]);
  };

  const copy = (inner) => {
    if (typeof inner === "string") return render(inner);
    if (Array.isArray(inner)) return inner.map(copy);
    if (inner !== null && typeof inner === "object") return Object.fromEntries(Object.entries(inner).map(([key, v]) => [key, copy(v)]));
    return inner;
  };
  return copy(value);
}

/** The most of the Stage 1 document a status result carries, in UTF-8 bytes, measured after cleaning (D19). */
const STAGE_DOCUMENT_MAX_BYTES = 64 * 1024;

/**
 * What the intake block may cost, as explicit initial limits rather than as a measurement.
 *
 * ⚠️ **THE NEWEST ENTRIES ARE THE ONES KEPT.** `stageOneDocument.text` is cut from the FRONT at 64 KiB, so in
 * a long intake the newest answers are exactly the ones that fall out of the document. This block is built
 * newest-first from the whole parse, which is what makes them observable at all once that happens.
 */
const INTAKE_ENTRIES_MAX = 10;
const INTAKE_FIELD_MAX_BYTES = 1024;
const INTAKE_BYTES_MAX = 16 * 1024;

const utf8 = new TextEncoder();

/** `text` cut to at most `maxBytes` of UTF-8 at a character boundary, never inside one. */
function capUtf8(text, maxBytes) {
  if (typeof text !== "string") return { text: null, truncated: false };
  if (utf8.encode(text).length <= maxBytes) return { text, truncated: false };
  let bytes = 0;
  let end = 0;
  for (const ch of text) {
    const size = utf8.encode(ch).length;
    if (bytes + size > maxBytes) break;
    bytes += size;
    end += ch.length;
  }
  return { text: text.slice(0, end), truncated: true };
}

/**
 * The intake entries a model receives: the newest that fit, in the order they were recorded.
 *
 * ⚠️ **CALLED AFTER CLEANING, AND THE BOUND IS MEASURED ON WHAT IS ACTUALLY SENT.** `INTAKE_BYTES_MAX` is the
 * UTF-8 length of this array as JSON, with each field already capped, so the limit is on the result rather
 * than on the project's own text.
 *
 * ⚠️ **THE NEWEST ENTRY ALWAYS FITS.** Two fields of at most 1 KiB each cannot approach 16 KiB, so the loop
 * below can never drop the one entry the caller most needs.
 */
function boundIntakeEntries(entries) {
  const kept = [];
  for (let i = entries.length - 1; i >= 0 && kept.length < INTAKE_ENTRIES_MAX; i--) {
    const answer = capUtf8(entries[i].answer, INTAKE_FIELD_MAX_BYTES);
    const reading = capUtf8(entries[i].reading, INTAKE_FIELD_MAX_BYTES);
    // Newest first, each older one in front of it, so what comes out is already in recorded order.
    kept.unshift({
      label: entries[i].label,
      answer: answer.text,
      answerTruncated: answer.truncated,
      reading: reading.text,
      readingTruncated: reading.truncated,
    });
    if (utf8.encode(JSON.stringify(kept)).length > INTAKE_BYTES_MAX) {
      kept.shift();
      break;
    }
  }
  return kept;
}

/**
 * @param {object} pi  Pi's extension API.
 * @param {{lintProject?: Function, handoffCompleteness?: Function, researchTools?: object, validationTools?: object}} [deps]  the implementations these
 *   wrappers call. Pi passes one argument, so production always takes the lazy imports below; the only
 *   caller that passes a second is a test that needs to control what a dependency returns, because what
 *   this wrapper must do with a path is its own responsibility whatever the lint hands it.
 */
/**
 * The current stage's skill in the system prompt - TSK-0048 (G4), toward ACC-0068 (D11).
 *
 * ⚠️ **THE SESSION CANNOT READ A SKILL FILE ITSELF (F95).** Its tools are exactly Kiln's, so Pi's `read` is absent
 * and Pi leaves skills out of the system prompt. This hook adds the current stage's skill instead: the complete
 * content of the one file Pi resolved for that name, override included, with no path.
 *
 * ⚠️ **PI SWALLOWS A HOOK'S ERROR AND CARRIES ON.** A throw here would start the session with no stage context
 * and nothing saying why. Every failure therefore becomes an authored block naming a stable code and telling the
 * model to change nothing.
 *
 * ⚠️ **ONE BLOCK, HOWEVER OFTEN IT RUNS, FRAMED BY LENGTH.** Pi hands the hook its base prompt each turn. If what it
 * is handed ends with an earlier Kiln frame, exactly that frame is removed before the new one is appended. The
 * payload is project-authored when a consumer overrides a skill, so it may contain any marker text: a frame is
 * therefore never found by searching for markers. Only a footer at the very end of the prompt is read, its length
 * (UTF-16 code units, the string's own `length`) locates the payload's start, and the separator and header must sit
 * exactly there. Anything else is not a Kiln frame, and nothing in the prompt is removed on a guess.
 */
const STAGE_CONTEXT_OPENING = "\n\n<!-- kiln:stage-context:begin -->\n";
const STAGE_CONTEXT_FOOTER_AT_END = /\n<!-- kiln:stage-context:end length=(0|[1-9]\d{0,8}) -->$/;

const framedStageContext = (payload) => `${STAGE_CONTEXT_OPENING}${payload}\n<!-- kiln:stage-context:end length=${payload.length} -->`;

function withoutStageContextFrame(prompt) {
  const footer = STAGE_CONTEXT_FOOTER_AT_END.exec(prompt);
  if (footer === null) return prompt;
  const frameStart = footer.index - Number(footer[1]) - STAGE_CONTEXT_OPENING.length;
  if (frameStart < 0 || prompt.slice(frameStart, frameStart + STAGE_CONTEXT_OPENING.length) !== STAGE_CONTEXT_OPENING) return prompt;
  return prompt.slice(0, frameStart);
}

const failClosedStageContext = (code) =>
  [
    "Kiln stage context: unavailable.",
    `Kiln could not supply this session's stage context (code: ${code}).`,
    "Make no change to this project's planning content: call no tool that creates, revises, links, unlinks, approves, activates or attests anything.",
    "Tell the operator the code above, and stop.",
  ].join("\n");

async function stageContextBlock(event, deps) {
  let stageContext;
  try {
    const context = await projectContext(deps);
    const { resolveStageContext } = await import("../../lib/stage-context.mjs");
    stageContext = resolveStageContext(context.ctx, { toolRoot: context.toolRoot, skills: event?.systemPromptOptions?.skills });
  } catch (e) {
    let code = "stage-context-unavailable";
    try {
      code = (await import("../../lib/stage-context.mjs")).stageContextCode(e);
    } catch {
      // The authored fallback code stands.
    }
    return failClosedStageContext(code);
  }

  if (stageContext.complete)
    return [
      "Kiln stage context: every stage is complete.",
      "Every stage gate is ready, so no stage is current and no stage skill is supplied.",
      "Tell the operator the planning stages are complete, and do not start another stage.",
    ].join("\n");

  const { stage, skillName, content } = stageContext;
  return [
    `Kiln stage context: the current stage is ${stage.id}${stage.name ? ` (${stage.name})` : ""}.`,
    `Its skill, ${skillName}, follows exactly as this session loaded it. Work from it.`,
    `<stage-skill name="${skillName}">`,
    content,
    "</stage-skill>",
  ].join("\n");
}

export default function register(pi, deps = {}) {
  // ⚠️ THE ONE HOOK, AND NOTHING RUNS AT REGISTRATION: `lib/`, project state and skill bytes are loaded when it fires.
  pi?.on?.("before_agent_start", async (event) => {
    const base = withoutStageContextFrame(typeof event?.systemPrompt === "string" ? event.systemPrompt : "");
    const block = await stageContextBlock(event, deps);
    return { systemPrompt: `${base}${framedStageContext(block)}` };
  });

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
      execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
        let context;
        try {
          context = await projectContext(deps);
        } catch (e) {
          return toolContentRefused(e, ctx) ?? rendered(refusal("no-content-root", `This project's planning content could not be resolved (${e?.code ?? "unresolved"}).`));
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
      execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
        let context;
        try {
          context = await projectContext(deps);
        } catch (e) {
          return toolContentRefused(e, ctx) ?? rendered(refusal("no-content-root", `This project's planning content could not be resolved (${e?.code ?? "unresolved"}).`));
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
   * The three research tools, each delegating to the implementation that already exists.
   *
   * ⚠️ **THE HANDLERS ARE THE LIBRARY'S, NOT THIS FILE'S.** `createResearchTools` decides what a
   * capability probe means, what a search may return and what the fetch boundary refuses; every one of
   * those is a rule with a decision behind it, and a wrapper that re-derived any of them would be a
   * second answer to a question that already has one. What is added here is a schema and a rendering.
   *
   * ⚠️ **A REFUSAL IS PASSED THROUGH, NOT TRANSLATED.** These tools already return structured data
   * with a reason a machine can switch on - `capability-unavailable` when the backend cannot be used,
   * `request-refused` when this one URL was out of bounds - and the two are kept apart on purpose. A
   * wrapper that folded them into its own `{ok:false, code}` would erase the distinction the library
   * exists to preserve, so the result travels as it was returned.
   *
   * ⚠️ **NO CONTENT ROOT IS RESOLVED.** Research reads the public web, not the project. A wrapper that
   * demanded a project would make a host capability unavailable in a directory that merely lacks
   * planning content.
   */
  for (const { name, label, description, parameters } of RESEARCH_TOOL_TABLE)
    pi?.registerTool?.({
      name,
      label,
      description,
      parameters,
      execute: async (_toolCallId, params) => {
        const tools = deps.researchTools ?? (await defaultResearchTools());
        const handler = tools[name];
        if (typeof handler !== "function")
          return rendered(refusal("unknown-operation", `This host has no ${name} implementation.`));

        try {
          return rendered(await handler(params ?? {}));
        } catch (e) {
          // ⚠️ THE MESSAGE IS SCRUBBED OF THIS MACHINE, and of nothing else: the library's own
          // sanitiser has already taken the credential out of anything it emits.
          return rendered(refusal("refused", scrub(e?.message ?? String(e), "")));
        }
      },
    });

  /**
   * The two validation tools, each delegating to the controller that already exists.
   *
   * ⚠️ **THE CONTROLLER DECIDES; THIS RENDERS.** Whether a job is refused before provisioning, how long
   * it may run, what is observed and whether the workspace is gone are `lib/validation/`'s rules. The
   * result is passed through with one change, which is this boundary's to make: machine paths become
   * `<workspace>` or `<path>` in a copy, and the controller's own record is left untouched.
   *
   * ⚠️ **NO CONTENT ROOT IS RESOLVED.** A validation job runs in a disposable workspace of its own, not
   * in the project, and a host capability must not depend on standing in one.
   */
  for (const { name, label, description, parameters } of VALIDATION_TOOL_TABLE)
    pi?.registerTool?.({
      name,
      label,
      description,
      parameters,
      execute: async (_toolCallId, params) => {
        const tools = deps.validationTools ?? (await defaultValidationTools());
        const handler = tools[name];
        if (typeof handler !== "function")
          return rendered(refusal("unknown-operation", `This host has no ${name} implementation.`));

        try {
          return rendered(await renderValidationResult(await handler(params ?? {})));
        } catch (e) {
          return rendered(await renderValidationResult(refusal("refused", e?.message ?? String(e))));
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
      "Report where this project stands: whether its planning content is ready to hand off, with the artifact " +
      "count and every handoff blocker; the current stage derived from the stage definitions and attestations, " +
      "with that stage's blockers and one recommended next action; the project's name and description; and the " +
      "Stage 1 document. Reads only; changes nothing.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    execute: async (_toolCallId, _params, _signal, _onUpdate, ctx) => {
      let context;
      try {
        context = await projectContext(deps);
      } catch (e) {
        return toolContentRefused(e, ctx) ?? rendered(
          await renderForModel(refusal("no-content-root", `This project's planning content could not be resolved (${e?.code ?? "unresolved"}).`))
        );
      }

      // ⚠️ ONE ROOT PER CALL. Everything below - the handoff gate, the derived state, the identity, the
      // document, path reduction and cleaning - uses the root resolved above, never a second resolution.
      const roots = { contentRoot: context.contentRoot, toolRoot: context.toolRoot };
      const projectStatus = await import("../../lib/project-status.mjs");
      const readProjectStatus = deps.readProjectStatus ?? projectStatus.readProjectStatus;

      let completeness;
      let status;
      try {
        const handoffCompleteness =
          deps.handoffCompleteness ?? (await import("../../lib/handoff/completeness.mjs")).handoffCompleteness;
        completeness = handoffCompleteness(context.ctx, { toolRoot: context.toolRoot });
        status = readProjectStatus(context.ctx, { toolRoot: context.toolRoot });
      } catch (e) {
        // ⚠️ AN AUTHORED CODE AND MESSAGE, NEVER THE ERROR (F101). A loader's message quotes absolute paths and
        // the file it could not parse; cleaning it would still pass on whatever the patterns miss.
        const authored = projectStatus.toProjectStatusRefusal(e);
        return rendered(await renderForModel(refusal(authored.code, authored.message), roots));
      }

      // ⚠️ PATHS ARE REDUCED BEFORE CLEANING (F105): relative to this root, or null.
      const located = (item) => (item && typeof item === "object" ? { ...item, path: relativeTo(context.contentRoot, item.path) } : null);
      const orchestration = status?.orchestration ?? {};
      const document = status?.stageOneDocument ?? {};
      const intake = status?.intake ?? {};

      const result = await renderForModel(
        {
          ok: true,
          ready: completeness.ready === true,
          artifactCount: completeness.artifactCount ?? 0,
          blockers: (completeness.blockers ?? []).map((b) => ({
            reason: b.reason ?? null,
            detail: typeof b.detail === "string" ? scrub(b.detail, context.contentRoot) : null,
            ruleId: b.ruleId ?? null,
          })),
          orchestration: {
            ...orchestration,
            blockers: (orchestration.blockers ?? []).map(located),
            nextAction: located(orchestration.nextAction),
          },
          project: status?.project ?? null,
          stageOneDocument: {
            stageId: document.stageId ?? null,
            path: relativeTo(context.contentRoot, document.path),
            text: document.text ?? null,
          },
          // ⚠️ WHAT THE DOCUMENT RECORDS, BESIDE THE DOCUMENT ITSELF. The operator's own words are kept in
          // their own document exactly as they gave them; what leaves here is cleaned like every other string.
          intake: {
            stageId: intake.stageId ?? null,
            state: intake.state ?? null,
            problem: intake.problem ?? null,
            total: intake.total ?? 0,
            entries: (intake.entries ?? []).map((e) => ({ label: e.label, answer: e.answer, reading: e.reading })),
          },
        },
        roots
      );

      // ⚠️ CAPPED AFTER CLEANING (D19), so the limit is on what the model receives.
      const capped = capUtf8(result.stageOneDocument.text, STAGE_DOCUMENT_MAX_BYTES);
      result.stageOneDocument = { ...result.stageOneDocument, text: capped.text, truncated: capped.truncated };

      // ⚠️ `total` IS THE DOCUMENT'S COUNT, NOT THIS BLOCK'S. `omitted` says how many of the oldest were
      // left out, so a model can tell a short conversation from the tail of a long one.
      const entries = boundIntakeEntries(result.intake.entries);
      result.intake = {
        stageId: result.intake.stageId,
        state: result.intake.state,
        problem: result.intake.problem,
        total: result.intake.total,
        returned: entries.length,
        omitted: Math.max(0, result.intake.total - entries.length),
        entries,
      };
      return rendered(result);
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
    execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
      let context;
      try {
        context = await projectContext(deps);
      } catch (e) {
        return toolContentRefused(e, ctx) ?? rendered(refusal("no-content-root", `This project's planning content could not be resolved (${e?.code ?? "unresolved"}).`));
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
    execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
      let context;
      try {
        context = await projectContext(deps);
      } catch (e) {
        return toolContentRefused(e, ctx) ?? rendered(refusal("no-content-root", `This project's planning content could not be resolved (${e?.code ?? "unresolved"}).`));
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
    execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
      let context;
      try {
        context = await projectContext(deps);
      } catch (e) {
        return toolContentRefused(e, ctx) ?? rendered(refusal("no-content-root", `This project's planning content could not be resolved (${e?.code ?? "unresolved"}).`));
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
    execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
      let context;
      try {
        context = await projectContext(deps);
      } catch (e) {
        return toolContentRefused(e, ctx) ?? rendered(refusal("no-content-root", `This project's planning content could not be resolved (${e?.code ?? "unresolved"}).`));
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

  /**
   * The operator's answer, written into the stage's document (ACC-0113).
   *
   * ⚠️ **THE ONLY WAY A STAGE DOCUMENT IS WRITTEN.** Editing the file directly is what this replaces: a
   * model with a file editor can rewrite a person's words while claiming to record them, and nothing in
   * the document would show it happened.
   *
   * ⚠️ **BOTH FIELDS ARE REQUIRED, because the separation is the point.** Wording with no reading is a
   * transcript, and a reading with no wording is the orchestrator's account of a conversation nobody can
   * check. `verbatim` is stored exactly as supplied; `interpretation` is Kiln's, and is escaped.
   */
  pi?.registerTool?.({
    name: "kiln_write_stage_document",
    label: "Kiln write stage document",
    description:
      "Record one operator answer in a stage's document: their own words exactly as they gave them, and, " +
      "separately, what Kiln took from them. Appends one entry; never rewrites what is already there.",
    parameters: {
      type: "object",
      properties: {
        stage: { type: "string", pattern: "^[0-9]{2}-[a-z0-9-]+$", description: "A stage id, such as 01-intake." },
        verbatim: {
          type: "string",
          description:
            "The operator's answer in their own words, passed through unchanged. Do not correct, summarise, " +
            "translate or reformat it.",
        },
        interpretation: {
          type: "string",
          description: "One line: what Kiln takes this answer to mean. Kiln's words, kept separate from theirs.",
        },
      },
      required: ["stage", "verbatim", "interpretation"],
      additionalProperties: false,
    },
    execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
      let context;
      try {
        context = await projectContext(deps);
      } catch (e) {
        return toolContentRefused(e, ctx) ?? rendered(refusal("no-content-root", `This project's planning content could not be resolved (${e?.code ?? "unresolved"}).`));
      }

      const documents = deps.stageDocuments ?? (await import("../../lib/stage-documents.mjs"));
      try {
        const written = await documents.writeStageDocumentEntry(context.contentRoot, params?.stage, {
          verbatim: params?.verbatim,
          interpretation: params?.interpretation,
        });
        return rendered({
          ok: true,
          stage: written.stageId,
          entry: written.entry,
          path: relativeTo(context.contentRoot, written.path),
        });
      } catch (e) {
        // ⚠️ THE MODULE'S OWN CODE IS THE MODEL'S CODE. Its refusals are already named for what a caller can
        // do about them, and flattening them to `refused` would tell a model nothing it could act on.
        //
        // ⚠️ CLASSIFIED BY CLASS, NOT BY `name`, WHICH IS WRITABLE. Anything else carrying that name would
        // otherwise hand a model one of this module's codes for a failure that is not about the document.
        if (e instanceof documents.StageDocumentRefusal) return rendered(refusal(e.code, scrub(e.message, context.contentRoot)));
        return rendered(refusal(PROJECT_REFUSAL_CODES[e?.name] ?? "refused", scrub(e?.message ?? String(e), context.contentRoot)));
      }
    },
  });
}
