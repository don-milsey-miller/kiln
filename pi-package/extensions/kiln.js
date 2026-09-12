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
  return {
    ctx: {
      contentRoot,
      schemas: loadSchemaSet(schemasDir),
      validators: createValidators(schemasDir),
      activated: readActivatedTypes(contentRoot),
    },
    contentRoot,
    toolRoot: tool,
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
}
