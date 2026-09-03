/**
 * The five persisted runtime records — schemas, and the rules that are load-bearing in them.
 *
 * ⚠️ **THESE ARE CONTRACTS, NOT CONFIGURATION.** Kiln invents, writes, versions and reads all five,
 * so a shape nobody validates is a comment. `.pi/settings.json` is the opposite case and is
 * deliberately NOT the precedent: Pi owns that file, the operator may hand-edit it, and Kiln merges
 * four keys into it defensively.
 *
 * ⚠️ **THE TESTS THAT MATTER MOST ARE THE REFUSALS.** Every one of these files is a place an
 * absolute home path, a credential or a fingerprint could plausibly end up, and REQ-0024 forbids all
 * three. A schema that only accepts good documents has not been shown to reject bad ones.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";

import {
  COMPATIBILITY_KEY_FIELDS,
  EndpointIdentityError,
  RUNTIME_RECORDS,
  RUNTIME_SCHEMAS_DIR,
  RequestProfileError,
  SCALAR_COMPAT_FIELDS,
  STRUCTURED_COMPAT_FIELDS,
  UNBOUNDED_COMPAT_FIELDS,
  assertValidRecord,
  canonicalizeEndpoint,
  createRuntimeValidators,
  generateProjectId,
  projectRequestProfile,
} from "../lib/runtime-records.mjs";
import { ValidationError } from "../lib/validate.mjs";
import { loadSchemaSet } from "../lib/schema-resolver.mjs";
import { createValidators } from "../lib/validate.mjs";

const validators = createRuntimeValidators();
const ok = (kind, doc) => assertValidRecord(validators, kind, doc);
const rejects = (kind, doc, why) =>
  assert.throws(() => assertValidRecord(validators, kind, doc), ValidationError, why);

const PROJECT_ID = "0123456789abcdef0123456789abcdef";
const NOW = "2026-09-03T10:00:00.000Z";

/* ================================================================ the two sets stay apart ====== */

test("the runtime schemas are invisible to the artifact loader, and vice versa", () => {
  // ⚠️ NOT A TIDINESS CHECK. `loadSchemaSet` refuses any `*.schema.json` in its directory that has
  // no `x-artifactType`; putting these files beside the artifact schemas would have broken every
  // caller of it. The separation is what makes both sets loadable at once.
  const artifacts = loadSchemaSet(join(RUNTIME_SCHEMAS_DIR, "..")); // schemas/
  assert.ok(Object.keys(artifacts.types).length > 0, "the artifact set must still load");
  for (const name of Object.keys(artifacts.types))
    assert.ok(!(name in RUNTIME_RECORDS), `${name} appears in both sets`);

  assert.ok(Object.keys(createValidators(join(RUNTIME_SCHEMAS_DIR, "..")).length ?? {}) !== undefined);
  for (const s of Object.values(artifacts.types)) assert.ok(!s["x-runtimeRecord"]);
});

test("every declared record has a schema, and every schema has a record entry", () => {
  assert.deepEqual(
    Object.keys(validators).sort(),
    Object.keys(RUNTIME_RECORDS).sort(),
    "the declared record set and the compiled schemas must agree"
  );
});

test("every runtime schema declares where it lives and whether it is committed", () => {
  for (const f of readdirSync(RUNTIME_SCHEMAS_DIR).filter((n) => n.endsWith(".schema.json"))) {
    if (f === "runtime-common.schema.json") continue;
    const s = JSON.parse(readFileSync(join(RUNTIME_SCHEMAS_DIR, f), "utf-8"));
    assert.ok(s["x-location"], `${f} does not say where the record lives`);
    assert.equal(typeof s["x-committed"], "boolean", `${f} does not say whether it is committed`);
    assert.equal(
      s["x-committed"],
      RUNTIME_RECORDS[s["x-runtimeRecord"]].committed,
      `${f} disagrees with RUNTIME_RECORDS about whether it is committed`
    );
  }
});

/* ================================================================ kiln-project (committed) ===== */

