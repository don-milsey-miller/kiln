/**
 * Where runtime state lives, and the refusal that stops it being written anywhere unsafe (CMP-0025,
 * REQ-0027, DEC-0029).
 *
 * ⚠️ **THE ORDERING IS THE REQUIREMENT, NOT THE LOCATION.** REQ-0027 names a sequence — coverage
 * first, then data — because a design that puts transcripts under an ignored path is correct and
 * still leaks if the first transcript is written before the ignore rule exists, or if the operator
 * deleted the rule and setup carried on. So the gate here is not "is this path a good place"; it is
 * "has the protection for this path been observed, right now, before anything is created". A caller
 * that cannot show that gets a refusal carrying the options, not a warning it may ignore.
 *
 * ⚠️ **THE TWO MODES ARE `project` AND `user`, AND THOSE SPELLINGS ARE NOT THIS MODULE'S TO
 * CHOOSE.** `schemas/runtime/kiln-session.schema.json` already fixes them, because a session record
 * names the mode it was written under and a resume compares it. Inventing `project-local` and
 * `external` here would put a second vocabulary beside the persisted one, and the two would
 * disagree the moment either moved.
 *
 * ⚠️ **THE EXTERNAL ROOT IS PER-PROJECT-ID, NEVER PER-PATH.** Deriving it from the project's
 * location would move the state out from under an operator who renamed or moved the project —
 * exactly when it must not move — and would leak the project's name into a directory name on every
 * machine. The id is random, meaningless, committed, and generated once (`generateProjectId`).
 *
 * ⚠️ **NOTHING HERE WRITES A COMMITTED ABSOLUTE PATH.** ACC-0050's third clause is a property of
 * what is NOT stored: the external root is recomputed from the platform and the committed id on
 * every run, so a clone on another machine derives its own and no user's home directory is ever
 * committed. `stateRootFor` is therefore a pure function of (mode, projectRoot, projectId, env) and
 * takes its environment as an argument so the derivation can be observed on both platforms from
 * either one.
 */

import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { atomicWrite } from "./atomic-write.mjs";
import { canonicalPath } from "./content-root.mjs";
import { IGNORE_RULES, coverage, planIgnoreBlock, blockText } from "./project-gitignore.mjs";
import { generateProjectId } from "./runtime-records.mjs";

/** The two state policies. Fixed by `schemas/runtime/kiln-session.schema.json`, not chosen here. */
export const STATE_MODE = Object.freeze({ PROJECT: "project", USER: "user" });

/** The committed, non-secret project record. Deliberately NOT ignored — see DEC-0029. */
export const PROJECT_RECORD = ".pi/kiln.json";

/** What `stateRootFor` refuses on, as distinct from a crash. */
export const STATE_REFUSAL = Object.freeze({
  UNKNOWN_MODE: "unknown-mode",
  NO_PROJECT_ID: "no-project-id",
  NO_USER_STATE_HOME: "no-user-state-home",
  COVERAGE_MISSING: "coverage-missing",
  RECORD_UNREADABLE: "project-record-unreadable",
});

export class LocalStateRefusal extends Error {
  constructor(reason, message, detail = {}) {
    super(message);
    this.name = "LocalStateRefusal";
    this.reason = reason;
    this.detail = detail;
  }
}

/* ------------------------------------------------------------------ the roots */

/**
 * The per-user state home for this platform, or `null` if the platform will not say.
 *
 * ⚠️ **`$XDG_STATE_HOME` ON EVERY POSIX PLATFORM INCLUDING macOS, and that is a deliberate refusal
 * to invent a third convention.** `setup-transaction.mjs` already documents the two roots this
 * project uses — `%LOCALAPPDATA%\Kiln\projects\<id>` and `$XDG_STATE_HOME/kiln/projects/<id>` — and
 * a module that quietly added `~/Library/Application Support` would make the documented layout wrong
 * on one platform without anything saying so. If macOS should differ, that is a decision to record
 * and then implement, not a default to slip in here.
 *
 * ⚠️ **`LOCALAPPDATA` RATHER THAN `APPDATA` ON WINDOWS, because this is state and not settings.**
 * `APPDATA` roams: on a domain profile it is copied between machines at logon, which would carry one
 * machine's session transcripts and consent records onto another — the precise thing the consent
 * record exists to keep machine-local (DEC-0028).
 */
