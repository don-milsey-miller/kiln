#!/usr/bin/env node
/**
 * `node .planning/bin/start-kiln.mjs` — one command, two processes: the planning application in the
 * background and Pi in front of the operator.
 *
 * ⚠️ **THIS FILE'S ONLY JOB IS TO SAY WHAT RUNS.** Everything about HOW — the port, the readiness
 * handshake, the shutdown contract — is in `lib/supervisor.mjs`, so it can be tested against
 * stand-in children without credentials or an interactive agent. What cannot be delegated to a test
 * is the choice of programs, because that choice is the security boundary: this supervisor attaches
 * the operator's terminal to whatever it starts.
 *
 * ⚠️ **NO COMMAND OVERRIDE, FROM ANY DIRECTION.** There is no flag and no environment variable that
 * can name a different launcher or a different agent. Both are resolved canonically from this
 * checkout, passed as a command plus an argument array, and spawned with `shell: false` — an
 * override would be a supported way to run an arbitrary program with the terminal inherited, and a
 * shell would be a second interpreter of the arguments.
 *
 * ⚠️ **THE RECORDED SELECTION IS CHECKED BEFORE ANYTHING STARTS, AND PI IS HELD TO IT (TSK-0037).** The launch
 * checks run first: this host's consent for the exact model, its credential contract, Pi's registry and
 * authentication, the thinking level, the package and its tools, and a compatibility record matching the key
 * computed for this launch. A refusal names the recorded provider and model and starts nothing. What passed is
 * then put on Pi's own command line as `--provider`, `--model` and `--thinking`, so Pi runs exactly the
 * selection that was checked rather than whatever default it would otherwise resolve. `--provider`,
 * `--model` and `--thinking` on THIS command are the one-run override: confirmed, proved for that run by
 * its own approved live check, and never written back.
 */

import { randomBytes } from "node:crypto";
import { createInterface } from "node:readline";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

import { existsSync } from "node:fs";

import { consentLocation } from "../lib/consent-record.mjs";
import { ContentRootError, canonicalPath, resolveProjectRoot } from "../lib/content-root.mjs";
import { LaunchRefusal, checkLaunch as checkLaunchDefault } from "../lib/launch-checks.mjs";
import { runLiveCanary } from "../lib/live-canary.mjs";
import { LocalStateRefusal, committedDeclarations } from "../lib/local-state.mjs";
import { REFUSAL, SupervisorRefusal, assertSelfHostOptIn, runSupervisor } from "../lib/supervisor.mjs";
import { declaredToolNames, packageRootFor } from "../lib/pi-package.mjs";
import { resolvePinnedAgent, resolvePinnedAgentDir, resolvePinnedSessionLister } from "../lib/pi-runtime.mjs";
import { isEntryPoint as isModuleEntryPoint } from "../lib/entry-point.mjs";
import { startInJob } from "../lib/windows-job.mjs";

const TOOL_ROOT = resolve(join(dirname(fileURLToPath(import.meta.url)), ".."));
const say = (msg) => console.log(`[kiln] ${msg}`);

/**
 * One line from the operator, or `null` if there is not going to be one.
 *
 * ⚠️ **AN END OF INPUT AND AN INTERRUPT ARE ANSWERS TOO, AND THEY ARE NOT "YES".** A closed stdin, a Ctrl+C or a
 * Ctrl+D while a question is on screen all mean the same thing: nobody chose. They resolve `null`, and every
 * caller treats that as a decision not to continue rather than as a blank answer to be defaulted.
 */
