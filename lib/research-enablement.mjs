/**
 * Tavily consent, probe and plain-English outcomes — TSK-0035, CMP-0027, against ACC-0054.
 *
 * ⚠️ **A SEPARATE APPROVAL, AFTER INSPECTION, BEFORE ANY USE OF THE KEY.** Inspection only reports whether
 * `TAVILY_API_KEY` is present. Validating it with `GET /usage` is a request made with this host's
 * credential, so it waits for its own answer, or for the explicit `--research tavily` request. Nothing
 * here reads the key before that point; the adapter reads it when the probe runs.
 *
 * ⚠️ **TWO RECORDS, TWO SCOPES.** The project's choice (`tavily` or `none`) is committed in
 * `.pi/kiln.json` and reaches every clone. This host's approval is in the ignored consent record and
 * reaches no one. A committed `tavily` therefore still asks on a host with no local approval.
 *
 * ⚠️ **THE CHOICE WRITER CLEARS THE GRANT BEFORE IT WRITES THE CHOICE.** Written the other way round, a
 * crash between the two would leave `none` committed beside a live `tavily` grant, and changing back to
 * `tavily` later would revive it without a prompt. Cleared first, a crash leaves the old choice and no
 * grant, which only asks again.
 *
 * ⚠️ **DISABLING ALWAYS SUCCEEDS, AND ENABLING PAYS FOR IT.** When the grant cannot be cleared, because Git
 * cannot verify the record or the record is tracked, a write to `none` still goes ahead: switching
 * research off must never depend on Git. What it leaves behind is a grant nobody can remove yet, so every
 * write back to `tavily` requires a successful clear first and is refused without one.
 *
 * ⚠️ **NOTHING IS PERSISTED UNLESS THE PROBE SAYS AVAILABLE.** "Tavily did not accept the existing
 * connection. No changes were made." is only true if an approval followed by a failed probe leaves both
 * records as they were. A decline is persisted, because it is a decision.
 *
 * ⚠️ **DECLINING NEVER BLOCKS PLANNING.** Every path returns an outcome. None throws for a decline, a
 * missing key or a failed probe.
 */

import { GRANT, NOT_REMEMBERED, STANDING, clearGrants, committedResearchChoice, peekGrant, recordGrant } from "./consent-record.mjs";
import { PROJECT_RECORD, PROJECT_RECORD_KEY } from "./local-state.mjs";
import { UNAVAILABLE } from "./research/refusal.mjs";
import { runWithTransaction } from "./setup-transaction.mjs";

/** The six user-facing research states (technical proposal §6.5). */
export const RESEARCH_OUTCOME = Object.freeze({
  AVAILABLE: "available",
  NO_CREDENTIAL: "no-credential",
  AUTHENTICATION_FAILED: "authentication-failed",
  QUOTA_EXHAUSTED: "quota-exhausted",
  BACKEND_UNREACHABLE: "backend-unreachable",
  USER_DISABLED: "user-disabled",
});

/** The separate approval, worded as §6.5 requires. */
export const RESEARCH_PROMPT = [
  "Optional web research",
  "",
  "Kiln can use Tavily to search public websites while researching your project. An existing Tavily",
  "connection was found on this computer.",
  "",
  "The key will not be copied into this project or shown to the AI. Would you like Kiln to check the",
  "connection and enable web research for this project?",
  "",
  "Checking the connection does not perform a search or use search credits. Future searches may count",
  "against your Tavily plan.",
].join("\n");

/**
 * The plain-English sentence for an outcome.
 *
 * @param {string} outcome
 * @param {{quota?: {remaining?: number|null, limit?: number|null}}} [detail]
 */
export function researchMessage(outcome, { quota } = {}) {
  switch (outcome) {
    case RESEARCH_OUTCOME.AVAILABLE: {
      const { remaining, limit } = quota ?? {};
      // ⚠️ ONLY WHEN TAVILY REPORTED THEM. An unknown count is left out, not written as zero.
      const credits = Number.isFinite(remaining)
        ? ` ${remaining}${Number.isFinite(limit) ? ` of ${limit}` : ""} search credits remain.`
        : "";
      return `Web research is ready.${credits}`;
    }
    case RESEARCH_OUTCOME.NO_CREDENTIAL:
      return (
        "No Tavily connection was found. Kiln can continue without it, but it will not be able to search " +
        "the web. You can connect Tavily now or enable it later."
      );
    case RESEARCH_OUTCOME.AUTHENTICATION_FAILED:
      return "Tavily did not accept the existing connection. No changes were made.";
    case RESEARCH_OUTCOME.QUOTA_EXHAUSTED:
      return "The connection works, but the Tavily account has no search credits remaining.";
    case RESEARCH_OUTCOME.BACKEND_UNREACHABLE:
      return "Kiln could not reach Tavily. You can retry later.";
    case RESEARCH_OUTCOME.USER_DISABLED:
      return "Web research remains disabled for this project.";
    default:
      throw new TypeError(`${JSON.stringify(outcome)} is not a research outcome`);
  }
}

