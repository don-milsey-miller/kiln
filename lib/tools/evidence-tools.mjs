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
import { effectiveSchema, loadSchemaSet, typeOfId } from "../schema-resolver.mjs";

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

const QUESTION_FIELDS = new Set([
  "title", "statement", "resolution", "answer", "answeredBy", "blocks", "raisedBy", "notes", "tags",
]);

/** REQ-0014: an unresolved question is a tracked item with a state, not a sentence in a document. */
const DECISION_FIELDS = new Set([
  "title", "statement", "alternatives", "rationale", "decidedAt",
  "addresses", "derivedFrom", "evidencedBy", "assumesThat", "tags", "notes",
]);

/** #38's decision register. `supersededBy` is absent: superseding is setLifecycle's job (#114). */
export const createDecision = (input, opts) => createArtifact("decision", DECISION_FIELDS, input, opts);

export const createQuestion = (input, opts) =>
  createArtifact("question", QUESTION_FIELDS, { resolution: "unanswered", ...input }, opts);

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

/**
 * Detach an evidence record from an assertion.
 *
 * ⚠️ This exists because **a link is a judgement, and judgements are wrong sometimes.**
 * The structural checks — one record cannot both support and refute, a link must resolve —
 * can be enforced. Whether a record actually BEARS on a claim the way someone said it does
 * cannot be, and the first real use of linkEvidence got it wrong (#101). A system where a
 * mistaken link can only be corrected by editing JSON by hand would push corrections outside
 * the typed path, which is #88's whole premise inverted.
 *
 * Same #78 read-modify-write as linkEvidence: fresh read inside the lock.
 */
export async function unlinkEvidence(assertionId, evidenceId, polarity, opts = {}) {
  if (polarity !== "support" && polarity !== "refute")
    throw new ValidationError(`Polarity must be "support" or "refute", got ${JSON.stringify(polarity)}.`, []);

  const contentRoot = opts.contentRoot ?? resolveContentRoot(opts.env);
  const validators = opts.validators ?? createValidators(opts.schemasDir ?? DEFAULT_SCHEMAS);
  const field = polarity === "support" ? "supportedBy" : "refutedBy";

  return withLock(join(contentRoot, LOCK_FILE), async () => {
    const abs = resolveInContentRoot(artifactRelPath("assertion", assertionId), { contentRoot });
    if (!existsSync(abs)) throw new ValidationError(`No such assertion: ${assertionId}`, []);

    const assertion = JSON.parse(readFileSync(abs, "utf-8"));
    const links = (assertion[field] ?? []).filter((r) => r !== evidenceId);
    if (links.length === (assertion[field] ?? []).length)
      return { assertionId, evidenceId, polarity, changed: false, assertion };

    const updated = { ...assertion, [field]: links };
    assertValid(validators, "assertion", updated, "assertion after unlinking");
    await atomicWrite(abs, JSON.stringify(updated, null, 2) + "\n");
    return { assertionId, evidenceId, polarity, changed: true, assertion: updated };
  });
}

/**
 * Revise an artifact's own fields — the third mutation the system needed, and it arrived the
 * same way the second one did: a correction that could otherwise only be made by hand.
 *
 * ⚠️ **Trace fields are NOT revisable here.** Links have their own operations because a link
 * is a judgement with its own guards (#101); routing them through a generic setter would let
 * a caller bypass the dual-link check by writing `refutedBy` directly.
 *
 * ⚠️ **#16: an approved artifact that changes becomes `amended`.** Not draft, not silently
 * still-approved — an approval was given to something that no longer says the same thing, and
 * the record should show that. A draft stays draft, because nothing was approved to lose.
 */
