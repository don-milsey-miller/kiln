#!/usr/bin/env node
/**
 * `node .planning/bin/setup.mjs` — the ordered first run, over the primitives that already exist (TSK-0060).
 *
 * ⚠️ **ITS PRE-INSTALL IMPORT GRAPH IS NODE BUILT-INS ONLY (ACC-0083).** This command runs before the
 * dependency graph it installs exists, so a top-level import of Ajv, Pi or anything else installed is not a
 * style question: the command could not start. Every module imported at the top of this file is itself
 * built-ins-only, transitively, and a test holds the whole graph to that. Everything else is imported
 * dynamically, after the install phase.
 *
 * ⚠️ **THE ORDER IS D26, AND THE INSTALL COMES BEFORE THE PLAN.** Paths, Node, the lock, the locked install,
 * the dynamic imports, the transaction plan, the initializer, the project identity and state protection, the
 * journal, then the remaining phases. The install cannot come later: the transaction plan validates existing
 * Kiln records, and that validation needs Ajv, which the install is what provides.
 *
 * ⚠️ **THE INSTALL IS A BOOTSTRAP MUTATION CONFINED TO THE `.planning` CHECKOUT.** It is `npm ci
 * --ignore-scripts`: it refuses a lockfile that disagrees with `package.json` before it changes anything, runs
 * no dependency lifecycle script, writes `node_modules` inside this checkout and nothing of the consumer's
 * project, and is refused after the fact if the lockfile moved. It happens before any journal exists, so an
 * interruption during it leaves the consumer's project untouched and a rerun simply repeats it.
 *
 * ⚠️ **IT IS NOT A SECOND INITIALIZER.** `bin/init-project.mjs` keeps its content-only contract; this command
 * calls the same `initializeProject` under the shared transaction.
 *
 * ⚠️ **PATHS ARE PRINTED BEFORE ANYTHING IS MUTATED (ACC-0085)**, including before the bootstrap install, and
 * an explicit `--project-root` that disagrees with the resolved content owner refuses with both printed.
 */

import { createHash } from "node:crypto";
import { createInterface } from "node:readline";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { ContentRootError, canonicalPath, contentRootCandidate, pathIdentityKey } from "../lib/content-root.mjs";
import { dependencyState } from "../lib/dependency-freshness.mjs";
import { withLock } from "../lib/lock.mjs";
import { SETUP_LOCK_FILE, SetupRefusal, runTransaction } from "../lib/setup-transaction.mjs";
import { initializeProject } from "../lib/initialize-project.mjs";

const TOOL_ROOT = canonicalPath(resolve(join(dirname(fileURLToPath(import.meta.url)), "..")));
const say = (msg) => console.log(`[kiln] ${msg}`);

/**
 * One line from the operator, or `null` when there is not going to be one.
 *
 * ⚠️ **A CLOSED INPUT IS AN ANSWER, AND IT IS NOT A CHOICE.** End of input, an interrupt and a run with no
 * terminal all resolve `null`, and every caller treats that as "nobody chose" rather than defaulting.
 */
const askLine = (question) =>
  new Promise((resolveAnswer) => {
    if (!process.stdin.isTTY) return resolveAnswer(null);
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    let answered = false;
    const finish = (value) => {
      if (answered) return;
      answered = true;
      rl.close();
      resolveAnswer(value);
    };
    rl.on("SIGINT", () => finish(null));
    rl.on("close", () => finish(null));
    rl.question(question, (answer) => finish(answer));
  });
const warn = (msg) => console.error(`[kiln] ${msg}`);

/**
 * One exit code per refusal class.
 *
 * ⚠️ **THE FULL MAPPING AND ITS `--help` ARE TSK-0061'S.** What is fixed here is that each class this slice can
 * reach has its own code, so a script can tell a bad argument from a missing runtime from a refusal to write.
 */
export const EXIT = Object.freeze({
  OK: 0,
  ARGUMENTS: 2,
  PATHS: 3,
  RUNTIME: 4,
  INSTALL: 5,
  STATE: 6,
  SETUP: 7,
});

export class SetupCommandRefusal extends Error {
  constructor(exit, message, detail = {}) {
    super(message);
    this.name = "SetupCommandRefusal";
    this.exit = exit;
    this.detail = detail;
  }
}

/** The options this slice reads. The whole argument surface, and its `--help`, belong to TSK-0061. */
const VALUED = new Set(["--project-root", "--name", "--description", "--local-state"]);
const FLAGS = new Set(["--non-interactive", "--resume", "--help", "-h"]);

