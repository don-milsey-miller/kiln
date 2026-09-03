/**
 * The setup transaction — one lock, one write plan, one journal, for the whole of `setup`.
 *
 * ⚠️ **ONE LOCK FOR THE COMMAND, NOT ONE PER WRITE.** `withLock` is otherwise held around a single
 * read-modify-write, which is right for a typed tool and wrong here: setup touches the content
 * scaffold, `.gitignore`, `.pi/settings.json`, `.pi/kiln.json` and the local state root, and a
 * second process interleaving between two of those leaves a project half-configured by two writers
 * that each believed they held it. The transaction reuses the initializer's existing
 * `<project>/.planning-init.lock` rather than adding a second one, because two locks beside each
 * other are not mutual exclusion — they are two processes each holding one.
 *
 * ⚠️ **THE LOCK COMES FIRST, AND PLANNING HAPPENS INSIDE IT.** Planning is not a read-only survey:
 * it probes each parent directory by creating and renaming a real file. Doing that before the lock
 * meant two processes could probe, and could leave, the same directories concurrently — and an
 * earlier version left `.pi/` behind on a project that then refused to be set up. `planTransaction`
 * therefore REFUSES unless this process demonstrably owns the lockfile; `runTransaction` takes the
 * spec, acquires the lock, and plans within it.
 *
 * ⚠️ **CONTAINMENT IS CANONICAL, NOT LEXICAL.** `relative()` and `resolve()` compare the SPELLING of
 * a path. A junction or symbolic link at `<project>/.pi` pointing anywhere spells innocently and
 * resolves outside the project, and a write through it lands outside the boundary this module
 * exists to hold. Every target is resolved through its deepest existing ancestor and proved to sit
 * beneath a root the caller EXPLICITLY authorised — and re-proved under the lock immediately before
 * each write, because a junction can appear after planning as easily as an edit can.
 *
 * ⚠️ **PLAN BEFORE WRITE, AND COMPARE AGAIN BEFORE EACH MERGE.** Planning records what every file
 * looked like; the merge re-reads under the lock and refuses if the identity moved. The window it
 * closes is small and real: an operator editing `.pi/settings.json` in another window while setup
 * runs. Refusing costs a rerun; overwriting costs their edit.
 *
 * ⚠️ **A FAILURE LATE IN SETUP NEVER ROLLS BACK WHAT SUCCEEDED EARLY.** A valid planning scaffold
 * is the operator's work product, not this transaction's scratch space. If the agent phases fail,
 * setup reports partial completion and leaves the content alone — the journal exists so the
 * remaining phases can be resumed, not so the finished ones can be undone.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { atomicWrite, TEMP_SUFFIX } from "./atomic-write.mjs";
import { canonicalPath, isAtOrInside, pathIdentityKey } from "./content-root.mjs";
import { withLock } from "./lock.mjs";

/** The lock the initializer already owns. Named here so nobody invents a second one. */
export const SETUP_LOCK_FILE = ".planning-init.lock";

/**
 * The roots a target may live under, and the only two names a target key may carry.
 *
 * ⚠️ **`state` IS A SEPARATE ROOT BECAUSE IT MAY LIE OUTSIDE THE PROJECT.** With `--local-state
 * user` the runtime records live under `%LOCALAPPDATA%\Kiln\projects\<id>\` or
 * `$XDG_STATE_HOME/kiln/projects/<id>/`. "Inside the project root" is therefore not the boundary —
 * "inside a root the caller named" is. An authorised root the caller did not pass does not exist:
 * there is no default state root, so a spec that never mentions one cannot write to one.
 */
export const ROOT_NAMES = Object.freeze(["project", "state"]);

/**
 * A refusal, as distinct from a crash.
 *
 * ⚠️ Every refusal names what it saw and what would clear it. An operator meeting one is mid-setup
 * on their own project, and "invalid state" tells them nothing they can act on.
 */
export class SetupRefusal extends Error {
  constructor(reason, message, detail = {}) {
    super(message);
    this.name = "SetupRefusal";
    this.reason = reason;
    this.detail = detail;
  }
}

export const REFUSAL = {
  PATH_ESCAPE: "path-escape",
  UNREADABLE: "unreadable",
  MALFORMED: "malformed",
  UNKNOWN_SCHEMA_VERSION: "unknown-schema-version",
  NOT_WRITABLE: "not-writable",
  CONCURRENT_EDIT: "concurrent-edit",
  UNPLANNED_TARGET: "unplanned-target",
  LOCK_NOT_HELD: "lock-not-held",
  JOURNAL_NOT_REMOVED: "journal-not-removed",
  PROBE_NOT_REMOVED: "probe-not-removed",
  DUPLICATE_TARGET: "duplicate-target",
  TRANSACTION_REVOKED: "transaction-revoked",
  TRANSACTION_NOT_AUTHENTIC: "transaction-not-authentic",
  /**
   * ⚠️ NAMED FOR WHAT IS OBSERVABLE. It was `operation-not-awaited`, which claimed more than the
   * mechanism can see: an unawaited operation that has already settled is indistinguishable from an
   * awaited one, and it cannot cross the release boundary anyway. What is detectable — and what
   * matters — is work STILL RUNNING when the body returned.
   */
  OPERATION_STILL_RUNNING: "operation-still-running",
};

