/**
 * Which content root the orchestrator may open - TSK-0048 (G3b), toward ACC-0071 (F96, D13, D20).
 *
 * ⚠️ **THE LAUNCHER'S REFUSAL DOES NOT REACH THE ORCHESTRATOR ON ITS OWN.** `resolveSelfHost` refuses to run in
 * the tool checkout, but the orchestrator's handlers run inside Pi, which re-resolves the content root from an
 * inherited `PLANNING_CONTENT_DIR` - and `resolveContentRoot` accepts any override, the tool's own
 * `planning-content/` included, because its inside-the-tool-root backstop runs only without one. Pi started
 * without the launcher never meets the launcher's refusal at all. So the orchestrator refuses too.
 *
 * ⚠️ **ONLY FOR THE ORCHESTRATOR.** This repository's own commands point `PLANNING_CONTENT_DIR` at the tool's
 * content on purpose (F106). The shared resolver is left as it is; this guard runs where the orchestrator opens
 * a project, and nowhere else.
 *
 * ⚠️ **PERMISSION IS A MARKER THE LAUNCHER WRITES AFTER VALIDATING, AND NOTHING ELSE.** The supervisor removes
 * every inherited spelling of `KILN_SELF_HOST` from both children and adds `validated-v1` to the agent alone,
 * only when `resolveSelfHost` returned `selfHost: true`. Here the value must be exactly that: absent, empty,
 * `true`, `1`, another version, other case or surrounding whitespace all refuse. A marker beside a content root
 * outside the tool root grants nothing, because there is nothing to grant.
 *
 * ⚠️ **A LOCAL SAFETY INTERLOCK, NOT AUTHENTICATION (F112).** Inside the Pi process this guard cannot tell a
 * marker the supervisor wrote from one the process inherited. Supervised runs remove every inherited spelling,
 * so the launcher path never grants self-hosting by accident. A user who starts Pi directly and deliberately
 * supplies the exact `validated-v1` is making the equivalent of an explicit self-host opt-in, and is permitted.
 * The marker stops an accidental or stale override from authoring into the tool's plan; it does not defend
 * against someone who controls the process. A per-run attestation that could tell the two apart is outside
 * TSK-0048, and no token or state file is kept for one.
 */

import { canonicalPath, isAtOrInside } from "./content-root.mjs";

export const SELF_HOST_MARKER = "KILN_SELF_HOST";
export const SELF_HOST_VALIDATED = "validated-v1";
export const TOOL_CONTENT_REFUSED = "tool-content-refused";

/** The operator-facing refusal. Its message names both canonical absolute paths; a model never receives it. */
export class ToolContentRefusal extends Error {
  constructor(contentRoot, toolRoot) {
    super(
      `Refusing to open the tool's own planning content.\n` +
        `  content root: ${contentRoot}\n` +
        `  tool root:    ${toolRoot}\n` +
        `The content root is the tool root or inside it, and this run was not started as a validated self-hosting ` +
        `run. Point PLANNING_CONTENT_DIR at your project's planning-content directory, or start the tool checkout ` +
        `through the launcher with --self-host.`
    );
    this.name = "ToolContentRefusal";
    this.code = TOOL_CONTENT_REFUSED;
    this.contentRoot = contentRoot;
    this.toolRoot = toolRoot;
  }
}

/**
 * Refuse a content root that is the tool root or lies inside it, unless the validated marker is present.
 *
 * ⚠️ **BOTH ROOTS ARE CANONICALISED FIRST,** so a sibling that is a symlink or junction into the tool root is
 * judged by where it leads, and Windows compares without case.
 *
 * @param {{contentRoot: string, toolRoot: string, env?: Record<string, string|undefined>}} options
 * @returns {{contentRoot: string, toolRoot: string, selfHost: boolean}}
 */
export function assertOrchestratorContentRoot({ contentRoot, toolRoot, env = process.env }) {
  const content = canonicalPath(contentRoot);
  const tool = canonicalPath(toolRoot);
  if (!isAtOrInside(content, tool)) return { contentRoot: content, toolRoot: tool, selfHost: false };
  if (env?.[SELF_HOST_MARKER] === SELF_HOST_VALIDATED) return { contentRoot: content, toolRoot: tool, selfHost: true };
  throw new ToolContentRefusal(content, tool);
}

/**
 * A copy of `env` with every spelling of the marker removed.
 *
 * ⚠️ **ON WINDOWS, NAMES ARE ONE VARIABLE WHATEVER THEIR CASE,** so `kiln_self_host` is the marker there and is
 * removed with it. Elsewhere names are case-sensitive, and only the exact name is the marker.
 *
 * @param {Record<string, string|undefined>} env
 * @param {string} [platform]
 */
export function withoutSelfHostMarker(env, platform = process.platform) {
  const out = {};
  for (const [key, value] of Object.entries(env ?? {})) {
    const isMarker = platform === "win32" ? key.toUpperCase() === SELF_HOST_MARKER : key === SELF_HOST_MARKER;
    if (!isMarker) out[key] = value;
  }
  return out;
}
