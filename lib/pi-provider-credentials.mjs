/**
 * The audited provider credential contract table — TSK-0038, CMP-0029, against ACC-0058.
 *
 * ⚠️ **NAMES, NEVER VALUES.** Every export here is a variable NAME or a category. Nothing in this
 * file reads `process.env`, accepts a credential, or returns one, and a test asserts the absence of
 * `process.env` in the source rather than trusting the reader. Constructing a child's environment
 * from these names is TSK-0039's work; a table that also read values would make the two
 * indistinguishable and put a credential in the one artifact that exists to be audited.
 *
 * ⚠️ **AN UNKNOWN PROVIDER IS A REFUSAL, NOT A GUESS, AND THE GUESS IS THE OBVIOUS IMPLEMENTATION.**
 * `provider.toUpperCase().replace(/-/g, "_") + "_API_KEY"` is right for perhaps half the table and
 * silently wrong for the rest: `moonshotai` needs `MOONSHOT_API_KEY`, `huggingface` needs `HF_TOKEN`,
 * `github-copilot` needs `COPILOT_GITHUB_TOKEN`, and `kimi-coding` needs `KIMI_API_KEY`. A deriver
 * that passed on `openai` would send a child to a provider with no credential and no explanation.
 * The other obvious implementation — enumerating the operator's environment for things that look
 * like keys — is worse, because it succeeds by finding secrets that were never offered.
 *
 * ⚠️ **THE PINNED PACKAGE IS THE SOURCE, AND IT IS COMPARED RATHER THAN COPIED BY HAND.**
 * `getApiKeyEnvVars(provider)` in `@earendil-works/pi-coding-agent`'s bundle is the one authoritative
 * mapping — `docs/providers.md` names its upstream as `packages/ai/src/env-api-keys.ts`. The CLI's
 * own `--help` text disagrees with it for six providers, so the help text is not a source. A test
 * extracts the live map out of the installed package and compares it to this table, which is what
 * makes a Pi version bump fail here instead of being inherited.
 *
 * ⚠️ **AUTH SOURCES, AND WHY THERE ARE ONLY THREE.** `docs/providers.md` resolution order is: the
 * CLI flag, then `auth.json`, then the environment variable, then a `models.json` provider key. Kiln
 * supports the middle two and the last, and NOT the ambient credential chains — DEC: an AWS or ADC
 * chain reads profiles, instance metadata and container endpoints, so there is no closed set of
 * names to declare and "the child gets exactly these variables" stops being a statement anyone can
 * check. Providers whose only route is such a chain are unsupported here rather than granted a wider
 * inheritance.
 */

/** The three routes by which a provider may be authenticated. There is deliberately no fourth. */
export const AUTH_SOURCE = Object.freeze({
  /** Pi's own `auth.json`, written by `/login`. The child needs the variables that LOCATE it. */
  STORED: "stored",
  /** An explicit, audited environment-variable name from the table below. */
  ENVIRONMENT_KEY: "environment-key",
  /** A name contributed by a custom provider through the validated declaration shape. */
  CUSTOM_ENVIRONMENT_KEY: "custom-environment-key",
});

export const CONTRACT_REFUSAL = Object.freeze({
  /** ACC-0058's named reason: neither built in nor validly declared. */
  UNSUPPORTED: "unsupported-credential-contract",
  /** A custom declaration that does not meet the shape. Reached directly through the validator. */
  DECLARATION_INVALID: "custom-declaration-invalid",
});

export class CredentialContractRefusal extends Error {
  constructor(reason, message, detail = {}) {
    super(message);
    this.name = "CredentialContractRefusal";
    this.reason = reason;
    this.detail = detail;
  }
}

/**
 * Providers Pi can reach that Kiln deliberately does NOT support, with the reason travelling beside
 * the id.
 *
 * ⚠️ **AN EXPLICIT ENTRY, NOT AN OMISSION, BECAUSE THE TWO LICENSE DIFFERENT CONCLUSIONS.** A
 * provider missing from the table might be one nobody has looked at; a provider here has been looked
 * at and refused. The refusal carries the reason so an operator is not left to guess whether they hit
 * a gap or a decision.
 */
