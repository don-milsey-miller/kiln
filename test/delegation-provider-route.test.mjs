/**
 * The credential route of a delegated child, through the package's own wrapper - #194.
 *
 * `kiln_delegate` handed the runtime no provider contract, so a provider authenticated through an environment
 * variable ran the session and failed in every child. The wrapper now takes the contract from trusted runtime state
 * and refuses, before a child exists, a route that cannot work.
 *
 * ⚠️ **THE REAL WRAPPER, THE REAL RUNTIME, THE REAL RECORDS.** Only two things are replaced. The process that would be
 * started is a recorder, so what a child WOULD have been handed is read exactly, and "nothing was spawned" is a count.
 * The executable resolver is a stub, because no executable is run. The project record and the grant are written by
 * Kiln's own modules, and stored authentication is asked of the pinned Pi.
 *
 * ⚠️ **EVERY CREDENTIAL HERE IS A SENTINEL.** Each is invented, is sent nowhere, and is searched for in every result.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { BASE_ENV } from "../lib/specialists/contract.mjs";
import { delegateToSpecialist } from "../lib/specialists/delegate.mjs";
import { ROUTE_REASON, ROUTE_REFUSED, sessionProviderRoute } from "../lib/specialists/provider-route.mjs";
import register from "../pi-package/extensions/kiln.js";
import { removeTestTree } from "./helpers/cleanup.mjs";
import { projectForDelegation } from "./helpers/delegation-project.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const TASK = "State in one sentence what this plan needs most.";
const CUSTOM = { provider: "acme-inference", model: "acme-large" };
const CUSTOM_VAR = "ACME_INFERENCE_KEY";
const SECRET = {
  custom: "acme-kiln-route-CUSTOM-7c1e55a0",
  openai: "sk-kiln-route-OPENAI-ENV-91bd02f4",
  stored: "sk-kiln-route-STORED-3fa86c17",
  unrelated: "kiln-route-UNRELATED-HOST-SECRET-d20e",
  research: "tvly-kiln-route-RESEARCH-64b9",
};
const HOST_TOOLS = ["kiln_create_requirement", "kiln_create_decision", "kiln_create_question", "kiln_list_artifacts", "kiln_read_artifact"];
/** Names this file sets or clears, so a case starts from a known host and the host is put back afterwards. */
const MANAGED = [
  "PLANNING_CONTENT_DIR", "KILN_PROJECT_ROOT", "KILN_STATE_MODE", CUSTOM_VAR, "OPENAI_API_KEY", "AZURE_OPENAI_API_KEY", "AZURE_OPENAI_BASE_URL",
  "AZURE_OPENAI_RESOURCE_NAME", "ANTHROPIC_API_KEY", "TAVILY_API_KEY", "KILN_ROUTE_UNRELATED_SECRET", "PI_CODING_AGENT_SESSION_DIR",
];

/**
 * A project as setup leaves it: a Git repository with Kiln's ignore block, a project record and, when asked, a
 * model-use grant - each written by the module that owns it.
 */
async function fixture({ grant = null, ignored = true, models = null, auth = "{}" } = {}) {
  const base = mkdtempSync(join(tmpdir(), "kiln-route-"));
  const project = join(base, "project");
  const contentRoot = join(project, "planning-content");
  const agentDir = join(base, "agent");
  mkdirSync(contentRoot, { recursive: true });
  mkdirSync(agentDir);
  writeFileSync(join(contentRoot, "project.yaml"), "name: route fixture\n");
  const { grantWritten } = await projectForDelegation(project, { ignored, grant });
  if (grant) assert.equal(grantWritten, ignored, "the fixture's grant was not recorded as expected");
  // `auth` is the file's text, `null` for no file, or `"directory"` for something that cannot be read as a file.
  if (auth === "directory") mkdirSync(join(agentDir, "auth.json"));
  else if (auth !== null) writeFileSync(join(agentDir, "auth.json"), auth);
  writeFileSync(join(agentDir, "models.json"), JSON.stringify(models ?? { providers: {} }));
  return { base, project, contentRoot, agentDir };
}

