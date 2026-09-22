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
import { CONTENT_DIR_NAME } from "../lib/project-scaffold.mjs";

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
  /** A project nobody has trusted, or one somebody denied: the scaffold is fine, the agent is not ready. */
  TRUST: 8,
  /** An answer left setup partial: nothing billable is enabled, and the project is still valid. */
  CONSENT: 9,
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
const VALUED = new Set(["--project-root", "--name", "--description", "--local-state", "--trust", "--provider", "--model", "--thinking", "--research"]);
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
    if (flag === "--trust") out.trust = value;
    if (flag === "--provider") out.provider = value;
    if (flag === "--model") out.model = value;
    if (flag === "--thinking") out.thinking = value;
    if (flag === "--research") out.research = value;
  }
  if (out.localState !== "project" && out.localState !== "user") return { error: `--local-state is "project" or "user", got ${JSON.stringify(out.localState)}.` };
  // ⚠️ THE ANSWER IS SPELLED OUT, BOTH WAYS. `--trust` with no value, or a value this does not understand, is a
  // mistake about the one decision that must never be defaulted (ACC-0108), so it is refused rather than read as
  // approval.
  if (out.trust !== undefined && out.trust !== "approve" && out.trust !== "deny")
    return { error: `--trust is "approve" or "deny", got ${JSON.stringify(out.trust)}.` };
  // ⚠️ A CHANGED SELECTION NEEDS BOTH HALVES. `--provider` alone cannot name a model and `--model` alone cannot say
  // whose it is, and guessing either from the other is how a run binds to something nobody asked for.
  if ((out.provider === undefined) !== (out.model === undefined))
    return { error: `--provider and --model are given together, or neither.` };
  if (out.research !== undefined && out.research !== "tavily" && out.research !== "disabled")
    return { error: `--research is "tavily" or "disabled", got ${JSON.stringify(out.research)}.` };
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
  // ⚠️ **SETUP CAN ONLY SET UP THE CONTENT ROOT THE INITIALIZER OWNS, AND SAYS SO RATHER THAN MAKING A SECOND.**
  // `PLANNING_CONTENT_DIR` selects which content a run READS; the initializer creates `<project>/planning-content`
  // by its own single rule. A run that accepted another selection would print one content root, create a second,
  // and commit a skill-override entry for whichever of the two it happened to be holding.
  const owned = join(owner, CONTENT_DIR_NAME);
  if (pathIdentityKey(contentRoot) !== pathIdentityKey(canonicalPath(owned)))
    throw new SetupCommandRefusal(
      EXIT.PATHS,
      `The selected content root is not the one this command can create.
` +
        `  selected: ${contentRoot}  (${candidate.how})
  owned:    ${owned}
` +
        `Setting up a project whose content lives elsewhere is not supported yet: the initializer creates ` +
        `${CONTENT_DIR_NAME}/ beside the project, and a run that accepted another selection would create a second ` +
        `content root and register a skill-override path for whichever one it was holding. Nothing was read or ` +
        `written. Unset the override, or run setup against the project that owns that content.`,
      { selected: contentRoot, owned: canonicalPath(owned), how: candidate.how }
    );

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
    // ⚠️ THE IGNORE FILE IS A PLANNED TARGET WHEN THIS RUN INTENDS TO CHANGE IT, and only then. Planning it is
    // what gives the owner's append the containment check, the identity recorded before anything is written and
    // the writeability probe; the owner refuses a transaction that did not plan it. A run that needs no fix
    // plans no write to it, so an already-covered project keeps the file entirely out of the transaction.
    files: [projectRecordTarget(), modules.settings.settingsTarget(), ...(coverageFix ? [{ path: ".gitignore" }] : [])],
    journal: { path: "state:runtime/setup-transaction.json", validate: modules.journalValidate },
  };

  return runTransaction(
    spec,
    async (tx) => {
      // ⚠️ DECLARED ONLY WHEN IT IS GOING TO RUN, so the journal's phase list is what this run set out to do
      // rather than a fixed menu with a permanently pending entry on every already-covered project.
      tx.declarePhases([
        ...(coverageFix ? ["state-coverage"] : []),
        "initialize",
        "state-protection",
        "project-identity",
        "trust",
        "registration",
        "inspection",
        "model",
        "credential-contract",
        "research",
      ]);

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

      // ⚠️ THE AGENT DIRECTORY IS ASKED OF PI ONCE, AND NAMED EXPLICITLY EVERYWHERE. `pi-trust` and the
      // inspection both refuse to guess it: Pi's own default is the operator's home store, and a default here
      // would record a decision, or read an authentication file, somewhere nobody named.
      //
      // ⚠️ **AND THE TRUST DECISION IS TAKEN IN A CHILD, BECAUSE LOADING PI'S SDK ENUMERATES THE ENVIRONMENT.**
      // Pi's bundled `debug` calls `Object.keys(process.env)` at module load. It reads no value, but it sees which
      // credential variables this computer has, and presence is what the inspection consent — still two phases
      // away — exists to gate. The child is started with an environment built from a fixed list of names, so
      // there is nothing of that kind in it to see, and this process loads no Pi until the operator has allowed
      // it. The agent directory the child resolved comes back in its report, for the phases that follow.
      const trust = await tx.phase("trust", () => decideTrust({ paths, args, ask, print, modules }));
      const agentDir = trust.agentDir;
      if (trust.state !== modules.trust.TRUST.APPROVED) return { initialized, identity, trust, registered: null };

      const registered = await tx.phase("registration", () => register({ tx, paths, print, modules }));

      // ⚠️ **CONSENT FIRST, AND NOTHING OF THE HOST'S IS READ BEFORE IT.** Pi's authentication store, its
      // custom-model registry and the presence of any credential variable are all behind this one answer; the
      // phases below exist in this order because each needs what the one before it was allowed to look at.
      const location = modules.consent.consentLocation({ projectRoot: paths.projectRoot });
      const validators = modules.records.createRuntimeValidators();
      const asking = interactively(args, ask);

      const inspection = await tx.phase("inspection", () =>
        modules.inspection.inspectWithConsent({ location, ask: asking.grant, agentDir })
      );
      print(inspection.summary);
      if (!inspection.inspected) {
        // ⚠️ A DECLINED INSPECTION IS AN ANSWER, AND IT STOPS THE PHASES THAT DEPEND ON IT. The research choice
        // still runs, because "not-inspected" is a state it knows how to record without looking at anything.
        const research = await tx.phase("research", () => decideResearch({ tx, location, inspection, args, asking, modules, validators, print }));
        return { initialized, identity, trust, registered, inspection, research, selection: null };
      }

      const selection = await tx.phase("model", () => chooseModel({ tx, paths, location, inspection, agentDir, args, asking, print, modules, validators }));
      if (selection.selection) print(`model ${selection.selection.provider} ${selection.selection.model} (${selection.selection.thinkingLevel})`);
      if (!READY_SELECTIONS.has(selection.outcome)) {
        const research = await tx.phase("research", () => decideResearch({ tx, location, inspection, args, asking, modules, validators, print }));
        return { initialized, identity, trust, registered, inspection, selection, research };
      }

      const contract = await tx.phase("credential-contract", () =>
        modules.credentials.resolveProviderCredentials(selection.selection.provider, { custom: null })
      );
      print(`credential contract ${contract.id}: ${contract.authSources.join(" or ")}`);

      const research = await tx.phase("research", () => decideResearch({ tx, location, inspection, args, asking, modules, validators, print }));
      return { initialized, identity, trust, registered, inspection, selection, contract, research };
    },
    { lock: { reuseHeld: true } }
  );
}