test("the committed project record accepts a project id and a research choice, and nothing else", () => {
  ok("kiln-project", { recordVersion: 1, projectId: PROJECT_ID });
  ok("kiln-project", { recordVersion: 1, projectId: PROJECT_ID, research: { provider: "tavily" } });
  ok("kiln-project", { recordVersion: 1, projectId: PROJECT_ID, research: { provider: "none" } });

  // ⚠️ THE REFUSALS ARE THE POINT: this file reaches every clone, so anything host-specific or
  // secret in it is a disclosure rather than an untidiness.
  rejects("kiln-project", { recordVersion: 1, projectId: PROJECT_ID, tavilyApiKey: "tvly-x" },
    "a credential must not be accepted in a committed file");
  rejects("kiln-project", { recordVersion: 1, projectId: PROJECT_ID, consent: { granted: true } },
    "consent is host-specific and must not reach a clone");
  rejects("kiln-project", { recordVersion: 1, projectId: PROJECT_ID, stateRoot: "C:/Users/someone/AppData" },
    "an absolute path must not be accepted");
  rejects("kiln-project", { recordVersion: 1, projectId: "NOT-HEX" }, "the id shape is fixed");
  rejects("kiln-project", { recordVersion: 1, projectId: PROJECT_ID.toUpperCase() },
    "uppercase would make the derived directory name case-dependent");
  rejects("kiln-project", { recordVersion: 1 }, "a project record without an id identifies nothing");
  rejects("kiln-project", { recordVersion: 1, projectId: PROJECT_ID, research: { provider: "brave" } },
    "an unknown research provider is not a choice this project can express");
});

test("a generated project id satisfies its own schema and is not derived from anything", () => {
  const a = generateProjectId(randomBytes);
  const b = generateProjectId(randomBytes);
  ok("kiln-project", { recordVersion: 1, projectId: a });
  assert.notEqual(a, b, "the id must not be derived from the project, which does not change between calls");
});

/* ================================================================ consent (ignored) ============ */

const GRANT = { granted: true, decidedAt: NOW };

test("consent records three separate grants, each dated, and refuses credential material", () => {
  ok("consent", { recordVersion: 1, inspection: GRANT });
  ok("consent", {
    recordVersion: 1,
    inspection: GRANT,
    modelUse: { ...GRANT, provider: "openai", model: "gpt-5" },
    research: { ...GRANT, provider: "tavily" },
  });

  // ⚠️ A REFUSAL IS A RECORDED DECISION. Treating `granted: false` as "not yet asked" is how a
  // declined prompt becomes one that reappears every launch until somebody clicks through it.
  ok("consent", { recordVersion: 1, inspection: { granted: false, decidedAt: NOW } });

  rejects("consent", { recordVersion: 1, inspection: { granted: true } },
    "consent that cannot be dated cannot be audited or expired");
  rejects("consent", { recordVersion: 1, inspection: { ...GRANT, apiKey: "sk-live" } },
    "the record says what was permitted, never what was found");
  rejects("consent", { recordVersion: 1, modelUse: GRANT },
    "a model grant that names no model authorises nothing in particular");
  rejects("consent", { recordVersion: 1, research: { ...GRANT, provider: "tavily", credentialDigest: "sha256:" + "a".repeat(64) } },
    "a credential-derived fingerprint is forbidden by section 3.12");
});

/* ================================================================ setup-transaction (ignored) == */

const JOURNAL = {
  recordVersion: 1,
  operation: "setup",
  startedAt: NOW,
  phases: [{ name: "initialize-content", status: "complete" }, { name: "install-dependencies", status: "running" }],
};

