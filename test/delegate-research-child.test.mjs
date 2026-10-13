/**
 * A delegated research child and the research permission check - #215.
 *
 * A research child was started with nothing its own research tools read: no project, no state mode, no state home
 * and no key. Every research tool call inside it answered `research-no-project-context`, in a project that had chosen
 * research and on a computer that had granted it.
 *
 * ⚠️ **THE CHILD MAKES THE SAME TWO-RECORD CHECK ITS PARENT DOES.** The research role is handed the locators that
 * check reads and nothing else of the session: not the run, not another credential, and not both state-home names.
 *
 * ⚠️ **THE PARENT RESOLVES THE KEY, AND ONLY AFTER PERMISSION.** From the environment or the system vault, and it
 * crosses as one named variable. Inside a child the vault is never asked.
 *
 * ⚠️ **NOTHING HERE CONTACTS TAVILY.** The real children are given a test-only extension, through the runtime's
 * `extraExtensions` seam, that sends requests for `https://api.tavily.com/` to a server on the loopback interface and
 * leaves every other request alone. Production has no way to move that address. The key is a placeholder.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { consentLocation } from "../lib/consent-record.mjs";
import { CREDENTIAL_SERVICE, DELEGATED_CHILD_ENV, runtimeCredentialEnv } from "../lib/credential-broker.mjs";
import { journalLocation, journalLocationFromEnv } from "../lib/decision-bundle-journal.mjs";
import { RECOVERY_REASON, RECOVERY_REQUEST_FILE, requestRecovery } from "../lib/recovery-request.mjs";
import { RESEARCH_REFUSAL } from "../lib/research/permission.mjs";
import { AGENT_DIR_ENV, BASE_ENV, RESEARCH_CONTEXT_ENV, childEnv } from "../lib/specialists/contract.mjs";
import { delegateToSpecialist } from "../lib/specialists/delegate.mjs";
import { sessionResearchRoute } from "../lib/specialists/research-route.mjs";
import { NONCE_ENV } from "../lib/specialists/task-observer.mjs";
import { VOICE_ENV } from "../lib/voice/config.mjs";
import { resolveProjectVoiceConfig } from "../lib/voice/project-config.mjs";
import { CARRYOVER_FILE, clearCarryover, readCarryover, writeCarryover } from "../lib/workflow-carryover.mjs";
import register from "../pi-package/extensions/kiln.js";
import { removeTestTree } from "./helpers/cleanup.mjs";
import { projectForDelegation } from "./helpers/delegation-project.mjs";
import { FIXTURE_KEY, FIXTURE_KEY_VAR, FIXTURE_MODEL, FIXTURE_PROVIDER, modelsJson, startProviderFixture } from "./helpers/provider-fixture.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const WIN32 = process.platform === "win32";
const TASK = "Find one source on nightly dock-fee reconciliation.";
const ANSWER = "RESEARCH-CHILD-ANSWER-215";
const QUERY = "nightly dock fee reconciliation";
const TAVILY_VAR = "TAVILY_API_KEY";
const TAVILY_HOST = "https://api.tavily.com/";
/** Placeholders. Each is invented, is sent only to the loopback interface, and is searched for in every result. */
const KEY = { env: "tvly-kiln-215-ENV-PLACEHOLDER-5d1c", vault: "tvly-kiln-215-VAULT-PLACEHOLDER-a90e" };
const OTHER = {
  OPENAI_API_KEY: "sk-kiln-215-OPENAI-0b7e",
  ELEVENLABS_API_KEY: "el-kiln-215-ELEVENLABS-44c2",
  TYPESAFE_API_KEY: "ts-kiln-215-TYPESAFE-e1f9",
  KILN_215_UNRELATED_SECRET: "kiln-215-UNRELATED-3a6d",
};
const RUN_ID = "00112233445566778899aabbccddeeff";
const CONTEXT = [RESEARCH_CONTEXT_ENV.PROJECT_ROOT, RESEARCH_CONTEXT_ENV.STATE_MODE];
const STATE_HOME = WIN32 ? RESEARCH_CONTEXT_ENV.STATE_HOME_WIN32 : RESEARCH_CONTEXT_ENV.STATE_HOME_POSIX;
/** Names a case sets, each put back afterwards. `CLEARED` are also removed first, so a case starts from a known host. */
const CLEARED = ["PLANNING_CONTENT_DIR", "KILN_PROJECT_ROOT", "KILN_STATE_MODE", "KILN_RUN_ID", TAVILY_VAR, FIXTURE_KEY_VAR, VOICE_ENV.enabled, "PI_CODING_AGENT_SESSION_DIR", ...Object.keys(OTHER)];
const RESTORED = [...CLEARED, "LOCALAPPDATA", "XDG_STATE_HOME"];

