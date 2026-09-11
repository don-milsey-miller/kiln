/**
 * Kiln's owned fields in Pi's project settings — TSK-0029, CMP-0024, against ACC-0047 and ACC-0048.
 *
 * `.pi/settings.json` is Pi's file. Pi writes it, `pi install -l` writes it, and an operator may edit it by
 * hand. Kiln owns six keys inside it and nothing else: the Kiln package entry, the skill-override path, the
 * default provider, model and thinking level, and the session directory. This module merges exactly those.
 *
 * ⚠️ **NO SCHEMA, AND NO SCHEMA VERSION.** Pi's settings format has no version field, and Kiln has no
 * standing to declare the shape of a file it does not own. What is refused is what cannot be merged safely:
 * text that is not JSON, a root that is not an object, and a value in one of Kiln's own keys that Kiln could
 * not have written. Every other key — Pi's, a third party's, one that does not exist yet — is kept.
 *
 * ⚠️ **PRESERVATION IS STRUCTURAL, AND KEY ORDER IS PI'S SERIALIZER'S.** The merge copies the parsed object
 * and assigns Kiln's keys onto that copy, so every unrelated value is kept, ordinary string keys keep their
 * relative order, an absent Kiln key is appended, and nothing Kiln does not own is rebuilt. A `packages` or
 * `skills` entry that is not Kiln's is carried through as the same value in the same place. Integer-like
 * property names are the exception: JavaScript's JSON puts them first in ascending numeric order, and Pi's own
 * save does exactly the same, so they follow that order rather than their original textual position (D37).
 *
 * ⚠️ **"NOTHING TO DO" IS DECIDED ON CONTENT, AND MEANS NO BYTES.** When the merged document equals the
 * parsed one, no text is returned and the transaction writes nothing — so a file already in the desired
 * state is left byte-identical even if it is indented differently from how Kiln would write it.
 *
 * ⚠️ **PI'S LOCK IS HONOURED, WITHOUT IMPORTING PI'S STORAGE.** Pi saves project settings under a
 * `proper-lockfile` lock on the file and writes in place; the setup transaction's own lock does not block
 * it. The write here takes that same lock — same library, same `<file>.lock` directory, same `realpath:
 * false`, same stale window — and holds it across the transaction's final identity check and its atomic
 * replacement, both of which happen inside `tx.merge`. A Pi save that lands first changes the file, and the
 * identity check refuses; a Pi save that arrives while this holds the lock cannot take it.
 *
 * ⚠️ **A LOCK IS ONLY HELD WHILE ITS HOLDER CAN SAY SO.** `proper-lockfile` keeps a lock alive by
 * touching its directory from a timer, every half of the stale window. A holder that is suspended,
 * descheduled, or blocking its own event loop for longer than that window leaves a lock the library
 * calls abandoned, and another writer — Pi, on its own default — may take it over and write. This is
 * the same contract Kiln relies on to recover from a Pi process that died holding the lock, so it
 * cannot be closed from one side; it is an operational property, not a defect, and it is stated here
 * because "Kiln holds the lock across the write" is only true of a process that is actually running.
 *
 * ⚠️ **A LOCK THAT CANNOT BE SHOWN RELEASED IS A REFUSAL, EVEN AFTER A SUCCESSFUL MERGE.** A lock left behind
 * blocks every Pi settings save until it goes stale, so a release that fails, or one that returns with Kiln's
 * lock directory still in place, is reported rather than swallowed. An earlier refusal is kept as
 * `priorReason`, by code only. A directory created only to hold the lock is removed only while it is empty,
 * so a file another writer put there keeps it.
 *
 * ⚠️ **THE PACKAGE ENTRY IS SUPPLIED, NEVER CONSTRUCTED.** `pi install -l` writes the literal entry, TSK-0030
 * proves canonical equivalence and chooses the portable spelling, and this merge only applies that decision.
 * With no `packageEntry` supplied, `packages` is left exactly as it is.
 */

