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
 *
 * ⚠️ **THE IDS COME FROM PI, NOT FROM FILENAMES (F121).** Pi stores sessions as
 * `<timestamp>_<uuid>.jsonl`, and the id that matters is inside each file's header — a DIFFERENT value
 * from the uuid in the name. Measured against the pinned 0.84.4: a file named `…_11111111-…` reports
 * `id: 99999999-…`. The earlier implementation derived ids by stripping the extension, so every real
 * recorded session would have been reported as one that no longer exists, and the tests could not see
 * it because their fixtures were named `sess-7f3a.jsonl`. Ids are now asked of Pi's own lister.
 *
 * ⚠️ **AND THE INSPECTION STAYS IN FRONT OF THE LISTER.** Measured: `SessionManager.list` answers `0`
 * for an absent directory, for a regular file where the directory belongs, AND for an empty one. It
 * cannot tell "there is nothing there" from "I could not look", and that difference is the whole of
 * the first-run rule, so it is established here before the lister is asked anything.
 */

import { createHash } from "node:crypto";
import { readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";

import { atomicWrite } from "./atomic-write.mjs";
import { withLock } from "./lock.mjs";
import { assertValidRecord, createRuntimeValidators } from "./runtime-records.mjs";

export const SESSION_RECORD = join("runtime", "kiln-session.json");

/**
 * The lock held while the record is read-modify-written.
 *
 * ⚠️ **NOT THE SETUP TRANSACTION.** That lock owns setup — creating the layout, the ignore block, the
 * committed record — and is held across work that has nothing to do with a launch. Borrowing it here
 * would make every run contend with setup's scope for a single small write, and would put the runtime
 * launch inside a transaction whose failure semantics are about initialisation.
 */
export const SESSION_LOCK = join("runtime", "kiln-session.lock");

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
  INACCESSIBLE: "the session record could not be opened",
  INVALID: "the session record does not match its schema",
  FOREIGN: "the session record belongs to a different project",
  GONE: "the recorded session no longer exists",
  TRANSCRIPT_UNSUPPORTED: "the recorded session's transcript cannot be opened unchanged",
  MODE_CHANGED: "the session was recorded under a different state mode",
  STORAGE_UNREADABLE: "the session storage could not be inspected",
  LISTER_FAILED: "the session storage could not be listed",
  NO_RUNTIME_DIR: "the runtime directory does not exist",
  WRITE_FAILED: "the session record could not be written",
};

/**
 * The problems an operator can resolve by choosing: a listed session, a new one, or cancel.
 *
 * ⚠️ **NOT THE TWO WHERE KILN COULD NOT LOOK.** Storage that could not be inspected has no list to choose from,
 * and a record that could not be opened may be perfectly valid; replacing either would overwrite something
 * nobody has seen. Those refuse in every mode.
 */
export const RECOVERABLE_PROBLEMS = Object.freeze([
  SESSION_PROBLEM.MISSING,
  SESSION_PROBLEM.UNREADABLE,
  SESSION_PROBLEM.INVALID,
  SESSION_PROBLEM.FOREIGN,
  SESSION_PROBLEM.MODE_CHANGED,
  SESSION_PROBLEM.GONE,
  SESSION_PROBLEM.TRANSCRIPT_UNSUPPORTED,
]);

/** How the session storage answered. ⚠️ "I could not look" is not "there is nothing there". */
export const STORAGE = {
  LISTED: "listed",
  ABSENT: "absent",
  UNREADABLE: "unreadable",
  NOT_A_DIRECTORY: "not-a-directory",
};

/**
 * Every session this state root actually holds, as PI reports them.
 *
 * The directory is inspected here — absent, unreadable, or not a directory at all — and only a
 * directory that was successfully inspected is handed to the lister.
 *
 * @param {string} sessionDir
 * @param {{lister: (cwd: string, sessionDir: string) => Promise<Array<object>>, projectRoot: string}} opts
 */
