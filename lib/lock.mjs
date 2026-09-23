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

/**
 * How long an abandoned break gate is tolerated. The gate is held across a handful of synchronous
 * calls with nothing awaited inside it, so a gate this old is one whose holder died inside it.
 */
const GATE_ABANDONED_MS = 10_000;

/**
 * Run `judge` while no other process can be removing this lock.
 *
 * ⚠️ **REMOVING SOMEBODY ELSE'S LOCK IS THE ONE OPERATION THAT NEEDS SERIALISING, AND BOTH BREAK PATHS DO IT.**
 * Every breaker reads the lock, decides its owner is gone, and then removes it. Two of them overlapping is two
 * writers: the first removes the dead lock and acquires, and the second — still holding the judgement it made a
 * moment ago — removes THAT lock, the live one, and acquires it as well. Measured in CI on 2026-09-23, where a
 * fourth racer moved a lock another recovery had legitimately taken.
 *
 * ⚠️ **AND SERIALISING THEM IS WHAT MAKES A RE-READ CONCLUSIVE.** Inside this gate a lockfile cannot turn from a
 * dead owner's into a live one's: creating it requires it to be absent, making it absent requires removing it,
 * and the only removers are its own holder — dead, by assumption — and a breaker, which is here. So `judge` acts
 * on the file it just read, without a window between the two.
 *
 * @returns `{taken: true, value}` with what `judge` returned, or `{taken: false, reason}` when it was not taken:
 *   `"claimed-elsewhere"` while another process is breaking, `"break-blocked"` when a previous one left files
 *   behind that only the operator may remove.
 */
function withBreakGate(lockPath, judge) {
  const { gate } = breakPaths(lockPath);
  let fd = null;
  try {
    fd = openSync(gate, "wx");
  } catch (e) {
    if (!CONTENTION_CODES.has(e.code)) return { taken: false, reason: "break-blocked" };
    const reclaimed = reclaimAbandonedGate(lockPath);
    if (reclaimed !== true) return { taken: false, reason: reclaimed };
    try {
      fd = openSync(gate, "wx");
    } catch {
      return { taken: false, reason: "claimed-elsewhere" }; // somebody took it the moment it came free
    }
  }
  try {
    // Written so an abandoned gate can be recognised as abandoned rather than waited on forever.
    writeSync(fd, JSON.stringify({ pid: process.pid, hostname: hostname(), takenAt: new Date().toISOString() }));
    return { taken: true, value: judge() };
  } finally {
    try {
      closeSync(fd);
    } catch {}
    try {
      unlinkSync(gate);
    } catch {}
  }
}

/** The two files a breaker may create beside a lock, both removed by the process that created them. */
export function breakPaths(lockPath) {
  return {
    gate: `${lockPath}.breaking`,
    token: `${lockPath}.breaking.reclaim`,
  };
}

/**
 * What can be proved about this gate: `"gone"`, `"held"`, `"abandoned"`, or `"unprovable"`.
 *
 * ⚠️ **AGE IS NOT DEATH, AND AN UNREADABLE GATE IS NOT AN ABANDONED ONE.** Creating the gate and writing
 * the owner record into it are two calls, and a process can be stopped between them — suspended, paged out,
 * held at a breakpoint — for as long as you like. So an empty gate says only that somebody created it, and
 * removing one on age would let a reclaimer take a gate whose creator then wakes up still believing it holds the
 * gate. The only gate this clears is one whose record names a process on this host that is demonstrably gone.
 *
 * ⚠️ **AND WHAT CANNOT BE PROVED IS REPORTED, NOT GUESSED.** An old gate that is unreadable, or names
 * another machine, will never clear itself, so leaving it silently would strand every later run on a timeout
 * about a pid. It fails closed instead, and the caller names the files for the operator to remove.
 */
function gateVerdict(gate) {
  let age;
  try {
    age = Date.now() - statSync(gate).mtimeMs;
  } catch {
    return "gone"; // it is not there at all; there is nothing to reclaim
  }
  // A gate is held across a handful of synchronous calls, so a young one is somebody's, whatever it contains.
  if (age < GATE_ABANDONED_MS) return "held";
  const owner = readOwner(gate);
  if (!owner || typeof owner.pid !== "number" || owner.hostname !== hostname()) return "unprovable";
  return ownerAlive(owner) ? "held" : "abandoned";
}