export const UNSUPPORTED_PROVIDERS = Object.freeze({
  "amazon-bedrock":
    "Bedrock authenticates through the AWS credential chain, which reads AWS_PROFILE, the shared " +
    "credentials file, container credential endpoints, IMDS and web-identity token files — 57 " +
    "distinct AWS_* names appear in the pinned client. There is no closed set of variable names to " +
    "declare, so no child environment built from names can be said to contain exactly what was " +
    "intended. Pi's own env-key map has no entry for it either.",
  "azure-openai":
    "Only `azure-openai-responses` is mapped in the pinned package. The unmapped `azure-openai` id " +
    "has no audited credential name, and inferring one from the mapped sibling would be the guess " +
    "this table exists to refuse.",
});

/**
 * One entry per supported provider.
 *
 * - `required`  every name must be present for the contract to be satisfiable.
 * - `anyOf`     groups from each of which at least one name is needed. Anthropic accepts three
 *               different credentials and Azure accepts either a base URL or a resource name; a flat
 *               `required` list would misreport both as needing all of them.
 * - `optional`  names that refine behaviour and whose absence is not a failure.
 * - `piMapped`  whether `getApiKeyEnvVars` in the pinned package maps this id. False only for
 *               providers Pi ships as an extension, which the comparison test exempts by this flag
 *               rather than by a hand-maintained list beside it.
 */
const ENV = AUTH_SOURCE.ENVIRONMENT_KEY;
const STORED = AUTH_SOURCE.STORED;

/** Every built-in provider offers both routes: `/login` writes auth.json, or the variable is set. */
const BOTH = Object.freeze([STORED, ENV]);

const entry = (id, { required = [], anyOf = [], optional = [], authSources = BOTH, piMapped = true }) =>
  Object.freeze({
    id,
    authSources: Object.freeze([...authSources]),
    required: Object.freeze([...required]),
    anyOf: Object.freeze(anyOf.map((group) => Object.freeze([...group]))),
    optional: Object.freeze([...optional]),
    piMapped,
  });

/** A provider whose whole contract is one API key. Most of the table is this shape. */
const simple = (id, name) => entry(id, { required: [name] });