const askLine = (question) =>
  new Promise((resolveAnswer) => {
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

const ask = async (question) => /^y(es)?$/i.test(String((await askLine(question)) ?? "").trim());

/**
 * What the operator is told about the shutdown.
 *
 * ⚠️ **EXPORTED BECAUSE IT WAS WRONG AND NOTHING COULD SEE IT.** The launcher's control-channel
 * answer moved under `shutdown.launcher` and its tree's under `shutdown.launcherTree`, and this line
 * kept reading the old flat fields — printing three `undefined`s on every successful run, in the one
 * part of the system with no test at all. A decision worth making is a decision worth being able to
 * check, so both of this file's are functions now.
 *
 * The tree is named beside the control channel because it is the half that notices a worker left
 * behind: a launcher can answer its pipe perfectly and still leave one.
 */
export function stoppedSummary(result) {
  const { launcher, launcherTree } = result.shutdown;
  return (
    `stopped (${result.trigger}) — stop sent: ${launcher.sentStop}, stdin end requested: ` +
    `${launcher.endRequested}, launcher exit observed: ${launcher.exitObserved}, ` +
    `launcher tree stopped: ${launcherTree.treeStopped}`
  );
}

/**
 * The process status this run should leave with.
 *
 * ⚠️ **AN INTERRUPT IS NOT A CLEAN EXIT, WHATEVER CODE PI HAPPENED TO RETURN.** `code` is null when
 * Pi is killed outright, and `?? 0` reported that as success — but the subtler case is the one that
 * survived that fix: a signal Pi handles TIDILY, shutting down and exiting 0. The agent's code then
 * says success and the run was still interrupted, so a script wrapping this would carry on.
 *
 * The supervisor already observed which of the two ended the run, recorded where the signal was
 * handled rather than inferred from the processes having gone. That observation decides the status;
 * the agent's own code is consulted only when nothing interrupted it.
 *
 * ⚠️ AND AN EXIT NOBODY SAW IS NOT A ZERO EITHER. `{code: null, signal: null}` is what the supervisor
 * records when the agent never went, and `?? 0` reads that as success. It is unreachable today —
 * such a run refuses before returning — which is exactly why it is worth pinning rather than
 * leaving to the next change.
 */
export function exitStatusFor(result) {
  if (result.trigger === "signal") return 1;
  const { code, signal, observed } = result.agentExit;
  if (observed === false) return 1;
  return code ?? (signal ? 1 : 0);
}

/**
 * The command line, which is one flag and nothing else.
 *
 * ⚠️ **AN UNRECOGNISED ARGUMENT IS A REFUSAL, NOT A SHRUG.** This file read `process.argv` not at all,
 * so anything typed after the script name was dropped in silence. That was tolerable while there were
 * no flags and stops being tolerable the moment one of them is the difference between refusing to
 * touch the tool repository and writing into it: `--selfhost` or `--self_host` would be discarded, and
 * the operator would read the refusal that follows as the flag not working rather than as the flag not
 * existing.
 *
 * ⚠️ It is EXPORTED for the same reason the two decisions above are: the alternative to testing it is
 * running the whole command against the test runner's argv.
 *
 * ⚠️ **THE OVERRIDE FLAGS TAKE A VALUE, AND EACH APPEARS AT MOST ONCE.** A flag with no value, or given twice,
 * is a refusal: the second would silently decide which model a billable run uses.
 *
 * @param {string[]} argv  the arguments after the script name
 * @returns {{selfHost: boolean, override: {provider?: string, model?: string, thinking?: string}} | {error: string}}
 */
export const OVERRIDE_FLAGS = Object.freeze({ "--provider": "provider", "--model": "model", "--thinking": "thinking" });

export function parseArgs(argv) {
  const out = { selfHost: false, override: {} };
  const usage = "This command takes --self-host, and --provider <id> --model <id> --thinking <level> for a one-run override.";
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--self-host") {
      out.selfHost = true;
      continue;
    }
    const key = Object.hasOwn(OVERRIDE_FLAGS, arg) ? OVERRIDE_FLAGS[arg] : null;
    if (!key) return { error: `Unrecognised argument: ${arg}\n${usage}` };
    const value = argv[i + 1];
    if (typeof value !== "string" || value.length === 0 || value.startsWith("--")) return { error: `${arg} needs a value.\n${usage}` };
    if (key in out.override) return { error: `${arg} was given more than once.\n${usage}` };
    out.override[key] = value;
    i++;
  }
  return out;
}

