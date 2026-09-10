/**
 * The provider canary — TSK-0040, against ACC-0104.
 *
 * ⚠️ **REAL CHILDREN AGAINST THE REAL PINNED SDK WHERE PI CAN PRODUCE THE CASE, STUBS WHERE IT CANNOT.**
 * Stored, environment and custom authentication, the unavailable and mismatched outcomes, and exact-model
 * matching all run the actual child importing `@earendil-works/pi-coding-agent` 0.84.4 with network model
 * loading off. The sources Pi will not produce against a fixture — `runtime`, a command, a fallback — and
 * the ways a child can fail are driven by stub children through the same parent path, so what is under test
 * there is the parent's decision and its cleanup, not a pretend SDK.
 *
 * ⚠️ **EVERY HOST ENVIRONMENT HERE IS BUILT FROM THE BASE LISTS ONLY.** A developer machine or a runner can
 * carry a real `ANTHROPIC_API_KEY`; inheriting it would turn "no credential" into "available" and make the
 * negative cells pass for the wrong reason.
 *
 * ⚠️ **THE MODEL ID IS PINNED TO THE PINNED CATALOGUE.** `claude-fable-5` is in 0.84.4's offline catalogue.
 * A Pi version bump is a deliberate, re-verified change under DEC-0026, and this constant moves with it.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { installReaper, reapLater } from "./helpers/reap.mjs";
import { AUTH_SOURCE, resolveProviderCredentials } from "../lib/pi-provider-credentials.mjs";
import { resolvePinnedSdk } from "../lib/pi-runtime.mjs";
import { BASE_ENV } from "../lib/specialists/contract.mjs";
import {
  CANARY_CHILD_PATH,
  CANARY_REFUSAL,
  CANARY_TEMP_PREFIX,
  CanaryRefusal,
  FORBIDDEN_PI_SOURCES,
  mapAuthSource,
  runProviderCanary,
} from "../lib/pi-provider-canary.mjs";

installReaper();

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MODEL = "claude-fable-5";
const NEAR_MISS = "claude-fable";

/** Credential-shaped, distinctive, and not real. */
const SECRET = "sk-ant-KILN-CANARY-PLANTED-9f3c1d";

/**
 * Credentials for providers the canary was NOT asked about, each carrying a marker no selected entry has.
 * Fixed expiry rather than `Date.now()`, so the entries compare exactly.
 */
const UNSELECTED = Object.freeze({
  openai: { type: "api_key", key: "sk-openai-UNSELECTED-PLANTED-4a7e" },
  "github-copilot": {
    type: "oauth",
    refresh: "gh-refresh-UNSELECTED-PLANTED-8b21",
    access: "gh-access-UNSELECTED-PLANTED-8b21",
    expires: 4102444800000,
  },
  acme: { type: "api_key", key: "acme-UNSELECTED-PLANTED-c93d" },
});

const CUSTOM_DECLARATION = Object.freeze({ id: "acme", apiKey: "$ACME_CANARY_KEY" });
const CUSTOM_CONFIG = Object.freeze({
  // Never contacted: network model loading is off, and availability is decided by configuration.
  baseUrl: "http://127.0.0.1:9/v1",
  api: "openai-completions",
  models: [{ id: "acme-model", name: "Acme Model", contextWindow: 128000, maxTokens: 4096 }],
});

/** The base runtime names only, from this process, plus whatever a cell plants. */
function cleanHost(extra = {}) {
  const out = {};
  for (const name of new Set([...BASE_ENV.win32, ...BASE_ENV.posix]))
    if (process.env[name] !== undefined) out[name] = process.env[name];
  return { ...out, ...extra };
}

/** A private parent for the canary's temporary roots, so "nothing survived" is a statement about one directory. */
const privateParent = () => reapLater(mkdtempSync(join(tmpdir(), "kiln-canary-test-")));

function assertNothingSurvived(parent, why) {
  assert.deepEqual(readdirSync(parent), [], `${why}: a temporary root survived in ${parent}`);
}

/** A stored credential file somewhere the canary must never write. */
function storedFixture(content) {
  const dir = reapLater(mkdtempSync(join(tmpdir(), "kiln-canary-stored-")));
  const path = join(dir, "auth.json");
  writeFileSync(path, JSON.stringify(content, null, 2) + "\n");
  return { dir, path, bytes: readFileSync(path), names: readdirSync(dir).sort() };
}

const OAUTH = (id) => ({ [id]: { type: "oauth", refresh: "r-not-real", access: "a-not-real", expires: Date.now() + 3_600_000 } });

async function refusalOf(promise, reason) {
  try {
    await promise;
  } catch (e) {
    assert.ok(e instanceof CanaryRefusal, `expected a CanaryRefusal, got ${e?.stack ?? e}`);
    assert.equal(e.reason, reason, `expected ${reason}, got ${e.reason}: ${e.message}`);
    return e;
  }
  assert.fail(`expected a ${reason} refusal, and the canary succeeded`);
}

/**
 * The real spawn, recorded: the exact command, argv and environment, both output streams, and the stored
 * credential file as the child found it at the moment it started.
 *
 * ⚠️ **THE STORED COPY IS THE POSITIVE CONTROL FOR THE STORED ROUTE, AND THE EVIDENCE FOR ITS NARROWING.**
 * A secret absent from every output is only meaningful if it was present to be leaked; and an unselected
 * provider's credential absent from the copy is only meaningful if the operator's file held it.
 */