/** The per-user state home of a fixture host, beside the project and outside its repository. */
const hostState = (base) => ({ [STATE_HOME]: join(base, "host-state") });

/**
 * A project as setup leaves it, with the research choice and this computer's answer a case asks for.
 *
 * @param {{research?: {chosen?: boolean, granted?: boolean|null}, stateMode?: "project"|"user"}} [o]
 */
async function fixture({ research = { granted: true }, stateMode = "project" } = {}) {
  const base = mkdtempSync(join(tmpdir(), "kiln-research-child-"));
  const project = join(base, "project");
  const contentRoot = join(project, "planning-content");
  const agentDir = join(base, "agent");
  mkdirSync(contentRoot, { recursive: true });
  mkdirSync(agentDir);
  writeFileSync(join(contentRoot, "project.yaml"), "name: research child fixture\n");
  const stateEnv = stateMode === "user" ? { ...process.env, ...hostState(base) } : process.env;
  const { projectId, grantWritten } = await projectForDelegation(project, {
    grant: { model: { provider: FIXTURE_PROVIDER, model: FIXTURE_MODEL, credentialVar: FIXTURE_KEY_VAR } },
    research,
    stateMode,
    env: stateEnv,
  });
  assert.equal(grantWritten, true, "the fixture's model-use grant was not recorded");
  writeFileSync(join(agentDir, "auth.json"), "{}");
  const where = { projectRoot: project, stateMode, projectId, env: stateEnv };
  return { base, project, contentRoot, agentDir, stateMode, runtime: consentLocation(where).runtime, journal: journalLocation(where).path };
}

/** A stand-in for Tavily on the loopback interface. It records the path and the credential of every request. */
async function tavilyLoopback() {
  const seen = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => (raw += d));
    req.on("end", () => {
      const path = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
      seen.push({ method: req.method, path, authorization: req.headers.authorization ?? null, body: raw });
      res.writeHead(200, { "content-type": "application/json", connection: "close" });
      if (path === "/usage") return res.end(JSON.stringify({ account: { plan_usage: 1, plan_limit: 1000 } }));
      if (path === "/search") return res.end(JSON.stringify({ results: [{ title: "Dock fees", url: "https://example.com/dock-fees", content: "Reconciled nightly.", score: 0.9 }] }));
      return res.end("{}");
    });
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  return { port: server.address().port, seen, close: () => new Promise((done) => server.close(done)) };
}

/**
 * The test-only extension a real child is given: requests for Tavily's own address go to the loopback stand-in, and
 * every other request is passed on untouched.
 */
const INTERCEPT_EXT = (port) => `
export default function () {
  const real = globalThis.fetch;
  const TAVILY = ${JSON.stringify(TAVILY_HOST)};
  globalThis.fetch = (input, init) => {
    const url = typeof input === "string" ? input : String(input?.url ?? input);
    if (!url.startsWith(TAVILY)) return real(input, init);
    return real("http://127.0.0.1:${port}/" + url.slice(TAVILY.length), init);
  };
}
`;

/**
 * Run `kiln_delegate` once through the real wrapper and runtime.
 *
 * `real` starts the pinned agent, with the interceptor above. Otherwise the spawn is a recorder: what the child WOULD
 * have been handed is read exactly, and "nothing was spawned" is a count.
 *
 * @returns {Promise<{details: object, text: string, spawned: Array<{env: object}>, requests: object[]}>}
 */
