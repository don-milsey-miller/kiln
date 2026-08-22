/**
 * The two fixtures that settle `evidence.environment`'s shape — written BEFORE the schema change,
 * on the PM's instruction, so the model is pressured by real records rather than designed and then
 * illustrated.
 *
 * They are deliberately unlike each other in the one dimension that matters:
 *
 *   HOST      — something ran, directly, with whatever the machine happened to have.
 *   CONTROLLER — the validation controller provisioned an environment and ran it there.
 *
 * ⚠️ **What they force is two AXES, not a "tier 0".** Inventing tier 0 would put host execution on the
 * isolation ladder at the bottom rung, which reads as *"the weakest isolation"* when the truth is
 * *"isolation is not a thing this run has an answer to"*. A rung implies a comparison; there is none.
 * So: **every experiment declares an environment; only a controller-managed run declares a
 * `sandboxTier`.** Absence of the tier is not silence — `execution: "host"` says why it is absent.
 *
 * ⚠️ **The host fixture is the real one.** It is the probe run the PM executed on 2026-08-22, which
 * `QST-0012` made unrecordable. Its facts are exactly what that output carried and nothing more.
 */

/**
 * FIXTURE A — direct host execution, no controller, no isolation claim.
 *
 * Everything here was visible in the eight lines the run printed. Nothing has been added by looking
 * at the machine afterwards: a later inspection describes a later moment, not this one.
 */
export const HOST_RUN = {
  execution: "host",
  // ⚠️ NO sandboxTier. Not omitted for tidiness — there was no controller, so there is no isolation
  // level to name, and naming one would grant containment this run never had.
  facts: {
    os: "Windows",
    backend: "tavily",
    "credential-source": "host environment variable",
  },
  omissions: [
    {
      fact: "node-version",
      state: "not-captured",
      reason: "No capture plan existed: the run predates the validation controller. It was not collected, and it must not be filled in later from a re-run.",
    },
    {
      fact: "os-build",
      state: "not-captured",
      reason: "Same: nothing collected it at the time.",
    },
    {
      fact: "tavily-plan-name",
      state: "not-captured",
      reason: "The /usage response was not retained; only the four numbers printed by the probe survive.",
    },
  ],
};

/**
 * FIXTURE B — controller-managed tier-1 execution.
 *
 * ⚠️ **Provisional until the controller actually emits it.** #127 says the collector's fixtures must
 * justify every schema state, and a state a collector cannot produce must not be in the schema. This
 * fixture is a claim about what the tier-1 controller will emit; the controller's own tests are what
 * turn it into a fact. It is written first so the schema is shaped by both cases at once.
 *
 * It carries the three omission states the host run cannot produce, which is why two fixtures were
 * needed rather than one.
 */
export const CONTROLLER_RUN = {
  execution: "controller",
  sandboxTier: 1,
  // The boundary travels WITH the record (DEC-0005). A reader of this evidence must be able to see
  // what tier 1 did not claim without going to find the decision that said so.
  isolationBoundary: {
    isolates: ["python-dependencies"],
    doesNotClaim: ["containment-of-hostile-code", "host-filesystem-denial", "network-isolation"],
  },
  facts: {
    os: "Windows",
    "python-version": "3.12.4",
    workspace: "fresh temporary directory",
    "venv": "created per run",
  },
  omissions: [
    {
      fact: "git-commit",
      state: "unavailable",
      reason: "Collection ran: the workspace is not a git repository, so there is no commit to record.",
    },
    {
      fact: "cpu-model",
      state: "not-observable",
      reason: "No collector for CPU model exists on this platform in tier 1.",
    },
    {
      fact: "TAVILY_API_KEY",
      state: "redacted",
      reason: "Present in the allowlisted process environment and deliberately suppressed: a credential must never reach an evidence record (DEC-0006).",
    },
  ],
};

/**
 * What the two together demand of the schema. Written as data so a test can assert the schema meets
 * it, rather than as a paragraph nobody checks.
 */
export const FIXTURE_DEMANDS = {
  everyExperimentHasEnvironment: true,
  sandboxTierRequiredOnlyForController: true,
  sandboxTierForbiddenForHost: true,
  omissionStates: ["not-captured", "not-observable", "unavailable", "redacted"],
  everyOmissionHasReason: true,
};
