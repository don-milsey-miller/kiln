/**
 * Kiln's persisted runtime records — the five files the agent-delivery layer writes outside
 * `planning-content/`, validated through the same Ajv layer as everything else.
 *
 * ⚠️ **WHY THESE ARE SCHEMA-VALIDATED AND `.pi/settings.json` IS NOT.** Settings is PI's file: Pi
 * writes it, the operator may hand-edit it, and Kiln owns four keys inside it. Kiln has no standing
 * to declare its shape, so setup reads it defensively and merges only what it owns. These five are
 * the opposite — Kiln invents them, writes them, versions them and is the only reader — so they are
 * contracts, and a contract nobody validates is a comment. Hand-parsing them would put a second,
 * informal schema implementation beside the real one.
 *
 * ⚠️ **A SEPARATE SET FROM THE ARTIFACT SCHEMAS, SHARING THE MACHINERY.** `createValidators()` keys
 * on `x-artifactType` and requires the artifact `common.schema.json`; these records have neither and
 * version on their own cadence. So they live in `schemas/runtime/` with their own discriminator —
 * and reuse this project's Ajv construction, dialect check, error formatter and `ValidationError`,
 * which is the duplication that would actually have cost something.
 *
 * ⚠️ **THE DIRECTORY IS INVISIBLE TO THE ARTIFACT LOADER, and that is load-bearing rather than
 * incidental.** `loadSchemaSet()` reads one directory non-recursively and refuses any
 * `*.schema.json` without an `x-artifactType`; a sibling directory does not match that filter, so
 * the two sets cannot collide. Putting these files beside the artifact schemas would have broken
 * every caller of the artifact loader.
 */

import Ajv from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { ValidationError, formatErrors } from "./validate.mjs";

const DIALECT = "https://json-schema.org/draft/2020-12/schema";
const COMMON = "runtime-common.schema.json";

export const RUNTIME_SCHEMAS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "schemas", "runtime");

/** The records this layer writes, where each lives, and whether it reaches a clone. */
export const RUNTIME_RECORDS = {
  "kiln-project": { location: "<project>/.pi/kiln.json", committed: true },
  consent: { location: "<local-state>/runtime/consent.json", committed: false },
  "setup-transaction": { location: "<local-state>/runtime/setup-transaction.json", committed: false },
  "kiln-session": { location: "<local-state>/runtime/kiln-session.json", committed: false },
  "model-compatibility": { location: "<local-state>/runtime/model-compatibility.json", committed: false },
};

/**
 * The eight determinants of a cached canary result, in one place, because they are the only inputs
 * that may invalidate a BILLABLE check (DEC-0033).
 *
 * ⚠️ EXPORTED SO COMPARISON CANNOT DRIFT FROM THE SCHEMA. A caller that hand-listed the fields to
 * compare would be a second definition of the invalidation set beside the first, and the two would
 * disagree the moment one changed — the same defect QST-0032 was about, in a different file.
 */
export const COMPATIBILITY_KEY_FIELDS = Object.freeze([
  "provider",
  "model",
  "thinkingLevel",
  "piVersion",
  "apiType",
  "endpointIdentity",
  "endpointIdentitySource",
  "effectiveRequestProfile",
  "preflightContractDigest",
]);

/**
 * Compile the runtime record validators, keyed by `x-runtimeRecord`.
 *
 * @param {string} [dir]
 */
export function createRuntimeValidators(dir = RUNTIME_SCHEMAS_DIR) {
  const files = readdirSync(dir).filter((f) => f.endsWith(".schema.json"));
  const docs = Object.fromEntries(files.map((f) => [f, JSON.parse(readFileSync(join(dir, f), "utf-8"))]));

  if (!docs[COMMON]) throw new Error(`No ${COMMON} in ${dir}; the shared runtime primitives are required.`);

  for (const [f, s] of Object.entries(docs))
    if (s.$schema !== DIALECT)
      throw new Error(`${f} declares $schema ${JSON.stringify(s.$schema)}; the dialect is fixed at ${DIALECT}.`);

  const ajv = new Ajv({ strict: false, allErrors: true });
  addFormats(ajv);
  ajv.addSchema(docs[COMMON], COMMON);

  const compiled = {};
  for (const [f, s] of Object.entries(docs)) {
    if (f === COMMON) continue;
    const kind = s["x-runtimeRecord"];
    if (!kind)
      throw new Error(`${f} has no x-runtimeRecord; every runtime record schema must declare one.`);
    // The filename/discriminator agreement rule the artifact loader also enforces, for the same
    // reason: two names for one thing drift, and the drift surfaces as a validator that is simply
    // missing rather than as an error anyone can read.
    if (kind !== f.replace(/\.schema\.json$/, ""))
      throw new Error(`${f} declares x-runtimeRecord "${kind}" — file name and record kind must agree.`);
    compiled[kind] = ajv.compile(s);
  }
  return compiled;
}

