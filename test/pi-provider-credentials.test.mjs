/**
 * The provider credential contract table — TSK-0038, against ACC-0058.
 *
 * ⚠️ **THE POSITIVE CASES ARE THE WEAK HALF OF THIS FILE.** A table that returns the right variable
 * for `openai` is satisfied by a deriver, by an environment scan, and by the audited table, and only
 * one of those is correct. So what most of these assert is what must NOT happen: that an unknown id
 * refuses instead of producing a plausible name, that ids whose variables are not derivable from
 * them still resolve, that the answer does not change when the environment does, and that no value
 * ever leaves the module.
 *
 * ⚠️ **CHILD-ENVIRONMENT CONSTRUCTION IS NOT TESTED HERE BECAUSE IT DOES NOT EXIST YET.** ACC-0058's
 * clause about additional variables not being inherited belongs to TSK-0039, and asserting it against
 * this module would be asserting it against nothing.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  AUTH_SOURCE,
  CONTRACT_REFUSAL,
  CredentialContractRefusal,
  DECLARATION_PROBLEM,
  PROVIDER_CREDENTIALS,
  UNSUPPORTED_PROVIDERS,
  declaredNames,
  readDeclaredName,
  resolveProviderCredentials,
  supportedProviders,
  validateCustomDeclaration,
} from "../lib/pi-provider-credentials.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MODULE_PATH = join(ROOT, "lib", "pi-provider-credentials.mjs");
const PI_DIR = join(ROOT, "node_modules", "@earendil-works", "pi-coding-agent");

/** The refusal itself, because what these assert is largely what an operator reads. */
function refusalFrom(fn, reason) {
  try {
    fn();
  } catch (e) {
    assert.ok(e instanceof CredentialContractRefusal, `expected a CredentialContractRefusal, got ${e}`);
    assert.equal(e.reason, reason, `expected ${reason}, got ${e.reason}: ${e.message}`);
    return e;
  }
  assert.fail(`expected a ${reason} refusal, and nothing was thrown`);
}

/**
 * Pi's own provider-to-variable map, read out of the INSTALLED package.
 *
 * ⚠️ **LOCATED BY CONTENT, NOT BY FILE NAME.** The bundle chunk is called `chunk-OMWWHBTG.js` today
 * and that name is a build artifact of the pinned version; a rebuild renames it. What is stable is
 * the function, so the chunk is found by looking for it.
 */
