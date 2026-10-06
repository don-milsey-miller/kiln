#!/usr/bin/env node
/**
 * The real `bin/setup.mjs` for a pseudo-terminal, with its own prompts left in place - #175.
 *
 * ⚠️ **NO `ask` AND NO `print` ARE SUPPLIED.** `capture-setup.mjs` scripts the operator's answers, which replaces
 * the interactive renderer with an adapter. This fixture exists for the opposite case: the command chooses its
 * renderer from the terminal it is given, and the test types into it.
 *
 * ⚠️ **ONLY NPM AND THE BILLABLE CHECK ARE REPLACED**, as in every other setup fixture: a test may not install a
 * dependency graph or send a provider a request. The network is replaced with functions that record and throw,
 * and the count is printed at exit, so "no network access" is observed rather than assumed.
 */

import { writeSync } from "node:fs";

import { recordAccess } from "../../helpers/access-recorder.mjs";

// A precondition, and why this file is harmless to `node --test`, which executes every file under `test/`.
if (!process.env.KILN_PTY_SETUP) process.exit(0);

const spec = JSON.parse(process.env.KILN_PTY_SETUP);
const rec = recordAccess({ root: spec.agentDir, names: [], env: { ...process.env }, basenames: [] });

// ⚠️ **THE PROCESS ID, SO A TEST CAN INTERRUPT THIS PROCESS ITSELF.** Killing through the pseudo-terminal makes
// node-pty enumerate the console's processes on Windows, and its helper throws `AttachConsole failed` once the
// console is going away. A test that means "the run died here" ends this process by id instead.
writeSync(1, `KILN_PTY_PID ${process.pid}\n`);

process.on("exit", (code) => writeSync(1, `\nKILN_PTY_NET ${rec.net.length}\nKILN_PTY_EXIT ${code}\n`));

const { main } = await import("../../../bin/setup.mjs");

// ⚠️ **THIS COMPUTER'S CREDENTIALS ARE NOT THE TEST'S.** The connections step asks the operating system's vault and
// the environment whether a key exists, and offers different choices when one does. With no vault and no
// credential-shaped variable, every host is asked the same questions and nobody's stored key is read.
const CREDENTIAL_SHAPED = /(API_?KEY|ACCESS_?KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL|_AUTH)/i;
const connectionEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) => !CREDENTIAL_SHAPED.test(name)));

const code = await main(spec.argv, {
  secureStore: Object.freeze({ available: false }),
  connectionEnv,
  install: () => ({ installed: false, why: "the fixture's bootstrap" }),
  canary: async ({ selection, declared = {}, preflight }) => {
    const { computeCompatibilityKey, OBSERVED_KEY_FIELDS } = await import("../../../lib/compatibility-record.mjs");
    const key = computeCompatibilityKey({ selection, model: preflight.model, piVersion: preflight.piVersion, declared, effectiveBaseUrl: preflight.effectiveBaseUrl });
    return {
      passed: true,
      challengeEchoed: true,
      observed: Object.fromEntries(OBSERVED_KEY_FIELDS.map((f) => [f, key[f]])),
      requests: [{ ...key.endpointIdentity, pathname: `${key.endpointIdentity.pathname}/responses` }],
    };
  },
});

process.exit(code);
