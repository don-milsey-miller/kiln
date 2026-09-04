/**
 * Whether a checkout's installed dependencies still match the lockfile that describes them.
 *
 * ⚠️ **EXTRACTED FROM THE LAUNCHER SO ITS THREE BRANCHES CAN BE OBSERVED CHEAPLY.** The condition it
 * replaces was wrong for a month and nothing could see it: proving "a warm checkout skips the
 * install" through the launcher costs a real build, and proving "a stale marker reinstalls" costs a
 * real `npm install`. As a function over a directory, all three are a few files in a temp folder.
 *
 * ⚠️ **COMPARED AGAINST npm'S OWN MARKER, NOT THE DIRECTORY'S mtime — AND THAT WAS THE DEFECT.** A
 * directory's mtime moves only when an entry is added or removed at its top level, which
 * reinstalling the same tree does not do; `npm install` DOES touch `package-lock.json`. So one
 * install left the lockfile permanently newer than `node_modules`, and every subsequent start
 * reinstalled — two minutes a run on a checkout with nothing to do, which is exactly the outcome the
 * conditional install exists to avoid. `node_modules/.package-lock.json` is written by npm on every
 * install and describes the tree it actually laid down.
 */

import { existsSync, statSync } from "node:fs";
import { join } from "node:path";

/** npm's record of the tree it installed. Its absence means nobody can vouch for what is there. */
export const INSTALLED_MARKER = ".package-lock.json";

/**
 * @param {string} root  the checkout whose dependencies are in question
 * @returns {{install: boolean, why: string}} the decision AND its reason, so the caller can say it
 */
export function dependencyState(root) {
  const modules = join(root, "node_modules");
  if (!existsSync(modules)) return { install: true, why: "no node_modules" };

  // ⚠️ **THE MARKER IS ASKED ABOUT BEFORE THE LOCKFILE, AND THE ORDER IS THE WHOLE ANSWER.** With the
  // lockfile checked first, a checkout holding nothing but an empty `node_modules` fell through the
  // "nothing to be newer than" branch and was declared usable — the one case where there is least
  // reason to believe it. Whether npm laid this tree down is a question about the TREE; whether it
  // is current is a question about the lockfile, and the second is only worth asking once the first
  // has an answer.
  const marker = join(modules, INSTALLED_MARKER);
  // ⚠️ A TREE npm DID NOT LAY DOWN. Refusing to guess about it is the same instinct as #70's: the
  // cost of a needless install is minutes, and the cost of skipping a needed one is a broken start.
  if (!existsSync(marker)) return { install: true, why: `no ${INSTALLED_MARKER}` };

  const lock = join(root, "package-lock.json");
  // A tree npm laid down, with no lockfile to be newer than it: nothing says it is stale.
  if (!existsSync(lock)) return { install: false, why: "no lockfile to compare against" };

  try {
    return statSync(lock).mtimeMs > statSync(marker).mtimeMs
      ? { install: true, why: "the lockfile is newer than the installed tree" }
      : { install: false, why: "the installed tree matches the lockfile" };
  } catch (e) {
    return { install: true, why: `could not compare (${e.code ?? "unknown"})` };
  }
}