/**
 * The flag Pi reads an allowlist from, and the alias that means the same thing.
 *
 * ⚠️ **THE ALIAS IS LISTED BECAUSE PI ACCEPTS IT.** `dist/cli/args.js` matches `--tools` or `-t` and
 * takes the NEXT argument, comma separated. An argument list already carrying either has a tool
 * policy in it, whichever spelling was used, and `--tools=…` is worse than a conflict: Pi does not
 * match that form at all, so it reads as a policy and is silently nothing.
 */
export const TOOLS_FLAG = "--tools";
export const TOOLS_FLAG_SPELLINGS = ["--tools", "-t"];

/**
 * Pi launched with exactly the tools this package declares, and no others.
 *
 * ⚠️ **AN ALLOWLIST, NOT A DENYLIST.** `--exclude-tools` would need this file to know every built-in
 * Pi has, today and after the next upgrade; naming what may run needs it to know only what Kiln
 * offers. `bash`, `edit`, `write` and the rest are absent because nothing put them in, which is the
 * one form of absence an upgrade cannot undo.
 *
 * ⚠️ **THE NAMES ARE THE VALIDATED DECLARATION'S**, handed in rather than written here. This file
 * says what runs; what Kiln offers is the package's to state, and it has just been checked against
 * what registration produces.
 *
 * ⚠️ **AN ARGUMENT LIST THAT ALREADY NAMES TOOLS IS A REFUSAL, NOT AN APPEND** — the same rule
 * `withSessionDir` applies to the transcript location and for the same reason. Two tool policies in
 * one command line leave the boundary to whichever Pi prefers, and this one exists to be stated.
 * The pinned agent's own argument list is one entry point path, so reaching this is a programming
 * error or a changed pin rather than something an operator can do. It refuses anyway.
 *
 * @param {{command: string, args: string[]}} agent
 * @param {string[]} tools
 */
export function withToolAllowlist(agent, tools) {
  const args = agent.args ?? [];

  if (!Array.isArray(tools) || tools.length === 0)
    throw new SupervisorRefusal(
      REFUSAL.TOOL_ALLOWLIST_MISSING,
      `No tool allowlist was resolved, so Pi would start with its built-in tools active. Refusing ` +
        `rather than handing the operator's terminal an agent whose boundary nobody stated.`,
      { tools: tools ?? null }
    );

  // ⚠️ A COMMA INSIDE A NAME IS TWO NAMES BY THE TIME PI READS IT, and an empty one is a name that
  // matches nothing. Either would make the list Kiln passed and the list Pi applied different lists.
  const malformed = tools.filter((name) => typeof name !== "string" || name.trim().length === 0 || /[,\s]/.test(name));
  if (malformed.length > 0)
    throw new SupervisorRefusal(
      REFUSAL.TOOL_ALLOWLIST_MISSING,
      `A tool name in the allowlist would not survive the command line: Pi splits this argument on ` +
        `commas, so a name containing one or made only of spaces is not the name that was declared.`,
      { malformed }
    );

  const conflict = args.findIndex(
    (a) => TOOLS_FLAG_SPELLINGS.includes(String(a)) || TOOLS_FLAG_SPELLINGS.some((f) => String(a).startsWith(`${f}=`))
  );
  if (conflict !== -1)
    throw new SupervisorRefusal(
      REFUSAL.TOOL_ALLOWLIST_CONFLICT,
      `The agent's argument list already names a tool policy at position ${conflict}, and this command ` +
        `must supply it: two of them leave the boundary to whichever Pi prefers, and the point of ` +
        `naming the tools is that Kiln can say what the agent may do.`,
      { args, tools }
    );

  return { ...agent, args: [...args, TOOLS_FLAG, tools.join(",")] };
}

