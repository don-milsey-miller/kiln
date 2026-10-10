/**
 * The credential route a delegated child will use, decided from trusted runtime state before anything is spawned - #194.
 *
 * `kiln_delegate` used to hand the runtime no provider contract, so `childEnv` emitted no provider variable and a
 * provider authenticated through the environment failed inside every child. This module is where the wrapper gets the
 * contract, and where a route that cannot work is refused before a child exists.
 *
 * ⚠️ **NOTHING HERE COMES FROM A TOOL ARGUMENT.** The provider and model are the session's own. A built-in provider's
 * contract is Kiln's audited table. A custom provider's contract is the variable setup recorded on this computer's
 * model-use grant, read for the project the supervisor named in `KILN_PROJECT_ROOT`, and only while that grant stands
 * for exactly this provider and model. That is the source the launch checks use.
 *
 * ⚠️ **A NAME IS ASKED FOR, NEVER LOOKED FOR.** Whether a variable is set is asked by the names the contract declares.
 * The environment is not enumerated and no value is returned, copied or compared.
 *
 * ⚠️ **STORED AUTHENTICATION IS ASKED OF PI.** `ModelRuntime.getProviderAuthStatus` answers whether the agent
 * directory's `auth.json` holds an entry for the provider. Pi reads that file into its own credential store to answer,
 * so the stored value is read by Pi's storage adapter. This module receives only `configured` and `source`: the value
 * is never returned to it, copied, logged or placed in an error.
 *
 * ⚠️ **A REFUSAL IS ONE OF A FEW FIXED WORDS.** No variable name, path, command, argument or error text is in it.
 */

import { join } from "../runtime-path.mjs";
import { CONSENT_READ, GRANT, STANDING, consentLocation, declaredCredentialVar, peekGrant } from "../consent-record.mjs";
import { RECORD, STATE_MODE, projectRecordState } from "../local-state.mjs";
import { AUTH_SOURCE, CredentialContractRefusal, UNSUPPORTED_PROVIDERS, resolveProviderCredentials } from "../pi-provider-credentials.mjs";
import { PROJECT_ROOT_ENV, STATE_MODE_ENV } from "../research/permission.mjs";
import { providerRoute } from "./contract.mjs";

/** The one code a delegation is refused under when its credential route cannot work. */
export const ROUTE_REFUSED = "credential-route-unavailable";

export const ROUTE_REASON = Object.freeze({
  /** The provider has no contract: declined by the table, or custom with no declaration recorded for it. */
  NO_CONTRACT: "no-contract",
  /** A custom provider whose use is not granted on this computer for exactly this provider and model. */
  NOT_GRANTED: "not-granted",
  /** Pi's `models.json` does not read the provider's key from the variable declared for it. */
  ROUTE_MISMATCH: "route-mismatch",
  /** An environment-only contract whose declared variable is not set. */
  VARIABLE_UNSET: "variable-unset",
  /** The environment route is incomplete or absent, and Pi reports no stored authentication for the provider. */
  STORED_UNAVAILABLE: "stored-unavailable",
  /** No project was named, or its record or this computer's consent record could not be read. */
  CONSENT_UNREADABLE: "consent-unreadable",
});

const refused = (reason) => Object.freeze({ ok: false, code: ROUTE_REFUSED, reason });

/** Whether Pi reports stored authentication for a provider in this agent directory. Never throws. */
async function storedAuthenticationPresent({ provider, agentDir, toolRoot }) {
  try {
    const { resolvePinnedSdk } = await import("../pi-runtime.mjs");
    const sdk = await import(resolvePinnedSdk(toolRoot).url);
    const runtime = await sdk.ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null, allowModelNetwork: false });
    const status = runtime.getProviderAuthStatus(provider);
    return status?.configured === true && status.source === "stored";
  } catch {
    // ⚠️ THE ERROR IS DROPPED. It can quote the file Pi was reading, and that file holds credentials.
    return false;
  }
}

