/**
 * The content initializer's TRANSACTIONAL half — getting a generated scaffold onto disk safely.
 *
 * ⚠️ **BUILT-INS ONLY, ALL THE WAY DOWN.** This module and everything it imports use nothing but
 * `node:` modules. The whole point of the initializer is that it runs in a checkout where
 * `npm install` has not happened yet — the consumer's first three commands are `git init`,
 * `git clone … .planning`, and this. An import of `ajv` anywhere in this graph would make the
 * documented first run fail on a `Cannot find package` error, and the failure would arrive AFTER the
 * user had already cloned a tool that could not introduce itself.
 *
 * That constraint is also why validation here is STRUCTURAL rather than a `lintProject` call: the
 * lint needs Ajv. What this can do without dependencies is read every generated file back off disk
 * and prove it is byte-for-byte what was meant to be written, that the directory contains nothing
 * else, and that the two declarations the rest of the tool reads out of a manifest — the schema
 * version and the activated-type list — say what they must. `test/initialize-project.test.mjs` runs
 * the real lint over the result, where dependencies do exist.
 *
 * ⚠️ **NOTHING VISIBLE IS CREATED UNTIL EVERYTHING IS VALID.** The tree is built in a hidden sibling
 * directory and renamed into place as the last step. A failure — a full disk, an interrupted process,
 * a validation problem — leaves no `planning-content/`, because a half-written content root is worse
 * than none: the next run would see a non-empty unknown directory and refuse, and the user would be
 * left hand-deleting a tree the tool made.
 *
 * ⚠️ **THERE IS NO `--force`, AND THAT IS THE DESIGN.** Every refusal here protects documents
 * somebody wrote. A flag that turns "I will not overwrite your planning content" into one keystroke
 * is a flag that will eventually be typed by someone who has not read what it does. If a content
 * root must be replaced, that is `rm -r` — a thing the operating system already makes deliberate.
 *
 * ⚠️ **`.gitignore` IS APPENDED BEFORE THE CONTENT IS RENAMED INTO PLACE.** That order looks
 * backwards and is not: the other order leaves a crash window in which the content root exists — so
 * every later run reports `already-initialized` and does nothing — while `.planning/` was never
 * ignored, and nothing would ever notice. Appending first means a crash costs a rerun, and the rerun
 * finds Kiln's own marked block and does not duplicate it.
 */

import {
  appendFileSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  rmdirSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join, resolve, sep } from "node:path";

import { withLock } from "./lock.mjs";
import { canonicalPath, isAtOrInside, pathIdentityKey, toolRoot } from "./content-root.mjs";
import { runWithTransaction, transactionState } from "./setup-transaction.mjs";
import { SCHEMA_VERSION, manifestSchemaVersion } from "./content-version.mjs";
import { loadStageDefinitions } from "./stages.mjs";
import { readActivatedTypes } from "./activation.mjs";
import {
  CONTENT_DIR_NAME,
  GITIGNORE_STATUS,
  SETUP_FILE,
  SETUP_VERSION,
  USER_TEXT_FILES,
  buildScaffold,
  byCodeUnit,
  requiredPaths,
} from "./project-scaffold.mjs";
import { IGNORE_RULES, applyIgnoreBlock, planIgnoreBlock } from "./project-gitignore.mjs";

export { CONTENT_DIR_NAME };

/** The name of the tool directory in a consumer checkout. Initializing INTO it is always wrong. */
export const TOOL_DIR_NAME = ".planning";
export const LOCK_FILE = ".planning-init.lock";

/** A structured outcome, so no caller has to read prose to decide what happened. */
export const STATUS = {
  CREATED: "created",
  ALREADY_INITIALIZED: "already-initialized",
  /** Kiln wrote this content root and something it cannot work without has since gone. */
  DAMAGED: "damaged",
  REFUSED: "refused",
};

