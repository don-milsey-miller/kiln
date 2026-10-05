/**
 * The Stage 4 decision bundle - #173 (F11, F13).
 *
 * One operator decision in Stage 4 becomes several typed writes: a question (new, or one an earlier
 * stage already raised), the decision that answers it, the question's resolution, any revision or link the decision causes, the decision's
 * approval, and sometimes a working note. Asking for each one separately made the operator approve
 * bookkeeping. This module applies them as one bounded unit under one approval.
 *
 *   plan    - validate every operation and final artifact, name the exact ids, compute the digest
 *   confirm - the caller shows the operator the whole plan, once
 *   execute - journal the authorisation, then run each operation through its typed writer
 *   resume  - continue an authorised journal from its first incomplete operation, with no new approval
 *
 * ⚠️ **THE TYPED WRITERS ARE THE ONLY THING THAT WRITES AN ARTIFACT.** Nothing here validates a
 * schema or a trace target itself. Planning calls each writer with `dryRun`, and execution calls the
 * same writer for real, so the two cannot disagree about what is legal.
 *
 * ⚠️ **ONE LOCK HOLD, REUSED BY NAME.** Execution holds the content lock across every operation and
 * each writer is told so with `lock: { reuseHeld: true }`. The lock is not held while the operator
 * reads the confirmation: the plan records what it saw, and execution refuses if any of it changed.
 *
 * ⚠️ **NO ROLLBACK.** A failure leaves completed operations in place and the journal says which they
 * are. Undoing them would delete artifacts whose ids are already consumed, and would not help after
 * a crash, which runs no handler at all.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { resolveInContentRoot } from "./content-root.mjs";
import { peekNextId, reserveId } from "./id-allocator.mjs";
import { artifactRelPath } from "./layout.mjs";
import { withLock } from "./lock.mjs";
import { typeOfId, typePrefixes } from "./schema-resolver.mjs";
import { LOCK_FILE } from "./tools/create-artifact.mjs";
import { assertValid, ValidationError } from "./validate.mjs";
import {
  BUNDLE_STATUS,
  JOURNAL_READ,
  JOURNAL_RECORD_VERSION,
  JOURNAL_REFUSAL,
  JournalError,
  OPERATION_STATUS,
  bundleDigest,
  canonicalJson,
  checkpointOf,
  firstIncomplete,
  isResumable,
  journalProtected,
  readJournal,
  writeJournal,
} from "./decision-bundle-journal.mjs";

export const BUNDLE_STAGE = "04-requirement-gaps";
export const STAGE_TARGET = `stage:${BUNDLE_STAGE}`;

/** The most related revisions and link changes one decision may carry. More than this is not one decision. */
export const MAX_REVISIONS = 10;
export const MAX_LINKS = 10;

/** A request stands for the two ids Kiln will assign with these. */
export const PLACEHOLDER = Object.freeze({ QUESTION: "$question", DECISION: "$decision" });

export const BUNDLE_REFUSAL = Object.freeze({
  INVALID_REQUEST: "invalid-request",
  WRONG_STAGE: "bundle-wrong-stage",
  JOURNAL_UNAVAILABLE: JOURNAL_REFUSAL.UNAVAILABLE,
  JOURNAL_UNREADABLE: JOURNAL_REFUSAL.UNREADABLE,
  JOURNAL_UNWRITABLE: JOURNAL_REFUSAL.UNWRITABLE,
  DIGEST_MISMATCH: "bundle-digest-mismatch",
  STATE_MISMATCH: "bundle-state-mismatch",
  NOTHING_TO_RESUME: "bundle-nothing-to-resume",
  INTERRUPTED: "bundle-interrupted",
  OPERATION_FAILED: "bundle-operation-failed",
});

/** A refusal before anything was authorised. `checkpoint` is set when an incomplete journal is the reason. */
export class BundleRefusal extends Error {
  constructor(code, message, { checkpoint = null } = {}) {
    super(message);
    this.name = "BundleRefusal";
    this.code = code;
    this.checkpoint = checkpoint;
  }
}

