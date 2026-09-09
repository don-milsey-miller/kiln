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
 */

import { randomBytes } from "node:crypto";
import { createInterface } from "node:readline";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn } from "node:child_process";

import { ContentRootError, canonicalPath, resolveProjectRoot } from "../lib/content-root.mjs";
import { SupervisorRefusal, assertSelfHostOptIn, runSupervisor } from "../lib/supervisor.mjs";
import { resolvePinnedAgent } from "../lib/pi-runtime.mjs";

const TOOL_ROOT = resolve(join(dirname(fileURLToPath(import.meta.url)), ".."));
const say = (msg) => console.log(`[kiln] ${msg}`);

const ask = (question) =>
  new Promise((resolveAnswer) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolveAnswer(/^y(es)?$/i.test(answer.trim()));
    });
  });

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
 * @param {string[]} argv  the arguments after the script name
 * @returns {{selfHost: boolean, error?: undefined} | {error: string}}
 */
export function parseArgs(argv) {
  const out = { selfHost: false };
  for (const arg of argv) {
    if (arg !== "--self-host")
      return { error: `Unrecognised argument: ${arg}\nThe only flag this command takes is --self-host.` };
    out.selfHost = true;
  }
  return out;
}

async function main(argv = process.argv.slice(2)) {
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

  const result = await runSupervisor({
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
    agent: resolvePinnedAgent(TOOL_ROOT),
    spawn,
    randomBytes,
    interactive: Boolean(process.stdin.isTTY),
    ask,
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
const isEntryPoint = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;

if (isEntryPoint)
  main().catch((e) => {
  // ⚠️ **BOTH REFUSALS PRINT AS REFUSALS, NOT AS STACK TRACES.** A missing content root is the FIRST
  // thing a contributor meets running this in the Kiln repository, which is its own consumer and so
  // is not covered by the sibling rule (#70). Letting it fall through to the generic handler printed
  // an unhandled error object for a condition with a one-line fix.
  if (e instanceof ContentRootError || e instanceof SupervisorRefusal) {
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
});