/**
 * The transactions this module has issued, and whether each is still live.
 *
 * ⚠️ **A SHAPE IS NOT AN IDENTITY.** A collaborator used to be trusted on the strength of carrying
 * a `plan.projectRoot` that matched, so `{ plan: { projectRoot } }` — an object literal — was
 * accepted as proof the lock was held, and the initializer went on to build a scaffold with no
 * exclusion whatsoever. Duck typing is fine for describing data and useless for authenticating a
 * capability: the only unforgeable fact about a transaction is that THIS module made it.
 *
 * ⚠️ **AND A CAPABILITY HAS A LIFETIME.** The `tx` object stays reachable after `runTransaction`
 * returns, so a caller that captured one could call `merge` with the lockfile already gone. The
 * ledger records `active`, revoked before the lock is released, which is what makes "holds the
 * lock" a claim about now rather than about some moment in the past.
 *
 * ⚠️ **A `WeakMap` SO A FINISHED TRANSACTION IS COLLECTABLE.** A `Map` here would pin every
 * transaction and its whole plan for the life of the process.
 */
const LEDGER = new WeakMap();

/**
 * What this module knows about `tx`, or `null` if it did not issue it.
 *
 * ⚠️ Returns a COPY. Handing back the ledger's own record would let a caller flip `active` and
 * re-authorise a revoked transaction, which is the forgery this exists to prevent wearing a
 * different hat.
 *
 * @param {unknown} tx
 * @returns {{projectRoot: string, active: boolean}|null}
 */
export function transactionState(tx) {
  const record = tx && typeof tx === "object" ? LEDGER.get(tx) : undefined;
  return record ? { projectRoot: record.projectRoot, active: record.active } : null;
}

/**
 * Run a collaborator's work AS PART OF `tx` — authenticated, and registered as in-flight.
 *
 * ⚠️ **AUTHENTICATING AT THE DOOR IS NOT THE SAME AS BEING INSIDE.** `transactionState` proves the
 * transaction was real and live at the moment it was asked. A collaborator that then goes off and
 * works on its own is outside the transaction's registry, so a body that never awaited it let the
 * transaction revoke and the lock release while the work carried on — the initializer built a whole
 * scaffold that way. Anything a collaborator does under the lock has to be work the transaction
 * knows it is waiting for, which means one primitive rather than a convention.
 *
 * @param {object} tx    the transaction object `runTransaction` handed to its body
 * @param {string} name  what this work is, for the refusal if it outlives its welcome
 * @param {() => Promise<any>|any} fn
 */
export async function runWithTransaction(tx, name, fn) {
  const record = tx && typeof tx === "object" ? LEDGER.get(tx) : undefined;
  if (!record)
    throw new SetupRefusal(
      REFUSAL.TRANSACTION_NOT_AUTHENTIC,
      `${name} was asked to run inside something that is not a transaction this module issued. An ` +
        `object that merely looks like one holds no lock, so running inside it is running inside nothing.`,
      { operation: name }
    );
  return record.enrol(name, fn);
}

const digestOf = (text) => `sha256:${createHash("sha256").update(text).digest("hex")}`;

const toPosix = (p) => p.split(sep).join("/");

/* ============================================================== paths and containment ========== */

/**
 * Split a target key into its root name and the path beneath it. A bare path means the project
 * root, so the common case reads as a path and the uncommon one cannot be mistaken for it.
 */
function splitKey(key) {
  if (typeof key !== "string" || key.length === 0)
    throw new SetupRefusal(REFUSAL.PATH_ESCAPE, `A target key must be a non-empty string, got ${JSON.stringify(key)}.`);
  const i = key.indexOf(":");
  if (i > 0) {
    const name = key.slice(0, i);
    if (ROOT_NAMES.includes(name)) return { root: name, rel: key.slice(i + 1) };
  }
  return { root: "project", rel: key };
}

/** The canonical roots this spec authorises, by name. */
function authorizedRoots(spec) {
  const roots = new Map();
  if (!spec?.projectRoot) throw new SetupRefusal(REFUSAL.PATH_ESCAPE, "A transaction needs a project root.");
  roots.set("project", canonicalPath(resolve(spec.projectRoot)));
  if (spec.stateRoot) roots.set("state", canonicalPath(resolve(spec.stateRoot)));
  return roots;
}