export function userStateHome({ platform = process.platform, env = process.env, home = homedir() } = {}) {
  if (platform === "win32") {
    const local = env.LOCALAPPDATA;
    return local ? join(local, "Kiln") : null;
  }
  const xdg = env.XDG_STATE_HOME;
  if (xdg) return join(xdg, "kiln");
  return home ? join(home, ".local", "state", "kiln") : null;
}

/**
 * The state root for a mode.
 *
 * @param {{mode: string, projectRoot: string, projectId?: string|null, platform?: string,
 *          env?: object, home?: string}} opts
 */
export function stateRootFor({ mode, projectRoot, projectId = null, platform, env, home } = {}) {
  if (mode !== STATE_MODE.PROJECT && mode !== STATE_MODE.USER)
    throw new LocalStateRefusal(
      STATE_REFUSAL.UNKNOWN_MODE,
      `${JSON.stringify(mode)} is not a state mode. The two are ${JSON.stringify(STATE_MODE.PROJECT)} ` +
        `(the project's ignored .pi/) and ${JSON.stringify(STATE_MODE.USER)} (a per-user root keyed by ` +
        `the committed project id).`,
      { mode }
    );

  if (mode === STATE_MODE.PROJECT) {
    if (!projectRoot) throw new LocalStateRefusal(STATE_REFUSAL.UNKNOWN_MODE, "Project-local state needs a project root.");
    return layout(join(resolve(projectRoot), ".pi"), mode);
  }

  // ⚠️ THE ID IS REQUIRED RATHER THAN MINTED HERE. Minting inside a path derivation would create a
  // committed identity as a side effect of asking a question, and a caller that only wanted to SHOW
  // the operator where external state would go would have changed the project by asking.
  if (!projectId)
    throw new LocalStateRefusal(
      STATE_REFUSAL.NO_PROJECT_ID,
      `External state is keyed by the committed project id and this project has none yet. ` +
        `Write ${PROJECT_RECORD} first (\`ensureProjectId\`); deriving a root from the project's path ` +
        `instead would move the state the moment somebody moved or renamed the project.`,
      { projectRoot }
    );

  const base = userStateHome({ platform, env, home });
  if (!base)
    throw new LocalStateRefusal(
      STATE_REFUSAL.NO_USER_STATE_HOME,
      `This platform did not say where per-user state belongs (${
        (platform ?? process.platform) === "win32" ? "%LOCALAPPDATA% is unset" : "no $XDG_STATE_HOME and no home directory"
      }), so external state has nowhere to go. Use project-local state, or set the variable.`,
      { platform: platform ?? process.platform }
    );

  return layout(join(base, "projects", projectId), mode);
}

/** The layout inside a state root. Derived in one place so no caller spells `sessions` itself. */
function layout(root, mode) {
  return { mode, root, sessions: join(root, "sessions"), runtime: join(root, "runtime") };
}

/**
 * Create the state root's directories.
 *
 * ⚠️ **SEPARATE FROM DERIVING IT, because deriving must be safe to do in order to ASK.** Setup shows
 * the operator where each mode would put things before they choose; a derivation that created
 * directories would leave one of the two behind whichever they picked, and an abandoned `.pi/` on a
 * project that then refused setup is a defect this codebase has already had once.
 */
export function createStateRoot(roots) {
  for (const dir of [roots.root, roots.sessions, roots.runtime]) mkdirSync(dir, { recursive: true });
  return roots;
}

/* ------------------------------------------------------------------ coverage before data */