export async function availableSessions(sessionDir, { lister, projectRoot } = {}) {
  if (typeof lister !== "function")
    throw new TypeError("availableSessions needs Pi's own session lister; ids must not come from filenames (F121)");
  if (typeof projectRoot !== "string" || projectRoot.length === 0)
    throw new TypeError("availableSessions needs the project root, because Pi lists sessions BY the directory they were started in");
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

  let listed;
  try {
    listed = await lister(projectRoot, sessionDir);
  } catch (e) {
    // A lister that threw did not tell us the directory is empty; it told us nothing.
    return { state: STORAGE.UNREADABLE, sessions: [], code: e?.code ?? e?.name ?? "unknown" };
  }

  // ⚠️ **ONLY WHAT PI COULD IDENTIFY.** It drops malformed and header-less files silently, which is
  // correct here: a file whose header cannot be read names no session anyone could return to.
  //
  // ⚠️ **ONLY WHAT THE PICKER SHOWS, PLUS THE ID AND FILE KILN LAUNCHES.** Pi's listing also carries each
  // session's first message and full text. They are not copied: a transcript can hold a pasted credential,
  // and nothing Kiln prints or records needs them.
  const sessions = (listed ?? [])
    .filter((s) => typeof s?.id === "string" && s.id.length > 0)
    .map((s) => ({
      id: s.id,
      path: s.path ?? null,
      name: typeof s.name === "string" ? s.name : null,
      createdMs: timeOf(s.created),
      modifiedMs: timeOf(s.modified),
      messageCount: Number.isInteger(s.messageCount) && s.messageCount >= 0 ? s.messageCount : null,
    }))
    .sort((a, b) => b.modifiedMs - a.modifiedMs);
  return { state: STORAGE.LISTED, sessions };
}

const timeOf = (d) => (d instanceof Date && !Number.isNaN(d.getTime()) ? d.getTime() : 0);

/** The longest session name the picker prints, in characters, before it is cut. */
export const SESSION_NAME_MAX = 60;

const ESC = 0x1b;
const BEL = 0x07;
const CSI_8BIT = 0x9b;
const ST_8BIT = 0x9c;
/** String controls, which run to a terminator: OSC, DCS, SOS, PM, APC (8-bit forms). */
const STRING_8BIT = new Set([0x9d, 0x90, 0x98, 0x9e, 0x9f]);
/** The same, introduced by ESC: `]`, `P`, `X`, `^`, `_`. */
const STRING_AFTER_ESC = new Set([0x5d, 0x50, 0x58, 0x5e, 0x5f]);
const LINE_BREAKS = new Set([0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x85, 0x2028, 0x2029]);
const isControl = (cp) =>
  cp <= 0x1f ||
  (cp >= 0x7f && cp <= 0x9f) ||
  cp === 0x061c ||
  cp === 0x200e ||
  cp === 0x200f ||
  (cp >= 0x202a && cp <= 0x202e) ||
  (cp >= 0x2066 && cp <= 0x2069);

/**
 * A session name made safe to print on one terminal line.
 *
 * ⚠️ **A NAME IS OPERATOR TEXT, AND A TERMINAL EXECUTES SOME TEXT.** An escape sequence in a name can move the
 * cursor, rewrite earlier lines, retitle the window or hide what follows, so the list the operator chooses
 * from could say something other than what is there. Escape sequences in their 7-bit and 8-bit forms are
 * removed with everything they introduce, line breaks become spaces, the remaining C0, DEL, C1 and bidi
 * controls are dropped, whitespace runs collapse, and the result is capped.
 *
 * ⚠️ **SCANNED BY CODE POINT, NOT MATCHED BY PATTERN**, so the source holds no control character or escape
 * literal that an editor or a copy could turn into the real thing.
 */
