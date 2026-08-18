/**
 * #78 — a short-lived exclusive lockfile around each read-modify-write.
 *
 * Held only for the duration of a single read-modify-write operation, never for an agent
 * turn. The watcher spike measured what this replaces: two processes editing disjoint
 * regions of one file destroyed it 5 runs of 5, and lost updates 4 of 5 even when both
 * wrote atomically (#31, reopened).
 *
 * #78 lists what the implementation owes and calls none of it optional: bounded acquisition
 * retry, stale-lock detection, a crashed-writer path, owner identification, cleanup, and
 * Windows-specific behaviour. All six are here.
 */

import { openSync, closeSync, writeSync, readFileSync, unlinkSync, existsSync, statSync } from "node:fs";
import { hostname } from "node:os";

export class LockError extends Error {
  constructor(message) {
    super(message);
    this.name = "LockError";
  }
}

/**
 * ⚠️ Windows surfaces contention on an exclusive create as EPERM, not only EEXIST.
 * Measured 2026-08-18 (QST-0001): `openSync(lockPath, "wx")` returned EPERM while another
 * process held or was releasing the lock, and the loop below treated anything but EEXIST as
 * fatal. Same family as #72's rename retry — that row says "the rename retry is not optional
 * on Windows", and the identical lesson for `open` was simply not drawn at the time.
 */
const CONTENTION_CODES = new Set(["EEXIST", "EPERM", "EBUSY", "EACCES"]);

const DEFAULTS = {
  retryMs: 5,
  // Back to 10s. It was raised to 30s as a mitigation on an unconfirmed diagnosis, and
  // QST-0001 DISCONFIRMED that diagnosis: the observed failure took 507ms and was never a
  // timeout. Keeping a setting whose justification has been disproven is how cargo-cult
  // configuration accumulates. If a genuine timeout is ever observed, raise it then, with the
  // evidence that says so.
  maxWaitMs: 10_000,
  /**
   * Older than this AND owned by a dead process => a crashed writer, not a slow one.
   * Kept comfortably above maxWaitMs so a waiter always gives up before it could start
   * considering a still-running holder stale — the two thresholds must not meet.
   */
  staleMs: 120_000,
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function ownerAlive(owner) {
  if (!owner || owner.hostname !== hostname() || typeof owner.pid !== "number") return true; // cannot tell; assume alive
  try {
    process.kill(owner.pid, 0); // signal 0 tests existence without delivering anything
    return true;
  } catch (e) {
    return e.code === "EPERM"; // exists but not ours
  }
}

function readOwner(path) {
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null; // unreadable or half-written: treat as unknown owner
  }
}

/** Break a lock only when it is old AND its owner is demonstrably gone. */
function breakIfStale(path, staleMs) {
  if (!existsSync(path)) return false;
  let age;
  try {
    age = Date.now() - statSync(path).mtimeMs;
  } catch {
    return false;
  }
  if (age < staleMs) return false;
  if (ownerAlive(readOwner(path))) return false;
  try {
    unlinkSync(path);
    return true;
  } catch {
    return false; // someone else won the race to break it; fine
  }
}

/**
 * Run `fn` while holding an exclusive lock at `lockPath`.
 * The lock is ALWAYS released, including when `fn` throws — that path is tested.
 *
 * @template T
 * @param {string} lockPath
 * @param {() => Promise<T> | T} fn
 * @param {{retryMs?: number, maxWaitMs?: number, staleMs?: number}} [opts]
 * @returns {Promise<T>}
 */
export async function withLock(lockPath, fn, opts = {}) {
  const { retryMs, maxWaitMs, staleMs } = { ...DEFAULTS, ...opts };
  const startedAt = Date.now();
  let fd;

  for (;;) {
    try {
      // "wx" is the exclusive create: it is the mutual exclusion, not an advisory hint.
      fd = openSync(lockPath, "wx");
      writeSync(fd, JSON.stringify({ pid: process.pid, hostname: hostname(), acquiredAt: new Date().toISOString() }));
      break;
    } catch (e) {
      // EPERM/EBUSY/EACCES here are contention on Windows, not a permissions failure — the
      // bounded wait below still ends it if the condition is real rather than transient.
      if (!CONTENTION_CODES.has(e.code)) throw new LockError(`Could not acquire ${lockPath}: ${e.code ?? e.message}`);
      if (e.code === "EEXIST" && breakIfStale(lockPath, staleMs)) continue;
      if (Date.now() - startedAt >= maxWaitMs) {
        const owner = readOwner(lockPath);
        throw new LockError(
          `Timed out after ${maxWaitMs}ms waiting for ${lockPath}` +
            (owner ? ` (held by pid ${owner.pid} on ${owner.hostname} since ${owner.acquiredAt})` : "")
        );
      }
      await sleep(retryMs);
    }
  }

  try {
    return await fn();
  } finally {
    try {
      closeSync(fd);
    } catch {}
    try {
      unlinkSync(lockPath);
    } catch {}
  }
}