test("the journal records the whole plan, file identities, and an exact resume command", () => {
  ok("setup-transaction", JOURNAL);
  ok("setup-transaction", {
    ...JOURNAL,
    lastCompletedPhase: "initialize-content",
    fileIdentities: [
      { path: ".pi/settings.json", state: "present", digest: "sha256:" + "b".repeat(64) },
      { path: ".pi/kiln.json", state: "absent" },
    ],
    recovery: { command: "node .planning/bin/setup.mjs --project-root . --resume", reason: "interrupted during install" },
  });

  // ⚠️ PRESENT-WITH-DIGEST AND ABSENT-WITHOUT ARE PAIRED IN THE SCHEMA. Either half alone makes the
  // comparison meaningless: a present file with no digest cannot be compared, and an absent one
  // with a digest is claiming to have hashed nothing.
  rejects("setup-transaction", { ...JOURNAL, fileIdentities: [{ path: ".pi/settings.json", state: "present" }] },
    "a present file must carry the digest it will be compared against");
  rejects("setup-transaction", { ...JOURNAL, fileIdentities: [{ path: "x", state: "absent", digest: "sha256:" + "c".repeat(64) }] },
    "an absent file cannot have a digest");

  // Absolute and traversing paths are refused by the schema, not by a reviewer.
  for (const bad of ["C:/Users/someone/.pi/settings.json", "/home/someone/x", "\\\\server\\share\\x", "../outside", "a/../../b"])
    rejects("setup-transaction", { ...JOURNAL, fileIdentities: [{ path: bad, state: "absent" }] }, `path must be refused: ${bad}`);

  rejects("setup-transaction", { ...JOURNAL, phases: [] }, "a journal with no plan cannot say what was meant to happen next");
  rejects("setup-transaction", { ...JOURNAL, phases: [{ name: "x", status: "half" }] }, "an unknown phase status");
});

test("`running` is a persisted phase state, because a killed process leaves one", () => {
  // It is what distinguishes "never started" from "may have half-happened", which decides whether
  // recovery can simply rerun the phase.
  ok("setup-transaction", { ...JOURNAL, phases: [{ name: "install-dependencies", status: "running" }] });
});

/* ================================================================ kiln-session (ignored) ======= */

const SESSION = { recordVersion: 1, projectId: PROJECT_ID, sessionId: "01a0647c-236e-7275", stateMode: "project" };

test("the session record names a mode, never a path, and carries the project it belongs to", () => {
  ok("kiln-session", SESSION);
  ok("kiln-session", { ...SESSION, stateMode: "user", startedAt: NOW, lastResumedAt: NOW });

  rejects("kiln-session", { ...SESSION, sessionDir: "C:/Users/someone/AppData/Local/Kiln" },
    "a resolved state directory is an absolute user path and must not be stored");
  rejects("kiln-session", { ...SESSION, stateMode: "external" }, "the mode vocabulary is fixed");
  rejects("kiln-session", { recordVersion: 1, sessionId: "x", stateMode: "project" },
    "a session record that cannot be disowned would be resumed into the wrong project");
});


/* ================================================================ model-compatibility ========== */

const COMPAT_KEY = {
  provider: "openai",
  model: "gpt-5",
  thinkingLevel: "high",
  piVersion: "0.84.4",
  apiType: "openai-completions",
  endpointIdentity: { scheme: "https", hostname: "api.openai.com", port: 443, pathname: "/v1" },
  endpointIdentitySource: "derived",
  effectiveRequestProfile: {
    reasoning: true,
    resolvedThinkingValue: "high",
    compat: { supportsDeveloperRole: true, supportsReasoningEffort: true },
    compatStructured: {},
    unboundedInputs: { categories: [] },
  },
  preflightContractDigest: "sha256:" + "a".repeat(64),
};
const COMPAT = {
  recordVersion: 1,
  key: COMPAT_KEY,
  result: { outcome: "passed", observedAt: NOW, challengeEchoed: true },
};