const customModels = (apiKey) => ({ providers: { [CUSTOM.provider]: { baseUrl: "http://127.0.0.1:9/v1", api: "openai-completions", apiKey, models: [{ id: CUSTOM.model }] } } });
const customGrant = (over = {}) => ({ model: { ...CUSTOM, credentialVar: CUSTOM_VAR, ...over } });

/**
 * Run `kiln_delegate` once through the real wrapper and runtime, with the spawn replaced by a recorder.
 *
 * @returns {Promise<{details: object, text: string, spawned: Array<{env: object}>}>}
 */
async function delegate(f, { selection, env = {}, projectRoot = f.project }) {
  const saved = Object.fromEntries(MANAGED.map((name) => [name, process.env[name]]));
  for (const name of MANAGED) delete process.env[name];
  Object.assign(process.env, { PLANNING_CONTENT_DIR: f.contentRoot, KILN_ROUTE_UNRELATED_SECRET: SECRET.unrelated, TAVILY_API_KEY: SECRET.research, ...env });
  if (projectRoot !== null) process.env.KILN_PROJECT_ROOT = projectRoot;

  const spawned = [];
  const runtime = (request) =>
    delegateToSpecialist(request, {
      resolveAgent: () => ({ command: "node", args: ["cli.js"] }),
      // ⚠️ THE RECORDER. It keeps what the child would have been handed and starts nothing.
      spawn: (_command, _args, options) => {
        spawned.push({ env: { ...options.env } });
        throw Object.assign(new Error("recorded, not started"), { code: "ENOENT" });
      },
      trackDescendants: () => ({ stop: async () => {}, snapshot: () => [] }),
      stopTree: async () => ({ exitObserved: true }),
    });

  const tools = new Map();
  register({ registerTool: (t) => tools.set(t.name, t), getAllTools: () => HOST_TOOLS.map((name) => ({ name })) }, { agentDir: f.agentDir, delegate: runtime });
  try {
    const result = await tools.get("kiln_delegate").execute("call-1", { role: "planning", task: TASK }, undefined, undefined, {
      model: { provider: selection.provider, id: selection.model },
      thinkingLevel: "off",
    });
    return { details: result.details, text: JSON.stringify(result), spawned };
  } finally {
    for (const name of MANAGED) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  }
}

/** Exactly the names a child may hold on this host for a contract's `declared` names. */
function expectedNames(declared) {
  const win32 = process.platform === "win32";
  const host = Object.keys(process.env);
  const set = (name) => (win32 ? host.some((k) => k.toLowerCase() === name.toLowerCase()) : name in process.env);
  return [
    ...BASE_ENV[win32 ? "win32" : "posix"].filter(set),
    "PI_CODING_AGENT_DIR",
    "PLANNING_CONTENT_DIR",
    "KILN_ARTIFACT_READ_TYPES",
    "KILN_TASK_NONCE",
    "KILN_ATTEST_FD",
    ...declared,
  ].sort();
}

/** A child was reached, and was handed exactly the base names and `declared`. */
function assertSpawnedWith(run, declared) {
  assert.equal(run.spawned.length, 1, `the runtime did not reach the spawn: ${JSON.stringify(run.details)}`);
  const { env } = run.spawned[0];
  assert.deepEqual(Object.keys(env).sort(), expectedNames(declared), "the child's environment is not exactly the allowlist");
  // No host secret under another name, and none of the names research or the project context would need.
  const values = Object.entries(env);
  for (const [label, secret] of Object.entries(SECRET)) {
    const under = values.filter(([, value]) => String(value).includes(secret)).map(([name]) => name);
    assert.deepEqual(under.filter((name) => !declared.includes(name)), [], `the ${label} sentinel reached the child outside its declared name`);
  }
  for (const name of ["TAVILY_API_KEY", "KILN_PROJECT_ROOT", "KILN_STATE_MODE", "KILN_ROUTE_UNRELATED_SECRET", "LOCALAPPDATA", "XDG_STATE_HOME"])
    assert.equal(name in env, false, `${name} reached the child`);
  // The recorder refused the start, which is the only reason this run did not succeed.
  assert.equal(run.details.code, "child-executable-not-found");
}