function recordingSpawn() {
  const calls = [];
  const spawnImpl = (command, args, options) => {
    const agentDir = options.env?.PI_CODING_AGENT_DIR;
    const copy = agentDir ? join(agentDir, "auth.json") : null;
    const storedCopyText = copy !== null && existsSync(copy) ? readFileSync(copy, "utf-8") : null;
    const record = {
      command,
      args: [...args],
      env: { ...options.env },
      stdout: "",
      stderr: "",
      storedCopyText,
      storedCopyHeldSecret: storedCopyText !== null && storedCopyText.includes(SECRET),
      rootAtSpawn: agentDir ? dirname(agentDir) : null,
    };
    calls.push(record);
    const child = spawn(command, args, options);
    child.stdout.on("data", (b) => (record.stdout += b.toString("utf-8")));
    child.stderr.on("data", (b) => (record.stderr += b.toString("utf-8")));
    return child;
  };
  return { spawnImpl, calls };
}

/** A stand-in child that ignores its argv and does exactly one thing, run through the real parent path. */
const stubSpawn = (script) => (_command, _args, options) => spawn(process.execPath, ["-e", script], options);
const reportScript = (report) => `process.stdout.write(${JSON.stringify(JSON.stringify(report))})`;

/** Every form a planted value could leak in: itself, its hashes, its encodings, a tail, its reversal. */
function fingerprints(value) {
  const hash = (alg) => createHash(alg).update(value).digest("hex");
  return [
    ["value", value],
    ["sha256", hash("sha256")],
    ["sha256-prefix", hash("sha256").slice(0, 12)],
    ["sha1", hash("sha1")],
    ["md5", hash("md5")],
    ["base64", Buffer.from(value).toString("base64")],
    ["base64url", Buffer.from(value).toString("base64url")],
    ["tail", value.slice(-6)],
    ["distinctive-core", "KILN-CANARY-PLANTED"],
    ["reversed", [...value].reverse().join("")],
  ];
}

function assertNoTrace(where, texts) {
  for (const [kind, fp] of fingerprints(SECRET))
    for (const [label, text] of Object.entries(texts))
      assert.ok(!String(text).includes(fp), `${where}: ${label} carries the planted secret as ${kind}`);
}

/** The child's own report shape — three facts, nothing else — and a stderr with nothing in it. */
function assertCleanChildStreams(call, where) {
  assert.equal(call.stderr, "", `${where}: the child wrote to stderr`);
  const report = JSON.parse(call.stdout);
  assert.deepEqual(Object.keys(report).sort(), ["available", "configured", "piSource"], `${where}: child stdout shape`);
}

const canary = (parent, overrides) => runProviderCanary({ toolRoot: ROOT, tempParent: parent, ...overrides });

/* ============================================ the six P13 cells ================================ */

test("⚠️ P13 stored api_key on a built-in provider: available, `stored`, and the operator's file untouched", async () => {
  const parent = privateParent();
  const stored = storedFixture({ anthropic: { type: "api_key", key: SECRET } });
  const { spawnImpl, calls } = recordingSpawn();

  const result = await canary(parent, {
    provider: "anthropic",
    model: MODEL,
    storedAuthPath: stored.path,
    hostEnv: cleanHost(),
    spawnImpl,
  });

  assert.deepEqual(result, { provider: "anthropic", model: MODEL, available: true, authSource: AUTH_SOURCE.STORED });

  // ⚠️ THE POSITIVE CONTROL: the copy the child authenticated from held the secret.
  assert.equal(calls.length, 1);
  assert.equal(calls[0].storedCopyHeldSecret, true, "the stored copy must have held the planted credential");
  assertCleanChildStreams(calls[0], "stored");
  assertNoTrace("stored", { result: JSON.stringify(result), stdout: calls[0].stdout, stderr: calls[0].stderr });

  // ⚠️ PI'S STORE CREATES, WRITES AND LOCKS. None of that may reach the operator's file or its directory.
  assert.deepEqual(readFileSync(stored.path), stored.bytes, "the operator's auth.json must be byte-identical");
  assert.deepEqual(readdirSync(stored.dir).sort(), stored.names, "nothing — no lock, no copy — beside the operator's file");
  assertNothingSurvived(parent, "stored success");
  assert.ok(!existsSync(calls[0].rootAtSpawn), "the root the child ran in is gone");
});

