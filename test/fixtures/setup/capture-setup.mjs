#!/usr/bin/env node
/**
 * The real `bin/setup.mjs`, run in a child with every credential access counted from before it starts.
 *
 * ⚠️ **THE COMMAND IS WHAT RUNS HERE.** Only npm and the operator's answers are supplied: the install is a seam
 * because spawning npm would install a dependency graph per case, and the answers are a scripted list because
 * there is nobody at a terminal. Everything else — the paths, the lock, the transaction, the trust store, Pi's own
 * loader — is the command's.
 *
 * ⚠️ **IN A CHILD, BECAUSE THE RECORDER REPLACES `process.env`, `fs` AND THE NETWORK.** Doing that inside the test
 * runner would wrap the runner's own reads for the rest of the file. Here the process exists to be thrown away.
 *
 * ⚠️ **THE COUNTS ARE WRITTEN AT EXIT, whether the run completed or refused**, straight to the file descriptor, so
 * an exit in progress cannot drop them.
 */

import { writeSync } from "node:fs";

import { recordAccess } from "../../helpers/access-recorder.mjs";

/**
 * ⚠️ **A PRECONDITION, AND ALSO WHY THIS FILE IS HARMLESS TO `node --test`.** The runner executes every file under
 * `test/`, and this one is a real program: run without a project to point at, it would refuse and fail a suite it
 * is not part of.
 */
if (!process.env.KILN_CAPTURE_SETUP) process.exit(0);

const spec = JSON.parse(process.env.KILN_CAPTURE_SETUP);

/**
 * ⚠️ **WATCHED BY NAME WHEREVER THEY ARE.** Pi's authentication store and custom-model registry are the files the
 * inspection consent gates, and they live in the agent directory, not in the project; the credential variables are
 * watched by name, and the network by refusal. What the recorder must be able to say is "nothing of this was
 * touched before the operator allowed it".
 */
const rec = recordAccess({
  root: spec.agentDir,
  names: ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "TAVILY_API_KEY"],
  env: { ...process.env },
  basenames: ["auth.json", "models.json"],
});

/**
 * Answers by the question they answer, and every question recorded in the same stream, so "before the answer" is
 * a position rather than a guess.
 *
 * ⚠️ **BY PROMPT, NOT BY POSITION.** Which questions a run asks depends on the project it is given — an already
 * ignored project is never asked about coverage — so a queue consumed in order would hand an answer to whichever
 * question happened to come first.
 */
const answers = (spec.answers ?? []).map(([pattern, answer]) => [new RegExp(pattern, "i"), answer]);
const asked = [];

process.on("exit", () =>
  writeSync(
    1,
    `\nKILN_ACCESS ${JSON.stringify({ fs: rec.fs, env: rec.env, net: rec.net, asked, printed })}\n`
  )
);

const { main } = await import("../../../bin/setup.mjs");

/** What was printed, with the access counts as they stood — so "printed before anything was written" is a fact. */
const printed = [];

const code = await main(spec.argv, {
  print: (line) => {
    // ⚠️ WRITES, NOT READS. Setup reads a great deal before it changes anything; what a path printed "before
    // anything is mutated" has to beat is the first write, so this counts only calls that can change a project.
    const writes = rec.fs.filter((event) => /^fs\.(write|append|mkdir|rename|rm|unlink|copy|truncate|chmod)/.test(event)).length;
    printed.push({ line, writes });
    writeSync(1, `${line}\n`);
  },
  ask: async (question) => {
    // ⚠️ THE QUESTION IS RECORDED WITH THE ACCESS COUNTS AS THEY STOOD WHEN IT WAS ASKED, which is what makes
    // "nothing was read before consent" an assertion about order rather than about totals.
    asked.push({ question, before: { fs: rec.fs.length, env: rec.env.length, net: rec.net.length } });
    for (const [pattern, answer] of answers) if (pattern.test(question)) return answer;
    return null;
  },
  install: () => ({ installed: false, why: "the fixture's bootstrap" }),
  // ⚠️ **THE ONE STEP THAT WOULD COST MONEY, ANSWERED HERE.** The canary sends a request to the selected provider;
  // this returns what a passing check would have observed, derived from what the command itself resolved, so a
  // recorded run can complete without anything leaving this machine.
  canary: async ({ selection, declared = {}, preflight }) => {
    const { computeCompatibilityKey, OBSERVED_KEY_FIELDS } = await import("../../../lib/compatibility-record.mjs");
    const key = computeCompatibilityKey({
      selection,
      model: preflight.model,
      piVersion: preflight.piVersion,
      declared,
      effectiveBaseUrl: preflight.effectiveBaseUrl,
    });
    return {
      passed: true,
      challengeEchoed: true,
      observed: Object.fromEntries(OBSERVED_KEY_FIELDS.map((f) => [f, key[f]])),
      requests: [{ ...key.endpointIdentity, pathname: `${key.endpointIdentity.pathname}/responses` }],
    };
  },
});

writeSync(1, `\nKILN_EXIT ${code}\n`);
process.exit(code);