export function parseArgs(argv) {
  const out = { localState: "project" };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const eq = arg.indexOf("=");
    const [flag, inline] = eq > 2 && arg.startsWith("--") ? [arg.slice(0, eq), arg.slice(eq + 1)] : [arg, null];
    if (FLAGS.has(flag) && inline === null) {
      if (flag === "--help" || flag === "-h") out.help = true;
      if (flag === "--non-interactive") out.nonInteractive = true;
      if (flag === "--resume") out.resume = true;
      continue;
    }
    if (!VALUED.has(flag)) return { error: `Unrecognised argument: ${arg}` };
    const value = inline ?? argv[++i];
    if (typeof value !== "string" || value.length === 0 || value.startsWith("--")) return { error: `${flag} needs a value.` };
    if (flag === "--project-root") out.projectRoot = value;
    if (flag === "--name") out.name = value;
    if (flag === "--description") out.description = value;
    if (flag === "--local-state") out.localState = value;
  }
  if (out.localState !== "project" && out.localState !== "user") return { error: `--local-state is "project" or "user", got ${JSON.stringify(out.localState)}.` };
  return out;
}

/**
 * Every path this run will touch, resolved and canonical, before anything is written.
 *
 * ⚠️ **AN EXPLICIT PROJECT ROOT IS CHECKED AGAINST THE CONTENT'S OWNER, NOT TRUSTED OVER IT.** The content root
 * decides which project owns it; a `--project-root` naming a different directory is a command about to be run
 * against the wrong project, so both are printed and the run refuses.
 */
export function resolvePaths({ projectRoot: explicit = null, env = process.env } = {}) {
  // ⚠️ **THE CANDIDATE, NOT THE RESOLVED ROOT, BECAUSE ON A FIRST RUN THERE IS NOTHING THERE YET.**
  // `resolveContentRoot` refuses a content root that does not exist, which is the state setup is called in;
  // the candidate is the same rule asked before anything is there, so the paths can be printed and the
  // disagreement below decided before this command creates anything.
  const candidate = contentRootCandidate(env);
  const contentRoot = canonicalPath(candidate.path);
  const owner = canonicalPath(dirname(candidate.path));
  if (explicit !== null) {
    const named = canonicalPath(resolve(explicit));
    if (pathIdentityKey(named) !== pathIdentityKey(owner))
      throw new SetupCommandRefusal(
        EXIT.PATHS,
        `The project root named on the command line is not the project that owns this content root.\n` +
          `  --project-root:        ${named}\n  owner of the content:  ${owner}  (dirname(${candidate.how}))\n` +
          `  content root:          ${contentRoot}\n` +
          `Nothing was read or written. Point --project-root at the owner, or select the other project's content ` +
          `with PLANNING_CONTENT_DIR.`,
        { named, owner, contentRoot }
      );
  }
  return {
    toolRoot: TOOL_ROOT,
    projectRoot: owner,
    contentRoot,
    settingsPath: join(owner, ".pi", "settings.json"),
    // ⚠️ THE PROJECT-LOCAL RUNTIME PATH IS DERIVED FROM BUILT-INS so it can be printed before the install.
    // An external user-local root is keyed by the committed project id and derived by `lib/local-state.mjs`,
    // which needs Ajv; `--local-state user` is therefore not part of this slice.
    runtimeStatePath: join(owner, ".pi", "runtime"),
  };
}

/** What `--engines` asks of the runtime, and whether this one satisfies it. Only `>=x.y.z` is understood. */
export function nodeSatisfies(required, version = process.versions.node) {
  const want = /^>=\s*(\d+)\.(\d+)\.(\d+)$/.exec(String(required ?? "").trim());
  if (!want) return { ok: false, why: `this checkout declares an engines.node this command cannot read (${required ?? "none"})` };
  const have = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!have) return { ok: false, why: `this runtime does not report a readable version (${version})` };
  for (let i = 1; i <= 3; i++) {
    const a = Number(have[i]);
    const b = Number(want[i]);
    if (a > b) return { ok: true };
    if (a < b) return { ok: false, why: `this runtime is Node ${version}, and this checkout needs Node ${required}` };
  }
  return { ok: true };
}

const digestOfFile = (path) => (existsSync(path) ? `sha256:${createHash("sha256").update(readFileSync(path)).digest("hex")}` : "absent");

