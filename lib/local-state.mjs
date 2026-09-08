/**
 * Where runtime state lives, and the refusals that stop it being written anywhere unsafe (CMP-0025,
 * REQ-0027, DEC-0029).
 *
 * ⚠️ **THE ORDERING IS THE REQUIREMENT, NOT THE LOCATION.** REQ-0027 names a sequence — coverage
 * first, then data — because a design that puts transcripts under an ignored path is correct and
 * still leaks if the first transcript is written before the ignore rule exists, or if the operator
 * deleted the rule and setup carried on. So the gate here is not "is this path a good place"; it is
 * "has the protection for this path been observed, right now, before anything is created". A caller
 * that cannot show that gets a refusal carrying the options, not a warning it may ignore.
 *
 * ⚠️ **EVERY LASTING WRITE GOES THROUGH THE SETUP TRANSACTION, AND THIS MODULE ONLY DECIDES.** An
 * earlier version wrote `.pi/kiln.json` with a bare `atomicWrite` and created state directories with
 * a recursive `mkdirSync`, which put both outside the one place that owns the project lock, canonical
 * containment, physical-path identity and compare-before-write. The comment claiming the re-read
 * happened "under the caller's lock" was the tell: the API could not establish that, because nothing
 * in it took a lock or a lease. With `.pi` as a junction, the unrestricted `mkdir` created `sessions`
 * and `runtime` outside the project entirely. Deciding is safe to do at any time; writing needs the
 * lease, and now requires it.
 *
 * ⚠️ **THE TWO MODES ARE `project` AND `user`, AND THOSE SPELLINGS ARE NOT THIS MODULE'S TO
 * CHOOSE.** `schemas/runtime/kiln-session.schema.json` already fixes them, because a session record
 * names the mode it was written under and a resume compares it. Inventing `project-local` and
 * `external` here would put a second vocabulary beside the persisted one.
 *
 * ⚠️ **THE EXTERNAL ROOT IS PER-PROJECT-ID, NEVER PER-PATH.** Deriving it from the project's
 * location would move the state out from under an operator who renamed or moved the project —
 * exactly when it must not move — and would leak the project's name into a directory name on every
 * machine. The id is random, meaningless, committed, and generated once.
 *
 * ⚠️ **NOTHING HERE WRITES A COMMITTED ABSOLUTE PATH.** ACC-0050's third clause is a property of
 * what is NOT stored: the external root is recomputed from the platform and the committed id on
 * every run, so a clone on another machine derives its own. `stateRootFor` is a pure function of
 * (mode, projectRoot, projectId, env) and takes its environment as an argument so the derivation can
 * be observed for both platforms from either one.
 */

import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { canonicalPath, isAtOrInside, pathIdentityKey } from "./content-root.mjs";
import { IGNORE_RULES, IGNORE_ACTION, coverage, planIgnoreBlock, blockText } from "./project-gitignore.mjs";
import { createRuntimeValidators, generateProjectId } from "./runtime-records.mjs";
import { runWithTransaction, transactionState } from "./setup-transaction.mjs";

export { generateProjectId };

/** The two state policies. Fixed by `schemas/runtime/kiln-session.schema.json`, not chosen here. */
export const STATE_MODE = Object.freeze({ PROJECT: "project", USER: "user" });

/** The committed, non-secret project record. Deliberately NOT ignored — see DEC-0029. */
export const PROJECT_RECORD = ".pi/kiln.json";

/** The transaction target key for that record, so no caller spells it twice. */
export const PROJECT_RECORD_KEY = `project:${PROJECT_RECORD}`;

/**
 * What a usable project id looks like.
 *
 * ⚠️ **CHECKED HERE AS WELL AS BY THE SCHEMA, AND THE DUPLICATION IS THE POINT.** The schema governs
 * what may be WRITTEN; this governs what may be turned into a path, and callers can supply an id
 * directly without ever having gone through the reader. `../../escaped` is a non-empty string, and
 * the old code joined it straight into the external root — putting `sessions/` and `runtime/` outside
 * `<state-home>/kiln/projects` entirely. A path component taken from data is validated at the
 * boundary where it becomes a path, not only where it entered.
 */