/**
 * How a refusal should be treated by a command-line caller.
 *   `invalid-target` — the arguments named something that cannot be initialized (exit 2).
 *   `conflict`       — the target is real but already holds content Kiln did not write (exit 1).
 */
export const REFUSAL_CLASS = { INVALID_TARGET: "invalid-target", CONFLICT: "conflict" };

/** Thrown when initialization STARTED and then failed. A refusal is returned, not thrown. */
export class InitializationError extends Error {
  constructor(message, problems = []) {
    super(message);
    this.name = "InitializationError";
    this.problems = problems;
  }
}

const RENAME_RETRY_CODES = new Set(["EPERM", "EBUSY", "EACCES", "ENOTEMPTY"]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ paths */

/**
 * ⚠️ Was a verbatim third copy of `content-root.mjs`'s rule, with a comment saying so. The rule is
 * now exported from the one module that owns path containment, so the copy is gone rather than
 * annotated — a duplicate that documents being a duplicate is still the thing that drifts.
 */
const samePathPrefix = (child, parent) => isAtOrInside(child, parent);

function refusal(reason, refusalClass, message, extra = {}) {
  return { status: STATUS.REFUSED, reason, refusalClass, message, ...extra };
}

/**
 * ⚠️ **THE PROJECT ROOT IS EXPLICIT AND CANONICALISED, NEVER `process.cwd()`.** An initializer that
 * defaulted to the working directory would create a project wherever the terminal happened to be —
 * and the one thing worse than refusing to guess is guessing about where to write a directory tree.
 * `realpathSync` resolves symlinks, so the containment checks below are about real locations rather
 * than about the spelling of a path.
 */
function resolveProjectRoot(projectRoot) {
  if (typeof projectRoot !== "string" || projectRoot.trim().length === 0)
    return { error: refusal("missing-project-root", REFUSAL_CLASS.INVALID_TARGET, "--project-root is required.") };
  if (projectRoot.includes("\0"))
    return { error: refusal("invalid-project-root", REFUSAL_CLASS.INVALID_TARGET, "--project-root contains a NUL byte.") };

  const absolute = resolve(projectRoot);
  if (!existsSync(absolute))
    return {
      error: refusal(
        "project-root-missing",
        REFUSAL_CLASS.INVALID_TARGET,
        `No such directory: ${absolute}\nThe project directory must already exist — the initializer fills a project in, ` +
          `it does not decide where one lives.`
      ),
    };
  if (!statSync(absolute).isDirectory())
    return {
      error: refusal("project-root-not-a-directory", REFUSAL_CLASS.INVALID_TARGET, `Not a directory: ${absolute}`),
    };

  const canonical = realpathSync(absolute);
  const tool = realpathSync(toolRoot());

  // ⚠️ TWO CHECKS, NOT ONE, BECAUSE THEY CATCH DIFFERENT MISTAKES. The first catches the consumer's
  // real error — running the command from inside `.planning/` and passing `.` — for the tool
  // checkout that is actually executing. The second catches SOME OTHER `.planning/` on the path,
  // which the first cannot see and which would produce content the resolver can never find, since
  // `<toolRoot>/../planning-content` is the only rule there is.
  if (samePathPrefix(canonical, tool))
    return {
      error: refusal(
        "inside-tool-directory",
        REFUSAL_CLASS.INVALID_TARGET,
        `Refusing to initialize inside the tool directory.\n` +
          `  project root: ${canonical}\n  tool root:    ${tool}\n` +
          `Planning content lives BESIDE the tool, never inside it: the tool directory is a clone that ` +
          `\`git pull\` overwrites, and it is ignored by the project's repository. Pass the containing ` +
          `project instead — from inside .planning/ that is \`--project-root ..\`.`
      ),
    };

  if (canonical.split(sep).includes(TOOL_DIR_NAME))
    return {
      error: refusal(
        "inside-tool-directory",
        REFUSAL_CLASS.INVALID_TARGET,
        `Refusing to initialize under a ${TOOL_DIR_NAME}/ directory: ${canonical}\n` +
          `Content resolution has exactly one rule — <toolRoot>/../planning-content — and content placed ` +
          `here could never be found by it.`
      ),
    };

  return { projectRoot: canonical };
}

/* ------------------------------------------------------------------ filesystem helpers */

/** Every file under `root`, as content-root-relative `/`-separated paths. Directories are not listed. */
function walkFiles(root, prefix = "") {
  const out = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...walkFiles(join(root, entry.name), rel));
    else out.push(rel);
  }
  return out.sort(byCodeUnit);
}