test("⚠️ P13 environment key on a built-in provider: available, `environment-key`, fixed argv", async () => {
  const parent = privateParent();
  const { spawnImpl, calls } = recordingSpawn();

  const result = await canary(parent, {
    provider: "anthropic",
    model: MODEL,
    hostEnv: cleanHost({ ANTHROPIC_API_KEY: SECRET }),
    spawnImpl,
  });

  assert.deepEqual(result, { provider: "anthropic", model: MODEL, available: true, authSource: AUTH_SOURCE.ENVIRONMENT_KEY });

  // ⚠️ THE POSITIVE CONTROL: the environment the canary built did carry the key to the child.
  assert.equal(calls[0].env.ANTHROPIC_API_KEY, SECRET, "the child's environment must have held the planted key");

  // ⚠️ FIXED ARGV: the interpreter, the child, the pinned SDK entry, the provider, the model. Nothing else.
  assert.equal(calls[0].command, process.execPath);
  assert.deepEqual(calls[0].args, [CANARY_CHILD_PATH, resolvePinnedSdk(ROOT).url, "anthropic", MODEL]);
  for (const arg of calls[0].args) {
    assert.ok(!arg.includes("--api-key"), `argv carries --api-key: ${arg}`);
    assert.ok(!arg.includes("print-api-key"), `argv carries print-api-key: ${arg}`);
  }
  assertNoTrace("environment argv", { argv: calls[0].args.join(" ") });

  // With no stored file supplied, the one credential file the child sees is an explicit empty object.
  assert.deepEqual(JSON.parse(calls[0].storedCopyText), {});

  assertCleanChildStreams(calls[0], "environment");
  assertNoTrace("environment", { result: JSON.stringify(result), stdout: calls[0].stdout, stderr: calls[0].stderr });
  assertNothingSurvived(parent, "environment success");
});

test("⚠️ P13 custom provider through its validated $VAR: available, `custom-environment-key`", async () => {
  const parent = privateParent();
  const { spawnImpl, calls } = recordingSpawn();

  const result = await canary(parent, {
    provider: "acme",
    model: "acme-model",
    custom: CUSTOM_DECLARATION,
    customProviderConfig: CUSTOM_CONFIG,
    hostEnv: cleanHost({ ACME_CANARY_KEY: SECRET }),
    spawnImpl,
  });

  assert.deepEqual(result, {
    provider: "acme",
    model: "acme-model",
    available: true,
    authSource: AUTH_SOURCE.CUSTOM_ENVIRONMENT_KEY,
  });
  assert.equal(calls[0].env.ACME_CANARY_KEY, SECRET, "the positive control: the declared variable reached the child");
  assertCleanChildStreams(calls[0], "custom");
  assertNoTrace("custom", { result: JSON.stringify(result), stdout: calls[0].stdout, stderr: calls[0].stderr });
  assertNothingSurvived(parent, "custom success");
});

test("⚠️ P13 no credential: a structured unavailable refusal whose detail is exactly four facts", async () => {
  const parent = privateParent();
  const e = await refusalOf(canary(parent, { provider: "anthropic", model: MODEL, hostEnv: cleanHost() }), CANARY_REFUSAL.UNAVAILABLE);
  assert.deepEqual(e.detail, { provider: "anthropic", model: MODEL, available: false, authSource: null });
  assertNothingSurvived(parent, "no credential");
});

test("⚠️ P13 unsupported provider: refused with no child and no temporary root", async () => {
  const parent = privateParent();
  let spawned = false;
  const e = await refusalOf(
    canary(parent, {
      provider: "acme-unknown",
      model: "whatever",
      hostEnv: cleanHost({ ACME_API_KEY: SECRET }),
      spawnImpl: () => {
        spawned = true;
        throw new Error("no canary child may be created for an unsupported provider");
      },
    }),
    CANARY_REFUSAL.UNSUPPORTED
  );
  assert.equal(spawned, false, "the contract must be refused before anything is spawned");
  assert.deepEqual(e.detail, { provider: "acme-unknown", model: "whatever" });
  assertNothingSurvived(parent, "unsupported — the root must never have been created");
  assertNoTrace("unsupported refusal", { message: e.message, detail: JSON.stringify(e.detail) });
});

test("⚠️ P13 stored OAuth on a custom provider: its mismatched source is reported, not hidden as unavailable", async () => {
  // ⚠️ THE TRAP THE SPIKE FOUND, REACHED THROUGH THE REAL SDK, AND NOW REPORTED FOR WHAT IT IS. The declared
  // variable is set, so the environment builds. Pi reports the provider `configured` from the stored OAuth
  // credential — which it checks first — while the exact model is absent from the available set. The source
  // is `stored`, which a custom contract does not permit, and that is judged BEFORE availability: reporting
  // this as merely unavailable would hide that the provider was authenticated by an undeclared route.
  const parent = privateParent();
  const stored = storedFixture(OAUTH("acme"));
  const e = await refusalOf(
    canary(parent, {
      provider: "acme",
      model: "acme-model",
      custom: CUSTOM_DECLARATION,
      customProviderConfig: CUSTOM_CONFIG,
      storedAuthPath: stored.path,
      hostEnv: cleanHost({ ACME_CANARY_KEY: SECRET }),
    }),
    CANARY_REFUSAL.AUTH_SOURCE_MISMATCH
  );
  assert.deepEqual(e.detail, { provider: "acme", model: "acme-model" });
  assertNoTrace("stored OAuth on a custom provider", { message: e.message, detail: JSON.stringify(e.detail) });
  assertNothingSurvived(parent, "stored OAuth on a custom provider");
});

test("⚠️ P13 a permitted source that is configured still does not make the model available", async () => {
  // ⚠️ THE `configured`-IS-NOT-AVAILABILITY CASE WITH NOTHING ELSE WRONG. Through the real SDK: a built-in
  // provider with a stored api_key whose key is empty — what a failed login can leave behind — is reported
  // `configured` from `stored`, a source the built-in contract permits, and the exact model is still absent
  // from the available set. The source maps cleanly, so the refusal is `unavailable` and carries it.
  const parent = privateParent();
  const stored = storedFixture({ anthropic: { type: "api_key", key: "" } });
  const e = await refusalOf(
    canary(parent, { provider: "anthropic", model: MODEL, storedAuthPath: stored.path, hostEnv: cleanHost() }),
    CANARY_REFUSAL.UNAVAILABLE
  );
  assert.deepEqual(e.detail, { provider: "anthropic", model: MODEL, available: false, authSource: AUTH_SOURCE.STORED });
  assertNothingSurvived(parent, "configured, permitted, unavailable");
});

