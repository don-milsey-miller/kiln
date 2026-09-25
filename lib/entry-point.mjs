/**
 * Whether a module is the program Node was asked to run — TSK-0074, toward ACC-0118.
 *
 * ⚠️ **REAL PATHS ON BOTH SIDES, BECAUSE NODE RESOLVES ONE OF THEM.** Node loads the main module from its real path,
 * so `import.meta.url` names the target of any link on the way, while `process.argv[1]` keeps the path the operator
 * typed. Comparing the two as given made every command run through a linked `.planning` — a junction on Windows, a
 * directory symlink on POSIX — decide it was only imported, do nothing, and exit 0. Both are resolved here before
 * they are compared.
 *
 * ⚠️ **AN IMPORT IS STILL NOT A RUN.** A module imported by a test or another command is not `process.argv[1]`, so
 * it answers false, and its command does not run.
 *
 * ⚠️ **NODE BUILT-INS ONLY.** `bin/setup.mjs` loads this before it installs anything (ACC-0083).
 */

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * @param {string} moduleUrl  the caller's `import.meta.url`
 * @param {string} [argv1]    the path Node was given, `process.argv[1]` by default
 * @returns {boolean}
 */
export function isEntryPoint(moduleUrl, argv1 = process.argv[1]) {
  if (!argv1) return false;
  try {
    return realpathSync(argv1) === realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}
