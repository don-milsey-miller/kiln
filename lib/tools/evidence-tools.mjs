/**
 * Typed tools for the evidence loop. All three preserve #96's split at the INPUT boundary,
 * which is the only place it can be enforced cheaply:
 *
 *   - `createAssertion` refuses `confidence` and `verdict`. Both are derived.
 *   - `createEvidence` records what was OBSERVED — including `outcome` — and never polarity.
 *     A successful run can refute a claim; the evidence does not know which way it bears.
 *   - `linkEvidence` is where polarity is added, as a relation on the ASSERTION.
 *   - `createRunbookStep` requires `restsOn`, and a destructive step cannot be created
 *     without it (#58's floor, structural half).
 *
 * ⚠️ **Evidence creation and assertion linking are deliberately SEPARATE operations.**
 * Combining them would make a two-file transaction whose crash semantics are far harder than
 * #88's single-artifact contract — and the failure mode of a fake transaction is worse than
 * the failure mode of a missing link. **An unattached evidence record is detectable and
 * repairable** (the lint can see it); a half-completed "atomic attachment" is a lie about
 * what happened, discovered later by someone trusting it.
 */

import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createArtifact, LOCK_FILE } from "./create-artifact.mjs";
import { resolveContentRoot, resolveInContentRoot } from "../content-root.mjs";
import { withLock } from "../lock.mjs";
import { atomicWrite } from "../atomic-write.mjs";
import { createValidators, assertValid, ValidationError } from "../validate.mjs";
import { artifactRelPath } from "../layout.mjs";

const DEFAULT_SCHEMAS = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "schemas");

/** ⚠️ `confidence` and `verdict` are absent on purpose (#96), as is `supportedBy`/`refutedBy`:
 *  polarity arrives through linkEvidence, not through creation. */
const ASSERTION_FIELDS = new Set([
  "title", "statement", "loadBearing", "targetEnvironment", "arisesFrom", "openQuestions", "notes", "tags",
]);

const EVIDENCE_FIELDS = new Set([
  "title", "kind", "summary", "sources", "environment", "outcome", "observedAt", "capture", "supersededBy", "notes", "tags",
]);

const RUNBOOK_STEP_FIELDS = new Set([
  "title", "instruction", "expectedOutcome", "ordinal", "destructive", "remediation", "restsOn", "partOf", "dependsOn", "notes", "tags",
]);

export const createAssertion = (input, opts) => createArtifact("assertion", ASSERTION_FIELDS, input, opts);
export const createEvidence = (input, opts) => createArtifact("evidence", EVIDENCE_FIELDS, input, opts);

export async function createRunbookStep(input, opts) {
  // REQ-0009 at the input boundary: an instruction with no backing claim should never be
  // creatable, destructive or not. The schema enforces it only for destructive steps —
  // that is the structural half; this is the authoring half.
  if (!Array.isArray(input?.restsOn) || input.restsOn.length === 0)
    throw new ValidationError(
      "A runbook step must declare `restsOn` — at least one assertion it depends on (REQ-0009). " +
        "An instruction that rests on nothing is the runbook becoming the place discovery happens.",
      []
    );
  return createArtifact("runbook-step", RUNBOOK_STEP_FIELDS, input, opts);
}

/**
 * Attach an existing evidence record to an existing assertion, with polarity.
 *
 * This is the system's first UPDATE path, so it is #78's read-modify-write in earnest:
 * lock → fresh read INSIDE the lock → modify → #72 atomic write → release. The fresh read
 * after acquisition is the part that matters; a snapshot taken before the lock would let the
 * lock serialise stale writes rather than prevent them.
 *
 * @param {string} assertionId
 * @param {string} evidenceId
 * @param {"support"|"refute"} polarity
 */
export async function linkEvidence(assertionId, evidenceId, polarity, opts = {}) {
  if (polarity !== "support" && polarity !== "refute")
    throw new ValidationError(`Polarity must be "support" or "refute", got ${JSON.stringify(polarity)}.`, []);

  const contentRoot = opts.contentRoot ?? resolveContentRoot(opts.env);
  const schemasDir = opts.schemasDir ?? DEFAULT_SCHEMAS;
  const validators = opts.validators ?? createValidators(schemasDir);
  const field = polarity === "support" ? "supportedBy" : "refutedBy";

  return withLock(join(contentRoot, LOCK_FILE), async () => {
    const assertionPath = resolveInContentRoot(artifactRelPath("assertion", assertionId), { contentRoot });
    const evidencePath = resolveInContentRoot(artifactRelPath("evidence", evidenceId), { contentRoot });

    if (!existsSync(assertionPath)) throw new ValidationError(`No such assertion: ${assertionId}`, []);
    if (!existsSync(evidencePath)) throw new ValidationError(`No such evidence: ${evidenceId}`, []);

    // Fresh read AFTER acquiring the lock (#78).
    const assertion = JSON.parse(readFileSync(assertionPath, "utf-8"));

    const other = field === "supportedBy" ? "refutedBy" : "supportedBy";
    if ((assertion[other] ?? []).includes(evidenceId))
      throw new ValidationError(
        `${evidenceId} is already linked to ${assertionId} as ${other}. One record cannot both support and ` +
          `refute the same claim — that is not a contested assertion, it is a mistake. Unlink first if the ` +
          `polarity was wrong.`,
        []
      );

    const links = new Set(assertion[field] ?? []);
    if (links.has(evidenceId)) return { assertionId, evidenceId, polarity, changed: false, assertion };
    links.add(evidenceId);

    const updated = { ...assertion, [field]: [...links].sort() };
    assertValid(validators, "assertion", updated, "assertion after linking");
    await atomicWrite(assertionPath, JSON.stringify(updated, null, 2) + "\n");
    return { assertionId, evidenceId, polarity, changed: true, assertion: updated };
  });
}