/** A refusal with the fixed shape, the expected reason, nothing spawned and nothing of the host in it. */
function assertRouteRefused(run, reason, f) {
  assert.equal(run.spawned.length, 0, `a child was started for a route that cannot work (${reason})`);
  assert.deepEqual(Object.keys(run.details).sort(), ["code", "message", "observed", "ok", "reason"]);
  assert.equal(run.details.ok, false);
  assert.equal(run.details.code, "credential-route-unavailable");
  assert.equal(run.details.code, ROUTE_REFUSED);
  assert.equal(run.details.reason, reason);
  assert.equal(run.details.observed, null);
  assert.equal(run.details.message, "This session's provider has no usable credential route for a delegated child, so none was started.");
  for (const [label, secret] of Object.entries(SECRET)) assert.equal(run.text.includes(secret), false, `the ${label} sentinel is in the refusal`);
  for (const leaked of [CUSTOM_VAR, "OPENAI_API_KEY", "AZURE_OPENAI", "auth.json", "models.json", f.base, f.base.split("\\").join("/"), f.base.split("\\").join("\\\\"), "node cli.js"])
    assert.equal(run.text.includes(leaked), false, `the refusal carries ${leaked}`);
}

/* ================================================================== 1. a custom provider, environment only */

test("⚠️ #194 a custom provider whose key is only in the environment reaches the child under its declared name and no other", async () => {
  const f = await fixture({ grant: customGrant(), models: customModels(`$${CUSTOM_VAR}`) });
  try {
    const run = await delegate(f, { selection: CUSTOM, env: { [CUSTOM_VAR]: SECRET.custom, OPENAI_API_KEY: SECRET.openai, ANTHROPIC_API_KEY: SECRET.unrelated } });
    assertSpawnedWith(run, [CUSTOM_VAR]);
    assert.equal(run.spawned[0].env[CUSTOM_VAR], SECRET.custom);
    assert.equal(run.spawned[0].env.PI_CODING_AGENT_DIR, f.agentDir, "the child was not given the session's agent directory");
  } finally {
    await removeTestTree(f.base);
  }
});

test("⚠️ #194 a custom provider whose declared variable is not set is refused before any child", async () => {
  const f = await fixture({ grant: customGrant(), models: customModels(`$${CUSTOM_VAR}`), auth: JSON.stringify({ [CUSTOM.provider]: { type: "api_key", key: SECRET.stored } }) });
  try {
    // A stored entry under the same id does not rescue it: a custom contract has an environment route only.
    assertRouteRefused(await delegate(f, { selection: CUSTOM, env: { OPENAI_API_KEY: SECRET.openai } }), "variable-unset", f);
  } finally {
    await removeTestTree(f.base);
  }
});

/* ================================================================== 2 and 3. a built-in provider with both routes */

test("⚠️ #194 a built-in provider with its key in the environment hands the child that name alone", async () => {
  const f = await fixture();
  try {
    // No project is named: a built-in contract is Kiln's table and needs no record.
    const run = await delegate(f, { selection: { provider: "openai", model: "gpt-5" }, env: { OPENAI_API_KEY: SECRET.openai, [CUSTOM_VAR]: SECRET.custom }, projectRoot: null });
    assertSpawnedWith(run, ["OPENAI_API_KEY"]);
    assert.equal(run.spawned[0].env.OPENAI_API_KEY, SECRET.openai);
  } finally {
    await removeTestTree(f.base);
  }
});

