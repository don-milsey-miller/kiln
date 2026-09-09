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
  for (const id of supportedProviders())
    for (const name of declaredNames(PROVIDER_CREDENTIALS[id]))
      assert.ok(
        !/^AWS_/.test(name) && name !== "GOOGLE_APPLICATION_CREDENTIALS",
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
