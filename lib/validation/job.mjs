/**
 * 7b, first piece: what a validation job DECLARES, and what the controller refuses before it
 * provisions anything.
 *
 * DEC-0005 lists the declaration: required tier and capabilities · input files or hashes · commands
 * as an ARGUMENT ARRAY, never an interpolated shell string · a capture plan · timeout and output
 * limits · expected outputs · any network, credential or cost requirement.
 *
 * ⚠️ **Refusal happens BEFORE provisioning, and that is the whole design.** #77's authorisation is
 * only a control if it can stop the spend; a ceiling checked after provisioning is a receipt. So this
 * module is deliberately pure — no filesystem, no process, no network — which is what lets it run
 * before anything exists to clean up.
 *
 * ⚠️ **Argument arrays, never shell strings.** `["python", "-c", src]` cannot be re-parsed by a shell;
 * `python -c "${src}"` can, and the difference is an entire class of defect removed at the type level
 * rather than by review (#58's floor, same move). A declaration carrying a string command is refused
 * here rather than sanitised, because sanitising a command means guessing what the caller meant.
 */

/** Why a job was refused. Distinct reasons so a caller can tell "fix the job" from "ask the PM". */
export const JOB_REFUSED = {
  MALFORMED: "job-malformed",
  SHELL_STRING: "shell-string-command",
  TIER_UNAVAILABLE: "tier-unavailable",
  ABOVE_CEILING: "above-approved-ceiling",
  CAPABILITY_UNAVAILABLE: "capability-unavailable",
};

/**
 * The project's approved ceiling. Deliberately explicit rather than inferred: #77 says tier 2 needs
 * PM approval and tier 3 is off unless the scope calls for it, so a controller that decided its own
 * limits would be deciding an authorisation question.
 */
export const DEFAULT_CEILING = {
  maxTier: 1,
  maxTimeoutMs: 120_000,
  maxOutputBytes: 2_000_000,
  network: false,
  credentials: false,
  costUnits: 0,
};

const isArgArray = (c) => Array.isArray(c) && c.length > 0 && c.every((a) => typeof a === "string" && a.length > 0);

function refuse(reason, detail) {
  return { ok: false, reason, detail };
}

/**
 * Check a declaration against a ceiling. Pure: no side effects, nothing provisioned, nothing to undo.
 *
 * @param {object} job
 * @param {object} [ceiling]
 * @returns {{ok: true, job: object} | {ok: false, reason: string, detail: string}}
 */
export function checkJob(job, ceiling = DEFAULT_CEILING) {
  if (!job || typeof job !== "object") return refuse(JOB_REFUSED.MALFORMED, "A job must be an object.");

  const { tier, commands, timeoutMs, maxOutputBytes, capturePlan, expectedOutputs, requires } = job;

  if (!Number.isInteger(tier) || tier < 1 || tier > 3)
    return refuse(JOB_REFUSED.MALFORMED, `\`tier\` must be 1, 2 or 3, got ${JSON.stringify(tier)}.`);

  if (!Array.isArray(commands) || commands.length === 0)
    return refuse(JOB_REFUSED.MALFORMED, "`commands` must be a non-empty array of argument arrays.");

  for (const [i, c] of commands.entries()) {
    if (typeof c === "string")
      return refuse(
        JOB_REFUSED.SHELL_STRING,
        `commands[${i}] is a string. Declare an argument array — ["python", "-c", "..."] — so nothing ` +
          `re-parses it. A string command is refused rather than quoted, because quoting it means ` +
          `guessing where the caller's arguments end.`
      );
    if (!isArgArray(c))
      return refuse(JOB_REFUSED.MALFORMED, `commands[${i}] must be a non-empty array of non-empty strings.`);
  }

  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0)
    return refuse(JOB_REFUSED.MALFORMED, "`timeoutMs` must be a positive integer — a run with no timeout has no stopping condition.");

  if (!Number.isInteger(maxOutputBytes) || maxOutputBytes <= 0)
    return refuse(JOB_REFUSED.MALFORMED, "`maxOutputBytes` must be a positive integer.");

  if (!capturePlan || typeof capturePlan !== "object")
    return refuse(
      JOB_REFUSED.MALFORMED,
      "`capturePlan` is required. It is what makes an omission DETECTABLE (#122): without a declared " +
        "plan, a fact that was never collected is indistinguishable from a fact that was absent."
    );

  if (!Array.isArray(expectedOutputs))
    return refuse(JOB_REFUSED.MALFORMED, "`expectedOutputs` must be an array (possibly empty, but declared).");

  // ---- the ceiling. Everything above this line is shape; everything below is authorisation. ----

  if (tier > ceiling.maxTier)
    return refuse(
      JOB_REFUSED.ABOVE_CEILING,
      `Job requires tier ${tier}; this project's approved ceiling is tier ${ceiling.maxTier} (#77). ` +
        `Raising it is the PM's decision, not the controller's.`
    );

  if (timeoutMs > ceiling.maxTimeoutMs)
    return refuse(JOB_REFUSED.ABOVE_CEILING, `timeoutMs ${timeoutMs} exceeds the ceiling ${ceiling.maxTimeoutMs}.`);

  if (maxOutputBytes > ceiling.maxOutputBytes)
    return refuse(JOB_REFUSED.ABOVE_CEILING, `maxOutputBytes ${maxOutputBytes} exceeds the ceiling ${ceiling.maxOutputBytes}.`);

  const needs = requires ?? {};
  if (needs.network && !ceiling.network)
    return refuse(JOB_REFUSED.ABOVE_CEILING, "Job requires network; the approved ceiling does not permit it.");
  if (needs.credentials && !ceiling.credentials)
    return refuse(JOB_REFUSED.ABOVE_CEILING, "Job requires credentials; the approved ceiling does not permit them.");
  if ((needs.costUnits ?? 0) > (ceiling.costUnits ?? 0))
    return refuse(
      JOB_REFUSED.ABOVE_CEILING,
      `Job declares a cost of ${needs.costUnits}; the approved ceiling is ${ceiling.costUnits ?? 0} (REQ-0012).`
    );

  return { ok: true, job };
}

/**
 * What tier 1 does NOT claim (DEC-0005), as data rather than as a paragraph.
 *
 * ⚠️ It is data because it has to reach the evidence record. A boundary stated only in a comment is a
 * boundary readers of the evidence never see, and the whole point is that a claim validated in tier 1
 * must not inherit containment it never had.
 */
export const TIER_1_BOUNDARY = {
  tier: 1,
  isolates: ["python-dependencies"],
  doesNotClaim: ["containment-of-hostile-code", "host-filesystem-denial", "network-isolation"],
  supplies: { credentials: false, processEnvironment: "allowlisted" },
  suitableFor: "trusted, non-destructive validation that does not require containment, OS fidelity, credentials or external infrastructure",
  statement: "A virtual environment isolates Python dependencies; it is not an OS security sandbox.",
};