export const PROJECT_ID_PATTERN = /^[0-9a-f]{32}$/;

export const STATE_REFUSAL = Object.freeze({
  UNKNOWN_MODE: "unknown-mode",
  NO_PROJECT_ID: "no-project-id",
  INVALID_PROJECT_ID: "invalid-project-id",
  NO_USER_STATE_HOME: "no-user-state-home",
  COVERAGE_MISSING: "coverage-missing",
  RECORD_INVALID: "project-record-invalid",
  ESCAPES_ROOT: "escapes-root",
  NO_LEASE: "no-transaction-lease",
});

export class LocalStateRefusal extends Error {
  constructor(reason, message, detail = {}) {
    super(message);
    this.name = "LocalStateRefusal";
    this.reason = reason;
    this.detail = detail;
  }
}

/** Compiled once: `createRuntimeValidators` reads and compiles every runtime schema. */
let cachedValidators = null;
const runtimeValidators = (supplied) => supplied ?? (cachedValidators ??= createRuntimeValidators());

/* ------------------------------------------------------------------ the roots */

/**
 * The per-user state home for this platform, or `null` if the platform will not say.
 *
 * ⚠️ **`$XDG_STATE_HOME` ON EVERY POSIX PLATFORM INCLUDING macOS, and that is a deliberate refusal
 * to invent a third convention.** `setup-transaction.mjs` already documents the two roots this
 * project uses — `%LOCALAPPDATA%\Kiln\projects\<id>` and `$XDG_STATE_HOME/kiln/projects/<id>` — and
 * a module that quietly added `~/Library/Application Support` would make the documented layout wrong
 * on one platform without anything saying so.
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

/** Refuse an id that is not exactly what the schema permits, before it becomes a path component. */
export function assertUsableProjectId(projectId, where = "the external state root") {
  if (typeof projectId !== "string" || !PROJECT_ID_PATTERN.test(projectId))
    throw new LocalStateRefusal(
      STATE_REFUSAL.INVALID_PROJECT_ID,
      `${JSON.stringify(projectId)} is not a usable project id, so it will not be made part of ` +
        `${where}. The contract is 32 lowercase hexadecimal characters — the same one ` +
        `runtime-common.schema.json states — and anything else is either a damaged record or an ` +
        `attempt to walk out of the projects directory.`,
      { projectId }
    );
  return projectId;
}

/**
 * Prove a path stays inside the root that authorises it, resolving through the deepest existing
 * ancestor so a junction or symlink is caught as a PLACE rather than looked for as a spelling.
 */
function assertContained(target, within, what) {
  const c = canonicalPath(target);
  const root = canonicalPath(within);
  if (!isAtOrInside(c, root))
    throw new LocalStateRefusal(
      STATE_REFUSAL.ESCAPES_ROOT,
      `${what} resolves to ${c}, which is outside ${root}. Nothing was created. A directory that ` +
        `spells innocently and resolves elsewhere is the whole reason containment is checked against ` +
        `the canonical path rather than the typed one.`,
      { target: c, within: root }
    );
  return c;
}