/**
 * Remove a gate whose holder died inside it, so one killed recovery cannot stop every later one.
 *
 * ⚠️ **JUDGING A FILE AND THEN REMOVING IT IS THE DEFECT THIS WHOLE FILE IS ABOUT, AND IT DOES NOT STOP BEING ONE
 * AT THIS LEVEL.** Two reclaimers can both find the same old gate abandoned; the first removes it and takes a new
 * gate, and the second then removes THAT gate — a live one — and a third process takes a gate of its own. Two
 * breakers again, and through them two lock holders. So reclaiming is itself serialised, by a token that only one
 * process can create.
 *
 * ⚠️ **AND THE TOKEN IS THE END OF THE REGRESS, BECAUSE IT IS NEVER RECLAIMED.** Nothing removes a token but the
 * process that created it. That makes the judgement below conclusive — while the token is held, the gate cannot
 * be removed, so it cannot be replaced by a live one either — and it makes the failure mode a refusal rather than
 * a second writer: a token left behind by a process killed inside these few calls stops all automatic breaking,
 * and the caller is told which file to remove. Fail closed, with a route out, is the correct end of this chain.
 *
 * @returns `true` when the gate was reclaimed, otherwise the reason it was not.
 */
function reclaimAbandonedGate(lockPath) {
  const { gate, token } = breakPaths(lockPath);
  const glimpsed = gateVerdict(gate);
  if (glimpsed !== "abandoned") return glimpsed === "unprovable" ? "break-blocked" : "claimed-elsewhere";

  let fd = null;
  try {
    fd = openSync(token, "wx");
  } catch (e) {
    if (!CONTENTION_CODES.has(e.code)) return "break-blocked";
    // Somebody is reclaiming right now, or died holding this token. A token is held for microseconds, so one that
    // is still here a moment later is the second case — and clearing it is the operator's call, not this one's.
    let age;
    try {
      age = Date.now() - statSync(token).mtimeMs;
    } catch {
      return "claimed-elsewhere"; // it went away by itself; the next attempt will find the gate free
    }
    return age < GATE_ABANDONED_MS ? "claimed-elsewhere" : "break-blocked";
  }
  try {
    writeSync(fd, JSON.stringify({ pid: process.pid, hostname: hostname(), takenAt: new Date().toISOString() }));
    // Judged again under the token, where the gate cannot be removed and so cannot be replaced.
    const verdict = gateVerdict(gate);
    if (verdict !== "abandoned") return verdict === "unprovable" ? "break-blocked" : "claimed-elsewhere";
    try {
      unlinkSync(gate);
    } catch {
      return "break-blocked";
    }
    return true;
  } finally {
    try {
      closeSync(fd);
    } catch {}
    try {
      unlinkSync(token);
    } catch {}
  }
}

/** Break a lock only when it is old AND its owner is demonstrably gone. */
function breakIfStale(path, staleMs) {
  // A cheap look first, so the common case — a lock somebody is holding — costs nothing and takes no gate.
  if (!existsSync(path)) return false;
  let age;
  try {
    age = Date.now() - statSync(path).mtimeMs;
  } catch {
    return false;
  }
  if (age < staleMs) return false;
  if (ownerAlive(readOwner(path))) return false;

  const gated = withBreakGate(path, () => {
    // Judged again on a file no other breaker can be removing, so the unlink below acts on what was just read.
    let current;
    try {
      current = Date.now() - statSync(path).mtimeMs;
    } catch {
      return false;
    }
    if (current < staleMs) return false;
    if (ownerAlive(readOwner(path))) return false;
    try {
      unlinkSync(path);
      return true;
    } catch {
      return false;
    }
  });
  // A waiter that could not gate simply keeps waiting: its bounded wait is what ends the attempt.
  return gated.taken === true && gated.value === true;
}