test("⚠️ #194 a built-in provider with no environment key falls back to stored authentication, and the child is handed no key", async () => {
  const f = await fixture({ auth: JSON.stringify({ openai: { type: "api_key", key: SECRET.stored } }) });
  try {
    const run = await delegate(f, { selection: { provider: "openai", model: "gpt-5" }, env: { [CUSTOM_VAR]: SECRET.custom } });
    assertSpawnedWith(run, []);
    assert.equal(run.text.includes(SECRET.stored), false, "the stored value reached the result");
  } finally {
    await removeTestTree(f.base);
  }
});

test("⚠️ #194 an incomplete environment route is never handed over in part: it uses stored authentication or is refused", async () => {
  // Azure needs its key and one of two locators. The key alone is not a route.
  const azure = { provider: "azure-openai-responses", model: "gpt-5" };
  const stored = await fixture({ auth: JSON.stringify({ [azure.provider]: { type: "api_key", key: SECRET.stored } }) });
  const none = await fixture();
  try {
    assertSpawnedWith(await delegate(stored, { selection: azure, env: { AZURE_OPENAI_API_KEY: SECRET.openai } }), []);
    assertRouteRefused(await delegate(none, { selection: azure, env: { AZURE_OPENAI_API_KEY: SECRET.openai } }), "stored-unavailable", none);
    assertRouteRefused(await delegate(none, { selection: { provider: "openai", model: "gpt-5" } }), "stored-unavailable", none);
  } finally {
    await removeTestTree(stored.base);
    await removeTestTree(none.base);
  }
});

/* ================================================================== 4. a stored-only provider */

test("⚠️ #194 a stored-only provider uses stored authentication when Pi reports it, and is refused when Pi does not", async () => {
  const codex = { provider: "openai-codex", model: "gpt-5.6-sol" };
  const present = await fixture({ auth: JSON.stringify({ [codex.provider]: { type: "oauth", access: SECRET.stored, refresh: SECRET.stored, expires: 4102444800000 } }) });
  const absent = await fixture({ auth: JSON.stringify({ openai: { type: "api_key", key: SECRET.stored } }) });
  try {
    // A variable of a plausible name on the host is not a route for a provider that declares none.
    assertSpawnedWith(await delegate(present, { selection: codex, env: { OPENAI_API_KEY: SECRET.openai } }), []);
    // Another provider's stored entry is not this provider's.
    assertRouteRefused(await delegate(absent, { selection: codex, env: { OPENAI_API_KEY: SECRET.openai } }), "stored-unavailable", absent);
  } finally {
    await removeTestTree(present.base);
    await removeTestTree(absent.base);
  }
});

/* ================================================================== 5. stored authentication that cannot be read */

test("⚠️ #194 unreadable, missing or malformed stored authentication is refused, and nothing of the file is repeated", async () => {
  const cases = [
    ["no file", null],
    ["not JSON", `{ "openai": { "type": "api_key", "key": "${SECRET.stored}" `],
    ["not an object", JSON.stringify([{ openai: SECRET.stored }])],
    ["a directory where the file should be", "directory"],
  ];
  for (const [label, auth] of cases) {
    const f = await fixture({ auth });
    try {
      for (const selection of [{ provider: "openai", model: "gpt-5" }, { provider: "openai-codex", model: "gpt-5.6-sol" }]) {
        const run = await delegate(f, { selection });
        assertRouteRefused(run, "stored-unavailable", f);
        assert.equal(run.text.includes(SECRET.stored), false, `${label}: the stored value is in the refusal`);
      }
    } finally {
      await removeTestTree(f.base);
    }
  }
});

/* ================================================================== 6. the recorded declaration */