/** Throw ValidationError unless `doc` is a legal record of `kind`. */
export function assertValidRecord(validators, kind, doc, what = "runtime record") {
  const v = validators[kind];
  if (!v) throw new ValidationError(`No schema for runtime record ${JSON.stringify(kind)}`, []);
  if (!v(doc)) throw new ValidationError(`Invalid ${what} (${kind}): ${formatErrors(v.errors)}`, v.errors ?? []);
  return doc;
}

/**
 * A generated project identifier.
 *
 * ⚠️ **RANDOM AND MEANINGLESS ON PURPOSE.** Deriving it from the project name or its path would
 * leak that name into an ignored directory name on every machine, and would change the identity the
 * moment somebody renamed or moved the project — which is exactly when the external state root must
 * NOT move out from under them.
 */
export function generateProjectId(randomBytes) {
  return randomBytes(16).toString("hex");
}


/* ==================================================================== determinant 6 ============ */

/** Default ports, so a port is always explicit and two spellings of one endpoint cannot differ. */
const DEFAULT_PORTS = { "http:": 80, "https:": 443, "ws:": 80, "wss:": 443 };

export class EndpointIdentityError extends Error {
  constructor(message) {
    super(message);
    this.name = "EndpointIdentityError";
  }
}

/**
 * Canonicalise a provider base URL into the structured endpoint identity.
 *
 * ⚠️ **ONE IMPLEMENTATION, BECAUSE A REGEX IN A SCHEMA IS NOT A CANONICALISER.** The first version
 * of determinant 6 was a pattern over a URL string. It correctly excluded userinfo, query and
 * fragment — and still accepted an uppercase hostname, an implicit port and a trailing slash, which
 * are three spellings of one endpoint. Two records for the same endpoint would have compared
 * unequal and re-run a billable check. The schema now describes the parts; this produces them.
 *
 * ⚠️ **REFUSES, NEVER SANITISES.** A query can carry routing, so stripping it would let two
 * differently routed endpoints share one proof; and an identity that is only non-secret after
 * userinfo has been removed is not something a persisted file may rely on. An endpoint whose URL
 * cannot be used needs an explicitly declared non-secret identity instead.
 */
export function canonicalizeEndpoint(baseUrl) {
  let url;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new EndpointIdentityError(`Not a URL: ${JSON.stringify(baseUrl)}`);
  }

  if (url.username || url.password)
    throw new EndpointIdentityError(
      "The base URL carries userinfo, which cannot be persisted and must not be stripped — the " +
        "result would be an identity that is only non-secret after sanitising. Declare an explicit " +
        "non-secret endpoint identity instead, or let the canary re-run."
    );
  if (url.search)
    throw new EndpointIdentityError(
      "The base URL carries a query, which can carry routing. Stripping it would let two " +
        "differently routed endpoints share one cached proof. Declare an explicit endpoint identity " +
        "instead, or let the canary re-run."
    );
  if (url.hash) throw new EndpointIdentityError("The base URL carries a fragment, which names nothing on a server.");

  const scheme = url.protocol.replace(/:$/, "").toLowerCase();
  const port = url.port ? Number(url.port) : DEFAULT_PORTS[url.protocol];
  if (!port)
    throw new EndpointIdentityError(
      `No port and no default for scheme "${scheme}"; an implicit port would make two spellings of ` +
        "one endpoint into two cache keys."
    );

  // Trailing slash removed except at the root, and empty segments collapsed — canonical, not merely
  // tidy: `/v1` and `/v1/` are one path and must be one key.
  const segments = url.pathname.split("/").filter(Boolean);
  const pathname = segments.length ? `/${segments.join("/")}` : "/";

  return { scheme, hostname: url.hostname.toLowerCase(), port, pathname };
}

/* ==================================================================== determinant 7 ============ */