/**
 * The allowlist for this checkout: the package's declared tools, validated first.
 *
 * ⚠️ **VALIDATION IS THE POINT, NOT A PRECAUTION.** `declaredToolNames` refuses when the declaration
 * and the registration disagree, so a name reaching the command line is one the package proved it
 * registers. Reading `signature.json` directly would put an unregistered name in front of a model.
 */
export async function piToolAllowlist(toolRoot = TOOL_ROOT) {
  return declaredToolNames({ packageRoot: packageRootFor(toolRoot) });
}

/** Pi's own flags for the model it runs. */
export const SELECTION_FLAGS = Object.freeze(["--provider", "--model", "--thinking"]);

/**
 * Pi held to the selection the launch checks passed.
 *
 * ⚠️ **AN ARGUMENT LIST THAT ALREADY NAMES A MODEL IS A REFUSAL**, for the reason `withToolAllowlist` refuses a
 * second tool policy: two selections leave the choice of a billable model to whichever Pi reads last.
 */
export function withSelection(agent, selection) {
  const args = agent.args ?? [];
  const conflict = args.findIndex((a) => SELECTION_FLAGS.includes(String(a)) || SELECTION_FLAGS.some((f) => String(a).startsWith(`${f}=`)));
  if (conflict !== -1)
    throw new SupervisorRefusal(
      REFUSAL.MODEL_SELECTION_CONFLICT,
      `The agent's argument list already names a model at position ${conflict}, and this command must supply the one the launch checks passed.`,
      { args }
    );
  for (const [name, value] of [["provider", selection?.provider], ["model", selection?.model], ["thinkingLevel", selection?.thinkingLevel]])
    if (typeof value !== "string" || value.length === 0 || value.startsWith("-"))
      throw new SupervisorRefusal(REFUSAL.MODEL_SELECTION_MISSING, `The checked selection has no usable ${name}, so Pi cannot be held to it.`, { name });
  return { ...agent, args: [...args, "--provider", selection.provider, "--model", selection.model, "--thinking", selection.thinkingLevel] };
}

/**
 * The live canary for a one-run proof, over the Pi agent directory the launch checks resolved.
 *
 * ⚠️ **ONLY THE SELECTED PROVIDER'S STORED ENTRY IS COPIED**, by the canary's own isolation, and only when the
 * store exists. The environment is this process's, scoped by the canary to the provider's contract.
 */
export function liveCanaryRunner() {
  // ⚠️ A CUSTOM PROVIDER ARRIVES WITH ITS DECLARATION AND ITS NON-CREDENTIAL CONFIGURATION (TSK-0072), both from the checks.
  return ({ selection, agentDir, declared, custom = null, customProviderConfig = null }) => {
    const storedAuthPath = join(agentDir, "auth.json");
    return runLiveCanary({
      ...selection,
      storedAuthPath: existsSync(storedAuthPath) ? storedAuthPath : null,
      hostEnv: process.env,
      declared,
      ...(custom ? { custom, customProviderConfig } : {}),
    });
  };
}

/**
 * @param {string[]} argv  the arguments after the script name
 * @param {{runSupervisor?: Function}} [deps]  ⚠️ **THE ONE SEAM, AND IT NAMES NO PROGRAM.** Which
 *   launcher and which agent run are still resolved here and here only; this replaces the supervisor
 *   with a recorder so that what this file builds can be read back. Without it the tool allowlist
 *   could only be checked by testing the helper that composes it, which is not the same claim as the
 *   command applying it. It is reachable from neither an argument nor an environment variable.
 */