/* ============================================ D23: only the selected stored entry =============== */

test("⚠️ D23 only the selected provider's stored entry reaches the temporary copy", async () => {
  // ⚠️ A WHOLE-FILE COPY HANDS THE DISPOSABLE CHILD CREDENTIALS IT WAS NEVER ASKED TO INSPECT. The
  // operator's file holds four providers; the child must find exactly one of them.
  const parent = privateParent();
  const selected = { type: "api_key", key: SECRET };
  const stored = storedFixture({ anthropic: selected, ...UNSELECTED });
  const { spawnImpl, calls } = recordingSpawn();

  const result = await canary(parent, {
    provider: "anthropic",
    model: MODEL,
    storedAuthPath: stored.path,
    hostEnv: cleanHost(),
    spawnImpl,
  });
  assert.equal(result.authSource, AUTH_SOURCE.STORED, "the selected entry must still authenticate");

  const copy = JSON.parse(calls[0].storedCopyText);
  assert.deepEqual(Object.keys(copy), ["anthropic"], "the copy must hold exactly the selected provider");
  assert.deepEqual(copy.anthropic, selected, "and that provider's entry, unchanged");

  // ⚠️ THE POSITIVE CONTROL: the operator's file really does hold every unselected credential.
  const original = readFileSync(stored.path, "utf-8");
  for (const [id, entry] of Object.entries(UNSELECTED))
    for (const value of Object.values(entry).filter((v) => typeof v === "string" && v.includes("UNSELECTED"))) {
      assert.ok(original.includes(value), `the fixture must hold ${id}'s credential for this test to mean anything`);
      assert.ok(!calls[0].storedCopyText.includes(value), `${id}'s credential reached the child's copy`);
      assert.ok(!calls[0].stdout.includes(value) && !calls[0].stderr.includes(value), `${id}'s credential reached output`);
    }

  assert.deepEqual(readFileSync(stored.path), stored.bytes, "the operator's file still holds all four, unchanged");
  assertNothingSurvived(parent, "selected-entry copy");
});

test("D23 a stored file with no entry for the provider copies `{}`, and a complete environment route still authenticates", async () => {
  const parent = privateParent();
  const stored = storedFixture({ ...UNSELECTED });
  const { spawnImpl, calls } = recordingSpawn();

  const result = await canary(parent, {
    provider: "anthropic",
    model: MODEL,
    storedAuthPath: stored.path,
    hostEnv: cleanHost({ ANTHROPIC_API_KEY: SECRET }),
    spawnImpl,
  });
  assert.equal(result.authSource, AUTH_SOURCE.ENVIRONMENT_KEY);
  assert.deepEqual(JSON.parse(calls[0].storedCopyText), {}, "nothing for this provider means an empty copy");
  assert.ok(!calls[0].storedCopyText.includes("UNSELECTED"), "and no other provider's entry in its place");
  assertNothingSurvived(parent, "empty copy");
});

test("⚠️ a malformed stored file is refused, and neither the file nor the parser's message leaks", async () => {
  const parent = privateParent();
  const dir = reapLater(mkdtempSync(join(tmpdir(), "kiln-canary-malformed-")));
  const bad = join(dir, "auth.json");
  // Unquoted, so the parser fails ON the credential and quotes the text around it.
  const text = `{"anthropic":${SECRET}}`;
  writeFileSync(bad, text);

  // ⚠️ THE POSITIVE CONTROL: on this runtime the parser's own message does quote the credential, so a
  // refusal that forwarded it would leak. Without this, a clean refusal could just mean the parser is quiet.
  let parserMessage = "";
  try {
    JSON.parse(text);
  } catch (err) {
    parserMessage = err.message;
  }
  assert.ok(parserMessage.includes("sk-ant"), `expected the parser to quote the input: ${parserMessage}`);

  let spawned = false;
  const e = await refusalOf(
    canary(parent, {
      provider: "anthropic",
      model: MODEL,
      storedAuthPath: bad,
      hostEnv: cleanHost(),
      spawnImpl: () => {
        spawned = true;
        throw new Error("no child may start from an unreadable credential file");
      },
    }),
    CANARY_REFUSAL.STORED_AUTH_INVALID
  );
  assert.equal(spawned, false);
  assert.deepEqual(e.detail, { provider: "anthropic", model: MODEL });
  assert.ok(!e.message.includes("sk-ant"), "the refusal must not forward the parser's quote");
  assertNoTrace("malformed stored file", { message: e.message, detail: JSON.stringify(e.detail) });

  // Valid JSON that is not a credential object is refused the same way.
  const array = join(dir, "array.json");
  writeFileSync(array, "[]");
  await refusalOf(
    canary(parent, { provider: "anthropic", model: MODEL, storedAuthPath: array, hostEnv: cleanHost() }),
    CANARY_REFUSAL.STORED_AUTH_INVALID
  );
  assertNothingSurvived(parent, "malformed stored file");
});

