/**
 * The operator-boundary audit file - TSK-0050, toward ACC-0070.
 *
 * Three operations are the operator's and not the orchestrator's: attesting a stage exit criterion,
 * approving an artifact, and activating or deactivating an artifact type. When one of them is refused
 * because the operator did not authorise it, the refusal has to survive the turn. A refusal that exists
 * only in the transcript is a refusal nobody can audit: the transcript is the model's own account of
 * what happened, and it is exactly the surface a prompted model would be shaping.
 *
 *   planning-content/state/operator-boundary-refusals.json
 *
 * ⚠️ **THIS MODULE KNOWS NOTHING ABOUT PI.** The confirmation itself happens in the package wrapper,
 * because `ctx.ui` is Pi's and `lib/` is also used by the CLI, the tests and the browser app. What lives
 * here is the record and its bounds, which every one of those callers needs and none of them should
 * re-derive.
 *
 * ⚠️ **ONLY VALIDATED IDENTIFIERS AND ENUMS ENTER THE FILE.** Never a path, an argument, a reason, the
 * operator's wording, the model's wording, a credential or transcript content. A field that does not
 * match its pattern is DROPPED, not stored and not escaped: an audit file is read by people and by the
 * status tool, and a single unvalidated string in it is a channel out of the sandbox. A record whose
 * `target` ends up empty is still a valid record - that an attempt was refused is the fact being kept.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const OPERATOR_BOUNDARY_FILE = join("state", "operator-boundary-refusals.json");

/**
 * The actor recorded when the operator DID authorise the act.
 *
 * ⚠️ It is Kiln's own constant and never a model argument. `decidedBy` and `approvedBy` leave the
 * model-facing schemas precisely so that no string a model composed can end up in an attestation
 * claiming a person decided something.
 */
export const OPERATOR_ACTOR = "operator via Pi UI";

/**
 * One code for every way authorisation was not granted.
 *
 * ⚠️ **PI RETURNS THE SAME `false` FOR ALL OF THEM.** With no UI bound, `confirm` is `async () => false`;
 * in RPC mode a cancelled dialog and an expired timeout resolve through the same path; an abort resolves
 * the same way again. The SDK's own timed-confirm example labels the outcome "Cancelled or timed out"
 * for that reason. A code claiming to separate rejection from timeout would be a distinction Kiln
 * invented rather than observed, and an audit file is the worst place to keep one.
 */
export const BOUNDARY_REFUSAL_CODE = "operator-confirmation-not-granted";

/** What the caller reports when the refusal stands but the record could not be written (D37). */
export const BOUNDARY_REFUSAL_UNRECORDED = "operator-boundary-refusal-unrecorded";

/** The operations this boundary covers. The audit file stores one of these three and nothing else. */
export const BOUNDARY_OPERATION = Object.freeze({
  ATTEST_STAGE: "write-stage-attestation",
  SET_REVIEW_STATUS: "set-review-status",
  SET_TYPE_ACTIVATION: "set-type-activation",
});

const OPERATIONS = new Set(Object.values(BOUNDARY_OPERATION));

/** Newest-100. The file is an audit trail, not a log: it must stay small enough to read and to carry. */
export const MAX_REFUSALS = 100;

/** How a reader describes the file, mirroring the intake block's four states rather than inventing a fifth vocabulary. */
export const BOUNDARY_STATE = Object.freeze({
  RECORDED: "recorded",
  EMPTY: "empty",
  ABSENT: "absent",
  INVALID: "invalid",
});

export const BOUNDARY_RECORD_REFUSAL = Object.freeze({
  UNREADABLE: "boundary-record-unreadable",
  UNWRITABLE: "boundary-record-unwritable",
});

/** A failure to KEEP the record. The refusal it was recording still stands; only the audit entry is lost. */
export class BoundaryRecordError extends Error {
  constructor(code, { cause } = {}) {
    super(code, cause === undefined ? undefined : { cause });
    this.name = "BoundaryRecordError";
    this.code = code;
  }
}

export const FILE_VERSION = 1;

