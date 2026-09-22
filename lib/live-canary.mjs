/**
 * The bounded live tool-call canary — TSK-0041, CMP-0030, against ACC-0061 and ACC-0062.
 *
 * ⚠️ **ONE REQUEST, ONE TOOL, ONE ANSWER THAT COUNTS.** A fresh random challenge is made here, the child sends
 * the one canary request through the real pinned Pi runtime and the selected provider, and the run passes only
 * when exactly one call to `kiln_preflight` arrives whose arguments are exactly `{challenge}` with this run's
 * value. A reply in prose, a call with a malformed or extra argument, a call to another name, a second call, or
 * a wrong challenge each fail under their own reason. Nothing the model says about itself is read.
 *
 * ⚠️ **THE SESSION IS PROVED BOUNDED, NOT ASSUMED.** The child reports the tool registry and active set Pi
 * actually built. Anything other than exactly `kiln_preflight` in both fails the run, so a change that let a
 * built-in, extension or Kiln tool into the canary session could not pass unnoticed.
 *
 * ⚠️ **SUCCESS IS RETURNED, NOT RECORDED.** Storing a passed canary against its key, and comparing that key at
 * launch, is TSK-0042's. This module writes nothing outside its disposable root, and the challenge value is
 * not returned: it is single-use, and keeping it would make a liveness proof replayable.
 *
 * ⚠️ **ISOLATION IS THE PROVIDER CANARY'S.** `runCanaryChild` gives the child a private root, the one selected
 * stored credential or a `$NAME` reference, a scoped environment and an empty working directory, and confirms
 * the root is removed. Nothing about that is restated here.
 */