/**
 * Remove a lockfile whose owner is demonstrably gone, for a caller that is recovering deliberately.
 *
 * ⚠️ **THE STALE WINDOW EXISTS FOR WAITERS, AND A RECOVERY IS NOT A WAITER.** `breakIfStale` needs a lock to be
 * old AND its owner dead, because a waiter cannot tell a slow holder from a dead one and guessing wrong means two
 * writers. A recovery is the opposite situation: the operator has been told the previous run was interrupted and
 * has asked for it to be continued, so the question is only whether that run is really gone. Without this, the
 * command a killed run records cannot run for two minutes — the lock it left is young, and the recovery waits out
 * a window meant to protect it from itself.
 *
 * ⚠️ **AND ONLY WHEN THAT IS PROVABLE.** A lockfile naming another host, an unreadable one, or one whose pid is
 * still alive is left exactly where it is: an unprovable claim about somebody else's process is not a reason to
 * take their lock.
 *
 * @returns {{broken: true, owner: object}
 *   | {broken: false, reason: "absent"|"unreadable"|"other-host"|"alive"|"claimed-elsewhere"}
 *   | {broken: false, reason: "break-blocked", blockedBy: {gate: string, token: string}}}
 */
export function breakDeadLock(lockPath) {
  // ⚠️ A CHEAP LOOK FIRST, so the common cases — no lock at all, or one somebody is holding — cost nothing and
  // move nothing. Everything this decides is decided again below, on a file nobody else can still be looking at.
  if (!existsSync(lockPath)) return { broken: false, reason: "absent" };
  const glimpsed = readOwner(lockPath);
  if (!glimpsed || typeof glimpsed.pid !== "number") return { broken: false, reason: "unreadable" };
  if (glimpsed.hostname !== hostname()) return { broken: false, reason: "other-host" };
  if (ownerAlive(glimpsed)) return { broken: false, reason: "alive" };

  /**
   * ⚠️ **THE LOCK IS NEVER TOUCHED OUTSIDE THE GATE, AND THE GLIMPSE ABOVE DECIDES NOTHING.** Moving a file out
   * of the way to look at it is how the previous version of this leaked a window: it renamed the lock, found a
   * live holder's record in it, put it back — and in between, a waiter created its own lock over the free name.
   * The judgement that acts is the one made inside the gate, on a file no other breaker can be removing.
   */
  const verdict = withBreakGate(lockPath, () => {
    if (!existsSync(lockPath)) return { broken: false, reason: "absent" };
    const owner = readOwner(lockPath);
    if (!owner || typeof owner.pid !== "number") return { broken: false, reason: "unreadable" };
    if (owner.hostname !== hostname()) return { broken: false, reason: "other-host" };
    if (ownerAlive(owner)) return { broken: false, reason: "alive" };
    try {
      unlinkSync(lockPath);
    } catch {
      return { broken: false, reason: "unreadable" };
    }
    return { broken: true, owner };
  });

  /**
   * ⚠️ **NO GATE IS NOT A BREAK.** While another process is breaking this lock, clearing it is theirs to do. And
   * when a previous breaker left its files behind, this says so by name instead of guessing: `blockedBy` is the
   * route out, and removing those files is the operator's decision because nothing here can prove they are stale.
   */
  if (verdict.taken) return verdict.value;
  return verdict.reason === "break-blocked"
    ? {
        broken: false,
        reason: "break-blocked",
        blockedBy: breakPaths(lockPath),
      }
    : { broken: false, reason: "claimed-elsewhere" };
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
  const { retryMs, maxWaitMs, staleMs, reuseHeld = false } = { ...DEFAULTS, ...opts };
  const startedAt = Date.now();
  let fd;

  const held = pathIdentityKey(resolve(lockPath));
  const outer = heldHere.getStore() ?? null;
  if (activeAncestorHolds(outer, held)) {
    // ⚠️ **REUSE IS OPT-IN, AND THE REFUSAL STAYS THE DEFAULT.** The setup command takes this lock for the
    // whole run — the dependency bootstrap has to happen inside it, before the transaction can even be
    // planned (D26) — and then calls the transaction, which acquires the same lock. Only a caller that can
    // say it already holds this exact lock passes `reuseHeld`; for everyone else, re-acquiring is still the
    // mistake it always was, because waiting would wait on a file only this process can remove.
    if (!reuseHeld)
      throw new LockError(
        `${lockPath} is already held further up this call stack. Waiting for it would wait on a file ` +
          `only this process can remove. Pass the held transaction down instead of acquiring the lock again.`
      );
    // ⚠️ AND IT DOES NOT RELEASE WHAT IT DID NOT TAKE: the holder further up owns the lifetime.
    return await fn();
  }

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