/**
 * Rename with the bounded retry #72 records as non-optional on Windows: a directory a watcher or an
 * indexer has open surfaces as EPERM/EBUSY rather than as anything meaningful.
 */
async function renameWithRetry(from, to, rename = renameSync, maxAttempts = 10, backoffMs = 10) {
  for (let attempt = 0; ; attempt++) {
    try {
      rename(from, to);
      return;
    } catch (e) {
      if (!RENAME_RETRY_CODES.has(e.code) || attempt >= maxAttempts) throw e;
      await sleep(backoffMs * (attempt + 1));
    }
  }
}

/* ------------------------------------------------------------------ validation */

/**
 * Prove the tree on disk IS the tree that was generated — read back, never trusted.
 *
 * ⚠️ Comparing the written files against the in-memory map is the only comparison that can catch a
 * truncated write or a path collision. Re-inspecting the map it was written from would prove only
 * that the generator agrees with itself, which is the failure `validatePackage` in the handoff
 * publisher exists to avoid and the same one applies here.
 */
function validateTree(root, files, stageDefinitions, schemaVersion) {
  const problems = [];

  for (const [rel, contents] of files) {
    const abs = join(root, ...rel.split("/"));
    if (!existsSync(abs)) {
      problems.push(`missing after write: ${rel}`);
      continue;
    }
    const actual = readFileSync(abs, "utf-8");
    if (actual !== contents) problems.push(`written bytes differ from generated bytes: ${rel}`);
  }

  const onDisk = walkFiles(root);
  const expected = [...files.keys()].sort(byCodeUnit);
  for (const extra of onDisk.filter((f) => !files.has(f))) problems.push(`unexpected file in the generated tree: ${extra}`);
  if (onDisk.length !== expected.length) problems.push(`generated ${onDisk.length} file(s); expected ${expected.length}`);

  const { manifest, version } = manifestSchemaVersion(root);
  if (!manifest) problems.push("the generated manifest could not be found");
  else if (version !== schemaVersion)
    problems.push(`the generated manifest declares schemaVersion ${version}; this tool writes ${schemaVersion}`);

  const activated = readActivatedTypes(root);
  if (activated.length)
    problems.push(`the generated manifest activates ${activated.join(", ")}; activation is a stage-2 decision (#39)`);

  for (const id of Object.keys(stageDefinitions))
    if (!files.has(`stages/${id}.md`)) problems.push(`no starter document for stage ${id}`);

  return problems;
}

/* ------------------------------------------------------------------ already-initialized */

/**
 * Read the marker that says Kiln wrote this content root.
 *
 * ⚠️ **FOUR OUTCOMES, NOT TWO, BECAUSE THEY CALL FOR DIFFERENT ACTIONS.** This used to return the
 * record or `null`, which collapsed "there is no setup record" together with "there is one and it is
 * damaged" and with "there is one and this tool does not understand it". The first falls through to
 * the conflict path and is reported as content Kiln did not write — which is the opposite of true,
 * and sends the user looking for a project that is not theirs.
 *
 * ⚠️ **A `setupVersion` this tool does not write is a REFUSAL, not a best effort.** The field exists
 * to gate a change in this record's shape; reading a shape you do not know, in order to decide
 * whether to leave somebody's project alone, is exactly the guess it was added to prevent. There is
 * no migration for it yet, so any number but the current one stops the command and says both.
 */
