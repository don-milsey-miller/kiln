/**
 * The session recovery request - #178.
 *
 *   <local-state>/runtime/recovery-request.json
 *
 * Kiln's extension runs inside Pi and cannot be the one to change which session the project records: that record
 * is the supervisor's, written under the session lock. So when a session cannot go on, or the operator asks for a
 * new one, the extension leaves this request and asks Pi to shut down. The supervisor reads it after the agent
 * exits, mints and records a new session, and starts Pi on that.
 *
 * ⚠️ **BOUND TO THE RUN, AND CONSUMED ONCE.** A request carries the supervisor's run id. `takeRecoveryRequest`
 * removes the file before it decides anything, so a request is read at most once, and one from another run is
 * reported as stale and never acted on.
 *
 * ⚠️ **A FIXED REASON, VALIDATED ON THE WAY IN AND ON THE WAY OUT.** Nothing free-form is written, so nothing a
 * model, a prompt or an error said can reach the supervisor through this file.
 */

import { existsSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";

import { atomicWrite } from "./atomic-write.mjs";
import { journalProtected } from "./decision-bundle-journal.mjs";
import { RECORD, STATE_MODE, projectRecordState, stateRootFor } from "./local-state.mjs";
import { createRuntimeValidators } from "./runtime-records.mjs";

export const RECOVERY_REQUEST_FILE = "recovery-request.json";
export const RECOVERY_REQUEST_KIND = "recovery-request";
export const RECOVERY_REQUEST_VERSION = 1;
/** Far above the record's real size. Anything larger is not a request and is not parsed. */
const MAX_REQUEST_BYTES = 1024;

export const RECOVERY_REASON = Object.freeze({
  OPERATOR_NEW_SESSION: "operator-new-session",
  COMPACTION_FAILED: "compaction-failed",
  BOUNDARY_INVALID: "compaction-boundary-invalid",
  INPUT_EXCEEDS: "input-exceeds-context-window",
});
const REASONS = new Set(Object.values(RECOVERY_REASON));

/** Whether Kiln started this recovery itself. The operator's own request for a new session is not one of these. */
export const isAutomaticRecovery = (reason) => REASONS.has(reason) && reason !== RECOVERY_REASON.OPERATOR_NEW_SESSION;

/** How many failure-driven recoveries one supervisor launch may make before it stops instead. */
export const MAX_AUTOMATIC_RECOVERIES = 1;

export const RECOVERY_TAKE = Object.freeze({ NONE: "none", ACCEPTED: "accepted", STALE: "stale", INVALID: "invalid" });

/** The variables Kiln's supervisor sets for the agent. */
const PROJECT_ROOT_ENV = "KILN_PROJECT_ROOT";
const STATE_MODE_ENV = "KILN_STATE_MODE";
const RUN_ID_ENV = "KILN_RUN_ID";
const RUN_ID = /^[0-9a-f]{32}$/;

let cachedValidators = null;
const validatorsFor = (supplied) => supplied ?? (cachedValidators ??= createRuntimeValidators());

/**
 * Ask the supervisor for a new session, from inside the agent it started.
 *
 * Returns `{written: true}` or `{written: false, code}`. It never throws: a recovery that cannot be requested is
 * a fact for the caller to report, not a second failure.
 *
 * @param {string} reason one of `RECOVERY_REASON`
 * @param {{env?: object, validators?: object, now?: () => Date, writeFile?: Function}} [options]
 */
export async function requestRecovery(reason, { env = process.env, validators, now = () => new Date(), writeFile = atomicWrite } = {}) {
  if (!REASONS.has(reason)) return { written: false, code: "recovery-reason-unknown" };
  const runId = env[RUN_ID_ENV];
  const projectRoot = env[PROJECT_ROOT_ENV];
  // ⚠️ NO SUPERVISOR, NO REQUEST. Outside a supervised run nobody would read it, and the file would wait for a
  // later run to find.
  if (typeof runId !== "string" || !RUN_ID.test(runId) || typeof projectRoot !== "string" || projectRoot.length === 0) return { written: false, code: "recovery-not-supervised" };

  let location;
  try {
    const stateMode = env[STATE_MODE_ENV] ?? STATE_MODE.PROJECT;
    let projectId = null;
    if (stateMode === STATE_MODE.USER) {
      const project = projectRecordState(projectRoot);
      if (project.kind !== RECORD.VALID) return { written: false, code: "recovery-state-unavailable" };
      projectId = project.record.projectId;
    }
    const roots = stateRootFor({ mode: stateMode, projectRoot, projectId, env });
    location = { projectRoot, stateMode, roots, runtime: roots.runtime, path: join(roots.runtime, RECOVERY_REQUEST_FILE), git: "git" };
  } catch {
    return { written: false, code: "recovery-state-unavailable" };
  }
  // The same protection the bundle journal asks for: the runtime directory exists and is kept out of the repository.
  if (!journalProtected(location, { verifyGit: false })) return { written: false, code: "recovery-state-unavailable" };

  const record = { recordVersion: RECOVERY_REQUEST_VERSION, runId, reason, requestedAt: now().toISOString() };
  if (!validatorsFor(validators)[RECOVERY_REQUEST_KIND](record)) return { written: false, code: "recovery-request-invalid" };
  try {
    await writeFile(location.path, JSON.stringify(record, null, 2) + "\n");
  } catch {
    return { written: false, code: "recovery-request-unwritable" };
  }
  return { written: true };
}

/**
 * Read the request for this run, and remove it whatever it says.
 *
 * ⚠️ **REMOVED FIRST.** The file is gone before its contents are judged, so no path through this function leaves
 * a request to be read a second time.
 *
 * @param {{runtimeDir: string, runId: string, validators?: object}} args
 * @returns {{state: string, reason?: string}}
 */
export function takeRecoveryRequest({ runtimeDir, runId, validators }) {
  const path = join(runtimeDir, RECOVERY_REQUEST_FILE);
  if (!existsSync(path)) return { state: RECOVERY_TAKE.NONE };
  let text = null;
  try {
    if (statSync(path).isFile() && statSync(path).size <= MAX_REQUEST_BYTES) text = readFileSync(path, "utf-8");
  } catch {
    text = null;
  }
  try {
    unlinkSync(path);
  } catch {
    // ⚠️ A REQUEST THAT CANNOT BE REMOVED IS NOT ACTED ON: it could be acted on again.
    return { state: RECOVERY_TAKE.INVALID };
  }
  if (text === null) return { state: RECOVERY_TAKE.INVALID };

  let record;
  try {
    record = JSON.parse(text);
  } catch {
    return { state: RECOVERY_TAKE.INVALID };
  }
  if (!validatorsFor(validators)[RECOVERY_REQUEST_KIND](record) || record.recordVersion !== RECOVERY_REQUEST_VERSION) return { state: RECOVERY_TAKE.INVALID };
  if (record.runId !== runId) return { state: RECOVERY_TAKE.STALE };
  return { state: RECOVERY_TAKE.ACCEPTED, reason: record.reason };
}