test("⚠️ #194 a custom provider is refused when models.json does not read its key from the declared variable", async () => {
  for (const [label, apiKey] of [["another variable", "$ACME_OTHER_KEY"], ["an inline literal key", SECRET.custom], ["a command", "!print-acme-key"]]) {
    const f = await fixture({ grant: customGrant(), models: customModels(apiKey) });
    try {
      const run = await delegate(f, { selection: CUSTOM, env: { [CUSTOM_VAR]: SECRET.custom, ACME_OTHER_KEY: SECRET.custom } });
      assertRouteRefused(run, "route-mismatch", f);
      assert.equal(run.text.includes("ACME_OTHER_KEY") || run.text.includes("print-acme-key"), false, `${label}: models.json was repeated`);
    } finally {
      await removeTestTree(f.base);
    }
  }
  // The provider is not in models.json at all.
  const absent = await fixture({ grant: customGrant() });
  try {
    assertRouteRefused(await delegate(absent, { selection: CUSTOM, env: { [CUSTOM_VAR]: SECRET.custom } }), "route-mismatch", absent);
  } finally {
    await removeTestTree(absent.base);
  }
});

test("⚠️ #194 a custom provider with no standing grant for exactly this provider and model is refused", async () => {
  const env = { [CUSTOM_VAR]: SECRET.custom };
  const cases = [
    ["no grant recorded", null],
    ["a declined grant", { ...customGrant(), granted: false }],
    ["a grant for another model of the provider", customGrant({ model: "acme-small" })],
    ["a grant for another provider", customGrant({ provider: "other-inference" })],
  ];
  for (const [label, grant] of cases) {
    const f = await fixture({ grant, models: customModels(`$${CUSTOM_VAR}`) });
    try {
      const run = await delegate(f, { selection: CUSTOM, env });
      assert.equal(run.details.reason, "not-granted", label);
      assertRouteRefused(run, "not-granted", f);
    } finally {
      await removeTestTree(f.base);
    }
  }
});

test("⚠️ #194 a custom provider with a grant and no declared variable has no contract, inline key or not", async () => {
  const f = await fixture({ grant: { model: { ...CUSTOM } }, models: customModels(SECRET.custom) });
  try {
    assertRouteRefused(await delegate(f, { selection: CUSTOM, env: { [CUSTOM_VAR]: SECRET.custom } }), "no-contract", f);
    // A provider the table declines stays declined.
    assertRouteRefused(await delegate(f, { selection: { provider: "amazon-bedrock", model: "claude" } }), "no-contract", f);
  } finally {
    await removeTestTree(f.base);
  }
});

test("⚠️ #194 a custom provider is refused when no project is named or its consent record cannot be trusted", async () => {
  const env = { [CUSTOM_VAR]: SECRET.custom };
  const named = await fixture({ grant: customGrant(), models: customModels(`$${CUSTOM_VAR}`) });
  // With no ignore block the consent record sits where Git would track it, so it is not opened.
  const unprotected = await fixture({ grant: customGrant(), ignored: false, models: customModels(`$${CUSTOM_VAR}`) });
  try {
    assertRouteRefused(await delegate(named, { selection: CUSTOM, env, projectRoot: null }), "consent-unreadable", named);
    assertRouteRefused(await delegate(named, { selection: CUSTOM, env, projectRoot: join(named.base, "no such project") }), "consent-unreadable", named);
    assertRouteRefused(await delegate(named, { selection: CUSTOM, env: { ...env, KILN_STATE_MODE: "elsewhere" } }), "consent-unreadable", named);
    assertRouteRefused(await delegate(unprotected, { selection: CUSTOM, env }), "consent-unreadable", unprotected);
  } finally {
    await removeTestTree(named.base);
    await removeTestTree(unprotected.base);
  }
});

/* ================================================================== the wrapper and the resolver */