/**
 * Every field a `target` may carry, and the exact shape each one must have.
 *
 * ⚠️ **PATTERNS RATHER THAN CATALOGUE MEMBERSHIP, DELIBERATELY.** Checking `artifactType` against the
 * schema catalogue would be more accurate and would make this module load the schema set, giving the
 * audit writer a dependency and a failure mode of its own - in a module whose entire job is to keep a
 * record when something has already gone wrong. The patterns below are what the record actually needs:
 * a lowercase identifier cannot carry a path separator, a drive letter, a space or a sentence. An
 * attempt naming a type that does not exist is still a fact worth recording accurately.
 */
const TARGET_FIELDS = Object.freeze({
  stageId: /^[0-9]{2}-[a-z0-9-]+$/,
  criterion: /^[a-z0-9-]+$/,
  artifactType: /^[a-z][a-z0-9-]*$/,
  artifactId: /^[A-Z]{3}-[0-9]{4,}$/,
  type: /^[a-z][a-z0-9-]*$/,
  action: /^(?:activate|deactivate)$/,
});

/** A second, blunt bound beside the patterns: no identifier Kiln uses comes near it. */
const MAX_FIELD_LENGTH = 64;

const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/**
 * The subset of `target` that may be written down.
 *
 * @param {unknown} target
 * @returns {Record<string, string>}
 */
export function cleanTarget(target) {
  if (target === null || typeof target !== "object" || Array.isArray(target)) return {};
  const out = {};
  // Iterate the DECLARED fields, not the caller's keys: an unknown key is then impossible rather than
  // merely rejected, and the written order is Kiln's rather than the caller's.
  for (const [field, pattern] of Object.entries(TARGET_FIELDS)) {
    const value = target[field];
    if (typeof value !== "string" || value.length === 0 || value.length > MAX_FIELD_LENGTH) continue;
    if (pattern.test(value)) out[field] = value;
  }
  return out;
}

/** Whether a record read back from the file is one this module could have written. */
function validEntry(entry) {
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return false;
  const keys = Object.keys(entry).sort();
  if (keys.join(",") !== "code,occurredAt,operation,target") return false;
  if (typeof entry.occurredAt !== "string" || !ISO_INSTANT.test(entry.occurredAt)) return false;
  if (!OPERATIONS.has(entry.operation)) return false;
  if (entry.code !== BOUNDARY_REFUSAL_CODE) return false;
  if (entry.target === null || typeof entry.target !== "object" || Array.isArray(entry.target)) return false;
  // A stored target must be exactly what `cleanTarget` would produce for it: same keys, same values,
  // same order. Anything else means the file was written by something other than this module.
  return JSON.stringify(cleanTarget(entry.target)) === JSON.stringify(entry.target);
}

export function operatorBoundaryPath(contentRoot) {
  if (typeof contentRoot !== "string" || contentRoot.length === 0)
    throw new TypeError("operatorBoundaryPath needs a content root.");
  return join(contentRoot, OPERATOR_BOUNDARY_FILE);
}

/**
 * Read the audit file.
 *
 * ⚠️ **IT NEVER THROWS FOR THE FILE'S OWN CONTENT.** Absent, empty, malformed and well-formed are four
 * states a caller reports, not four errors. `invalid` covers an unparseable file, a wrong envelope and
 * an entry this module could not have written - the last because a tampered entry is exactly what an
 * audit file must not present as genuine.
 *
 * @param {string} contentRoot
 * @returns {{state: string, total: number, refusals: Array<object>}}
 */
export function readBoundaryRefusals(contentRoot) {
  const path = operatorBoundaryPath(contentRoot);
  if (!existsSync(path)) return { state: BOUNDARY_STATE.ABSENT, total: 0, refusals: [] };

  let record;
  try {
    record = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return { state: BOUNDARY_STATE.INVALID, total: 0, refusals: [] };
  }

  const invalid = { state: BOUNDARY_STATE.INVALID, total: 0, refusals: [] };
  if (record === null || typeof record !== "object" || Array.isArray(record)) return invalid;
  if (record.version !== FILE_VERSION) return invalid;
  if (!Array.isArray(record.refusals)) return invalid;
  if (record.refusals.length > MAX_REFUSALS) return invalid;
  if (!record.refusals.every(validEntry)) return invalid;

  return {
    state: record.refusals.length === 0 ? BOUNDARY_STATE.EMPTY : BOUNDARY_STATE.RECORDED,
    total: record.refusals.length,
    refusals: record.refusals,
  };
}