test("the invalidation set is exactly the eight determinants, and all are required", () => {
  ok("model-compatibility", COMPAT);

  // ⚠️ THE EXPORTED LIST AND THE SCHEMA MUST AGREE, checked against the schema's own `required`
  // rather than against a copy in this test — a second hand-written list here would be the very
  // drift the export exists to prevent.
  const schema = JSON.parse(readFileSync(join(RUNTIME_SCHEMAS_DIR, "model-compatibility.schema.json"), "utf-8"));
  assert.deepEqual(
    [...COMPATIBILITY_KEY_FIELDS].sort(),
    [...schema.properties.key.required].sort(),
    "the exported key fields and the schema's required key fields must be the same set"
  );
  assert.deepEqual(
    [...COMPATIBILITY_KEY_FIELDS].sort(),
    Object.keys(schema.properties.key.properties).sort(),
    "every declared key property must be a determinant, and vice versa"
  );

  // ⚠️ ALL REQUIRED, because an absent determinant would silently mean "matches anything" — which
  // is the difference between a cache miss and a proof reused on a path nobody tested.
  for (const field of COMPATIBILITY_KEY_FIELDS) {
    const partial = { ...COMPAT_KEY };
    delete partial[field];
    rejects("model-compatibility", { ...COMPAT, key: partial }, `a key missing ${field} must not validate`);
  }
});

const sha256Hex = (input) => createHash("sha256").update(input).digest("hex");

test("the endpoint identity is canonical, and non-canonical spellings cannot be persisted", () => {
  // ⚠️ THE PREVIOUS VERSION WAS A REGEX OVER A URL STRING AND LET THREE SPELLINGS OF ONE ENDPOINT
  // THROUGH — an uppercase hostname, an implicit port and a trailing slash. Two records for the
  // same endpoint would have compared unequal and re-run a BILLABLE check, which is the failure
  // this determinant exists to prevent rather than cause.
  const EP = COMPAT_KEY.endpointIdentity;
  ok("model-compatibility", COMPAT);
  ok("model-compatibility", { ...COMPAT, key: { ...COMPAT_KEY, endpointIdentity: { ...EP, pathname: "/" } } });

  const nonCanonical = [
    ["uppercase hostname", { ...EP, hostname: "API.OpenAI.COM" }],
    ["uppercase scheme", { ...EP, scheme: "HTTPS" }],
    ["trailing slash", { ...EP, pathname: "/v1/" }],
    ["empty segment", { ...EP, pathname: "//v1" }],
    ["relative path", { ...EP, pathname: "v1" }],
    ["port out of range", { ...EP, port: 70000 }],
    ["port as string", { ...EP, port: "443" }],
    ["extra part", { ...EP, query: "route=b" }],
  ];
  for (const [why, bad] of nonCanonical)
    rejects("model-compatibility", { ...COMPAT, key: { ...COMPAT_KEY, endpointIdentity: bad } }, why);

  for (const missing of ["scheme", "hostname", "port", "pathname"]) {
    const partial = { ...EP };
    delete partial[missing];
    rejects("model-compatibility", { ...COMPAT, key: { ...COMPAT_KEY, endpointIdentity: partial } },
      `an identity missing ${missing} is not an identity`);
  }

  // A declared identity is a different claim about the same string, so it stays part of the key.
  ok("model-compatibility", { ...COMPAT, key: { ...COMPAT_KEY, endpointIdentitySource: "declared" } });
  rejects("model-compatibility", { ...COMPAT, key: { ...COMPAT_KEY, endpointIdentitySource: "guessed" } });
});

test("the canonicaliser collapses every spelling of one endpoint, and refuses rather than sanitises", () => {
  // ⚠️ ONE IMPLEMENTATION BEHIND THE SCHEMA. The schema describes canonical parts; something has to
  // produce them, and a caller left to lowercase and de-slash by hand is how the three spellings got
  // in. All four of these are the same endpoint and must reduce to one key.
  const forms = [
    "https://API.OpenAI.COM/v1",
    "https://api.openai.com:443/v1/",
    "https://api.openai.com/v1",
    "https://api.openai.com:443//v1//",
  ];
  const ids = forms.map((f) => JSON.stringify(canonicalizeEndpoint(f)));
  assert.equal(new Set(ids).size, 1, `spellings did not collapse: ${ids.join(" | ")}`);
  assert.deepEqual(canonicalizeEndpoint(forms[0]), { scheme: "https", hostname: "api.openai.com", port: 443, pathname: "/v1" });

  // Whatever it produces must satisfy the schema — otherwise the two halves have drifted.
  for (const f of forms)
    ok("model-compatibility", { ...COMPAT, key: { ...COMPAT_KEY, endpointIdentity: canonicalizeEndpoint(f) } });
  ok("model-compatibility", { ...COMPAT, key: { ...COMPAT_KEY, endpointIdentity: canonicalizeEndpoint("http://127.0.0.1:8099") } });

  // ⚠️ REFUSES, NEVER SANITISES. Stripping a query would let two differently routed endpoints share
  // one proof; removing userinfo would leave an identity that is only non-secret after sanitising.
  for (const bad of ["https://user:pw@h/v1", "https://user@h/v1", "https://h/v1?route=b", "https://h/v1#frag", "not a url", "ftp+x://h/v1"])
    assert.throws(() => canonicalizeEndpoint(bad), EndpointIdentityError, `must refuse: ${bad}`);
});