export const PROVIDER_CREDENTIALS = Object.freeze(
  Object.fromEntries(
    [
      // ⚠️ THREE ALTERNATIVES, NOT THREE REQUIREMENTS. `getApiKeyEnvVars("anthropic")` returns all
      // three and any one of them authenticates.
      entry("anthropic", {
        anyOf: [["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_OAUTH_TOKEN", "ANTHROPIC_API_KEY"]],
      }),
      // ⚠️ NOT `GITHUB_TOKEN`, AND NOT DERIVABLE FROM THE ID. Special-cased in the pinned package.
      simple("github-copilot", "COPILOT_GITHUB_TOKEN"),
      simple("openai", "OPENAI_API_KEY"),
      // ⚠️ THE KEY ALONE DOES NOT LOCATE THE ENDPOINT. Azure needs a base URL or a resource name, and
      // a contract that listed only the key would be satisfiable and still unusable.
      entry("azure-openai-responses", {
        required: ["AZURE_OPENAI_API_KEY"],
        anyOf: [["AZURE_OPENAI_BASE_URL", "AZURE_OPENAI_RESOURCE_NAME"]],
        optional: ["AZURE_OPENAI_API_VERSION", "AZURE_OPENAI_DEPLOYMENT_NAME_MAP"],
      }),
      simple("deepseek", "DEEPSEEK_API_KEY"),
      simple("nvidia", "NVIDIA_API_KEY"),
      simple("google", "GEMINI_API_KEY"),
      // ⚠️ **THE EXPLICIT KEY ROUTE ONLY.** Vertex's documented path is Application Default
      // Credentials, which is an ambient chain and therefore out. The project and location are names
      // rather than credentials, and the key route cannot address an endpoint without them, so they
      // are optional names here — not a claim that ADC is supported.
      entry("google-vertex", {
        required: ["GOOGLE_CLOUD_API_KEY"],
        optional: ["GOOGLE_CLOUD_PROJECT", "GOOGLE_CLOUD_LOCATION"],
      }),
      simple("groq", "GROQ_API_KEY"),
      simple("cerebras", "CEREBRAS_API_KEY"),
      simple("xai", "XAI_API_KEY"),
      simple("radius", "RADIUS_API_KEY"),
      simple("openrouter", "OPENROUTER_API_KEY"),
      simple("vercel-ai-gateway", "AI_GATEWAY_API_KEY"),
      simple("mistral", "MISTRAL_API_KEY"),
      simple("ant-ling", "ANT_LING_API_KEY"),
      simple("zai", "ZAI_API_KEY"),
      simple("zai-coding-cn", "ZAI_CODING_CN_API_KEY"),
      simple("minimax", "MINIMAX_API_KEY"),
      simple("minimax-cn", "MINIMAX_CN_API_KEY"),
      // ⚠️ TWO IDS, ONE VARIABLE. So is `opencode`/`opencode-go` and the two international Qwen
      // plans: the table cannot be keyed by variable name, and nothing may assume a bijection.
      simple("moonshotai", "MOONSHOT_API_KEY"),
      simple("moonshotai-cn", "MOONSHOT_API_KEY"),
      // ⚠️ `HF_TOKEN`, WHICH NO RULE PRODUCES FROM "huggingface".
      simple("huggingface", "HF_TOKEN"),
      simple("fireworks", "FIREWORKS_API_KEY"),
      simple("together", "TOGETHER_API_KEY"),
      simple("baseten", "BASETEN_API_KEY"),
      simple("opencode", "OPENCODE_API_KEY"),
      simple("opencode-go", "OPENCODE_API_KEY"),
      simple("kimi-coding", "KIMI_API_KEY"),
      entry("cloudflare-workers-ai", {
        required: ["CLOUDFLARE_API_KEY", "CLOUDFLARE_ACCOUNT_ID"],
      }),
      entry("cloudflare-ai-gateway", {
        required: ["CLOUDFLARE_API_KEY", "CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_GATEWAY_ID"],
      }),
      simple("qwen-token-plan", "QWEN_TOKEN_PLAN_API_KEY"),
      simple("qwen-token-plan-individual", "QWEN_TOKEN_PLAN_API_KEY"),
      simple("qwen-token-plan-cn", "QWEN_TOKEN_PLAN_CN_API_KEY"),
      simple("xiaomi", "XIAOMI_API_KEY"),
      simple("xiaomi-token-plan-cn", "XIAOMI_TOKEN_PLAN_CN_API_KEY"),
      simple("xiaomi-token-plan-ams", "XIAOMI_TOKEN_PLAN_AMS_API_KEY"),
      simple("xiaomi-token-plan-sgp", "XIAOMI_TOKEN_PLAN_SGP_API_KEY"),
      // ⚠️ **PI SHIPS THIS AS AN EXTENSION, SO IT IS NOT IN THE ENV-KEY MAP** — `piMapped: false`, and
      // the comparison test exempts it on that flag. The names come from the extension itself:
      // `LLAMA_PROVIDER_ID = "llama.cpp"` and both variables are read in
      // `dist/extensions/llama/provider.js`, documented in `docs/llama-cpp.md`.
      //
      // ⚠️ THE BASE URL IS REQUIRED HERE THOUGH THE EXTENSION DEFAULTS IT to http://127.0.0.1:8080.
      // A child that inherits no URL and silently talks to whatever is on the loopback port is the
      // failure this contract is meant to make impossible, so the address is stated rather than
      // defaulted. `HF_TOKEN` is deliberately absent: it authenticates Hugging Face model SEARCH and
      // DOWNLOAD, which is not child inference.
      entry("llama.cpp", {
        required: ["LLAMA_BASE_URL"],
        optional: ["LLAMA_API_KEY"],
        piMapped: false,
      }),
    ].map((e) => [e.id, e])
  )
);

/* ================================================ custom declarations ========================== */

/**
 * The one accepted spelling of a contributed variable name.
 *
 * ⚠️ **A COMPLETE EXPRESSION, ANCHORED, AND THE ANCHORS ARE THE RULE RATHER THAN TIDINESS.** Pi's
 * `apiKey` grammar also accepts `!command` (executes and uses stdout), a bare literal, and
 * interpolation inside a larger string. Each of those is a VALUE or a way of producing one, and this
 * table holds names. `${KEY_PREFIX}_${KEY_SUFFIX}` is the subtle one: it is spelled like
 * interpolation and denotes a value assembled from two names, so there is no single name to declare.
 *
 * ⚠️ **AND PI'S OWN RULE IS THAT AN UPPERCASE BARE WORD IS A LITERAL.** `docs/models.md` states that
 * plain uppercase strings such as `MY_API_KEY` are literals, not variables. Accepting one here would
 * read an operator's typo as a name and put a literal credential in `models.json`.
 */
