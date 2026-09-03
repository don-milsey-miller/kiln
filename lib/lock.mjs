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
import { AsyncLocalStorage } from "node:async_hooks";
import { hostname } from "node:os";
import { resolve } from "node:path";

import { pathIdentityKey } from "./content-root.mjs";

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

/**
 * The locks held by the CALLING ASYNC CONTEXT — that is, the ones an acquisition here would be
 * nested inside.
 *
 * ⚠️ **RE-ENTERING A LOCK YOU ALREADY HOLD IS ALWAYS A BUG, AND IT USED TO COST 10 SECONDS TO SAY
 * SO.** The lockfile is an exclusive create, so a second acquisition from inside the first waits on
 * a file only this process can remove: it spins the whole bounded wait and then reports a timeout
 * "held by pid <self>", which reads like contention with another process. Setup makes this
 * reachable rather than theoretical — it holds the project lock for its whole run, and the
 * initializer and the ignore owner run inside it. They take the held transaction instead; a caller
 * that forgets gets this sentence immediately rather than a stall.
 *
 * ⚠️ **SCOPED TO THE ASYNC CONTEXT, NOT TO THE PROCESS, AND THAT DISTINCTION IS THE WHOLE POINT.**
 * A flat process-wide set cannot tell nesting from concurrency, and two `initializeProject` calls
 * raced through `Promise.all` in one process are exactly what this lock EXISTS to serialise —
 * refusing them would break the guarantee in the name of protecting it. `AsyncLocalStorage` gives
 * the precise question: is this acquisition inside that one, or beside it?
 *
 * ⚠️ **LEASE FRAMES, NOT A SET OF NAMES, BECAUSE THE CONTEXT OUTLIVES THE LOCK.** A `Set` in the
 * store records ANCESTRY, and ancestry is permanent: an async resource created inside `fn` — a
 * timer, a deferred promise, an event handler — keeps that store forever, so a legitimate
 * acquisition from such a callback AFTER the lock was released was refused as nested while no lock
 * existed at all. What the check actually needs is a lease that can expire. Each frame is
 * deactivated when its lock is released, and the walk considers only live ones, so the store means
 * "locks still held above me" rather than "locks once held above me".
 *
 * ⚠️ **AND NOT A PID CHECK ON THE FILE.** A lockfile naming this pid is not proof we hold it — a
 * crashed run whose pid was later reused leaves one, and the stale-lock path exists to break
 * exactly that. This records what this call stack actually did, so it has no false positives.
 */
const heldHere = new AsyncLocalStorage();

/** Walk the enclosing frames, counting only leases that have not yet been released. */
function activeAncestorHolds(frame, key) {
  for (let f = frame; f; f = f.parent) if (f.active && f.key === key) return true;
  return false;
}

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

  const held = pathIdentityKey(resolve(lockPath));
  const outer = heldHere.getStore() ?? null;
  if (activeAncestorHolds(outer, held))
    throw new LockError(
      `${lockPath} is already held further up this call stack. Waiting for it would wait on a file ` +
        `only this process can remove. Pass the held transaction down instead of acquiring the lock again.`
    );

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

  // Opened only after acquisition succeeded — a lock we failed to take is not one we hold.
  const lease = { key: held, active: true, parent: outer };
  try {
    return await heldHere.run(lease, fn);
  } finally {
    // ⚠️ THE LEASE EXPIRES BEFORE THE FILE GOES, not after. Between the two a descendant would meet
    // ordinary contention and retry, which is correct; the other order would refuse it as nested
    // for the moment the lock no longer existed.
    lease.active = false;
    try {
      closeSync(fd);
    } catch {}
    try {
      unlinkSync(lockPath);
    } catch {}
  }
}