const refuse = (code, message, extra) => {
  throw new BundleRefusal(code, message, extra);
};

const ARTIFACT_ID = /^[A-Z]{3}-[0-9]{4,}$/;
const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const hashOf = (text) => `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;

/* ------------------------------------------------------------------ the request */

/**
 * The request's own shape. What a field may CONTAIN is each typed writer's to decide; this checks
 * only what makes it a bundle: the three required parts, the bounds, and no target named twice.
 */
function assertRequest(request) {
  const bad = (message) => refuse(BUNDLE_REFUSAL.INVALID_REQUEST, message);
  if (!isRecord(request)) bad("A decision bundle is an object.");
  // ⚠️ EXACTLY ONE. The question is either created here or already exists; a request naming both
  // would leave it unsaid which one the decision answers.
  const hasNew = request.question !== undefined;
  const hasExisting = request.questionId !== undefined;
  if (hasNew === hasExisting) bad("Supply exactly one of `question` (a new question's fields) or `questionId` (an existing, unresolved question).");
  if (hasNew && !isRecord(request.question)) bad("`question` must hold the new question's fields.");
  if (hasExisting && (typeof request.questionId !== "string" || !/^QST-[0-9]{4,}$/.test(request.questionId))) bad("`questionId` must be a question id, such as QST-0001.");
  if (!isRecord(request.decision)) bad("`decision` must hold the new decision's fields.");
  if (typeof request.answer !== "string" || request.answer.trim().length === 0) bad("`answer` must say what the operator decided.");

  // ⚠️ THE BUNDLE SETTLES THE QUESTION ITSELF. A question that arrived already answered would be
  // resolved twice, with two wordings, and only one of them shown as the resolution.
  for (const field of hasNew ? ["resolution", "answer", "answeredBy"] : [])
    if (field in request.question) bad(`\`question.${field}\` is set by the bundle's own resolution; do not supply it.`);

  const revisions = request.revisions ?? [];
  if (!Array.isArray(revisions) || revisions.length > MAX_REVISIONS) bad(`\`revisions\` is a list of at most ${MAX_REVISIONS}.`);
  const revised = new Set();
  for (const r of revisions) {
    if (!isRecord(r) || typeof r.type !== "string" || typeof r.id !== "string" || !ARTIFACT_ID.test(r.id) || !isRecord(r.changes) || Object.keys(r.changes).length === 0)
      bad("Each revision needs a `type`, an existing artifact `id`, and non-empty `changes`.");
    if (revised.has(r.id)) bad(`${r.id} is revised more than once; put every change to it in one revision.`);
    revised.add(r.id);
  }

  const links = request.links ?? [];
  if (!Array.isArray(links) || links.length > MAX_LINKS) bad(`\`links\` is a list of at most ${MAX_LINKS}.`);
  const linked = new Set();
  for (const l of links) {
    if (!isRecord(l) || (l.action !== "link" && l.action !== "unlink") || typeof l.type !== "string" || typeof l.id !== "string" || !ARTIFACT_ID.test(l.id) || typeof l.field !== "string" || !Array.isArray(l.targets) || l.targets.length === 0)
      bad("Each link change needs an `action` of link or unlink, a `type`, an existing artifact `id`, a `field`, and `targets`.");
    for (const t of l.targets)
      if (typeof t !== "string" || !(ARTIFACT_ID.test(t) || t === PLACEHOLDER.QUESTION || t === PLACEHOLDER.DECISION))
        bad(`A link target is an artifact id, ${PLACEHOLDER.QUESTION} or ${PLACEHOLDER.DECISION}.`);
    const key = `${l.id} ${l.field}`;
    if (linked.has(key)) bad(`${l.id}.${l.field} is changed more than once; name every target in one link change.`);
    linked.add(key);
  }

  if (request.stageNote !== undefined) {
    const n = request.stageNote;
    if (!isRecord(n) || (n.action !== "append-working-note" && n.action !== "replace-working-note"))
      bad("`stageNote.action` must be append-working-note or replace-working-note.");
  }
}

