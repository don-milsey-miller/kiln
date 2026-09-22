/**
 * Permission-gated connection inspection — TSK-0033, CMP-0027, against ACC-0052 and ACC-0053.
 *
 * ⚠️ **ASK FIRST, AND A DECLINE READS NOTHING.** Every access this module makes happens after the
 * operator answers the prompt with an explicit yes: the load of Pi's pinned SDK, the construction of
 * its model runtime, and the research-credential presence check. Pi itself reads its authentication
 * store, its custom-model file and the provider credential variables while computing availability,
 * so those reads happen after consent too, and Kiln adds no separate per-variable check. Importing
 * this module reads nothing. Any other answer is a decline,
 * and a declined inspection performs none of them. The result then says the connections were NOT
 * INSPECTED, never that nothing is configured, so setup is honestly partial.
 *
 * ⚠️ **CONFIGURED AUTHENTICATION IS NOT A WORKING REQUEST.** A listed model is one Pi finds with
 * configured authentication. Nothing here shows a request to it would succeed.
 *
 * ⚠️ **AVAILABILITY, NOT STATUS.** Models come from `getAvailable()` and each is confirmed with
 * `hasConfiguredAuth()`. `getProviderAuthStatus()` can report a provider configured whose models the
 * registry will not use (measured in the Pi compatibility spike), so it is never read as readiness.
 * `getAll()` is the whole built-in catalogue and is never presented.
 *
 * ⚠️ **NOTHING IS CONTACTED.** The runtime is created with `allowModelNetwork: false`, and no probe,
 * refresh or request is made.
 *
 * ⚠️ **THE RESULT CARRIES NAMES, IDENTIFIERS AND ONE PRESENCE BIT.** Provider display names, exact
 * model identifiers, and present-or-absent for the research credential. No key, token, header,
 * environment value or anything derived from a credential is read into it.
 *
 * Persisting the grant is `inspectWithConsent`'s, through the host consent record (TSK-0034). Placing
 * this step in setup is TSK-0060's.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { GRANT, obtainGrant } from "./consent-record.mjs";
import { resolvePinnedSdk } from "./pi-runtime.mjs";
import { TAVILY } from "./research/tavily-adapter.mjs";

const TOOL_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * ⚠️ THE WORDING IS PART OF THE COMPONENT (CMP-0027). It says what happens. "Search for credentials"
 * describes the same act in a way that is more alarming and less accurate, since nothing is shown or
 * copied.
 */
export const INSPECTION_PROMPT =
  "Check this computer for existing AI-provider and web-research connections? " +
  "Kiln will list provider names and models Pi finds with configured authentication, plus whether " +
  "a web-research key is present. It will not show credential values or contact a service.";

/** The research credential, by name only. */
export const RESEARCH_CREDENTIAL = TAVILY.envVar;

export const INSPECTION = Object.freeze({
  GRANTED: "granted",
  DECLINED: "declined",
});

/**
 * The accesses a granted inspection makes, each named so a caller can observe them. The defaults are
 * the real ones. A test replaces none of them to observe the real reads, and may wrap them to record.
 */
export const defaultAccess = Object.freeze({
  /** Load the pinned Pi SDK. Nothing is read from Pi's state by loading it. */
  loadSdk: async () => import(resolvePinnedSdk(TOOL_ROOT).url),
  /**
   * Is the research credential present? Presence only: the value is never returned.
   *
   * ⚠️ `process.env`, THE SAME ENVIRONMENT PI READS. Pi reads the provider variables from
   * `process.env` while computing availability, so a research check against any other object would
   * report on a different environment from the rest of the result.
   */
  researchPresent: () => typeof process.env[RESEARCH_CREDENTIAL] === "string" && process.env[RESEARCH_CREDENTIAL].length > 0,
});

/**
 * Ask, and inspect only on an explicit yes.
 *
 * @param {object} options
 * @param {(prompt: string) => Promise<unknown>|unknown} options.ask  the operator's answer; only `true` grants
 * @param {string} [options.agentDir]  Pi's agent directory; asked of the pinned package when omitted
 * @param {object} [options.access]  the access points, for observation
 */
export async function inspectConnections({ ask, agentDir, access = defaultAccess } = {}) {
  if (typeof ask !== "function") throw new TypeError("inspectConnections needs an `ask` function");

  const answer = await ask(INSPECTION_PROMPT);
  // ⚠️ ONLY AN EXPLICIT YES. A string, a truthy object or a missing answer is not consent.
  if (answer !== true) {
    return {
      decision: INSPECTION.DECLINED,
      inspected: false,
      connections: "not-inspected",
      researchCredential: "not-inspected",
      summary:
        "Connections were not checked. Setup continues without them, and providers and the " +
        "web-research key are unknown, not absent.",
    };
  }

  const sdk = await access.loadSdk();
  const root = agentDir ?? sdk.getAgentDir();
  const runtime = await sdk.ModelRuntime.create({
    authPath: join(root, "auth.json"),
    modelsPath: join(root, "models.json"),
    allowModelNetwork: false,
  });
  const registry = new sdk.ModelRegistry(runtime);

  const byProvider = new Map();
  for (const model of registry.getAvailable()) {
    if (!registry.hasConfiguredAuth(model)) continue;
    if (!byProvider.has(model.provider)) byProvider.set(model.provider, new Set());
    byProvider.get(model.provider).add(model.id);
  }

  const providers = [...byProvider.entries()]
    .map(([provider, ids]) => ({
      provider,
      displayName: registry.getProviderDisplayName(provider) ?? provider,
      models: [...ids].sort(),
    }))
    .sort((a, b) => a.displayName.localeCompare(b.displayName));

  return {
    decision: INSPECTION.GRANTED,
    inspected: true,
    providers,
    researchCredential: access.researchPresent() ? "present" : "absent",
    summary:
      providers.length === 0
        ? "Pi found no provider with configured authentication on this computer."
        : `Pi found ${providers.length} provider(s) with configured authentication on this computer.`,
  };
}

/**
 * Inspect under the host consent record: a recorded answer is reused, and only a host with no answer
 * is asked. The answer is recorded before anything is inspected.
 *
 * @param {object} options
 * @param {object} options.location  from `consentLocation`
 * @param {(prompt: string) => Promise<unknown>|unknown} options.ask
 * @param {string} [options.agentDir]
 * @param {object} [options.access]
 * @param {() => Date} [options.now]
 */
export async function inspectWithConsent({ location, ask, agentDir, access, now } = {}) {
  const consent = await obtainGrant(location, { grant: GRANT.INSPECTION, ask, prompt: INSPECTION_PROMPT, now });
  const result = await inspectConnections({ agentDir, access, ask: () => consent.granted });
  return { ...result, consent };
}