/* ============================================ exact matching and precedence ===================== */

test("⚠️ the exact model id and the exact provider are both required", async () => {
  const parent = privateParent();

  // A prefix of a real id is not that id.
  const prefix = await refusalOf(
    canary(parent, { provider: "anthropic", model: NEAR_MISS, hostEnv: cleanHost({ ANTHROPIC_API_KEY: SECRET }) }),
    CANARY_REFUSAL.UNAVAILABLE
  );
  assert.equal(prefix.detail.model, NEAR_MISS);

  // A real id under a provider that does not serve it is not that model.
  const wrongProvider = await refusalOf(
    canary(parent, {
      provider: "openai",
      model: MODEL,
      hostEnv: cleanHost({ ANTHROPIC_API_KEY: SECRET, OPENAI_API_KEY: SECRET }),
    }),
    CANARY_REFUSAL.UNAVAILABLE
  );
  assert.equal(wrongProvider.detail.provider, "openai");
  assertNothingSurvived(parent, "exact matching");
});

test("stored and environment together: Pi reports `stored`, and a built-in contract permits it", async () => {
  // Measured precedence, pinned here so the environment-key cell above cannot quietly be reading a file.
  const parent = privateParent();
  const stored = storedFixture({ anthropic: { type: "api_key", key: SECRET } });
  const result = await canary(parent, {
    provider: "anthropic",
    model: MODEL,
    storedAuthPath: stored.path,
    hostEnv: cleanHost({ ANTHROPIC_API_KEY: SECRET }),
  });
  assert.equal(result.authSource, AUTH_SOURCE.STORED);
  assertNothingSurvived(parent, "stored and environment");
});

test("⚠️ an available model through a source the contract does not permit is a mismatch refusal", async () => {
  // Through the real SDK: a custom provider with a stored api_key is AVAILABLE, and Pi reports `stored`.
  // A custom contract declares only its `$VAR` route, so availability through a file is refused.
  const parent = privateParent();
  const stored = storedFixture({ acme: { type: "api_key", key: SECRET } });
  const e = await refusalOf(
    canary(parent, {
      provider: "acme",
      model: "acme-model",
      custom: CUSTOM_DECLARATION,
      customProviderConfig: CUSTOM_CONFIG,
      storedAuthPath: stored.path,
      hostEnv: cleanHost({ ACME_CANARY_KEY: SECRET }),
    }),
    CANARY_REFUSAL.AUTH_SOURCE_MISMATCH
  );
  assert.deepEqual(e.detail, { provider: "acme", model: "acme-model" });
  assertNoTrace("mismatch refusal", { message: e.message, detail: JSON.stringify(e.detail) });
  assertNothingSurvived(parent, "mismatch");
});

/* ============================================ the closed output shape =========================== */

test("⚠️ the successful report is exactly four keys and cannot be extended", async () => {
  const parent = privateParent();
  const result = await canary(parent, { provider: "anthropic", model: MODEL, hostEnv: cleanHost({ ANTHROPIC_API_KEY: SECRET }) });
  assert.deepEqual(Object.keys(result).sort(), ["authSource", "available", "model", "provider"]);
  assert.ok(Object.isFrozen(result), "a report a caller could add a field to is not closed");

  // ⚠️ A CHILD REPORTING MORE IS NOT BELIEVED. Pi's status carries a `label` of variable names; a child that
  // passed it through would be a leak the parent must refuse rather than forward.
  const extra = await refusalOf(
    canary(parent, {
      provider: "anthropic",
      model: MODEL,
      hostEnv: cleanHost(),
      spawnImpl: stubSpawn(reportScript({ available: true, configured: true, piSource: "environment", label: "ANTHROPIC_API_KEY" })),
    }),
    CANARY_REFUSAL.OUTPUT_INVALID
  );
  assert.deepEqual(extra.detail, { provider: "anthropic", model: MODEL });
  assert.ok(!extra.message.includes("ANTHROPIC_API_KEY"), "the refusal must not repeat the leaked name");
  assertNothingSurvived(parent, "closed shape");
});

/* ============================================ auth-source mapping =============================== */

test("⚠️ Pi sources Kiln does not permit are refused, never classified", () => {
  const builtIn = resolveProviderCredentials("anthropic");
  const custom = resolveProviderCredentials("acme", { custom: CUSTOM_DECLARATION });

  for (const source of FORBIDDEN_PI_SOURCES)
    for (const contract of [builtIn, custom])
      assert.deepEqual(
        mapAuthSource(source, contract),
        { refusal: CANARY_REFUSAL.AUTH_SOURCE_FORBIDDEN },
        `${source} must be refused on ${contract.id}`
      );

  assert.deepEqual(mapAuthSource("stored", builtIn), { authSource: AUTH_SOURCE.STORED });
  assert.deepEqual(mapAuthSource("environment", builtIn), { authSource: AUTH_SOURCE.ENVIRONMENT_KEY });
  assert.deepEqual(mapAuthSource("environment", custom), { authSource: AUTH_SOURCE.CUSTOM_ENVIRONMENT_KEY });
  assert.deepEqual(mapAuthSource("stored", custom), { refusal: CANARY_REFUSAL.AUTH_SOURCE_MISMATCH });

  const storedOnly = { id: "stored-only", authSources: [AUTH_SOURCE.STORED], required: [], anyOf: [], optional: [] };
  assert.deepEqual(mapAuthSource("environment", storedOnly), { refusal: CANARY_REFUSAL.AUTH_SOURCE_MISMATCH });

  for (const unknown of ["banana", "", null, undefined])
    assert.deepEqual(mapAuthSource(unknown, builtIn), { refusal: CANARY_REFUSAL.AUTH_SOURCE_UNKNOWN }, String(unknown));
});