/**
 * The locked dependency install: a bootstrap mutation confined to this checkout.
 *
 * ⚠️ **`npm ci --ignore-scripts`, AND EACH HALF IS A GUARANTEE.** `ci` refuses BEFORE it changes anything when
 * the lockfile is missing or disagrees with `package.json`, which is the check a digest taken afterwards can
 * only report too late. `--ignore-scripts` keeps every dependency's install lifecycle from running: those
 * scripts execute arbitrary code with this process's cwd and environment, and nothing in this checkout's graph
 * needs one, so the bootstrap confines itself to writing `node_modules` rather than trusting what it installs.
 *
 * ⚠️ **THE LOCKFILE IS PROVED UNCHANGED ANYWAY.** `ci` is not supposed to write `package-lock.json` at all, so
 * the digest either side is a defensive check rather than the primary one: if the lock moved, the install was
 * not the one this command promised and the tree may have been altered, so it stops and says so.
 *
 * @param {{toolRoot: string, run?: Function}} opts
 */
export function installDependencies({ toolRoot = TOOL_ROOT, run = defaultInstall } = {}) {
  const state = dependencyState(toolRoot);
  if (!state.install) return { installed: false, why: state.why };

  const lock = join(toolRoot, "package-lock.json");
  const before = digestOfFile(lock);
  const result = run({ toolRoot });
  if (!result?.ok)
    throw new SetupCommandRefusal(
      EXIT.INSTALL,
      `Installing this checkout's locked dependencies failed (${result?.why ?? "unknown"}). Nothing of the ` +
        `project was changed: the install writes only inside ${toolRoot}. A locked install also refuses when ` +
        `package-lock.json is missing or does not match package.json, which is repaired by running the install ` +
        `yourself and committing the lockfile it produces.`,
      { toolRoot }
    );
  const after = digestOfFile(lock);
  if (after !== before)
    throw new SetupCommandRefusal(
      EXIT.INSTALL,
      `The dependency install rewrote ${lock}, so it was not the locked install this command promised. ` +
        `Nothing of the project was changed. Restore the lockfile and run the install yourself to see what it wants to change.`,
      { lock }
    );
  return { installed: true, why: state.why };
}

/** The arguments that make the install a locked one; see `installDependencies` for why each is there. */
export const INSTALL_ARGS = Object.freeze(["ci", "--ignore-scripts"]);

/**
 * ⚠️ **npm IS SPAWNED HERE AND NOWHERE ELSE**, the way `bin/start-shell.mjs` already does it: through the
 * `npm_execpath` this process was started with when there is one, and otherwise the platform's npm, which needs
 * a shell on Windows because it is a `.cmd`.
 */
export function defaultInstall({ toolRoot, spawn = spawnSync }) {
  const viaNode = process.env.npm_execpath;
  const r = viaNode
    ? spawn(process.execPath, [viaNode, ...INSTALL_ARGS], { cwd: toolRoot, stdio: "inherit" })
    : spawn(process.platform === "win32" ? "npm.cmd" : "npm", [...INSTALL_ARGS], {
        cwd: toolRoot,
        stdio: "inherit",
        shell: process.platform === "win32",
      });
  return r.status === 0 ? { ok: true } : { ok: false, why: r.status === null ? `signal ${r.signal}` : `exit ${r.status}` };
}

/** The exact command that continues an interrupted run, printed into the journal and on refusal. */
export const resumeCommand = (projectRoot) => `node .planning/bin/setup.mjs --project-root ${projectRoot} --resume`;

/**
 * The phases from the transaction plan onwards. Everything here runs after the install, so every module it
 * needs is imported dynamically.
 */