test("⚠️ #194 the wrapper passes on a reason only when it is one of the six, and never calls the runtime on a refusal", async () => {
  const f = await fixture();
  const hostile = `C:\\Users\\operator\\auth.json ${SECRET.stored} ${CUSTOM_VAR}`;
  const saved = process.env.PLANNING_CONTENT_DIR;
  process.env.PLANNING_CONTENT_DIR = f.contentRoot;
  try {
    assert.deepEqual(Object.values(ROUTE_REASON).sort(), ["consent-unreadable", "no-contract", "not-granted", "route-mismatch", "stored-unavailable", "variable-unset"]);
    const outcomes = [
      [async () => ({ ok: false, code: hostile, message: hostile, reason: hostile, detail: hostile, variable: CUSTOM_VAR }), undefined],
      [async () => ({ ok: false, reason: "stored-unavailable", message: hostile, path: hostile }), "stored-unavailable"],
      [async () => { throw new Error(hostile); }, undefined],
      [async () => null, undefined],
      [async () => ({ ok: "yes", contract: {} }), undefined],
    ];
    for (const [providerRoute, reason] of outcomes) {
      let called = 0;
      const tools = new Map();
      register({ registerTool: (t) => tools.set(t.name, t), getAllTools: () => HOST_TOOLS.map((name) => ({ name })) }, { agentDir: f.agentDir, providerRoute, delegate: async () => (called++, { ok: true }) });
      const result = await tools.get("kiln_delegate").execute("call-1", { role: "planning", task: TASK }, undefined, undefined, { model: { provider: "openai", id: "gpt-5" }, thinkingLevel: "off" });
      assert.equal(called, 0, "the runtime was called for a refused route");
      assert.equal(result.details.code, "credential-route-unavailable");
      assert.equal(result.details.reason, reason);
      assert.equal(result.details.observed, null);
      const text = JSON.stringify(result);
      for (const leaked of ["operator", SECRET.stored, CUSTOM_VAR, "auth.json"]) assert.equal(text.includes(leaked), false, `the wrapper repeated ${leaked}`);
    }
  } finally {
    if (saved === undefined) delete process.env.PLANNING_CONTENT_DIR;
    else process.env.PLANNING_CONTENT_DIR = saved;
    await removeTestTree(f.base);
  }
});

test("⚠️ #194 the resolver reads the environment it is given by declared name, and a stored answer is a boolean from Pi", async () => {
  const f = await fixture({ auth: JSON.stringify({ openai: { type: "api_key", key: SECRET.stored } }) });
  try {
    const session = { provider: "openai", model: "gpt-5", agentDir: f.agentDir, toolRoot: ROOT };
    // An environment that throws for any name the contract does not declare proves nothing else is looked at.
    const guarded = (set) => new Proxy(set, {
      get: (target, name) => {
        if (typeof name === "string" && name !== "OPENAI_API_KEY") throw new Error(`the resolver read ${name}`);
        return target[name];
      },
      has: (target, name) => {
        if (name !== "OPENAI_API_KEY") throw new Error(`the resolver asked about ${String(name)}`);
        return name in target;
      },
      ownKeys: () => { throw new Error("the resolver enumerated the environment"); },
    });
    const viaEnvironment = await sessionProviderRoute(session, { env: guarded({ OPENAI_API_KEY: SECRET.openai }), platform: "linux", storedPresent: () => assert.fail("stored authentication was asked about when the environment route was complete") });
    assert.equal(viaEnvironment.ok, true);
    assert.equal(viaEnvironment.route, "environment");
    assert.equal(JSON.stringify(viaEnvironment).includes(SECRET.openai), false, "the resolver returned a value");

    const viaStored = await sessionProviderRoute(session, { env: guarded({}), platform: "linux" });
    assert.deepEqual({ ok: viaStored.ok, route: viaStored.route }, { ok: true, route: "stored" });
    assert.equal(JSON.stringify(viaStored).includes(SECRET.stored), false, "the stored value was returned");

    // Only `true` is presence.
    for (const answer of ["yes", 1, { configured: true }, undefined])
      assert.deepEqual(await sessionProviderRoute(session, { env: {}, storedPresent: () => answer }), { ok: false, code: ROUTE_REFUSED, reason: "stored-unavailable" });
  } finally {
    await removeTestTree(f.base);
  }
});
