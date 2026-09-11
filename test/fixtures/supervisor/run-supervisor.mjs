#!/usr/bin/env node
/**
 * A real `runSupervisor` with stand-in children, run as its own process so it can be given a pipe
 * on fd 0 — the harness's stand-in for the operator's terminal.
 *
 * ⚠️ THE SUPERVISOR HERE IS THE PRODUCTION ONE. Only the two commands differ, which is exactly the
 * seam `bin/start-kiln.mjs` closes in production. Nothing about the routing, the readiness rule or
 * the shutdown contract is simulated.
 */
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { runSupervisor } from "../../../lib/supervisor.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
/**
 * ⚠️ **A PRECONDITION, AND ALSO WHY THIS FILE IS HARMLESS TO `node --test`.** The runner executes
 * every file under `test/`, and unlike the inert fixtures beside it this one is a real program. Run
 * without the arguments that give it somewhere to report, it has no contract to fulfil and does
 * nothing — rather than throwing on an undefined path and failing a suite it is not part of.
 */
if (process.argv.length < 4) process.exit(0);

const [, , projectRoot, agentReport, launcherReport, readyFlag, gate, port, agentDir] = process.argv;

/**
 * ⚠️ **THE PORT IS PASSED IN, BECAUSE THE DEFAULT IS 3000 AND 3000 IS SOMEBODY ELSE'S.** Leaving it
 * unset made this harness ask for the same fixed port every time — colliding with a developer's own
 * dev server, and with the other test files `node --test` runs in parallel. It surfaced once as a
 * lone failure in a full-suite run that passed on its own, which is the shape of a flake nobody
 * tracks down.
 */
if (!port) {
  console.error("[sup] no port supplied");
  process.exit(2);
}

/**
 * The Pi agent directory the trust gate reads and the children are given. Passed in, and pointing at a
 * temporary directory the harness granted trust in, so this runs the REAL gate rather than an injected
 * answer - what production does, against a store that is never the operator own.
 */
if (!agentDir) {
  console.error("[sup] no agent directory supplied");
  process.exit(2);
}

const result = await runSupervisor({
  projectRoot,
  agentDir,
  launcher: {
    command: process.execPath,
    args: [join(HERE, "adversary-launcher.mjs"), launcherReport, readyFlag],
  },
  agent: {
    command: process.execPath,
    args: [join(HERE, "agent-stand-in.mjs"), agentReport, gate],
  },
  spawn,
  randomBytes,
  env: { ...process.env, PORT: port, KILN_FAKE_BUILD: "" },
  build: null, // the adversary cannot know this checkout's version; identity is the four facts
  readyMs: 30_000,
  graceMs: 5000,
  log: (m) => console.log(`[sup] ${m}`),
});

console.log(`[sup] shutdown ${JSON.stringify(result.shutdown)}`);
process.exit(0);
