/**
 * The host consent record and its invalidation rules — TSK-0034, CMP-0027, against ACC-0054.
 *
 * ⚠️ **READ BEFORE ASKING, AND ONLY A VALID RECORD IN A PROTECTED PLACE GRANTS ANYTHING.** A missing,
 * unreadable or invalid record grants nothing, and so does a valid one whose location this repository
 * does not ignore right now, or that Git tracks, or about which Git gives no conclusive answer: a record
 * Git could carry is a record a clone could inherit, which is the failure ACC-0054 is about. The coverage
 * gate is the same one the supervisor asks before a transcript (`coverageState`), and the tracked check
 * asks Git about the record's actual path. Both are re-asked on every read and every write rather than
 * trusted from setup, and neither kind of record is ever written over.
 *
 * ⚠️ **WITHOUT GIT, NOTHING IS REMEMBERED.** A host where Git is unavailable cannot show that the record
 * is kept out of a repository, so an unchanged project is asked again on every launch there, and the
 * answer carries the reason (`NOT_REMEMBERED.unverified`). Reuse without a prompt holds only where Git
 * gives a definite answer.
 *
 * ⚠️ **THREE GRANTS, NEVER MERGED.** Inspection, model use for one exact provider and model, and research
 * use for one research provider are separate fields of `schemas/runtime/consent.schema.json`, and each is
 * written, read and cleared on its own. Granting one says nothing about another.
 *
 * ⚠️ **A CHANGED CHOICE CLEARS ITS GRANT, IT DOES NOT MERELY STOP MATCHING IT.** If a grant were judged
 * only by "the saved choice equals the current one", a project that moved from model A to B and back to A
 * would find A's grant valid again, although the operator was last asked about B. So whenever a read
 * observes a choice that differs from the one a grant names, or has no choice at all, that grant is
 * removed from the record under the lock, and the prompt reopens. A choice Kiln itself changes is cleared
 * by the caller through `clearGrants` in the same step. What this cannot see is a change made and undone
 * entirely outside Kiln between two reads: nothing observed B, so nothing distinguishes that from no
 * change at all.
 *
 * ⚠️ **A DECLINE IS RECORDED ONLY WHEN SOMEONE SAID NO.** `false` is a decision and survives a rerun.
 * A closed input, an empty answer or anything else that is not a boolean grants nothing for this run and
 * records nothing, so it is asked again rather than turned into a standing refusal nobody gave.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import { atomicWrite } from "./atomic-write.mjs";
import { STATE_MODE, coverageState, projectRecordState, RECORD, stateRootFor } from "./local-state.mjs";
import { withLock } from "./lock.mjs";
import { createRuntimeValidators } from "./runtime-records.mjs";

export const CONSENT_RECORD = join("runtime", "consent.json");
export const CONSENT_LOCK = join("runtime", "consent.lock");
export const CONSENT_RECORD_VERSION = 1;

/** The three grants, spelled as the schema's field names. */
export const GRANT = Object.freeze({ INSPECTION: "inspection", MODEL_USE: "modelUse", RESEARCH: "research" });

/** What the record on disk is. Only `valid` in a protected location can grant anything. */
export const CONSENT_READ = Object.freeze({
  ABSENT: "absent",
  VALID: "valid",
  INVALID: "invalid",
  INACCESSIBLE: "inaccessible",
  UNPROTECTED: "unprotected",
  /** Git tracks the record in its index, so the next commit would carry it. */
  TRACKED: "tracked",
  /** The record is in the current commit, so a clone of that commit carries it. */
  COMMITTED: "committed",
  /** Git could not say whether the record is kept out of the repository. */
  UNVERIFIED: "unverified",
});

/** What Git says about the record's path. Only `ignored` and `no-repository` let it be trusted or written. */
export const GIT = Object.freeze({
  IGNORED: "ignored",
  NO_REPOSITORY: "no-repository",
  TRACKED: "tracked",
  COMMITTED: "committed",
  NOT_IGNORED: "not-ignored",
  INCONCLUSIVE: "inconclusive",
});