/**
 * The project's trust decision: obtained, never assumed (ACC-0108).
 *
 * ⚠️ **AN UNAPPROVED PROJECT IS A CHILD THAT SILENTLY LOADS NONE OF KILN'S TOOLS.** AST-0042 measured it on the
 * pinned runtime: no error, no warning, no non-zero exit. That is why a run with nobody to ask refuses instead
 * of carrying on, and why `--trust` has to be spelled out rather than implied by `--non-interactive`.
 *
 * ⚠️ **AND A DENIAL IS AN ANSWER, NOT A FAILURE.** The scaffold this run has already written stays, and it stays
 * valid; what the operator is told is that the agent is not ready and what would make it ready.
 */
async function decideTrust({ paths, args, ask, print, modules }) {
  const ask_ = (action) => trustDecision(action, paths, modules);

  // ⚠️ **AN EXPLICIT ANSWER OUTRANKS A RECORDED ONE, IN BOTH DIRECTIONS.** `--trust approve` is the operator
  // answering now; treating a recorded denial as final would leave them rerunning a command that cannot change
  // anything, which is how an operator concludes the flag does not work.
  if (args.trust === "deny") {
    const denied = await ask_("deny");
    print(`trust denied for ${denied.recordedFor ?? denied.projectRoot}`);
    return denied;
  }
  if (args.trust === "approve") {
    const granted = await ask_("approve");
    print(`trust approved for ${granted.recordedFor ?? granted.projectRoot}`);
    return granted;
  }

  const current = await ask_("read");
  if (current.state !== "missing") {
    // ⚠️ WHICH DIRECTORY ANSWERED. Pi may answer a project from a decision recorded against an ancestor, and an
    // operator told "denied" is entitled to know which directory they denied.
    print(`trust ${current.state} for ${current.recordedFor ?? current.projectRoot}`);
    return current;
  }

  if (args.nonInteractive)
    throw new SetupCommandRefusal(
      EXIT.TRUST,
      `This project has no trust decision, and a run with nobody to ask must not make one.\n` +
        `  project: ${paths.projectRoot}\n` +
        `An unapproved project starts an agent that loads none of Kiln's tools and reports nothing wrong, so ` +
        `assuming approval would produce exactly that. Rerun with --trust approve, or interactively.`,
      { projectRoot: paths.projectRoot }
    );

  // ⚠️ THE CANONICAL DIRECTORY IS IN THE QUESTION, because that is what the decision applies to.
  print(`Kiln needs this project trusted before its agent can load the project's package and tools:`);
  print(`  ${paths.projectRoot}`);
  const raw = await ask("Trust this project? (yes/no) ");
  const answer = String(raw ?? "").trim().toLowerCase();
  if (answer === "yes" || answer === "y") {
    const granted = await ask_("approve");
    print(`trust approved for ${granted.recordedFor ?? granted.projectRoot}`);
    return granted;
  }
  // ⚠️ **ONLY A NO IS A NO.** A denial is a decision the store remembers, and every later run reads it back as
  // "somebody said no" — so recording one for an answer nobody gave would put words in the operator's mouth and
  // make the next run stop without asking. A closed input, an empty line and an answer this does not understand
  // are all the same thing: no decision, nothing written, and a rerun that asks again.
  if (answer === "no" || answer === "n") {
    const denied = await ask_("deny");
    print(`trust denied for ${denied.recordedFor ?? denied.projectRoot}`);
    return denied;
  }
  throw new SetupCommandRefusal(
    EXIT.TRUST,
    `${raw === null || answer.length === 0 ? "No answer was given" : "That answer was not yes or no"}, so this ` +
      `project's trust is still undecided and nothing was recorded.
` +
      `  project: ${paths.projectRoot}
` +
      `Rerun and answer yes or no, or pass --trust approve or --trust deny. Everything this run set up is ` +
      `already written and valid.`,
    { projectRoot: paths.projectRoot, answered: raw !== null }
  );
}