/**
 * Is the protection for project-local state in place RIGHT NOW?
 *
 * ⚠️ **ASKED OF THE FILE, NOT OF A RECORD OF THE FILE.** `state/setup.json` says what Kiln did once;
 * REQ-0027 is about what is true at the moment data is about to be written, and those differ exactly
 * when it matters — the operator deleted the block after setup ran. The ignore owner is the single
 * reader (CMP-0023), so this asks it rather than scanning the file a second way.
 *
 * ⚠️ **USER MODE IS NOT EXEMPT BECAUSE IT IS SAFE; IT IS EXEMPT BECAUSE IT IS OUTSIDE.** Nothing
 * under `%LOCALAPPDATA%` or `$XDG_STATE_HOME` is inside the operator's repository, so no ignore rule
 * protects it and none is needed. `.pi/settings.json` and `.pi/kiln.json` stay committed either way.
 */
export function coverageState({ projectRoot, mode, recorded = null }) {
  if (mode === STATE_MODE.USER) return { covered: true, mode, reason: "external state is outside the repository" };

  const plan = planIgnoreBlock(projectRoot, { recorded });

  // ⚠️ A PROJECT THAT IS NOT A REPOSITORY IS COVERED, and this is the one exemption that could be
  // mistaken for a loophole. Git tracks nothing here, so nothing can be published by it; the risk
  // REQ-0027 names does not exist until `git init`, and refusing would block the offline case the
  // initializer already supports.
  if (plan.repository === false)
    return { covered: true, mode, reason: "not a Git repository, so nothing here is tracked", plan };

  const uncovered = coverage(plan.existing ?? "").uncovered;
  return { covered: uncovered.length === 0, mode, uncovered, state: plan.state, plan };
}

/**
 * The gate: an authorised, created state root, or a refusal carrying what the operator may choose.
 *
 * ⚠️ **THE REFUSAL CARRIES THE OPTIONS RATHER THAN PROMPTING FOR THEM.** Interactive setup renders
 * these three and non-interactive setup fails on the same object, so "offers the block, external
 * state, or stopping" and "refuses" are one decision with two presentations instead of two code
 * paths that can disagree. The exact block text travels with it so the operator can be shown the
 * bytes rather than a description of them.
 *
 * ⚠️ **NOTHING IS CREATED BEFORE THE CHECK PASSES.** ACC-0049 asks that the paths not exist after a
 * refusal, not that a warning was printed, so the directory creation is the LAST thing this does.
 *
 * @returns {{ok: true, roots: object} | {ok: false, refusal: LocalStateRefusal, options: object[]}}
 */
export function openStateRoot({ projectRoot, mode, projectId = null, recorded = null, platform, env, home, create = true }) {
  const roots = stateRootFor({ mode, projectRoot, projectId, platform, env, home });
  const covers = coverageState({ projectRoot, mode, recorded });

  if (!covers.covered) {
    const refusal = new LocalStateRefusal(
      STATE_REFUSAL.COVERAGE_MISSING,
      `Project-local runtime state would be written to ${roots.root}, and ${
        covers.uncovered.length === IGNORE_RULES.length ? "none of" : "not all of"
      } the paths that protect it are ignored by this repository ` +
        `(missing: ${covers.uncovered.join(", ")}). Nothing was created. Writing session transcripts, ` +
        `consent or compatibility records into a directory Git is tracking is the failure REQ-0027 ` +
        `exists to prevent, and it is not one a warning makes safe.`,
      { root: roots.root, uncovered: covers.uncovered, state: covers.state }
    );
    return { ok: false, refusal, covers, roots, options: refusalOptions(covers) };
  }

  return { ok: true, roots: create ? createStateRoot(roots) : roots, covers };
}