test("⚠️ a forbidden or unknown source reported by a child refuses through the parent, leaving nothing", async () => {
  const parent = privateParent();
  const cases = [
    ["runtime", CANARY_REFUSAL.AUTH_SOURCE_FORBIDDEN],
    ["models_json_command", CANARY_REFUSAL.AUTH_SOURCE_FORBIDDEN],
    ["fallback", CANARY_REFUSAL.AUTH_SOURCE_FORBIDDEN],
    ["models_json_key", CANARY_REFUSAL.AUTH_SOURCE_FORBIDDEN],
    ["banana", CANARY_REFUSAL.AUTH_SOURCE_UNKNOWN],
  ];
  for (const [piSource, reason] of cases) {
    const e = await refusalOf(
      canary(parent, {
        provider: "anthropic",
        model: MODEL,
        hostEnv: cleanHost(),
        spawnImpl: stubSpawn(reportScript({ available: true, configured: true, piSource })),
      }),
      reason
    );
    assert.deepEqual(e.detail, { provider: "anthropic", model: MODEL }, piSource);
    assertNothingSurvived(parent, `source ${piSource}`);
  }
});

test("⚠️ a bad source keeps its own refusal when the model is also unavailable", async () => {
  // ⚠️ THE ORDERING CORRECTION. Judging availability first reported every one of these as merely
  // unavailable, so a forbidden command source, an unknown source and an undeclared route all looked like
  // an ordinary missing model.
  const parent = privateParent();

  for (const [piSource, reason] of [
    ["models_json_command", CANARY_REFUSAL.AUTH_SOURCE_FORBIDDEN],
    ["runtime", CANARY_REFUSAL.AUTH_SOURCE_FORBIDDEN],
    ["banana", CANARY_REFUSAL.AUTH_SOURCE_UNKNOWN],
  ]) {
    const e = await refusalOf(
      canary(parent, {
        provider: "anthropic",
        model: MODEL,
        hostEnv: cleanHost(),
        spawnImpl: stubSpawn(reportScript({ available: false, configured: true, piSource })),
      }),
      reason
    );
    assert.deepEqual(e.detail, { provider: "anthropic", model: MODEL }, piSource);
  }

  const mismatch = await refusalOf(
    canary(parent, {
      provider: "acme",
      model: "acme-model",
      custom: CUSTOM_DECLARATION,
      customProviderConfig: CUSTOM_CONFIG,
      hostEnv: cleanHost({ ACME_CANARY_KEY: SECRET }),
      spawnImpl: stubSpawn(reportScript({ available: false, configured: true, piSource: "stored" })),
    }),
    CANARY_REFUSAL.AUTH_SOURCE_MISMATCH
  );
  assert.deepEqual(mismatch.detail, { provider: "acme", model: "acme-model" });

  // An available model with no source the runtime could name is not one the canary can vouch for.
  const nameless = await refusalOf(
    canary(parent, {
      provider: "anthropic",
      model: MODEL,
      hostEnv: cleanHost(),
      spawnImpl: stubSpawn(reportScript({ available: true, configured: false, piSource: null })),
    }),
    CANARY_REFUSAL.AUTH_SOURCE_UNKNOWN
  );
  assert.deepEqual(nameless.detail, { provider: "anthropic", model: MODEL });
  assertNothingSurvived(parent, "bad source while unavailable");
});

/* ============================================ refusals before any state ========================= */

test("⚠️ a custom configuration is closed, and its refusals name neither the property nor its value", async () => {
  const parent = privateParent();
  const run = (overrides) =>
    canary(parent, {
      hostEnv: cleanHost({ ACME_CANARY_KEY: SECRET }),
      spawnImpl: () => assert.fail("no child may be created for an invalid configuration"),
      ...overrides,
    });

  const builtInWithConfig = await refusalOf(
    run({ provider: "anthropic", model: MODEL, customProviderConfig: CUSTOM_CONFIG }),
    CANARY_REFUSAL.CUSTOM_CONFIG_INVALID
  );
  assert.equal(builtInWithConfig.detail.problem, "built-in-provider");

  const missing = await refusalOf(
    run({ provider: "acme", model: "acme-model", custom: CUSTOM_DECLARATION }),
    CANARY_REFUSAL.CUSTOM_CONFIG_INVALID
  );
  assert.equal(missing.detail.problem, "missing");

  // ⚠️ THESE ARE THE PROPERTIES THAT WOULD AUTHENTICATE BY A ROUTE THE CONTRACT NEVER DECLARED.
  for (const [label, config] of [
    ["apiKey", { ...CUSTOM_CONFIG, apiKey: SECRET }],
    ["headers", { ...CUSTOM_CONFIG, headers: { Authorization: `Bearer ${SECRET}` } }],
    ["authHeader", { ...CUSTOM_CONFIG, authHeader: true }],
    ["model apiKey", { ...CUSTOM_CONFIG, models: [{ ...CUSTOM_CONFIG.models[0], apiKey: SECRET }] }],
  ]) {
    const e = await refusalOf(
      run({ provider: "acme", model: "acme-model", custom: CUSTOM_DECLARATION, customProviderConfig: config }),
      CANARY_REFUSAL.CUSTOM_CONFIG_INVALID
    );
    assert.equal(e.detail.problem, "unknown-property", label);
    assert.equal(e.detail.unknownCount, 1, label);
    for (const name of ["apiKey", "headers", "authHeader", "Authorization"])
      assert.ok(!e.message.includes(name), `${label}: the refusal names ${name}`);
    assertNoTrace(`config ${label}`, { message: e.message, detail: JSON.stringify(e.detail) });
  }
  assertNothingSurvived(parent, "invalid configuration — no root may have been created");
});

