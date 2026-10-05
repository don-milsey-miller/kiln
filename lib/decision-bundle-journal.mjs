/**
 * The Stage 4 decision bundle's operation journal - #173.
 *
 *   <local-state>/runtime/decision-bundle-journal.json
 *
 * One approval authorises several typed writes. The journal is what makes that approval survive a
 * crash or a compaction between two of them: it is written before the first project mutation and
 * after every operation, so a later invocation can tell which operations ran and continue from the
 * first that did not, without asking the operator again.
 *
 * ⚠️ **IT LIVES IN KILN'S RUNTIME STATE, NOT IN `planning-content`.** An authorisation is one
 * operator's answer on one computer. Planning content is committed and cloned; a journal there would
 * hand a clone an approval nobody on that computer gave. The location is derived exactly as the
 * consent record's is, and the same two protections are asked of it: the project's ignore coverage,
 * and Git's own answer about the record's path.
 *
 * ⚠️ **NOTHING IS CREATED.** A missing runtime directory is setup's to make. Without one the journal
 * cannot be kept, and a bundle whose journal cannot be kept is refused before anything changes.
 *
 * ⚠️ **A FAILURE IS A CODE, NEVER A MESSAGE.** The journal holds the approved operation arguments
 * and stable codes. No error text, path, tool result or retrieved page enters it.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { atomicWrite } from "./atomic-write.mjs";
import { gitProtection, GIT } from "./consent-record.mjs";
import { RECORD, STATE_MODE, coverageState, projectRecordState, stateRootFor } from "./local-state.mjs";
import { createRuntimeValidators } from "./runtime-records.mjs";

export const JOURNAL_RECORD = join("runtime", "decision-bundle-journal.json");
export const JOURNAL_RECORD_VERSION = 1;
export const JOURNAL_KIND = "decision-bundle-journal";

/** The variables Kiln's supervisor sets for the agent, as `lib/research/permission.mjs` reads them. */
const PROJECT_ROOT_ENV = "KILN_PROJECT_ROOT";
const STATE_MODE_ENV = "KILN_STATE_MODE";

export const BUNDLE_STATUS = Object.freeze({
  AUTHORIZED: "authorized",
  COMPLETED: "completed",
  FAILED: "failed",
  BLOCKED: "blocked",
});

export const OPERATION_STATUS = Object.freeze({
  PENDING: "pending",
  COMPLETED: "completed",
  FAILED: "failed",
  BLOCKED: "blocked",
});

/** What the record on disk is. Only `valid` in a protected place can be resumed. */
export const JOURNAL_READ = Object.freeze({
  ABSENT: "absent",
  VALID: "valid",
  INVALID: "invalid",
  INACCESSIBLE: "inaccessible",
  UNPROTECTED: "unprotected",
});

export const JOURNAL_REFUSAL = Object.freeze({
  UNAVAILABLE: "bundle-journal-unavailable",
  UNREADABLE: "bundle-journal-unreadable",
  UNWRITABLE: "bundle-journal-unwritable",
});

/** A failure to locate or keep the journal. The cause is for a developer and never for a model. */
export class JournalError extends Error {
  constructor(code, { cause } = {}) {
    super(code, cause === undefined ? undefined : { cause });
    this.name = "JournalError";
    this.code = code;
  }
}

let cachedValidators = null;
const validatorsFor = (supplied) => supplied ?? (cachedValidators ??= createRuntimeValidators());

/** @param {{projectRoot: string, stateMode?: string, projectId?: string|null, platform?: string, env?: object, home?: string, git?: string}} where */
export function journalLocation({ projectRoot, stateMode = STATE_MODE.PROJECT, projectId = null, platform, env, home, git = "git" }) {
  const roots = stateRootFor({ mode: stateMode, projectRoot, projectId, platform, env, home });
  return Object.freeze({ projectRoot, stateMode, roots, runtime: roots.runtime, path: join(roots.root, JOURNAL_RECORD), git });
}

/**
 * The journal's place for a Pi started by Kiln's supervisor, or `null` when no project was named.
 *
 * ⚠️ **THE PROJECT IS NAMED, NOT GUESSED.** Without `KILN_PROJECT_ROOT` there is no state root to
 * derive, and the working directory is not consulted.
 */
export function journalLocationFromEnv(env = process.env, { validators } = {}) {
  const projectRoot = env[PROJECT_ROOT_ENV];
  if (typeof projectRoot !== "string" || projectRoot.length === 0) return null;
  const stateMode = env[STATE_MODE_ENV] ?? STATE_MODE.PROJECT;
  try {
    let projectId = null;
    if (stateMode === STATE_MODE.USER) {
      const project = projectRecordState(projectRoot, { validators });
      if (project.kind !== RECORD.VALID) throw new JournalError(JOURNAL_REFUSAL.UNAVAILABLE);
      projectId = project.record.projectId;
    }
    return journalLocation({ projectRoot, stateMode, projectId, env });
  } catch (cause) {
    if (cause instanceof JournalError) throw cause;
    throw new JournalError(JOURNAL_REFUSAL.UNAVAILABLE, { cause });
  }
}