/**
 * The ordered operations a request stands for, once the two new ids are known.
 *
 * With `questionId` the question already exists, so there is no `create-question` and `ids.question`
 * is that id.
 *
 * ⚠️ **THE ORDER IS KILN'S, AND IT IS PART OF THE DIGEST.** The question exists before the decision
 * that addresses it; the decision exists before the question is resolved by it; the approval comes
 * after every artifact edit; the note is last.
 */
export function buildOperations(request, ids) {
  const questionId = request.questionId ?? ids.question;
  const resolve = (t) => (t === PLACEHOLDER.QUESTION ? questionId : t === PLACEHOLDER.DECISION ? ids.decision : t);
  const addresses = [...new Set([...(Array.isArray(request.decision.addresses) ? request.decision.addresses : []), questionId])].sort();

  const operations = [
    ...(request.questionId === undefined ? [{ kind: "create-question", target: questionId, args: { artifact: request.question } }] : []),
    { kind: "create-decision", target: ids.decision, args: { artifact: { ...request.decision, addresses } } },
    { kind: "resolve-question", target: questionId, args: { resolution: "answered", answer: request.answer, answeredBy: [ids.decision] } },
  ];
  for (const r of request.revisions ?? []) operations.push({ kind: "revise-artifact", target: r.id, args: { type: r.type, changes: r.changes } });
  for (const l of request.links ?? [])
    operations.push({ kind: l.action === "unlink" ? "unlink-trace" : "link-trace", target: l.id, args: { type: l.type, field: l.field, targets: l.targets.map(resolve) } });
  operations.push({ kind: "approve-decision", target: ids.decision, args: { type: "decision", reviewStatus: "approved" } });
  if (request.stageNote !== undefined) {
    const { action, subsection, title, content } = request.stageNote;
    operations.push({ kind: "write-stage-note", target: STAGE_TARGET, args: { action, subsection, title, content } });
  }
  // ⚠️ A ROUND TRIP, so the digest is over what the journal will hold: `undefined` members are gone.
  return JSON.parse(JSON.stringify(operations));
}

/* ------------------------------------------------------------------ shared plumbing */

async function resolveRuntime(options) {
  const registry = options.TYPED_TOOLS && options.MUTATION_TOOLS ? null : await import("./tools/registry.mjs");
  return {
    typed: options.TYPED_TOOLS ?? registry.TYPED_TOOLS,
    mutation: options.MUTATION_TOOLS ?? registry.MUTATION_TOOLS,
    documents: options.stageDocuments ?? (await import("./stage-documents.mjs")),
  };
}

/** What every nested writer is given: the same schemas and validators, and the lock it must reuse. */
const writerOptions = (options, extra = {}) => ({
  contentRoot: options.contentRoot,
  schemasDir: options.schemasDir,
  schemas: options.schemas,
  validators: options.validators,
  lock: { reuseHeld: true },
  ...extra,
});

const lockPath = (options) => join(options.contentRoot, LOCK_FILE);

function artifactPath(options, id) {
  const type = typeOfId(options.schemas, id);
  if (!type) throw new ValidationError(`\`${id}\` is not an artifact ID.`, []);
  return resolveInContentRoot(artifactRelPath(type, id), { contentRoot: options.contentRoot });
}

/** The hash a target has right now: `null` for an artifact that does not exist. */
function currentHash(target, options, runtime) {
  if (target === STAGE_TARGET) return runtime.documents.readWorkingNotes(options.contentRoot, BUNDLE_STAGE).revision;
  const path = artifactPath(options, target);
  return existsSync(path) ? hashOf(readFileSync(path, "utf-8")) : null;
}