/**
 * Append one refusal, oldest-first order preserved, bounded at `MAX_REFUSALS`.
 *
 * ⚠️ **THE SAME WRITE DISCIPLINE AS EVERY OTHER PLANNING WRITE**: the project lock, a fresh read inside
 * it, then an atomic write. The audit file is shared state and two refusals can land together.
 *
 * ⚠️ **AN EXISTING INVALID FILE REFUSES RATHER THAN BEING REPLACED.** Appending to a file this module
 * cannot vouch for would either drop its contents or bless them. Neither is a thing an audit trail may
 * do quietly, so the caller is told the record could not be kept and the refusal it describes stands.
 *
 * @param {string} contentRoot
 * @param {{operation: string, target?: object, now?: string}} entry
 * @returns {Promise<{occurredAt: string, operation: string, code: string, target: object}>}
 */
export async function recordBoundaryRefusal(contentRoot, { operation, target, now } = {}) {
  // A bad operation is a defect in Kiln, not a state of the project: it must not be written down and it
  // must not be quietly tolerated.
  if (!OPERATIONS.has(operation))
    throw new TypeError(`Unknown operator-boundary operation: ${JSON.stringify(operation)}.`);
  if (now !== undefined && !(typeof now === "string" && ISO_INSTANT.test(now)))
    throw new TypeError("`now` must be an ISO instant with milliseconds.");

  const { withLock } = await import("./lock.mjs");
  const { atomicWrite } = await import("./atomic-write.mjs");
  const { mkdirSync } = await import("node:fs");
  const { dirname } = await import("node:path");
  const { LOCK_FILE } = await import("./tools/create-artifact.mjs");

  const path = operatorBoundaryPath(contentRoot);
  const written = {
    occurredAt: now ?? new Date().toISOString(),
    operation,
    code: BOUNDARY_REFUSAL_CODE,
    target: cleanTarget(target),
  };

  // ⚠️ **EVERY WAY THE RECORD CAN FAIL IS ONE TYPED ERROR (D37).** Acquiring the lock is a failure path
  // too: a held lock, a stale holder, a nested acquisition. Those escape `withLock` as its own error
  // carrying an absolute lock path, and a caller that classified by class would miss them and let the raw
  // message through. The refusal being recorded still stands whichever of these happens; only the audit
  // entry is lost, which is exactly what `UNWRITABLE` says.
  try {
    return await withLock(join(contentRoot, LOCK_FILE), async () => {
      const existing = readBoundaryRefusals(contentRoot); // fresh, inside the lock
      if (existing.state === BOUNDARY_STATE.INVALID)
        throw new BoundaryRecordError(BOUNDARY_RECORD_REFUSAL.UNREADABLE);

      // ⚠️ Trim from the FRONT. The newest refusal is the one a reader came for, and dropping the newest
      // to protect the oldest would make the file most useless exactly when it is busiest.
      const refusals = [...existing.refusals, written].slice(-MAX_REFUSALS);
      mkdirSync(dirname(path), { recursive: true });
      await atomicWrite(path, JSON.stringify({ version: FILE_VERSION, refusals }, null, 2) + "\n");
      return written;
    });
  } catch (cause) {
    // ⚠️ An already-typed refusal keeps its own code: `UNREADABLE` says the existing file could not be
    // vouched for, which is a different thing to report than a write that failed.
    if (cause instanceof BoundaryRecordError) throw cause;
    // ⚠️ The cause is kept for a developer and never returned to a model: it carries an absolute path.
    throw new BoundaryRecordError(BOUNDARY_RECORD_REFUSAL.UNWRITABLE, { cause });
  }
}
