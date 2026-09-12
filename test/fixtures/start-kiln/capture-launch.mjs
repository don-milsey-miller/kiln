#!/usr/bin/env node
/**
 * The real `bin/start-kiln.mjs`, run with its supervisor replaced by a recorder.
 *
 * ⚠️ **THE COMMAND IS WHAT RUNS HERE, NOT A COPY OF ITS DECISIONS.** `main()` parses the argument
 * list, resolves the tool root, resolves the pinned agent from the installed package's own manifest,
 * validates the Kiln package and composes the agent's argument array. All of that happens; only the
 * supervisor is swapped, because the alternative to swapping it is attaching a terminal to Pi.
 *
 * ⚠️ **IN A CHILD, BECAUSE `main()` ENDS IN `process.exit`.** That is the command's own contract and
 * not something to work around; it is simply the reason this is a separate process that prints one
 * line and goes.
 */

import { main } from "../../../bin/start-kiln.mjs";

/**
 * ⚠️ **A PRECONDITION, AND ALSO WHY THIS FILE IS HARMLESS TO `node --test`.** The runner executes
 * every file under `test/`, and this one is a real program: run without a project to point at, it
 * would reach the content-root refusal and fail a suite it is not part of.
 */
if (!process.env.KILN_CAPTURE_LAUNCH) process.exit(0);

const result = {
  trigger: "agent-exit",
  agentExit: { code: 0, signal: null, observed: true },
  shutdown: {
    launcher: { sentStop: true, endRequested: true, exitObserved: true },
    launcherTree: { treeStopped: true },
  },
};

await main(process.argv.slice(2), {
  runSupervisor: async (options) => {
    console.log(
      `KILN_LAUNCH ${JSON.stringify({
        agentCommand: options.agent?.command ?? null,
        agentArgs: options.agent?.args ?? null,
        launcherCommand: options.launcher?.command ?? null,
        launcherArgs: options.launcher?.args ?? null,
        toolRoot: typeof options.toolRoot,
        agentDir: typeof options.agentDir,
        selfHost: options.selfHost ?? null,
      })}`
    );
    return result;
  },
});
