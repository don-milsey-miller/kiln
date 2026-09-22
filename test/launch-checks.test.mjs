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

function keyFor({ provider, model, thinkingLevel }) {
  return {
    provider,
    model,
    thinkingLevel,
    piVersion: "0.84.4",
    apiType: "openai-responses",
    endpointIdentity: { scheme: "https", hostname: "api.openai.com", port: 443, pathname: "/v1" },
    endpointIdentitySource: "derived",
    effectiveRequestProfile: { reasoning: false, compat: {}, compatStructured: {}, unboundedInputs: { categories: [] } },
    preflightContractDigest: "sha256:" + "b".repeat(64),
  };
}

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
  const expectedKey = keyFor(selection);
  if (record)
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
      expectedKey: p.expectedKey,
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

test("⚠️ ACC-0056 absent authentication refuses, names the recorded ids, and no other provider is used", async () => {
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

test("⚠️ ACC-0054 a host without a model-use grant is refused before any credential is touched", async () => {
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

test("⚠️ the compatibility record must exist, be valid, and match this exact launch", async () => {
  const p = await launchable();
  const path = join(p.stateRoot, COMPATIBILITY_RECORD);
  const good = readFileSync(path, "utf8");
  try {
    rmSync(path);
    refusedNaming(await launch(p), LAUNCH_REFUSAL.COMPATIBILITY_MISSING, p.selection);

    writeFileSync(path, "{not json");
    refusedNaming(await launch(p), LAUNCH_REFUSAL.COMPATIBILITY_INVALID, p.selection);
    writeFileSync(path, JSON.stringify({ ...JSON.parse(good), result: { outcome: "failed", observedAt: "2026-09-22T00:00:00Z" } }));
    refusedNaming(await launch(p), LAUNCH_REFUSAL.COMPATIBILITY_INVALID, p.selection);

    const other = JSON.parse(good);
    other.key.thinkingLevel = "low";
    writeFileSync(path, JSON.stringify(other));
    const thinking = await launch(p);
    refusedNaming(thinking, LAUNCH_REFUSAL.COMPATIBILITY_MISMATCH, p.selection);
    assert.equal(thinking.refusal.detail.field, "thinkingLevel");

    writeFileSync(path, good);
    const stale = await launch(p, { expectedKey: { ...p.expectedKey, piVersion: "0.85.0" } });
    refusedNaming(stale, LAUNCH_REFUSAL.COMPATIBILITY_MISMATCH, p.selection);
    assert.deepEqual(stale.refusal.detail.fields, ["piVersion"]);

    // Key order is not meaning.
    const reordered = Object.fromEntries(Object.entries(p.expectedKey).reverse());
    assert.ok((await launch(p, { expectedKey: reordered })).result);

    // With no expected key there is nothing to show the record matches.
    refusedNaming(await launch(p, { expectedKey: null }), LAUNCH_REFUSAL.COMPATIBILITY_UNVERIFIABLE, p.selection);
  } finally {
    cleanup(p);
  }
});

test("⚠️ a one-run override is confirmed, checked exactly, and changes neither settings nor consent", async () => {
  const p = await launchable();
  const bytes = () => ({ settings: readFileSync(join(p.stateRoot, "settings.json")), consent: readFileSync(p.location.path) });
  const before = bytes();
  const override = { provider: "openai", model: CATALOGUE.reasoner, thinking: "high" };
  try {
    // A run that cannot ask, or a no, refuses before any credential is touched.
    const cannot = await launch(p, { override });
    refusedNaming(cannot, LAUNCH_REFUSAL.OVERRIDE_NOT_CONFIRMED, { provider: "openai", model: CATALOGUE.reasoner });
    untouched(cannot, "unconfirmed override");
    const no = await launch(p, { override, ask: () => false });
    refusedNaming(no, LAUNCH_REFUSAL.OVERRIDE_NOT_CONFIRMED, { provider: "openai", model: CATALOGUE.reasoner });
    untouched(no, "declined override");

    // Confirmed: every check runs for the override, which here has no matching compatibility record.
    const prompts = [];
    const yes = await launch(p, { override, ask: (q) => (prompts.push(q), true) });
    assert.deepEqual(yes.atAsk, [{ fs: 0, env: 0, net: 0 }], "a credential was touched before the override was confirmed");
    assert.match(prompts[0], /This is for this run only/);
    assert.match(prompts[0], /billable tokens or provider quota/);
    refusedNaming(yes, LAUNCH_REFUSAL.COMPATIBILITY_MISMATCH, { provider: "openai", model: CATALOGUE.reasoner });

    // A removed model as the override is refused by name, like the recorded one.
    const gone = await launch(p, { override: { provider: "openai", model: "gpt-kiln-removed-1", thinking: "off" }, ask: () => true });
    refusedNaming(gone, LAUNCH_REFUSAL.MODEL_NOT_FOUND, { provider: "openai", model: "gpt-kiln-removed-1" });

    // A thinking-only override uses the granted model, asks nothing, and is checked by Pi's rule.
    const thinking = await launch(p, { override: { thinking: "high" }, ask: () => { throw new Error("asked"); } });
    refusedNaming(thinking, LAUNCH_REFUSAL.THINKING_NOT_SUPPORTED, p.selection);

    const after = bytes();
    assert.ok(after.settings.equals(before.settings), "an override rewrote the project's selection");
    assert.ok(after.consent.equals(before.consent), "an override changed this host's consent");
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
