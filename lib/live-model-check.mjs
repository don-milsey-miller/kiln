/**
 * Setup's live model check: reuse a matching record, or approve, run and record the bounded canary — TSK-0042,
 * CMP-0030, against ACC-0060 and ACC-0062.
 *
 * ⚠️ **THE KEY IS COMPUTED FROM WHAT PI RESOLVED, THEN COMPARED.** The caller hands over the zero-cost
 * preflight's result — the selection, the model as Pi resolved it, the provider's display name and the pinned Pi
 * version — and the eight determinants are computed from those. A stored record is reused only when every
 * determinant matches, so a change of provider, model, thinking level, Pi version, API type, endpoint, request
 * profile or canary protocol reopens approval.
 *
 * ⚠️ **A SEPARATE APPROVAL THAT NAMES THE COST, AND DECLINING IS A CHOICE.** The prompt names the provider and the
 * exact model and says the provider may charge. A no, or `--live-model-check deny`, is reported as the operator's
 * choice: content and browser setup stand, the agent is not described as ready, and intake does not begin. A run
 * that cannot ask and was given neither flag refuses, rather than spending or skipping on its own.
 *
 * ⚠️ **ONLY A PASS THAT PROVES THIS KEY IS RECORDED (R8, R9).** The canary child reports the key fields it
 * resolved and where its request went. A pass whose request differs from this key's — another resolved model, or
 * an endpoint outside this key's — is a failure here, and nothing is recorded. A failed canary writes nothing.
 *
 * ⚠️ **NO KEY, NO CHECK.** When no key can be computed — a configuration needing a declared identity nobody gave,
 * or an effective endpoint that cannot be established without the network — no canary could prove it, so none is
 * sent and setup is reported not ready, with the reason.
 *
 * ⚠️ **A PASS THAT CANNOT BE RECORDED IS NOT READINESS (D21).** If the record cannot be written where a clone could
 * not carry it, the pass proves this run only: setup is reported as awaiting a per-run check, not ready, so a later
 * launch cannot inherit it.
 */

import { CompatibilityKeyRefusal, KEY_REFUSAL, computeCompatibilityKey, differingFields, proofProblem, readCompatibility, recordCompatibility } from "./compatibility-record.mjs";
import { liveCheckPrompt } from "./live-canary.mjs";
import { CanaryRefusal } from "./pi-provider-canary.mjs";

export const LIVE_CHECK_OUTCOME = Object.freeze({
  REUSED: "reused",
  PASSED: "passed",
  PASSED_NOT_RECORDED: "passed-not-recorded",
  UNCACHEABLE: "uncacheable",
  DECLINED: "declined",
  FAILED: "failed",
});

export const LIVE_CHECK_REFUSAL = Object.freeze({ NEEDS_APPROVAL: "live-check-needs-approval" });

export class LiveCheckRefusal extends Error {
  constructor(reason, message, detail = {}) {
    super(message);
    this.name = "LiveCheckRefusal";
    this.reason = reason;
    this.detail = detail;
  }
}

const named = (s) => `${s.provider} ${s.model}`;

const DECLINED_MESSAGE =
  "The live model check was not run, by your choice. Content and browser setup are complete; the agent is not " +
  "marked ready and intake has not begun. Run setup again, or pass --live-model-check approve, to run the check.";

/**
 * @param {object} opts
 * @param {object} opts.preflight   `zeroCostPreflight`'s result: `selection`, `model`, `displayName`, `piVersion`,
 *        and `effectiveBaseUrl` or `endpointUnestablished`
 * @param {object} opts.location    from `compatibilityLocation`
 * @param {(prompt: string) => unknown} [opts.ask]
 * @param {"approve"|"deny"} [opts.request]  the explicit `--live-model-check` answer, if one was given
 * @param {(ctx: {selection: object, declared: object}) => Promise<object>} opts.canary  `runLiveCanary`'s result shape
 * @param {{endpointIdentity?: object, requestIdentity?: string}} [opts.declared]
 * @param {() => Date} [opts.now]
 */
