#!/usr/bin/env node
/**
 * One competitor in the two-recoveries race — spawned only by `test/setup-command.test.mjs`.
 *
 * ⚠️ **THE POINT IS THE WINDOW BETWEEN BREAKING AND ACQUIRING.** A recovery that reads a dead owner and then
 * unlinks the lock can unlink a lock somebody else has just legitimately acquired; both then believe they hold
 * the project. Two processes doing exactly that, started together against one dead lockfile, is the only way to
 * observe it — a single process cannot race itself.
 *
 * ⚠️ **AND OVERLAP IS OBSERVED, NOT INFERRED.** Each holder appends its own arrival and departure to a shared
 * file and stays inside the lock briefly; two arrivals with no departure between them is two writers, whatever
 * the exit codes say.
 *
 * argv: `<lockPath> <logPath> <holdMs>`.
 */

import { appendFileSync } from "node:fs";

import { breakDeadLock, withLock } from "../../../lib/lock.mjs";

/**
 * ⚠️ **A PRECONDITION, AND ALSO WHY THIS FILE IS HARMLESS TO `node --test`.** The runner executes every file
 * under `test/`, and this one is a real program: run with no lock to compete for, it has nothing to do and says
 * so by exiting cleanly rather than failing a suite it is not part of.
 */
const [lockPath, logPath, holdMs] = process.argv.slice(2);
if (!lockPath || !logPath) process.exit(0);

const note = (what) => appendFileSync(logPath, `${what} ${process.pid}\n`);

const broke = breakDeadLock(lockPath);
note(`broke:${broke.broken ? "yes" : broke.reason}`);

try {
  await withLock(
    lockPath,
    async () => {
      note("enter");
      // ⚠️ A BUSY WAIT, NOT A TIMER: what has to overlap is the time the lock is HELD, and a process that yields
      // here would make the window depend on the scheduler rather than on the lock.
      const until = Date.now() + Number(holdMs ?? 300);
      while (Date.now() < until) {}
      note("exit");
    },
    { maxWaitMs: 5_000 }
  );
  process.exit(0);
} catch (e) {
  // A competitor that could not get the lock is a correct outcome; it reports rather than failing the run.
  note(`refused:${e?.name ?? "error"}`);
  process.exit(3);
}