import { randomBytes as nodeRandomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { CanaryRefusal, runCanaryChild } from "./pi-provider-canary.mjs";
import { THINKING_LEVELS } from "./pi-settings.mjs";
import { CANARY_MAX_TOKENS, PREFLIGHT_TOOL_NAME, isExactChallengeCall } from "./preflight-tool.mjs";

export const LIVE_CANARY_CHILD_PATH = join(dirname(fileURLToPath(import.meta.url)), "live-canary-child.mjs");

export const LIVE_CANARY_REFUSAL = Object.freeze({
  INVALID_REQUEST: "live-canary-invalid-request",
  MODEL_NOT_FOUND: "live-canary-model-not-found",
  TOOL_SET_NOT_BOUNDED: "live-canary-tool-set-not-bounded",
  NO_TOOL_CALL: "live-canary-no-tool-call",
  WRONG_TOOL: "live-canary-wrong-tool",
  MALFORMED_CALL: "live-canary-malformed-call",
  TOO_MANY_CALLS: "live-canary-too-many-calls",
  OUTPUT_INVALID: "live-canary-output-invalid",
});

const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isNameList = (v) => Array.isArray(v) && v.every((n) => typeof n === "string");

/** The child's report, checked as a closed shape before any of it is believed. */
function readLiveReport(raw, provider, model) {
  const invalid = () =>
    new CanaryRefusal(LIVE_CANARY_REFUSAL.OUTPUT_INVALID, `The live canary child for ${provider}/${model} did not return its report shape.`, {
      provider,
      model,
    });
  let report;
  try {
    report = JSON.parse(raw);
  } catch {
    throw invalid();
  }
  if (!isPlainObject(report) || Object.keys(report).sort().join(",") !== "activeTools,calls,ceiling,model,registeredTools") throw invalid();
  if (report.model !== "found" && report.model !== "not-found") throw invalid();
  if (!isNameList(report.registeredTools) || !isNameList(report.activeTools) || !Array.isArray(report.calls)) throw invalid();
  for (const c of report.calls) {
    if (!isPlainObject(c) || !(c.name === null || typeof c.name === "string")) throw invalid();
    const keys = Object.keys(c).sort().join(",");
    if (keys !== "args,name" && keys !== "name,oversized") throw invalid();
  }
  return report;
}

/**
 * Judge a report against this run's challenge. Pure, and exported so each failure shape is tested against the
 * same function the canary uses.
 */
export function judgeLiveReport(report, challenge, { provider, model, thinkingLevel }) {
  const ids = { provider, model, thinkingLevel };
  if (report.model !== "found")
    throw new CanaryRefusal(LIVE_CANARY_REFUSAL.MODEL_NOT_FOUND, `${provider}/${model} is not in Pi's registry, so no canary request was sent.`, ids);

  const only = (names) => names.length === 1 && names[0] === PREFLIGHT_TOOL_NAME;
  if (!only(report.registeredTools) || !only(report.activeTools))
    throw new CanaryRefusal(
      LIVE_CANARY_REFUSAL.TOOL_SET_NOT_BOUNDED,
      `The canary session for ${provider}/${model} held tools other than ${PREFLIGHT_TOOL_NAME}, so its result proves nothing and is not accepted.`,
      { ...ids, registeredTools: report.registeredTools, activeTools: report.activeTools }
    );

  const calls = report.calls;
  if (calls.length === 0)
    throw new CanaryRefusal(
      LIVE_CANARY_REFUSAL.NO_TOOL_CALL,
      `${provider}/${model} answered without calling ${PREFLIGHT_TOOL_NAME}. A reply claiming tool support is not a tool call.`,
      ids
    );
  if (calls.length > 1)
    throw new CanaryRefusal(LIVE_CANARY_REFUSAL.TOO_MANY_CALLS, `${provider}/${model} made ${calls.length} tool calls where exactly one was asked for.`, {
      ...ids,
      calls: calls.length,
    });
  const [call] = calls;
  if (call.name !== PREFLIGHT_TOOL_NAME)
    throw new CanaryRefusal(LIVE_CANARY_REFUSAL.WRONG_TOOL, `${provider}/${model} called a tool other than ${PREFLIGHT_TOOL_NAME}.`, ids);
  // ⚠️ THE ARGUMENTS ARE JUDGED, NEVER REPEATED. A malformed call's content is the model's, and nothing here
  // needs to show it.
  if (call.oversized || !isExactChallengeCall(call, challenge))
    throw new CanaryRefusal(
      LIVE_CANARY_REFUSAL.MALFORMED_CALL,
      `${provider}/${model} called ${PREFLIGHT_TOOL_NAME} with arguments that are not exactly this run's challenge.`,
      ids
    );

  return Object.freeze({ provider, model, thinkingLevel, passed: true, challengeEchoed: true, ceiling: report.ceiling });
}

/**
 * Send the one bounded canary request and judge what the provider returned.
 *
 * @param {object} request  as `runProviderCanary`, plus `thinkingLevel` and optionally `randomBytes`
 * @returns {Promise<{provider: string, model: string, thinkingLevel: string, passed: true, challengeEchoed: true, ceiling: number}>}
 */
export async function runLiveCanary(request = {}) {
  const { thinkingLevel, randomBytes = nodeRandomBytes } = request;
  if (!THINKING_LEVELS.includes(thinkingLevel))
    throw new CanaryRefusal(LIVE_CANARY_REFUSAL.INVALID_REQUEST, "A live canary needs the selected thinking level.", {
      provider: request.provider ?? null,
      model: request.model ?? null,
    });
  // ⚠️ FRESH EVERY RUN, AND NEVER RETURNED OR STORED.
  const challenge = randomBytes(16).toString("hex");

  return runCanaryChild(request, {
    childPath: LIVE_CANARY_CHILD_PATH,
    workDir: true,
    childArgs: ({ sdk, provider, model, workDir }) => [LIVE_CANARY_CHILD_PATH, sdk.url, provider, model, thinkingLevel, challenge, workDir],
    readReport: readLiveReport,
    finish: ({ report, provider, model }) => judgeLiveReport(report, challenge, { provider, model, thinkingLevel }),
  });
}

export { CANARY_MAX_TOKENS };