export function terminalSafeName(name, max = SESSION_NAME_MAX) {
  if (typeof name !== "string") return null;
  const cps = Array.from(name, (c) => c.codePointAt(0));
  const out = [];
  let i = 0;
  const skipCsi = () => {
    while (i < cps.length && cps[i] >= 0x30 && cps[i] <= 0x3f) i++;
    while (i < cps.length && cps[i] >= 0x20 && cps[i] <= 0x2f) i++;
    if (i < cps.length && cps[i] >= 0x40 && cps[i] <= 0x7e) i++;
  };
  const skipString = () => {
    while (i < cps.length) {
      if (cps[i] === BEL || cps[i] === ST_8BIT) return void i++;
      if (cps[i] === ESC && cps[i + 1] === 0x5c) return void (i += 2);
      i++;
    }
  };
  while (i < cps.length) {
    const cp = cps[i++];
    if (cp === ESC) {
      const next = cps[i];
      if (next === 0x5b) {
        i++;
        skipCsi();
      } else if (STRING_AFTER_ESC.has(next)) {
        i++;
        skipString();
      } else if (next !== undefined) i++;
    } else if (cp === CSI_8BIT) skipCsi();
    else if (STRING_8BIT.has(cp)) skipString();
    else if (LINE_BREAKS.has(cp)) out.push(0x20);
    else if (!isControl(cp)) out.push(cp);
  }
  const cleaned = String.fromCodePoint(...out).replace(/\s+/g, " ").trim();
  if (cleaned.length === 0) return null;
  const chars = Array.from(cleaned);
  return chars.length <= max ? cleaned : `${chars.slice(0, max - 3).join("")}...`;
}

const stamp = (ms) => (ms > 0 ? `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")} UTC` : "unknown");

/**
 * The numbered lines an operator chooses from, one per session, in the order given.
 *
 * ⚠️ **NO ID, NO PATH AND NO MESSAGE TEXT.** Position, a terminal-safe name, when the session was created
 * and last modified, and how many messages it holds.
 */
export function renderSessionChoices(sessions) {
  return sessions.map((s, i) => {
    const count = s.messageCount === null ? "message count unknown" : `${s.messageCount} message${s.messageCount === 1 ? "" : "s"}`;
    return `  ${i + 1}. ${terminalSafeName(s.name) ?? "(unnamed)"} | created ${stamp(s.createdMs)} | modified ${stamp(s.modifiedMs)} | ${count}`;
  });
}

/** Where sessions live for a mode. Derived here so no caller can forget to pass it. */
export function sessionDirFor(stateRoot) {
  return join(stateRoot, "sessions");
}

/** Why a transcript cannot be handed to Pi unchanged, or `null` when it can. */
export const TRANSCRIPT_PROBLEM = Object.freeze({
  FORMAT_UNKNOWN: "the pinned Pi did not report its transcript format",
  UNREADABLE: "the transcript could not be read",
  EMPTY: "the transcript is empty",
  UNTERMINATED: "the transcript's last line is unterminated",
  MALFORMED: "the transcript has a line that is not JSON",
  NO_HEADER: "the transcript does not start with a session header",
  VERSION: "the transcript is not in the pinned Pi's current format",
  WRONG_SESSION: "the transcript names a different session",
  NO_MESSAGE: "the transcript's current branch has no message",
  NO_THINKING_LEVEL: "the transcript's current branch records no thinking level",
});

/**
 * Whether Pi would open this transcript WITHOUT WRITING TO IT before Kiln's guard runs.
 *
 * ⚠️ **PI REWRITES SOME TRANSCRIPTS WHILE OPENING THEM, AND THAT WRITE HAPPENS BEFORE ANY EXTENSION RUNS.**
 * Read from the pinned 0.84.4: a header whose version is missing or below the current one is migrated and the
 * file rewritten; a last line without its newline gets one appended; an empty file is replaced by a new session;
 * and a branch without a thinking-level entry, or without any message, gets model or thinking-level entries
 * appended while the session is created. Each of those would change the transcript before it could be compared,
 * so each is refused here, by reading only, before Pi is started.
 *
 * ⚠️ **STRICTER THAN PI ON ONE POINT.** Pi skips a line that is not JSON; this refuses it, because what Pi
 * would then load is not the transcript Kiln inspected.
 *
 * @param {string} path
 * @param {{version: number, sessionId?: string}} expected  the pinned Pi's current format, and the session named
 * @returns {{ok: true, problem: null, digest: string} | {ok: false, problem: string, code?: string}}
 */