async function delegate(f, { role = "research", env = {}, real = null, vault = null, script = [{ text: ANSWER }] } = {}) {
  const provider = await startProviderFixture({ script });
  writeFileSync(join(f.agentDir, "models.json"), JSON.stringify(modelsJson(provider.url)));
  const saved = Object.fromEntries(RESTORED.map((name) => [name, process.env[name]]));
  for (const name of CLEARED) delete process.env[name];
  Object.assign(process.env, {
    PLANNING_CONTENT_DIR: f.contentRoot,
    KILN_PROJECT_ROOT: f.project,
    KILN_STATE_MODE: f.stateMode,
    // What a supervised session holds and no child may: the run, and credentials for other services.
    KILN_RUN_ID: RUN_ID,
    [VOICE_ENV.enabled]: "true",
    [FIXTURE_KEY_VAR]: FIXTURE_KEY,
    ...OTHER,
    ...(f.stateMode === "user" ? hostState(f.base) : {}),
    ...env,
  });

  const spawned = [];
  const runtime = real
    ? (request) => delegateToSpecialist(request, { extraExtensions: [real.extension] })
    : (request) =>
        delegateToSpecialist(request, {
          resolveAgent: () => ({ command: "node", args: ["cli.js"] }),
          spawn: (_command, _args, options) => {
            spawned.push({ env: { ...options.env } });
            throw Object.assign(new Error("recorded, not started"), { code: "ENOENT" });
          },
          trackDescendants: () => ({ stop: async () => {}, snapshot: () => [] }),
          stopTree: async () => ({ exitObserved: true }),
        });
  // The system vault is replaced by a store a case fills, and every question put to it is counted.
  const asked = [];
  const secureStore = { available: true, get: async (service) => (asked.push(service), vault) };
  const researchRoute = () => sessionResearchRoute({ credentialEnv: (service, o) => runtimeCredentialEnv(service, { ...o, secureStore }) });

  const tools = new Map();
  register({ registerTool: (t) => tools.set(t.name, t), getAllTools: () => [...tools.keys()].map((name) => ({ name })) }, { agentDir: f.agentDir, delegate: runtime, researchRoute });
  try {
    const result = await tools.get("kiln_delegate").execute("call-1", { role, task: TASK }, undefined, undefined, {
      model: { provider: FIXTURE_PROVIDER, id: FIXTURE_MODEL },
      thinkingLevel: "off",
    });
    return { details: result.details, text: JSON.stringify(result), spawned, requests: provider.requests, asked, parentHeld: process.env[TAVILY_VAR] ?? null };
  } finally {
    for (const name of RESTORED) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
    await provider.close();
  }
}

/** Exactly the names a child may hold on this host beyond the base, for `declared`. */
function expectedNames(declared) {
  const host = Object.keys(process.env);
  const set = (name) => (WIN32 ? host.some((k) => k.toLowerCase() === name.toLowerCase()) : name in process.env);
  return [...BASE_ENV[WIN32 ? "win32" : "posix"].filter(set), AGENT_DIR_ENV, "PLANNING_CONTENT_DIR", "KILN_ARTIFACT_READ_TYPES", NONCE_ENV, "KILN_ATTEST_FD", FIXTURE_KEY_VAR, ...declared].sort();
}

/** One child was reached, with exactly the allowlist plus `declared`, and nothing else of the session. */
function assertSpawnedWith(run, declared) {
  assert.equal(run.spawned.length, 1, `the runtime did not reach the spawn: ${JSON.stringify(run.details)}`);
  const { env } = run.spawned[0];
  assert.deepEqual(Object.keys(env).sort(), expectedNames(declared), "the child's environment is not exactly the allowlist");
  assert.equal("KILN_RUN_ID" in env, false, "the run reached the child");
  for (const [name, secret] of Object.entries(OTHER)) {
    assert.equal(name in env, false, `${name} reached the child`);
    assert.equal(Object.values(env).some((value) => String(value).includes(secret)), false, `the ${name} value reached the child under another name`);
  }
  assert.equal(RESEARCH_CONTEXT_ENV.STATE_HOME_WIN32 in env && RESEARCH_CONTEXT_ENV.STATE_HOME_POSIX in env, false, "both state-home names reached the child");
  return env;
}

/** What the child's research tools answered, as the provider was shown it on the next request. */
const toolResults = (requests) =>
  requests
    .flatMap((r) => (r.body?.messages ?? []).filter((m) => m.role === "tool"))
    .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
    .filter((text, i, all) => all.indexOf(text) === i);

