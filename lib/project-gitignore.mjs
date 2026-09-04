/**
 * The SINGLE owner of every Kiln edit to the consumer's `.gitignore`.
 *
 * ⚠️ **BUILT-INS ONLY.** This module is imported by `initialize-project.mjs`, which runs in a
 * checkout where `npm install` has not happened yet. An import of `ajv` anywhere in this graph would
 * make the documented first run fail on `Cannot find package`.
 *
 * ⚠️ **ONE OWNER, BECAUSE TWO APPENDERS IS HOW A HAND-EDITED FILE ACQUIRES TWO KILN BLOCKS.** The
 * logic here was `initialize-project.mjs`'s and worked; what it could not survive was setup growing
 * a second appender with its own idempotency rules. Every Kiln write to `.gitignore` goes through
 * `planIgnoreBlock` and `applyIgnoreBlock` — initialization and setup alike — so the at-most-once
 * rule is a property of the code rather than of two callers agreeing.
 *
 * ⚠️ **PLAN AND APPLY ARE SEPARATE ON PURPOSE.** The initializer plans before it generates the
 * content tree and applies just before the swap, because the other order leaves a crash window in
 * which the content root exists — so every later run reports `already-initialized` and does nothing
 * — while `.planning/` was never ignored, and nothing would ever notice.
 */

import { appendFileSync, closeSync, existsSync, openSync, readFileSync, writeSync } from "node:fs";
import { join } from "node:path";

import { GITIGNORE_BEGIN, GITIGNORE_END, GITIGNORE_RULE, GITIGNORE_STATUS } from "./project-scaffold.mjs";

export { GITIGNORE_BEGIN, GITIGNORE_END, GITIGNORE_RULE, GITIGNORE_STATUS };

/** A `.gitignore` line that ignores `.planning/`, in any of the spellings git treats as equivalent. */
const IGNORES_TOOL_DIR = new Set([".planning", ".planning/", "/.planning", "/.planning/"]);

/**
 * Decide what should happen to `.gitignore` WITHOUT writing anything.
 *
 * ⚠️ **A Kiln-marked block already present counts as `added`, not as `already-ignored`.** That
 * distinction is what makes a crash between the append and the rename recoverable: the rerun can see
 * that the block is Kiln's own work rather than a pre-existing rule, and records the truth.
 *
 * ⚠️ **The scan is of the file's text, not `git check-ignore`.** Shelling out to git would be more
 * thorough — it would see a global excludes file and a parent repository's rules — and it would make
 * the answer depend on a binary being on PATH in a command whose whole selling point is that it needs
 * nothing installed. The text scan is what this can honestly claim, and it is what the block-at-most-
 * once rule actually needs.
 */
export function planIgnoreBlock(projectRoot) {
  const path = join(projectRoot, ".gitignore");
  const gitPath = join(projectRoot, ".git");

  // A worktree or submodule has `.git` as a FILE pointing elsewhere; both are repositories.
  if (!existsSync(gitPath))
    return { repository: false, status: GITIGNORE_STATUS.NOT_A_REPOSITORY, action: "none", path };

  if (!existsSync(path))
    return { repository: true, status: GITIGNORE_STATUS.ADDED, action: "create", path, existing: "" };

  const existing = readFileSync(path, "utf-8");
  const lines = existing.split(/\r?\n/).map((l) => l.trim());

  if (lines.includes(GITIGNORE_BEGIN))
    return { repository: true, status: GITIGNORE_STATUS.ADDED, action: "none", path, existing };

  const ignored = lines.some((l) => IGNORES_TOOL_DIR.has(l));
  if (ignored) return { repository: true, status: GITIGNORE_STATUS.ALREADY_IGNORED, action: "none", path, existing };

  return { repository: true, status: GITIGNORE_STATUS.ADDED, action: "append", path, existing };
}

/**
 * Perform the planned `.gitignore` change.
 *
 * ⚠️ **It APPENDS; it never rewrites.** Every existing byte is carried through unchanged, and the
 * line ending is taken from what is already in the file — a CRLF `.gitignore` that grew three LF
 * lines is a diff nobody asked for on a checkout nobody configured.
 *
 * ⚠️ **THE FILE IS RE-READ HERE RATHER THAN WRITTEN FROM THE PLAN'S SNAPSHOT.** The plan is made
 * before the content tree is generated, and writing `plan.existing + block` would put those bytes
 * back — silently reverting anything that reached the file in between. The initializer's lock keeps
 * two Kilns apart; it does not keep an editor's save out. Re-reading also lets the append notice a
 * marked block that appeared after the plan was made, so the at-most-once rule holds even then.
 */
export function applyIgnoreBlock(plan) {
  if (plan.action === "none") return plan.status;

  // ⚠️ AN EXCLUSIVE CREATE, SO TWO PROCESSES CANNOT BOTH "CREATE" THE FILE. `wx` fails with EEXIST if
  // anything got there first — a concurrent Kiln, a `git init` template, the user — and that failure
  // is the signal to append instead. Checking `existsSync` and then writing would be the same race
  // with a wider window, and the loser would silently discard whatever the winner wrote.
  if (!existsSync(plan.path)) {
    try {
      const fd = openSync(plan.path, "wx");
      try {
        writeSync(fd, blockText("\n"));
      } finally {
        closeSync(fd);
      }
      return plan.status;
    } catch (e) {
      if (e.code !== "EEXIST") throw e; // a real failure, not contention
    }
  }

  // ⚠️ READ TO DECIDE, APPEND TO WRITE — never `writeFileSync(path, existing + block)`. Rebuilding
  // the whole file from a string this function is holding means every byte written between the read
  // and the write is destroyed, and `.gitignore` is a file people edit by hand and tools append to.
  // `appendFileSync` writes only the new bytes and cannot revert anyone else's.
  const existing = readFileSync(plan.path, "utf-8");
  if (existing.split(/\r?\n/).some((l) => l.trim() === GITIGNORE_BEGIN)) return plan.status;

  const eol = /\r\n/.test(existing) ? "\r\n" : "\n";
  if (existing.length === 0) {
    appendFileSync(plan.path, blockText(eol), "utf-8");
    return plan.status;
  }

  const separator = (existing.endsWith("\n") ? "" : eol) + eol;
  appendFileSync(plan.path, separator + blockText(eol), "utf-8");
  return plan.status;
}

/** The marked block, with the line ending the target file already uses. */
export function blockText(eol) {
  return [GITIGNORE_BEGIN, GITIGNORE_RULE, GITIGNORE_END].join(eol) + eol;
}