/**
 * Register Kiln's package and the selected content root's skill overrides, through the planned merge (D27).
 *
 * ⚠️ **BOTH ENTRIES ARE PROVED BEFORE EITHER IS WRITTEN.** The package entry has to reach this checkout's
 * package directory and the skills entry has to reach the selected content root's `skills-overrides/`; a
 * spelling that does not is a committed path pointing at nothing, on every clone.
 */
async function register({ tx, paths, print, modules }) {
  const settingsDir = dirname(paths.settingsPath);
  const { packageEntry, packageEntryEquivalents } = modules.packageEntry.provePortableEntryTarget({
    settingsDir,
    packageRoot: modules.package.packageRootFor(paths.toolRoot),
  });
  const { skillsEntry } = modules.settings.skillOverrideEntry({ projectRoot: paths.projectRoot, contentRoot: paths.contentRoot });

  const result = await modules.settings.applyKilnRegistration({
    transaction: tx,
    registration: { packageEntry, packageEntryEquivalents, skillsEntry },
  });
  print(`package ${packageEntry} and skills ${skillsEntry} registered${result.changed ? "" : " (unchanged)"}`);
  return { ...result, packageEntry, skillsEntry };
}

/**
 * The installed Pi, held to this checkout's pin.
 *
 * ⚠️ **ITS REFUSAL IS THE RUNTIME CLASS, NOT A CRASH.** `resolvePinnedAgent` raises a supervisor refusal, which
 * reads well and carries the expected version and the directory it looked in; what it does not carry is an exit
 * code for this command, so it is given one here rather than falling through to "something went wrong".
 */