/** The environment variables Git is given. Nothing else is read, and no `GIT_*` override reaches it. */
const GIT_ENV_NAMES = ["PATH", "Path", "SystemRoot", "HOME", "USERPROFILE", "TEMP", "TMP"];

function runGit(location, args) {
  const env = { LC_ALL: "C", LANGUAGE: "C", GIT_TERMINAL_PROMPT: "0" };
  for (const name of GIT_ENV_NAMES) {
    const value = process.env[name];
    if (typeof value === "string") env[name] = value;
  }
  return spawnSync(location.git ?? "git", ["-c", "core.fsmonitor=false", ...args], {
    cwd: dirname(location.path),
    env,
    encoding: "utf8",
    timeout: 10_000,
    windowsHide: true,
  });
}

const inconclusive = (r) => ({ state: GIT.INCONCLUSIVE, code: r.error ? (r.error.code ?? "spawn-failed") : `exit-${r.status ?? r.signal}` });

/**
 * Is the consent record's actual path kept out of whichever repository holds it?
 *
 * ⚠️ **ASKED FROM THE RECORD'S OWN DIRECTORY.** Git then finds the repository that really contains the
 * record: the project, a parent repository above a project with no `.git` of its own, a linked worktree
 * whose `.git` is a file, or a nested repository. The ignore-file scan in `coverageState` reads only the
 * project's own `.gitignore`, and calls a project without `.git` "not a repository" even when a parent
 * repository's next `git add -A` would take the record.
 *
 * ⚠️ **THREE QUESTIONS, EACH ONE A WAY A CLONE CAN CARRY THE RECORD.** Is it in the index (a force-add)?
 * Is it in `HEAD` (a removal staged but not committed leaves it in the commit a clone checks out)? Would
 * Git ignore it, by the rules of the repository that holds it? Other branches and older commits are not
 * asked about.
 *
 * ⚠️ **ONLY DEFINITE ANSWERS COUNT.** Exit 128 with "not a git repository" on the first question means no
 * repository holds the directory. Git being absent, refusing an unsafe directory, timing out or any other
 * exit is inconclusive, and an inconclusive answer grants nothing.
 */
export function gitProtection(location) {
  const name = basename(location.path);

  const index = runGit(location, ["ls-files", "--error-unmatch", "-z", "--", name]);
  if (index.error) return inconclusive(index);
  if (index.status === 128 && /not a git repository/i.test(index.stderr ?? "")) return { state: GIT.NO_REPOSITORY };
  if (index.status === 0) return { state: GIT.TRACKED };
  if (index.status !== 1) return inconclusive(index);

  // An unborn branch has no commit to carry anything, and `--verify -q` exits 1 for it.
  const head = runGit(location, ["rev-parse", "--verify", "-q", "HEAD^{commit}"]);
  if (head.error || (head.status !== 0 && head.status !== 1)) return inconclusive(head);
  if (head.status === 0) {
    const tree = runGit(location, ["ls-tree", "--name-only", "-z", "HEAD", "--", name]);
    if (tree.error || tree.status !== 0) return inconclusive(tree);
    if (tree.stdout.length > 0) return { state: GIT.COMMITTED };
  }

  const ignore = runGit(location, ["check-ignore", "-q", "--", name]);
  if (ignore.error) return inconclusive(ignore);
  if (ignore.status === 0) return { state: GIT.IGNORED };
  if (ignore.status === 1) return { state: GIT.NOT_IGNORED };
  return inconclusive(ignore);
}

/**
 * Why an answer could not be remembered, in the operator's terms. Returned with the answer, so an
 * operator asked again on every launch knows why and what would change it.
 */
