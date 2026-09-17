/**
 * Kiln's guard inside Pi: the session Pi opened must be the one Kiln selected — ACC-0103, F128.
 *
 * ⚠️ **`--session <id>` REFUSES A SESSION THAT IS ALREADY GONE; THIS CATCHES THE REST.** Measured against the
 * pinned 0.84.4: the id form exits rather than inventing a session, but it lists and then opens in two steps, it
 * falls back to a prefix match, and a path form silently becomes a NEW session with a random id when the file
 * has gone. So what Pi actually bound is compared here, in `session_start`, against what Kiln wrote down.
 *
 * ⚠️ **IT RUNS BEFORE PI DOES ANYTHING WITH THE SESSION.** Measured: `session_start` fires before any input,
 * agent start, turn or provider request, and Pi's own code reaches the first handler without yielding to the
 * event loop after it enables submissions. A synchronous decision here therefore lands before a keystroke can.
 *
 * ⚠️ **IT STOPS BY THROWING FROM A MICROTASK, WITH A PLAIN MESSAGE.** Measured across eight ways of stopping
 * Pi: `ctx.shutdown()` defers until the agent is idle and let a whole turn run first; signals and `process.exit`
 * left the terminal with its cursor hidden. An uncaught throw reaches Pi's own crash handler, which restores the
 * terminal and exits — with no provider request, no transcript write, and no input processed. The value thrown
 * is a string, because an Error would print a stack trace carrying this file's path.
 *
 * ⚠️ **NOTHING IT LEARNS REACHES THE MODEL.** It never appends to the session, and its answer to the supervisor
 * is a code in a file: no session id, no path, no digest, no transcript text.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";

import { GUARD_CODE, GUARD_OUTCOME, createGuardFile, takeGuardFile, writeGuardResult } from "./session-guard.mjs";

// Re-exported so a caller of the guard needs one import, not two, to set an expectation and read its answer.
export { GUARD_CODE, GUARD_ENV, GUARD_OUTCOME, createGuardFile } from "./session-guard.mjs";

/** What an operator sees if Pi is stopped: which run ended, and why, with nothing else in it. */
export const GUARD_STOP_MESSAGE = "Kiln stopped this session: Pi did not open the session Kiln recorded.";

const canonical = (path) => {
  try {
    const real = realpathSync.native(path);
    return process.platform === "win32" ? real.toLowerCase() : real;
  } catch {
    return null;
  }
};

/** Which check failed, or `null` when the session Pi bound is the recorded one. */
export function checkBoundSession(expected, bound) {
  if (bound.sessionId !== expected.sessionId) return GUARD_CODE.SESSION_ID_MISMATCH;
  if (!bound.file || !existsSync(bound.file)) return GUARD_CODE.SESSION_FILE_MISSING;
  const here = canonical(bound.file);
  const there = canonical(expected.file);
  if (here === null || there === null || here !== there) return GUARD_CODE.SESSION_FILE_MISMATCH;
  if (createHash("sha256").update(readFileSync(bound.file)).digest("hex") !== expected.digest) return GUARD_CODE.TRANSCRIPT_CHANGED;
  return null;
}

/**
 * ⚠️ **THE EXPECTATION IS TAKEN WHEN THE EXTENSION LOADS, NOT WHEN THE SESSION STARTS.** Taking it removes the
 * variable naming it and deletes the file, so no process Pi starts later inherits either.
 */
export function createSessionGuard({ env = process.env, stop = stopPi, now = () => {} } = {}) {
  const taken = takeGuardFile(env);
  return (pi) => {
    pi.on("session_start", (_event, ctx) => {
      now();
      if (!taken.ok) {
        // No expectation, so nothing can be proved about this session. It is not allowed to continue.
        stop(GUARD_CODE.EXPECTATION_UNAVAILABLE);
        return;
      }
      const { expected } = taken;
      const sm = ctx.sessionManager;
      const code = checkBoundSession(expected, { sessionId: sm.getSessionId(), file: sm.getSessionFile() });
      writeGuardResult(expected.result, code === null ? GUARD_OUTCOME.ACCEPTED : GUARD_OUTCOME.REFUSED, code);
      if (code !== null) stop(code);
    });
  };
}

/** The measured stop: an uncaught throw from a microtask, which Pi's crash handler turns into a clean exit. */
function stopPi() {
  queueMicrotask(() => {
    throw GUARD_STOP_MESSAGE;
  });
}

export default function sessionGuardExtension(pi) {
  return createSessionGuard()(pi);
}
