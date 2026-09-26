/**
 * Launch-time availability checks and the refusal path — TSK-0037, against ACC-0056 and toward ACC-0054.
 *
 * ⚠️ **THE REAL REGISTRY.** Every check runs the pinned Pi SDK over an isolated agent directory, so "the
 * recorded model is removed" is a model id Pi's catalogue does not hold, and "its authentication is absent" is
 * an empty authentication store and environment. `test/helpers/access-recorder.mjs` watches that directory and
 * the credential variables, so the refusals that must come before any credential access are observed.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { recordAccess } from "./helpers/access-recorder.mjs";
import { GRANT, consentLocation, recordGrant } from "../lib/consent-record.mjs";
import { COMPATIBILITY_RECORD, LAUNCH_REFUSAL, LaunchRefusal, REMEDIES, checkLaunch, resolveSelection } from "../lib/launch-checks.mjs";
import { blockText } from "../lib/project-gitignore.mjs";
import { resolvePinnedSdk } from "../lib/pi-runtime.mjs";
import { OBSERVED_KEY_FIELDS, computeCompatibilityKey } from "../lib/compatibility-record.mjs";
import { CanaryRefusal } from "../lib/pi-provider-canary.mjs";

const ROOT = join(import.meta.dirname, "..");
const PROJECT_ID = "abcdefabcdefabcdefabcdefabcdef01";
const KEY_SENTINEL = "sk-kiln-launch-STORED-3e7a90b4";
const WATCHED = ["OPENAI_API_KEY", "ANTHROPIC_API_KEY"];
const SYSTEM = Object.fromEntries(["PATH", "Path", "SystemRoot", "HOME", "USERPROFILE", "TEMP", "TMP"].filter((n) => typeof process.env[n] === "string").map((n) => [n, process.env[n]]));

/** A non-reasoning and a reasoning OpenAI model from the pinned catalogue, so the ids are real. */
const CATALOGUE = await (async () => {
  const sdk = await import(resolvePinnedSdk(ROOT).url);
  const empty = mkdtempSync(join(tmpdir(), "kiln-launch-cat-"));
  try {
    const r = new sdk.ModelRegistry(await sdk.ModelRuntime.create({ authPath: join(empty, "auth.json"), modelsPath: join(empty, "models.json"), allowModelNetwork: false }));
    const openai = r.getAll().filter((m) => m.provider === "openai");
    return { plain: openai.find((m) => !m.reasoning).id, reasoner: openai.find((m) => m.reasoning).id, all: openai.map((m) => m.id) };
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
})();

const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

const SDK = await import(resolvePinnedSdk(ROOT).url);
const PI_VERSION = resolvePinnedSdk(ROOT).version;

/** The key setup would record: computed from the model Pi resolves over this agent directory. */
async function keyFor(agentDir, selection) {
  const r = new SDK.ModelRegistry(await SDK.ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json"), allowModelNetwork: false }));
  const model = r.find(selection.provider, selection.model);
  return model ? computeCompatibilityKey({ selection, model, piVersion: PI_VERSION }) : null;
}

/** A canary result that proves `key`: its observed fields and one request under its endpoint, as the child reports them. */
const proofFor = (key, over = {}) => ({
  passed: true,
  challengeEchoed: true,
  observed: Object.fromEntries(OBSERVED_KEY_FIELDS.map((f) => [f, key[f]])),
  requests: [{ ...key.endpointIdentity, pathname: `${key.endpointIdentity.pathname}/responses` }],
  ...over,
});

/** The SDK with the registry's resolved model, or its authentication, changed the way a host could change them. */
const sdkWith = (patch) => ({
  ...SDK,
  ModelRegistry: class extends SDK.ModelRegistry {
    constructor(...a) {
      super(...a);
      Object.assign(this, patch(this));
    }
  },
});

/**
 * A launchable project: a committed selection, this host's grant for it, a stored key in Pi's agent
 * directory, and a compatibility record matching the expected key.
 */
async function launchable({ model = CATALOGUE.plain, thinkingLevel = "off", stored = true, grant = true, record = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), "kiln-launch-"));
  const dir = join(root, "project");
  const stateRoot = join(dir, ".pi");
  mkdirSync(join(stateRoot, "runtime"), { recursive: true });
  git(dir, "init", "-q");
  writeFileSync(join(dir, ".gitignore"), blockText());
  writeFileSync(join(stateRoot, "kiln.json"), JSON.stringify({ recordVersion: 1, projectId: PROJECT_ID }, null, 2) + "\n");
  const selection = { provider: "openai", model, thinkingLevel };
  writeFileSync(join(stateRoot, "settings.json"), JSON.stringify({ defaultProvider: "openai", defaultModel: model, defaultThinkingLevel: thinkingLevel }, null, 2));

  const agentDir = join(root, "agent");
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, "auth.json"), JSON.stringify(stored ? { openai: { type: "api_key", key: KEY_SENTINEL } } : {}));
  writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: {} }));

  const location = consentLocation({ projectRoot: dir });
  if (grant) await recordGrant(location, { grant: GRANT.MODEL_USE, granted: grant === true, choice: { model: selection } });
  const expectedKey = await keyFor(agentDir, selection);
  if (record && expectedKey)
    writeFileSync(
      join(stateRoot, COMPATIBILITY_RECORD),
      JSON.stringify({ recordVersion: 1, key: expectedKey, result: { outcome: "passed", observedAt: "2026-09-22T00:00:00Z", challengeEchoed: true } }, null, 2)
    );
  return { root, dir, stateRoot, agentDir, location, selection, expectedKey };
}