function checkPinnedRuntime(modules, paths) {
  try {
    return modules.runtime.resolvePinnedAgent(paths.toolRoot);
  } catch (e) {
    throw new SetupCommandRefusal(EXIT.RUNTIME, `${e.message}
Nothing of the project was changed.`, {
      toolRoot: paths.toolRoot,
      ...(e.detail ?? {}),
    });
  }
}

/**
 * The environment the trust child is given: named variables, never a copy of this one.
 *
 * ⚠️ **BUILT BY NAME, BECAUSE ENUMERATING WOULD BE THE THING BEING AVOIDED.** Copying `process.env` and removing
 * the credential variables means first seeing which of them this computer has, which is the presence check the
 * inspection consent gates. Each name here is read directly, so nothing else is ever looked at. The list is the
 * one `lib/specialists/contract.mjs` measured for a child that holds no credential, plus Pi's own locators when
 * the operator has set them — without those a child on Windows resolves the operator's default directory, which
 * is the right answer for setup and has to be reached deliberately rather than by inheriting everything.
 */
export function trustChildEnv(names, env = process.env) {
  const out = {};
  for (const name of names) {
    const value = env[name];
    if (typeof value === "string") out[name] = value;
  }
  return out;
}

/**
 * Take one trust decision in the child.
 *
 * ⚠️ **ITS FAILURES ARE THIS COMMAND'S REFUSALS.** A child that could not resolve Pi, or could not persist the
 * decision, is a run that must not continue as though the project were trusted; what it printed on stderr is
 * Kiln's own refusal text, so it is passed through rather than replaced with "the child failed".
 */