test("the request profile is bounded at every level, and cannot carry a credential", () => {
  // ⚠️ `propertyNames` CONSTRAINS ONLY IMMEDIATE KEYS, which is how the first version let
  // `{ compat: { authorization: "Bearer …" } }` through — and no name rule could ever catch a secret
  // under an innocuous key. The projection is closed at every level and holds scalars only.
  const PROF = COMPAT_KEY.effectiveRequestProfile;
  for (const [why, profile] of [
    ["nested credential under compat", { ...PROF, compat: { authorization: "Bearer s" } }],
    ["secret under an innocuous top-level name", { ...PROF, innocent: "sk-live-secret" }],
    ["object under a KNOWN compat name", { ...PROF, compat: { supportsStore: { nested: "x" } } }],
    ["array under a known compat name", { ...PROF, compat: { supportsStore: ["x"] } }],
    ["headers smuggled in", { ...PROF, headers: { authorization: "x" } }],
    ["samplingParams smuggled in", { ...PROF, samplingParams: { temperature: 1 } }],
    ["an unbounded compat member by value", { ...PROF, compatStructured: { chatTemplateKwargs: { a: 1 } } }],
    ["unknown key inside a structured member", { ...PROF, compatStructured: { openRouterRouting: { sneaked: "x" } } }],
    ["a resurrected digest", { ...PROF, compatDigest: "sha256:" + "c".repeat(64) }],
  ])
    rejects("model-compatibility", { ...COMPAT, key: { ...COMPAT_KEY, effectiveRequestProfile: profile } }, why);

  for (const missing of ["reasoning", "compat", "compatStructured", "unboundedInputs"]) {
    const partial = { ...PROF };
    delete partial[missing];
    rejects("model-compatibility", { ...COMPAT, key: { ...COMPAT_KEY, effectiveRequestProfile: partial } },
      `the profile must require ${missing}`);
  }

  ok("model-compatibility", {
    ...COMPAT,
    key: { ...COMPAT_KEY, effectiveRequestProfile: { ...PROF, resolvedThinkingValue: null } },
  });
});

test("an unbounded input needs a DECLARED identity, and the identity is never derived", () => {
  const PROF = COMPAT_KEY.effectiveRequestProfile;
  const withCategory = (extra) => ({
    ...COMPAT,
    key: { ...COMPAT_KEY, effectiveRequestProfile: { ...PROF, unboundedInputs: { categories: ["chatTemplateKwargs"], ...extra } } },
  });

  // ⚠️ A CATEGORY WITHOUT AN IDENTITY WOULD CLAIM A PROOF FOR A REQUEST SHAPE NOTHING DESCRIBES.
  rejects("model-compatibility", withCategory({}), "a present category requires a declared identity");
  ok("model-compatibility", withCategory({ declaredIdentity: "template-rev-7" }));

  // Only the category NAMES — never a key, a value or a count, since a key name from an
  // operator-authored record is itself unbounded content.
  rejects("model-compatibility", {
    ...COMPAT,
    key: { ...COMPAT_KEY, effectiveRequestProfile: { ...PROF, unboundedInputs: { categories: ["chatTemplateKwargs"], declaredIdentity: "x", keys: ["innocent"] } } },
  }, "the keys of an unbounded record must never be persisted");
  rejects("model-compatibility", {
    ...COMPAT,
    key: { ...COMPAT_KEY, effectiveRequestProfile: { ...PROF, unboundedInputs: { categories: ["somethingElse"], declaredIdentity: "x" } } },
  }, "the category vocabulary is fixed");
});

