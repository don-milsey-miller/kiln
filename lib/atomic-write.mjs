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

import { writeFileSync, renameSync, unlinkSync, openSync, closeSync, fsyncSync } from "node:fs";
import { dirname, join, basename } from "node:path";

export const TEMP_SUFFIX = ".vpw-tmp";

const RETRY_CODES = new Set(["EPERM", "EBUSY", "EACCES"]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class AtomicWriteError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = "AtomicWriteError";
    this.cause = cause;
  }
}

/**
 * Write `text` to `target` atomically.
 *
 * @param {string} target
 * @param {string} text
 * @param {{maxAttempts?: number, backoffMs?: number, fsync?: boolean}} [opts]
 * @returns {Promise<{renameRetries: number}>}
 */
export async function atomicWrite(target, text, opts = {}) {
  const { maxAttempts = 10, backoffMs = 5, fsync = true } = opts;
  const tmp = join(dirname(target), `.${basename(target)}.${process.pid}${TEMP_SUFFIX}`);

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

  let renameRetries = 0;
  for (let attempt = 0; ; attempt++) {
    try {
      renameSync(tmp, target);
      return { renameRetries };
    } catch (e) {
      if (!RETRY_CODES.has(e.code) || attempt >= maxAttempts) {
        try {
          unlinkSync(tmp);
        } catch {}
        throw new AtomicWriteError(
          `Atomic write failed after ${attempt + 1} attempt(s): ${e.code ?? e.message} -> ${target}`,
          e
        );
      }
      renameRetries++;
      await sleep(backoffMs * (attempt + 1));
    }
  }
}