export async function main(argv = process.argv.slice(2), { runSupervisor: supervise = runSupervisor, checkLaunch = checkLaunchDefault } = {}) {
  const args = parseArgs(argv);
  if (args.error) {
    for (const line of args.error.split("\n")) console.error(`[kiln] ${line}`);
    process.exit(2);
  }

  // ⚠️ **BEFORE THE PROJECT ROOT IS RESOLVED, BECAUSE WITH THE FLAG AND NO OVERRIDE IT CANNOT BE.**
  // The project root is `dirname(contentRoot)`, and `--self-host` with no `PLANNING_CONTENT_DIR` has
  // no content root to take the dirname of — so this line used to be the first one to run and the
  // operator got "no planning content root", a refusal about a rule they were trying to override,
  // with a hint that does not mention the flag they typed. The half of the opt-in that depends only
  // on the flag and the environment is decided here; `runSupervisor` re-checks it with the roots.
  assertSelfHostOptIn({ toolRoot: TOOL_ROOT, selfHost: args.selfHost });

  const projectRoot = canonicalPath(resolveProjectRoot());
  const interactive = Boolean(process.stdin.isTTY);

  // ⚠️ **THE LAUNCH CHECKS, BEFORE ANY PROCESS STARTS, AND BEFORE PI IS EVEN LOADED.** Consent is checked before any
  // credential is read, and a refusal leaves nothing to stop. Pi's agent directory is not resolved here: resolving
  // it loads Pi's SDK, and loading that enumerates the environment, which is access this host has not yet allowed.
  // The checks ask Pi for it only after consent. A run that cannot ask gets no `ask`, so anything needing an
  // answer refuses.
  const checked = await checkLaunch({
    projectRoot,
    location: consentLocation({ projectRoot }),
    override: args.override,
    /**
     * ⚠️ **THE PROJECT'S OWN DECLARATIONS, BECAUSE THE KEY IS RECOMPUTED HERE TOO.** A model whose endpoint
     * cannot be canonicalised, or whose request depends on values Kiln may not persist, has no compatibility key
     * without the non-secret identities the operator declared to setup (D22). Recomputing without them produces a
     * different key, so the record setup wrote would not match and a proved project would refuse to start.
     */
    declared: committedDeclarations(projectRoot),
    ...(interactive ? { ask } : {}),
    canary: liveCanaryRunner(),
  });
  const agentDir = await resolvePinnedAgentDir(TOOL_ROOT);
  say(
    `launch checks passed for ${checked.selection.provider} ${checked.selection.model} (thinking ${checked.selection.thinkingLevel})` +
      `${checked.overridden ? ", one-run override" : ""}; compatibility proved by ${checked.proof === "record" ? "this computer's record" : "this run's live check"}`
  );

  const result = await supervise({
    projectRoot,
    // ⚠️ **THE TOOL ROOT IS PASSED RATHER THAN LEFT TO THE SUPERVISOR'S DEFAULT.** This file already
    // resolved it canonically to pick the launcher and the agent out of THIS checkout, and the
    // self-host gate asks whether the project root is that same directory. Two derivations of "which
    // checkout is running" can differ under a symlinked clone, and the one that decides whether `.pi/`
    // may be written here should be the one that decided which programs run.
    toolRoot: TOOL_ROOT,
    selfHost: args.selfHost,
    // ⚠️ Both commands are `process.execPath` plus a script resolved from THIS checkout, so neither
    // depends on PATH and neither is a shell string that could be re-parsed.
    launcher: { command: process.execPath, args: [join(TOOL_ROOT, "bin", "start-shell.mjs")], cwd: TOOL_ROOT },
    // ⚠️ Resolved from the installed package's OWN `bin.pi` declaration, with its name and
    // version checked against this checkout's pin and the path contained inside the package.
    // Guessing an entry point is how you run a different file than the one `pi` would.
    // ⚠️ **THE ALLOWLIST IS PART OF WHAT RUNS, WHICH IS THIS FILE'S JOB.** The supervisor takes a
    // command and an argument array because the choice of program is the security boundary; the
    // choice of what that program may do is the same boundary, so it is made in the same place and
    // not left to a default inside the supervisor.
    agent: withSelection(withToolAllowlist(resolvePinnedAgent(TOOL_ROOT), await piToolAllowlist(TOOL_ROOT)), checked.selection),
    // ⚠️ **ASKED OF PI, ONCE, IN THIS PROCESS.** `getAgentDir()` reads this process's environment and
    // expands a leading `~`; resolving it here and handing the answer to the supervisor means the store
    // the trust gate reads and the store the child consults are one directory, without Kiln restating
    // another tool's home-directory rules. The supervisor forces it into every child's environment.
    agentDir,
    // ⚠️ **PI'S OWN LISTER, FOR THE SAME REASON THE COMMAND RESOLVES THE AGENT (F121).** Which sessions
    // exist, and what each one's id is, are Pi's facts: the id lives in a session file's header and is a
    // different value from the uuid in its filename. Kiln asks the pinned package rather than reading
    // names off disk, and it is resolved here because `lib/pi-runtime.mjs` imports the supervisor's
    // refusal types — the supervisor reaching back for it would close that circle at load time.
    sessionLister: await resolvePinnedSessionLister(TOOL_ROOT),
    spawn,
    randomBytes,
    interactive,
    // ⚠️ BOTH ENDS, BECAUSE THAT IS PI'S OWN TEST: with either one not a terminal it runs in print mode.
    startPrompt: Boolean(process.stdin.isTTY && process.stdout.isTTY),
    // F130 mechanism 2, PROTOTYPE and opt-in: on Windows, KILN_WINDOWS_JOB_HOST=1 starts the agent and the launcher, each inside a job its host
    // holds. Unset, nothing changes.
    agentJob: process.platform === "win32" && process.env.KILN_WINDOWS_JOB_HOST === "1" ? startInJob : null,
    launcherJob: process.platform === "win32" && process.env.KILN_WINDOWS_JOB_HOST === "1" ? startInJob : null,
    ask,
    askLine,
    log: say,
  });

  say(stoppedSummary(result));
  process.exit(exitStatusFor(result));
}