export function inspectTranscript(path, { version, sessionId } = {}) {
  const refuse = (problem, code) => ({ ok: false, problem, ...(code ? { code } : {}) });
  if (!Number.isInteger(version)) return refuse(TRANSCRIPT_PROBLEM.FORMAT_UNKNOWN);

  let bytes;
  try {
    bytes = readFileSync(path);
  } catch (e) {
    return refuse(TRANSCRIPT_PROBLEM.UNREADABLE, e?.code ?? "unknown");
  }
  if (bytes.length === 0) return refuse(TRANSCRIPT_PROBLEM.EMPTY);
  if (bytes[bytes.length - 1] !== 0x0a) return refuse(TRANSCRIPT_PROBLEM.UNTERMINATED);

  const entries = [];
  for (const line of bytes.toString("utf-8").split("\n")) {
    if (line.trim().length === 0) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      return refuse(TRANSCRIPT_PROBLEM.MALFORMED);
    }
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return refuse(TRANSCRIPT_PROBLEM.MALFORMED);
    entries.push(entry);
  }

  const [header, ...rest] = entries;
  if (!header || header.type !== "session" || typeof header.id !== "string") return refuse(TRANSCRIPT_PROBLEM.NO_HEADER);
  if (header.version !== version) return refuse(TRANSCRIPT_PROBLEM.VERSION);
  if (sessionId !== undefined && header.id !== sessionId) return refuse(TRANSCRIPT_PROBLEM.WRONG_SESSION);

  // The current branch as Pi builds it: the last entry is the leaf, and parents are followed from there.
  const byId = new Map();
  let leaf;
  for (const entry of rest) {
    byId.set(entry.id, entry);
    leaf = entry;
  }
  const branch = [];
  const seen = new Set();
  for (let at = leaf; at && !seen.has(at); at = at.parentId ? byId.get(at.parentId) : undefined) {
    seen.add(at);
    branch.push(at);
  }
  if (!branch.some((e) => e.type === "message")) return refuse(TRANSCRIPT_PROBLEM.NO_MESSAGE);
  if (!branch.some((e) => e.type === "thinking_level_change")) return refuse(TRANSCRIPT_PROBLEM.NO_THINKING_LEVEL);
  // The digest of exactly the bytes inspected, which the guard inside Pi compares against what Pi opened.
  return { ok: true, problem: null, digest: createHash("sha256").update(bytes).digest("hex") };
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
 * @returns {Promise<{action: string, sessionId?: string, problem: string, available: object}>}
 */
export async function planSession({ stateRoot, projectId, stateMode, projectRoot, lister, sessionDir, validators }) {
  if (stateMode !== "project" && stateMode !== "user")
    throw new TypeError(`planSession needs the ACTIVE state mode ("project" or "user"), got ${JSON.stringify(stateMode)}`);

  const path = join(stateRoot, SESSION_RECORD);
  const storage = await availableSessions(sessionDir ?? sessionDirFor(stateRoot), { lister, projectRoot });
  const ask = (problem) => ({ action: SESSION.ASK, problem, recoverable: RECOVERABLE_PROBLEMS.includes(problem), available: storage });

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
    // ⚠️ A RECORD THAT COULD NOT BE OPENED MAY BE VALID, so it is not the corrupt-JSON case below: nothing
    // may replace a record nobody could inspect.
    if (e?.code !== "ENOENT") return ask(SESSION_PROBLEM.INACCESSIBLE);
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
  const listed = storage.sessions.find((s) => s.id === doc.sessionId);
  if (!listed) return ask(SESSION_PROBLEM.GONE);

  // ⚠️ **AND ITS TRANSCRIPT MUST BE ONE PI OPENS WITHOUT REWRITING.** A migration or repair write lands before
  // anything Kiln runs inside Pi can compare it, so the transcript is inspected here, by reading only.
  const transcript = inspectTranscript(listed.path, { version: lister?.sessionVersion, sessionId: doc.sessionId });
  if (!transcript.ok) return { ...ask(SESSION_PROBLEM.TRANSCRIPT_UNSUPPORTED), transcript: transcript.problem };

  return { action: SESSION.RESUME, sessionId: doc.sessionId, problem: SESSION_PROBLEM.NONE, available: storage };
}