export const NOT_REMEMBERED = Object.freeze({
  unverified:
    "Your answer applies to this run only. Kiln could not confirm with Git that its consent record is kept " +
    "out of the repository (Git is not available or gave no answer), so it cannot trust a saved answer and " +
    "will ask on every launch until Git is available.",
  tracked:
    "Your answer applies to this run only. Git tracks Kiln's consent record, so it may have come from another " +
    "computer, and Kiln will not write over it. Remove it from Git (git rm --cached) and commit the removal.",
  committed:
    "Your answer applies to this run only. Kiln's consent record is in the current commit, so anyone cloning " +
    "it would receive it. Commit its removal, and Kiln will remember your answer from then on.",
  "not-ignored":
    "Your answer applies to this run only. The repository holding Kiln's consent record does not ignore it, so " +
    "a commit could carry it to another computer. Ignore Kiln's runtime directory in that repository.",
  unprotected:
    "Your answer applies to this run only. This project's .gitignore does not ignore Kiln's runtime directory. " +
    "Re-run setup to restore Kiln's ignore block.",
  inaccessible: "Your answer applies to this run only. Kiln's consent record could not be opened, and Kiln will not write over it.",
  "no-runtime-dir": "Your answer applies to this run only. Kiln's runtime directory does not exist yet. Re-run setup to create it.",
});

/** How a Git answer that forbids trusting or writing the record is reported, or `null` if it allows both. */
function gitRefusal(git) {
  switch (git.state) {
    case GIT.IGNORED:
    case GIT.NO_REPOSITORY:
      return null;
    case GIT.TRACKED:
      return { read: CONSENT_READ.TRACKED, reason: "tracked" };
    case GIT.COMMITTED:
      return { read: CONSENT_READ.COMMITTED, reason: "committed" };
    case GIT.NOT_IGNORED:
      return { read: CONSENT_READ.UNPROTECTED, reason: "not-ignored" };
    default:
      return { read: CONSENT_READ.UNVERIFIED, reason: "unverified", code: git.code };
  }
}

/** Where a grant stands for the current choice. */
export const STANDING = Object.freeze({
  GRANTED: "granted",
  DECLINED: "declined",
  /** Nobody on this host has answered for this choice: prompt before any credential access. */
  ASK: "ask",
  /** There is no choice to grant anything for, such as research set to `none`. */
  NOT_APPLICABLE: "not-applicable",
});

let cachedValidators = null;
const validatorsFor = (supplied) => supplied ?? (cachedValidators ??= createRuntimeValidators());

/**
 * The consent record's place, derived from the same inputs as the rest of the run's state.
 *
 * @param {{projectRoot: string, stateMode?: string, projectId?: string|null, platform?: string, env?: object, home?: string, git?: string}} where
 */
export function consentLocation({ projectRoot, stateMode = STATE_MODE.PROJECT, projectId = null, platform, env, home, git = "git" }) {
  const roots = stateRootFor({ mode: stateMode, projectRoot, projectId, platform, env, home });
  return Object.freeze({
    projectRoot,
    stateMode,
    roots,
    runtime: roots.runtime,
    path: join(roots.root, CONSENT_RECORD),
    lock: join(roots.root, CONSENT_LOCK),
    git,
  });
}

/** Is the record's location protected right now? Asked of the ignore file, never of a record of it. */
function protection(location) {
  const covers = coverageState({ projectRoot: location.projectRoot, mode: location.stateMode, roots: location.roots });
  return { covered: covers.covered === true, uncovered: covers.uncovered ?? [] };
}

/**
 * Read the record. Never writes, never prompts.
 *
 * @returns {{state: string, record: object|null, uncovered?: string[], code?: string, detail?: string}}
 */
