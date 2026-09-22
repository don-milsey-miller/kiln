/**
 * The live tool-call canary's child — TSK-0041, against ACC-0061 and ACC-0062. Spawned only by
 * `lib/live-canary.mjs`, through the provider canary's isolated runner.
 *
 * It builds one Pi agent session through the pinned SDK and sends one request. What makes it bounded:
 *
 * - **one tool.** `tools: ["kiln_preflight"]` is an allowlist applied to the registry itself, so Pi's built-in
 *   tools, any extension tool and every Kiln tool are absent, not merely inactive. The preflight tool comes from
 *   `lib/preflight-tool.mjs`, which imports nothing.
 * - **no project.** The working directory is an empty directory under the canary's private root. Extensions,
 *   skills, prompt templates, themes and context files are all switched off, settings are in memory, the
 *   session is in memory, and the system prompt is the canary's own.
 * - **a low token ceiling.** Pi takes the output ceiling from the model, so the model is copied with
 *   `maxTokens` lowered to `CANARY_MAX_TOKENS`.
 * - **one call.** The session is aborted once the preflight tool has run, so no further turn is requested.
 *
 * It prints one closed JSON report, and on any failure exits non-zero printing nothing, as the provider
 * canary's child does: an error from the SDK can carry a path or a configuration value.
 *
 * argv: exactly `<sdkUrl> <provider> <model> <thinkingLevel> <challenge> <workDir>`. No credential arrives by argv.
 */

import { join } from "node:path";

import { CANARY_MAX_TOKENS, CANARY_SYSTEM_PROMPT, PREFLIGHT_TOOL_NAME, canaryPrompt, preflightToolDefinition } from "./preflight-tool.mjs";

const EXIT_FAILED = 3;

/** At most this many tool calls are reported; the predicate needs one. */
const MAX_REPORTED_CALLS = 4;
/** An argument object longer than this is reported as oversized rather than copied. */
const MAX_ARGS_CHARS = 512;

const reportable = (args) => {
  let text;
  try {
    text = JSON.stringify(args);
  } catch {
    return { oversized: true };
  }
  return typeof text === "string" && text.length <= MAX_ARGS_CHARS ? { args } : { oversized: true };
};

async function main() {
  const argv = process.argv.slice(2);
  if (argv.length !== 6) return EXIT_FAILED;
  const [sdkUrl, provider, modelId, thinkingLevel, challenge, workDir] = argv;
  const agentDir = process.env.PI_CODING_AGENT_DIR;
  if (typeof agentDir !== "string" || agentDir.length === 0) return EXIT_FAILED;

  const sdk = await import(sdkUrl);
  const runtime = await sdk.ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: join(agentDir, "models.json"),
    allowModelNetwork: false,
  });
  const registry = new sdk.ModelRegistry(runtime);
  const found = registry.find(provider, modelId);
  if (!found) {
    process.stdout.write(JSON.stringify({ model: "not-found", registeredTools: [], activeTools: [], calls: [], ceiling: null }));
    return 0;
  }
  const bounded = { ...found, maxTokens: Math.min(Number.isFinite(found.maxTokens) ? found.maxTokens : CANARY_MAX_TOKENS, CANARY_MAX_TOKENS) };

  const settingsManager = sdk.SettingsManager.inMemory({});
  const resourceLoader = new sdk.DefaultResourceLoader({
    cwd: workDir,
    agentDir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPrompt: CANARY_SYSTEM_PROMPT,
  });
  await resourceLoader.reload();

  const calls = [];
  let session = null;
  const tool = preflightToolDefinition(() => {
    // ⚠️ ONE CALL IS ALL THE CANARY ASKS FOR. Stop the loop so no further turn is requested.
    queueMicrotask(() => session?.abort().catch(() => {}));
  });

  ({ session } = await sdk.createAgentSession({
    cwd: workDir,
    agentDir,
    modelRuntime: runtime,
    model: bounded,
    thinkingLevel,
    tools: [PREFLIGHT_TOOL_NAME],
    customTools: [tool],
    resourceLoader,
    settingsManager,
    sessionManager: sdk.SessionManager.inMemory(workDir),
  }));

  // ⚠️ OBSERVED UPSTREAM OF THE TOOL, from the events Pi emits for every call the provider returned, including
  // one to a name that is not registered or with arguments that fail the schema.
  session.subscribe((event) => {
    if (event?.type === "tool_execution_start" && calls.length < MAX_REPORTED_CALLS)
      calls.push({ name: typeof event.toolName === "string" ? event.toolName : null, ...reportable(event.args) });
  });

  const registeredTools = session.getAllTools().map((t) => t.name).sort();
  const activeTools = [...session.getActiveToolNames()].sort();
  try {
    await session.prompt(canaryPrompt(challenge), { expandPromptTemplates: false });
  } catch {
    /* an aborted run rejects; what was observed is the report */
  }
  session.dispose?.();

  process.stdout.write(JSON.stringify({ model: "found", registeredTools, activeTools, calls, ceiling: bounded.maxTokens }));
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