/** The adapter's unavailable reasons, in the user-facing vocabulary. */
const FROM_PROBE = Object.freeze({
  [UNAVAILABLE.NO_CREDENTIAL]: RESEARCH_OUTCOME.NO_CREDENTIAL,
  [UNAVAILABLE.AUTH_FAILED]: RESEARCH_OUTCOME.AUTHENTICATION_FAILED,
  [UNAVAILABLE.QUOTA_EXHAUSTED]: RESEARCH_OUTCOME.QUOTA_EXHAUSTED,
  [UNAVAILABLE.BACKEND_UNREACHABLE]: RESEARCH_OUTCOME.BACKEND_UNREACHABLE,
});

/** A probe result as an outcome. Anything the adapter did not name is treated as unreachable. */
export function outcomeFromProbe(result) {
  if (result?.ok === true) return RESEARCH_OUTCOME.AVAILABLE;
  return FROM_PROBE[result?.reason] ?? RESEARCH_OUTCOME.BACKEND_UNREACHABLE;
}

export class ResearchChoiceRefusal extends Error {
  constructor(reason, message, detail = {}) {
    super(message);
    this.name = "ResearchChoiceRefusal";
    this.reason = reason;
    this.detail = detail;
  }
}

/**
 * Write the project's research choice to `.pi/kiln.json`, clearing this host's research grant first when
 * the choice changes.
 *
 * ⚠️ **THROUGH THE SETUP TRANSACTION.** The record is committed and holds the project's identity, so it
 * is written the way `ensureProjectId` writes it: planned, re-read under the lock, and refused if it
 * moved. The transaction must have planned `projectRecordTarget()`.
 *
 * @param {{transaction: object, location: object, provider: "tavily"|"none", validators?: object}} opts
 * @returns {Promise<{changed: boolean, from: string|null, to: string, cleared: string[], uncleared?: string}>}
 */
export async function writeResearchChoice({ transaction, location, provider, validators }) {
  if (provider !== "tavily" && provider !== "none") throw new TypeError(`A research choice is "tavily" or "none", got ${JSON.stringify(provider)}`);

  return runWithTransaction(transaction, "writeResearchChoice", async () => {
    const from = committedResearchChoice(location.projectRoot, { validators });
    if (from === provider) return { changed: false, from, to: provider, cleared: [] };

    const clear = await clearGrants(location, [GRANT.RESEARCH], { validators });
    const clearedOrNothingToClear = clear.written || clear.reason === "unchanged" || clear.reason === "no-runtime-dir";
    if (!clearedOrNothingToClear && provider === "tavily")
      throw new ResearchChoiceRefusal(
        clear.reason,
        `The research choice was not changed. Kiln must first clear this computer's earlier research ` +
          `approval, and could not: ${NOT_REMEMBERED[clear.reason] ?? clear.reason} Changing the choice ` +
          `without clearing it could let that approval come back unasked.`,
        { reason: clear.reason }
      );
    const cleared = clear.written ? [GRANT.RESEARCH] : [];
    const uncleared = clearedOrNothingToClear ? null : clear.reason;

    let changed = false;
    await transaction.merge(PROJECT_RECORD_KEY, (current) => {
      if (current === null)
        throw new ResearchChoiceRefusal("no-project-record", `${PROJECT_RECORD} does not exist. Setup writes it first.`);
      const record = JSON.parse(current);
      if (record.research?.provider === provider) return null;
      changed = true;
      return JSON.stringify({ ...record, research: { provider } }, null, 2) + "\n";
    });
    return { changed, from, to: provider, cleared, ...(uncleared ? { uncleared } : {}) };
  });
}

/** How research is turned on later, shown with every disabled outcome (D3). */
export const ENABLE_LATER = "To enable web research later, run setup again with --research tavily.";

const outcome = (name, extra = {}) => ({
  outcome: name,
  message: researchMessage(name, extra),
  ...(name === RESEARCH_OUTCOME.USER_DISABLED ? { hint: ENABLE_LATER } : {}),
  ...extra,
});