const CAPABILITY_THEN_SEARCH = [{ toolCalls: [{ name: "research_capability", arguments: {} }] }, { toolCalls: [{ name: "research_search", arguments: { query: QUERY } }] }, { text: ANSWER }];

/* ========================================================================== the child's environment ==== */

for (const stateMode of ["project", "user"])
  test(`⚠️ #215 a permitted research child is handed the key and the ${stateMode}-mode locators, and nothing else of the session`, async () => {
    const f = await fixture({ stateMode });
    try {
      const run = await delegate(f, { env: { [TAVILY_VAR]: KEY.env } });
      const env = assertSpawnedWith(run, [TAVILY_VAR, ...CONTEXT, ...(stateMode === "user" ? [STATE_HOME] : [])]);
      assert.equal(env[TAVILY_VAR], KEY.env);
      assert.equal(env.KILN_PROJECT_ROOT, f.project);
      assert.equal(env.KILN_STATE_MODE, stateMode);
      if (stateMode === "user") assert.equal(env[STATE_HOME], hostState(f.base)[STATE_HOME]);
      assert.deepEqual(run.asked, [], "the vault was asked although the environment held the key");
      assert.equal(run.text.includes(KEY.env), false, "the key reached the result");
    } finally {
      removeTestTree(f.base, "#215 research child environment");
    }
  });

test("⚠️ #215 a key held only in the system vault is resolved by the parent and crosses as the one named variable", async () => {
  const f = await fixture();
  try {
    const run = await delegate(f, { vault: KEY.vault });
    const env = assertSpawnedWith(run, [TAVILY_VAR, ...CONTEXT]);
    assert.equal(env[TAVILY_VAR], KEY.vault);
    assert.deepEqual(run.asked, [CREDENTIAL_SERVICE.TAVILY], "the vault was not asked exactly once, for research");
    assert.equal(run.parentHeld, null, "resolving the key wrote it into the session's own environment");
    assert.equal(run.text.includes(KEY.vault), false, "the key reached the result");
  } finally {
    removeTestTree(f.base, "#215 vault-held key");
  }
});

test("⚠️ #215 a permitted project with no key anywhere is refused before a child exists: research-credential-missing", async () => {
  const f = await fixture();
  try {
    const run = await delegate(f, { vault: null });
    assert.equal(run.spawned.length, 0, "a child was started");
    assert.equal(run.details.ok, false);
    assert.equal(run.details.code, "child-environment-refused");
    assert.equal(run.details.reason, "research-credential-missing");
    assert.deepEqual(run.asked, [CREDENTIAL_SERVICE.TAVILY]);
    assert.equal(run.requests.length, 0, "a provider was contacted");
  } finally {
    removeTestTree(f.base, "#215 no key");
  }
});

for (const [what, research] of [
  ["declined on this computer", { granted: false }],
  ["chosen and never answered here", { granted: null }],
  ["not chosen by the project", { chosen: false }],
])
  test(`⚠️ #215 research ${what}: the child starts with the locators and no key, and neither the key nor the vault is read`, async () => {
    const f = await fixture({ research });
    try {
      const run = await delegate(f, { env: { [TAVILY_VAR]: KEY.env }, vault: KEY.vault });
      const env = assertSpawnedWith(run, CONTEXT);
      assert.equal(TAVILY_VAR in env, false);
      for (const key of Object.values(KEY)) assert.equal(Object.values(env).some((value) => String(value).includes(key)), false, "a research key reached the child");
      assert.deepEqual(run.asked, [], "the vault was asked for a project that has not permitted research");
    } finally {
      removeTestTree(f.base, "#215 research not permitted");
    }
  });

