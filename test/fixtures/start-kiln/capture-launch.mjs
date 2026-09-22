#!/usr/bin/env node
/**
 * The real `bin/start-kiln.mjs`, run with its supervisor replaced by a recorder.
 *
 * ⚠️ **THE COMMAND IS WHAT RUNS HERE, NOT A COPY OF ITS DECISIONS.** `main()` parses the argument
 * list, resolves the tool root, resolves the pinned agent from the installed package's own manifest,
 * validates the Kiln package and composes the agent's argument array. All of that happens; only the
 * supervisor is swapped, because the alternative to swapping it is attaching a terminal to Pi.
 *
 * ⚠️ **THE LAUNCH CHECKS ARE RECORDED TOO, OR RUN FOR REAL.** With `KILN_CAPTURE_REAL_CHECKS` the command's own
 * `checkLaunch` runs; otherwise a recorder prints what the command handed it and answers with a checked
 * selection, or, with `KILN_CAPTURE_REFUSE`, refuses as a launch check would.
 *
 * ⚠️ **IN A CHILD, BECAUSE `main()` ENDS IN `process.exit`.** That is the command's own contract and
 * not something to work around; it is simply the reason this is a separate process that prints one
 * line and goes.
 */

import { exitOnFailure, main } from "../../../bin/start-kiln.mjs";
import { writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordAccess } from "../../helpers/access-recorder.mjs";
import { LAUNCH_REFUSAL, LaunchRefusal } from "../../../lib/launch-checks.mjs";

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

/**
 * ⚠️ WITH `KILN_CAPTURE_ACCESS`, EVERY CREDENTIAL ACCESS IS COUNTED FROM BEFORE `main()` RUNS. Pi's authentication
 * store and custom-model file are watched by name wherever they are, the credential variables by name, and the
 * network by refusal. The counts are written when the process exits, whether it launched or refused, straight
 * to the file descriptor so an exit in progress cannot drop them.
 */
if (process.env.KILN_CAPTURE_ACCESS) {
  const rec = recordAccess({
    root: join(tmpdir(), "kiln-capture-no-such-root"),
    names: ["OPENAI_API_KEY", "ANTHROPIC_API_KEY"],
    env: { ...process.env },
    basenames: ["auth.json", "models.json"],
  });
  process.on("exit", () => writeSync(1, `
KILN_ACCESS ${JSON.stringify({ fs: rec.fs.length, env: rec.env.length, net: rec.net.length, first: [...rec.fs, ...rec.env].slice(0, 3) })}
`));
}

const recordedChecks = async (opts) => {
  console.log(
    `KILN_CHECK ${JSON.stringify({
      projectRoot: typeof opts.projectRoot,
      location: typeof opts.location?.path,
      agentDir: typeof opts.agentDir,
      override: opts.override,
      ask: typeof opts.ask,
      canary: typeof opts.canary,
    })}`
  );
  if (process.env.KILN_CAPTURE_REFUSE)
    throw new LaunchRefusal(LAUNCH_REFUSAL.MODEL_NOT_FOUND, "The recorded model fixture fixture-model is not in Pi's model registry on this computer.", {
      provider: "fixture",
      model: "fixture-model",
    });
  return { selection: { provider: "fixture", model: "fixture-model", thinkingLevel: "off" }, overridden: false, proof: "record", tools: [] };
};

await main(process.argv.slice(2), {
  ...(process.env.KILN_CAPTURE_REAL_CHECKS ? {} : { checkLaunch: recordedChecks }),
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
}).catch(exitOnFailure);