/**
 * The research step of setup.
 *
 * @param {object} opts
 * @param {object} opts.transaction  a live setup transaction that planned `projectRecordTarget()`
 * @param {object} opts.location     from `consentLocation`
 * @param {"present"|"absent"|"not-inspected"} opts.presence  the inspection's research-credential result
 * @param {(prompt: string) => unknown} [opts.ask]
 * @param {"tavily"|"disabled"} [opts.request]  the explicit `--research` choice, if one was given
 * @param {{probe: () => Promise<object>}} opts.adapter  the Tavily adapter
 * @param {() => Date} [opts.now]
 */
export async function setUpResearch({ transaction, location, presence, ask, request, adapter, now, validators }) {
  const opts = { validators };

  if (request === "disabled") {
    const written = await writeResearchChoice({ transaction, location, provider: "none", validators });
    return { ...outcome(RESEARCH_OUTCOME.USER_DISABLED), asked: false, probed: false, choice: written };
  }

  // ⚠️ DECIDED WITHOUT CHANGING ANYTHING. A grant for a choice the project no longer holds stands as
  // `ask`, so it needs fresh approval, but it is removed only once a probe succeeds, by the writer.
  // Removing it here would make "No changes were made" untrue for a probe that then fails.
  const current = committedResearchChoice(location.projectRoot, { validators });
  const { standing } = peekGrant(location, GRANT.RESEARCH, { research: current }, opts);

  // ⚠️ UNKNOWN IS NOT ABSENT, AND IT IS NOT A REASON TO LOOK. With inspection declined nothing was
  // checked, so nothing is asked and research stays off.
  if (presence === "not-inspected")
    return { ...outcome(RESEARCH_OUTCOME.USER_DISABLED), asked: false, probed: false, because: "inspection-declined" };
  if (presence === "absent") return { ...outcome(RESEARCH_OUTCOME.NO_CREDENTIAL), asked: false, probed: false };
  if (presence !== "present") throw new TypeError(`presence is "present", "absent" or "not-inspected", got ${JSON.stringify(presence)}`);

  let approved;
  let asked = false;
  if (request === "tavily") approved = true;
  else if (current === "none") return { ...outcome(RESEARCH_OUTCOME.USER_DISABLED), asked: false, probed: false };
  else if (standing === STANDING.GRANTED) approved = true;
  else if (standing === STANDING.DECLINED) return { ...outcome(RESEARCH_OUTCOME.USER_DISABLED), asked: false, probed: false };
  else {
    if (typeof ask !== "function") throw new TypeError("setUpResearch needs an `ask` function when no --research choice was given");
    asked = true;
    approved = await ask(RESEARCH_PROMPT);
  }

  // ⚠️ ONLY AN EXPLICIT BOOLEAN IS A DECISION. Anything else leaves research off and records nothing.
  if (typeof approved !== "boolean") return { ...outcome(RESEARCH_OUTCOME.USER_DISABLED), asked, probed: false };

  if (approved === false) {
    // A project with no choice yet takes `none`. A committed `tavily` is another operator's choice, so
    // only this host's decline is recorded.
    if (current === null) {
      const written = await writeResearchChoice({ transaction, location, provider: "none", validators });
      return { ...outcome(RESEARCH_OUTCOME.USER_DISABLED), asked, probed: false, choice: written };
    }
    const consent = await recordGrant(location, { grant: GRANT.RESEARCH, granted: false, choice: { research: "tavily" }, now }, opts);
    return { ...outcome(RESEARCH_OUTCOME.USER_DISABLED), asked, probed: false, consent };
  }

  // ⚠️ THE FIRST USE OF THE KEY, AND IT COMES AFTER THE ANSWER.
  const probe = await adapter.probe();
  const name = outcomeFromProbe(probe);
  const quota = probe?.quota;
  if (name !== RESEARCH_OUTCOME.AVAILABLE)
    return { ...outcome(name, quota ? { quota } : {}), asked, probed: true, reason: probe?.reason ?? null };

  const choice = await writeResearchChoice({ transaction, location, provider: "tavily", validators });
  const consent =
    standing === STANDING.GRANTED && !choice.changed
      ? { written: false, reason: "unchanged" }
      : await recordGrant(location, { grant: GRANT.RESEARCH, granted: true, choice: { research: "tavily" }, now }, opts);
  return {
    ...outcome(RESEARCH_OUTCOME.AVAILABLE, { quota }),
    asked,
    probed: true,
    choice,
    consent,
    ...(consent.written || consent.reason === "unchanged" ? {} : { notRemembered: NOT_REMEMBERED[consent.reason] }),
  };
}