for (const role of ["planning", "validation"])
  test(`⚠️ #215 a ${role} child in a project that permits research receives no key and no project context`, async () => {
    const f = await fixture({ stateMode: "user" });
    try {
      // Once with the key in the session's environment, and once with it only in the vault, where resolving it at
      // all would show as a question put to the vault.
      for (const held of [{ [TAVILY_VAR]: KEY.env }, {}]) {
        const run = await delegate(f, { role, env: held, vault: KEY.vault });
        const env = assertSpawnedWith(run, []);
        for (const name of [TAVILY_VAR, ...Object.values(RESEARCH_CONTEXT_ENV)]) assert.equal(name in env, false, `${name} reached a ${role} child`);
        for (const key of Object.values(KEY)) assert.equal(Object.values(env).some((value) => String(value).includes(key)), false);
        assert.deepEqual(run.asked, [], "the vault was asked for a role that holds no research credential");
      }
    } finally {
      removeTestTree(f.base, `#215 ${role} child`);
    }
  });

test("⚠️ #215 the state-home name is one per platform, only in user mode, and on POSIX only when it is set", () => {
  const host = { PATH: "p", [AGENT_DIR_ENV]: "agent", KILN_PROJECT_ROOT: "project", KILN_RUN_ID: RUN_ID, LOCALAPPDATA: "local", XDG_STATE_HOME: "xdg", HOME: "home" };
  const names = (platform, over) => Object.keys(childEnv("research", { ...host, ...over }, { platform })).filter((name) => name.startsWith("KILN_") || name === "LOCALAPPDATA" || name === "XDG_STATE_HOME");
  assert.deepEqual(names("win32", { KILN_STATE_MODE: "project" }), ["KILN_PROJECT_ROOT", "KILN_STATE_MODE"]);
  assert.deepEqual(names("linux", { KILN_STATE_MODE: "project" }), ["KILN_PROJECT_ROOT", "KILN_STATE_MODE"]);
  assert.deepEqual(names("win32", { KILN_STATE_MODE: "user" }), ["KILN_PROJECT_ROOT", "KILN_STATE_MODE", "LOCALAPPDATA"]);
  assert.deepEqual(names("linux", { KILN_STATE_MODE: "user" }), ["KILN_PROJECT_ROOT", "KILN_STATE_MODE", "XDG_STATE_HOME"]);
  assert.deepEqual(names("darwin", { KILN_STATE_MODE: "user" }), ["KILN_PROJECT_ROOT", "KILN_STATE_MODE", "XDG_STATE_HOME"]);
  // Unset or empty, the parent's state root is under the home directory, which the base carries.
  assert.deepEqual(names("linux", { KILN_STATE_MODE: "user", XDG_STATE_HOME: undefined }), ["KILN_PROJECT_ROOT", "KILN_STATE_MODE"]);
  assert.deepEqual(names("linux", { KILN_STATE_MODE: "user", XDG_STATE_HOME: "" }), ["KILN_PROJECT_ROOT", "KILN_STATE_MODE"]);
  assert.equal("HOME" in childEnv("research", { ...host, KILN_STATE_MODE: "user", XDG_STATE_HOME: undefined }, { platform: "linux" }), true);
  // A state mode this does not know names no state home. The child's own check refuses it.
  assert.deepEqual(names("win32", { KILN_STATE_MODE: "elsewhere" }), ["KILN_PROJECT_ROOT", "KILN_STATE_MODE"]);
  // No session mode at all: only the project is named.
  assert.deepEqual(names("win32", {}), ["KILN_PROJECT_ROOT"]);
  for (const role of ["planning", "validation"])
    for (const platform of ["win32", "linux"])
      assert.deepEqual(Object.keys(childEnv(role, { ...host, KILN_STATE_MODE: "user" }, { platform })).filter((name) => name !== "PATH" && name !== "HOME" && name !== AGENT_DIR_ENV), [], `${role} on ${platform}`);
});

/* ================================================================= the vault, inside a delegated child ==== */