/** A custom provider's declaration, from this computer's standing grant, or the reason there is none. */
async function recordedDeclaration({ provider, model, agentDir, env, validators }) {
  const projectRoot = env?.[PROJECT_ROOT_ENV];
  const stateMode = env?.[STATE_MODE_ENV] ?? STATE_MODE.PROJECT;
  if (typeof projectRoot !== "string" || projectRoot.length === 0) return { reason: ROUTE_REASON.CONSENT_UNREADABLE };
  if (stateMode !== STATE_MODE.PROJECT && stateMode !== STATE_MODE.USER) return { reason: ROUTE_REASON.CONSENT_UNREADABLE };

  let name;
  try {
    const project = projectRecordState(projectRoot, { validators });
    if (project.kind !== RECORD.VALID) return { reason: ROUTE_REASON.CONSENT_UNREADABLE };
    const location = consentLocation({ projectRoot, stateMode, projectId: project.record.projectId, env });
    const peek = peekGrant(location, GRANT.MODEL_USE, { model: { provider, model } }, { validators });
    if (peek.read !== CONSENT_READ.VALID && peek.read !== CONSENT_READ.ABSENT) return { reason: ROUTE_REASON.CONSENT_UNREADABLE };
    if (peek.standing !== STANDING.GRANTED) return { reason: ROUTE_REASON.NOT_GRANTED };
    name = declaredCredentialVar(location, { provider, model }, { validators });
  } catch {
    return { reason: ROUTE_REASON.CONSENT_UNREADABLE };
  }
  if (typeof name !== "string" || name.length === 0) return { reason: ROUTE_REASON.NO_CONTRACT };

  // ⚠️ THE DECLARED ROUTE IS PI'S ROUTE, as at launch: the variable setup was told is the one `models.json` reads.
  const { declaredRouteProblem } = await import("../launch-checks.mjs");
  if (declaredRouteProblem({ agentDir, provider, name })) return { reason: ROUTE_REASON.ROUTE_MISMATCH };
  return { custom: { id: provider, apiKey: `$${name}` } };
}

/**
 * The provider contract for this session's delegation, or the fixed reason its route is unavailable.
 *
 * @param {{provider: string, model: string, agentDir: string, toolRoot: string}} session  all from trusted context
 * @param {{env?: object, platform?: string, storedPresent?: Function, validators?: object}} [deps]  test seams
 * @returns {Promise<{ok: true, contract: object, route: "environment"|"stored"} | {ok: false, code: string, reason: string}>}
 */
export async function sessionProviderRoute({ provider, model, agentDir, toolRoot } = {}, deps = {}) {
  const env = deps.env ?? process.env;
  if (typeof provider !== "string" || provider.length === 0 || typeof model !== "string" || model.length === 0) return refused(ROUTE_REASON.NO_CONTRACT);

  let contract;
  try {
    contract = resolveProviderCredentials(provider);
  } catch (error) {
    if (!(error instanceof CredentialContractRefusal)) return refused(ROUTE_REASON.NO_CONTRACT);
    // A provider the table declines stays declined: a recorded declaration cannot reopen it.
    if (Object.hasOwn(UNSUPPORTED_PROVIDERS, provider)) return refused(ROUTE_REASON.NO_CONTRACT);
    const declared = await recordedDeclaration({ provider, model, agentDir, env, validators: deps.validators });
    if (declared.reason) return refused(declared.reason);
    try {
      contract = resolveProviderCredentials(provider, { custom: declared.custom });
    } catch {
      return refused(ROUTE_REASON.NO_CONTRACT);
    }
  }

  const route = providerRoute(contract, env, { platform: deps.platform });
  if (route === "environment") return Object.freeze({ ok: true, contract, route });
  if (route === "unset") return refused(ROUTE_REASON.VARIABLE_UNSET);
  if (!contract.authSources.includes(AUTH_SOURCE.STORED)) return refused(ROUTE_REASON.NO_CONTRACT);

  const present = await (deps.storedPresent ?? storedAuthenticationPresent)({ provider, agentDir, toolRoot });
  return present === true ? Object.freeze({ ok: true, contract, route: "stored" }) : refused(ROUTE_REASON.STORED_UNAVAILABLE);
}