function readSetupRecord(contentRoot) {
  const path = join(contentRoot, ...SETUP_FILE.split("/"));
  if (!existsSync(path)) return { kind: "absent", path };

  let record;
  try {
    record = JSON.parse(readFileSync(path, "utf-8"));
  } catch (e) {
    return { kind: "unreadable", path, detail: e.message };
  }
  if (!record || typeof record !== "object" || Array.isArray(record) || !Number.isInteger(record.setupVersion))
    return { kind: "unreadable", path, detail: "no integer `setupVersion`" };
  if (record.setupVersion !== SETUP_VERSION)
    return { kind: "unsupported", path, setupVersion: record.setupVersion };

  return { kind: "ok", path, record };
}

/** Directories are checked as directories: a FILE named `data` is damage, not a directory. */
function isDirectory(p) {
  try {
    return lstatSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * What an initialized content root is missing that it cannot work without.
 *
 * ⚠️ **STRUCTURAL DAMAGE IS NOT DRIFT, AND CONFLATING THEM MADE A BROKEN PROJECT EXIT 0.** A rerun
 * used to report `already-initialized` on the strength of `state/setup.json` alone, so a content root
 * whose `project.yaml` had been deleted was a silent success — the one outcome a setup command must
 * never produce, because the next thing the user does is run the app against it. Edits to authored
 * files stay informational; an absent manifest or stage document does not.
 */
function structuralProblems(contentRoot, stageDefinitions) {
  const required = requiredPaths(stageDefinitions);
  const problems = [];
  for (const rel of required.files)
    if (!existsSync(join(contentRoot, ...rel.split("/")))) problems.push({ kind: "file", path: rel });
  for (const rel of required.directories)
    if (!isDirectory(join(contentRoot, ...rel.split("/")))) problems.push({ kind: "directory", path: rel });
  return problems;
}

/**
 * What has changed since the scaffold was written — REPORTED, never repaired.
 *
 * ⚠️ **The initializer does not restore anything, and this is why the drift report exists.** A
 * "self-healing" initializer that silently rewrote a stage document would undo work the moment
 * someone reran a command they thought was a no-op. Naming what changed and doing nothing about it
 * leaves the decision where it belongs.
 *
 * ⚠️ **`project.yaml` and `README.md` are not compared.** They carry the project's name and
 * description, so re-deriving them would mean parsing YAML back out of a file the user is entitled
 * to have edited — and every edit to either is expected rather than suspicious. `missing` still
 * covers them, because their ABSENCE is a real fact that needs no regeneration to see.
 */
function detectDrift(contentRoot, stageDefinitions, schemaVersion, setup) {
  const reference = buildScaffold({
    name: "reference",
    description: "",
    stageDefinitions,
    schemaVersion,
    gitignoreStatus: setup?.steps?.gitignore ?? GITIGNORE_STATUS.NOT_A_REPOSITORY,
  });

  const missing = [];
  const modified = [];
  for (const [rel, contents] of reference) {
    const abs = join(contentRoot, ...rel.split("/"));
    if (!existsSync(abs)) {
      missing.push(rel);
      continue;
    }
    if (USER_TEXT_FILES.has(rel)) continue;
    if (readFileSync(abs, "utf-8") !== contents) modified.push(rel);
  }
  return { missing: missing.sort(byCodeUnit), modified: modified.sort(byCodeUnit) };
}

/* ------------------------------------------------------------------ entry point */

/**
 * Initialize a project's `planning-content/`.
 *
 * @param {object} opts
 * @param {string} opts.projectRoot            the CONTAINING project, not the tool directory
 * @param {string} opts.name                   required — written into the manifest
 * @param {string} [opts.description]
 * @param {object} [opts.stageDefinitions]     defaults to the tool's own `stages/`
 * @param {number} [opts.schemaVersion]        defaults to `SCHEMA_VERSION`
 * @param {(event: object) => void} [opts.log] receives `{kind, ...}` notices as they happen
 * @param {(from: string, to: string) => void} [opts.rename] injectable, as in `publishHandoff`
 * @param {object} [opts.lock]                 `withLock` options, for tests that need a short wait
 * @param {object} [opts.transaction]          a transaction from `runTransaction` that ALREADY holds
 *   this project's lock. When passed, the initializer runs inside it instead of acquiring the lock
 *   itself — see the note on nested locks below.
 * @returns {Promise<object>} `{status: "created" | "already-initialized" | "refused", ...}`
 */
export async function initializeProject(opts = {}) {
  const {
    name,
    description = "",
    schemaVersion = SCHEMA_VERSION,
    log = () => {},
    rename = renameSync,
    lock = {},
  } = opts;

  const resolved = resolveProjectRoot(opts.projectRoot);
  if (resolved.error) return resolved.error;
  const projectRoot = resolved.projectRoot;

  if (typeof name !== "string" || name.trim().length === 0)
    return refusal(
      "invalid-name",
      REFUSAL_CLASS.INVALID_TARGET,
      "A project name is required: it is written into the manifest and nothing can derive it."
    );
  if (name.length > 200)
    return refusal("invalid-name", REFUSAL_CLASS.INVALID_TARGET, "A project name must be 200 characters or fewer.");
  if (typeof description !== "string")
    return refusal("invalid-description", REFUSAL_CLASS.INVALID_TARGET, "--description must be text.");
  if (description.length > 4000)
    return refusal("invalid-description", REFUSAL_CLASS.INVALID_TARGET, "A description must be 4000 characters or fewer.");

  const stageDefinitions = opts.stageDefinitions ?? loadStageDefinitions();
  if (!stageDefinitions || Object.keys(stageDefinitions).length === 0)
    return refusal(
      "no-stage-definitions",
      REFUSAL_CLASS.INVALID_TARGET,
      `No stage definitions under ${join(toolRoot(), "stages")}. Starter documents are generated from that set ` +
        `and there is nothing to generate from — refusing rather than inventing a stage list (#34).`
    );

  const contentRoot = join(projectRoot, CONTENT_DIR_NAME);
  log({ kind: "paths", toolRoot: toolRoot(), projectRoot, contentRoot });

  /**
   * ⚠️ **ONE LOCK FOR THE COMMAND, SO THIS ONE DEFERS RATHER THAN NESTS.** `setup` holds
   * `<project>/.planning-init.lock` for its whole run and calls this from inside it. Acquiring the
   * same lock again would wait on a file only this process can remove — the exclusive create cannot
   * tell "someone else holds it" from "I hold it" — so the transaction is passed down and the lock
   * is not taken twice. `withLock` refuses re-entry outright, which is what turns a caller that
   * forgets into an immediate error rather than a stall.
   *
   * ⚠️ **THE TRANSACTION IS CHECKED AGAINST THIS PROJECT, NOT JUST CHECKED FOR.** A transaction is
   * exclusion over ONE project; one held on a different project excludes nobody here, and accepting
   * it would let two initializers run believing they were each protected.
   */
  if (opts.transaction) {
    // ⚠️ **AUTHENTICATED, NOT DUCK-TYPED.** This used to read `transaction.plan.projectRoot` and
    // believe it, so `{ plan: { projectRoot } }` — an object literal — was accepted as proof that
    // the lock was held, and the scaffold was built with no exclusion at all. A shape describes
    // data; it cannot establish a capability. `transactionState` answers the only question that
    // matters: did the transaction module issue this exact object, and is it still live?
    const state = transactionState(opts.transaction);
    if (!state)
      return refusal(
        "transaction-not-authentic",
        REFUSAL_CLASS.INVALID_TARGET,
        "The supplied transaction was not issued by the setup transaction module. An object that " +
          "merely looks like one holds no lock, and running inside it would mean running inside nothing."
      );
    if (!state.active)
      return refusal(
        "transaction-not-active",
        REFUSAL_CLASS.CONFLICT,
        "The supplied transaction has already finished and its lock is released. Holding the lock " +
          "once is not holding it now."
      );

    const held = state.projectRoot;
    if (pathIdentityKey(held) !== pathIdentityKey(canonicalPath(projectRoot)))
      return refusal(
        "transaction-project-mismatch",
        REFUSAL_CLASS.CONFLICT,
        `The supplied transaction holds a different project.\n` +
          `  transaction: ${held}\n  initializing: ${projectRoot}\n` +
          `A lock on another project is not exclusion here — it would let a second initializer run ` +
          `while this one believed it was protected.`
      );

    // ⚠️ **RUN THROUGH THE TRANSACTION, NOT MERELY PAST ITS DOOR.** The three checks above produce
    // an operator-readable refusal; they do not make this work part of the transaction. Returning
    // `initializeUnderLock()` directly left the scaffold being built outside the transaction's
    // registry, so a body that did not await this call let the lock release while initialization
    // carried on — authenticated at entry and unprotected throughout. `runWithTransaction`
    // re-authenticates and enrols, so the transaction cannot finish while this is still running.
    return runWithTransaction(opts.transaction, "initializeProject", () => initializeUnderLock());
  }

  return withLock(join(projectRoot, LOCK_FILE), () => initializeUnderLock(), { maxWaitMs: 30_000, ...lock });

  async function initializeUnderLock() {
    /* ---- what is already there ------------------------------------------ */

    let mustRemoveEmptyDirectory = false;
    if (existsSync(contentRoot)) {
      if (!lstatSync(contentRoot).isDirectory())
        return refusal(
          "content-root-not-a-directory",
          REFUSAL_CLASS.CONFLICT,
          `${contentRoot} exists and is not a directory. Kiln will not replace it.`
        );

      const entries = readdirSync(contentRoot);
      const setup = readSetupRecord(contentRoot);

      if (setup.kind === "unreadable")
        return refusal(
          "setup-record-unreadable",
          REFUSAL_CLASS.CONFLICT,
          `${setup.path} exists but cannot be read as a setup record (${setup.detail}).\n` +
            `That file is what says this content root is Kiln's, so a damaged one leaves the question ` +
            `unanswerable. Restore it from Git rather than letting the command decide.`,
          { contentRoot }
        );

      if (setup.kind === "unsupported")
        return refusal(
          "setup-version-unsupported",
          REFUSAL_CLASS.CONFLICT,
          `${setup.path} declares setupVersion ${setup.setupVersion}; this tool writes ${SETUP_VERSION}.\n` +
            `The record's shape is not one this tool knows, and there is no migration for it — update ` +
            `the tool (\`git pull\` in .planning/) rather than acting on a record it cannot read.`,
          { contentRoot }
        );

      if (setup.kind === "ok") {
        const structural = structuralProblems(contentRoot, stageDefinitions);
        const drift = detectDrift(contentRoot, stageDefinitions, schemaVersion, setup.record);

        // ⚠️ NOT A SUCCESS, AND NOT REPAIRED EITHER. The command's job is to report what it found;
        // rewriting a manifest under a project that still holds the user's artifacts would be a far
        // worse answer than a non-zero exit.
        if (structural.length) {
          log({ kind: "damaged", contentRoot, structural });
          return { status: STATUS.DAMAGED, projectRoot, contentRoot, setup: setup.record, structural, drift };
        }

        log({ kind: "already-initialized", contentRoot, drift });
        return {
          status: STATUS.ALREADY_INITIALIZED,
          projectRoot,
          contentRoot,
          setup: setup.record,
          drift,
          // ⚠️ Reported so the caller can say so out loud. A second run does not touch `.gitignore`:
          // if the user deleted a block Kiln added, restoring it would overrule a deliberate edit
          // with a command they expected to do nothing.
          gitignore: { touched: false, recorded: setup.record.steps?.gitignore ?? null },
        };
      }

      if (entries.length > 0)
        return refusal(
          "content-root-conflict",
          REFUSAL_CLASS.CONFLICT,
          `${contentRoot} already exists, is not empty, and was not written by Kiln — there is no ` +
            `state/setup.json in it. Refusing: initializing would mean writing over documents somebody ` +
            `authored, and there is deliberately no flag that makes that easy.`,
          { contentRoot, conflicts: entries.sort(byCodeUnit) }
        );

      // An empty directory is not content. It cannot be renamed over, so it goes just before the swap.
      mustRemoveEmptyDirectory = true;
    }

    /* ---- plan, generate, write out of sight ------------------------------ */

    const gitignorePlan = planIgnoreBlock(projectRoot);
    if (!gitignorePlan.repository)
      log({
        kind: "notice",
        message:
          `${projectRoot} is not a Git repository, so nothing was added to a .gitignore. ` +
          `If you make it one later, add ${IGNORE_RULES.map((r) => `\`${r}\``).join(", ")} yourself: the ` +
          `tool directory is a clone with its own remote and committing it into this project would nest ` +
          `one repository in another, and the other two hold session transcripts and runtime records.`,
      });

    const files = buildScaffold({ name, description, stageDefinitions, schemaVersion, gitignoreStatus: gitignorePlan.status });

    const temp = join(projectRoot, `.${CONTENT_DIR_NAME}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
    log({ kind: "temp-directory", path: temp });

    let committed = false;
    try {
      mkdirSync(temp, { recursive: true });
      for (const [rel, contents] of files) {
        const abs = join(temp, ...rel.split("/"));
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, contents, "utf-8");
      }

      const problems = validateTree(temp, files, stageDefinitions, schemaVersion);
      if (problems.length)
        throw new InitializationError(
          `The generated planning content did not validate, so nothing was moved into place:\n` +
            problems.map((p) => `  - ${p}`).join("\n"),
          problems
        );

      // ⚠️ BEFORE THE SWAP. See this module's header: the other order has a crash window in which
      // the content root exists and `.planning/` is ignored by nothing, forever.
      // ⚠️ THE OWNER IS NOT PASSED A `contentRoot`, because there is not one yet — the scaffold is
      // still in the temp directory. The record is written BY the scaffold, from the planned status,
      // which is why `perform` keeps `plan.status` on every path that declines to write.
      const applied = await applyIgnoreBlock(gitignorePlan);
      if (gitignorePlan.action !== "none")
        log({ kind: "gitignore", action: gitignorePlan.action, path: gitignorePlan.path, ...applied });

      // ⚠️ `rmdirSync`, which refuses a non-empty directory, rather than a recursive remove. This
      // path is only reached for a directory that was observed empty a few milliseconds ago, and the
      // difference between the two calls is what happens if that observation was wrong: one fails,
      // the other deletes whatever arrived in between.
      if (mustRemoveEmptyDirectory) rmdirSync(contentRoot);
      await renameWithRetry(temp, contentRoot, rename);
      committed = true;

      log({ kind: "created", contentRoot, fileCount: files.size });
      return {
        status: STATUS.CREATED,
        projectRoot,
        contentRoot,
        files: [...files.keys()],
        validated: true,
        git: { repository: gitignorePlan.repository, gitignore: applied.status, path: gitignorePlan.path, applied },
      };
    } finally {
      // ⚠️ ALWAYS, and it is what makes "a failed first run leaves no visible planning-content/" true
      // rather than usually true. The temp name is dot-prefixed so even a failure this cannot reach —
      // a killed process — leaves nothing that reads as the user's content directory.
      if (!committed) {
        try {
          rmSync(temp, { recursive: true, force: true });
        } catch {
          /* reported by the next run's conflict list, not by a swallowed error here */
        }
      }
    }
  }
}
