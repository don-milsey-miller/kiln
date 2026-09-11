/**
 * The portable spelling of Kiln's package entry — TSK-0030, CMP-0024, against ACC-0105.
 *
 * `pi install -l` writes whatever spelling it resolved on the machine it ran on: a relative path with the
 * platform's separators, or an absolute one. That spelling is committed, so it has to become the portable
 * `../.planning/pi-package` form. Nothing here constructs that form as a target.
 *
 * ⚠️ **PROOF FIRST, REWRITE SECOND.** The literal entry and the portable entry are both resolved from the
 * directory the settings file lives in, which is how Pi resolves a package path, and both must name the same
 * directory on this platform. Only then is the rewrite handed to the settings merge. An entry that resolves
 * somewhere else, does not resolve, or cannot be read is left exactly as `pi install -l` wrote it — rewriting
 * it anyway would point the project at a directory nobody showed was the pinned package.
 *
 * ⚠️ **SAMENESS IS ASKED OF THE FILESYSTEM, NOT OF THE TEXT.** Two spellings are the same directory when
 * they canonicalise to the same path: `.` and `..` resolved, symlinks and junctions followed, and Windows
 * compared case-insensitively. That single comparison is the proof, over two paths already shown to be
 * readable directories. Comparing the strings as written would call `..\\.planning\\pi-package` and
 * `../.planning/pi-package` different on Windows, where they are one directory, and would call a link
 * different from the directory it points at.
 *
 * ⚠️ **NO PATH REACHES A REFUSAL.** The literal entry comes from a file that is committed and may hold an
 * absolute home path; a refusal says which side failed and why, never what it was.
 */

import { statSync } from "node:fs";
import { join, resolve } from "node:path";

import { canonicalPath, pathIdentityKey } from "./content-root.mjs";
import { SETTINGS_PATH, applyKilnSettings } from "./pi-settings.mjs";

/** The one spelling Kiln commits: relative to `.pi`, forward slashes, no machine in it. */
export const PORTABLE_PACKAGE_ENTRY = "../.planning/pi-package";

export const PACKAGE_ENTRY_REFUSAL = Object.freeze({
  INVALID_LITERAL: "package-entry-invalid-literal",
  CONFLICT: "package-entry-already-supplied",
  NO_TRANSACTION: "package-entry-no-transaction",
  MISSING: "package-entry-missing",
  UNREADABLE: "package-entry-unreadable",
  NOT_A_DIRECTORY: "package-entry-not-a-directory",
  NOT_EQUIVALENT: "package-entry-not-equivalent",
});

export class PackageEntryRefusal extends Error {
  constructor(reason, message, detail = {}) {
    super(message);
    this.name = "PackageEntryRefusal";
    this.reason = reason;
    this.detail = detail;
  }
}

/** Which spelling is being resolved, for a refusal that names the side without naming the path. */
const SIDE = Object.freeze({ LITERAL: "literal", PORTABLE: "portable" });

/**
 * The canonical path of the directory at `abs`, or a refusal naming `side`.
 *
 * ⚠️ The path is canonicalised only after `statSync` has shown a readable directory is there, so "the same
 * path" is always a statement about two directories that exist, never about two spellings of nothing.
 */
function canonicalDirectory(abs, side) {
  let stats;
  try {
    stats = statSync(abs);
  } catch (e) {
    if (e?.code === "ENOENT" || e?.code === "ENOTDIR")
      throw new PackageEntryRefusal(
        PACKAGE_ENTRY_REFUSAL.MISSING,
        `The ${side} package entry does not resolve to anything, so it cannot be shown to be the pinned ` +
          `package. ${SETTINGS_PATH} is left as it is.`,
        { side }
      );
    throw new PackageEntryRefusal(
      PACKAGE_ENTRY_REFUSAL.UNREADABLE,
      `The ${side} package entry cannot be read, so it cannot be shown to be the pinned package. ` +
        `${SETTINGS_PATH} is left as it is.`,
      { side, code: e?.code ?? null }
    );
  }

  if (!stats.isDirectory())
    throw new PackageEntryRefusal(
      PACKAGE_ENTRY_REFUSAL.NOT_A_DIRECTORY,
      `The ${side} package entry resolves to something that is not a directory, so it is not a package ` +
        `directory. ${SETTINGS_PATH} is left as it is.`,
      { side }
    );

  return pathIdentityKey(canonicalPath(abs));
}