/**
 * Resolve one target key to a canonical absolute path and PROVE it stays inside its declared root.
 *
 * ⚠️ **THE CANONICALISATION IS THE BOUNDARY; THE SYNTAX CHECKS ARE ONLY VALIDATION.** Rejecting
 * `..` and drive letters catches a mistake. It does not catch a junction, because a junction is not
 * a spelling — it is a place. Only resolving through the deepest existing ancestor and comparing
 * canonical prefixes decides where a path actually goes, and that resolver is shared with the
 * content root's (#70/#86) rather than written a second time here.
 *
 * ⚠️ **AND THE KEY COMES BACK FROM THE RESOLVED PATH, NOT FROM WHAT THE CALLER TYPED.** A canonical
 * LOCATION is not a canonical IDENTITY: `.pi/settings.json` and `.pi/a/../settings.json` resolve to
 * one file and used to enter the plan as two entries, each with its own recorded identity, the
 * second silently winning. Deriving the key from `abs` collapses every spelling of a file onto one
 * plan entry.
 */
function resolveTarget(roots, key) {
  const { root, rel } = splitKey(key);
  const base = roots.get(root);
  if (!base)
    throw new SetupRefusal(
      REFUSAL.PATH_ESCAPE,
      `Target ${JSON.stringify(key)} names the ${JSON.stringify(root)} root, which this transaction was not ` +
        `given. Authorised roots: ${[...roots.keys()].join(", ")}. A root nobody passed is not a default.`,
      { key, root }
    );

  if (!rel || isAbsolute(rel) || /^[A-Za-z]:/.test(rel) || rel.includes(":"))
    throw new SetupRefusal(
      REFUSAL.PATH_ESCAPE,
      `Target ${JSON.stringify(key)} must be a relative path beneath the ${root} root — no absolute path, ` +
        `no drive letter, no colon. Name the root instead: "state:runtime/....json".`,
      { key, root }
    );

  const abs = canonicalPath(join(base, toPosix(rel)));

  if (abs === base || !isAtOrInside(abs, base))
    throw new SetupRefusal(
      REFUSAL.PATH_ESCAPE,
      `Refusing to plan a write outside the ${root} root.\n` +
        `  target:    ${key}\n  canonical: ${abs}\n  root:      ${base}\n` +
        `A junction or symbolic link inside the project is still a path out of it — the spelling of a ` +
        `path is not its location, so containment is decided after resolving it.`,
      { key, root, canonical: abs, base }
    );

  const canonicalRel = toPosix(relative(base, abs));
  return { key: `${root}:${canonicalRel}`, root, rel: canonicalRel, base, abs };
}

/**
 * Prove, under the lock, that a target still resolves where the plan said it did.
 *
 * ⚠️ A junction can appear between planning and writing exactly as an edit can. This closes that
 * window to the gap between this check and the rename immediately after it; the lock bounds who
 * else is legitimately writing, and no cross-platform API lets a rename refuse to follow a link.
 * Naming the residual gap is honest; pretending the plan-time check covered it would not be.
 */
function verifyStillResolves(entry) {
  const now = canonicalPath(join(entry.base, entry.rel));
  if (now !== entry.abs)
    throw new SetupRefusal(
      REFUSAL.PATH_ESCAPE,
      `${entry.key} no longer resolves where setup planned it.\n` +
        `  planned: ${entry.abs}\n  now:     ${now}\n` +
        `Something replaced a directory on that path with a link after the plan was built.`,
      { key: entry.key, planned: entry.abs, current: now }
    );
}

/* ============================================================== preflight ====================== */

/**
 * Remove exactly one path, tolerating only its absence, and REPORT anything else.
 *
 * ⚠️ **ONE CLASSIFICATION FOR ALL THREE CALLERS** — the probe's files, the probe's directories and
 * the journal. Each of them has the same question to answer and the same wrong answer available:
 * `catch {}` turns "I could not undo what I did" into silence, and silence is indistinguishable
 * from success to everything downstream.
 *
 * ⚠️ **ENOENT IS THE ONLY BENIGN OUTCOME**, because it means the thing this was asked to achieve is
 * already true. Every other code means a file or directory is still there.
 *
 * @param {string} path
 * @param {{dir?: boolean}} [opts]  `dir` uses rmdir, so a directory something else populated
 *   survives and is reported rather than being recursively destroyed.
 * @returns {{path: string, code: string}|null} what was left behind, or null
 */
export function removeOrReport(path, { dir = false } = {}) {
  try {
    if (dir) rmdirSync(path);
    else unlinkSync(path);
  } catch (e) {
    if (e.code !== "ENOENT") return { path, code: e.code ?? e.message };
  }
  // ⚠️ **ENOENT DOES NOT PROVE ABSENCE, AND THIS WAS MEASURED, NOT ASSUMED.** On Windows,
  // `rmdirSync` against a FILE throws ENOENT and leaves the file exactly where it was — so a rule
  // that trusted the code would have reported a clean cleanup over a probe file still sitting in
  // the operator's project. The postcondition is what matters, so the postcondition is what is
  // checked: one stat, and the answer is what is there rather than what the syscall said.
  return existsSync(path) ? { path, code: "still-present" } : null;
}

const leftoverList = (leftovers) => leftovers.map((l) => `  ${l.path} (${l.code})`).join("\n");