const COMPLETE_VARIABLE = /^\$(?:([A-Z][A-Z0-9_]*)|\{([A-Z][A-Z0-9_]*)\})$/;

/** Names Kiln owns. A custom provider that could set one would be redirecting Pi's own configuration. */
const RESERVED_PREFIX = "PI_";

const DECLARATION_PROBLEM = Object.freeze({
  NOT_A_STRING: "not-a-string",
  COMMAND: "command",
  LITERAL: "literal",
  PARTIAL_INTERPOLATION: "partial-interpolation",
  MULTIPLE_VARIABLES: "multiple-variables",
  NAME_GRAMMAR: "name-grammar",
  RESERVED_PREFIX: "reserved-prefix",
  BAD_SHAPE: "bad-shape",
  DUPLICATE_NAME: "duplicate-name",
});

export { DECLARATION_PROBLEM };

/**
 * Read one declared name, or say precisely what is wrong with it.
 *
 * @param {unknown} expression
 * @returns {{name: string} | {problem: string}}
 */
export function readDeclaredName(expression) {
  if (typeof expression !== "string" || expression.length === 0) return { problem: DECLARATION_PROBLEM.NOT_A_STRING };
  if (expression.startsWith("!")) return { problem: DECLARATION_PROBLEM.COMMAND };

  const dollars = (expression.match(/\$/g) ?? []).length;
  if (dollars === 0) return { problem: DECLARATION_PROBLEM.LITERAL };
  if (dollars > 1) return { problem: DECLARATION_PROBLEM.MULTIPLE_VARIABLES };

  const match = COMPLETE_VARIABLE.exec(expression);
  if (!match) {
    // ⚠️ **TWO DIFFERENT MISTAKES BEHIND ONE FAILED MATCH, AND THEY NEED DIFFERENT MESSAGES.** Either a
    // well-formed reference has text around it, or the name itself breaks the grammar. The first is
    // partial interpolation: `prefix-$KEY` and `$KEY-suffix` both denote a value built around a name.
    // The second is `$lowercase` or `$1KEY`, where there is no name to have surrounded.
    if (!expression.startsWith("$")) return { problem: DECLARATION_PROBLEM.PARTIAL_INTERPOLATION };
    const wellFormedPrefix = /^\$(?:\{[A-Z][A-Z0-9_]*\}|[A-Z][A-Z0-9_]*)/.test(expression);
    return {
      problem: wellFormedPrefix ? DECLARATION_PROBLEM.PARTIAL_INTERPOLATION : DECLARATION_PROBLEM.NAME_GRAMMAR,
    };
  }

  const name = match[1] ?? match[2];
  if (name.startsWith(RESERVED_PREFIX)) return { problem: DECLARATION_PROBLEM.RESERVED_PREFIX };
  return { name };
}

/**
 * Validate a custom provider's declaration and return it as a table entry.
 *
 * The accepted shape is deliberately smaller than Pi's provider config: an id, one `apiKey`
 * expression, and optional further expressions. Everything else in a `models.json` provider block —
 * `baseUrl`, `api`, `headers`, `authHeader` — is not a credential contract and is not this module's.
 *
 * @param {{id?: unknown, apiKey?: unknown, optional?: unknown}} declaration
 * @returns {{id: string, authSources: string[], required: string[], anyOf: string[][], optional: string[], piMapped: boolean}}
 */