/**
 * Prove that the literal entry and the portable entry name one directory, and return what the settings merge
 * needs to make the rewrite. Throws a `PackageEntryRefusal` when the proof cannot be made.
 *
 * @param {object} options
 * @param {string} options.settingsDir  the directory `.pi/settings.json` lives in, which package paths resolve against
 * @param {string} options.literalEntry the entry `pi install -l` wrote
 * @returns {{packageEntry: string, packageEntryEquivalents: string[]}}
 */
export function provePortablePackageEntry({ settingsDir, literalEntry }) {
  // A path may hold spaces and may be absolute. What it may not be is empty, or carry a NUL.
  if (typeof literalEntry !== "string" || literalEntry.trim().length === 0 || literalEntry.includes("\u0000"))
    throw new PackageEntryRefusal(
      PACKAGE_ENTRY_REFUSAL.INVALID_LITERAL,
      `The package entry to normalise must be the non-empty path \`pi install -l\` wrote. Nothing was changed.`,
      { side: SIDE.LITERAL }
    );

  const literal = canonicalDirectory(resolve(settingsDir, literalEntry), SIDE.LITERAL);
  const portable = canonicalDirectory(resolve(settingsDir, PORTABLE_PACKAGE_ENTRY), SIDE.PORTABLE);

  if (literal !== portable)
    throw new PackageEntryRefusal(
      PACKAGE_ENTRY_REFUSAL.NOT_EQUIVALENT,
      `The package entry \`pi install -l\` wrote resolves to a different directory from ` +
        `\`${PORTABLE_PACKAGE_ENTRY}\`, so rewriting it would point the project somewhere nobody showed was ` +
        `the pinned package. ${SETTINGS_PATH} is left as it is.`,
      { side: SIDE.LITERAL }
    );

  return { packageEntry: PORTABLE_PACKAGE_ENTRY, packageEntryEquivalents: [literalEntry] };
}

/**
 * Rewrite the package entry to its portable spelling, through the settings merge, once equivalence is proved.
 *
 * ⚠️ The package entry is this function's to decide, so `desired` must not carry one: two writers choosing it
 * is exactly the ambiguity the proof exists to remove.
 *
 * @param {object} options
 * @param {object} options.transaction    a live transaction whose plan includes `settingsTarget()`
 * @param {string} options.literalEntry   the entry `pi install -l` wrote
 * @param {object} options.desired        the rest of the desired state — see `validateDesired`
 * @param {object} [options.lockRetries]
 * @param {(info: {path: string}) => Promise<void>} [options.onLockAcquired]
 * @returns {Promise<{target: string, changed: boolean}>}
 */
export async function applyPortablePackageEntry({ transaction, literalEntry, desired, ...options }) {
  if (desired?.packageEntry != null || (desired?.packageEntryEquivalents ?? []).length > 0)
    throw new PackageEntryRefusal(
      PACKAGE_ENTRY_REFUSAL.CONFLICT,
      `The desired state already carries a package entry, and this is the function that decides it. Pass the ` +
        `rest of the desired state and the literal entry only. Nothing was changed.`,
      { side: SIDE.LITERAL }
    );

  const projectRoot = transaction?.plan?.projectRoot;
  if (typeof projectRoot !== "string" || projectRoot.length === 0)
    throw new PackageEntryRefusal(
      PACKAGE_ENTRY_REFUSAL.NO_TRANSACTION,
      `Normalising the package entry needs a live setup transaction, and none was supplied. Nothing was read ` +
        `and nothing was written.`,
      {}
    );

  // ⚠️ PROVED BEFORE THE TRANSACTION IS TOUCHED, so a refusal cannot leave a lock or a temporary file.
  const settingsDir = join(projectRoot, ".pi");
  const proved = provePortablePackageEntry({ settingsDir, literalEntry });

  return applyKilnSettings({ transaction, desired: { ...desired, ...proved }, ...options });
}
