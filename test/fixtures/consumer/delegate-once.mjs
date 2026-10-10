#!/usr/bin/env node
/**
 * One delegation from inside a consumer's own clone, through the package's own wrapper - #176.
 *
 * Run with the consumer project as the working directory and its `.planning` clone named in
 * `KILN_CONSUMER_DELEGATION`. Everything is imported from that clone, never from the checkout under test's
 * working tree, so what runs is what a consumer installed.
 *
 *   1. the clone's own setup bootstrap installs its locked dependencies;
 *   2. the resolver setup's preflight uses says which agent it found;
 *   3. the clone's own modules write the project record and the model-use grant that declares the provider's
 *      credential variable, as setup does (#194);
 *   4. `register(pi)` is called with no second argument, and `kiln_delegate` is executed once.
 *
 * ⚠️ **NOTHING IS INJECTED INTO THE DELEGATION.** No resolver, no spawn, no extension. The provider is whatever
 * the isolated agent directory's `models.json` names, which the test points at a loopback fixture. Its key is in
 * this process's environment and nowhere else.
 */

import { join } from "node:path";
import { pathToFileURL } from "node:url";

// A precondition, and why this file is harmless to `node --test`, which executes every file under `test/`.
if (!process.env.KILN_CONSUMER_DELEGATION) process.exit(0);

const spec = JSON.parse(process.env.KILN_CONSUMER_DELEGATION);
const from = (...parts) => import(pathToFileURL(join(spec.toolRoot, ...parts)).href);

const setup = await from("bin", "setup.mjs");
const installed = setup.installDependencies({ toolRoot: spec.toolRoot });
// The reviewed repair setup applies next, because its bootstrap suppresses lifecycle scripts.
const { repairPiBraceExpansion } = await from("bin", "repair-pi-brace-expansion.mjs");
repairPiBraceExpansion(spec.toolRoot);

const { resolvePinnedAgent } = await from("lib", "pi-runtime.mjs");
const preflight = resolvePinnedAgent(spec.toolRoot);

// The records a custom provider's credential route is read from, and the project the supervisor would name.
const { projectForDelegation } = await from("test", "helpers", "delegation-project.mjs");
const recorded = await projectForDelegation(spec.projectRoot, { grant: { model: { provider: spec.provider, model: spec.model, credentialVar: spec.credentialVar } } });
process.env.KILN_PROJECT_ROOT = spec.projectRoot;

const { default: register } = await from("pi-package", "extensions", "kiln.js");
const tools = [];
register({ registerTool: (tool) => tools.push(tool), getAllTools: () => tools.map((tool) => ({ name: tool.name })) });
const delegate = tools.find((tool) => tool.name === "kiln_delegate");

const result = await delegate.execute("call-1", { role: spec.role, task: spec.task }, undefined, undefined, {
  model: { provider: spec.provider, id: spec.model },
  thinkingLevel: "off",
});

process.stdout.write(
  `\nKILN_CONSUMER_RESULT ${JSON.stringify({ installed: installed.installed === true, preflightVersion: preflight.version, grantWritten: recorded.grantWritten, result: result.details })}\n`
);
process.exit(0);