const readArtifact = (options, id) => JSON.parse(readFileSync(artifactPath(options, id), "utf-8"));

/** A question's own statement, for a checkpoint to quote. Throws when it cannot be read. */
export function questionStatement(contentRoot, id) {
  return JSON.parse(readFileSync(resolveInContentRoot(artifactRelPath("question", id), { contentRoot }), "utf-8")).statement;
}

function loadJournal(options) {
  const location = options.journal;
  if (!location) refuse(BUNDLE_REFUSAL.JOURNAL_UNAVAILABLE, "This session has no protected runtime-state directory, so an approved bundle could not be journaled. Nothing was changed.");
  const read = readJournal(location, { validators: options.runtimeValidators });
  if (read.state === JOURNAL_READ.UNPROTECTED || (read.state === JOURNAL_READ.ABSENT && !journalProtected(location)))
    refuse(BUNDLE_REFUSAL.JOURNAL_UNAVAILABLE, "Kiln's runtime-state directory is missing or is not kept out of the repository, so an approved bundle could not be journaled. Nothing was changed. Re-run setup.");
  return read;
}

/** One operation through its typed writer. `dryRun` validates and writes nothing. */
async function runOperation(op, journal, options, runtime, { dryRun = false } = {}) {
  const assumeExisting = [journal.ids.question, journal.ids.decision];
  const base = writerOptions(options, dryRun ? { dryRun: true } : {});
  switch (op.kind) {
    case "create-question":
    case "create-decision": {
      const type = op.kind === "create-question" ? "question" : "decision";
      if (!dryRun) await reserveId(options.contentRoot, op.target);
      return runtime.typed[type](op.args.artifact, { ...base, reservedId: op.target, assumeExisting });
    }
    case "resolve-question":
      return runtime.mutation.resolveQuestion(op.target, op.args.resolution, { ...base, answer: op.args.answer, answeredBy: op.args.answeredBy, ...(dryRun ? { assumeExisting } : {}) });
    case "revise-artifact":
      return runtime.mutation.reviseArtifact(op.args.type, op.target, op.args.changes, base);
    case "link-trace":
      return runtime.mutation.linkTrace(op.args.type, op.target, op.args.field, op.args.targets, { ...base, assumeExisting });
    case "unlink-trace":
      return runtime.mutation.unlinkTrace(op.args.type, op.target, op.args.field, op.args.targets, base);
    case "approve-decision":
      return runtime.mutation.setReviewStatus(op.args.type, op.target, op.args.reviewStatus, { ...base, reviewedBy: options.reviewedBy });
    case "write-stage-note":
      return runtime.documents.writeWorkingNotes(
        options.contentRoot,
        BUNDLE_STAGE,
        { ...op.args, expectedRevision: journal.targets[STAGE_TARGET] },
        { lock: base.lock, ...(dryRun ? { dryRun: true } : {}) }
      );
    default:
      throw new ValidationError(`Unknown bundle operation ${JSON.stringify(op.kind)}.`, []);
  }
}

/** A stable code for a caught failure. Never the message: that can carry a path. */
function failureCode(error, runtime) {
  if (error instanceof runtime.documents.StageDocumentRefusal && /^[a-z0-9-]{1,80}$/.test(error.code ?? "")) return error.code;
  return (
    {
      ValidationError: "invalid-artifact",
      ArtifactExistsError: "artifact-exists",
      AllocationError: "id-allocation-refused",
      AtomicWriteError: "write-failed",
      LockError: "lock-unavailable",
    }[error?.name] ?? "operation-failed"
  );
}

/** `status` is the response class the model reports; `checkpoint` is the journal's own account. */
const resultOf = (journal, { ok, code = null, detail = null }) => ({
  ok,
  status: ok ? "action-completed" : "blocked",
  ...(code ? { code } : {}),
  ...(detail ? { detail } : {}),
  checkpoint: checkpointOf(journal),
});

/* ------------------------------------------------------------------ plan */