test("⚠️ #215 inside a delegated child the system vault is never asked, and the marker grants nothing", async () => {
  assert.equal(DELEGATED_CHILD_ENV, NONCE_ENV, "the broker's marker is not the variable the runtime sets on a child");
  const asked = [];
  const secureStore = { available: true, get: async (service) => (asked.push(service), KEY.vault) };
  const broker = { resolve: async (service) => (asked.push(`broker:${service}`), { value: KEY.vault, source: "secure-store" }) };

  const child = { [NONCE_ENV]: "0f".repeat(16) };
  // Every service Kiln has a credential identity for, not only research: a child reaches none of them in the vault.
  for (const service of Object.values(CREDENTIAL_SERVICE))
    for (const options of [{ secureStore }, { broker }, { secureStore, broker }]) {
      const out = await runtimeCredentialEnv(service, { env: child, ...options });
      assert.deepEqual(out, child, `a delegated child was handed a vault-held ${service} credential`);
    }
  assert.deepEqual(asked, [], "a delegated child asked the vault");

  // What its parent handed it is still its own.
  const held = await runtimeCredentialEnv(CREDENTIAL_SERVICE.TAVILY, { env: { ...child, [TAVILY_VAR]: KEY.env }, secureStore });
  assert.equal(held[TAVILY_VAR], KEY.env);
  assert.deepEqual(asked, []);

  // Without the marker the vault is asked as before, so setting the marker can only take that away.
  const session = await runtimeCredentialEnv(CREDENTIAL_SERVICE.TAVILY, { env: {}, secureStore });
  assert.equal(session[TAVILY_VAR], KEY.vault);
  assert.deepEqual(asked, [CREDENTIAL_SERVICE.TAVILY]);
});

/* ================================================================== session state, from the context ==== */

test("⚠️ #215 the environment a research child is started with reaches no carry-over, journal or recovery request", async () => {
  const f = await fixture();
  try {
    const run = await delegate(f, { env: { [TAVILY_VAR]: KEY.env } });
    assertSpawnedWith(run, [TAVILY_VAR, ...CONTEXT]);
    // Exactly what the runtime handed the spawn, markers included.
    const env = run.spawned[0].env;
    const untouched = plantSessionState(f);

    assert.equal(journalLocationFromEnv(env), null, "the child can name the session's bundle journal");
    assert.equal(readCarryover({ sessionId: "any-session", env }), null);
    assert.equal(clearCarryover({ sessionId: "any-session", env }), false);
    assert.deepEqual(await writeCarryover({ reason: "context-recovery" }, { env }), { written: false, code: "carryover-not-supervised" });
    for (const reason of Object.values(RECOVERY_REASON)) assert.deepEqual(await requestRecovery(reason, { env }), { written: false, code: "recovery-not-supervised" });
    untouched();

    // The same locators without the delegation marker are the session's own, which reads its record and removes one
    // it cannot validate. That is what the marker takes away.
    const { [NONCE_ENV]: _marker, ...session } = env;
    assert.notEqual(journalLocationFromEnv(session), null);
    assert.equal(readCarryover({ sessionId: "any-session", env: session }), null);
    assert.equal(existsSync(join(f.runtime, CARRYOVER_FILE)), false, "the control did not behave as a session does");
  } finally {
    removeTestTree(f.base, "#215 session state");
  }
});

/* ============================================================================== voice, from the context ==== */

test("⚠️ #215 the context a research child holds does not turn voice on", async () => {
  const f = await fixture();
  try {
    const run = await delegate(f, { env: { [TAVILY_VAR]: KEY.env } });
    const env = assertSpawnedWith(run, [TAVILY_VAR, ...CONTEXT]);
    for (const name of Object.values(VOICE_ENV)) assert.equal(name in env, false, `${name} reached the child`);
    // The session had voice switched on and an ElevenLabs key. With the project named, voice is decided by the
    // project's own records, and this project never chose it.
    const voice = resolveProjectVoiceConfig(env);
    assert.equal(voice.enabled, false, JSON.stringify(voice));
  } finally {
    removeTestTree(f.base, "#215 voice");
  }
});

/* ============================================================================ real children, end to end ==== */

/** What the session's frame says of an unfinished bundle. None of it belongs in a child's conversation. */
const SESSION_STATE_MARKS = ["planted", "Kiln workflow checkpoint", "bundle-journal", "Kiln recovery"];