export async function trustDecision(action, paths, modules, spawn = spawnSync) {
  const { AGENT_DIR_ENV, AGENT_SESSION_DIR_ENV, BASE_ENV } = modules.contract;
  const child = join(paths.toolRoot, "lib", "pi-trust-child.mjs");
  const spec = JSON.stringify({ action, projectRoot: paths.projectRoot, toolRoot: paths.toolRoot });
  const result = spawn(process.execPath, [child, spec], {
    encoding: "utf-8",
    // ⚠️ THE NAMES THE CONTRACT MEASURED FOR A CHILD THAT HOLDS NO CREDENTIAL, plus Pi's own locators when the
    // operator set them: without those a child on Windows resolves the operator's default directory, which is the
    // right answer for setup but has to be reached deliberately rather than by inheriting everything.
    env: trustChildEnv([...BASE_ENV[process.platform === "win32" ? "win32" : "posix"], AGENT_DIR_ENV, AGENT_SESSION_DIR_ENV]),
  });

  // ⚠️ **A FAILED CHILD IS AN UNKNOWN RESULT, NOT A GUARANTEED ABSENCE OF ONE.** It may have written the decision
  // and then failed on the read-back that proves it landed, so "nothing was changed" would be a promise this
  // process cannot keep. What is true is that the outcome is unverified, and that is what the operator is told.
  if (result.status !== 0)
    throw new SetupCommandRefusal(
      EXIT.TRUST,
      `The project's trust decision could not be ${action === "read" ? "read" : "recorded and verified"}.\n` +
        `${String(result.stderr ?? "").trim() || `The check exited ${result.status ?? "on a signal"}.`}\n` +
        `Whether anything was recorded is unknown${action === "read" ? "" : ": the check may have written the decision and failed to confirm it"}. ` +
        `Rerun setup to see where this project's trust stands.`,
      { action, status: result.status }
    );

  let report;
  try {
    report = JSON.parse(String(result.stdout).trim().split("\n").pop());
  } catch {
    throw new SetupCommandRefusal(EXIT.TRUST, `The trust check did not report a decision this command could read.`, { action });
  }
  return checkedTrustReport(report, action, paths);
}

/** The three answers Pi's store can give about a project. */
const TRUST_STATES = new Set(["approved", "denied", "missing"]);

/**
 * The child's report, checked before it is treated as this project's trust.
 *
 * ⚠️ **A PARSEABLE LINE IS NOT A DECISION.** The report crosses a process boundary, and everything after this
 * point acts on it: an "approved" for another project, for an action nobody requested, or without the directory
 * it was recorded in would each make this run describe a trusted project on evidence about something else. Four
 * things are checked — the state is one Pi's store can give, the action asked for is the state that came back,
 * the project is the one this run is setting up, and the agent directory is named — because each of them is
 * something a wrong or truncated report can get wrong while still parsing.
 */
function checkedTrustReport(report, action, paths) {
  const refuse = (why) => {
    throw new SetupCommandRefusal(
      EXIT.TRUST,
      `The trust check reported something this command cannot act on: ${why}.\n` +
        `Whether anything was recorded is unknown. Rerun setup to see where this project's trust stands.`,
      { action, why }
    );
  };

  if (report === null || typeof report !== "object") refuse("the report is not an object");
  if (!TRUST_STATES.has(report.state)) refuse(`${JSON.stringify(report.state)} is not a trust state`);
  // ⚠️ THE ANSWER MUST BE TO THE QUESTION ASKED. A recorded approval reported for a denial is either a defect or
  // a report about a different run, and acting on either is how a project nobody trusted gets described as one.
  if (action === "approve" && report.state !== "approved") refuse(`an approval was requested and the state is ${report.state}`);
  if (action === "deny" && report.state !== "denied") refuse(`a denial was requested and the state is ${report.state}`);
  if (typeof report.agentDir !== "string" || report.agentDir.length === 0) refuse("it names no agent directory");
  if (typeof report.projectRoot !== "string" || pathIdentityKey(canonicalPath(report.projectRoot)) !== pathIdentityKey(paths.projectRoot))
    refuse(`it is about ${report.projectRoot ?? "no project"}, not ${paths.projectRoot}`);
  return report;
}

/** The selection outcomes that mean this project has a model it may use on this computer. */
const READY_SELECTIONS = new Set(["selected", "confirmed", "reused"]);

/**
 * One typed line, turned into what each of these modules expects.
 *
 * ⚠️ **A YES OR NO IS A BOOLEAN, AND NOTHING ELSE IS.** Consent, model confirmation and the research choice all
 * record only an explicit boolean, so an answer this cannot read must arrive as something that is not one:
 * anything else would turn "the operator typed something odd" into a decision remembered on their behalf. A
 * choice from a list is a line, and a closed input is `null` everywhere.
 *
 * ⚠️ **AND A RUN WITH NOBODY TO ASK DOES NOT ASK.** `grant` answers `null` without prompting, so a consent
 * record is never written for a question nobody saw; `choice` is undefined, which is how the selection and the
 * research choice know they cannot ask and refuse instead of defaulting.
 */