/**
 * The compat fields carried by VALUE in the effective request profile — scalars only.
 *
 * ⚠️ **A TEST CHECKS THIS AGAINST THE PINNED PACKAGE'S OWN TYPE DECLARATIONS**, so it cannot quietly
 * fall behind Pi. Hand-maintaining a list beside a declaration that already exists is the defect
 * QST-0032 was about; the list is unavoidable here because Kiln must decide what to persist, so the
 * check is what keeps it honest.
 */
export const SCALAR_COMPAT_FIELDS = Object.freeze([
  "allowEmptySignature", "cacheControlFormat", "deferredToolsMode", "forceAdaptiveThinking",
  "maxTokensField", "requiresAssistantAfterToolResult", "requiresReasoningContentOnAssistantMessages",
  "requiresThinkingAsText", "requiresToolResultName", "sendSessionAffinityHeaders",
  "sessionAffinityFormat", "supportsAdditionalTools", "supportsCacheControlOnTools",
  "supportsDeveloperRole", "supportsEagerToolInputStreaming", "supportsExplicitPromptCacheMode",
  "supportsFinishReason", "supportsLongCacheRetention", "supportsOpenAIGrammarTools",
  "supportsReasoningEffort", "supportsStore", "supportsStrictMode", "supportsStrictTools",
  "supportsTemperature", "supportsThinkingTokenBudget", "supportsToolReferences",
  "supportsToolSearch", "supportsUsageInStreaming", "thinkingFormat", "thinkingTokenBudgetField",
  "zaiToolStream",
]);

/**
 * Compat members that are STRUCTURES rather than scalars, and are safely typed by Pi — persisted by
 * value, with unknown keys refused at every depth.
 */
export const STRUCTURED_COMPAT_FIELDS = Object.freeze([
  "allowedFallbackModels", "openRouterRouting", "vercelGatewayRouting",
]);

/**
 * Compat members whose CONTENT is operator-authored and unbounded. Never persisted, and — this is
 * the correction that matters — **never digested either**.
 *
 * ⚠️ **A DIGEST OF UNBOUNDED CONFIGURATION IS A CREDENTIAL-DERIVED FINGERPRINT.** The first version
 * of this projection hashed the whole resolved compat object to keep these in the key without
 * putting their contents in the file. That reasoning was wrong in a way this very module already
 * warned about: `runtime-common.schema.json`'s `digest` definition says hashing a key does not make
 * it safe to persist, it makes it an oracle for confirming a guess. An operator writing
 * `chatTemplateKwargs: { innocent: "sk-live-…" }` would have had that secret's SHA-256 written to
 * disk. Hashing hides content; it does not sanitise it.
 */
export const UNBOUNDED_COMPAT_FIELDS = Object.freeze(["chatTemplateArgs", "chatTemplateKwargs"]);

/**
 * Header names that carry credentials rather than routing.
 *
 * ⚠️ **EXCLUDED ENTIRELY, AND DELIBERATELY NOT DETERMINANTS.** These are credential transport:
 * rotating a key changes the header and changes nothing about what the model can do, so treating
 * one as a determinant would re-run a billable check on every rotation while adding no safety.
 * Everything NOT on this list is treated as possible routing, because a custom header can select a
 * different backend — and a header whose value routes is a determinant whose value cannot be
 * persisted, which is exactly what `unboundedInputs` is for.
 */
export const AUTH_HEADER_NAMES = Object.freeze([
  "authorization", "proxy-authorization", "cookie", "set-cookie",
  "api-key", "x-api-key", "x-goog-api-key", "anthropic-api-key", "openai-api-key",
  "x-auth-token", "x-access-token", "x-session-token", "x-amz-security-token",
]);

export class RequestProfileError extends Error {
  constructor(message) {
    super(message);
    this.name = "RequestProfileError";
  }
}

/** Recursively refuse a key the declared shape does not name. Fail closed, at every depth. */
function assertKnownShape(value, allowed, path) {
  if (value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const [i, v] of value.entries()) assertKnownShape(v, allowed, `${path}[${i}]`);
    return;
  }
  for (const k of Object.keys(value)) {
    if (!allowed.has(k))
      throw new RequestProfileError(
        `${path}.${k} is not a field this projection knows. Refusing to persist a structure whose ` +
          "shape has moved: an unknown key is either a determinant that would be dropped or content " +
          "that has no business in the record."
      );
    assertKnownShape(value[k], allowed, `${path}.${k}`);
  }
}