test("the reported input cannot produce a persisted fingerprint", () => {
  // ⚠️ THE EXACT CASE REVIEW REPRODUCED. The previous projection hashed the whole compat object to
  // keep unbounded members in the key without persisting them — which wrote the SHA-256 of an
  // operator's secret to disk. That is the credential-derived fingerprint REQ-0024 and section 3.12
  // forbid, and this module's own `digest` definition already warned that hashing a key makes it an
  // oracle rather than making it safe. Hashing hides content; it does not sanitise it.
  const evil = { compat: { chatTemplateKwargs: { innocent: "sk-live-secret" } } };

  assert.throws(() => projectRequestProfile(evil, null), RequestProfileError,
    "unbounded configuration must refuse to be cached without a declared identity");

  const profile = projectRequestProfile(evil, null, { declaredIdentity: "template-rev-7" });
  const serialised = JSON.stringify(profile);
  assert.ok(!serialised.includes("sk-live-secret"), "the value reached the profile");
  assert.ok(!serialised.includes("innocent"), "the operator's KEY NAME reached the profile");
  assert.ok(!/sha256/.test(serialised), "a digest over unbounded content reached the profile");
  assert.deepEqual(profile.unboundedInputs, { categories: ["chatTemplateKwargs"], declaredIdentity: "template-rev-7" });
  ok("model-compatibility", { ...COMPAT, key: { ...COMPAT_KEY, effectiveRequestProfile: profile } });
});

test("samplingParams is a determinant, and auth headers are not", () => {
  // ⚠️ PI DOCUMENTS THAT `samplingParams` OVERRIDES NAMED REQUEST FIELDS, so ignoring it would let a
  // cached proof outlive the request it was taken against. It is unbounded, so it becomes a category
  // rather than a value.
  assert.throws(() => projectRequestProfile({ samplingParams: { temperature: 0.2 } }, null), RequestProfileError);
  assert.deepEqual(projectRequestProfile({ samplingParams: {} }, null).unboundedInputs, { categories: [] },
    "an empty object is not a configuration");

  // ⚠️ AUTH HEADERS ARE CREDENTIAL TRANSPORT AND MUST NOT INVALIDATE. Rotating a key changes the
  // header and changes nothing about what the model can do; treating it as a determinant would
  // re-run a billable check on every rotation for no safety.
  const authOnly = { headers: { Authorization: "Bearer secret", "X-Api-Key": "k", Cookie: "s=1" } };
  const p = projectRequestProfile(authOnly, null);
  assert.deepEqual(p.unboundedInputs, { categories: [] }, "authentication headers must not become a category");
  assert.ok(!JSON.stringify(p).includes("secret"));

  // Anything else may be routing — a determinant whose value cannot be persisted.
  assert.throws(() => projectRequestProfile({ headers: { "X-Route": "backend-b" } }, null), RequestProfileError);
  assert.deepEqual(
    projectRequestProfile({ headers: { "X-Route": "b", Authorization: "Bearer s" } }, null, { declaredIdentity: "routing-a" }).unboundedInputs,
    { categories: ["customHeaders"], declaredIdentity: "routing-a" },
    "a mixed set reports only the routing category"
  );
});