/**
 * Decide what this invocation is: a fresh bundle to confirm, or an authorised one to resume.
 *
 * Reads only. Every refusal here leaves the project and the journal exactly as they were.
 *
 * @param {object} request the model's arguments
 * @param {object} options `{contentRoot, schemasDir, schemas, validators, journal, currentStage, reviewedBy}`
 * @returns {Promise<{mode: "resume", digest: string} | {mode: "fresh", plan: object}>}
 */
export async function planDecisionBundle(request, options) {
  const runtime = await resolveRuntime(options);

  return withLock(lockPath(options), async () => {
    const read = loadJournal(options);
    const unreadable = read.state === JOURNAL_READ.INVALID || read.state === JOURNAL_READ.INACCESSIBLE;
    const prior = read.journal;

    if (typeof request?.resumeDigest === "string") {
      if (unreadable) refuse(BUNDLE_REFUSAL.JOURNAL_UNREADABLE, "The bundle journal could not be read or validated, so nothing can be resumed from it. Nothing was changed.");
      if (!isResumable(prior)) refuse(BUNDLE_REFUSAL.NOTHING_TO_RESUME, "No approved decision bundle is waiting to be resumed.");
      if (prior.digest !== request.resumeDigest)
        refuse(BUNDLE_REFUSAL.DIGEST_MISMATCH, "That digest is not the approved bundle's. Nothing was changed.", { checkpoint: checkpointOf(prior) });
      return { mode: "resume", digest: prior.digest };
    }

    assertRequest(request);

    if (unreadable && request.replaceIncomplete !== true)
      refuse(
        BUNDLE_REFUSAL.JOURNAL_UNREADABLE,
        "An earlier bundle journal exists and could not be read or validated, so Kiln cannot tell whether an approved bundle is incomplete. Nothing was changed. Tell the operator; `replaceIncomplete` asks them to discard it."
      );

    if (isResumable(prior)) {
      // ⚠️ THE SAME CONTENT UNDER THE SAME IDS IS THE SAME BUNDLE. A model that re-sends the approved
      // request after a compaction resumes it; one that changed a word has a different digest.
      const again = { question: request.questionId ?? prior.ids.question, decision: prior.ids.decision };
      const digest = bundleDigest({ stage: BUNDLE_STAGE, ids: again, operations: buildOperations(request, again) });
      if (digest === prior.digest) return { mode: "resume", digest };
      if (request.replaceIncomplete !== true)
        refuse(
          BUNDLE_REFUSAL.DIGEST_MISMATCH,
          "An approved decision bundle is incomplete, and this request differs from it in content, targets, order or scope. The earlier approval does not cover it. Nothing was changed. Resume the approved bundle with `resumeDigest`, or set `replaceIncomplete` to ask the operator to approve this one instead.",
          { checkpoint: checkpointOf(prior) }
        );
    }

    const stage = await options.currentStage();
    if (stage !== BUNDLE_STAGE)
      refuse(BUNDLE_REFUSAL.WRONG_STAGE, `A decision bundle belongs to stage ${BUNDLE_STAGE}, and the current stage is ${stage ?? "none: every stage is complete"}.`);

    const prefixes = typePrefixes(options.schemas);
    const existing = request.questionId !== undefined;
    const ids = { question: existing ? request.questionId : peekNextId(options.contentRoot, prefixes.question), decision: peekNextId(options.contentRoot, prefixes.decision) };
    const operations = buildOperations(request, ids);
    const draft = { ids, targets: {}, operations };

    if (existing) {
      // ⚠️ AN EXISTING QUESTION MUST BE THERE AND STILL OPEN. Settling one that is already answered,
      // deferred or moot would overwrite a recorded outcome under an approval for something else.
      const path = artifactPath(options, ids.question);
      if (!existsSync(path)) throw new ValidationError(`No such question: ${ids.question}`, []);
      const resolution = readArtifact(options, ids.question).resolution;
      if (resolution !== "unanswered")
        refuse(BUNDLE_REFUSAL.INVALID_REQUEST, `${ids.question} is already ${resolution}, so there is nothing for this decision to resolve.`);
    }

    // The targets as they stand now. Execution refuses if any has moved by the time the operator answers.
    for (const op of operations) if (!(op.target in draft.targets)) draft.targets[op.target] = null;
    // The note's dry run below is what holds this revision to the document as it stands.
    if (STAGE_TARGET in draft.targets) draft.targets[STAGE_TARGET] = request.stageNote.expectedRevision;
    for (const target of Object.keys(draft.targets))
      if (target !== STAGE_TARGET && (existing || target !== ids.question) && target !== ids.decision) draft.targets[target] = currentHash(target, options, runtime);

    // ⚠️ EVERY OPERATION IS VALIDATED BEFORE AN ID IS CONSUMED OR THE OPERATOR IS ASKED. A confirmation
    // is for a bundle Kiln can apply, not for one that will be rejected half way.
    const effects = [];
    let question;
    let decision;
    const effect = (target, outcome) => {
      const before = readArtifact(options, target);
      if (!effects.some((e) => e.target === target)) effects.push({ target, from: before.reviewStatus ?? null, to: outcome.artifact?.reviewStatus ?? null });
    };
    for (const op of operations) {
      // The new artifacts' later operations are validated as final shapes below. An existing question
      // is on disk, so its resolution goes through the writer's own dry run like any other edit.
      if (op.kind === "approve-decision" || (op.kind === "resolve-question" && !existing)) continue;
      const outcome = await runOperation(op, draft, options, runtime, { dryRun: true });
      if (op.kind === "create-question") question = outcome;
      else if (op.kind === "create-decision") decision = outcome;
      if ((op.kind === "create-question" || op.kind === "create-decision") && outcome.exists)
        refuse(BUNDLE_REFUSAL.STATE_MISMATCH, `${op.target} already exists, so the ID counter is behind the content. Nothing was changed.`);
      if ((op.kind === "revise-artifact" || op.kind === "link-trace" || op.kind === "unlink-trace") && outcome.changed !== true)
        refuse(BUNDLE_REFUSAL.INVALID_REQUEST, `The ${op.kind} on ${op.target} would change nothing. Remove it from the bundle.`);
      if (op.kind === "resolve-question" || op.kind === "revise-artifact" || op.kind === "link-trace" || op.kind === "unlink-trace") effect(op.target, outcome);
    }

    // The two artifacts as the bundle leaves them, through the same validators the writers use.
    if (!existing) assertValid(options.validators, "question", { ...question.artifact, resolution: "answered", answer: request.answer, answeredBy: [ids.decision] }, "question after resolution");
    assertValid(options.validators, "decision", { ...decision.artifact, reviewStatus: "approved" }, "decision after approval");

    const digest = bundleDigest({ stage: BUNDLE_STAGE, ids, operations });
    return {
      mode: "fresh",
      plan: {
        stage: BUNDLE_STAGE,
        digest,
        ids,
        operations,
        targets: draft.targets,
        // The next id each counter must still be about to issue. An existing question consumes none.
        highWater: { question: existing ? null : ids.question, decision: ids.decision },
        // An existing question's own statement, so the confirmation shows what is being answered.
        question: existing ? { id: ids.question, statement: readArtifact(options, ids.question).statement ?? null } : null,
        // Approved artifacts an edit will move to `amended`, for the confirmation to disclose.
        effects: effects.filter((e) => e.from !== e.to),
        // An earlier bundle that did not finish, for the confirmation to disclose: its completed operations stay.
        replaces: unreadable ? { unreadable: true } : isResumable(prior) || prior?.status === BUNDLE_STATUS.BLOCKED ? checkpointOf(prior) : null,
        priorDigest: prior?.digest ?? null,
        priorState: read.state,
      },
    };
  });
}

