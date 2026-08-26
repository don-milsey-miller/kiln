/**
 * Lifecycle cleanup for workspaces a test DELIBERATELY caused to be retained.
 *
 * The controller retains a workspace when it cannot verify removal, and on Windows that is a
 * routine outcome after a command is killed — the interpreter holds the directory for a moment
 * longer than the destroy attempt waits. That behaviour is correct and several tests provoke it on
 * purpose. What was missing is what happens to the directory afterwards: thirteen `runJob` call
 * sites, one of which tidied up, and 155MB of `vpw-tier1-*` and `vpw-skel-*` residue four days later.
 *
 * ⚠️ **The reaper runs after the assertions, and it can never make a test pass.** It is an `after`
 * hook, so every claim about retention has already been evaluated by the time it touches anything.
 * A controller that failed to retain a workspace would fail its test first and be swept second.
 * Cleanup that runs before the check is how a cleanup step starts hiding the defect it was added
 * beside.
 *
 * ⚠️ **It removes only paths a test explicitly registered.** The tempting version globs `vpw-*` out
 * of the system temp directory, and that version can delete a concurrently running test file's live
 * workspace — `node --test` runs files in separate processes — or somebody's unrelated directory
 * that happens to share a prefix. A reaper with a wildcard is a `rm -rf` with a pattern nobody
 * reviewed.
 *
 * ⚠️ **It never throws.** A sweep that fails prints what it could not remove and lets the run pass.
 * If leftover residue turned a green run red, the next person deletes the registration rather than
 * the residue, and the leak comes back with the check that was supposed to catch it.
 *
 * ⚠️ **The `after` hook is installed by the consumer, not at import.** `node --test` collects every
 * file under `test/`, this one included, so a top-level `after()` here would register a root hook in
 * a process that has no tests to clean up after — a side effect of being *imported*, and of being
 * *collected*, rather than of being used. Nothing broke while it did, but a shared helper that
 * mutates the runner on import is the kind of thing that is only ever debugged once it does. Call
 * `installReaper()` at the top level of the test file that needs it.
 *
 * (It also gets counted as one passing test named after the file. That is Node reporting a
 * zero-test file, not this module doing something odd — `test/fixtures/` reports the same, and did
 * before this file existed.)
 */

import { after } from "node:test";
import { existsSync, rmSync } from "node:fs";

const pending = new Set();
let installed = false;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Register a path to be removed once the file's tests have finished.
 * @param {string|null|undefined} path
 * @returns {string|null|undefined} the path, unchanged, so this can wrap an expression
 */
export function reapLater(path) {
  if (typeof path === "string" && path.length) pending.add(path);
  return path;
}

/**
 * Register whatever a controller result retained. Returns the result UNCHANGED so it can wrap a
 * call without moving the assertions that follow it:
 *
 *   const r = reapWorkspace(await runJob(job));
 *
 * A result whose destroy succeeded registers nothing — there is no path to reap.
 * @template T
 * @param {T} result
 * @returns {T}
 */
export function reapWorkspace(result) {
  reapLater(result?.destroy?.retainedPath);
  return result;
}

/**
 * Best effort, with a pause between attempts: the handle that blocked the controller's own removal
 * is usually released within a second, and retrying immediately just fails again for the same
 * reason.
 * @returns {Promise<string[]>} paths that survived every attempt
 */
export async function sweepRetained() {
  const stuck = [];
  for (const path of pending) {
    if (!existsSync(path)) {
      pending.delete(path);
      continue;
    }
    let gone = false;
    for (let attempt = 0; attempt < 4 && !gone; attempt++) {
      try {
        rmSync(path, { recursive: true, force: true, maxRetries: 3 });
      } catch {
        /* observed below, not inferred from the throw — the same rule the controller follows */
      }
      gone = !existsSync(path);
      if (!gone) await sleep(400);
    }
    pending.delete(path);
    if (!gone) stuck.push(path);
  }
  return stuck;
}

/**
 * Register the end-of-file sweep. Call once, at the top level of a test file that provokes
 * retention. Idempotent, so two modules both installing it cannot double-sweep.
 */
export function installReaper() {
  if (installed) return;
  installed = true;
  after(async () => {
    const stuck = await sweepRetained();
    if (stuck.length)
      console.warn(
        `\n⚠️  ${stuck.length} retained workspace(s) survived the sweep and are still on disk:\n` +
          stuck.map((p) => `      ${p}`).join("\n") +
          `\n    Not a test failure. Remove them by hand if they accumulate.\n`
      );
  });
}
