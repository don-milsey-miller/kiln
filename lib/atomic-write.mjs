/**
 * #72 — every write to `planning-content/` is temp file plus rename, never truncate-in-place,
 * with a bounded retry on EPERM/EBUSY/EACCES.
 *
 * The watcher spike measured why: against a non-atomic writer, EVERY naive read was a partial
 * read — 120 of 120, the normal case rather than an edge case. The rename retry is not
 * optional on Windows: a live run hit EPERM renaming over a destination a reader had open,
 * at roughly 1 retry per 40 renames.
 *
 * The temp suffix is the one the watcher ignores (#73), so a temp file never looks like a
 * content change.
 */

import { writeFileSync, renameSync, unlinkSync, openSync, closeSync, fsyncSync, linkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join, basename } from "node:path";

export const TEMP_SUFFIX = ".vpw-tmp";

const RETRY_CODES = new Set(["EPERM", "EBUSY", "EACCES"]);
/** A pause that ends early when `signal` aborts, so a cancelled writer is not held for the rest of a backoff. */
const sleep = (ms, signal = null) =>
  new Promise((resolve) => {
    if (!signal) return void setTimeout(resolve, ms);
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });

/**
 * Wait without a timer, for a time too short for one. A timer wakes on the system tick, and so does everything
 * else that sleeps: this is how a retry stops arriving at the same instant as a reader that is also on a timer.
 */
function offTheTick(ms) {
  const until = performance.now() + ms;
  while (performance.now() < until);
}

/**
 * Why an atomic write did not happen. Every one of them means the destination is exactly as it was.
 *
 *  - `CANCELLED`: the caller's signal aborted before the rename.
 *  - `CONTENDED`: the rename was refused for as long as it was retried, with a code another program holding the
 *    destination produces.
 *  - `FAILED`: the rename was refused for a reason retrying does not help.
 */
export const ATOMIC_WRITE_REFUSAL = Object.freeze({ CANCELLED: "atomic-write-cancelled", CONTENDED: "atomic-write-contended", FAILED: "atomic-write-failed" });

export class AtomicWriteError extends Error {
  constructor(message, cause, code = ATOMIC_WRITE_REFUSAL.FAILED) {
    super(message);
    this.name = "AtomicWriteError";
    this.cause = cause;
    this.code = code;
  }
}

/**
 * Write `text` to `target` atomically.
 *
 * ⚠️ **THE RENAME IS THE COMMIT POINT, AND `signal` IS ONLY LOOKED AT BEFORE IT.** A caller that is cancelled before
 * the rename gets `CANCELLED`, with the temporary file removed and the destination untouched. Once the rename has
 * succeeded the write happened, and this returns as it always did: there is no point after it at which the write
 * can be reported as not having happened.
 *
 * @param {string} target
 * @param {string} text
 * @param {{maxAttempts?: number, backoffMs?: number, fsync?: boolean, signal?: AbortSignal, retryJitterMs?: number}} [opts]
 *   `retryJitterMs` delays each retry by a random time up to that many milliseconds, without a timer. Off by default.
 * @returns {Promise<{renameRetries: number}>}
 */
export async function atomicWrite(target, text, opts = {}) {
  const { maxAttempts = 10, backoffMs = 5, fsync = true, signal = null, retryJitterMs = 0 } = opts;
  const tmp = join(dirname(target), `.${basename(target)}.${process.pid}${TEMP_SUFFIX}`);
  const discard = () => {
    try {
      unlinkSync(tmp);
    } catch {}
  };
  const cancelled = () => new AtomicWriteError(`Atomic write cancelled before it was committed -> ${target}`, null, ATOMIC_WRITE_REFUSAL.CANCELLED);

  if (signal?.aborted) throw cancelled();
  try {
    writeFileSync(tmp, text, "utf-8");
    if (fsync) {
      // Rename is atomic with respect to readers; it is not a durability guarantee on its own.
      const fd = openSync(tmp, "r+");
      try {
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    }
  } catch (e) {
    // The temporary file is this call's alone, and a failure to fill it must not leave it behind.
    discard();
    throw e;
  }

  // ⚠️ **ONE FULL TURN OF THE EVENT LOOP BEFORE THE COMMIT POINT, FOR A CALLER THAT CAN CANCEL.** Everything above is
  // synchronous, so a cancellation that arrived while the temporary file was being written and flushed has not been
  // delivered yet: the signal still reads as not aborted. The first `setImmediate` only finishes the turn this code
  // is already in. The second runs after the next turn has polled for input, which is where the cancellation is
  // read, so the check below sees it before the rename instead of after.
  if (signal) for (let turn = 0; turn < 2; turn++) await new Promise((resolve) => setImmediate(resolve));

  let renameRetries = 0;
  for (let attempt = 0; ; attempt++) {
    if (signal?.aborted) {
      discard();
      throw cancelled();
    }
    try {
      renameSync(tmp, target);
      return { renameRetries };
    } catch (e) {
      const contended = RETRY_CODES.has(e.code);
      if (!contended || attempt >= maxAttempts) {
        discard();
        throw new AtomicWriteError(
          `Atomic write failed after ${attempt + 1} attempt(s): ${e.code ?? e.message} -> ${target}`,
          e,
          contended ? ATOMIC_WRITE_REFUSAL.CONTENDED : ATOMIC_WRITE_REFUSAL.FAILED
        );
      }
      renameRetries++;
      await sleep(backoffMs * (attempt + 1), signal);
      if (retryJitterMs > 0) offTheTick(Math.random() * retryJitterMs);
    }
  }
}

/**
 * Create a new file atomically without ever replacing an existing destination.
 * The complete, flushed temporary file becomes visible through an exclusive hard-link operation.
 */
export async function atomicCreate(target, text, opts = {}) {
  const { fsync = true } = opts;
  const tmp = join(dirname(target), `.${basename(target)}.${process.pid}.${randomUUID()}${TEMP_SUFFIX}`);

  try {
    writeFileSync(tmp, text, { encoding: "utf-8", flag: "wx" });
    if (fsync) {
      const fd = openSync(tmp, "r+");
      try {
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    }
    linkSync(tmp, target);
    unlinkSync(tmp);
    return { created: true };
  } catch (e) {
    try {
      unlinkSync(tmp);
    } catch {}
    throw new AtomicWriteError(`Atomic create failed: ${e.code ?? e.message} -> ${target}`, e);
  }
}