function interactively(args, ask) {
  const typed = async (prompt) => {
    const line = await ask(prompt);
    if (line === null || line === undefined) return null;
    const said = String(line).trim();
    if (/^(y|yes)$/i.test(said)) return true;
    if (/^(n|no)$/i.test(said)) return false;
    return said;
  };
  return args.nonInteractive ? { grant: async () => null, choice: undefined } : { grant: typed, choice: typed };
}

/**
 * The project's model: discovered from what this host is authenticated for, chosen, confirmed and granted.
 *
 * ⚠️ **THE EXISTING WRITERS DO THE WORK, INCLUDING CLEARING THE OLD GRANT.** A changed selection has to clear
 * this host's approval for the previous model BEFORE the new one is written, or a run could inherit an approval
 * for a model nobody approved; `selectModel` owns that rule, and setup's job here is to hand it the inspection,
 * the thinking support and the rest of the settings state.
 */
async function chooseModel({ tx, paths, location, inspection, agentDir, args, asking, print, modules, validators }) {
  const thinkingSupport = await modules.selection.loadThinkingSupport({ inspection, agentDir });
  // ⚠️ THE SELECTION'S WRITE CARRIES THE SAME SKILL ENTRY REGISTRATION WROTE, derived from the content root
  // rather than spelled again here: two writers of one key that disagree would leave the file with both.
  const { skillsEntry } = modules.settings.skillOverrideEntry({ projectRoot: paths.projectRoot, contentRoot: paths.contentRoot });
  return modules.selection.selectModel({
    transaction: tx,
    location,
    inspection,
    thinkingSupport,
    ask: asking.choice,
    print,
    requested: { provider: args.provider, model: args.model, thinking: args.thinking },
    settings: { stateMode: modules.localState.STATE_MODE.PROJECT, skillsEntry },
    validators,
  });
}

/**
 * The web-research decision, which is separate from the model's and asked on its own.
 *
 * ⚠️ **THE PRESENCE COMES FROM THE INSPECTION, NOT FROM A SECOND LOOK.** `researchCredential` is what the one
 * granted inspection saw — present, absent, or not-inspected — and passing it through is what keeps this
 * phase from reading the environment on its own.
 */