/** State a supervised session may hold in its runtime directory. A child must leave every byte of it alone. */
function plantSessionState(f) {
  mkdirSync(f.runtime, { recursive: true });
  mkdirSync(dirname(f.journal), { recursive: true });
  const planted = {
    [join(f.runtime, CARRYOVER_FILE)]: '{"planted":"carry-over, not a record a child may judge"}\n',
    [f.journal]: '{"planted":"bundle journal, not a record a child may judge"}\n',
  };
  for (const [path, text] of Object.entries(planted)) writeFileSync(path, text);
  return () => {
    for (const [path, text] of Object.entries(planted)) {
      assert.equal(existsSync(path), true, `${path} was removed`);
      assert.equal(readFileSync(path, "utf-8"), text, `${path} was changed`);
    }
    assert.equal(existsSync(join(f.runtime, RECOVERY_REQUEST_FILE)), false, "a recovery request was written");
  };
}

async function realChild(f, options) {
  const tavily = await tavilyLoopback();
  const extension = join(f.base, "tavily-loopback.js");
  writeFileSync(extension, INTERCEPT_EXT(tavily.port));
  try {
    return { ...(await delegate(f, { ...options, real: { extension } })), tavily: tavily.seen };
  } finally {
    await tavily.close();
  }
}

for (const stateMode of ["project", "user"])
  test(`⚠️ #215 a real research child passes its own permission check and searches, in ${stateMode} state mode`, { timeout: 240_000 }, async () => {
    const f = await fixture({ stateMode });
    try {
      const untouched = plantSessionState(f);
      const run = await realChild(f, { env: { [TAVILY_VAR]: KEY.env }, script: CAPABILITY_THEN_SEARCH });
      assert.equal(run.details.ok, true, `the delegation was refused: ${JSON.stringify(run.details)}`);
      assert.equal(run.details.output, ANSWER);

      // The stand-in was asked for the probe and the search, each with the key and nothing else was asked of it.
      assert.deepEqual(run.tavily.map((r) => `${r.method} ${r.path}`), ["GET /usage", "POST /search"]);
      for (const request of run.tavily) assert.equal(request.authorization, `Bearer ${KEY.env}`);
      assert.equal(JSON.parse(run.tavily[1].body).query, QUERY);

      const [capability, search] = toolResults(run.requests).map((text) => JSON.parse(text));
      assert.equal(capability.available, true, JSON.stringify(capability));
      assert.equal(search.ok, true, JSON.stringify(search));
      assert.ok(JSON.stringify(search).includes("https://example.com/dock-fees"), "the search did not return the stand-in's result");

      // The key is in no result, and the model was never shown it.
      assert.equal(run.text.includes(KEY.env), false, "the key reached the result");
      for (const request of run.requests) {
        assert.equal(request.authorized, true);
        const sent = JSON.stringify(request.body);
        assert.equal(sent.includes(KEY.env), false, "the key reached the provider");
        for (const secret of Object.values(OTHER)) assert.equal(sent.includes(secret), false, "another credential reached the provider");
        for (const mark of SESSION_STATE_MARKS) assert.equal(sent.includes(mark), false, `session state reached the child's conversation: ${mark}`);
      }
      untouched();
    } finally {
      removeTestTree(f.base, "#215 real research child");
    }
  });

test("⚠️ #215 a real research child in a project that declined research answers with the permission's own reason", { timeout: 240_000 }, async () => {
  const f = await fixture({ research: { granted: false } });
  try {
    const untouched = plantSessionState(f);
    const run = await realChild(f, { env: { [TAVILY_VAR]: KEY.env }, vault: KEY.vault, script: CAPABILITY_THEN_SEARCH });
    assert.equal(run.details.ok, true, `the delegation was refused: ${JSON.stringify(run.details)}`);
    assert.deepEqual(run.tavily, [], "the research backend was contacted");
    const answers = toolResults(run.requests).map((text) => JSON.parse(text));
    assert.equal(answers.length, 2);
    for (const answer of answers) {
      assert.equal(answer.reason, RESEARCH_REFUSAL.NOT_GRANTED, JSON.stringify(answer));
      assert.equal(answer.mustRecordGap, true);
      assert.equal(answer.permitted, false);
    }
    for (const key of Object.values(KEY)) assert.equal(run.text.includes(key), false, "a research key reached the result");
    for (const request of run.requests) for (const mark of SESSION_STATE_MARKS) assert.equal(JSON.stringify(request.body).includes(mark), false, `session state reached the child's conversation: ${mark}`);
    untouched();
  } finally {
    removeTestTree(f.base, "#215 real research child, declined");
  }
});