async function runPhases({ paths, args, ask, print, modules }) {
  const { STATE_MODE, coverageState, createStateRoot, ensureProjectId, projectRecordTarget, stateRootFor } = modules.localState;
  const { randomBytes } = modules.crypto;

  if (args.localState === "user")
    throw new SetupCommandRefusal(
      EXIT.STATE,
      `--local-state user is not part of this slice: an external user-local root is keyed by the committed ` +
        `project id, and this command cannot print its path before the install. Run with project-local state.`,
      { localState: args.localState }
    );

  const roots = stateRootFor({ mode: STATE_MODE.PROJECT, projectRoot: paths.projectRoot });

  /**
   * ⚠️ **THE OPERATOR IS ASKED BEFORE THE TRANSACTION, AND THE ANSWER IS APPLIED INSIDE IT.** Deciding reads
   * the project and nothing else — coverage, the state library's options, one question — so it costs nothing
   * if the run is refused. The write it authorises is a mutation like any other and belongs to a declared
   * phase, where the journal can say it happened. The old order did the write here, outside the plan and with
   * no journal: the lock was held, but an interruption left a change nothing recorded.
   */
  const covers = coverageState({ projectRoot: paths.projectRoot, mode: STATE_MODE.PROJECT, roots });
  let coverageFix = null;
  if (!covers.covered) {
    const decided = modules.localState.openStateRoot({ projectRoot: paths.projectRoot, mode: STATE_MODE.PROJECT });
    const options = decided.options ?? [];
    if (args.nonInteractive)
      throw new SetupCommandRefusal(EXIT.STATE, `${decided.refusal.message}\n${renderChoices(options)}`, { options: options.map((o) => o.id) });
    print(decided.refusal.message);
    print(renderChoices(options));
    const answer = await ask(`Which? (${options.map((o) => o.id).join(", ")}) `);
    const chosen = options.find((o) => o.id === String(answer ?? "").trim());
    if (!chosen || chosen.id === "stop" || chosen.available !== true)
      throw new SetupCommandRefusal(EXIT.STATE, `Nothing was written. ${chosen?.unavailableBecause ?? "Setup stopped without protecting the runtime state."}`, {
        chosen: chosen?.id ?? null,
      });
    if (chosen.id !== "fix-ignore")
      throw new SetupCommandRefusal(EXIT.STATE, `The "${chosen.id}" choice is not part of this slice. Nothing was written.`, { chosen: chosen.id });
    coverageFix = chosen.plan;
  }

  const spec = {
    projectRoot: paths.projectRoot,
    stateRoot: roots.root,
    stateMode: STATE_MODE.PROJECT,
    files: [projectRecordTarget()],
    journal: { path: "state:runtime/setup-transaction.json", validate: modules.journalValidate },
  };

  return runTransaction(
    spec,
    async (tx) => {
      // ⚠️ DECLARED ONLY WHEN IT IS GOING TO RUN, so the journal's phase list is what this run set out to do
      // rather than a fixed menu with a permanently pending entry on every already-covered project.
      tx.declarePhases([...(coverageFix ? ["state-coverage"] : []), "initialize", "state-protection", "project-identity"]);

      // ⚠️ FIRST, BECAUSE EVERY LATER PHASE WRITES INTO THE PATHS IT PROTECTS (REQ-0027). The ignore owner does
      // its own classification against a fresh read — the plan above is a statement about the file as it was —
      // so this passes the transaction rather than the bytes.
      if (coverageFix)
        await tx.phase("state-coverage", async () => {
          await modules.gitignore.applyIgnoreBlock(coverageFix, { transaction: tx });
          print("added Kiln's block to .gitignore");
          const now = coverageState({ projectRoot: paths.projectRoot, mode: STATE_MODE.PROJECT, roots });
          if (!now.covered)
            throw new SetupCommandRefusal(EXIT.STATE, "The ignore block was applied and the runtime paths are still not ignored. Nothing else was written.", {});
        });

      const initialized = await tx.phase("initialize", () =>
        initializeProject({ projectRoot: paths.projectRoot, name: args.name, description: args.description, transaction: tx })
      );
      // ⚠️ THE INITIALIZER REPORTS REFUSALS AND DAMAGE AS DATA, and its statuses are its own vocabulary.
      if (initialized.status === modules.init.STATUS.REFUSED || initialized.status === modules.init.STATUS.DAMAGED)
        throw new SetupCommandRefusal(EXIT.SETUP, initialized.message ?? `The initializer reported ${initialized.status}.`, { status: initialized.status });
      print(`project initialized (${initialized.status})`);

      await tx.phase("state-protection", () => createStateRoot(roots, { transaction: tx }));
      const identity = await tx.phase("project-identity", () => ensureProjectId({ transaction: tx, randomBytes }));
      print(`project id ${identity.created ? "created" : "reused"}`);

      // ⚠️ THE JOURNAL ONLY NOW: it lives in the runtime directory, which has just been protected and created.
      await tx.beginJournal();
      await tx.setRecovery(resumeCommand(paths.projectRoot), "setup was interrupted after the journal began");
      return { initialized, identity };
    },
    { lock: { reuseHeld: true } }
  );
}