/** Run the checks under the recorder, returning the result or the refusal and what was touched. */
async function launch(p, opts = {}) {
  const rec = recordAccess({ root: p.agentDir, names: WATCHED, env: { ...SYSTEM, ...(opts.env ?? {}) } });
  const atAsk = [];
  try {
    const result = await checkLaunch({
      projectRoot: p.dir,
      location: p.location,
      stateRoot: p.stateRoot,
      agentDir: p.agentDir,
      ...opts,
      ...(opts.ask ? { ask: (q) => (atAsk.push(rec.counts()), opts.ask(q)) } : {}),
    });
    return { result, fs: [...rec.fs], env: [...rec.env], net: [...rec.net], atAsk };
  } catch (e) {
    if (!(e instanceof LaunchRefusal)) throw e;
    return { refusal: e, fs: [...rec.fs], env: [...rec.env], net: [...rec.net], atAsk };
  } finally {
    rec.restore();
  }
}

const cleanup = (p) => rmSync(p.root, { recursive: true, force: true });
const untouched = (o, label) => assert.deepEqual({ fs: o.fs, env: o.env, net: o.net }, { fs: [], env: [], net: [] }, `${label}: a credential was touched`);

/** Every refusal names the ids it is about and offers both ways on. */
function refusedNaming(o, reason, { provider, model }) {
  assert.ok(o.refusal, `expected ${reason}, and the launch passed`);
  assert.equal(o.refusal.reason, reason, o.refusal.message);
  assert.match(o.refusal.message, new RegExp(`${provider} ${model.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  assert.deepEqual(o.refusal.remedies.map((r) => r.id), ["rerun-setup", "one-run-override"]);
  for (const r of REMEDIES) assert.ok(o.refusal.message.includes(r.text), "a remedy is missing from the message");
  assert.equal(o.refusal.detail.provider, provider);
  assert.equal(o.refusal.detail.model, model);
}

test("the recorded selection passes every check, and nothing is contacted", async () => {
  const p = await launchable();
  try {
    const o = await launch(p);
    assert.ok(o.result, o.refusal?.message);
    assert.deepEqual(o.result.selection, p.selection);
    assert.equal(o.result.overridden, false);
    assert.equal(o.result.authSource, "stored");
    assert.ok(o.result.tools.length > 0, "no tools were validated");
    assert.equal(o.result.compatibility.outcome, "passed");
    // The positive control for the recorder: the registry reads the stored key's file.
    assert.ok(o.fs.some((e) => /auth\.json$/.test(e)));
    assert.deepEqual(o.net, []);
  } finally {
    cleanup(p);
  }
});

test("⚠️ ACC-0056 a recorded model removed from the registry refuses, names it, and nothing is substituted", async () => {
  const removed = "gpt-kiln-removed-0";
  assert.equal(CATALOGUE.all.includes(removed), false);
  const p = await launchable({ model: removed });
  try {
    const o = await launch(p);
    refusedNaming(o, LAUNCH_REFUSAL.MODEL_NOT_FOUND, { provider: "openai", model: removed });
    assert.match(o.refusal.message, /no other model was used in its place/);
    // Other OpenAI models are available on this host, and none was taken.
    assert.ok(CATALOGUE.all.length > 1);
    assert.equal(o.result, undefined);
  } finally {
    cleanup(p);
  }
});

test("⚠️ ACC-0056 ACC-0089 (5) absent authentication refuses, names the recorded ids, and no other provider is used", async () => {
  const p = await launchable({ stored: false });
  try {
    const o = await launch(p, { env: {} });
    refusedNaming(o, LAUNCH_REFUSAL.AUTH_ABSENT, p.selection);
    assert.match(o.refusal.message, /no other provider was used in its place/);
    // An unrelated provider's key in the environment changes nothing.
    const q = await launch(p, { env: { ANTHROPIC_API_KEY: "sk-ant-kiln-launch-OTHER-0000" } });
    refusedNaming(q, LAUNCH_REFUSAL.AUTH_ABSENT, p.selection);
  } finally {
    cleanup(p);
  }
});

test("⚠️ ACC-0054 ACC-0089 (3) a host without a model-use grant is refused before any credential is touched", async () => {
  for (const [label, grant, reason] of [["no grant", false, LAUNCH_REFUSAL.MODEL_USE_NOT_GRANTED], ["declined", "declined", LAUNCH_REFUSAL.MODEL_USE_DECLINED]]) {
    const p = await launchable({ grant });
    try {
      const o = await launch(p, { env: { OPENAI_API_KEY: "sk-kiln-launch-ENV-5a5a" } });
      refusedNaming(o, reason, p.selection);
      untouched(o, label);
    } finally {
      cleanup(p);
    }
  }
});

test("a provider with no credential contract is refused before Pi is read", async () => {
  const p = await launchable();
  try {
    writeFileSync(join(p.stateRoot, "settings.json"), JSON.stringify({ defaultProvider: "kiln-uncontracted", defaultModel: "m-1", defaultThinkingLevel: "off" }));
    await recordGrant(p.location, { grant: GRANT.MODEL_USE, granted: true, choice: { model: { provider: "kiln-uncontracted", model: "m-1" } } });
    const o = await launch(p);
    refusedNaming(o, LAUNCH_REFUSAL.CREDENTIAL_CONTRACT, { provider: "kiln-uncontracted", model: "m-1" });
    untouched(o, "no contract");
  } finally {
    cleanup(p);
  }
});

test("a custom-model file Pi cannot load is refused without repeating its contents", async () => {
  const p = await launchable();
  try {
    writeFileSync(join(p.agentDir, "models.json"), `{ "providers": { "x": { "apiKey": "${KEY_SENTINEL}" `);
    const o = await launch(p);
    refusedNaming(o, LAUNCH_REFUSAL.CUSTOM_MODELS_ERROR, p.selection);
    assert.equal(o.refusal.message.includes(KEY_SENTINEL.slice(0, 12)), false, "the refusal repeated the file's contents");
  } finally {
    cleanup(p);
  }
});

test("a committed thinking level the model does not support is refused rather than clamped", async () => {
  const p = await launchable({ thinkingLevel: "high" });
  try {
    const o = await launch(p);
    refusedNaming(o, LAUNCH_REFUSAL.THINKING_NOT_SUPPORTED, p.selection);
    assert.deepEqual(o.refusal.detail.supported, ["off"]);
  } finally {
    cleanup(p);
  }
});

test("a package that does not load as declared is refused", async () => {
  const p = await launchable();
  const empty = mkdtempSync(join(tmpdir(), "kiln-launch-pkg-"));
  try {
    const o = await launch(p, { packageRoot: empty });
    refusedNaming(o, LAUNCH_REFUSAL.PACKAGE_INVALID, p.selection);
    assert.ok(o.refusal.detail.packageReason);
  } finally {
    cleanup(p);
    rmSync(empty, { recursive: true, force: true });
  }
});

test("⚠️ the compatibility record must exist, be valid, and match the key computed for this exact launch", async () => {
  const p = await launchable();
  const path = join(p.stateRoot, COMPATIBILITY_RECORD);
  const good = readFileSync(path, "utf8");
  const withKey = (patch) => JSON.stringify({ ...JSON.parse(good), key: { ...JSON.parse(good).key, ...patch } });
  try {
    assert.equal((await launch(p)).result.proof, "record");

    rmSync(path);
    refusedNaming(await launch(p), LAUNCH_REFUSAL.COMPATIBILITY_MISSING, p.selection);
    // ⚠️ The project's own cacheable selection is proved by setup's record: a canary runner changes nothing.
    const offered = await launch(p, { ask: () => true, canary: async () => { throw new Error("a canary ran for the recorded selection"); } });
    refusedNaming(offered, LAUNCH_REFUSAL.COMPATIBILITY_MISSING, p.selection);

    writeFileSync(path, "{not json");
    refusedNaming(await launch(p), LAUNCH_REFUSAL.COMPATIBILITY_INVALID, p.selection);
    writeFileSync(path, JSON.stringify({ ...JSON.parse(good), result: { outcome: "failed", observedAt: "2026-09-22T00:00:00Z" } }));
    refusedNaming(await launch(p), LAUNCH_REFUSAL.COMPATIBILITY_INVALID, p.selection);

    // Each determinant the record differs on is named.
    for (const [patch, field] of [
      [{ thinkingLevel: "low" }, "thinkingLevel"],
      [{ piVersion: "0.85.0" }, "piVersion"],
      [{ apiType: "anthropic-messages" }, "apiType"],
      [{ endpointIdentity: { scheme: "https", hostname: "proxy.example", port: 443, pathname: "/v1" } }, "endpointIdentity"],
      [{ preflightContractDigest: "sha256:" + "c".repeat(64) }, "preflightContractDigest"],
    ]) {
      writeFileSync(path, withKey(patch));
      const o = await launch(p);
      refusedNaming(o, LAUNCH_REFUSAL.COMPATIBILITY_MISMATCH, p.selection);
      assert.deepEqual(o.refusal.detail.fields, [field]);
    }

    // The launch's own inputs move the key too: a different pinned Pi version no longer matches the record.
    writeFileSync(path, good);
    const moved = await launch(p, { access: { ...(await import("../lib/model-selection.mjs")).defaultThinkingAccess, piVersion: () => "0.85.0" } });
    refusedNaming(moved, LAUNCH_REFUSAL.COMPATIBILITY_MISMATCH, p.selection);
    assert.deepEqual(moved.refusal.detail.fields, ["piVersion"]);

    // Key order in the stored record is not meaning.
    const reordered = JSON.parse(good);
    reordered.key = Object.fromEntries(Object.entries(reordered.key).reverse());
    writeFileSync(path, JSON.stringify(reordered));
    assert.equal((await launch(p)).result.proof, "record");
  } finally {
    cleanup(p);
  }
});

test("⚠️ a selection whose key cannot be computed refuses: no record or canary could be shown to be about it", async () => {
  const p = await launchable();
  const { defaultThinkingAccess } = await import("../lib/model-selection.mjs");
  const find = SDK.ModelRegistry.prototype.find;
  // An endpoint that routes by query cannot be a cache identity.
  const routed = { ...defaultThinkingAccess, loadSdk: async () => sdkWith((r) => ({ find: (...a) => { const m = find.apply(r, a); return m ? { ...m, baseUrl: `${m.baseUrl}?route=eu` } : m; } })) };
  try {
    for (const opts of [{}, { ask: () => true, canary: async () => { throw new Error("a canary ran"); } }]) {
      const o = await launch(p, { access: routed, ...opts });
      refusedNaming(o, LAUNCH_REFUSAL.COMPATIBILITY_UNCACHEABLE, p.selection);
      assert.equal(o.refusal.detail.uncacheable, "endpoint-identity-unavailable");
    }
    // A declared identity makes it computable again, and the record then decides.
    const declared = await launch(p, { access: routed, declared: { endpointIdentity: { scheme: "https", hostname: "api.openai.com", port: 443, pathname: "/v1" } } });
    refusedNaming(declared, LAUNCH_REFUSAL.COMPATIBILITY_MISMATCH, p.selection);
    assert.deepEqual(declared.refusal.detail.fields, ["endpointIdentitySource"]);
  } finally {
    cleanup(p);
  }
});

test("⚠️ R9 the endpoint is the one authentication sends the request to, and an unestablishable one refuses record reuse", async () => {
  const p = await launchable();
  const { defaultThinkingAccess } = await import("../lib/model-selection.mjs");
  try {
    // Authentication that replaces the model's base URL: the record, taken at the catalogue endpoint, no longer matches.
    const replaced = { ...defaultThinkingAccess, loadSdk: async () => sdkWith(() => ({ getProviderAuth: async () => ({ auth: { apiKey: "x", baseUrl: "https://proxy.example/openai/v1" } }) })) };
    const moved = await launch(p, { access: replaced });
    refusedNaming(moved, LAUNCH_REFUSAL.COMPATIBILITY_MISMATCH, p.selection);
    assert.deepEqual(moved.refusal.detail.fields, ["endpointIdentity"]);

    // Authentication that cannot resolve without the network: the endpoint is unestablished, and the record is not reused.
    let fetched = 0;
    const needsNetwork = { ...defaultThinkingAccess, loadSdk: async () => sdkWith(() => ({ getProviderAuth: async () => { fetched++; await fetch("https://oauth.example/token"); return { auth: {} }; } })) };
    const o = await launch(p, { access: needsNetwork, ask: () => true, canary: async () => { throw new Error("a canary ran"); } });
    refusedNaming(o, LAUNCH_REFUSAL.COMPATIBILITY_UNCACHEABLE, p.selection);
    assert.equal(o.refusal.detail.uncacheable, "effective-endpoint-unestablished");
    assert.equal(fetched, 1);
    assert.deepEqual(o.net, [], "the network was reached while establishing the endpoint");
  } finally {
    cleanup(p);
  }
});

test("⚠️ D20 a force-added record in a clone is not reused; the run needs its own live check", async () => {
  const p = await launchable();
  const second = mkdtempSync(join(tmpdir(), "kiln-launch-clone-"));
  try {
    git(p.dir, "add", "-A");
    git(p.dir, "add", "-f", ".pi/runtime/model-compatibility.json", ".pi/runtime/consent.json");
    git(p.dir, "-c", "user.name=kiln-test", "-c", "user.email=kiln-test@example.invalid", "commit", "-q", "-m", "carried");
    const clone = join(second, "project");
    git(second, "clone", "-q", p.dir, clone);
    const q = { ...p, dir: clone, stateRoot: join(clone, ".pi"), location: consentLocation({ projectRoot: clone }) };
    // This host grants model use for itself; the record is the one the clone carried.
    rmSync(join(clone, ".pi", "runtime", "consent.json"));
    git(clone, "rm", "-q", "--cached", ".pi/runtime/consent.json");
    git(clone, "-c", "user.name=kiln-test", "-c", "user.email=kiln-test@example.invalid", "commit", "-q", "-m", "own consent");
    await recordGrant(q.location, { grant: GRANT.MODEL_USE, granted: true, choice: { model: p.selection } });

    const refused = await launch(q);
    refusedNaming(refused, LAUNCH_REFUSAL.COMPATIBILITY_NEEDS_CANARY, p.selection);
    assert.equal(refused.refusal.detail.untrusted, "tracked");
    const ran = [];
    const ok = await launch(q, { ask: () => true, canary: async (ctx) => (ran.push(ctx.selection), proofFor(p.expectedKey)) });
    assert.equal(ok.result?.proof, "this-run", ok.refusal?.message);
    assert.equal(ran.length, 1);
  } finally {
    cleanup(p);
    rmSync(second, { recursive: true, force: true });
  }
});

test("⚠️ a one-run override is confirmed, proved for this run by its own live check, and changes neither settings, consent nor the record", async () => {
  const p = await launchable();
  const bytes = () => ({
    settings: readFileSync(join(p.stateRoot, "settings.json")),
    consent: readFileSync(p.location.path),
    record: readFileSync(join(p.stateRoot, COMPATIBILITY_RECORD)),
  });
  const before = bytes();
  const override = { provider: "openai", model: CATALOGUE.reasoner, thinking: "high" };
  const target = { provider: "openai", model: CATALOGUE.reasoner };
  const overrideKey = await keyFor(p.agentDir, { ...target, thinkingLevel: "high" });
  const passing = async () => proofFor(overrideKey);
  try {
    // A run that cannot ask, or a no, refuses before any credential is touched.
    const cannot = await launch(p, { override, canary: passing });
    refusedNaming(cannot, LAUNCH_REFUSAL.OVERRIDE_NOT_CONFIRMED, target);
    untouched(cannot, "unconfirmed override");
    const no = await launch(p, { override, ask: () => false, canary: passing });
    refusedNaming(no, LAUNCH_REFUSAL.OVERRIDE_NOT_CONFIRMED, target);
    untouched(no, "declined override");

    // Confirmed, with no canary runner: the record cannot prove the override, so the run refuses.
    refusedNaming(await launch(p, { override, ask: () => true }), LAUNCH_REFUSAL.COMPATIBILITY_NEEDS_CANARY, target);

    // Confirmed, the live check is its own approval, named with the model and the possible charge.
    const prompts = [];
    const ran = [];
    const yes = await launch(p, {
      override,
      ask: (q) => (prompts.push(q), true),
      canary: async (ctx) => (ran.push({ ...ctx.selection, promptsSoFar: prompts.length }), proofFor(overrideKey)),
    });
    assert.deepEqual(yes.atAsk[0], { fs: 0, env: 0, net: 0 }, "a credential was touched before the override was confirmed");
    assert.ok(yes.result, yes.refusal?.message);
    assert.equal(yes.result.proof, "this-run");
    assert.equal(prompts.length, 2);
    assert.match(prompts[0], /This is for this run only/);
    assert.match(prompts[0], /billable tokens or provider quota/);
    assert.match(prompts[1], /^Live model check/);
    assert.match(prompts[1], new RegExp(`using ${CATALOGUE.reasoner.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    assert.match(prompts[1], /Your provider may charge for\nthis request/);
    assert.match(prompts[1], /not recorded/);
    assert.deepEqual(ran, [{ provider: "openai", model: CATALOGUE.reasoner, thinkingLevel: "high", promptsSoFar: 2 }], "the canary ran before its approval");

    // The live check declined, or failing, refuses; the canary is not run without its approval.
    const declined = [];
    const d = await launch(p, { override, ask: (q) => !q.startsWith("Live model check"), canary: async () => (declined.push(1), proofFor(overrideKey)) });
    refusedNaming(d, LAUNCH_REFUSAL.LIVE_CHECK_DECLINED, target);
    assert.equal(declined.length, 0);
    const failed = await launch(p, { override, ask: () => true, canary: async () => { throw new CanaryRefusal("live-canary-no-tool-call", "prose"); } });
    refusedNaming(failed, LAUNCH_REFUSAL.LIVE_CHECK_FAILED, target);
    assert.equal(failed.refusal.detail.canaryReason, "live-canary-no-tool-call");
    // A runner that returns without a pass is a failure too, not a proof.
    refusedNaming(await launch(p, { override, ask: () => true, canary: async () => ({ passed: false }) }), LAUNCH_REFUSAL.LIVE_CHECK_FAILED, target);

    // ⚠️ R8: a pass about a different request is not a proof of this one.
    for (const [label, proof, reason] of [
      ["another resolved model", proofFor(overrideKey, { observed: { ...proofFor(overrideKey).observed, apiType: "openai-completions" } }), "canary-inputs-differ"],
      ["a request elsewhere", proofFor(overrideKey, { requests: [{ scheme: "https", hostname: "proxy.example", port: 443, pathname: "/v1/responses" }] }), "effective-endpoint-differs"],
      ["no observed request", proofFor(overrideKey, { requests: [] }), "effective-endpoint-unobserved"],
      ["no key in the child", proofFor(overrideKey, { observed: { keyError: "effective-endpoint-unestablished" } }), "canary-key-unavailable"],
    ]) {
      const o = await launch(p, { override, ask: () => true, canary: async () => proof });
      refusedNaming(o, LAUNCH_REFUSAL.LIVE_CHECK_FAILED, target);
      assert.equal(o.refusal.detail.canaryReason, reason, label);
    }

    // ⚠️ D17: a stored record that matches the override model is still not the override's proof.
    const recordPath = join(p.stateRoot, COMPATIBILITY_RECORD);
    const projectRecord = readFileSync(recordPath);
    writeFileSync(recordPath, JSON.stringify({ recordVersion: 1, key: overrideKey, result: { outcome: "passed", observedAt: "2026-09-22T00:00:00Z", challengeEchoed: true } }));
    const d17 = [];
    const withRecord = await launch(p, { override, ask: (q) => (d17.push(q), true), canary: async () => (d17.push("canary"), proofFor(overrideKey)) });
    assert.equal(withRecord.result?.proof, "this-run", "a matching record stood in for the override's own proof");
    assert.equal(d17.filter((q) => q === "canary").length, 1);
    assert.ok(d17.some((q) => typeof q === "string" && q.startsWith("Live model check")));
    writeFileSync(recordPath, projectRecord);

    // A removed model as the override is refused by name, like the recorded one.
    const gone = await launch(p, { override: { provider: "openai", model: "gpt-kiln-removed-1", thinking: "off" }, ask: () => true, canary: passing });
    refusedNaming(gone, LAUNCH_REFUSAL.MODEL_NOT_FOUND, { provider: "openai", model: "gpt-kiln-removed-1" });

    // A thinking-only override uses the granted model, asks nothing, and is checked by Pi's rule.
    const thinking = await launch(p, { override: { thinking: "high" }, ask: () => { throw new Error("asked"); } });
    refusedNaming(thinking, LAUNCH_REFUSAL.THINKING_NOT_SUPPORTED, p.selection);

    const after = bytes();
    assert.ok(after.settings.equals(before.settings), "an override rewrote the project's selection");
    assert.ok(after.consent.equals(before.consent), "an override changed this host's consent");
    assert.ok(after.record.equals(before.record), "a one-run live check changed the compatibility record");
  } finally {
    cleanup(p);
  }
});

test("an incomplete override, no recorded selection, or an override with no thinking level is refused", async () => {
  const p = await launchable();
  try {
    assert.throws(() => resolveSelection(p.dir, { provider: "openai" }), (e) => e.reason === LAUNCH_REFUSAL.OVERRIDE_INVALID);
    assert.throws(() => resolveSelection(p.dir, { thinking: "extreme" }), (e) => e.reason === LAUNCH_REFUSAL.OVERRIDE_INVALID);
    assert.throws(() => resolveSelection(p.dir, { provider: "openai", model: CATALOGUE.reasoner }), (e) => e.reason === LAUNCH_REFUSAL.OVERRIDE_INVALID && /Pass --thinking/.test(e.message));
    rmSync(join(p.stateRoot, "settings.json"));
    assert.throws(() => resolveSelection(p.dir), (e) => e.reason === LAUNCH_REFUSAL.NO_SELECTION);
  } finally {
    cleanup(p);
  }
});

test("F1 the override remedy states the flags a changed model actually needs", async () => {
  const text = REMEDIES.find((r) => r.id === "one-run-override").text;
  assert.match(text, /--provider <id> --model <id> --thinking <level> to use a different model/);
  assert.match(text, /--thinking <level> alone to change only the thinking level/);
  assert.equal(text.includes("[--thinking"), false, "the remedy still shows --thinking as optional for a changed model");
  const p = await launchable();
  try {
    // What the remedy says is what resolveSelection enforces.
    assert.throws(() => resolveSelection(p.dir, { provider: "openai", model: CATALOGUE.reasoner }), (e) => e.reason === LAUNCH_REFUSAL.OVERRIDE_INVALID);
    assert.equal(resolveSelection(p.dir, { provider: "openai", model: CATALOGUE.reasoner, thinking: "high" }).modelChanged, true);
    assert.equal(resolveSelection(p.dir, { thinking: "off" }).modelChanged, false);
  } finally {
    cleanup(p);
  }
});

test("⚠️ F2 Pi failing to load at any stage is a specific refusal that repeats nothing of the error", async () => {
  const { defaultThinkingAccess } = await import("../lib/model-selection.mjs");
  const real = await defaultThinkingAccess.loadSdk();
  const secret = `models.json said ${KEY_SENTINEL}`;
  const boom = () => {
    throw new Error(secret);
  };
  const withRegistry = (patch) => ({
    ...real,
    ModelRegistry: class extends real.ModelRegistry {
      constructor(...a) {
        super(...a);
        Object.assign(this, patch);
      }
    },
  });
  const cases = [
    ["sdk", { loadSdk: async () => boom() }],
    ["sdk", { loadSdk: async () => ({}) }],
    ["runtime", { loadSdk: async () => ({ ...real, ModelRuntime: { create: async () => boom() } }) }],
    ["registry", { loadSdk: async () => ({ ...real, ModelRegistry: class { constructor() { boom(); } } }) }],
    ["registry", { loadSdk: async () => withRegistry({ getError: boom }) }],
    ["lookup", { loadSdk: async () => withRegistry({ find: boom }) }],
    ["lookup", { loadSdk: async () => withRegistry({ getAvailable: boom }) }],
    ["thinking-rule", { loadCompat: async () => boom() }],
    ["thinking-rule", { loadCompat: async () => ({}) }],
    ["thinking-rule", { loadCompat: async () => ({ getSupportedThinkingLevels: () => "off" }) }],
  ];
  const p = await launchable();
  try {
    for (const [stage, override] of cases) {
      const access = { ...defaultThinkingAccess, ...override };
      const o = await launch(p, { access });
      refusedNaming(o, LAUNCH_REFUSAL.PI_LOAD_FAILED, p.selection);
      assert.equal(o.refusal.detail.stage, stage);
      const text = JSON.stringify({ message: o.refusal.message, detail: o.refusal.detail });
      assert.equal(text.includes(KEY_SENTINEL.slice(0, 12)), false, `${stage}: the refusal repeated the error`);
      assert.equal(text.includes("models.json said"), false, `${stage}: the refusal repeated the error message`);
    }
  } finally {
    cleanup(p);
  }
});

test("⚠️ ACC-0089 (8) a declined live check refuses the launch as live-check-declined, the canary is never run, and nothing is changed", async () => {
  // At launch a live check is asked only for a model the record does not prove: a one-run override. The override is
  // confirmed, the live check declined, and the run must refuse without sending the canary or writing anything.
  const p = await launchable();
  const bytes = () => ({
    settings: readFileSync(join(p.stateRoot, "settings.json")),
    consent: readFileSync(p.location.path),
    record: readFileSync(join(p.stateRoot, COMPATIBILITY_RECORD)),
  });
  const before = bytes();
  const override = { provider: "openai", model: CATALOGUE.reasoner, thinking: "high" };
  const target = { provider: "openai", model: CATALOGUE.reasoner };
  try {
    const sent = [];
    const d = await launch(p, { override, ask: (q) => !q.startsWith("Live model check"), canary: async () => (sent.push(1), { passed: true }) });
    refusedNaming(d, LAUNCH_REFUSAL.LIVE_CHECK_DECLINED, target);
    assert.equal(sent.length, 0, "the canary ran without its approval");
    assert.deepEqual(bytes(), before, "settings, consent or the compatibility record changed");
  } finally {
    cleanup(p);
  }
});