export function readConsent(location, { validators } = {}) {
  const guard = protection(location);
  // ⚠️ NOT EVEN OPENED. A record in a place Git would track is not this host's to trust.
  if (!guard.covered) return { state: CONSENT_READ.UNPROTECTED, record: null, uncovered: guard.uncovered };

  let text;
  try {
    text = readFileSync(location.path, "utf-8");
  } catch (e) {
    if (e?.code === "ENOENT") return { state: CONSENT_READ.ABSENT, record: null };
    return { state: CONSENT_READ.INACCESSIBLE, record: null, code: e?.code ?? "unknown" };
  }

  // ⚠️ THE PROJECT'S IGNORE FILE IS NOT THE WHOLE ANSWER. A force-added or still-committed record is
  // covered by it and reaches every clone, and a parent repository has rules of its own.
  const git = gitRefusal(gitProtection(location));
  if (git) return { state: git.read, record: null, ...(git.code ? { code: git.code } : {}) };

  let doc;
  try {
    doc = JSON.parse(text);
  } catch {
    return { state: CONSENT_READ.INVALID, record: null, detail: "is not JSON" };
  }
  const validate = validatorsFor(validators).consent;
  if (!validate(doc) || doc.recordVersion !== CONSENT_RECORD_VERSION)
    return {
      state: CONSENT_READ.INVALID,
      record: null,
      detail: validate.errors?.map((e) => `${e.instancePath || "/"} ${e.message}`).join("; ") || `recordVersion ${doc.recordVersion}`,
    };
  return { state: CONSENT_READ.VALID, record: doc };
}

/**
 * The project's current choices, as the grants key on them.
 *
 * `model` is `{provider, model}` or `null` when none is selected. `research` is `"tavily"`, `"none"` or
 * `null` when nobody has decided. Both keys are required so that a caller cannot clear a grant by
 * forgetting to say what the choice is.
 */
function assertChoice(choice) {
  if (!choice || typeof choice !== "object" || !("model" in choice) || !("research" in choice))
    throw new TypeError("A consent choice needs both `model` and `research`; `null` means none is chosen");
  const { model, research } = choice;
  if (model !== null && (typeof model?.provider !== "string" || !model.provider || typeof model?.model !== "string" || !model.model))
    throw new TypeError(`A model choice is {provider, model} with both non-empty, got ${JSON.stringify(model)}`);
  if (research !== null && research !== "tavily" && research !== "none")
    throw new TypeError(`A research choice is "tavily", "none" or null, got ${JSON.stringify(research)}`);
  return choice;
}

/** The committed research choice from `.pi/kiln.json`: `"tavily"`, `"none"`, or `null` if undecided. */
export function committedResearchChoice(projectRoot, { validators } = {}) {
  const state = projectRecordState(projectRoot, { validators });
  if (state.kind !== RECORD.VALID) return null;
  return state.record.research?.provider ?? null;
}

const standingOf = (grant) => (grant.granted === true ? STANDING.GRANTED : STANDING.DECLINED);

/**
 * Which grants in `record` no longer name the current choice, and must be removed rather than ignored.
 */
export function staleGrants(record, choice) {
  assertChoice(choice);
  const stale = [];
  const use = record?.modelUse;
  if (use && (choice.model === null || use.provider !== choice.model.provider || use.model !== choice.model.model))
    stale.push(GRANT.MODEL_USE);
  const research = record?.research;
  if (research && (choice.research === null || choice.research === "none" || research.provider !== choice.research))
    stale.push(GRANT.RESEARCH);
  return stale;
}

/** Where each grant stands for the current choice, given a record with no stale grants left in it. */
export function standings(record, choice) {
  assertChoice(choice);
  const stale = new Set(staleGrants(record, choice));
  const inspection = record?.inspection ? standingOf(record.inspection) : STANDING.ASK;
  const modelUse =
    choice.model === null ? STANDING.NOT_APPLICABLE : record?.modelUse && !stale.has(GRANT.MODEL_USE) ? standingOf(record.modelUse) : STANDING.ASK;
  const research =
    choice.research !== "tavily" ? STANDING.NOT_APPLICABLE : record?.research && !stale.has(GRANT.RESEARCH) ? standingOf(record.research) : STANDING.ASK;
  return { [GRANT.INSPECTION]: inspection, [GRANT.MODEL_USE]: modelUse, [GRANT.RESEARCH]: research };
}