/**
 * ⚠️ **THE SAME GUARD `bin/init-project.mjs` CARRIES, AND FOR THE SAME REASON.** This file now exports
 * the two decisions it makes, and without the guard importing it to test them would run the whole
 * command against the TEST RUNNER's argv — starting a launcher and handing something the terminal.
 * The exports are the reason the guard exists.
 */
// ⚠️ Real paths on both sides, so a command run through a linked `.planning` runs (TSK-0074).
const isEntryPoint = isModuleEntryPoint(import.meta.url);

/**
 * How a failed run ends: a refusal prints as one, anything else as the error it is.
 *
 * ⚠️ EXPORTED SO THE CAPTURE FIXTURE ENDS THE WAY THE COMMAND DOES. A refusal the fixture could only report as an
 * unhandled rejection would test a different exit from the one an operator sees.
 */
export function exitOnFailure(e) {
  // ⚠️ **BOTH REFUSALS PRINT AS REFUSALS, NOT AS STACK TRACES.** A missing content root is the FIRST
  // thing a contributor meets running this in the Kiln repository, which is its own consumer and so
  // is not covered by the sibling rule (#70). Letting it fall through to the generic handler printed
  // an unhandled error object for a condition with a one-line fix.
  if (e instanceof ContentRootError || e instanceof SupervisorRefusal || e instanceof LaunchRefusal || e instanceof LocalStateRefusal) {
    for (const line of e.message.split("\n")) console.error(`[kiln] ${line}`);
    if (e instanceof ContentRootError) {
      console.error(`[kiln]`);
      console.error(`[kiln] If this is the Kiln repository itself, name its content directory explicitly:`);
      console.error(`[kiln]   PowerShell   $env:PLANNING_CONTENT_DIR = (Resolve-Path .\\planning-content).Path`);
      console.error(`[kiln]   sh           PLANNING_CONTENT_DIR="$PWD/planning-content" node .planning/bin/start-kiln.mjs`);
    }
    process.exit(2);
  }
  console.error(e);
  process.exit(1);
}

if (isEntryPoint) main().catch(exitOnFailure);