/** Every key name appearing anywhere in the three safely typed structures. */
const STRUCTURED_KEYS = new Set([
  "only", "order", "ignore", "quantizations", "allow_fallbacks", "require_parameters",
  "data_collection", "zdr", "enforce_distillable_text", "sort", "by", "partition",
  "max_price", "prompt", "completion", "image", "audio", "request",
  "preferred_min_throughput", "preferred_max_latency",
  "provider", "model", "cost", "input", "output", "cacheRead", "cacheWrite", "tiers",
]);

/**
 * Project a resolved Pi model into the persisted effective request profile.
 *
 * ⚠️ **NOTHING UNBOUNDED IS PERSISTED, HASHED, COUNTED OR NAMED.** Where operator-authored content
 * affects the request — `chatTemplateKwargs`, `chatTemplateArgs`, non-empty `samplingParams`, or a
 * non-authentication header — only the CATEGORY is recorded, and an explicitly supplied non-secret
 * `declaredIdentity` is required. Without one this refuses, and the canary re-runs. That is the
 * honest cost of configuration Kiln cannot inspect safely; the alternative was a fingerprint.
 *
 * ⚠️ **`samplingParams` IS A DETERMINANT.** Pi documents that it overrides named request fields, so
 * ignoring it would let a proof outlive the request it was taken against. It is unbounded, so it
 * lands in the same category rather than in the key by value.
 *
 * @param {object} model
 * @param {string|null} resolvedThinkingValue
 * @param {{declaredIdentity?: string}} [options]
 */
export function projectRequestProfile(model, resolvedThinkingValue, options = {}) {
  const compatIn = model?.compat ?? {};
  const known = new Set([...SCALAR_COMPAT_FIELDS, ...STRUCTURED_COMPAT_FIELDS, ...UNBOUNDED_COMPAT_FIELDS]);
  const unknown = Object.keys(compatIn).filter((k) => !known.has(k)).sort();
  if (unknown.length)
    throw new RequestProfileError(
      `The resolved model carries compat fields this projection does not know: ${unknown.join(", ")}. ` +
        "Refusing to cache rather than dropping a determinant or persisting an unbounded value. " +
        "Classify each field and extend the schema."
    );

  const compat = {};
  for (const f of SCALAR_COMPAT_FIELDS) if (compatIn[f] !== undefined) compat[f] = compatIn[f];

  const compatStructured = {};
  for (const f of STRUCTURED_COMPAT_FIELDS) {
    if (compatIn[f] === undefined) continue;
    assertKnownShape(compatIn[f], STRUCTURED_KEYS, `compat.${f}`);
    compatStructured[f] = compatIn[f];
  }

  const nonEmpty = (v) => v && typeof v === "object" && Object.keys(v).length > 0;
  const categories = [];
  for (const f of UNBOUNDED_COMPAT_FIELDS) if (nonEmpty(compatIn[f])) categories.push(f);
  if (nonEmpty(model?.samplingParams)) categories.push("samplingParams");

  // Headers split by role: credential transport is excluded outright and never invalidates;
  // anything else may be routing, and routing that cannot be persisted must be declared.
  const auth = new Set(AUTH_HEADER_NAMES);
  const routingHeaders = Object.keys(model?.headers ?? {}).filter((h) => !auth.has(h.toLowerCase()));
  if (routingHeaders.length) categories.push("customHeaders");
  categories.sort();

  const declaredIdentity = options.declaredIdentity;
  if (categories.length && !declaredIdentity)
    throw new RequestProfileError(
      `This model's request depends on configuration Kiln cannot persist or digest safely ` +
        `(${categories.join(", ")}), and no non-secret identity was declared for it. Refusing to ` +
        "cache a compatibility result: hashing the values would write a credential-derived " +
        "fingerprint, and ignoring them would let the proof outlive the request. Declare a " +
        "non-secret label for this configuration, or accept that the canary re-runs."
    );
  if (!categories.length && declaredIdentity)
    throw new RequestProfileError(
      "A declared identity was supplied for a model with no unbounded configuration. It would sit " +
        "in the key describing nothing, and would silently invalidate the proof when it changed."
    );

  return {
    reasoning: Boolean(model?.reasoning),
    ...(resolvedThinkingValue === undefined ? {} : { resolvedThinkingValue }),
    compat,
    compatStructured,
    unboundedInputs: { categories, ...(declaredIdentity ? { declaredIdentity } : {}) },
  };
}
