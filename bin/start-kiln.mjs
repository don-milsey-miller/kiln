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
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

import { ContentRootError, canonicalPath, resolveProjectRoot } from "../lib/content-root.mjs";
import { SupervisorRefusal, resolvePinnedAgent, runSupervisor } from "../lib/supervisor.mjs";

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

async function main() {
  const projectRoot = canonicalPath(resolveProjectRoot());

  const result = await runSupervisor({
    projectRoot,
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

  say(
    `stopped — stop sent: ${result.shutdown.sentStop}, stdin end requested: ${result.shutdown.endRequested}, ` +
      `launcher exit observed: ${result.shutdown.exitObserved}`
  );
  // ⚠️ **A SIGNAL IS NOT A CLEAN EXIT.** `code` is null when Pi was killed, and `?? 0` reported that
  // as success. Reaching this line at all already means the launcher was seen to go — an unobserved
  // shutdown is a refusal from the supervisor and leaves through the handler below.
  process.exit(result.agentExit.code ?? (result.agentExit.signal ? 1 : 0));
}

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