/** The three answers to a coverage refusal, in the order setup should offer them. */
function refusalOptions(covers) {
  return [
    {
      id: "add-block",
      // ⚠️ THE BYTES, NOT A DESCRIPTION OF THEM. An operator asked to approve an edit to their own
      // `.gitignore` is entitled to see exactly what would be added.
      summary: `add Kiln's marked block to .gitignore, ignoring ${covers.uncovered.join(", ")}`,
      block: blockText("\n", covers.uncovered),
      available: covers.state !== "edited" && covers.state !== "malformed",
      // An edited or malformed block is CMP-0023's to resolve with an explicit choice; offering
      // "add the block" over one would append a second, which is the defect that owner prevents.
      unavailableBecause:
        covers.state === "edited" || covers.state === "malformed"
          ? `the file already holds a Kiln-marked block that is ${covers.state}; that has to be resolved first`
          : undefined,
    },
    { id: "user-state", summary: "keep runtime state outside the repository, in a per-user root", available: true },
    { id: "stop", summary: "change nothing and stop", available: true },
  ];
}

/* ------------------------------------------------------------------ the project id */

/**
 * Read the committed project id, or `null` if there is no record.
 *
 * ⚠️ **AN UNREADABLE RECORD IS A REFUSAL, NOT A `null`.** `null` means "no id yet", which invites
 * minting one; a damaged `.pi/kiln.json` may well contain an id that other things already key on —
 * the external state root and the browser health identity among them — so treating damage as
 * absence is how a project acquires a second identity and loses its state.
 */
export function readProjectId(projectRoot) {
  const path = join(resolve(projectRoot), ...PROJECT_RECORD.split("/"));
  if (!existsSync(path)) return null;

  let record;
  try {
    record = JSON.parse(readFileSync(path, "utf-8"));
  } catch (e) {
    throw new LocalStateRefusal(
      STATE_REFUSAL.RECORD_UNREADABLE,
      `${path} exists but cannot be read as JSON (${e.message}). It holds this project's committed ` +
        `identity, which keys the external state root — so a damaged one is a recovery decision, not ` +
        `a reason to mint a second id. Restore it from Git.`,
      { path }
    );
  }
  const id = record?.projectId;
  if (id !== undefined && (typeof id !== "string" || id.length === 0))
    throw new LocalStateRefusal(
      STATE_REFUSAL.RECORD_UNREADABLE,
      `${path} has a projectId that is not a non-empty string (${JSON.stringify(id)}).`,
      { path }
    );
  return id ?? null;
}

/**
 * The project's id, minted and committed once if it has none.
 *
 * ⚠️ **ONCE. A SECOND CALL RETURNS THE FIRST ANSWER AND WRITES NOTHING.** The schema says it plainly
 * — created once and never regenerated — because it keys the external state root: regenerating it
 * silently orphans every transcript and consent record the project already had, on every machine.
 *
 * @param {{projectRoot: string, randomBytes: Function, now?: Function}} opts
 */
export async function ensureProjectId({ projectRoot, randomBytes, recordVersion = 1 }) {
  const existing = readProjectId(projectRoot);
  if (existing) return { projectId: existing, created: false };

  const path = join(resolve(projectRoot), ...PROJECT_RECORD.split("/"));
  mkdirSync(join(resolve(projectRoot), ".pi"), { recursive: true });

  // Re-read under the caller's lock: the record may have appeared since the check above, and two
  // ids for one project is the failure this whole function exists to prevent.
  const again = readProjectId(projectRoot);
  if (again) return { projectId: again, created: false };

  const record = existsSync(path) ? JSON.parse(readFileSync(path, "utf-8")) : { recordVersion };
  record.recordVersion ??= recordVersion;
  record.projectId = generateProjectId(randomBytes);
  await atomicWrite(path, JSON.stringify(record, null, 2) + "\n");
  return { projectId: record.projectId, created: true, path };
}

/**
 * A generated project identifier.
 *
 * ⚠️ RE-EXPORTED FROM `runtime-records.mjs` RATHER THAN REIMPLEMENTED. That module owns the shape of
 * every persisted record and already explains why the id is random and meaningless; a second
 * generator here would be a second definition of the project's identity.
 */
export { generateProjectId };

/** Canonical identity of a state root, for comparing two without comparing spellings. */
export function stateRootIdentity(root) {
  return canonicalPath(resolve(root));
}

/** Does this path hold anything at all? Used to assert a refusal created nothing. */
export function isPresent(path) {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}