test("the safely typed structures are persisted by value, and refuse unknown keys at depth", () => {
  const model = {
    reasoning: true,
    compat: {
      supportsDeveloperRole: true,
      openRouterRouting: { order: ["a", "b"], zdr: true, max_price: { prompt: 1 } },
      vercelGatewayRouting: { only: ["bedrock"] },
    },
  };
  const p = projectRequestProfile(model, "high");
  assert.deepEqual(p.compatStructured.vercelGatewayRouting, { only: ["bedrock"] });
  assert.equal(p.compatStructured.openRouterRouting.zdr, true, "routing selects a backend, so it is a determinant");
  ok("model-compatibility", { ...COMPAT, key: { ...COMPAT_KEY, effectiveRequestProfile: p } });

  // ⚠️ FAIL CLOSED AT EVERY DEPTH. An unknown nested key is either a determinant that would be
  // dropped or content with no business in the record; both are refusals.
  assert.throws(
    () => projectRequestProfile({ compat: { openRouterRouting: { order: ["a"], sneaked: { k: "sk-live" } } } }, null),
    RequestProfileError
  );
  assert.throws(() => projectRequestProfile({ compat: { brandNewPiField: true } }, null), RequestProfileError);

  // A declared identity with nothing to describe is refused too: it would sit in the key meaning
  // nothing and would silently invalidate the proof whenever it changed.
  assert.throws(() => projectRequestProfile({ reasoning: true }, null, { declaredIdentity: "x" }), RequestProfileError);
});

test("the persisted compat field set has not fallen behind the pinned Pi package", () => {
  // ⚠️ THE LIST IS HAND-CHOSEN BECAUSE KILN MUST DECIDE WHAT TO PERSIST, so this checks it against
  // Pi's OWN type declarations rather than against a copy — the same move that stopped the
  // trace-field guard being a hand-maintained list beside a declaration that already existed.
  const types = join(
    RUNTIME_SCHEMAS_DIR, "..", "..",
    "node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/types.d.ts"
  );
  const src = readFileSync(types, "utf-8");
  const declared = new Set();
  for (const name of ["OpenAICompletionsCompat", "OpenAIResponsesCompat", "AnthropicMessagesCompat", "BedrockCompat"]) {
    const m = new RegExp(`export interface ${name} \\{([\\s\\S]*?)\\n\\}`).exec(src);
    assert.ok(m, `${name} not found in the pinned package — the check itself has gone stale`);
    for (const [, field] of m[1].matchAll(/^\s{4}([A-Za-z][A-Za-z0-9]*)\??:/gm)) declared.add(field);
  }

  const covered = new Set([...SCALAR_COMPAT_FIELDS, ...STRUCTURED_COMPAT_FIELDS, ...UNBOUNDED_COMPAT_FIELDS]);
  const missing = [...declared].filter((f) => !covered.has(f)).sort();
  assert.deepEqual(
    missing,
    [],
    `the pinned Pi package declares compat fields this projection does not classify: ${missing.join(", ")}. ` +
      "Classify each as SCALAR, STRUCTURED or UNBOUNDED and extend the schema accordingly. " +
      "⚠️ THIS TEST PROVES EVERY FIELD WAS CLASSIFIED. It cannot prove the classification is SAFE — " +
      "the digest defect passed a green version of this check, because a field classified as " +
      "'structured, covered by a digest' was classified and still wrong."
  );

  // And the schema carries exactly the scalars — no more, no fewer.
  const schema = JSON.parse(readFileSync(join(RUNTIME_SCHEMAS_DIR, "model-compatibility.schema.json"), "utf-8"));
  assert.deepEqual(
    Object.keys(schema.properties.key.properties.effectiveRequestProfile.properties.compat.properties).sort(),
    [...SCALAR_COMPAT_FIELDS].sort(),
    "the schema's compat properties and SCALAR_COMPAT_FIELDS must be the same set"
  );
});

test("only a successful canary is persisted, and the challenge value is not", () => {
  // ⚠️ A STORED FAILURE WOULD BE A CACHE OF A REFUSAL. Section 3.12 says a failure mutates nothing;
  // the next run must retry rather than inherit it.
  for (const outcome of ["failed", "declined", "pending"])
    rejects("model-compatibility", { ...COMPAT, result: { outcome, observedAt: NOW } }, `outcome ${outcome} must not be cached`);

  // The challenge is single-use: keeping it would turn a liveness proof into a replayable one.
  rejects("model-compatibility", { ...COMPAT, result: { ...COMPAT.result, challenge: "abc123xyz" } });
  rejects("model-compatibility", { ...COMPAT, result: { outcome: "passed" } }, "a proof with no date cannot be aged out");
});

