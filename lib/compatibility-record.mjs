/**
 * The compatibility key and record — TSK-0042, CMP-0030, against ACC-0060 and ACC-0062 (DEC-0033).
 *
 * ⚠️ **THE KEY IS COMPUTED, NEVER READ BACK.** `computeCompatibilityKey` derives all eight determinants from the
 * current runtime inputs: the selection, the model as Pi resolves it, and the pinned Pi version. A launch
 * compares the stored record with THAT, so a record can never vouch for itself.
 *
 * ⚠️ **DETERMINANT 8 IS THE CANARY PROTOCOL, NOT THE PACKAGE.** `preflightContractDigest` digests exactly what
 * the canary hands Pi — tool name, description, input schema, system prompt, request template with the
 * challenge replaced by a placeholder, the token ceiling and the success predicate's version. The package
 * capability signature is not in the key; it is a zero-cost check at every launch (DEC-0033).
 *
 * ⚠️ **NOTHING UNBOUNDED IS PERSISTED OR HASHED.** The endpoint is canonicalised or refused, never stripped, and
 * the request profile is `projectRequestProfile`'s classification. Where either needs a declared non-secret
 * identity and none was given, there is no key: nothing is cached, no live check is sent, and setup and launch
 * refuse (D22).
 *
 * ⚠️ **THE ENDPOINT IS THE ONE THE REQUEST GOES TO.** Pi can replace a model's `baseUrl` with one its
 * authentication supplies, at request time. So determinant 6 is computed from the EFFECTIVE base URL, which
 * `resolveEffectiveBaseUrl` asks of Pi's own authentication resolution with the network refused. When that
 * resolution cannot finish without the network, the endpoint is unestablished, there is no key, and no record
 * is reused.
 *
 * ⚠️ **ONLY A PASSED CANARY IS WRITTEN, AND ONLY A RECORD NO CLONE COULD HAVE CARRIED IS READ.** The record lives
 * under the ignored runtime directory, and both writing and reading it go through the consent record's gate: the
 * ignore block, and Git's own answer about the record's actual path. A tracked, committed, unignored or
 * unverifiable record is `untrusted` and is never reused. A failed canary writes nothing.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { atomicWrite } from "./atomic-write.mjs";
import { consentLocation, gitProtection, GIT } from "./consent-record.mjs";
import { coverageState } from "./local-state.mjs";
import { withLock } from "./lock.mjs";
import {
  CANARY_MAX_TOKENS,
  CANARY_SYSTEM_PROMPT,
  PREFLIGHT_DESCRIPTION,
  PREFLIGHT_PARAMETERS,
  PREFLIGHT_TOOL_NAME,
  canaryPrompt,
} from "./preflight-tool.mjs";
import { COMPATIBILITY_KEY_FIELDS, EndpointIdentityError, RequestProfileError, canonicalizeEndpoint, createRuntimeValidators, projectRequestProfile } from "./runtime-records.mjs";

export const COMPATIBILITY_RECORD = join("runtime", "model-compatibility.json");
export const COMPATIBILITY_LOCK = join("runtime", "model-compatibility.lock");
export const COMPATIBILITY_RECORD_VERSION = 1;

/** The version of the success predicate in `isExactChallengeCall`. Changing the predicate changes the digest. */
export const SUCCESS_PREDICATE_VERSION = 1;

export const KEY_REFUSAL = Object.freeze({
  ENDPOINT: "endpoint-identity-unavailable",
  PROFILE: "request-profile-uncacheable",
  MODEL: "model-unresolved",
  EFFECTIVE_ENDPOINT: "effective-endpoint-unestablished",
});

/** The key fields the canary child computes from its own resolved model, and the parent compares (R8). */
export const OBSERVED_KEY_FIELDS = Object.freeze(["apiType", "endpointIdentity", "endpointIdentitySource", "effectiveRequestProfile"]);