/**
 * The state root for a mode, and the root that authorises it.
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
    const within = resolve(projectRoot);
    return layout(join(within, ".pi"), mode, within);
  }

  // ⚠️ THE ID IS REQUIRED RATHER THAN MINTED HERE. Minting inside a path derivation would create a
  // committed identity as a side effect of asking a question, and a caller that only wanted to SHOW
  // the operator where external state would go would have changed the project by asking.
  if (projectId === null || projectId === undefined || projectId === "")
    throw new LocalStateRefusal(
      STATE_REFUSAL.NO_PROJECT_ID,
      `External state is keyed by the committed project id and this project has none yet. ` +
        `Write ${PROJECT_RECORD} first (\`ensureProjectId\`); deriving a root from the project's path ` +
        `instead would move the state the moment somebody moved or renamed the project.`,
      { projectRoot }
    );
  assertUsableProjectId(projectId);

  const base = userStateHome({ platform, env, home });
  if (!base)
    throw new LocalStateRefusal(
      STATE_REFUSAL.NO_USER_STATE_HOME,
      `This platform did not say where per-user state belongs (${
        (platform ?? process.platform) === "win32" ? "%LOCALAPPDATA% is unset" : "no $XDG_STATE_HOME and no home directory"
      }), so external state has nowhere to go. Use project-local state, or set the variable.`,
      { platform: platform ?? process.platform }
    );

  const projects = join(base, "projects");
  return layout(join(projects, projectId), mode, projects);
}

/** The layout inside a state root. Derived in one place so no caller spells `sessions` itself. */
function layout(root, mode, within) {
  return { mode, root, within, sessions: join(root, "sessions"), runtime: join(root, "runtime") };
}

/**
 * Create the state root's directories, under the transaction's lease and inside its root.
 *
 * ⚠️ **THE LEASE IS REQUIRED BECAUSE THIS MUTATES THE FILESYSTEM.** Everything setup writes runs
 * inside one authenticated, revocable transaction holding one project-wide lock; a directory created
 * beside that is created with no exclusion at all, and two setups can then race over the same root.
 *
 * ⚠️ **AND CONTAINMENT IS CHECKED BEFORE EACH LEVEL, NOT AFTER.** `mkdirSync(..., {recursive: true})`
 * follows a junction wherever it points, so with `<project>/.pi` redirected the old code created
 * `sessions` and `runtime` outside the project and reported success. Checking afterwards would
 * already have created them somewhere; the canonical path of each directory is proved to be inside
 * the authorising root first, and the deepest existing ancestor is what gets resolved, so a junction
 * anywhere along the way is caught as a place rather than looked for as a spelling.
 *
 * ⚠️ **AND THE ROOT IT CREATES IS THE TRANSACTION'S, NOT THE CALLER'S.** This is the correction that
 * matters most. An earlier version authenticated the lease against a `projectRoot` the caller passed
 * and then created directories at a path the caller ALSO passed, checking containment against a
 * `within` field the caller passed as well — three arguments from one source, agreeing with each
 * other and with nothing. A live transaction for project A created `B/.pi/sessions`, and a
 * transaction planned with no `stateRoot` created an external root anyway. Authenticating a
 * capability and then letting its holder name the target is not authorisation; it is asking the
 * caller to mark its own homework, which is the same mistake as trusting a plan whose premise had
 * expired, one layer up.
 *
 * So the authorising root comes out of the transaction's own ledger, the state root must EQUAL the
 * one that transaction explicitly planned, and containment is proved against that authenticated
 * path. `roots.within` is now only a derivation detail; nothing authorises anything with it.
 */
export function createStateRoot(roots, { transaction }) {
  const authorised = assertStateRootLeased(transaction, roots, "creating a state root");

  for (const dir of [roots.root, roots.sessions, roots.runtime]) {
    assertContained(dir, authorised, dir === roots.root ? "the state root" : `${dir}`);
    mkdirSync(dir, { recursive: true });
    // Re-checked after creation: the ancestor that was resolved before may not have existed, so the
    // pre-check resolved a shorter prefix than the path that now exists.
    assertContained(dir, authorised, dir);
  }
  return roots;
}

/**
 * The authenticated, live lease this module's mutations require.
 *
 * ⚠️ **AUTHENTICATED, NOT DUCK-TYPED** — the same questions `initialize-project.mjs` asks, for the
 * same reason. A shape describes data; it cannot establish a capability.
 *
 * ⚠️ **AND IT TAKES NO `projectRoot` ARGUMENT, DELIBERATELY.** One was accepted before, and being
 * optional it could simply be omitted to skip the only check that compared the lease to anything.
 * A parameter whose absence weakens a guarantee is not a check. The identity of the project is the
 * transaction's to state.
 */