/**
 * Record the session this run is about to start, under a lock, before Pi is spawned.
 *
 * ⚠️ **THE PLAN IS MADE AGAIN INSIDE THE LOCK.** The one made before it was made outside any mutual
 * exclusion, and two runs starting together would both have seen "no record" and both minted an id —
 * the second overwriting the first, leaving a live conversation nothing points at. Re-planning here
 * means the loser of the race finds the winner's record and RESUMES it rather than clobbering it.
 *
 * ⚠️ **NOTHING IS CREATED.** A missing runtime directory is setup's to make, under the lock that owns
 * the project layout; a supervisor that created one would be the second writer of a layout with one
 * owner. It is reported instead, and the caller refuses before starting anything.
 *
 * ⚠️ **IT RETURNS A RESULT RATHER THAN THROWING A REFUSAL**, because the refusal vocabulary belongs to
 * the supervisor and importing it here would close a cycle (`supervisor` → `session-record`).
 *
 * @returns {Promise<{ok: boolean, action?: string, sessionId?: string, problem?: string, code?: string, path?: string}>}
 */
export async function recordSession({
  stateRoot,
  projectId,
  stateMode,
  projectRoot,
  lister,
  sessionId,
  sessionDir,
  validators,
  now = () => new Date(),
}) {
  if (typeof sessionId !== "string" || sessionId.trim().length === 0)
    throw new TypeError(`recordSession needs the session id this run will pass to Pi, got ${JSON.stringify(sessionId)}`);

  const runtimeDir = join(stateRoot, "runtime");
  if (!existsSync(runtimeDir))
    return { ok: false, problem: SESSION_PROBLEM.NO_RUNTIME_DIR, code: "ENOENT", path: join(stateRoot, SESSION_RECORD) };

  const path = join(stateRoot, SESSION_RECORD);
  const checks = validators ?? createRuntimeValidators();

  return withLock(join(stateRoot, SESSION_LOCK), async () => {
    const again = await planSession({ stateRoot, projectId, stateMode, projectRoot, lister, sessionDir, validators: checks });
    // Another run got here first: its session is the one to return to, and this run adopts it.
    if (again.action === SESSION.RESUME)
      return { ok: true, action: SESSION.RESUME, sessionId: again.sessionId, problem: SESSION_PROBLEM.NONE, path };
    // Anything other than a clean first run is a question, and a question is not something to write over.
    if (again.action !== SESSION.START) return { ok: false, action: SESSION.ASK, problem: again.problem, path };

    const doc = {
      recordVersion: 1,
      projectId,
      sessionId,
      stateMode,
      startedAt: now().toISOString(),
    };
    // ⚠️ VALIDATED BEFORE IT IS WRITTEN, so an invalid record is never the thing on disk that the next
    // run has to treat as a question.
    try {
      assertValidRecord(checks, "kiln-session", doc, path);
    } catch (e) {
      return { ok: false, problem: SESSION_PROBLEM.INVALID, code: e?.code ?? "invalid", path };
    }

    try {
      await atomicWrite(path, JSON.stringify(doc, null, 2) + "\n");
    } catch (e) {
      return { ok: false, problem: SESSION_PROBLEM.WRITE_FAILED, code: e?.cause?.code ?? e?.code ?? "unknown", path };
    }
    return { ok: true, action: SESSION.START, sessionId, problem: SESSION_PROBLEM.NONE, path };
  });
}