export class CompatibilityKeyRefusal extends Error {
  constructor(reason, message, detail = {}) {
    super(message);
    this.name = "CompatibilityKeyRefusal";
    this.reason = reason;
    this.detail = detail;
  }
}

const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/** Key order is not meaning. */
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (isPlainObject(value)) return Object.fromEntries(Object.keys(value).sort().map((k) => [k, canonical(value[k])]));
  return value;
}
const canonicalJson = (v) => JSON.stringify(canonical(v));

/** A 32-character placeholder in the challenge's own shape, so the template is digested, never a challenge. */
const CHALLENGE_PLACEHOLDER = "0".repeat(32);

/** The canary protocol exactly as the canary hands it to Pi, with the challenge replaced by a placeholder. */
export function canaryContract() {
  return {
    toolName: PREFLIGHT_TOOL_NAME,
    description: PREFLIGHT_DESCRIPTION,
    parameters: PREFLIGHT_PARAMETERS,
    systemPrompt: CANARY_SYSTEM_PROMPT,
    promptTemplate: canaryPrompt(CHALLENGE_PLACEHOLDER),
    maxTokens: CANARY_MAX_TOKENS,
    successPredicateVersion: SUCCESS_PREDICATE_VERSION,
  };
}

/** Determinant 8: the digest of the canary protocol. Exported with its input so a test can show each part counts. */
export function preflightContractDigest(contract = canaryContract()) {
  return `sha256:${createHash("sha256").update(canonicalJson(contract)).digest("hex")}`;
}

/**
 * The value Pi sends for the selected thinking level: the model's own mapping where it has one — `null` when
 * the map marks the level unsupported — and otherwise the level itself. A model that does not reason sends none.
 */
export function resolvedThinkingValue(model, thinkingLevel) {
  if (!model?.reasoning) return undefined;
  const map = model.thinkingLevelMap;
  return isPlainObject(map) && Object.hasOwn(map, thinkingLevel) ? map[thinkingLevel] : thinkingLevel;
}

/**
 * The eight determinants for this selection, from the model as Pi resolved it.
 *
 * @param {object} opts
 * @param {{provider: string, model: string, thinkingLevel: string}} opts.selection
 * @param {object} opts.model        the registry's resolved model for that selection
 * @param {string} opts.piVersion    the pinned Pi version
 * @param {{endpointIdentity?: object, requestIdentity?: string}} [opts.declared]  explicitly supplied non-secret identities
 * @param {string} [opts.effectiveBaseUrl]  the base URL the request actually goes to, from `resolveEffectiveBaseUrl`
 */
export function computeCompatibilityKey({ selection, model, piVersion, declared = {}, effectiveBaseUrl }) {
  const ids = { provider: selection.provider, model: selection.model };
  if (!model || model.provider !== selection.provider || model.id !== selection.model)
    throw new CompatibilityKeyRefusal(KEY_REFUSAL.MODEL, `The resolved model is not ${selection.provider} ${selection.model}.`, ids);

  let endpointIdentity;
  let endpointIdentitySource;
  if (declared.endpointIdentity) {
    endpointIdentity = canonical(declared.endpointIdentity);
    endpointIdentitySource = "declared";
  } else {
    try {
      endpointIdentity = canonicalizeEndpoint(effectiveBaseUrl ?? model.baseUrl);
      endpointIdentitySource = "derived";
    } catch (e) {
      if (!(e instanceof EndpointIdentityError)) throw e;
      // ⚠️ The canonicaliser's message names the problem, never the URL's userinfo or query.
      throw new CompatibilityKeyRefusal(
        KEY_REFUSAL.ENDPOINT,
        `${selection.provider} ${selection.model}'s endpoint cannot be used as a cache identity (${e.message}) and none was declared, so no compatibility result can be cached for it.`,
        ids
      );
    }
  }

  let effectiveRequestProfile;
  try {
    effectiveRequestProfile = projectRequestProfile(model, resolvedThinkingValue(model, selection.thinkingLevel), {
      ...(declared.requestIdentity ? { declaredIdentity: declared.requestIdentity } : {}),
    });
  } catch (e) {
    if (!(e instanceof RequestProfileError)) throw e;
    throw new CompatibilityKeyRefusal(KEY_REFUSAL.PROFILE, `${selection.provider} ${selection.model}'s request profile cannot be cached: ${e.message}`, ids);
  }

  return {
    provider: selection.provider,
    model: selection.model,
    thinkingLevel: selection.thinkingLevel,
    piVersion,
    apiType: model.api,
    endpointIdentity,
    endpointIdentitySource,
    effectiveRequestProfile,
    preflightContractDigest: preflightContractDigest(),
  };
}