/** The state library's own three choices, rendered as it returned them. */
export function renderChoices(options) {
  return options
    .map((o) => {
      const head = `  ${o.id}: ${o.summary}${o.available === true ? "" : " (not available)"}`;
      return o.block ? `${head}\n${o.block.replace(/^/gm, "      ")}` : head;
    })
    .join("\n");
}

/**
 * @param {string[]} argv
 * @param {object} [deps]  ⚠️ **SEAMS FOR WHAT THIS COMMAND CANNOT DO IN A TEST**: spawning npm, and asking the
 *   operator. Neither names a program or a path; the install still runs in this checkout and nowhere else.
 */
export async function main(argv = process.argv.slice(2), deps = {}) {
  const { install = installDependencies, ask = askLine, print = say, nodeVersion = process.versions.node } = deps;
  const args = parseArgs(argv);
  if (args.error) {
    warn(args.error);
    warn("This slice takes --project-root <path>, --name <text>, --description <text>, --local-state project, --non-interactive, --resume.");
    return EXIT.ARGUMENTS;
  }
  if (args.help) {
    print("node .planning/bin/setup.mjs --project-root <path> [--name <text>] [--description <text>] [--non-interactive]");
    return EXIT.OK;
  }

  try {
    // 1. Every path, printed before anything is mutated.
    const paths = resolvePaths({ projectRoot: args.projectRoot ?? null });
    print(`tool root     ${paths.toolRoot}`);
    print(`project root  ${paths.projectRoot}`);
    print(`content root  ${paths.contentRoot}`);
    print(`settings      ${paths.settingsPath}`);
    print(`runtime state ${paths.runtimeStatePath}`);

    // 2. The runtime, before installing a dependency graph that cannot run on it.
    const manifest = JSON.parse(readFileSync(join(paths.toolRoot, "package.json"), "utf-8"));
    const node = nodeSatisfies(manifest.engines?.node, nodeVersion);
    if (!node.ok) throw new SetupCommandRefusal(EXIT.RUNTIME, `Nothing was changed: ${node.why}.`, { required: manifest.engines?.node ?? null });

    // 3. The single setup lock, held across everything that follows, including the bootstrap install.
    return await withLock(join(paths.projectRoot, SETUP_LOCK_FILE), async () => {
      // 4. The locked dependencies, inside this checkout only.
      const installed = install({ toolRoot: paths.toolRoot });
      print(installed.installed ? "dependencies installed" : `dependencies present (${installed.why})`);

      // 5. Everything else, now that it exists.
      const modules = {
        localState: await import("../lib/local-state.mjs"),
        init: await import("../lib/initialize-project.mjs"),
        gitignore: await import("../lib/project-gitignore.mjs"),
        crypto: await import("node:crypto"),
        journalValidate: await journalValidator(),
      };

      // 6 to 9: the plan, the initializer, the identity and state protection, the journal.
      await runPhases({ paths, args, ask, print, modules });
      print("setup complete for this slice: paths, runtime, dependencies, initialization, state protection, identity, journal");
      return EXIT.OK;
    });
  } catch (e) {
    return reportFailure(e, print);
  }
}

/** The journal's own schema check, from the runtime records this checkout validates everything else with. */
async function journalValidator() {
  const { createRuntimeValidators } = await import("../lib/runtime-records.mjs");
  const validators = createRuntimeValidators();
  return (record) => {
    const validate = validators["setup-transaction"];
    if (!validate(record)) throw new SetupRefusal("malformed", `The setup journal would not match its schema: ${JSON.stringify(validate.errors?.[0] ?? {})}`);
  };
}

/** Every refusal prints as one and carries its own exit code; anything else is the error it is. */
export function reportFailure(e, print = say) {
  if (e instanceof SetupCommandRefusal) {
    for (const line of e.message.split("\n")) warn(line);
    return e.exit;
  }
  if (e instanceof ContentRootError) {
    for (const line of e.message.split("\n")) warn(line);
    return EXIT.PATHS;
  }
  if (e instanceof SetupRefusal || e?.name === "LocalStateRefusal" || e?.name === "LockError") {
    for (const line of String(e.message).split("\n")) warn(line);
    return EXIT.SETUP;
  }
  console.error(e);
  return EXIT.SETUP;
}

const isEntryPoint = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isEntryPoint) main().then((code) => process.exit(code), (e) => process.exit(reportFailure(e)));