function assertLease(transaction, what) {
  const state = transactionState(transaction);
  if (!state)
    throw new LocalStateRefusal(
      STATE_REFUSAL.NO_LEASE,
      `${what} needs a setup transaction, and what was supplied was not issued by the transaction ` +
        `module. An object that merely looks like one holds no lock, so the work would run inside ` +
        `nothing. Nothing was written.`,
      { what }
    );
  if (!state.active)
    throw new LocalStateRefusal(
      STATE_REFUSAL.NO_LEASE,
      `${what} was attempted through a transaction that has already finished and released its lock. ` +
        `Holding the lock once is not holding it now. Nothing was written.`,
      { what }
    );
  return state;
}

/**
 * The state root this transaction authorises, proved to be the one about to be created.
 *
 * ⚠️ **THE TRANSACTION MUST HAVE PLANNED A `stateRoot` EXPLICITLY.** `authorizedRoots` adds `state`
 * only when the spec names one, and its comment already says why: "an authorised root the caller did
 * not pass does not exist: there is no default state root, so a spec that never mentions one cannot
 * write to one." Creating directories under a transaction that planned none was exactly that
 * default, arriving through a different door.
 *
 * ⚠️ **AND IN PROJECT MODE IT MUST STILL LIE INSIDE THE TRANSACTION'S PROJECT.** Equality with the
 * planned state root binds the capability; it does not by itself stop `<project>/.pi` being a
 * junction, because the plan canonicalises the same junction to the same place and the two agree.
 * The mode is what says whether being outside the project is intended, so the mode is what decides.
 * External state is deliberately outside and is exempt.
 *
 * ⚠️ **WHICH IS WHY THE MODE IS TAKEN FROM THE TRANSACTION, NOT FROM `roots`.** A root without its
 * policy is half an authorisation, and the missing half was the half that mattered: with
 * `<project>/.pi` a junction, taking the legitimate project-local roots and changing one field —
 * `mode: "project"` to `"user"` — turned the refusal above into a directory outside the project. The
 * root was genuinely authorised throughout; the rule governing it was the caller's to rewrite. Both
 * are now planned together, and the caller's mode is compared to the authenticated one rather than
 * consulted: a mismatch is a refusal, and the decision below is made on the transaction's answer.
 */