function pinnedEnvKeyMap() {
  const chunks = join(PI_DIR, "dist", "bundle", "chunks");
  for (const name of readdirSync(chunks)) {
    if (!name.endsWith(".js")) continue;
    const source = readFileSync(join(chunks, name), "utf-8");
    const at = source.indexOf("function getApiKeyEnvVars");
    if (at === -1) continue;

    const start = source.indexOf("{", source.indexOf('envVar={"', at));
    let depth = 0;
    let end = -1;
    for (let i = start; i < source.length; i++) {
      if (source[i] === "{") depth++;
      else if (source[i] === "}" && --depth === 0) {
        end = i + 1;
        break;
      }
    }
    assert.ok(end > start, `could not delimit the env-key object in ${name}`);
    const literal = source.slice(start, end);
    const map = new Map();
    for (const [, , id, variable] of literal.matchAll(/("?)([a-z0-9.\-]+)\1\s*:\s*"([A-Z0-9_]+)"/g))
      map.set(id, variable);
    return { map, source: source.slice(at, at + 400), file: name };
  }
  assert.fail("getApiKeyEnvVars was not found in the pinned package");
}

/* ================================================ T1: unknown providers refuse ================= */

test("T1 an unknown provider is refused by name, and the refusal says nothing is inferred", () => {
  const e = refusalFrom(() => resolveProviderCredentials("anthropic-proxy"), CONTRACT_REFUSAL.UNSUPPORTED);
  assert.match(e.message, /anthropic-proxy/, "the refusal must name the provider");
  assert.equal(e.detail.provider, "anthropic-proxy");
  assert.match(e.message, /never searched|not inferred|No variable name is inferred/i);
});

test("T1 a real Pi provider with no safe mapping is refused with the reason recorded beside it", () => {
  // ⚠️ AN EXPLICIT DECISION, NOT A GAP. Bedrock authenticates through the AWS credential chain, and
  // `getApiKeyEnvVars("amazon-bedrock")` returns nothing in the pinned package either.
  for (const id of Object.keys(UNSUPPORTED_PROVIDERS)) {
    const e = refusalFrom(() => resolveProviderCredentials(id), CONTRACT_REFUSAL.UNSUPPORTED);
    assert.match(e.message, new RegExp(id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.ok(e.detail.why && e.detail.why.length > 40, `${id} must carry why it was declined`);
  }
  assert.ok(!("amazon-bedrock" in PROVIDER_CREDENTIALS), "a declined provider must not also be in the table");
  assert.ok(!("azure-openai" in PROVIDER_CREDENTIALS));
});

test("T1 a near miss on a supported id is refused rather than resolved to its neighbour", () => {
  // ⚠️ CASE AND SEPARATOR VARIANTS ARE THE TYPOS AN OPERATOR ACTUALLY MAKES, and a lenient lookup
  // would hand them the neighbour's credential.
  for (const id of ["Anthropic", "ANTHROPIC", "open_ai", "openai ", "kimi_coding", "llama-cpp", "llama"])
    refusalFrom(() => resolveProviderCredentials(id), CONTRACT_REFUSAL.UNSUPPORTED);
  for (const id of [null, undefined, "", 42, {}])
    refusalFrom(() => resolveProviderCredentials(id), CONTRACT_REFUSAL.UNSUPPORTED);
});

test("T1 a custom declaration cannot redefine a built-in provider", () => {
  // ⚠️ THE AUDITED TABLE UNDONE BY ITS OWN EXTENSION MECHANISM would be the quietest possible defect:
  // `anthropic` pointed at a variable the operator chose, with every test still green.
  const contract = resolveProviderCredentials("anthropic", { custom: { id: "anthropic", apiKey: "$MY_OWN_KEY" } });
  assert.deepEqual([...contract.anyOf[0]], ["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_OAUTH_TOKEN", "ANTHROPIC_API_KEY"]);
  assert.ok(!declaredNames(contract).includes("MY_OWN_KEY"), "the declaration must not reach a known provider");
});

test("T1 a declaration for a different id than the one being resolved is refused", () => {
  const e = refusalFrom(
    () => resolveProviderCredentials("mine", { custom: { id: "theirs", apiKey: "$THEIR_KEY" } }),
    CONTRACT_REFUSAL.UNSUPPORTED
  );
  assert.equal(e.detail.declared, "theirs");
});

/* ================================================ T2: no name is derived from an id ============= */

/** The obvious deriver, and the mutation this table exists to defeat. */
const guess = (id) => `${id.toUpperCase().replace(/[-.]/g, "_")}_API_KEY`;

test("⚠️ T2 no variable name is derived from a provider id", () => {
  // ⚠️ **THE TRAP IS THAT A DERIVER LOOKS RIGHT ON THE COMMON CASES.** `openai`, `groq`, `mistral`
  // and a dozen others come out correct, so a positive-only suite passes against it. These are the
  // ids where it is wrong, and each is a real provider whose variable no rule produces.
  const undeducible = {
    moonshotai: "MOONSHOT_API_KEY",
    "moonshotai-cn": "MOONSHOT_API_KEY",
    huggingface: "HF_TOKEN",
    "github-copilot": "COPILOT_GITHUB_TOKEN",
    "kimi-coding": "KIMI_API_KEY",
    google: "GEMINI_API_KEY",
    "google-vertex": "GOOGLE_CLOUD_API_KEY",
    "vercel-ai-gateway": "AI_GATEWAY_API_KEY",
    "opencode-go": "OPENCODE_API_KEY",
    "azure-openai-responses": "AZURE_OPENAI_API_KEY",
    "qwen-token-plan-individual": "QWEN_TOKEN_PLAN_API_KEY",
    "llama.cpp": "LLAMA_BASE_URL",
  };

  for (const [id, expected] of Object.entries(undeducible)) {
    const names = declaredNames(resolveProviderCredentials(id));
    assert.ok(names.includes(expected), `${id} must declare ${expected}, got ${names.join(", ")}`);
    assert.notEqual(guess(id), expected, `${id} would be a bad witness: the deriver happens to be right`);
    assert.ok(!names.includes(guess(id)), `${id} must not declare the derived ${guess(id)}`);
  }

  // ⚠️ AND THE DERIVER'S OUTPUT MUST NOT BE ACCEPTED AS AN ID EITHER. `moonshot` is not a provider,
  // but `MOONSHOT_API_KEY` exists — so a deriver fed the wrong id produces a name that looks correct.
  refusalFrom(() => resolveProviderCredentials("moonshot"), CONTRACT_REFUSAL.UNSUPPORTED);
  refusalFrom(() => resolveProviderCredentials("copilot"), CONTRACT_REFUSAL.UNSUPPORTED);
  refusalFrom(() => resolveProviderCredentials("gemini"), CONTRACT_REFUSAL.UNSUPPORTED);
});

test("T2 the table is not a bijection, so nothing may key it by variable name", () => {
  // ⚠️ THREE VARIABLES SERVE TWO PROVIDERS EACH. A reverse index would silently drop one of each pair.
  const byName = new Map();
  for (const id of supportedProviders())
    for (const name of PROVIDER_CREDENTIALS[id].required) byName.set(name, [...(byName.get(name) ?? []), id]);

  const shared = [...byName.entries()].filter(([, ids]) => ids.length > 1);
  assert.ok(shared.length >= 3, `expected shared variables, found ${JSON.stringify(shared)}`);
  assert.deepEqual(byName.get("MOONSHOT_API_KEY"), ["moonshotai", "moonshotai-cn"]);
  assert.deepEqual(byName.get("OPENCODE_API_KEY"), ["opencode", "opencode-go"]);
  assert.deepEqual(byName.get("QWEN_TOKEN_PLAN_API_KEY"), ["qwen-token-plan", "qwen-token-plan-individual"]);
});

/* ================================================ T3: the environment is never read ============= */

test("⚠️ T3 the module does not read the environment, structurally", () => {
  // ⚠️ THE BEHAVIOURAL TEST BELOW CANNOT PROVE THIS ON ITS OWN: an implementation that scanned the
  // environment and happened to find nothing would pass it. This reads the source.
  const source = readFileSync(MODULE_PATH, "utf-8");
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  assert.ok(!/process\s*\.\s*env/.test(code), "the table must never reference process.env");
  assert.ok(!/readFileSync|readdirSync|execSync|spawn/.test(code), "nor read the filesystem or spawn anything");
});

test("⚠️ T3 the answer does not change when the environment does", () => {
  const decoys = {
    ACME_API_KEY: "acme-live-0000",
    SOMETHING_TOKEN: "tok-0000",
    ANTHROPIC_API_KEY: "sk-ant-decoy-value",
    MY_OWN_KEY: "should-never-appear",
  };
  const saved = Object.fromEntries(Object.keys(decoys).map((k) => [k, process.env[k]]));

  const ids = supportedProviders();
  const before = ids.map((id) => JSON.stringify(resolveProviderCredentials(id)));
  try {
    Object.assign(process.env, decoys);
    const during = ids.map((id) => JSON.stringify(resolveProviderCredentials(id)));
    assert.deepEqual(during, before, "a populated environment must not change one byte of the contract");

    // And an unknown provider still refuses even though a plausible-looking key is now present.
    refusalFrom(() => resolveProviderCredentials("acme"), CONTRACT_REFUSAL.UNSUPPORTED);
  } finally {
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k];
      else process.env[k] = v;
  }

  const after = ids.map((id) => JSON.stringify(resolveProviderCredentials(id)));
  assert.deepEqual(after, before);
});

/* ================================================ T4: no value ever leaves ====================== */

test("⚠️ T4 no credential value appears in any return, refusal or declared name", () => {
  const SECRET = "sk-ant-thisexactstringmustnotescape";
  const saved = process.env.ANTHROPIC_API_KEY;
  try {
    process.env.ANTHROPIC_API_KEY = SECRET;

    for (const id of supportedProviders()) {
      const contract = resolveProviderCredentials(id);
      const serialised = JSON.stringify(contract);
      assert.ok(!serialised.includes(SECRET), `${id} leaked a value: ${serialised}`);
      // ⚠️ NAMES ONLY, and the grammar is asserted rather than eyeballed: anything lowercase would be
      // a value or a path that had found its way in.
      for (const name of declaredNames(contract))
        assert.match(name, /^[A-Z][A-Z0-9_]*$/, `${id} declares something that is not a variable name: ${name}`);
      assert.ok(contract.authSources.length > 0, `${id} must declare how it can be authenticated`);
      for (const source of contract.authSources)
        assert.ok(Object.values(AUTH_SOURCE).includes(source), `${id} declares an unknown auth source: ${source}`);
    }

    // A refusal must not carry it either — the one place a careless implementation would echo it.
    const e = refusalFrom(() => resolveProviderCredentials("unknown-thing"), CONTRACT_REFUSAL.UNSUPPORTED);
    assert.ok(!e.message.includes(SECRET) && !JSON.stringify(e.detail).includes(SECRET));
  } finally {
    if (saved === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = saved;
  }
});

test("T4 there is no ambient-chain category, and no contract claims one", () => {
  // ⚠️ DEC: the supported categories are stored auth, explicit environment keys, and validated custom
  // declarations. A fourth would be the widening ACC-0058 forbids, dressed as a feature.
  assert.deepEqual(Object.values(AUTH_SOURCE).sort(), ["custom-environment-key", "environment-key", "stored"]);
  // ⚠️ **A NAME BELONGING TO AN EXCLUDED BRANCH IS THE MILDEST FORM OF THE WIDENING.** `google-vertex`
  // carried `GOOGLE_CLOUD_PROJECT` and `GOOGLE_CLOUD_LOCATION` as optional names, which configure the
  // ADC branch — so the entry described two routes while claiming to support one. They are named here
  // rather than left to the exact table below, because the rule is standing: no future entry may
  // reintroduce them either.
  const ambient = ["GOOGLE_APPLICATION_CREDENTIALS", "GOOGLE_CLOUD_PROJECT", "GOOGLE_CLOUD_LOCATION"];
  for (const id of supportedProviders())
    for (const name of declaredNames(PROVIDER_CREDENTIALS[id]))
      assert.ok(
        !/^AWS_/.test(name) && !ambient.includes(name),
        `${id} declares ${name}, which belongs to an ambient credential chain`
      );
});

/* ================================================ T5: custom declarations ======================= */

test("T5 a complete variable reference is the only accepted spelling", () => {
  assert.deepEqual(readDeclaredName("$MY_KEY"), { name: "MY_KEY" });
  assert.deepEqual(readDeclaredName("${MY_KEY}"), { name: "MY_KEY" });

  const contract = validateCustomDeclaration({ id: "acme", apiKey: "$ACME_KEY", optional: ["${ACME_REGION}"] });
  assert.deepEqual(contract.authSources, [AUTH_SOURCE.CUSTOM_ENVIRONMENT_KEY]);
  assert.deepEqual([...contract.required], ["ACME_KEY"]);
  assert.deepEqual([...contract.optional], ["ACME_REGION"]);
  assert.deepEqual(resolveProviderCredentials("acme", { custom: { id: "acme", apiKey: "$ACME_KEY" } }).required, [
    "ACME_KEY",
  ]);
});

test("⚠️ T5 every rejected spelling is rejected for its own stated reason", () => {
  // ⚠️ **PI'S `apiKey` GRAMMAR ACCEPTS ALL OF THESE, WHICH IS WHY EACH NEEDS ITS OWN CASE.** A command
  // produces a value by executing something; a bare uppercase word is a LITERAL by Pi's own rule, so
  // accepting it would read an operator's typo as a name; and a partially interpolated string denotes
  // a value assembled from names, with no single name to declare.
  const cases = {
    "!security find-generic-password -ws anthropic": DECLARATION_PROBLEM.COMMAND,
    "!op read op://vault/item/credential": DECLARATION_PROBLEM.COMMAND,
    MY_API_KEY: DECLARATION_PROBLEM.LITERAL,
    "sk-ant-abc123": DECLARATION_PROBLEM.LITERAL,
    ollama: DECLARATION_PROBLEM.LITERAL,
    "${KEY_PREFIX}_${KEY_SUFFIX}": DECLARATION_PROBLEM.MULTIPLE_VARIABLES,
    "$A$B": DECLARATION_PROBLEM.MULTIPLE_VARIABLES,
    "prefix-$MY_KEY": DECLARATION_PROBLEM.PARTIAL_INTERPOLATION,
    "$MY_KEY-suffix": DECLARATION_PROBLEM.PARTIAL_INTERPOLATION,
    "$my_key": DECLARATION_PROBLEM.NAME_GRAMMAR,
    "$1KEY": DECLARATION_PROBLEM.NAME_GRAMMAR,
    "$": DECLARATION_PROBLEM.NAME_GRAMMAR,
    "$PI_CODING_AGENT_DIR": DECLARATION_PROBLEM.RESERVED_PREFIX,
    "$PI_ANYTHING": DECLARATION_PROBLEM.RESERVED_PREFIX,
  };

  for (const [expression, problem] of Object.entries(cases)) {
    assert.deepEqual(readDeclaredName(expression), { problem }, `${expression} must fail as ${problem}`);
    const e = refusalFrom(
      () => validateCustomDeclaration({ id: "acme", apiKey: expression }),
      CONTRACT_REFUSAL.DECLARATION_INVALID
    );
    assert.equal(e.detail.problem, problem);
    // ⚠️ **THE REFUSAL NAMES THE PROBLEM, NEVER THE VALUE**, since the rejected spelling may BE a
    // credential (`sk-ant-...`) or a command that fetches one. Very short expressions are exempt: a
    // bare `"$"` is a substring of the guidance text `$NAME`, which is not an echo of anything.
    if (expression.length >= 5)
      assert.ok(!e.message.includes(expression), `the refusal must not echo the declared value: ${e.message}`);
  }

  for (const bad of [null, undefined, 42, {}, []])
    assert.deepEqual(readDeclaredName(bad), { problem: DECLARATION_PROBLEM.NOT_A_STRING });
});

test("T5 a malformed declaration shape is refused, and a duplicate name with it", () => {
  for (const bad of [null, "a string", [], 42])
    refusalFrom(() => validateCustomDeclaration(bad), CONTRACT_REFUSAL.DECLARATION_INVALID);
  refusalFrom(() => validateCustomDeclaration({ apiKey: "$K" }), CONTRACT_REFUSAL.DECLARATION_INVALID);
  refusalFrom(() => validateCustomDeclaration({ id: "", apiKey: "$K" }), CONTRACT_REFUSAL.DECLARATION_INVALID);
  refusalFrom(
    () => validateCustomDeclaration({ id: "acme", apiKey: "$K", optional: "$L" }),
    CONTRACT_REFUSAL.DECLARATION_INVALID
  );

  const dup = refusalFrom(
    () => validateCustomDeclaration({ id: "acme", apiKey: "$K", optional: ["$K"] }),
    CONTRACT_REFUSAL.DECLARATION_INVALID
  );
  assert.equal(dup.detail.problem, DECLARATION_PROBLEM.DUPLICATE_NAME);
});

test("⚠️ T5 an invalid declaration makes the PROVIDER unsupported, under ACC-0058's reason", () => {
  // ⚠️ A declaration that failed validation is not a declaration, so from the resolver's side the
  // provider is one "neither built in nor declared through the validated custom shape" — which is the
  // reason ACC-0058 names. The underlying problem still travels, or the diagnosis would be lost.
  const e = refusalFrom(
    () => resolveProviderCredentials("acme", { custom: { id: "acme", apiKey: "!op read secret" } }),
    CONTRACT_REFUSAL.UNSUPPORTED
  );
  assert.equal(e.detail.provider, "acme");
  assert.equal(e.detail.declarationProblem, DECLARATION_PROBLEM.COMMAND);
});

/* ================================================ the exact declared names ===================== */

/**
 * Every supported provider and the complete, ordered list of names it declares.
 *
 * ⚠️ **EXACT, BECAUSE MEMBERSHIP ASSERTIONS CANNOT SEE AN ADDITION.** The tests above check that a
 * provider declares the name it must; none of them notice a name that should not be there. That is
 * exactly how `google-vertex` carried two ADC variables through a green suite and a green four-cell
 * CI run. A frozen list fails on an addition, a removal and a reordering alike, so a change to the
 * audited surface has to be made deliberately here.
 *
 * ⚠️ **AND IT IS A PIN, NOT A DERIVATION.** Generating this from the module would assert the module
 * against itself. Each row was read back against its source: the 36 single-key rows against the
 * `envVar` literal inside `getApiKeyEnvVars`, `anthropic` and `github-copilot` against the two
 * branches above it, the Azure and Cloudflare companions against the provider table in
 * `docs/providers.md`, and `llama.cpp` against `dist/extensions/llama/provider.js` with
 * `docs/llama-cpp.md`.
 */
const EXACT_DECLARED_NAMES = Object.freeze({
    "ant-ling": ["ANT_LING_API_KEY"],
    anthropic: ["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_OAUTH_TOKEN", "ANTHROPIC_API_KEY"],
    "azure-openai-responses": [
      "AZURE_OPENAI_API_KEY",
      "AZURE_OPENAI_BASE_URL",
      "AZURE_OPENAI_RESOURCE_NAME",
      "AZURE_OPENAI_API_VERSION",
      "AZURE_OPENAI_DEPLOYMENT_NAME_MAP",
    ],
    baseten: ["BASETEN_API_KEY"],
    cerebras: ["CEREBRAS_API_KEY"],
    "cloudflare-ai-gateway": ["CLOUDFLARE_API_KEY", "CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_GATEWAY_ID"],
    "cloudflare-workers-ai": ["CLOUDFLARE_API_KEY", "CLOUDFLARE_ACCOUNT_ID"],
    deepseek: ["DEEPSEEK_API_KEY"],
    fireworks: ["FIREWORKS_API_KEY"],
    "github-copilot": ["COPILOT_GITHUB_TOKEN"],
    google: ["GEMINI_API_KEY"],
    "google-vertex": ["GOOGLE_CLOUD_API_KEY"],
    groq: ["GROQ_API_KEY"],
    huggingface: ["HF_TOKEN"],
    "kimi-coding": ["KIMI_API_KEY"],
    "llama.cpp": ["LLAMA_BASE_URL", "LLAMA_API_KEY"],
    minimax: ["MINIMAX_API_KEY"],
    "minimax-cn": ["MINIMAX_CN_API_KEY"],
    mistral: ["MISTRAL_API_KEY"],
    moonshotai: ["MOONSHOT_API_KEY"],
    "moonshotai-cn": ["MOONSHOT_API_KEY"],
    nvidia: ["NVIDIA_API_KEY"],
    openai: ["OPENAI_API_KEY"],
    opencode: ["OPENCODE_API_KEY"],
    "opencode-go": ["OPENCODE_API_KEY"],
    openrouter: ["OPENROUTER_API_KEY"],
    "qwen-token-plan": ["QWEN_TOKEN_PLAN_API_KEY"],
    "qwen-token-plan-cn": ["QWEN_TOKEN_PLAN_CN_API_KEY"],
    "qwen-token-plan-individual": ["QWEN_TOKEN_PLAN_API_KEY"],
    radius: ["RADIUS_API_KEY"],
    together: ["TOGETHER_API_KEY"],
    "vercel-ai-gateway": ["AI_GATEWAY_API_KEY"],
    xai: ["XAI_API_KEY"],
    xiaomi: ["XIAOMI_API_KEY"],
    "xiaomi-token-plan-ams": ["XIAOMI_TOKEN_PLAN_AMS_API_KEY"],
    "xiaomi-token-plan-cn": ["XIAOMI_TOKEN_PLAN_CN_API_KEY"],
    "xiaomi-token-plan-sgp": ["XIAOMI_TOKEN_PLAN_SGP_API_KEY"],
    zai: ["ZAI_API_KEY"],
    "zai-coding-cn": ["ZAI_CODING_CN_API_KEY"],
});

test("⚠️ the declared names are exactly these, for exactly these providers", () => {
  assert.deepEqual(supportedProviders(), Object.keys(EXACT_DECLARED_NAMES).sort(), "the provider set is exact");

  for (const [id, expected] of Object.entries(EXACT_DECLARED_NAMES))
    assert.deepEqual(declaredNames(resolveProviderCredentials(id)), expected, `${id} declares exactly these names`);

  // ⚠️ AND THE STRUCTURE BEHIND THE FLAT LIST, for the two entries where it is not a flat list. An
  // `anyOf` collapsed into `required` would report Anthropic as needing all three credentials at once.
  assert.deepEqual([...PROVIDER_CREDENTIALS.anthropic.required], []);
  assert.equal(PROVIDER_CREDENTIALS.anthropic.anyOf.length, 1);
  assert.deepEqual([...PROVIDER_CREDENTIALS["azure-openai-responses"].required], ["AZURE_OPENAI_API_KEY"]);
  assert.deepEqual(
    [...PROVIDER_CREDENTIALS["azure-openai-responses"].anyOf[0]],
    ["AZURE_OPENAI_BASE_URL", "AZURE_OPENAI_RESOURCE_NAME"]
  );
});

test("⚠️ google-vertex declares the API-key branch and nothing from the ADC branch", () => {
  // ⚠️ ITS OWN TEST BECAUSE IT WAS ITS OWN DEFECT. The key route is what Pi's env-key map supports;
  // project and location belong to Application Default Credentials, which is excluded, so declaring
  // them amounted to claiming a route this table does not support.
  const contract = resolveProviderCredentials("google-vertex");
  assert.deepEqual(declaredNames(contract), ["GOOGLE_CLOUD_API_KEY"]);
  assert.deepEqual([...contract.optional], [], "no optional names, since the key is the whole contract");
  assert.deepEqual([...contract.anyOf], []);
});

/* ================================================ F19: unknown properties ====================== */

test("⚠️ F19 a property beyond the accepted shape is refused, not silently dropped", () => {
  // ⚠️ **THESE ARE THE PROPERTIES AN OPERATOR WILL ACTUALLY PASTE.** A `models.json` provider block
  // carries `baseUrl`, `api`, `headers` and `authHeader`, so someone copying one in has every reason
  // to expect them to matter. Dropping them without a word lets a declaration that reads as
  // "authenticate with this header" load as "authenticate with this variable name".
  for (const extra of [
    { baseUrl: "https://api.example.com" },
    { api: "openai-completions" },
    { headers: { Authorization: "Bearer x" } },
    { authHeader: true },
    { key: "sk-literal-credential" },
    { env: { SOME_NAME: "some-value" } },
    { models: [] },
    { optionals: ["$OTHER"] },
  ]) {
    const e = refusalFrom(
      () => validateCustomDeclaration({ id: "acme", apiKey: "$ACME_KEY", ...extra }),
      CONTRACT_REFUSAL.DECLARATION_INVALID
    );
    assert.equal(e.detail.problem, DECLARATION_PROBLEM.UNKNOWN_PROPERTY, JSON.stringify(extra));
    assert.equal(e.detail.unknownCount, 1);
  }

  // ⚠️ `optionals` IS IN THAT LIST ON PURPOSE: a near miss on `optional` would otherwise be dropped,
  // and the operator's optional names would silently not exist.

  const many = refusalFrom(
    () => validateCustomDeclaration({ id: "acme", apiKey: "$ACME_KEY", baseUrl: "u", headers: {}, key: "k" }),
    CONTRACT_REFUSAL.DECLARATION_INVALID
  );
  assert.equal(many.detail.unknownCount, 3);
  assert.match(many.message, /id, apiKey, optional/, "the refusal must state the accepted shape");
});

test("⚠️ F19 the refusal names neither the property nor its value", () => {
  // ⚠️ **ONE OF THEM MAY BE THE CREDENTIAL.** A `key` property holding a literal secret, or a header
  // naming an internal host, would reach every log this refusal reaches. The count and the accepted
  // shape are what an operator needs; the offending content is not.
  const PROP = "zzUnexpectedProperty";
  const VALUE = "zz-secret-value-must-not-escape";
  const e = refusalFrom(
    () => validateCustomDeclaration({ id: "acme", apiKey: "$ACME_KEY", [PROP]: VALUE }),
    CONTRACT_REFUSAL.DECLARATION_INVALID
  );

  const everything = `${e.message} ${JSON.stringify(e.detail)}`;
  assert.ok(!everything.includes(PROP), `the property name must not be echoed: ${everything}`);
  assert.ok(!everything.includes(VALUE), `the property value must not be echoed: ${everything}`);
  assert.ok(!everything.includes("zz"), "nor any fragment of either");
  // What it must say instead.
  assert.match(e.message, /acme/, "the provider id is the one identifier it does name");
  assert.match(e.message, /1 property/, "and how many were rejected");
});

test("F19 the accepted shape still passes, with and without the optional array", () => {
  assert.deepEqual([...validateCustomDeclaration({ id: "a", apiKey: "$A_KEY" }).optional], []);
  assert.deepEqual(
    [...validateCustomDeclaration({ id: "a", apiKey: "$A_KEY", optional: ["$A_REGION"] }).optional],
    ["A_REGION"]
  );
  // ⚠️ AND AN UNKNOWN PROPERTY MAKES THE PROVIDER UNSUPPORTED THROUGH THE RESOLVER, like every other
  // declaration failure — ACC-0058's reason, with the problem preserved.
  const e = refusalFrom(
    () => resolveProviderCredentials("acme", { custom: { id: "acme", apiKey: "$ACME_KEY", baseUrl: "u" } }),
    CONTRACT_REFUSAL.UNSUPPORTED
  );
  assert.equal(e.detail.declarationProblem, DECLARATION_PROBLEM.UNKNOWN_PROPERTY);
});

/* ================================================ T6: agreement with the pinned package ========= */

test("⚠️ T6 the table agrees with the pinned Pi package, or this fails on the version bump", () => {
  const { map, source, file } = pinnedEnvKeyMap();
  assert.ok(map.size > 30, `expected the env-key map, parsed ${map.size} entries from ${file}`);

  // The two special cases are not in the object literal; they are branches above it.
  assert.match(source, /provider==="github-copilot"\)return\["COPILOT_GITHUB_TOKEN"\]/);
  assert.match(source, /provider==="anthropic"\)return\[ANTHROPIC_AUTH_TOKEN_ENV,ANTHROPIC_OAUTH_TOKEN_ENV,ANTHROPIC_API_KEY_ENV\]/);

  // ⚠️ EVERY ID PI MAPS IS EITHER SUPPORTED OR EXPLICITLY DECLINED. A new provider in a later Pi is
  // then a failure here rather than a silent omission from an "audited" table.
  for (const [id, variable] of map) {
    if (id in UNSUPPORTED_PROVIDERS) continue;
    const contract = PROVIDER_CREDENTIALS[id];
    assert.ok(contract, `${id} is in Pi's env-key map and is neither in the table nor declined`);
    assert.ok(
      declaredNames(contract).includes(variable),
      `${id} maps to ${variable} in the pinned package; the table declares ${declaredNames(contract).join(", ")}`
    );
  }

  // ⚠️ AND IN THE OTHER DIRECTION: a table entry claiming to be Pi-mapped must actually be mapped, so
  // a hand-added row cannot pass itself off as audited.
  for (const id of supportedProviders()) {
    const contract = PROVIDER_CREDENTIALS[id];
    if (!contract.piMapped) {
      assert.ok(!map.has(id), `${id} is marked piMapped: false but the pinned package does map it`);
      continue;
    }
    if (id === "anthropic" || id === "github-copilot") continue; // branches, asserted above
    assert.ok(map.has(id), `${id} claims to come from Pi's env-key map and is not in it`);
  }

  assert.equal(PROVIDER_CREDENTIALS["llama.cpp"].piMapped, false, "the extension provider is not in the map");
});