/** Which determinants differ between two keys, compared as canonical JSON. */
export function differingFields(a, b) {
  return COMPATIBILITY_KEY_FIELDS.filter((f) => canonicalJson(a?.[f]) !== canonicalJson(b?.[f]));
}

/**
 * Does a request's endpoint lie under a key's endpoint identity? Same scheme, host and port, and a path at or
 * below the identity's path on a segment boundary. Only these four parts are compared or reported.
 */
export function requestUnderEndpoint(identity, request) {
  if (!isPlainObject(identity) || !isPlainObject(request)) return false;
  if (identity.scheme !== request.scheme || identity.hostname !== request.hostname || identity.port !== request.port) return false;
  const base = identity.pathname === "/" ? "" : identity.pathname;
  return request.pathname === identity.pathname || request.pathname.startsWith(`${base}/`);
}

/** A request URL as the four endpoint parts, or `null` if it cannot be read. Query and userinfo are dropped. */
export function requestEndpoint(url) {
  try {
    const u = new URL(url);
    return canonicalizeEndpoint(`${u.protocol}//${u.host}${u.pathname}`);
  } catch {
    return null;
  }
}

/**
 * The base URL Pi will actually send this model's requests to, established WITHOUT the network.
 *
 * ⚠️ **PI'S OWN RESOLUTION, WITH THE NETWORK REFUSED.** Authentication can supply a `baseUrl` that replaces the
 * model's. It is resolved through the registry, as Pi resolves it for a request, while `fetch` refuses every
 * call: a resolution that needs the network, such as an OAuth refresh, fails, and the endpoint is then
 * unestablished rather than guessed. Nothing of the resolution but the base URL leaves this function.
 *
 * @returns {Promise<{baseUrl: string} | {unestablished: string}>}
 */
export async function resolveEffectiveBaseUrl(registry, model, { allowNetwork = false } = {}) {
  const realFetch = globalThis.fetch;
  if (!allowNetwork)
    globalThis.fetch = async () => {
      throw new Error("network refused while establishing the effective endpoint");
    };
  try {
    const resolution = await registry.getProviderAuth(model.provider);
    const replaced = resolution?.auth?.baseUrl;
    return { baseUrl: typeof replaced === "string" && replaced.length > 0 ? replaced : model.baseUrl };
  } catch {
    return { unestablished: KEY_REFUSAL.EFFECTIVE_ENDPOINT };
  } finally {
    if (!allowNetwork) globalThis.fetch = realFetch;
  }
}

/**
 * Does a passed canary prove THIS key? `null` if it does, otherwise why not (R8, R9).
 *
 * ⚠️ **THE REQUEST THE CANARY MADE, NOT THE ONE THE PARENT EXPECTED.** The child resolves its own model from its
 * isolated agent directory, which can differ from the host's (a host `models.json` override it did not see, for
 * one). Its observed key fields must equal this key's, it must have been seen sending at least one request, and
 * every request must lie under this key's endpoint. Otherwise the proof is about a different request.
 *
 * @returns {null | {reason: string, fields?: string[]}}
 */