function assertStateRootLeased(transaction, roots, what) {
  const state = assertLease(transaction, what);
  const authorised = state.roots.state;

  if (!authorised)
    throw new LocalStateRefusal(
      STATE_REFUSAL.NO_LEASE,
      `${what} was attempted through a transaction that authorises no state root. Plan it with ` +
        `{ stateRoot } naming the root to be created; a transaction that never mentioned one cannot ` +
        `create one, or the state root would be a default rather than a decision. Nothing was created.`,
      { what, authorised: Object.keys(state.roots) }
    );

  const wanted = canonicalPath(resolve(roots.root));
  if (pathIdentityKey(wanted) !== pathIdentityKey(authorised))
    throw new LocalStateRefusal(
      STATE_REFUSAL.NO_LEASE,
      `${what} was attempted at a root this transaction does not authorise.\n` +
        `  authorised: ${authorised}\n  asked for:  ${wanted}\n` +
        `A lease is a capability over the root it was planned with, not over any root its holder ` +
        `names afterwards. Nothing was created.`,
      { what, authorised, wanted }
    );

  // ⚠️ **THE AUTHENTICATED MODE IS VALIDATED BEFORE IT IS ACTED ON, AND THIS IS A DEFAULT-DENY.**
  // `setup-transaction.mjs` keeps the value opaque on purpose — the vocabulary is this layer's — but
  // opaque to the planner means unvalidated HERE unless this says so. It did not, and the policy
  // below asked only whether the mode was exactly `project`: `"projcet"`, `"PROJECT"`, `" project"`
  // and anything else fell through to the branch that permits a root outside the project, so a
  // one-character typo in a spec turned a junction into transcripts written outside the repository.
  // A rule shaped "if it is the strict one, be strict" grants the permissive case to every value
  // nobody thought of, which is the wrong way round for a check that guards an escape.
  if (!Object.values(STATE_MODE).includes(state.stateMode))
    throw new LocalStateRefusal(
      STATE_REFUSAL.UNKNOWN_MODE,
      `${what} was attempted under the state mode ${JSON.stringify(state.stateMode)}, which is not one ` +
        `this module knows. The two are ${Object.values(STATE_MODE).map((m) => JSON.stringify(m)).join(" and ")}. ` +
        `Nothing was created: an unrecognised mode cannot be assumed to be the permissive one, and ` +
        `the policy that decides whether state may live outside the project is not a place to guess.`,
      { what, stateMode: state.stateMode, known: Object.values(STATE_MODE) }
    );

  if (roots.mode !== state.stateMode)
    throw new LocalStateRefusal(
      STATE_REFUSAL.NO_LEASE,
      `${what} was attempted under a state mode this transaction does not authorise.\n` +
        `  authorised: ${JSON.stringify(state.stateMode)}\n  asked for:  ${JSON.stringify(roots.mode)}\n` +
        `The mode decides whether the state root may lie outside the project, so it is planned with ` +
        `the root and not supplied beside it. Nothing was created.`,
      { what, authorised: state.stateMode, wanted: roots.mode }
    );

  // ⚠️ WRITTEN AS "UNLESS IT IS THE ONE THAT PERMITS THIS", so the strict branch is what a value has
  // to be named to reach. With the vocabulary check above this is belt and braces today; written the
  // other way round it was the whole defect, and a third mode added later would inherit the safe
  // answer rather than the permissive one.
  if (state.stateMode !== STATE_MODE.USER && !isAtOrInside(authorised, state.projectRoot))
    throw new LocalStateRefusal(
      STATE_REFUSAL.ESCAPES_ROOT,
      `Project-local state resolves to ${authorised}, which is outside the transaction's project ` +
        `${state.projectRoot}. Nothing was created. A ${PROJECT_RECORD.split("/")[0]} that spells ` +
        `innocently and resolves elsewhere is why containment is checked against the canonical path.`,
      { authorised, projectRoot: state.projectRoot }
    );

  return authorised;
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
 * protects it and none is needed.
 */
export function coverageState({ projectRoot, mode, recorded = null }) {
  if (mode === STATE_MODE.USER) return { covered: true, mode, reason: "external state is outside the repository" };

  const plan = planIgnoreBlock(projectRoot, { recorded });

  // ⚠️ A PROJECT THAT IS NOT A REPOSITORY IS COVERED, and this is the one exemption that could be
  // mistaken for a loophole. Git tracks nothing here, so nothing can be published by it.
  if (plan.repository === false)
    return { covered: true, mode, reason: "not a Git repository, so nothing here is tracked", plan };

  const uncovered = coverage(plan.existing ?? "").uncovered;
  return { covered: uncovered.length === 0, mode, uncovered, state: plan.state, plan };
}

/**
 * The gate: an authorised state root, or a refusal carrying what the operator may choose.
 *
 * ⚠️ **DECIDING CREATES NOTHING; ONLY A TRANSACTION CREATES.** Setup shows the operator where each
 * mode would put things before they choose, so a derivation that created directories would leave one
 * of the two behind whichever they picked. Pass a live transaction to have the root created, and
 * ACC-0049's check — that the paths do not exist after a refusal — holds by construction rather than
 * by remembering to clean up.
 *
 * @returns {{ok: true, roots: object} | {ok: false, refusal: LocalStateRefusal, options: object[]}}
 */
export function openStateRoot({ projectRoot, mode, projectId = null, recorded = null, platform, env, home, transaction = null }) {
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

  return { ok: true, roots: transaction ? createStateRoot(roots, { transaction }) : roots, covers };
}

/**
 * The answers to a coverage refusal, in the order setup should offer them.
 *
 * ⚠️ **THE IGNORE OPTION CARRIES THE OWNER'S OWN PLAN, NOT A DESCRIPTION OF ONE.** An earlier version
 * always offered "add the block" with freshly composed bytes, which for an exact LEGACY block is the
 * wrong operation twice over: that block needs MIGRATING — its markers replaced in place — and
 * appending a second marked block beside it produces exactly the duplicate CMP-0023 exists to
 * prevent. Handing back `covers.plan` means integration calls `applyIgnoreBlock(plan)` and performs
 * the operation the owner decided on, rather than re-deriving one from a summary string and getting
 * it wrong in the case the summary did not anticipate.
 */
function refusalOptions(covers) {
  const plan = covers.plan;
  const ignore = { id: "fix-ignore", plan, action: plan?.action ?? IGNORE_ACTION.NONE };

  if (plan?.action === IGNORE_ACTION.MIGRATE)
    Object.assign(ignore, {
      summary: `migrate Kiln's existing block in .gitignore so it also ignores ${plan.adds.join(", ")}`,
      block: blockText(plan.block?.eol ?? "\n", plan.adds),
      replaces: true,
      available: true,
    });
  else if (plan?.action === IGNORE_ACTION.APPEND || plan?.action === IGNORE_ACTION.CREATE)
    Object.assign(ignore, {
      summary: `add Kiln's marked block to .gitignore, ignoring ${plan.adds.join(", ")}`,
      // ⚠️ THE BYTES, NOT A DESCRIPTION OF THEM. An operator asked to approve an edit to their own
      // `.gitignore` is entitled to see exactly what would be added.
      block: blockText("\n", plan.adds),
      replaces: false,
      available: true,
    });
  else
    Object.assign(ignore, {
      // A report — an edited, malformed or removed block — is CMP-0023's to resolve with an explicit
      // choice. It is offered, with the choice the owner requires, rather than hidden.
      summary: `resolve the ${covers.state} Kiln block in .gitignore`,
      available: false,
      requiresChoice: plan?.requiresChoice === true,
      choices: plan?.choices,
      unavailableBecause:
        `the file holds a Kiln-marked block that is ${covers.state}; that is an explicit decision ` +
        `(${(plan?.choices ?? []).join(" or ") || "operator review"}) rather than something setup may do for you`,
    });

  return [
    ignore,
    { id: "user-state", summary: "keep runtime state outside the repository, in a per-user root", available: true },
    { id: "stop", summary: "change nothing and stop", available: true },
  ];
}

/* ------------------------------------------------------------------ the project record */

/** Whether the record is absent, valid, or invalid — three answers, never two. */
export const RECORD = Object.freeze({ ABSENT: "absent", VALID: "valid", INVALID: "invalid" });

/**
 * What `.pi/kiln.json` is, validated in full against its schema.
 *
 * ⚠️ **THE WHOLE RECORD, NOT JUST THE FIELD THIS MODULE WANTS.** Reading only `projectId` accepted a
 * record with an unknown `token` property, a missing `recordVersion`, or an id that is not an id —
 * and the writer then preserved those keys and committed them. `kiln-project.schema.json` already
 * forbids additional properties and pins the id's shape; the defect was not asking it.
 *
 * ⚠️ **AND AN INVALID RECORD IS ITS OWN ANSWER, NEVER "ABSENT".** `absent` invites minting an id,
 * and this file holds an identity the external state root and the browser health identity already
 * key on. Treating damage as absence is how a project acquires a second identity and loses its state.
 */
export function projectRecordState(projectRoot, { validators } = {}) {
  const path = join(resolve(projectRoot), ...PROJECT_RECORD.split("/"));
  if (!existsSync(path)) return { kind: RECORD.ABSENT, path };

  let text;
  try {
    text = readFileSync(path, "utf-8");
  } catch (e) {
    return { kind: RECORD.INVALID, path, detail: `cannot be read (${e.message})` };
  }
  return { path, ...classifyRecordText(text, validators), text };
}

function classifyRecordText(text, validators) {
  let record;
  try {
    record = JSON.parse(text);
  } catch (e) {
    return { kind: RECORD.INVALID, detail: `is not JSON (${e.message})` };
  }
  const validate = runtimeValidators(validators)["kiln-project"];
  if (!validate(record))
    return {
      kind: RECORD.INVALID,
      record,
      detail: validate.errors.map((e) => `${e.instancePath || "/"} ${e.message}`).join("; "),
    };
  return { kind: RECORD.VALID, record };
}

/** The committed project id, `null` if there is no record, a refusal if there is a broken one. */
export function readProjectId(projectRoot, { validators } = {}) {
  const state = projectRecordState(projectRoot, { validators });
  if (state.kind === RECORD.ABSENT) return null;
  if (state.kind === RECORD.INVALID) throw recordRefusal(state);
  return assertUsableProjectId(state.record.projectId, "the external state root");
}

function recordRefusal(state) {
  return new LocalStateRefusal(
    STATE_REFUSAL.RECORD_INVALID,
    `${state.path} exists and ${state.detail}. It holds this project's committed identity, which keys ` +
      `the external state root — so a damaged one is a recovery decision, not a reason to mint a ` +
      `second id or to repair it in place. Restore it from Git, or delete it deliberately if this ` +
      `project genuinely has no identity yet.`,
    { path: state.path, detail: state.detail }
  );
}

/**
 * The transaction target for the project record, so callers plan it rather than spelling it.
 *
 * The validator runs at PLAN time as well as at merge time, so a transaction over a project whose
 * record is already invalid refuses before it writes anything at all.
 */
export function projectRecordTarget({ validators } = {}) {
  return {
    path: PROJECT_RECORD_KEY,
    validate: (text) => {
      const state = classifyRecordText(text, validators);
      if (state.kind === RECORD.INVALID) throw recordRefusal({ path: PROJECT_RECORD, detail: state.detail });
    },
  };
}

/**
 * The project's id, minted and committed once if — and only if — the record is absent.
 *
 * ⚠️ **ONCE, AND ONLY OVER AN ABSENCE.** The schema says it plainly: created once and never
 * regenerated, because it keys the external state root and regenerating it silently orphans every
 * transcript and consent record the project already had, on every machine. An INVALID record is not
 * an absence and is not repaired here — the previous version generated an id into one and preserved
 * whatever else it contained, which committed an unknown `token` field straight back into the
 * project.
 *
 * ⚠️ **THROUGH THE TRANSACTION'S MERGE, so the compare-before-write is real.** `merge` re-reads the
 * planned file under the lock and refuses if its identity moved, which is the protection the bare
 * `atomicWrite` here claimed in a comment and did not have.
 *
 * @param {{transaction: object, randomBytes: Function, validators?: object}} opts
 */
export async function ensureProjectId({ transaction, randomBytes, validators, recordVersion = 1 }) {
  // ⚠️ NO `projectRoot` ARGUMENT: the target is resolved by `tx.merge` through the transaction's own
  // plan, so which project's record is written is the transaction's answer and not a caller's. An
  // earlier signature took one and authenticated against it, which meant the check compared the
  // caller's claim to the caller's other claim.
  assertLease(transaction, `writing ${PROJECT_RECORD}`);

  let projectId = null;
  let created = false;

  const result = await runWithTransaction(transaction, "ensureProjectId", () =>
    transaction.merge(PROJECT_RECORD_KEY, (current) => {
      if (current !== null) {
        const state = classifyRecordText(current, validators);
        if (state.kind === RECORD.INVALID) throw recordRefusal({ path: PROJECT_RECORD, detail: state.detail });
        projectId = assertUsableProjectId(state.record.projectId);
        return null; // valid, and it already has an identity: nothing to write
      }
      projectId = assertUsableProjectId(generateProjectId(randomBytes), "this project's new identity");
      created = true;
      return JSON.stringify({ recordVersion, projectId }, null, 2) + "\n";
    })
  );

  return { projectId, created, target: result.target, changed: result.changed };
}

/* ------------------------------------------------------------------ helpers */

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