/* ------------------------------------------------------------------ execute and resume */

/** Run operations from `start`, journaling after each. The caller holds the content lock. */
async function runFrom(journal, start, options, runtime) {
  const location = options.journal;
  const persist = () => writeJournal(location, journal, { validators: options.runtimeValidators, writeFile: options.journalWriteFile });

  for (let index = start; index < journal.operations.length; index++) {
    // ⚠️ AN ABORT STOPS BETWEEN OPERATIONS, NEVER INSIDE ONE. The journal already says where.
    if (options.signal?.aborted) return resultOf(journal, { ok: false, code: BUNDLE_REFUSAL.INTERRUPTED });

    const op = journal.operations[index];
    try {
      await runOperation(op, journal, options, runtime);
    } catch (error) {
      op.status = OPERATION_STATUS.FAILED;
      op.code = failureCode(error, runtime);
      journal.status = BUNDLE_STATUS.FAILED;
      journal.code = BUNDLE_REFUSAL.OPERATION_FAILED;
      try {
        await persist();
      } catch {
        // The result below still says what failed; the journal keeps the operation as it was, which a resume retries.
      }
      return resultOf(journal, { ok: false, code: BUNDLE_REFUSAL.OPERATION_FAILED, detail: error?.message ?? null });
    }

    op.status = OPERATION_STATUS.COMPLETED;
    delete op.code;
    journal.targets[op.target] = currentHash(op.target, options, runtime);
    const last = index === journal.operations.length - 1;
    journal.status = last ? BUNDLE_STATUS.COMPLETED : BUNDLE_STATUS.AUTHORIZED;
    delete journal.code;
    try {
      await persist();
    } catch {
      // ⚠️ THE OPERATION RAN AND THE JOURNAL DOES NOT SAY SO. Stop: a resume finds the target already
      // in its applied state and records it then, rather than this run continuing unjournaled.
      return resultOf(journal, { ok: false, code: BUNDLE_REFUSAL.JOURNAL_UNWRITABLE });
    }
  }
  return resultOf(journal, { ok: true });
}