/** The standing of the inspection grant alone. It keys on no choice, so it needs none. */
export function inspectionStanding(record) {
  return record?.inspection ? standingOf(record.inspection) : STANDING.ASK;
}

/**
 * Read-modify-write under the consent lock, with the location's protection re-proved inside it.
 *
 * ⚠️ **NOTHING IS CREATED.** A missing runtime directory is setup's to make, exactly as for the session
 * record. The result says the record was not written, and the caller carries on with an unpersisted
 * answer rather than creating a layout it does not own.
 *
 * ⚠️ **AN INVALID RECORD IS REPLACED, AN INACCESSIBLE ONE IS NOT.** An invalid record grants nothing, so
 * starting again from empty discards nothing. One that could not be opened may be valid, and nobody has
 * seen what writing over it would lose.
 */
async function mutate(location, change, { validators } = {}) {
  if (!existsSync(location.runtime)) return { written: false, reason: "no-runtime-dir" };
  const checks = validatorsFor(validators);

  return withLock(location.lock, async () => {
    const guard = protection(location);
    if (!guard.covered) return { written: false, reason: "unprotected", uncovered: guard.uncovered };
    // ⚠️ ASKED EVEN WHEN THE FILE IS ABSENT. A tracked record deleted from the working tree is still in
    // the index or in HEAD, and an unignored path in a parent repository holds nothing yet; writing
    // either would put this host's answer into the next commit.
    const git = gitRefusal(gitProtection(location));
    if (git) return { written: false, reason: git.reason, ...(git.code ? { code: git.code } : {}) };

    const read = readConsent(location, { validators: checks });
    if (read.state === CONSENT_READ.INACCESSIBLE) return { written: false, reason: "inaccessible", code: read.code };

    const before = read.record ?? { recordVersion: CONSENT_RECORD_VERSION };
    const after = change(structuredClone(before));
    if (after === null) return { written: false, reason: "unchanged", record: before };

    if (!checks.consent(after))
      throw new TypeError(`Refusing to write an invalid consent record: ${checks.consent.errors.map((e) => `${e.instancePath || "/"} ${e.message}`).join("; ")}`);
    await atomicWrite(location.path, JSON.stringify(after, null, 2) + "\n");
    return { written: true, record: after };
  });
}

/**
 * Remove grants. What a caller that changes a choice does in the same step, so the old grant cannot
 * outlive it.
 */
export async function clearGrants(location, grants, opts = {}) {
  for (const g of grants)
    if (!Object.values(GRANT).includes(g)) throw new TypeError(`${JSON.stringify(g)} is not a grant`);
  return mutate(
    location,
    (record) => {
      const present = grants.filter((g) => g in record);
      if (!present.length) return null;
      for (const g of present) delete record[g];
      return record;
    },
    opts
  );
}

/**
 * Read the record against the current choice, clearing every grant the choice has moved away from.
 *
 * @returns {Promise<{read: string, standings: object, cleared: string[], persisted: boolean}>}
 */
export async function reconcileConsent(location, choice, opts = {}) {
  assertChoice(choice);
  const read = readConsent(location, opts);
  const stale = staleGrants(read.record, choice);
  let record = read.record;
  let persisted = true;
  if (stale.length) {
    const r = await clearGrants(location, stale, opts);
    persisted = r.written || r.reason === "unchanged";
    // Whether or not the clear could be written, the stale grants grant nothing now.
    record = r.record ?? Object.fromEntries(Object.entries(record).filter(([k]) => !stale.includes(k)));
  }
  return { read: read.state, standings: standings(record, choice), cleared: stale, persisted };
}