export async function reviseArtifact(type, id, changes, opts = {}) {
  const contentRoot = opts.contentRoot ?? resolveContentRoot(opts.env);
  const schemasDir = opts.schemasDir ?? DEFAULT_SCHEMAS;
  const validators = opts.validators ?? createValidators(schemasDir);
  const schemas = opts.schemas ?? loadSchemaSet(schemasDir);

  const forbidden = ["id", "type", "schemaVersion", "lifecycle", "reviewStatus"];
  const traceLike = ["supportedBy", "refutedBy", "restsOn", "derivedFrom", "evidencedBy", "arisesFrom", "partOf", "dependsOn", "addresses", "assumesThat", "supersededBy", "boundedBy", "verifiedBy", "openQuestions", "implements", "decidedBy", "usesSchemas"];
  for (const k of Object.keys(changes ?? {})) {
    if (forbidden.includes(k))
      throw new ValidationError(`\`${k}\` is not revisable — it is identity or lifecycle state (#82).`, []);
    if (traceLike.includes(k))
      throw new ValidationError(
        `\`${k}\` is a trace field. Links have their own operations so their guards cannot be bypassed (#101).`,
        []
      );
  }

  return withLock(join(contentRoot, LOCK_FILE), async () => {
    const abs = resolveInContentRoot(artifactRelPath(type, id), { contentRoot });
    if (!existsSync(abs)) throw new ValidationError(`No such ${type}: ${id}`, []);

    const doc = JSON.parse(readFileSync(abs, "utf-8")); // fresh, inside the lock
    const updated = { ...doc, ...changes };

    // ⚠️ "Payload changed" is NOT a materiality class (#61), and treating every edit alike
    // breaks #63's promise that cosmetic edits never prompt — fixing a typo in an approved
    // artifact's rationale would reopen it. Materiality comes from #84's effective schema,
    // never from a hardcoded field list.
    const eff = effectiveSchema(schemas, type);
    const changedFields = Object.keys(changes ?? {})
      .filter((k) => JSON.stringify(doc[k]) !== JSON.stringify(updated[k]))
      .map((field) => {
        const prop = eff.properties[field] ?? {};
        const materiality = prop["x-materiality"] ?? "semantic"; // unknown is treated as material
        // A field may declare whether changing it invalidates an approval. Default by class:
        // cosmetic does not, everything else does — advisory conservatively, since
        // `priority: must -> should` plainly reopens an approval while `tags` plainly does
        // not, and #61 already parks per-field advisory nuance as unresolved.
        const amends = prop["x-amendsApproval"] ?? materiality !== "cosmetic";
        return { field, materiality, amends };
      });

    const amends = changedFields.some((c) => c.amends);
    if (doc.reviewStatus === "approved" && amends) updated.reviewStatus = "amended";

    assertValid(validators, type, updated, `${type} after revision`);
    await atomicWrite(abs, JSON.stringify(updated, null, 2) + "\n");
    return {
      id,
      changed: changedFields.length > 0,
      changedFields,
      amends,
      // #63's two streams. The caller routes on this rather than re-deriving it.
      stream: amends ? "change-feed" : "activity-log",
      artifact: updated,
    };
  });
}

/**
 * Move an artifact's lifecycle — the fourth mutation, and it closes a gap #83 left open.
 *
 * ⚠️ #83 says tools never physically delete and that removal is `lifecycle: retired`. It
 * provided no way to SET that. `reviseArtifact` refuses lifecycle deliberately (#102), so
 * until now the only route to retiring an artifact was hand-editing JSON — which #88 forbids.
 * A policy with no mechanism is a policy nobody can follow.
 *
 * `superseded` requires naming the successors; the schema enforces it, this refuses earlier
 * with a message that says what to pass.
 */
export async function setLifecycle(type, id, lifecycle, opts = {}) {
  const allowed = ["active", "superseded", "retired"];
  if (!allowed.includes(lifecycle))
    throw new ValidationError(`lifecycle must be one of ${allowed.join(", ")}, got ${JSON.stringify(lifecycle)}.`, []);
  const successors = opts.supersededBy ?? [];
  if (lifecycle === "superseded" && successors.length === 0)
    throw new ValidationError(
      `Superseding ${id} requires \`supersededBy\` — what replaced it. A superseded artifact with no successor ` +
        `is a dead end that looks like history.`,
      []
    );

  const contentRoot = opts.contentRoot ?? resolveContentRoot(opts.env);
  const validators = opts.validators ?? createValidators(opts.schemasDir ?? DEFAULT_SCHEMAS);

  return withLock(join(contentRoot, LOCK_FILE), async () => {
    const abs = resolveInContentRoot(artifactRelPath(type, id), { contentRoot });
    if (!existsSync(abs)) throw new ValidationError(`No such ${type}: ${id}`, []);
    const doc = JSON.parse(readFileSync(abs, "utf-8"));
    const updated = { ...doc, lifecycle, supersededBy: lifecycle === "superseded" ? [...successors].sort() : [] };
    assertValid(validators, type, updated, `${type} after lifecycle change`);
    await atomicWrite(abs, JSON.stringify(updated, null, 2) + "\n");
    return { id, from: doc.lifecycle, to: lifecycle, artifact: updated };
  });
}

