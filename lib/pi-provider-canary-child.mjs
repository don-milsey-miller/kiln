/**
 * The provider canary's child — TSK-0040, against ACC-0104. Spawned only by `lib/pi-provider-canary.mjs`.
 *
 * It imports the pinned Pi SDK, builds a `ModelRuntime` over the isolated agent directory it was given,
 * and answers one question: is this exact provider and model available, and which source does Pi say
 * authenticates it. It prints three facts and nothing else.
 *
 * ⚠️ **NO AGENT SESSION, NO TOOLS, NO NETWORK.** Nothing here constructs a session, so Pi's default tools
 * — `bash`, `edit` and `write` among them — never exist in this process. `allowModelNetwork: false` keeps
 * the catalogue offline. What runs is catalogue and credential resolution, which is the whole of what
 * the canary is for.
 *
 * ⚠️ **THE STATUS `label` IS NEVER READ INTO OUTPUT.** `getProviderAuthStatus()` attaches a `label` to an
 * `environment` source, built from `getConfigValueEnvVarNames()` — variable NAMES. Only `configured` and
 * `source` are taken, by name, so a report cannot leak what it never copied.
 *
 * ⚠️ **ON ANY FAILURE IT EXITS NON-ZERO AND PRINTS NOTHING.** An error from the SDK can carry a path or
 * a configuration value, and stderr reaches the same logs a report does. The parent classifies a failed
 * child from its exit status alone.
 *
 * argv: exactly `<sdkUrl> <provider> <model>`. Credentials never arrive here by argv; the SDK reads them
 * from the isolated agent directory named by `PI_CODING_AGENT_DIR` and from the environment `childEnv`
 * built.
 */

import { join } from "node:path";

const EXIT_FAILED = 3;

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 3) return EXIT_FAILED;
  const [sdkUrl, provider, model] = args;

  const agentDir = process.env.PI_CODING_AGENT_DIR;
  if (typeof agentDir !== "string" || agentDir.length === 0) return EXIT_FAILED;

  const { ModelRuntime, ModelRegistry } = await import(sdkUrl);
  const runtime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: join(agentDir, "models.json"),
    allowModelNetwork: false,
  });
  const registry = new ModelRegistry(runtime);

  // ⚠️ BOTH IDS, EXACTLY. `claude-fable` is not `claude-fable-5`, and a real model id under the wrong
  // provider is not that model. A prefix or fuzzy match here would report a model the run cannot select.
  const available = registry.getAvailable().some((m) => m.provider === provider && m.id === model);

  const status = registry.getProviderAuthStatus(provider);
  const configured = status?.configured === true;
  const piSource = configured && typeof status.source === "string" ? status.source : null;

  process.stdout.write(JSON.stringify({ available, configured, piSource }));
  return 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  () => {
    process.exitCode = EXIT_FAILED;
  }
);