/** A choice holding only the key `grant` is keyed on, so the other grant is never judged by it. */
function ownChoice(grant, choice) {
  const key = grant === GRANT.MODEL_USE ? "model" : grant === GRANT.RESEARCH ? "research" : null;
  if (!key) throw new TypeError(`${JSON.stringify(grant)} is not a choice-keyed grant`);
  if (!choice || typeof choice !== "object" || !(key in choice))
    throw new TypeError(`Reconciling ${grant} needs the current ${key} choice; \`null\` means none is chosen`);
  return assertChoice({ model: null, research: null, [key]: choice[key] });
}

/**
 * Where ONE grant stands for a choice, WITHOUT changing the record.
 *
 * ⚠️ **FOR A CALLER THAT MAY STILL CHANGE NOTHING.** A stale grant stands as `ask` here exactly as it
 * would after `reconcileGrant`, but it stays in the record. A step that promises "no changes were made"
 * when it fails must decide with this, and clear only once it succeeds.
 *
 * @returns {{read: string, standing: string, stale: boolean}}
 */
export function peekGrant(location, grant, choice, opts = {}) {
  const own = ownChoice(grant, choice);
  const read = readConsent(location, opts);
  const stale = staleGrants(read.record, own).includes(grant);
  return { read: read.state, standing: standings(read.record, own)[grant], stale };
}

/**
 * Reconcile ONE choice-keyed grant against its own current choice, leaving the other grants alone.
 *
 * ⚠️ **A CALLER THAT KNOWS ONE CHOICE MUST NOT CLEAR THE OTHER.** The research flow does not know the
 * model selection. Passing `model: null` to `reconcileConsent` would read as "no model chosen" and
 * remove a valid model-use grant, so the grant being asked about is the only one reconciled here.
 *
 * @param {object} location
 * @param {string} grant  `GRANT.MODEL_USE` or `GRANT.RESEARCH`
 * @param {{model?: object|null, research?: string|null}} choice  must carry the key for `grant`
 * @returns {Promise<{read: string, standing: string, cleared: string[], persisted: boolean}>}
 */
export async function reconcileGrant(location, grant, choice, opts = {}) {
  const own = ownChoice(grant, choice);
  const read = readConsent(location, opts);
  const stale = staleGrants(read.record, own).filter((g) => g === grant);
  let record = read.record;
  let persisted = true;
  if (stale.length) {
    const r = await clearGrants(location, stale, opts);
    persisted = r.written || r.reason === "unchanged";
    record = r.record ?? Object.fromEntries(Object.entries(record).filter(([k]) => !stale.includes(k)));
  }
  return { read: read.state, standing: standings(record, own)[grant], cleared: stale, persisted };
}

/**
 * Record an operator's answer for one grant, keyed to the choice it was given for.
 *
 * @param {object} location
 * @param {{grant: string, granted: boolean, choice?: object, now?: () => Date}} answer
 */
export async function recordGrant(location, { grant, granted, choice = null, now = () => new Date() }, opts = {}) {
  if (typeof granted !== "boolean") throw new TypeError("Only a boolean answer is a decision that can be recorded");
  const entry = { granted, decidedAt: now().toISOString() };
  if (grant === GRANT.MODEL_USE) {
    assertChoice({ model: choice?.model ?? null, research: null });
    if (!choice?.model) throw new TypeError("A model-use grant names the exact provider and model it was given for");
    Object.assign(entry, { provider: choice.model.provider, model: choice.model.model });
  } else if (grant === GRANT.RESEARCH) {
    if (choice?.research !== "tavily") throw new TypeError("A research grant names the research provider it was given for");
    entry.provider = choice.research;
  } else if (grant !== GRANT.INSPECTION) throw new TypeError(`${JSON.stringify(grant)} is not a grant`);

  return mutate(location, (record) => ({ ...record, [grant]: entry }), opts);
}