import { existsSync, mkdirSync, rmdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

import lockfile from "proper-lockfile";

import { canonicalPath, pathIdentityKey } from "./content-root.mjs";
import { STATE_MODE } from "./local-state.mjs";
import { SetupRefusal, runWithTransaction, transactionState } from "./setup-transaction.mjs";

export const SETTINGS_PATH = ".pi/settings.json";
export const SETTINGS_KEY = `project:${SETTINGS_PATH}`;

/** Relative to `.pi`, as Pi resolves resource paths in project settings. Observed overriding in EVD-0081. */
export const SKILL_OVERRIDE_PATH = "../planning-content/skills-overrides";

/** Written only when project-local state is selected. Pi resolves it against its working directory. */
export const PROJECT_SESSION_DIR = ".pi/sessions";

/** Pi 0.84.4's `VALID_THINKING_LEVELS`, compared against the installed package by a test. */
export const THINKING_LEVELS = Object.freeze(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

/** Pi's `lockSync` uses proper-lockfile's default stale window; judging staleness differently would not coordinate. */
const LOCK_STALE_MS = 10_000;

/** Pi retries its lock for about 200 ms. Kiln waits somewhat longer, then refuses rather than waiting forever. */
const DEFAULT_LOCK_RETRIES = Object.freeze({ retries: 40, factor: 1, minTimeout: 25, maxTimeout: 50 });

export const SETTINGS_REFUSAL = Object.freeze({
  MALFORMED: "settings-malformed",
  NOT_AN_OBJECT: "settings-not-an-object",
  INVALID_OWNED_VALUE: "settings-invalid-owned-value",
  INVALID_DESIRED: "settings-invalid-desired-state",
  NOT_PLANNED: "settings-not-planned",
  NO_LEASE: "settings-no-lease",
  LOCKED: "settings-locked",
  LOCK_COMPROMISED: "settings-lock-compromised",
  LOCK_CLEANUP_FAILED: "settings-lock-cleanup-failed",
});

export class SettingsRefusal extends Error {
  constructor(reason, message, detail = {}) {
    super(message);
    this.name = "SettingsRefusal";
    this.reason = reason;
    this.detail = detail;
  }
}

const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/**
 * What each Kiln-owned key must hold if it is present at all. An absent key is fine: Kiln adds it.
 *
 * ⚠️ `packages` and `skills` are checked only as arrays. Their entries mostly belong to other writers, and a
 * third-party entry Kiln does not understand is not Kiln's to refuse.
 */
const OWNED_VALUE_CHECKS = Object.freeze({
  defaultProvider: (v) => typeof v === "string" && v.length > 0,
  defaultModel: (v) => typeof v === "string" && v.length > 0,
  defaultThinkingLevel: (v) => THINKING_LEVELS.includes(v),
  sessionDir: (v) => typeof v === "string",
  packages: (v) => Array.isArray(v),
  skills: (v) => Array.isArray(v),
});

/**
 * Parse existing settings text, or refuse.
 *
 * ⚠️ **NO PARSER TEXT, AND NO VALUES, EVER REACH A MESSAGE.** V8's `JSON.parse` error quotes the input
 * around the failure, and a malformed settings file can hold anything an operator pasted into it. Refusals
 * name the problem and, for an owned value, the key — never what the key held.
 *
 * @param {string} text
 * @returns {object}
 */
export function readSettings(text) {
  let doc;
  let parsed = false;
  if (typeof text === "string") {
    try {
      doc = JSON.parse(text.replace(/^\uFEFF/, ""));
      parsed = true;
    } catch {
      parsed = false;
    }
  }
  if (!parsed)
    throw new SettingsRefusal(
      SETTINGS_REFUSAL.MALFORMED,
      `${SETTINGS_PATH} is not valid JSON, so Kiln cannot merge its fields without risking what it holds.`
    );
  if (!isPlainObject(doc))
    throw new SettingsRefusal(
      SETTINGS_REFUSAL.NOT_AN_OBJECT,
      `${SETTINGS_PATH} does not hold a JSON object, so it has no fields for Kiln to merge into.`
    );

  for (const [field, valid] of Object.entries(OWNED_VALUE_CHECKS))
    if (Object.hasOwn(doc, field) && !valid(doc[field]))
      throw new SettingsRefusal(
        SETTINGS_REFUSAL.INVALID_OWNED_VALUE,
        `${SETTINGS_PATH} holds a value for \`${field}\` that Kiln could not have written. Refusing rather than ` +
          `replacing it: the file is left exactly as it is for whoever put that value there to correct.`,
        { field }
      );

  return doc;
}

/** The transaction plan entry, so existing settings are validated at plan time, before anything is written. */
export function settingsTarget() {
  return {
    path: SETTINGS_KEY,
    validate: (text) => {
      readSettings(text);
    },
  };
}

/**
 * A relative path that means the same thing on every platform and every machine.
 *
 * ⚠️ It must start `./` or `../` and use forward slashes. A drive letter, a leading `/`, a `~` home reference
 * or a backslash is a machine-specific path, and this file is committed.
 */
const isPortableRelativePath = (v) =>
  typeof v === "string" && /^\.\.?\//.test(v) && !/[\\~\0]/.test(v) && !/\/\//.test(v);

const hasNoControlCharacters = (v) => typeof v === "string" && !/[\u0000-\u001f\u007f]/.test(v);

/**
 * The desired state, checked before anything touches the filesystem, and normalised.
 *
 * @param {{stateMode: string, provider: string, model: string, thinkingLevel: string,
 *          packageEntry?: string|null, packageEntryEquivalents?: string[]}} desired
 */
export function validateDesired(desired) {
  const refuse = (field) => {
    throw new SettingsRefusal(
      SETTINGS_REFUSAL.INVALID_DESIRED,
      `The desired value for \`${field}\` cannot be written to a committed settings file. Nothing was changed.`,
      { field }
    );
  };

  if (!isPlainObject(desired)) refuse("desired");
  const { stateMode, provider, model, thinkingLevel, packageEntry = null, packageEntryEquivalents = [] } = desired;

  if (!Object.values(STATE_MODE).includes(stateMode)) refuse("stateMode");
  if (typeof provider !== "string" || provider.trim() !== provider || provider.length === 0 || !hasNoControlCharacters(provider))
    refuse("provider");
  if (typeof model !== "string" || model.trim() !== model || model.length === 0 || !hasNoControlCharacters(model))
    refuse("model");
  if (!THINKING_LEVELS.includes(thinkingLevel)) refuse("thinkingLevel");
  if (packageEntry !== null && !isPortableRelativePath(packageEntry)) refuse("packageEntry");
  if (!Array.isArray(packageEntryEquivalents) || packageEntryEquivalents.some((e) => typeof e !== "string" || e.length === 0))
    refuse("packageEntryEquivalents");
  if (packageEntry === null && packageEntryEquivalents.length > 0) refuse("packageEntryEquivalents");

  return Object.freeze({
    stateMode,
    provider,
    model,
    thinkingLevel,
    packageEntry,
    packageEntryEquivalents: Object.freeze([...packageEntryEquivalents]),
  });
}

/**
 * Put `value` in `entries` exactly once, in Pi's string form or its `{source}` form, leaving every other
 * entry where it was.
 *
 * ⚠️ **THE FIRST OCCURRENCE KEEPS ITS PLACE AND ITS FORM.** An object entry may carry filters —
 * `{source, skills: [...]}` — and flattening it to a string would silently widen what Pi loads. Only its
 * `source` is corrected, and only when it was one of the proven-equivalent spellings. Later occurrences are
 * duplicates of Kiln's own entry and are dropped. Nothing that is not Kiln's is touched.
 */
function onceIn(entries, value, equivalents) {
  const names = [value, ...equivalents];
  const isOwned = (e) =>
    (typeof e === "string" && names.includes(e)) || (isPlainObject(e) && typeof e.source === "string" && names.includes(e.source));

  const out = [];
  let placed = false;
  for (const entry of entries) {
    if (!isOwned(entry)) {
      out.push(entry);
      continue;
    }
    if (placed) continue;
    placed = true;
    if (typeof entry === "string") out.push(value);
    else out.push(entry.source === value ? entry : { ...entry, source: value });
  }
  if (!placed) out.push(value);
  return out;
}

/** The existing file's trailing-newline style. A new file has none, as Pi writes it. */
function trailingNewlineOf(text) {
  if (text === null) return "";
  if (text.endsWith("\r\n")) return "\r\n";
  if (text.endsWith("\n")) return "\n";
  return "";
}

/**
 * The merged settings text, or `null` when the desired state already holds.
 *
 * Pure: no filesystem, no environment. Everything it writes comes from `currentText` and `desired`.
 *
 * @param {string|null} currentText  the file as read under the transaction, or null when absent
 * @param {object} desired           see `validateDesired`
 * @returns {string|null}
 */
export function mergeSettingsText(currentText, desired) {
  const d = validateDesired(desired);
  const current = currentText === null ? {} : readSettings(currentText);

  const next = { ...current };
  next.defaultProvider = d.provider;
  next.defaultModel = d.model;
  next.defaultThinkingLevel = d.thinkingLevel;
  if (d.packageEntry !== null) next.packages = onceIn(current.packages ?? [], d.packageEntry, d.packageEntryEquivalents);
  next.skills = onceIn(current.skills ?? [], SKILL_OVERRIDE_PATH, []);

  // ⚠️ EXTERNAL STATE COMMITS NO SESSION PATH. The external root is machine-specific; the supervisor passes
  // `--session-dir` for it, which outranks this setting, so removing Kiln's key loses nothing and commits nothing.
  if (d.stateMode === STATE_MODE.PROJECT) next.sessionDir = PROJECT_SESSION_DIR;
  else delete next.sessionDir;

  if (currentText !== null && JSON.stringify(next) === JSON.stringify(current)) return null;
  return JSON.stringify(next, null, 2) + trailingNewlineOf(currentText);
}

/** Which directory is at `path`, so a lock another writer takes after Kiln's release is not mistaken for Kiln's. */
function directoryIdentity(path) {
  try {
    const s = statSync(path, { bigint: true });
    return `${s.dev}:${s.ino}:${s.birthtimeNs}`;
  } catch (e) {
    if (e?.code === "ENOENT") return null;
    throw e;
  }
}

/** Whether the lock directory Kiln took is still there. One that cannot be looked at cannot be shown gone. */
function kilnLockRemains(lockPath, identity) {
  try {
    const now = directoryIdentity(lockPath);
    return now !== null && (identity === null || now === identity);
  } catch {
    return true;
  }
}

/**
 * A lost lock, before the merge or during it.
 *
 * ⚠️ **BEFORE THE MERGE IS A SEPARATE CHECK, NOT A NICETY.** `onCompromised` can fire between taking the lock
 * and starting the merge — the lock directory deleted, or taken over as stale — and a merge run after that
 * holds nothing. Checking only afterwards would report the loss having already written under it.
 */
const compromisedRefusal = (when) =>
  new SettingsRefusal(
    SETTINGS_REFUSAL.LOCK_COMPROMISED,
    when === "before-merge"
      ? `The lock on ${SETTINGS_PATH} was lost before the merge ran, so nothing was written.`
      : `The lock on ${SETTINGS_PATH} was lost while the merge ran, so another writer may have raced it.`,
    { when }
  );

/** An earlier failure's code, never its message: an unexpected error's text can hold anything. */
const safeReason = (e) => (e instanceof SettingsRefusal || e instanceof SetupRefusal ? e.reason : "unexpected-error");

const STALE_LOCK_REMEDY =
  ` It goes stale after about ${LOCK_STALE_MS / 1000} seconds, or it can be removed once no Pi or Kiln process is using ` +
  `${SETTINGS_PATH}.`;

const CLEANUP_MESSAGES = Object.freeze({
  "lock-release-failed": `Releasing Kiln's lock on ${SETTINGS_PATH} failed, so the lock may still be in place and would block Pi's settings saves.${STALE_LOCK_REMEDY}`,
  "lock-left-behind": `Kiln's lock on ${SETTINGS_PATH} was still in place after its release returned, and would block Pi's settings saves.${STALE_LOCK_REMEDY}`,
  "directory-not-removed": "The .pi directory Kiln created only to hold the lock could not be removed, although nothing was written into it.",
});

const CLEANUP_OUTCOME = (primary) =>
  primary === null
    ? " The merge itself completed; what is refused is what it left behind."
    : " An earlier failure had already stopped the merge; its code is kept as priorReason.";

/**
 * Release Kiln's lock and remove a directory created only to hold it. Returns the step that failed, or null.
 *
 * ⚠️ **A RELEASE THAT RETURNS IS NOT PROOF.** The lock directory is looked at afterwards, and the same
 * directory still being there is a failure. A directory with a different identity is a lock another writer took
 * after Kiln let go: it is not Kiln's to report or remove.
 *
 * ⚠️ `ERELEASED` is proper-lockfile saying it already gave the lock up as compromised. That is not a release
 * failure, but whether Kiln's directory remains is still checked.
 *
 * ⚠️ **ONLY AN EMPTY DIRECTORY IS REMOVED.** `rmdirSync` refuses a directory with anything in it, so a file
 * another writer put there keeps it, and that is not a failure. Any other reason it cannot be removed is.
 */
async function releaseAndClean({ release, lockPath, lockIdentity, dir, removeDir }) {
  let step = null;
  if (release) {
    try {
      await release();
    } catch (e) {
      if (e?.code !== "ERELEASED") step = "lock-release-failed";
    }
    if (step === null && kilnLockRemains(lockPath, lockIdentity)) step = "lock-left-behind";
  }
  if (removeDir)
    try {
      rmdirSync(dir);
    } catch (e) {
      if (!["ENOTEMPTY", "EEXIST", "ENOENT"].includes(e?.code)) step ??= "directory-not-removed";
    }
  return step;
}

/**
 * Apply Kiln's desired settings through a live setup transaction, under Pi's settings lock.
 *
 * @param {object} options
 * @param {object} options.transaction   a live transaction whose plan includes `settingsTarget()`
 * @param {object} options.desired       see `validateDesired`
 * @param {object} [options.lockRetries] proper-lockfile retry options for acquiring Pi's lock
 * @param {(info: {path: string}) => Promise<void>} [options.onLockAcquired]  runs while the lock is held
 * @returns {Promise<{target: string, changed: boolean}>}
 */
export async function applyKilnSettings({
  transaction,
  desired,
  lockRetries = DEFAULT_LOCK_RETRIES,
  onLockAcquired = async () => {},
} = {}) {
  const lease = transactionState(transaction);
  if (!lease || !lease.active)
    throw new SettingsRefusal(
      SETTINGS_REFUSAL.NO_LEASE,
      `Writing ${SETTINGS_PATH} needs a live setup transaction, and none was supplied. Nothing was written.`
    );

  // ⚠️ BEFORE ANY FILESYSTEM CHANGE, so an invalid request cannot leave even a directory behind.
  const d = validateDesired(desired);

  const want = pathIdentityKey(canonicalPath(join(transaction.plan.projectRoot, ".pi", "settings.json")));
  const planned = [...transaction.plan.files.values()].find((f) => f.kind === "file" && pathIdentityKey(f.abs) === want);
  if (!planned)
    throw new SettingsRefusal(
      SETTINGS_REFUSAL.NOT_PLANNED,
      `${SETTINGS_PATH} was not in this transaction's plan. Plan it with settingsTarget() so the existing file ` +
        `is validated before anything is written.`
    );

  const dir = dirname(planned.abs);
  const lockPath = `${planned.abs}.lock`;
  const createdDir = !existsSync(dir);
  let release = null;
  let lockIdentity = null;
  let compromised = false;
  let primary = null;

  try {
    // Pi's lock directory lives beside the file, so the directory must exist before the lock can be taken.
    if (createdDir) mkdirSync(dir);

    try {
      release = await lockfile.lock(planned.abs, {
        realpath: false,
        stale: LOCK_STALE_MS,
        retries: lockRetries,
        onCompromised: () => {
          compromised = true;
        },
      });
    } catch (e) {
      if (e?.code === "ELOCKED")
        throw new SettingsRefusal(
          SETTINGS_REFUSAL.LOCKED,
          `Another writer is holding the lock on ${SETTINGS_PATH}. Refusing rather than writing around it; ` +
            `rerun once the other writer has finished.`
        );
      throw e;
    }
    lockIdentity = directoryIdentity(lockPath);

    await onLockAcquired({ path: planned.abs });

    if (compromised) throw compromisedRefusal("before-merge");

    // ⚠️ THE LOCK SPANS `tx.merge`, WHICH RE-READS AND COMPARES THE FILE AND THEN REPLACES IT ATOMICALLY.
    const result = await runWithTransaction(transaction, "applyKilnSettings", () =>
      transaction.merge(SETTINGS_KEY, (current) => mergeSettingsText(current, d))
    );

    if (compromised) throw compromisedRefusal("during-merge");
    return result;
  } catch (e) {
    primary = e;
    throw e;
  } finally {
    const step = await releaseAndClean({
      release,
      lockPath,
      lockIdentity,
      dir,
      // A directory created only to hold the lock goes again when nothing was written into it.
      removeDir: createdDir && !existsSync(planned.abs),
    });
    if (step !== null) {
      const detail = { step };
      if (primary !== null) detail.priorReason = safeReason(primary);
      // eslint-disable-next-line no-unsafe-finally
      throw new SettingsRefusal(SETTINGS_REFUSAL.LOCK_CLEANUP_FAILED, CLEANUP_MESSAGES[step] + CLEANUP_OUTCOME(primary), detail);
    }
  }
}