/**
 * Settle a question — the fifth mutation, and it exists for the reason DEC-0003's audit named:
 * **the workflow authorised a state transition and supplied no typed operation for it.**
 *
 * Stage 4's entire purpose is producing questions and settling them, `question.resolution`
 * is the field that records the settling, and until now nothing could write it. `reviseArtifact`
 * could reach `resolution` and `answer` but refuses `answeredBy` — correctly, since it is a
 * trace field (#101) — so recording WHAT settled a question had no typed path at all. That is
 * the same defect as #83's missing lifecycle setter, one artifact type over.
 *
 * ⚠️ The guard that matters is the one the schema states and this one says EARLIER, with a
 * message: **answered requires an answer or a link to what settled it.** A question marked
 * answered carrying neither is the backlog's version of a well-formed false success — closed
 * on the board, recording nothing.
 *
 * ⚠️ **Reopening is deliberately not implemented.** Nothing in the workflow authorises moving a
 * question back to `unanswered`, and doing it silently would leave a stale `answer` attached to
 * a live question — a worse state than either end. When something does authorise it, what
 * happens to the recorded answer is the decision to make first.
 *
 * @param {string} id
 * @param {"answered"|"deferred"|"moot"} resolution
 * @param {{answer?: string, answeredBy?: string[]}} [opts]
 */
export async function resolveQuestion(id, resolution, opts = {}) {
  const allowed = ["answered", "deferred", "moot"];
  if (!allowed.includes(resolution)) {
    const hint =
      resolution === "unanswered"
        ? " Reopening is not implemented: decide what happens to the recorded answer first."
        : "";
    throw new ValidationError(
      `resolution must be one of ${allowed.join(", ")}, got ${JSON.stringify(resolution)}.${hint}`,
      []
    );
  }

  const answeredBy = opts.answeredBy ?? [];
  const answer = opts.answer;
  if (resolution === "answered" && !answer && answeredBy.length === 0)
    throw new ValidationError(
      `Answering ${id} requires \`answer\`, \`answeredBy\`, or both. A question marked answered that ` +
        `records neither what the answer is nor what settled it is closed on the board and empty in the record.`,
      []
    );

  const contentRoot = opts.contentRoot ?? resolveContentRoot(opts.env);
  const schemasDir = opts.schemasDir ?? DEFAULT_SCHEMAS;
  const validators = opts.validators ?? createValidators(schemasDir);
  const schemas = opts.schemas ?? loadSchemaSet(schemasDir);

  return withLock(join(contentRoot, LOCK_FILE), async () => {
    const abs = resolveInContentRoot(artifactRelPath("question", id), { contentRoot });
    if (!existsSync(abs)) throw new ValidationError(`No such question: ${id}`, []);

    // Every link must resolve to something that exists. Same standard as linkEvidence: the
    // typed path does not create dangling references and leave them for the lint to find.
    for (const ref of answeredBy) {
      const refType = typeOfId(schemas, ref);
      if (!refType) throw new ValidationError(`\`answeredBy\` contains ${ref}, which is not an artifact ID.`, []);
      const refPath = resolveInContentRoot(artifactRelPath(refType, ref), { contentRoot });
      if (!existsSync(refPath)) throw new ValidationError(`\`answeredBy\` names ${ref}, which does not exist.`, []);
    }

    const doc = JSON.parse(readFileSync(abs, "utf-8")); // fresh, inside the lock (#78)
    const links = [...new Set([...(doc.answeredBy ?? []), ...answeredBy])].sort();
    const updated = { ...doc, resolution, ...(answer === undefined ? {} : { answer }), answeredBy: links };

    // Settling a question is semantic and structural, never cosmetic — so #16 applies without
    // needing #103's materiality lookup: an approval given to an open question was not given
    // to a closed one.
    if (doc.reviewStatus === "approved") updated.reviewStatus = "amended";

    assertValid(validators, "question", updated, `question after resolution`);
    await atomicWrite(abs, JSON.stringify(updated, null, 2) + "\n");
    return { id, from: doc.resolution, to: resolution, answeredBy: links, artifact: updated };
  });
}