async function decideResearch({ tx, location, inspection, args, asking, modules, validators, print }) {
  const result = await modules.research.setUpResearch({
    transaction: tx,
    location,
    presence: inspection.researchCredential,
    ask: asking.choice,
    request: args.research,
    adapter: modules.tavily.createTavilyAdapter({}),
    validators,
  });
  print(result.message);
  if (result.hint) print(result.hint);
  return result;
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
  const {
    install = installDependencies,
    ask = askLine,
    print = say,
    nodeVersion = process.versions.node,
    verifyRuntime = checkPinnedRuntime,
  } = deps;
  const args = parseArgs(argv);
  if (args.error) {
    warn(args.error);
    warn(
      "This slice takes --project-root <path>, --name <text>, --description <text>, --local-state project, " +
        "--trust approve|deny, --provider <id> --model <id>, --thinking <level>, --research tavily|disabled, " +
        "--non-interactive, --resume."
    );
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
        runtime: await import("../lib/pi-runtime.mjs"),
        trust: await import("../lib/pi-trust.mjs"),
        settings: await import("../lib/pi-settings.mjs"),
        package: await import("../lib/pi-package.mjs"),
        packageEntry: await import("../lib/pi-package-entry.mjs"),
        consent: await import("../lib/consent-record.mjs"),
        inspection: await import("../lib/connection-inspection.mjs"),
        selection: await import("../lib/model-selection.mjs"),
        credentials: await import("../lib/pi-provider-credentials.mjs"),
        research: await import("../lib/research-enablement.mjs"),
        tavily: await import("../lib/research/tavily-adapter.mjs"),
        records: await import("../lib/runtime-records.mjs"),
        contract: await import("../lib/specialists/contract.mjs"),
        crypto: await import("node:crypto"),
        journalValidate: await journalValidator(),
      };

      // ⚠️ **THE PINNED RUNTIME IS VERIFIED BEFORE THE PLAN, NOT INSIDE IT (D26 step 5).** Everything after this
      // point is Pi's: the trust store, the package the settings register, the loader that reads them. A version
      // this checkout was never measured against is a fact about the install, known the moment the imports
      // resolve, and discovering it four phases later would mean refusing with the project already changed.
      const pinned = verifyRuntime(modules, paths);
      print(`pinned runtime ${pinned.version}`);

      // 6 to 12: the plan, the initializer, the identity and state protection, the journal, the trust decision
      // and the registration.
      const done = await runPhases({ paths, args, ask, print, modules });

      // ⚠️ **A DENIAL LEAVES A WORKING PROJECT AND SAYS THE AGENT IS NOT READY (ACC-0108).** Everything written
      // before this point is valid and stays: the content scaffold, the ignore block, the project identity and
      // the protected runtime directory. What is missing is the one thing an operator can grant later, so the
      // exit code distinguishes it from a refusal and the message says what would change it.
      if (done.trust.state !== modules.trust.TRUST.APPROVED) {
        warn(`This project is not trusted, so Kiln's agent is not ready. The project itself is set up and valid.`);
        warn(`  project: ${paths.projectRoot}`);
        warn(`Rerun setup with --trust approve to grant it. Kiln's planning content and its browser-only start are unaffected.`);
        return EXIT.TRUST;
      }

      // ⚠️ **A PARTIAL SETUP IS REPORTED AS ONE, WITH THE PROJECT LEFT VALID.** An inspection nobody allowed, a
      // model nobody confirmed and a cancelled choice are all answers; none of them is a failure of the command,
      // and none of them may be described as a ready agent. The project, its identity, its protected runtime
      // directory and its registered package all stand, and the operator can answer later.
      if (!done.inspection?.inspected || !READY_SELECTIONS.has(done.selection?.outcome)) {
        warn(`Setup is partial: this project has no model it may use on this computer yet.`);
        warn(
          done.inspection?.inspected
            ? `  the model was ${done.selection?.outcome === "declined" ? "declined" : "not confirmed"}; rerun setup to choose one`
            : `  this computer's connections were not inspected, so no model could be offered; rerun setup to allow it`
        );
        warn(`Everything else this run set up is written and valid.`);
        return EXIT.CONSENT;
      }

      print("setup complete for this slice: paths, runtime, dependencies, initialization, state protection, identity, journal, trust, registration, inspection, model, credential contract, research");
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
  // ⚠️ THE PINNED RUNTIME IS ITS OWN CLASS WHEREVER IT IS RAISED. `resolvePinnedAgent` and the agent-directory
  // resolver raise a supervisor refusal, and an operator whose install does not match the pin needs that told
  // apart from "setup could not write something".
  if (e?.name === "SupervisorRefusal") {
    for (const line of String(e.message).split("\n")) warn(line);
    return EXIT.RUNTIME;
  }
  // ⚠️ **KILN'S REFUSALS REACH THE OPERATOR AS REFUSALS, NOT AS STACK TRACES.** Each of these classes carries a
  // written message and a `reason`; printing the object instead would bury what was refused under a trace of
  // where. Which exit code each class deserves is the mapping TSK-0061 publishes — until then they share the
  // setup class, which is at least honest about "this run refused and wrote nothing further".
  if (typeof e?.reason === "string" && typeof e?.name === "string" && e.name.endsWith("Refusal")) {
    for (const line of String(e.message).split("\n")) warn(line);
    return EXIT.SETUP;
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