/**
 * Is the journal's place usable and kept out of every repository right now?
 * `verifyGit: false` asks the ignore file only.
 */
export function journalProtected(location, { verifyGit = true } = {}) {
  if (!existsSync(location.runtime)) return false;
  let covered = false;
  try {
    covered = coverageState({ projectRoot: location.projectRoot, mode: location.stateMode, roots: location.roots }).covered === true;
  } catch {
    covered = false;
  }
  if (!covered) return false;
  if (!verifyGit) return true;
  const git = gitProtection(location).state;
  return git === GIT.IGNORED || git === GIT.NO_REPOSITORY;
}

/**
 * Read the journal. Never writes.
 *
 * `verifyGit: false` skips the three Git questions. It is for a reader that only describes the
 * journal - the compaction checkpoint and the stage frame - and never for one that resumes it.
 *
 * @returns {{state: string, journal: object|null}}
 */
export function readJournal(location, { validators, verifyGit = true } = {}) {
  if (!existsSync(location.path)) return { state: JOURNAL_READ.ABSENT, journal: null };
  // ⚠️ NOT EVEN OPENED. A journal in a place Git would carry is not this host's to resume.
  if (!journalProtected(location, { verifyGit })) return { state: JOURNAL_READ.UNPROTECTED, journal: null };

  let text;
  try {
    text = readFileSync(location.path, "utf-8");
  } catch (e) {
    if (e?.code === "ENOENT") return { state: JOURNAL_READ.ABSENT, journal: null };
    return { state: JOURNAL_READ.INACCESSIBLE, journal: null };
  }

  let doc;
  try {
    doc = JSON.parse(text);
  } catch {
    return { state: JOURNAL_READ.INVALID, journal: null };
  }
  const validate = validatorsFor(validators)[JOURNAL_KIND];
  if (!validate(doc) || doc.recordVersion !== JOURNAL_RECORD_VERSION) return { state: JOURNAL_READ.INVALID, journal: null };
  // ⚠️ THE DIGEST IS RECOMPUTED, NOT BELIEVED. An edited operation under an unedited digest is a
  // bundle nobody approved.
  if (bundleDigest(doc) !== doc.digest) return { state: JOURNAL_READ.INVALID, journal: null };
  return { state: JOURNAL_READ.VALID, journal: doc };
}

/**
 * Replace the journal atomically. The caller holds the content lock, which serialises every bundle.
 *
 * ⚠️ **THE CALLER PROVES THE PLACE FIRST.** `journalProtected` is asked once per lock hold rather
 * than before each write, because it asks Git three questions and a bundle writes after every operation.
 *
 * @param {{validators?: object, writeFile?: Function}} [opts] `writeFile` replaces `atomicWrite`, for tests that need a write to fail.
 */
export async function writeJournal(location, journal, { validators, writeFile = atomicWrite } = {}) {
  if (!existsSync(location.runtime)) throw new JournalError(JOURNAL_REFUSAL.UNAVAILABLE);
  const validate = validatorsFor(validators)[JOURNAL_KIND];
  if (!validate(journal)) throw new JournalError(JOURNAL_REFUSAL.UNWRITABLE);
  try {
    await writeFile(location.path, JSON.stringify(journal, null, 2) + "\n");
  } catch (cause) {
    throw new JournalError(JOURNAL_REFUSAL.UNWRITABLE, { cause });
  }
}

/** JSON with every object's keys in code-unit order, so equal values have equal bytes. */
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

/**
 * The authorisation digest: the stage, the exact reserved ids, and every operation in order.
 *
 * ⚠️ **STATUS IS NOT PART OF IT.** Progress changes; what was approved does not.
 */
export function bundleDigest({ stage, ids, operations }) {
  const approved = { version: 1, stage, ids, operations: operations.map(({ kind, target, args }) => ({ kind, target, args })) };
  return `sha256:${createHash("sha256").update(canonicalJson(approved), "utf8").digest("hex")}`;
}

/** Authorised and not finished: the two states a later invocation may continue. */
export const isResumable = (journal) => journal?.status === BUNDLE_STATUS.AUTHORIZED || journal?.status === BUNDLE_STATUS.FAILED;

/** The first operation that has not completed, or `null` when all have. */
export function firstIncomplete(journal) {
  const index = journal.operations.findIndex((op) => op.status !== OPERATION_STATUS.COMPLETED);
  return index === -1 ? null : index;
}

/**
 * What may leave the journal for a model or a compaction entry.
 *
 * ⚠️ **IDENTIFIERS, STATUSES AND CODES ONLY.** Every field here is one the record's schema holds to
 * a pattern or an enum. Operation arguments - the approved wording - are deliberately absent.
 */
export function checkpointOf(journal) {
  return {
    checkpointVersion: 1,
    stage: journal.stage,
    digest: journal.digest,
    status: journal.status,
    ...(journal.code ? { code: journal.code } : {}),
    ids: { question: journal.ids.question, decision: journal.ids.decision },
    firstIncomplete: firstIncomplete(journal),
    operations: journal.operations.map((op, index) => ({
      index,
      kind: op.kind,
      target: op.target,
      status: op.status,
      ...(op.code ? { code: op.code } : {}),
    })),
  };
}