/**
 * Apply a plan the operator has just confirmed.
 *
 * ⚠️ **THE JOURNAL IS WRITTEN BEFORE THE FIRST MUTATION.** If it cannot be, nothing is changed.
 */
export async function executeDecisionBundle(plan, options) {
  const runtime = await resolveRuntime(options);

  return withLock(lockPath(options), async () => {
    const read = loadJournal(options);
    const mismatch = (what) => refuse(BUNDLE_REFUSAL.STATE_MISMATCH, `${what} changed while the operator was deciding, so the approval no longer describes the project. Nothing was changed. Propose the bundle again.`);

    // What the plan saw must still be what is there.
    if (read.state !== plan.priorState || (read.journal?.digest ?? null) !== plan.priorDigest) mismatch("The bundle journal");
    const prefixes = typePrefixes(options.schemas);
    if (plan.highWater.question !== null && peekNextId(options.contentRoot, prefixes.question) !== plan.highWater.question) mismatch("The question ID counter");
    if (peekNextId(options.contentRoot, prefixes.decision) !== plan.highWater.decision) mismatch("The decision ID counter");
    for (const [target, expected] of Object.entries(plan.targets))
      if (currentHash(target, options, runtime) !== expected) mismatch(target === STAGE_TARGET ? "The stage document" : target);

    const journal = {
      recordVersion: JOURNAL_RECORD_VERSION,
      stage: plan.stage,
      digest: plan.digest,
      status: BUNDLE_STATUS.AUTHORIZED,
      authorizedAt: options.now ?? new Date().toISOString(),
      ids: { ...plan.ids },
      targets: { ...plan.targets },
      operations: plan.operations.map((op) => ({ ...op, status: OPERATION_STATUS.PENDING })),
    };
    try {
      await writeJournal(options.journal, journal, { validators: options.runtimeValidators, writeFile: options.journalWriteFile });
    } catch (error) {
      if (error instanceof JournalError) refuse(error.code, "The approved bundle could not be journaled, so nothing was changed.");
      throw error;
    }
    return runFrom(journal, 0, options, runtime);
  });
}