test("an invalid request refuses before anything exists", async () => {
  const parent = privateParent();
  for (const request of [{ model: MODEL }, { provider: "anthropic" }, { provider: "", model: MODEL }, { provider: "anthropic", model: 5 }])
    await refusalOf(canary(parent, { hostEnv: cleanHost(), ...request }), CANARY_REFUSAL.INVALID_REQUEST);
  assertNothingSurvived(parent, "invalid request");
});

test("a refusal before any state never attempts a removal", async () => {
  const parent = privateParent();
  let removals = 0;
  const removeRoot = () => {
    removals++;
  };
  await refusalOf(canary(parent, { provider: "acme-unknown", model: "x", hostEnv: cleanHost(), removeRoot }), CANARY_REFUSAL.UNSUPPORTED);
  await refusalOf(
    canary(parent, { provider: "anthropic", model: MODEL, customProviderConfig: CUSTOM_CONFIG, hostEnv: cleanHost(), removeRoot }),
    CANARY_REFUSAL.CUSTOM_CONFIG_INVALID
  );
  await refusalOf(canary(parent, { provider: "anthropic", hostEnv: cleanHost(), removeRoot }), CANARY_REFUSAL.INVALID_REQUEST);
  assert.equal(removals, 0, "there was no root, so there was nothing to remove");
  assertNothingSurvived(parent, "pre-state refusals");
});

/* ============================================ cleanup on every path after state exists ========= */

test("⚠️ the temporary root is removed on every exit path once it exists", async () => {
  const parent = privateParent();
  const missingPath = join(reapLater(mkdtempSync(join(tmpdir(), "kiln-canary-absent-"))), "does-not-exist.json");

  const paths = [
    [
      "stored credential file missing",
      { provider: "anthropic", model: MODEL, storedAuthPath: missingPath, hostEnv: cleanHost() },
      CANARY_REFUSAL.STORED_AUTH_MISSING,
    ],
    [
      "environment refused before spawning",
      { provider: "acme", model: "acme-model", custom: CUSTOM_DECLARATION, customProviderConfig: CUSTOM_CONFIG, hostEnv: cleanHost() },
      CANARY_REFUSAL.ENVIRONMENT_REFUSED,
    ],
    [
      "child exits non-zero",
      { provider: "anthropic", model: MODEL, hostEnv: cleanHost(), spawnImpl: stubSpawn("process.exitCode = 1") },
      CANARY_REFUSAL.CHILD_FAILED,
    ],
    [
      "child cannot be spawned",
      {
        provider: "anthropic",
        model: MODEL,
        hostEnv: cleanHost(),
        spawnImpl: () => {
          throw new Error("spawn failed");
        },
      },
      CANARY_REFUSAL.CHILD_FAILED,
    ],
    [
      "child prints something that is not JSON",
      { provider: "anthropic", model: MODEL, hostEnv: cleanHost(), spawnImpl: stubSpawn('process.stdout.write("not json")') },
      CANARY_REFUSAL.OUTPUT_INVALID,
    ],
    [
      "child prints the wrong shape",
      { provider: "anthropic", model: MODEL, hostEnv: cleanHost(), spawnImpl: stubSpawn(reportScript({ available: true })) },
      CANARY_REFUSAL.OUTPUT_INVALID,
    ],
    [
      "child never finishes",
      {
        provider: "anthropic",
        model: MODEL,
        hostEnv: cleanHost(),
        timeoutMs: 400,
        spawnImpl: stubSpawn("setTimeout(() => {}, 60000)"),
      },
      CANARY_REFUSAL.CHILD_FAILED,
    ],
  ];

  for (const [label, request, reason] of paths) {
    const e = await refusalOf(canary(parent, request), reason);
    assert.ok(e.detail.provider && e.detail.model, `${label}: the refusal names the provider and model`);
    assertNothingSurvived(parent, label);
  }

  assert.equal(existsSync(missingPath), false, "a missing stored path must not be created by the canary or by Pi");

  const environment = await refusalOf(
    canary(parent, { provider: "acme", model: "acme-model", custom: CUSTOM_DECLARATION, customProviderConfig: CUSTOM_CONFIG, hostEnv: cleanHost() }),
    CANARY_REFUSAL.ENVIRONMENT_REFUSED
  );
  assert.equal(environment.detail.environmentReason, "provider-name-missing");
  assertNothingSurvived(parent, "environment refusal detail");
});

