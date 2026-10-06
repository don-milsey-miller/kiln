/**
 * What a replaced session hands to the session that replaces it - #178.
 *
 *   <local-state>/runtime/workflow-carryover.json
 *
 * A new session starts with an empty conversation. The stage and any unfinished decision bundle come back on their
 * own, derived from the project and the journal on every turn. Two things do not: the question or proposal the
 * assistant had open, and which bundle operation completed last. Those are written here by the session that is
 * leaving, and read by the frame of the one that follows.
 *
 * ⚠️ **A CARRIED PROPOSAL IS STILL PENDING.** Nothing here records an approval, and the text is presented to the
 * next session as something the operator has not yet answered.
 *
 * ⚠️ **BOUND TO THE REPLACEMENT SESSION, BY THE SUPERVISOR.** The leaving session does not know which session
 * replaces it: the supervisor mints that id. So the record is written carrying the run's id, and the supervisor
 * stamps the new session's id onto it once that session is recorded. From then on only that session is told what
 * it says, in this launch or a later one, until it has answered once. A record nobody stamped is told to nobody.
 */

import { existsSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";

import { atomicWrite } from "./atomic-write.mjs";
import { journalProtected } from "./decision-bundle-journal.mjs";
import { RECORD, STATE_MODE, projectRecordState, stateRootFor } from "./local-state.mjs";
import { createRuntimeValidators } from "./runtime-records.mjs";

export const CARRYOVER_FILE = "workflow-carryover.json";
export const CARRYOVER_KIND = "workflow-carryover";
export const CARRYOVER_VERSION = 1;
/** The most of a pending question or proposal that is carried, in characters. The schema holds the same number. */
export const CARRYOVER_PENDING_MAX = 4096;
const MAX_RECORD_BYTES = 32 * 1024;

const RUN_ID = /^[0-9a-f]{32}$/;
let cachedValidators = null;
const validatorsFor = (supplied) => supplied ?? (cachedValidators ??= createRuntimeValidators());

/** Where the record lives for the project the supervisor named, or `null` when it named none. */
function located(env) {
  const projectRoot = env.KILN_PROJECT_ROOT;
  if (typeof projectRoot !== "string" || projectRoot.length === 0) return null;
  try {
    const stateMode = env.KILN_STATE_MODE ?? STATE_MODE.PROJECT;
    let projectId = null;
    if (stateMode === STATE_MODE.USER) {
      const project = projectRecordState(projectRoot);
      if (project.kind !== RECORD.VALID) return null;
      projectId = project.record.projectId;
    }
    const roots = stateRootFor({ mode: stateMode, projectRoot, projectId, env });
    return { projectRoot, stateMode, roots, runtime: roots.runtime, path: join(roots.runtime, CARRYOVER_FILE), git: "git" };
  } catch {
    return null;
  }
}

const remove = (path) => {
  try {
    unlinkSync(path);
  } catch {
    // Nothing reads it either way.
  }
};

/** The record at `path` when it is a valid one, `null` when there is none, and `undefined` when it is not valid. */
function load(path, validators) {
  if (!existsSync(path)) return null;
  try {
    if (!statSync(path).isFile() || statSync(path).size > MAX_RECORD_BYTES) return undefined;
    const record = JSON.parse(readFileSync(path, "utf-8"));
    return validatorsFor(validators)[CARRYOVER_KIND](record) && record.recordVersion === CARRYOVER_VERSION ? record : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Write what the next session should be told, from the session that is leaving. Never throws; returns `{written}`.
 *
 * The record carries no session id yet. The supervisor adds it with `bindCarryover`.
 *
 * @param {{reason: string, pending?: {source: string, text: string}|null, lastOperation?: object|null}} carry
 *   `pending.text` must already be bounded and cleaned by the caller, which is the one that knows how.
 */
export async function writeCarryover({ reason, pending = null, lastOperation = null }, { env = process.env, validators, now = () => new Date(), writeFile = atomicWrite } = {}) {
  const runId = env.KILN_RUN_ID;
  const location = typeof runId === "string" && RUN_ID.test(runId) ? located(env) : null;
  if (!location) return { written: false, code: "carryover-not-supervised" };
  if (!journalProtected(location, { verifyGit: false })) return { written: false, code: "carryover-state-unavailable" };
  const record = {
    recordVersion: CARRYOVER_VERSION,
    runId,
    reason,
    createdAt: now().toISOString(),
    ...(pending && typeof pending.text === "string" && pending.text.length > 0 ? { pending: { source: pending.source, text: pending.text.slice(0, CARRYOVER_PENDING_MAX) } } : {}),
    ...(lastOperation ? { lastOperation } : {}),
  };
  if (!validatorsFor(validators)[CARRYOVER_KIND](record)) return { written: false, code: "carryover-invalid" };
  try {
    await writeFile(location.path, JSON.stringify(record, null, 2) + "\n");
  } catch {
    return { written: false, code: "carryover-unwritable" };
  }
  return { written: true };
}

/**
 * Stamp the session that replaces the writer onto the record. The supervisor calls this once it has recorded that
 * session and before it starts Pi on it. Never throws; returns `{bound}`.
 *
 * ⚠️ **ONLY THIS RUN'S, AND ONLY ONE NOT YET BOUND.** A record that is not valid, or that another run left unbound,
 * is removed. A record already bound to a session is that session's and is left alone.
 */
export async function bindCarryover({ runtimeDir, runId, sessionId, validators, writeFile = atomicWrite }) {
  const path = join(runtimeDir, CARRYOVER_FILE);
  const record = load(path, validators);
  if (record === null) return { bound: false };
  if (record === undefined || (record.sessionId === undefined && record.runId !== runId)) {
    remove(path);
    return { bound: false };
  }
  if (record.sessionId !== undefined) return { bound: false };
  const bound = { ...record, sessionId };
  if (!validatorsFor(validators)[CARRYOVER_KIND](bound)) {
    remove(path);
    return { bound: false };
  }
  try {
    await writeFile(path, JSON.stringify(bound, null, 2) + "\n");
  } catch {
    // ⚠️ AN UNBOUND RECORD IS TOLD TO NOBODY, so one that could not be bound is not left to be bound to a later session.
    remove(path);
    return { bound: false };
  }
  return { bound: true };
}

/**
 * Remove a record that was never bound to a session, or is not a record. The supervisor calls this before it
 * starts its first agent: whatever is unbound then was left by a run that ended before its replacement existed.
 * Returns whether anything was removed.
 */
export function discardUnboundCarryover({ runtimeDir, validators }) {
  const path = join(runtimeDir, CARRYOVER_FILE);
  const record = load(path, validators);
  if (record === null || (record !== undefined && record.sessionId !== undefined)) return false;
  remove(path);
  return true;
}

/**
 * Whether a valid carry-over is bound to exactly `sessionId`. Reads only: nothing is removed, whatever is there.
 *
 * Session planning asks this about a recorded session that has no transcript. Pi writes a transcript at a
 * session's first assistant message, and the carry-over is removed at that same message, so a bound record is the
 * supervisor's own evidence that the session it recorded has not yet taken a turn.
 */
export function carryoverBoundTo({ runtimeDir, sessionId, validators }) {
  if (typeof sessionId !== "string" || sessionId.length === 0) return false;
  const record = load(join(runtimeDir, CARRYOVER_FILE), validators);
  return record !== null && record !== undefined && record.sessionId === sessionId;
}

/**
 * The carry-over bound to `sessionId`, or `null`. A file that is not a valid record is removed.
 *
 * ⚠️ **NOT REMOVED BY BEING READ.** The frame is rebuilt on every turn, and the session it is bound to may be
 * closed and started again before it has answered. `clearCarryover` removes it once that session has.
 */
export function readCarryover({ sessionId, env = process.env, validators } = {}) {
  const location = located(env);
  if (!location || typeof sessionId !== "string" || sessionId.length === 0) return null;
  const record = load(location.path, validators);
  if (record === undefined) remove(location.path);
  return record && record.sessionId === sessionId ? record : null;
}

/** Remove the carry-over bound to `sessionId`. Called when that session's first assistant message has completed. */
export function clearCarryover({ sessionId, env = process.env, validators } = {}) {
  if (readCarryover({ sessionId, env, validators }) === null) return false;
  remove(located(env).path);
  return true;
}