export async function runLiveModelCheck({ preflight, location, ask, request, canary, declared = {}, now = () => new Date(), validators }) {
  const { selection } = preflight;
  if (typeof canary !== "function") throw new TypeError("runLiveModelCheck needs the canary runner");

  let key = null;
  let uncacheable = preflight.endpointUnestablished ? KEY_REFUSAL.EFFECTIVE_ENDPOINT : null;
  if (!uncacheable)
    try {
      key = computeCompatibilityKey({ selection, model: preflight.model, piVersion: preflight.piVersion, declared, effectiveBaseUrl: preflight.effectiveBaseUrl });
    } catch (e) {
      if (!(e instanceof CompatibilityKeyRefusal)) throw e;
      uncacheable = e.reason;
    }
  // ⚠️ NOTHING CAN BE PROVED WITHOUT A KEY, so nothing is sent or charged.
  if (!key)
    return {
      outcome: LIVE_CHECK_OUTCOME.UNCACHEABLE,
      ready: false,
      reason: uncacheable,
      message:
        uncacheable === KEY_REFUSAL.EFFECTIVE_ENDPOINT
          ? `Kiln cannot establish, without contacting anything, which endpoint ${named(selection)} will be sent to, so no live check could prove it. The agent is not marked ready.`
          : `${named(selection)}'s configuration cannot be identified for a compatibility check (${uncacheable}). Declare a non-secret identity for it and run setup again. The agent is not marked ready.`,
      selection,
    };

  // ⚠️ REUSE ONLY A TRUSTED RECORD, AND ONLY UNDER EVERY DETERMINANT. Nothing is asked, sent or charged.
  let stale = null;
  const found = readCompatibility(location, { validators });
  if (found.state === "valid") {
    const fields = differingFields(found.record.key, key);
    if (fields.length === 0) return { outcome: LIVE_CHECK_OUTCOME.REUSED, ready: true, recorded: true, selection };
    stale = fields;
  }

  if (request === "deny") return { outcome: LIVE_CHECK_OUTCOME.DECLINED, ready: false, message: DECLINED_MESSAGE, selection };
  if (request !== "approve") {
    if (typeof ask !== "function")
      throw new LiveCheckRefusal(
        LIVE_CHECK_REFUSAL.NEEDS_APPROVAL,
        `No matching compatibility record exists for ${named(selection)}, and this run cannot ask. Pass --live-model-check ` +
          "approve to send the one diagnostic request, which the provider may charge for, or --live-model-check deny to leave setup partial.",
        { provider: selection.provider, model: selection.model, ...(stale ? { stale } : {}) }
      );
    const answer = await ask(liveCheckPrompt({ displayName: preflight.displayName, model: selection.model }));
    if (answer !== true) return { outcome: LIVE_CHECK_OUTCOME.DECLINED, ready: false, message: DECLINED_MESSAGE, selection };
  }

  let result;
  try {
    result = await canary({ selection, declared });
  } catch (e) {
    if (!(e instanceof CanaryRefusal)) throw e;
    return {
      outcome: LIVE_CHECK_OUTCOME.FAILED,
      ready: false,
      reason: e.reason,
      message: `The live model check for ${named(selection)} did not pass (${e.reason}). Nothing was recorded, and the agent is not marked ready.`,
      selection,
    };
  }
  if (result?.passed !== true)
    return { outcome: LIVE_CHECK_OUTCOME.FAILED, ready: false, reason: "not-passed", message: `The live model check for ${named(selection)} did not pass.`, selection };

  // ⚠️ R8, R9: the pass must be a pass for THIS key's request.
  const problem = proofProblem(key, result);
  if (problem)
    return {
      outcome: LIVE_CHECK_OUTCOME.FAILED,
      ready: false,
      reason: problem.reason,
      ...(problem.fields ? { fields: problem.fields } : {}),
      message: `The live model check for ${named(selection)} ran against a different request than this selection makes (${problem.reason}). Nothing was recorded, and the agent is not marked ready.`,
      selection,
    };
  const written = await recordCompatibility(
    location,
    { key, result: { outcome: "passed", observedAt: now().toISOString(), challengeEchoed: result.challengeEchoed === true } },
    { validators }
  );
  return written.written
    ? { outcome: LIVE_CHECK_OUTCOME.PASSED, ready: true, recorded: true, selection }
    : {
        outcome: LIVE_CHECK_OUTCOME.PASSED_NOT_RECORDED,
        ready: false,
        recorded: false,
        awaiting: "per-run-check",
        reason: written.reason,
        message: `The live model check for ${named(selection)} passed, but its result could not be recorded safely (${written.reason}), so it proves this run only. Each launch will need its own live model check.`,
        selection,
      };
}