test("nothing outside `key` can become a determinant by accident", () => {
  // ⚠️ THE STRUCTURAL POINT OF NESTING THE KEY. Comparison is a deep equality over one object, so a
  // field added to `result` — or anywhere else — cannot quietly join the invalidation set, and a
  // determinant cannot quietly fall out of it.
  const schema = JSON.parse(readFileSync(join(RUNTIME_SCHEMAS_DIR, "model-compatibility.schema.json"), "utf-8"));
  assert.deepEqual(Object.keys(schema.properties).sort(), ["key", "recordVersion", "result"]);
  for (const noise of ["observedAt", "sessionId", "consent", "statePath"])
    rejects("model-compatibility", { ...COMPAT, key: { ...COMPAT_KEY, [noise]: "x" } }, `${noise} is not a determinant`);
});

/* ================================================================ shared rules ================= */

test("every record requires its own version, and versions are per record", () => {
  for (const kind of Object.keys(validators)) {
    const minimal = {
      "kiln-project": { projectId: PROJECT_ID },
      consent: {},
      "setup-transaction": { operation: "setup", startedAt: NOW, phases: [{ name: "x", status: "pending" }] },
      "kiln-session": { projectId: PROJECT_ID, sessionId: "x", stateMode: "project" },
      "model-compatibility": { key: COMPAT_KEY, result: { outcome: "passed", observedAt: NOW } },
    }[kind];
    rejects(kind, minimal, `${kind} must require recordVersion`);
    ok(kind, { recordVersion: 1, ...minimal });
    rejects(kind, { recordVersion: 0, ...minimal }, `${kind} versions start at 1`);
  }
});

test("no runtime schema permits an unknown property, at the top level OR nested", () => {
  // ⚠️ THE GENERAL FORM OF EVERY REFUSAL ABOVE. Credential material, absolute paths and host
  // specifics all arrive as fields nobody declared, so a record that accepted unknown properties
  // would let each of them in one at a time while every named test still passed.
  //
  // ⚠️ THE NESTED HALF IS HERE BECAUSE THE TOP-LEVEL HALF MISSED A REAL HOLE. `consent.inspection`
  // was a bare `$ref` to a shared `grant` shape: `unevaluatedProperties` had nothing to attach to,
  // the referenced definition could not forbid fields its other users legitimately add, and a
  // credential field validated cleanly. Only the specific test caught it, so the general test now
  // reaches one level down.
  const TOP = {
    "kiln-project": { recordVersion: 1, projectId: PROJECT_ID },
    consent: { recordVersion: 1 },
    "setup-transaction": { recordVersion: 1, operation: "setup", startedAt: NOW, phases: [{ name: "x", status: "pending" }] },
    "kiln-session": { recordVersion: 1, projectId: PROJECT_ID, sessionId: "x", stateMode: "project" },
  };
  for (const kind of Object.keys(validators))
    rejects(kind, { ...TOP[kind], somethingNobodyDeclared: "x" }, `${kind} must refuse an undeclared field`);

  const NESTED = [
    ["kiln-project", { ...TOP["kiln-project"], research: { provider: "tavily", sneaked: "x" } }],
    ["consent", { recordVersion: 1, inspection: { ...GRANT, sneaked: "x" } }],
    ["consent", { recordVersion: 1, modelUse: { ...GRANT, provider: "p", model: "m", sneaked: "x" } }],
    ["consent", { recordVersion: 1, research: { ...GRANT, provider: "tavily", sneaked: "x" } }],
    ["setup-transaction", { ...TOP["setup-transaction"], phases: [{ name: "x", status: "pending", sneaked: "y" }] }],
    ["setup-transaction", { ...TOP["setup-transaction"], fileIdentities: [{ path: "a", state: "absent", sneaked: "y" }] }],
    ["setup-transaction", { ...TOP["setup-transaction"], recovery: { command: "c", sneaked: "y" } }],
  ];
  for (const [kind, doc] of NESTED)
    rejects(kind, doc, `${kind} must refuse an undeclared field in a nested object`);
});
