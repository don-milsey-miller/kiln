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
 * ✅ **AUTHORITATIVE as of 2026-08-22: rewritten FROM a real controller run**, per the PM's condition
 * that it becomes authoritative only when the real path emits it. It was provisional before that, and
 * reality corrected it in two places — which is the argument for the condition:
 *
 *   1. The redacted fact is `env:TAVILY_API_KEY`, not `TAVILY_API_KEY`. The `env:` prefix is how the
 *      capture plan asks for an environment variable, and the fixture had invented a name.
 *   2. There is a FOURTH omission the draft did not have: `timing`, `not-captured`. Writing the
 *      fixture from imagination produced three states from three causes and quietly missed the one
 *      that comes from the capture plan itself.
 *
 * ⚠️ Neither correction was large, and that is the point: a fixture written from a design is
 * plausible everywhere and wrong in the details, and the details are what a schema is made of.
 *
 * Values here are shape, not measurements — `test/controller.test.mjs` compares KEYS and
 * (fact, state) pairs against a live run, never the machine-specific values.
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
    os: "Windows_NT 10.0.26200",
    "python-version": "Python 3.12.10",
    workspace: "fresh temporary directory",
    venv: "created per run",
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
      reason: 'No collector for "cpu-model" exists on this platform at this tier.',
    },
    {
      fact: "env:TAVILY_API_KEY",
      state: "redacted",
      reason: "Obtained from the host environment and suppressed by policy: a credential must never reach an evidence record (DEC-0006).",
    },
    {
      fact: "timing",
      state: "not-captured",
      reason: "The capture plan explicitly disabled this fact for this run.",
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
