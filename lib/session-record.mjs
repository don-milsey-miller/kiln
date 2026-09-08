/**
 * Which Kiln session a rerun returns to — CMP-0037, against ACC-0103.
 *
 * ⚠️ **"THE AGENT STARTED" IS NOT "THE SESSION RESUMED", AND THAT IS THE WHOLE POINT.** A brand-new
 * unrelated session starts just as successfully as the right one, and to an operator returning to
 * their planning conversation the two look identical until the context is missing. So what is
 * recorded, and what is asserted, is the IDENTIFIER the agent was invoked with — matched against the
 * one stored — never the fact that a process came up.
 *
 * ⚠️ **A RECORD THAT CANNOT BE TRUSTED IS A QUESTION, NOT A DEFAULT.** Missing, unreadable, invalid,
 * or naming a session that is no longer there: each of those has an obvious cheap answer — start a
 * fresh one — and that answer silently discards the thing the operator came back for. The available
 * sessions are presented instead, and a non-interactive run refuses.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { assertValidRecord, createRuntimeValidators } from "./runtime-records.mjs";

export const SESSION_RECORD = join("runtime", "kiln-session.json");

/** What a caller must do about the session, and why — never a bare session id. */
export const SESSION = {
  START: "start",
  RESUME: "resume",
  ASK: "ask",
};

export const SESSION_PROBLEM = {
  NONE: "none",
  MISSING: "no session record",
  UNREADABLE: "the session record is not readable JSON",
  INVALID: "the session record does not match its schema",
  FOREIGN: "the session record belongs to a different project",
  GONE: "the recorded session no longer exists",
  MODE_CHANGED: "the session was recorded under a different state mode",
  STORAGE_UNREADABLE: "the session storage could not be inspected",
};

/** How the session storage answered. ⚠️ "I could not look" is not "there is nothing there". */
export const STORAGE = {
  LISTED: "listed",
  ABSENT: "absent",
  UNREADABLE: "unreadable",
  NOT_A_DIRECTORY: "not-a-directory",
};

/**
 * Every session this state root actually holds, newest first.
 *
 * ⚠️ Read from the directory rather than remembered, because the answer this is used for — "which
 * sessions could the operator have meant" — is a question about what is there NOW.
 */