test("⚠️ a failed removal is `canary-cleanup-failed` on every path, with the earlier reason preserved", async () => {
  // ⚠️ **BOTH WAYS A REMOVAL CAN FAIL, ON EVERY PATH THAT CREATES STATE.** A remover that throws is the
  // obvious failure; one that returns without removing is the quiet one, and it is caught only because the
  // root's absence is checked rather than assumed. When cleanup fails after another refusal, the cleanup
  // failure is what the caller must act on — a credential copy may still be on disk — and the earlier
  // reason travels in `priorReason` so the diagnosis is not lost.
  const parent = privateParent();
  const missing = join(reapLater(mkdtempSync(join(tmpdir(), "kiln-canary-absent-"))), "nope.json");

  const paths = [
    ["success", { provider: "anthropic", model: MODEL, hostEnv: cleanHost({ ANTHROPIC_API_KEY: SECRET }) }, undefined],
    ["unavailable", { provider: "anthropic", model: MODEL, hostEnv: cleanHost() }, CANARY_REFUSAL.UNAVAILABLE],
    [
      "stored file missing",
      { provider: "anthropic", model: MODEL, storedAuthPath: missing, hostEnv: cleanHost() },
      CANARY_REFUSAL.STORED_AUTH_MISSING,
    ],
    [
      "environment refused",
      { provider: "acme", model: "acme-model", custom: CUSTOM_DECLARATION, customProviderConfig: CUSTOM_CONFIG, hostEnv: cleanHost() },
      CANARY_REFUSAL.ENVIRONMENT_REFUSED,
    ],
    [
      "child failed",
      { provider: "anthropic", model: MODEL, hostEnv: cleanHost(), spawnImpl: stubSpawn("process.exitCode = 1") },
      CANARY_REFUSAL.CHILD_FAILED,
    ],
    [
      "output invalid",
      { provider: "anthropic", model: MODEL, hostEnv: cleanHost(), spawnImpl: stubSpawn('process.stdout.write("not json")') },
      CANARY_REFUSAL.OUTPUT_INVALID,
    ],
    [
      "forbidden source",
      {
        provider: "anthropic",
        model: MODEL,
        hostEnv: cleanHost(),
        spawnImpl: stubSpawn(reportScript({ available: true, configured: true, piSource: "runtime" })),
      },
      CANARY_REFUSAL.AUTH_SOURCE_FORBIDDEN,
    ],
  ];

  const removers = [
    [
      "throws",
      () => {
        throw new Error("removal failed on purpose");
      },
    ],
    ["returns without removing", () => {}],
  ];

  for (const [label, request, prior] of paths)
    for (const [how, remover] of removers) {
      let attempts = 0;
      const e = await refusalOf(
        canary(parent, {
          ...request,
          removeRoot: (root) => {
            attempts++;
            return remover(root);
          },
        }),
        CANARY_REFUSAL.CLEANUP_FAILED
      );
      assert.equal(attempts, 1, `${label}, remover ${how}: removal was attempted exactly once`);
      const expected = { provider: request.provider, model: request.model };
      if (prior !== undefined) expected.priorReason = prior;
      assert.deepEqual(e.detail, expected, `${label}, remover ${how}`);
      assertNoTrace(`cleanup failure after ${label}`, { message: e.message, detail: JSON.stringify(e.detail) });
    }

  // ⚠️ THE FAILURES WERE REAL: every failed removal left its root behind for the reaper.
  const survivors = readdirSync(parent).filter((n) => n.startsWith(CANARY_TEMP_PREFIX));
  assert.equal(survivors.length, paths.length * removers.length, "each failed removal must have left its root");
});

/* ============================================ nothing printed by the boundary ================== */

test("⚠️ the parent prints nothing and the child writes only its report", () => {
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const parent = strip(readFileSync(join(ROOT, "lib", "pi-provider-canary.mjs"), "utf-8"));
  const child = strip(readFileSync(CANARY_CHILD_PATH, "utf-8"));

  assert.ok(!/console\./.test(parent), "the parent must not log");
  assert.ok(!/process\.(stdout|stderr)/.test(parent), "the parent must not write to its own streams");
  // ⚠️ THE WHOLE-FILE ROUTE IS GONE, and this is its structural half; the selected-entry test is the other.
  assert.ok(!/copyFileSync/.test(parent), "stored credentials are never copied as a whole file");

  assert.ok(!/console\./.test(child), "the child must not log");
  assert.ok(!/process\.stderr/.test(child), "the child must not write to stderr");
  assert.equal((child.match(/process\.stdout\.write/g) ?? []).length, 1, "the child writes exactly one thing");

  // ⚠️ AND NEITHER CAN NAME THE TWO ROUTES THAT PUT A CREDENTIAL ON A COMMAND LINE OR ON STDOUT.
  for (const source of [parent, child]) {
    assert.ok(!source.includes("--api-key"), "no --api-key in code");
    assert.ok(!source.includes("print-api-key"), "no print-api-key in code");
    assert.ok(!/createAgentSession|AgentSession\(|\bsession\s*=/.test(source), "no agent session is constructed");
  }
});

test("the temporary prefix is the one the cleanup assertions look for", () => {
  assert.equal(CANARY_TEMP_PREFIX, "kiln-canary-");
});