/** The directories on this path that do not exist yet, outermost first. */
function missingChain(dir) {
  const missing = [];
  let cur = dir;
  while (!existsSync(cur)) {
    missing.unshift(cur);
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return missing;
}

/**
 * Prove this process can create a temporary file beside the target and rename it into place —
 * the exact operation `atomicWrite` performs — then leave the directory exactly as it was found.
 *
 * ⚠️ **A DIRECTORY THAT EXISTS IS NOT A DIRECTORY THAT CAN BE WRITTEN.** A read-only checkout, a
 * permissions problem, or a filesystem that refuses rename-over is worth discovering BEFORE the
 * scaffold is created, not between two writes with half the work done. ⚠️ **IT PROBES RENAME, NOT
 * JUST CREATE**, because rename-over-existing is the operation that actually fails — on Windows it
 * is the one that retries on EPERM.
 *
 * ⚠️ **AND IT LEAVES NOTHING BEHIND, DIRECTORIES INCLUDED.** Probing `.pi/settings.json` on a fresh
 * project has to create `.pi/`; an earlier version created it and never removed it, so a plan that
 * subsequently REFUSED still changed the project. Every directory this creates is recorded and
 * removed in reverse on every exit path — with `rmdir`, not a recursive delete, so a directory
 * something else populated in the meantime survives untouched.
 */
function probeWritable(dir) {
  const from = join(dir, `.kiln-probe.${process.pid}${TEMP_SUFFIX}`);
  const to = join(dir, `.kiln-probe.${process.pid}.target${TEMP_SUFFIX}`);
  const created = [];
  let failure = null;

  try {
    for (const d of missingChain(dir)) {
      mkdirSync(d);
      created.push(d);
    }
    writeFileSync(from, "probe\n", "utf-8");
    writeFileSync(to, "existing\n", "utf-8"); // rename OVER something, which is the real case
    renameSync(from, to);
  } catch (e) {
    failure = new SetupRefusal(
      REFUSAL.NOT_WRITABLE,
      `Cannot write in ${dir}: ${e.code ?? e.message}. Setup would have failed partway through, so ` +
        `it refuses before writing anything.`,
      { dir, code: e.code }
    );
  }

  // ⚠️ CLEANED UP ON EVERY PATH, INCLUDING FAILURE: a probe left behind is indistinguishable from a
  // crashed writer's temp file to anyone reading the directory later. Innermost directory first,
  // since an outer one cannot go until what the probe put inside it has.
  const leftovers = [
    ...[from, to].map((p) => removeOrReport(p)),
    ...created.reverse().map((d) => removeOrReport(d, { dir: true })),
  ].filter(Boolean);

  if (leftovers.length) {
    // ⚠️ **A CLEANUP THAT FAILS IS NOT A DETAIL OF A REFUSAL — IT IS A CHANGE TO THE PROJECT.**
    // Swallowing it let planning report success with a probe file or a directory still sitting
    // there, which is precisely what "a refused plan leaves the project as it was found" denies.
    // Since it cannot be made true here, it is said out loud, with each path named.
    const refusal = new SetupRefusal(
      REFUSAL.PROBE_NOT_REMOVED,
      `Setup could not remove what its preflight probe created in ${dir}:\n${leftoverList(leftovers)}\n` +
        `Delete these before rerunning — planning is supposed to leave the project exactly as it ` +
        `found it, and it did not.` +
        (failure ? `\nThe probe had already failed: ${failure.message}` : ``),
      { dir, leftovers, ...(failure ? { cause: failure.reason } : {}) }
    );
    // ⚠️ The original refusal is retained, not replaced: it is why setup stopped, and the leftover
    // is a second fact about the same moment rather than a substitute for the first. Both reach the
    // operator in the message, because an operator reads the message and not `error.cleanup`.
    if (failure) {
      failure.cleanup = refusal;
      failure.detail.leftovers = leftovers;
      failure.message += `\nIt also could not remove what it had already created:\n${leftoverList(leftovers)}`;
      throw failure;
    }
    throw refusal;
  }

  if (failure) throw failure;
}

/**
 * Record what a file looks like now, so a later merge can tell whether it moved.
 *
 * `absent` is recorded rather than omitted: "did not exist when I planned" and "I never looked"
 * lead to different actions, and a file that APPEARS between plan and merge must refuse too.
 */
function identify(abs) {
  if (!existsSync(abs)) return { state: "absent" };
  let text;
  try {
    const st = statSync(abs);
    if (!st.isFile())
      throw new SetupRefusal(REFUSAL.UNREADABLE, `${abs} is not a regular file.`, { path: abs });
    text = readFileSync(abs, "utf-8");
  } catch (e) {
    if (e instanceof SetupRefusal) throw e;
    throw new SetupRefusal(REFUSAL.UNREADABLE, `Cannot read ${abs}: ${e.code ?? e.message}`, { path: abs, code: e.code });
  }
  return { state: "present", digest: digestOf(text), text };
}

/**
 * Prove this process owns the lock before planning touches the filesystem.
 *
 * ⚠️ **A STRUCTURAL CHECK, NOT A CONVENTION.** "Call `planTransaction` under the lock" written in a
 * comment is a rule that holds until the next caller; the probe writes real files, so a caller who
 * forgets is two processes creating and deleting the same directories. `withLock` records the
 * owning pid and host in the lockfile, which makes ownership something this can actually verify.
 */
function assertLockHeld(lockPath) {
  let owner = null;
  try {
    owner = JSON.parse(readFileSync(lockPath, "utf-8"));
  } catch {}
  if (!owner || owner.pid !== process.pid || owner.hostname !== hostname())
    throw new SetupRefusal(
      REFUSAL.LOCK_NOT_HELD,
      `Refusing to plan without holding ${lockPath}. Planning probes each target directory by ` +
        `creating and renaming a real file, so it is a write, not a survey. Use runTransaction(), ` +
        `which acquires the lock first.` +
        (owner ? `\n  currently held by pid ${owner.pid} on ${owner.hostname}` : `\n  no lock is held`),
      { lockPath, owner }
    );
}

/* ============================================================== the plan ======================= */

/**
 * Build the write plan: canonicalise and contain every target, validate what is readable, prove
 * each parent is writable, and record identities — all under the lock, and all before anything
 * lasting is written.
 *
 * ⚠️ **MUST BE CALLED WITH THE LOCK HELD** — `runTransaction` is the way to do that.
 *
 * @param {{
 *   projectRoot: string,
 *   stateRoot?: string,
 *   files?: Array<{path: string, validate?: (text: string, ctx: object) => void}>,
 *   journal?: {path: string, validate?: (record: object) => void},
 * }} spec
 */
export function planTransaction(spec) {
  const roots = authorizedRoots(spec);
  const projectRoot = roots.get("project");
  const lockPath = join(projectRoot, SETUP_LOCK_FILE);
  assertLockHeld(lockPath);

  const canonicalLock = canonicalPath(lockPath);
  const files = new Map();

  /**
   * ⚠️ **INDEXED BY PHYSICAL LOCATION, BECAUSE THE KEY IS NOT THE FILE.** Two entries can reach one
   * file two ways: the same root spelled differently, and — the case a key check cannot see at all
   * — two authorized roots that overlap, which is the DEFAULT arrangement, since project-local
   * state lives at `<project>/.pi`. `project:.pi/runtime/x.json` and `state:runtime/x.json` are
   * then one file under two names, with two recorded identities, and the second write would be
   * compared against an identity taken before the first.
   */
  const byLocation = new Map();

  const plot = (entry, kind) => {
    const t = resolveTarget(roots, entry.path);

    // ⚠️ The lock is not a target. Merging it would hand the transaction the file that says who
    // owns the transaction, and the failure mode is a project that can never be locked again.
    if (t.abs === canonicalLock)
      throw new SetupRefusal(
        REFUSAL.PATH_ESCAPE,
        `${t.key} is the transaction lock itself, which nothing may plan a write to.`,
        { key: t.key }
      );
    const location = pathIdentityKey(t.abs);
    const clash = byLocation.get(location);
    if (clash)
      throw new SetupRefusal(
        REFUSAL.DUPLICATE_TARGET,
        `Two entries in the write plan are the same file.\n` +
          `  ${clash}\n  ${t.key}\n  both resolve to: ${t.abs}\n` +
          `Two entries for one file are two recorded identities for one file, and the second write ` +
          `would be compared against an identity taken before the first. They may differ only in ` +
          `spelling, or they may arrive through two authorized roots that overlap.`,
        { key: t.key, clashesWith: clash, canonical: t.abs }
      );

    const identity = identify(t.abs);

    // ⚠️ VALIDATED AT PLAN TIME, WHERE A REFUSAL IS FREE. A malformed settings file discovered
    // mid-merge is a refusal with half the work done; discovered here it is a refusal with none.
    if (identity.state === "present" && entry.validate) {
      try {
        entry.validate(identity.text, { key: t.key, path: t.rel, absolute: t.abs });
      } catch (e) {
        if (e instanceof SetupRefusal) throw e;
        throw new SetupRefusal(
          REFUSAL.MALFORMED,
          `${t.key} could not be parsed as the file setup owns fields in: ${e.message}\n` +
            `Refusing to replace it — a file setup cannot read is a file whose contents it must not ` +
            `assume, and there is no --force because the only thing force could mean here is ` +
            `discarding something the operator wrote.`,
          { key: t.key, cause: e.message }
        );
      }
    }

    probeWritable(dirname(t.abs));
    files.set(t.key, { ...t, kind, ...identity });
    byLocation.set(location, t.key);
    return t.key;
  };

  for (const entry of spec.files ?? []) plot(entry, "file");

  // ⚠️ THE JOURNAL IS A PLANNED TARGET LIKE ANY OTHER. It used to take a free-form path and write
  // it directly, which meant the one file written on the FAILURE path was the only one that had
  // skipped containment, the probe and the identity comparison.
  //
  // ⚠️ ITS VALIDATOR GUARDS WHAT GOES OUT, NOT WHAT IS ALREADY THERE. A leftover journal is
  // recorded by identity and nothing more: it is Kiln's own file, the next flush replaces it, and
  // refusing to set a project up because the record of its LAST interruption is corrupt would turn
  // one bad file into a project that cannot recover.
  const journalKey = spec.journal ? plot({ path: spec.journal.path }, "journal") : null;
  const journalValidate = spec.journal?.validate ?? null;

  return { roots, projectRoot, lockPath, files, journalKey, journalValidate };
}

/** Every canonical path this transaction may touch, for printing before it mutates anything. */
export function describePlan(plan) {
  return {
    projectRoot: plan.projectRoot,
    roots: Object.fromEntries(plan.roots),
    lock: plan.lockPath,
    files: [...plan.files.values()].map((f) => ({
      target: f.key,
      absolute: f.abs,
      state: f.state,
      ...(f.kind === "journal" ? { kind: "journal" } : {}),
      ...(f.digest ? { digest: f.digest } : {}),
    })),
  };
}

/* ============================================================== the journal file =============== */

/**
 * Delete the journal, tolerating only its absence.
 *
 * ⚠️ **A SWALLOWED DELETION FAILURE IS A SUCCESSFUL SETUP THAT STILL LOOKS INTERRUPTED.** The
 * journal's PRESENCE is the interruption signal, so a run that reports success while leaving one
 * behind has published a lie about its own state — the next start reads as a recovery forever.
 * ENOENT is the one benign outcome: it means the thing this was asked to achieve is already true.
 */
export function removeJournalFile(path) {
  const left = removeOrReport(path);
  if (left)
    throw new SetupRefusal(
      REFUSAL.JOURNAL_NOT_REMOVED,
      `Setup finished, but its journal could not be removed: ${left.code}\n  ${left.path}\n` +
        `Delete that file before running setup again — while it exists, every start reads as a ` +
        `recovery from an interruption that did not happen.`,
      { path: left.path, code: left.code }
    );
}

/* ============================================================== running it ===================== */

/**
 * Acquire the lock, plan inside it, and run `body` with the whole plan available.
 *
 * @param {object} spec  as accepted by `planTransaction`
 * @param {(tx: object) => Promise<any>} body
 * @param {{lock?: object, operation?: string, now?: () => string}} [opts]
 */
export async function runTransaction(spec, body, opts = {}) {
  const projectRoot = canonicalPath(resolve(spec.projectRoot));
  const lockPath = join(projectRoot, SETUP_LOCK_FILE);

  return withLock(
    lockPath,
    async () => {
      // ⚠️ INSIDE THE LOCK. The probes below create and remove real directories.
      const plan = planTransaction(spec);
      return execute(plan, body, opts);
    },
    { maxWaitMs: 30_000, ...(opts.lock ?? {}) }
  );
}

async function execute(plan, body, opts) {
  const now = opts.now ?? (() => new Date().toISOString());
  const startedAt = now();

  /** The phase plan is written up front: a journal listing only what happened cannot say what was next. */
  const phases = [];
  let journalOpen = false;
  let lastCompletedPhase = null;
  let recovery = null;

  const journalEntry = plan.journalKey ? plan.files.get(plan.journalKey) : null;

  /**
   * ⚠️ THE JOURNAL DOES NOT RECORD ITSELF. Its own digest changes on every flush, so including it
   * would make the record describe a file that no longer matches by the time it lands.
   */
  const journalRecord = () => ({
    recordVersion: 1,
    operation: opts.operation ?? "setup",
    startedAt,
    phases: phases.map(({ name, status, detail }) => ({ name, status, ...(detail ? { detail } : {}) })),
    ...(lastCompletedPhase ? { lastCompletedPhase } : {}),
    fileIdentities: [...plan.files.values()]
      .filter((f) => f.kind !== "journal")
      .map((f) => ({
        root: f.root,
        path: f.rel,
        state: f.state,
        ...(f.digest ? { digest: f.digest } : {}),
      })),
    ...(recovery ? { recovery } : {}),
  });

  /** Write bytes to a planned, still-contained target, and update the plan to match reality. */
  const commit = async (entry, text) => {
    verifyStillResolves(entry);
    mkdirSync(dirname(entry.abs), { recursive: true }); // the probe removed what it created
    await atomicWrite(entry.abs, text);
    entry.state = "present";
    entry.digest = digestOf(text);
    entry.text = text;
  };

  /** Refuse if the file moved between the plan (or the last write) and now. */
  const requireUnmoved = (entry) => {
    verifyStillResolves(entry);
    const current = identify(entry.abs);
    const was = entry.state === "present" ? entry.digest : "absent";
    const is = current.state === "present" ? current.digest : "absent";
    if (was !== is)
      throw new SetupRefusal(
        REFUSAL.CONCURRENT_EDIT,
        `${entry.key} changed after setup planned its write and before the merge ran.\n` +
          `  planned: ${was}\n  now:     ${is}\n` +
          `Refusing rather than overwriting: the change is someone's edit, and setup's plan was ` +
          `built against what the file used to say. Rerun setup to plan against the current file.`,
        { key: entry.key, planned: was, current: is }
      );
    return current;
  };

  const flush = async () => {
    if (!journalOpen) return;
    const record = journalRecord();
    // Validated BEFORE the write, so an invalid journal stops the transaction instead of landing.
    if (plan.journalValidate) plan.journalValidate(record);
    requireUnmoved(journalEntry);
    await commit(journalEntry, JSON.stringify(record, null, 2) + "\n");
  };

  /**
   * The transaction's own lifetime, and the operations still running inside it.
   *
   * ⚠️ **REVOCATION IS WHAT MAKES "HOLDS THE LOCK" A CLAIM ABOUT NOW.** The `tx` object survives
   * `runTransaction` — a caller can capture it — and every method on it used to keep working, so a
   * retained `tx.merge` wrote a file with the lockfile already deleted. Nothing about the object
   * said when it stopped being a capability, so it never did.
   *
   * ⚠️ **AND IN-FLIGHT WORK IS TRACKED BECAUSE REVOCATION ALONE DOES NOT CATCH IT.** An operation
   * STARTED before the body returned is already past the guard; if nobody awaited it, it would
   * finish after the lock was gone — the same unprotected write, arriving by the one route a
   * revocation check cannot see.
   */
  const record = { projectRoot: plan.projectRoot, active: true, enrol: null };
  const inflight = new Set();

  const refuseIfRevoked = (name) => {
    if (!record.active)
      throw new SetupRefusal(
        REFUSAL.TRANSACTION_REVOKED,
        `tx.${name}() was called after its transaction finished and the lock was released. A ` +
          `transaction is a capability for the duration of runTransaction()'s body, not a handle to ` +
          `keep — outside it there is no exclusion, so a write through it is a write nobody is ` +
          `holding the project for. Open a new transaction.`,
        { operation: name }
      );
  };

  /**
   * Register one unit of work with this transaction: refused after revocation, and visible to the
   * drain until it settles. Every route into the transaction goes through here — the `tx` methods
   * and, via `runWithTransaction`, any collaborator running under the held lock.
   */
  const enrol = async (name, fn) => {
    refuseIfRevoked(name);
    const running = (async () => fn())();
    inflight.add(running);
    try {
      return await running;
    } finally {
      // Self-cleaning even when the CALLER never awaits: this `finally` belongs to this async
      // frame, which settles with `running` regardless of who is listening.
      inflight.delete(running);
    }
  };
  record.enrol = enrol;

  const guarded =
    (name, fn) =>
    (...args) =>
      enrol(name, () => fn(...args));

  const impl = {
    /** Declare the ordered plan before running it. */
    declarePhases(names) {
      for (const name of names) phases.push({ name, status: "pending" });
    },
    /**
     * Journaling starts only once there is a protected place to journal INTO. The phases before
     * that point are the ones the initializer already makes idempotent and refusal-safe on their
     * own; writing their journal into an unprotected directory would be the very thing the
     * coverage-before-data rule forbids. The DESTINATION was fixed at plan time — this only decides
     * WHEN the first record lands.
     */
    async beginJournal() {
      if (!journalEntry)
        throw new SetupRefusal(
          REFUSAL.UNPLANNED_TARGET,
          `No journal was planned, so there is nowhere contained to journal into. Pass ` +
            `{ journal: { path: "state:runtime/setup-transaction.json", validate } } to the transaction.`,
          {}
        );
      journalOpen = true;
      await flush();
    },
    async setRecovery(command, reason) {
      recovery = { command, ...(reason ? { reason } : {}) };
      await flush();
    },
    /** Run one declared phase, recording `running` before it starts. */
    async phase(name, fn) {
      const entry = phases.find((p) => p.name === name);
      if (!entry) throw new Error(`Phase ${JSON.stringify(name)} was not declared.`);
      // ⚠️ `running` IS PERSISTED BEFORE THE WORK, not after. A process killed mid-phase must leave
      // evidence that the phase may have half-happened; a status written only on completion cannot
      // tell "never started" from "died halfway", and those need different recoveries.
      entry.status = "running";
      await flush();
      try {
        const result = await fn(tx);
        entry.status = "complete";
        lastCompletedPhase = name;
        await flush();
        return result;
      } catch (e) {
        entry.status = "failed";
        entry.detail = e instanceof SetupRefusal ? `${e.reason}: ${e.message.split("\n")[0]}` : String(e.message ?? e);
        await flush();
        throw e;
      }
    },
    /**
     * Merge one planned file: re-read under the lock, refuse if it moved, and write only if the
     * bytes would actually change.
     *
     * @param {string} key  a planned target key, e.g. `.pi/settings.json` or `state:runtime/x.json`
     * @param {(current: string|null) => string|null} produce  desired content, or null to leave alone
     */
    async merge(key, produce) {
      // ⚠️ RESOLVED THE SAME WAY THE PLAN WAS, so a caller that spells a target differently at
      // merge time reaches the entry it planned rather than falling through to "unplanned".
      const planned = plan.files.get(resolveTarget(plan.roots, key).key);
      if (!planned || planned.kind === "journal")
        throw new SetupRefusal(
          REFUSAL.UNPLANNED_TARGET,
          `${key} was not in the write plan${planned ? " as a mergeable file — it is the journal" : ""}. ` +
            `Every file setup may write is contained, validated and probed before the first lasting ` +
            `write; merging an unplanned one would skip all three.`,
          { key }
        );

      // ⚠️ THE FRESH READ IS THE POINT. Comparing against the planned digest catches an edit that
      // arrived after planning — including a file that did not exist then and does now.
      const current = requireUnmoved(planned);

      const before = current.state === "present" ? current.text : null;
      const desired = produce(before);
      if (desired === null || desired === before) {
        // ⚠️ BYTE EQUALITY, NOT A REPORTED STATUS. "Nothing to do" has to mean the bytes already
        // match, or a rerun that rewrites identical content still churns mtimes and diffs.
        return { target: planned.key, changed: false };
      }

      await commit(planned, desired);
      return { target: planned.key, changed: true };
    },
  };

  /**
   * ⚠️ **THE READS ARE UNGUARDED ON PURPOSE.** `plan`, `describe()` and `journalRecord()` write
   * nothing, and a caller reporting on a transaction after it finished is exactly who needs them.
   * What is guarded is everything that could reach the filesystem, plus `declarePhases`, which
   * mutates the state the journal is written from.
   */
  const tx = {
    plan,
    describe: () => describePlan(plan),
    journalRecord,
    declarePhases: (...args) => {
      refuseIfRevoked("declarePhases");
      return impl.declarePhases(...args);
    },
    beginJournal: guarded("beginJournal", (...a) => impl.beginJournal(...a)),
    setRecovery: guarded("setRecovery", (...a) => impl.setRecovery(...a)),
    phase: guarded("phase", (...a) => impl.phase(...a)),
    merge: guarded("merge", (...a) => impl.merge(...a)),
  };
  // The unforgeable half: possession of THIS object is the credential, and the ledger says whether
  // it is still live. A collaborator authenticates through `transactionState`, never through shape.
  LEDGER.set(tx, record);

  let result;
  let failure = null;
  try {
    try {
      result = await body(tx);
    } catch (e) {
      failure = e;
    }

    // ⚠️ NOTHING MAY CROSS THE RELEASE BOUNDARY. Anything still running was started while the lock
    // was held and is entitled to finish under it, so it is drained rather than abandoned.
    //
    // ⚠️ **TO QUIESCENCE, NOT ONCE.** A single `allSettled` over one snapshot misses work the
    // snapshot's own operations start while being drained — the initializer's phases, a merge
    // chained off another merge — and that work would be registered after the wait and revoked
    // mid-flight. The loop re-reads the registry, so the exit condition is "the transaction is
    // idle" rather than "the operations I first saw have finished". It is deliberately unbounded:
    // the only other option is releasing the lock while work continues, which is the defect.
    const stillRunning = inflight.size;
    while (inflight.size) await Promise.allSettled([...inflight]);

    // ⚠️ REPORTED AS "STILL RUNNING", WHICH IS ALL THAT IS OBSERVABLE. An operation the body did not
    // await but which had already settled is indistinguishable from an awaited one — and could not
    // have crossed the boundary — so no claim is made about it. What is detectable is work in
    // flight at the moment the body returned, and that is a write whose outcome the run cannot
    // report even though it happened.
    if (!failure && stillRunning)
      failure = new SetupRefusal(
        REFUSAL.OPERATION_STILL_RUNNING,
        `${stillRunning} transaction operation(s) were still running when the body returned. They ` +
          `were drained to completion under the lock, so none of them wrote after it was released, ` +
          `and the run is reported failed: a write in flight when its transaction ends is one whose ` +
          `outcome the run cannot report. Await every call made through the transaction.`,
        { pending: stillRunning }
      );

    if (failure) {
      // Retained on failure, with whatever recovery advice was set. Nothing already written is
      // undone: a valid scaffold is the operator's, not this transaction's to reclaim.
      try {
        await flush();
      } catch (journalError) {
        // The original failure is what the operator has to act on; losing it to a second one while
        // reporting the second as the cause would be strictly worse than carrying both.
        if (failure && typeof failure === "object") failure.journalError = journalError;
      }
      throw failure;
    }

    // ⚠️ THE JOURNAL IS REMOVED ON SUCCESS, so its PRESENCE is the signal that a run was
    // interrupted. A journal that lingered would make every later start look like a recovery —
    // which is why a failure to remove it is raised rather than swallowed, even though all the
    // work succeeded.
    if (journalOpen) removeJournalFile(journalEntry.abs);
    return result;
  } finally {
    // ⚠️ REVOKED BEFORE `withLock` RELEASES THE FILE, and on every exit path including a throw.
    // The window this closes is the whole point: a transaction that outlived its lock by even one
    // statement is a capability with no exclusion behind it.
    record.active = false;
  }
}