export function availableSessions(sessionDir) {
  if (!sessionDir) return { state: STORAGE.ABSENT, sessions: [] };
  let stat = null;
  try {
    stat = statSync(sessionDir);
  } catch (e) {
    // ⚠️ ENOENT IS A REAL ANSWER — nothing is stored — and every other code is NOT an answer.
    return e?.code === "ENOENT"
      ? { state: STORAGE.ABSENT, sessions: [] }
      : { state: STORAGE.UNREADABLE, sessions: [], code: e?.code ?? "unknown" };
  }
  if (!stat.isDirectory()) return { state: STORAGE.NOT_A_DIRECTORY, sessions: [] };

  let entries;
  try {
    entries = readdirSync(sessionDir, { withFileTypes: true });
  } catch (e) {
    return { state: STORAGE.UNREADABLE, sessions: [], code: e?.code ?? "unknown" };
  }

  const sessions = entries
    .filter((e) => e.isFile() || e.isDirectory())
    .map((e) => {
      const path = join(sessionDir, e.name);
      let mtimeMs = 0;
      try {
        mtimeMs = statSync(path).mtimeMs;
      } catch {}
      return { id: e.name.replace(/\.[^.]+$/, ""), mtimeMs };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  return { state: STORAGE.LISTED, sessions };
}

/** Where sessions live for a mode. Derived here so no caller can forget to pass it. */
export function sessionDirFor(stateRoot) {
  return join(stateRoot, "sessions");
}

/**
 * Decide what this run should do about the session, from the record on disk.
 *
 * ⚠️ **THE ACTIVE MODE IS REQUIRED, BECAUSE THE RECORD NAMES ONE AND IT DECIDES WHERE TO LOOK.** A
 * record written under project-local state and read while running with `--local-state user` points
 * at a session directory that is not the one in use; resuming on the strength of a matching id would
 * name a session from the other store. Comparing only `projectId` and `sessionId` left that route
 * open, and every field along it is individually valid.
 *
 * ⚠️ **THE SESSION DIRECTORY IS DERIVED, NOT PASSED.** As an optional argument its absence silently
 * skipped the existence check — the caller who forgot it got a resume with no proof the session was
 * there. It is derived from the state root, and an override exists only so a test can point at one.
 *
 * @param {{stateRoot: string, projectId: string, stateMode: "project"|"user", sessionDir?: string,
 *          validators?: object}} opts
 * @returns {{action: string, sessionId?: string, problem: string, available: object}}
 */
export function planSession({ stateRoot, projectId, stateMode, sessionDir, validators }) {
  if (stateMode !== "project" && stateMode !== "user")
    throw new TypeError(`planSession needs the ACTIVE state mode ("project" or "user"), got ${JSON.stringify(stateMode)}`);

  const path = join(stateRoot, SESSION_RECORD);
  const storage = availableSessions(sessionDir ?? sessionDirFor(stateRoot));
  const ask = (problem) => ({ action: SESSION.ASK, problem, available: storage });

  // ⚠️ **"I COULD NOT LOOK" IS NOT "THERE IS NOTHING THERE".** Unreadable storage, or a regular file
  // where the session directory should be, used to flatten into an empty list — and an empty list
  // with no record reads as a first run, which starts fresh over sessions nobody could enumerate.
  const inspected = storage.state === STORAGE.LISTED || storage.state === STORAGE.ABSENT;
  if (!inspected) return ask(SESSION_PROBLEM.STORAGE_UNREADABLE);

  // ⚠️ **READ, RATHER THAN ASKED ABOUT.** `existsSync` answers false for a record that is there and
  // cannot be opened — a permissions problem, a broken link — and false was the one answer that
  // could authorise starting fresh. Only ENOENT means "no record"; every other failure means "I
  // could not read the record", which is a question, exactly as it is for the storage above.
  let text = null;
  try {
    text = readFileSync(path, "utf-8");
  } catch (e) {
    if (e?.code !== "ENOENT") return ask(SESSION_PROBLEM.UNREADABLE);
  }

  // ⚠️ NO RECORD AND NO SESSIONS IS A FIRST RUN — the one case where starting fresh discards nothing,
  // and it requires BOTH: the storage successfully inspected and found empty or absent, and no
  // record present.
  if (text === null)
    return storage.sessions.length
      ? ask(SESSION_PROBLEM.MISSING)
      : { action: SESSION.START, problem: SESSION_PROBLEM.MISSING, available: storage };

  let doc;
  try {
    doc = JSON.parse(text);
  } catch {
    return ask(SESSION_PROBLEM.UNREADABLE);
  }
  try {
    assertValidRecord(validators ?? createRuntimeValidators(), "kiln-session", doc, path);
  } catch {
    return ask(SESSION_PROBLEM.INVALID);
  }

  // ⚠️ **THE PROJECT IS CHECKED, BECAUSE A STATE ROOT CAN BE SHARED OR COPIED.** Resuming a session
  // recorded for another project is the exact failure this criterion is about, arriving by the one
  // route where every field is individually valid.
  if (doc.projectId !== projectId) return ask(SESSION_PROBLEM.FOREIGN);
  // ⚠️ AND THE MODE, because it decides WHICH STORE the id refers to.
  if (doc.stateMode !== stateMode) return ask(SESSION_PROBLEM.MODE_CHANGED);

  // A record naming a session that is no longer there is not a resume; it is a question.
  if (!storage.sessions.some((s) => s.id === doc.sessionId)) return ask(SESSION_PROBLEM.GONE);

  return { action: SESSION.RESUME, sessionId: doc.sessionId, problem: SESSION_PROBLEM.NONE, available: storage };
}