/** Has this operation's effect already landed? Asked only of the first incomplete operation, on a resume. */
async function alreadyApplied(op, journal, options, runtime) {
  try {
    if (op.kind === "write-stage-note") {
      const notes = runtime.documents.readWorkingNotes(options.contentRoot, BUNDLE_STAGE);
      return notes.subsections.some((s) => s.name === op.args.subsection && s.title === op.args.title && s.content === op.args.content);
    }
    const path = artifactPath(options, op.target);
    if (!existsSync(path)) return false;
    const onDisk = JSON.parse(readFileSync(path, "utf-8"));
    const outcome = await runOperation(op, journal, options, runtime, { dryRun: true });
    return canonicalJson(outcome.artifact) === canonicalJson(onDisk);
  } catch {
    return false;
  }
}

/**
 * Continue the authorised journal from its first incomplete operation. No confirmation is asked.
 *
 * ⚠️ **THE PROJECT MUST STILL BE WHERE THE JOURNAL LEFT IT.** Every target's hash is compared first.
 * One difference is allowed: the first incomplete operation may already have landed, when a crash
 * came after its write and before its journal entry. Anything else blocks the bundle and spends the
 * authorisation, and the operator is asked again.
 */
export async function resumeDecisionBundle(digest, options) {
  const runtime = await resolveRuntime(options);

  return withLock(lockPath(options), async () => {
    const read = loadJournal(options);
    if (read.state !== JOURNAL_READ.VALID) refuse(BUNDLE_REFUSAL.JOURNAL_UNREADABLE, "The bundle journal could not be read or validated, so nothing can be resumed from it. Nothing was changed.");
    const journal = read.journal;
    if (!isResumable(journal)) refuse(BUNDLE_REFUSAL.NOTHING_TO_RESUME, "No approved decision bundle is waiting to be resumed.");
    if (journal.digest !== digest) refuse(BUNDLE_REFUSAL.DIGEST_MISMATCH, "That digest is not the approved bundle's. Nothing was changed.", { checkpoint: checkpointOf(journal) });

    const persist = () => writeJournal(options.journal, journal, { validators: options.runtimeValidators, writeFile: options.journalWriteFile });
    let start = firstIncomplete(journal);

    for (const [target, expected] of Object.entries(journal.targets)) {
      let actual;
      try {
        actual = currentHash(target, options, runtime);
      } catch {
        actual = undefined;
      }
      if (actual === expected) continue;

      const op = start === null ? null : journal.operations[start];
      if (op && op.target === target && (await alreadyApplied(op, journal, options, runtime))) {
        op.status = OPERATION_STATUS.COMPLETED;
        delete op.code;
        journal.targets[target] = actual;
        start = firstIncomplete(journal);
        continue;
      }

      if (op) {
        op.status = OPERATION_STATUS.BLOCKED;
        op.code = BUNDLE_REFUSAL.STATE_MISMATCH;
      }
      journal.status = BUNDLE_STATUS.BLOCKED;
      journal.code = BUNDLE_REFUSAL.STATE_MISMATCH;
      try {
        await persist();
      } catch {
        // The refusal stands whether or not the journal could record it.
      }
      return resultOf(journal, { ok: false, code: BUNDLE_REFUSAL.STATE_MISMATCH });
    }

    if (start === null) {
      journal.status = BUNDLE_STATUS.COMPLETED;
      delete journal.code;
      try {
        await persist();
      } catch {
        return resultOf(journal, { ok: false, code: BUNDLE_REFUSAL.JOURNAL_UNWRITABLE });
      }
      return resultOf(journal, { ok: true });
    }
    return runFrom(journal, start, options, runtime);
  });
}