export function proofProblem(key, result) {
  const observed = result?.observed;
  if (!isPlainObject(observed) || observed.keyError) return { reason: "canary-key-unavailable" };
  const fields = OBSERVED_KEY_FIELDS.filter((f) => canonicalJson(observed[f]) !== canonicalJson(key[f]));
  if (fields.length) return { reason: "canary-inputs-differ", fields };
  const requests = Array.isArray(result.requests) ? result.requests : [];
  if (requests.length === 0) return { reason: "effective-endpoint-unobserved" };
  if (!requests.every((r) => requestUnderEndpoint(key.endpointIdentity, r))) return { reason: "effective-endpoint-differs" };
  return null;
}

let cachedValidators = null;
const validatorsFor = (v) => v ?? (cachedValidators ??= createRuntimeValidators());

/** Where the record lives, reusing the consent record's derivation and gate for the same runtime directory. */
export function compatibilityLocation(where) {
  const consent = consentLocation(where);
  return Object.freeze({
    ...consent,
    path: join(consent.roots.root, COMPATIBILITY_RECORD),
    lock: join(consent.roots.root, COMPATIBILITY_LOCK),
  });
}

/** The record's location beside a consent location's runtime directory. */
export function compatibilityLocationFrom(consent) {
  return Object.freeze({ ...consent, path: join(consent.roots.root, COMPATIBILITY_RECORD), lock: join(consent.roots.root, COMPATIBILITY_LOCK) });
}

/** Can this record be trusted to be this host's own? The consent record's gate, asked of the record's path. */
function recordGate(location) {
  const covers = coverageState({ projectRoot: location.projectRoot, mode: location.stateMode, roots: location.roots });
  if (!covers.covered) return "unprotected";
  const git = gitProtection(location);
  if (git.state === GIT.IGNORED || git.state === GIT.NO_REPOSITORY) return null;
  return git.state === GIT.INCONCLUSIVE ? "unverified" : git.state;
}

/**
 * What the record is: `absent`, `invalid`, `untrusted` (a clone could have carried it), or `valid`.
 * Only `valid` means anything.
 */
export function readCompatibility(location, { validators } = {}) {
  if (!existsSync(location.path)) return { state: "absent" };
  // ⚠️ GATED ON READ AS WELL AS WRITE. A force-added record reaches a clone however carefully it was written.
  const untrusted = recordGate(location);
  if (untrusted) return { state: "untrusted", why: untrusted };
  let text;
  try {
    text = readFileSync(location.path, "utf8");
  } catch (e) {
    return e?.code === "ENOENT" ? { state: "absent" } : { state: "invalid", why: `could not be opened (${e?.code ?? "unknown"})` };
  }
  let doc;
  try {
    doc = JSON.parse(text);
  } catch {
    return { state: "invalid", why: "is not JSON" };
  }
  if (!validatorsFor(validators)["model-compatibility"](doc)) return { state: "invalid", why: "does not match its schema" };
  return { state: "valid", record: doc };
}

/**
 * Persist a passed canary against its key.
 *
 * ⚠️ **GATED LIKE THE CONSENT RECORD.** The ignore block must cover the runtime directory, and Git must say the
 * record's path is ignored or outside any repository. Otherwise nothing is written and the result says why:
 * the pass then proves that run only, and setup reports it as awaiting a per-run check (D21).
 *
 * @returns {Promise<{written: boolean, reason?: string}>}
 */
export async function recordCompatibility(location, { key, result }, { validators } = {}) {
  if (result?.outcome !== "passed") throw new TypeError("Only a passed canary is recorded");
  const doc = { recordVersion: COMPATIBILITY_RECORD_VERSION, key, result };
  const checks = validatorsFor(validators);
  if (!checks["model-compatibility"](doc)) throw new TypeError("Refusing to write an invalid compatibility record");
  if (!existsSync(location.runtime)) return { written: false, reason: "no-runtime-dir" };

  return withLock(location.lock, async () => {
    const refused = recordGate(location);
    if (refused) return { written: false, reason: refused };
    await atomicWrite(location.path, JSON.stringify(doc, null, 2) + "\n");
    return { written: true };
  });
}