export function validateCustomDeclaration(declaration) {
  const refuse = (problem, message, detail = {}) => {
    throw new CredentialContractRefusal(CONTRACT_REFUSAL.DECLARATION_INVALID, message, { problem, ...detail });
  };

  if (declaration === null || typeof declaration !== "object" || Array.isArray(declaration))
    refuse(DECLARATION_PROBLEM.BAD_SHAPE, "A custom credential declaration must be an object.");

  const { id, apiKey, optional = [] } = declaration;
  if (typeof id !== "string" || id.length === 0)
    refuse(DECLARATION_PROBLEM.BAD_SHAPE, "A custom credential declaration must carry a non-empty provider id.");
  if (!Array.isArray(optional))
    refuse(DECLARATION_PROBLEM.BAD_SHAPE, `\`optional\` must be an array of declarations for ${id}.`, { id });

  const read = readDeclaredName(apiKey);
  if (read.problem)
    refuse(
      read.problem,
      `${id} declares an apiKey this table cannot accept as a NAME (${read.problem}). Declare exactly ` +
        `one complete variable reference — $NAME or \${NAME}, uppercase, not beginning PI_ — because ` +
        `a literal, a command and a partially interpolated string are all values or ways of making one.`,
      { id }
    );

  const optionalNames = [];
  for (const expression of optional) {
    const each = readDeclaredName(expression);
    if (each.problem)
      refuse(each.problem, `${id} declares an optional entry this table cannot accept as a NAME (${each.problem}).`, {
        id,
      });
    if (each.name === read.name || optionalNames.includes(each.name))
      refuse(DECLARATION_PROBLEM.DUPLICATE_NAME, `${id} declares ${each.name} more than once.`, { id });
    optionalNames.push(each.name);
  }

  return Object.freeze({
    id,
    authSources: Object.freeze([AUTH_SOURCE.CUSTOM_ENVIRONMENT_KEY]),
    required: Object.freeze([read.name]),
    anyOf: Object.freeze([]),
    optional: Object.freeze(optionalNames),
    piMapped: false,
  });
}

/* ================================================ the one entry point ========================== */

/**
 * The credential contract for one provider, or a refusal naming it.
 *
 * ⚠️ **THE BUILT-IN TABLE WINS, AND A CUSTOM DECLARATION CANNOT REDEFINE A KNOWN PROVIDER.** Letting
 * one through would be a supported way to point `anthropic` at a variable the operator chose, which
 * is the audited table's whole point undone by its own extension mechanism.
 *
 * ⚠️ **AN INVALID CUSTOM DECLARATION IS `unsupported-credential-contract`, NOT A SECOND OUTCOME.**
 * ACC-0058 asks that a provider "neither built in nor declared through the validated custom shape"
 * refuse under that reason, and a declaration that failed validation is not a declaration. The
 * underlying problem travels in `detail.declarationProblem` so the diagnosis is not lost.
 *
 * @param {string} providerId
 * @param {{custom?: object|null}} [opts]
 */
export function resolveProviderCredentials(providerId, opts = {}) {
  const unsupported = (message, detail = {}) =>
    new CredentialContractRefusal(CONTRACT_REFUSAL.UNSUPPORTED, message, { provider: providerId, ...detail });

  if (typeof providerId !== "string" || providerId.length === 0)
    throw unsupported(`A provider id is required, got ${JSON.stringify(providerId)}.`);

  const declined = UNSUPPORTED_PROVIDERS[providerId];
  if (declined) throw unsupported(`${providerId} has no supported credential contract.\n${declined}`, { why: declined });

  const known = PROVIDER_CREDENTIALS[providerId];
  if (known) return known;

  const custom = opts.custom ?? null;
  if (custom === null)
    throw unsupported(
      `${providerId} has no built-in credential contract and no custom declaration was supplied.\n` +
        `No variable name is inferred from a provider id and the environment is never searched, so ` +
        `there is nothing to fall back to. Declare the contract explicitly, or select a supported provider.`
    );

  let validated;
  try {
    validated = validateCustomDeclaration(custom);
  } catch (e) {
    if (!(e instanceof CredentialContractRefusal)) throw e;
    throw unsupported(
      `${providerId}'s custom credential declaration is not valid, so the provider has no contract.\n${e.message}`,
      { declarationProblem: e.detail.problem }
    );
  }

  if (validated.id !== providerId)
    throw unsupported(
      `The custom declaration supplied for ${providerId} declares ${validated.id}. A declaration is ` +
        `refused rather than applied to whichever provider was being resolved.`,
      { declared: validated.id }
    );

  return validated;
}

/** Every name a contract mentions, for a caller that needs the flat set. Names only. */
export function declaredNames(contract) {
  return [...contract.required, ...contract.anyOf.flat(), ...contract.optional];
}

/** The provider ids this table supports, sorted, so a caller never enumerates the object's order. */
export function supportedProviders() {
  return Object.keys(PROVIDER_CREDENTIALS).sort();
}