/**
 * Remember, on this host's model-use grant, the variable a custom provider's key is declared in.
 *
 * ⚠️ **ONLY ON A GRANT FOR EXACTLY THIS MODEL, AND ONLY ONE THAT SAYS YES.** A declaration beside a declined or
 * stale grant would outlive the decision it belongs to. Without one, nothing is written and the result says so.
 *
 * @param {object} location
 * @param {{model: {provider: string, model: string}, credentialVar: string}} declaration
 */
export async function recordCredentialVar(location, { model, credentialVar }, opts = {}) {
  assertChoice({ model: model ?? null, research: null });
  if (!model) throw new TypeError("A credential declaration names the provider and model whose grant it belongs to");
  if (typeof credentialVar !== "string" || !/^[A-Z][A-Z0-9_]*$/.test(credentialVar))
    throw new TypeError("A credential declaration is the NAME of an environment variable");
  let refused = null;
  const r = await mutate(
    location,
    (record) => {
      const use = record.modelUse;
      if (!use || use.granted !== true || use.provider !== model.provider || use.model !== model.model) {
        refused = "no-grant";
        return null;
      }
      if (use.credentialVar === credentialVar) return null;
      return { ...record, modelUse: { ...use, credentialVar } };
    },
    opts
  );
  return refused ? { written: false, reason: refused } : r;
}

/**
 * The credential variable this host declared for exactly `model`, or `null`.
 *
 * ⚠️ **READ FROM A GRANT THAT STILL SAYS YES FOR THIS MODEL**, so a declaration left beside another selection is
 * never applied to this one.
 */
export function declaredCredentialVar(location, model, opts = {}) {
  const use = readConsent(location, opts).record?.modelUse;
  if (!use || use.granted !== true || use.provider !== model?.provider || use.model !== model?.model) return null;
  return use.credentialVar ?? null;
}

/**
 * Obtain one grant: read first, and ask only when this host has no answer for the current choice.
 *
 * ⚠️ **THE PROMPT IS THE LAST THING BEFORE ANY CREDENTIAL ACCESS, AND THIS FUNCTION MAKES NONE.** It
 * reads Kiln's own consent record and the ignore file, and nothing belonging to a provider. The caller
 * performs the access only on `granted: true`.
 *
 * @param {object} location
 * @param {{grant: string, choice?: object, ask: (prompt: string) => unknown, prompt: string, now?: () => Date}} request
 * @returns {Promise<{granted: boolean, standing: string, asked: boolean, persisted: boolean, cleared: string[]}>}
 */
export async function obtainGrant(location, { grant, choice = null, ask, prompt, now }, opts = {}) {
  if (typeof ask !== "function") throw new TypeError("obtainGrant needs an `ask` function");
  if (typeof prompt !== "string" || !prompt) throw new TypeError("obtainGrant needs the prompt text");

  let standing;
  let cleared = [];
  let persisted = true;
  if (grant === GRANT.INSPECTION) {
    standing = inspectionStanding(readConsent(location, opts).record);
  } else {
    const r = await reconcileGrant(location, grant, choice, opts);
    ({ cleared, persisted, standing } = r);
  }

  if (standing === STANDING.NOT_APPLICABLE || standing === STANDING.GRANTED || standing === STANDING.DECLINED)
    return { granted: standing === STANDING.GRANTED, standing, asked: false, persisted, cleared };

  const answer = await ask(prompt);
  // ⚠️ ONLY AN EXPLICIT YES GRANTS, AND ONLY AN EXPLICIT BOOLEAN IS RECORDED.
  if (typeof answer !== "boolean") return { granted: false, standing: STANDING.ASK, asked: true, persisted: false, cleared };
  const written = await recordGrant(location, { grant, granted: answer, choice, now }, opts);
  return {
    granted: answer,
    standing: answer ? STANDING.GRANTED : STANDING.DECLINED,
    asked: true,
    persisted: written.written,
    ...(written.written ? {} : { notPersistedBecause: written.reason, notRemembered: NOT_REMEMBERED[written.reason] }),
    cleared,
  };
}
