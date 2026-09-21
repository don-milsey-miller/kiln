/**
 * Permission-gated connection inspection — TSK-0033, against ACC-0052 and ACC-0053.
 *
 * ⚠️ **OBSERVED, NOT READ FROM THE CODE.** `test/helpers/access-recorder.mjs` records every filesystem
 * call under the isolated Pi agent directory, every read of a provider or research credential variable,
 * and every network call, at Node's own modules. The granted runs are the positive control: they show
 * the recorder sees the real reads of `auth.json`, `models.json` and the credential variables, so an
 * empty record for a decline is a real absence.
 *
 * ⚠️ **THE FIXTURE CREDENTIALS ARE SENTINELS.** No value here works anywhere. They exist so the result
 * can be searched for them.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

import { recordAccess } from "./helpers/access-recorder.mjs";
import { INSPECTION, INSPECTION_PROMPT, RESEARCH_CREDENTIAL, defaultAccess, inspectConnections } from "../lib/connection-inspection.mjs";
import { declaredNames, resolveProviderCredentials, supportedProviders } from "../lib/pi-provider-credentials.mjs";
import { resolvePinnedSdk } from "../lib/pi-runtime.mjs";

const ROOT = join(import.meta.dirname, "..");

/** Every credential variable Kiln knows, plus the research one: the names whose reads are watched. */
const CREDENTIAL_NAMES = (() => {
  const names = new Set([RESEARCH_CREDENTIAL]);
  for (const provider of supportedProviders()) {
    try { for (const n of declaredNames(resolveProviderCredentials(provider))) names.add(n); } catch {}
  }
  return names;
})();

const SENTINELS = {
  stored: "sk-kiln-inspect-STORED-7f3a91c2",
  inline: "kiln-inspect-INLINE-4b8e0d17",
  env: "sk-ant-kiln-inspect-ENV-2c9d55a0",
  research: "tvly-kiln-inspect-RESEARCH-e61f3b88",
  oauth: "kiln-inspect-OAUTH-access-93ad1c",
};

/** An isolated Pi agent directory holding a stored key, a custom provider, and a status-only trap. */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "kiln-inspect-"));
  const agentDir = join(root, "agent");
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, "auth.json"), JSON.stringify({
    openai: { type: "api_key", key: SENTINELS.stored },
    // ⚠️ THE TRAP: a stored OAuth record for a models.json provider. Pi reports the provider configured,
    // and its model is not available. A readiness check reading status would list it.
    "kiln-status-only": { type: "oauth", access: SENTINELS.oauth, refresh: SENTINELS.oauth, expires: Date.now() + 3_600_000 },
  }));
  writeFileSync(join(agentDir, "models.json"), JSON.stringify({
    providers: {
      "kiln-local": {
        baseUrl: "http://127.0.0.1:9/v1", api: "openai-completions", apiKey: SENTINELS.inline,
        models: [{ id: "kiln-local-model", name: "Kiln Local", contextWindow: 8192, maxTokens: 1024 }],
      },
      "kiln-status-only": {
        baseUrl: "http://127.0.0.1:9/v1", api: "openai-completions",
        models: [{ id: "kiln-status-model", name: "Status Only", contextWindow: 8192, maxTokens: 1024 }],
      },
    },
  }));
  return { root, agentDir };
}

/** Run one inspection under the recorder, with the counts taken at the moment the prompt is asked. */
async function observe({ answer, env, agentDir, root, access }) {
  const rec = recordAccess({ root, names: CREDENTIAL_NAMES, env });
  let atPrompt = null;
  let prompt = null;
  try {
    const result = await inspectConnections({
      agentDir,
      access,
      ask: (text) => { atPrompt = rec.counts(); prompt = text; return answer; },
    });
    return { result, atPrompt, prompt, fs: [...rec.fs], env: [...rec.env], net: [...rec.net] };
  } finally {
    rec.restore();
  }
}

const noLeak = (result) => {
  const text = JSON.stringify(result);
  for (const value of Object.values(SENTINELS))
    for (let i = 0; i + 8 <= value.length; i++)
      assert.equal(text.includes(value.slice(i, i + 8)), false, "the result carries part of a credential value");
  assert.equal(/bearer|authorization|api[-_]?key"|"key"|token"/i.test(text), false, "the result carries a header or credential field");
};

test("⚠️ ACC-0052 a decline reads nothing, contacts nothing, and reports not-inspected rather than nothing configured", async () => {
  const { root, agentDir } = fixture();
  try {
    let sdkLoaded = 0;
    const access = { ...defaultAccess, loadSdk: async () => { sdkLoaded++; return defaultAccess.loadSdk(); } };
    const o = await observe({ answer: false, env: { ANTHROPIC_API_KEY: SENTINELS.env, [RESEARCH_CREDENTIAL]: SENTINELS.research }, agentDir, root, access });

    assert.equal(o.prompt, INSPECTION_PROMPT);
    assert.deepEqual(o.atPrompt, { fs: 0, env: 0, net: 0 }, "something was read before the prompt was answered");
    assert.deepEqual(o.fs, [], "the declined inspection touched Pi's authentication store or model file");
    assert.deepEqual(o.env, [], "the declined inspection read a credential variable");
    assert.deepEqual(o.net, [], "the declined inspection contacted something");
    assert.equal(sdkLoaded, 0, "the declined inspection loaded Pi's runtime");

    assert.equal(o.result.decision, INSPECTION.DECLINED);
    assert.equal(o.result.inspected, false);
    assert.equal(o.result.connections, "not-inspected");
    assert.equal(o.result.researchCredential, "not-inspected");
    // ⚠️ HONESTLY PARTIAL. Unknown is not absent.
    assert.match(o.result.summary, /unknown, not absent/);
    assert.equal("providers" in o.result, false, "a declined result lists providers, which reads as nothing configured");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("⚠️ ACC-0052 only an explicit yes is consent: every other answer reads nothing", async () => {
  const { root, agentDir } = fixture();
  try {
    for (const answer of [undefined, null, "yes", "true", 1, {}, [], Promise.resolve("true")]) {
      const o = await observe({ answer, env: { ANTHROPIC_API_KEY: SENTINELS.env }, agentDir, root });
      assert.equal(o.result.decision, INSPECTION.DECLINED, `${String(answer)} was taken as consent`);
      assert.deepEqual({ fs: o.fs, env: o.env, net: o.net }, { fs: [], env: [], net: [] }, `${String(answer)} led to a read`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("⚠️ ACC-0052 ACC-0053 after consent: fresh discovery, available models only, and nothing read before the answer", async () => {
  const { root, agentDir } = fixture();
  try {
    const env = { ANTHROPIC_API_KEY: SENTINELS.env, [RESEARCH_CREDENTIAL]: SENTINELS.research };
    const o = await observe({ answer: true, env, agentDir, root });

    // Nothing before the answer.
    assert.deepEqual(o.atPrompt, { fs: 0, env: 0, net: 0 }, "something was read before the prompt was answered");

    // ⚠️ THE POSITIVE CONTROL. The recorder sees the real reads once consent is given.
    assert.ok(o.fs.some((e) => /auth\.json$/.test(e)), "the recorder did not see the authentication store read");
    assert.ok(o.fs.some((e) => /models\.json$/.test(e)), "the recorder did not see the custom-model load");
    assert.ok(o.env.some((e) => e.endsWith(" ANTHROPIC_API_KEY")), "the recorder did not see a provider variable read");
    assert.ok(o.env.some((e) => e.endsWith(` ${RESEARCH_CREDENTIAL}`)), "the recorder did not see the research presence check");

    // ⚠️ ACC-0053: nothing contacted, with the network refused rather than merely unused.
    assert.deepEqual(o.net, [], "the inspection contacted something");

    const r = o.result;
    assert.equal(r.decision, INSPECTION.GRANTED);
    assert.deepEqual(Object.keys(r).sort(), ["decision", "inspected", "providers", "researchCredential", "summary"]);
    assert.equal(r.researchCredential, "present");

    const byId = Object.fromEntries(r.providers.map((p) => [p.provider, p]));
    assert.deepEqual(Object.keys(byId).sort(), ["anthropic", "kiln-local", "openai"], "the providers are not exactly the three with usable credentials");
    assert.deepEqual(byId["kiln-local"].models, ["kiln-local-model"]);
    for (const p of r.providers) {
      assert.deepEqual(Object.keys(p).sort(), ["displayName", "models", "provider"]);
      assert.ok(p.displayName.length > 0 && p.models.length > 0);
    }

    // ⚠️ AGAINST AN INDEPENDENT REGISTRY: each listed model is available, the listing is not the
    // catalogue, and the status-only provider is excluded although its status says configured.
    const sdk = await import(resolvePinnedSdk(ROOT).url);
    const saved = process.env;
    process.env = env;
    try {
      const registry = new sdk.ModelRegistry(await sdk.ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json"), allowModelNetwork: false }));
      const available = new Set(registry.getAvailable().map((m) => `${m.provider}/${m.id}`));
      for (const p of r.providers) {
        assert.equal(p.displayName, registry.getProviderDisplayName(p.provider));
        for (const id of p.models) assert.ok(available.has(`${p.provider}/${id}`), `${p.provider}/${id} is listed but not available`);
      }
      const listed = r.providers.reduce((n, p) => n + p.models.length, 0);
      assert.equal(listed, available.size, "the listing is not exactly the available set");
      assert.ok(listed < registry.getAll().length, "the listing is the whole catalogue");
      assert.equal(registry.getProviderAuthStatus("kiln-status-only")?.configured, true, "the status-only trap no longer reproduces");
      assert.equal(byId["kiln-status-only"], undefined, "a provider whose status says configured, with no available model, was listed");
    } finally {
      process.env = saved;
    }

    noLeak(r);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("⚠️ ACC-0053 the research credential is present or absent, never its value", async () => {
  const { root, agentDir } = fixture();
  try {
    for (const [env, expected] of [[{}, "absent"], [{ [RESEARCH_CREDENTIAL]: "" }, "absent"], [{ [RESEARCH_CREDENTIAL]: SENTINELS.research }, "present"]]) {
      const o = await observe({ answer: true, env, agentDir, root });
      assert.equal(o.result.researchCredential, expected);
      assert.deepEqual(o.net, []);
      noLeak(o.result);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the listing is read from getAvailable(), and getAll() is never called", async () => {
  const { root, agentDir } = fixture();
  try {
    // ⚠️ OBSERVED ON THE REGISTRY ITSELF. With the auth filter, getAll() can produce the same listing,
    // so only the calls show which surface was used.
    const calls = [];
    const access = {
      ...defaultAccess,
      loadSdk: async () => {
        const sdk = await defaultAccess.loadSdk();
        class Recorded extends sdk.ModelRegistry {
          getAll(...a) { calls.push("getAll"); return super.getAll(...a); }
          getAvailable(...a) { calls.push("getAvailable"); return super.getAvailable(...a); }
        }
        return { ...sdk, ModelRegistry: Recorded };
      },
    };
    const o = await observe({ answer: true, env: {}, agentDir, root, access });
    assert.equal(o.result.decision, INSPECTION.GRANTED);
    assert.ok(calls.includes("getAvailable"), "the listing was not read from getAvailable()");
    assert.equal(calls.includes("getAll"), false, "getAll() was called");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * ⚠️ IMPORT-TIME READS NEED A PROCESS THAT HAS NOT IMPORTED THE MODULE. The recorder starts first,
 * then the module is imported, and the counts are taken after the import, at the prompt and at the
 * end. Every `auth.json` and `models.json` on the machine is watched, not only the fixture's.
 */
function freshProcess(answer) {
  const { root, agentDir } = fixture();
  try {
    const source = `
      const { recordAccess } = await import(${JSON.stringify(pathToFileURL(join(ROOT, "test", "helpers", "access-recorder.mjs")).href)});
      const rec = recordAccess({
        root: ${JSON.stringify(root)},
        names: ${JSON.stringify([...CREDENTIAL_NAMES])},
        env: ${JSON.stringify({ ANTHROPIC_API_KEY: SENTINELS.env, [RESEARCH_CREDENTIAL]: SENTINELS.research })},
        basenames: ["auth.json", "models.json"],
      });
      const mod = await import(${JSON.stringify(pathToFileURL(join(ROOT, "lib", "connection-inspection.mjs")).href)});
      const afterImport = rec.counts();
      let atPrompt = null;
      const result = await mod.inspectConnections({ agentDir: ${JSON.stringify(agentDir)}, ask: () => { atPrompt = rec.counts(); return ${JSON.stringify(answer)}; } });
      const final = rec.counts();
      const events = { fs: [...rec.fs], env: [...rec.env], net: [...rec.net] };
      rec.restore();
      console.log(JSON.stringify({ afterImport, atPrompt, final, events, decision: result.decision }));`;
    const r = spawnSync(process.execPath, ["--input-type=module", "-e", source], { cwd: ROOT, encoding: "utf8", timeout: 120_000 });
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout.trim().split("\n").at(-1));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("⚠️ ACC-0052 in a fresh process: importing the module and declining read nothing, anywhere", () => {
  const o = freshProcess(false);
  const none = { fs: 0, env: 0, net: 0 };
  assert.deepEqual(o.afterImport, none, `importing the module read something: ${JSON.stringify(o.events)}`);
  assert.deepEqual(o.atPrompt, none);
  assert.deepEqual(o.final, none, `the decline read something: ${JSON.stringify(o.events)}`);
  assert.equal(o.decision, INSPECTION.DECLINED);
});

test("⚠️ ACC-0052 in a fresh process: nothing before the answer, and the reads follow consent", () => {
  const o = freshProcess(true);
  const none = { fs: 0, env: 0, net: 0 };
  assert.deepEqual(o.afterImport, none, `importing the module read something: ${JSON.stringify(o.events)}`);
  assert.deepEqual(o.atPrompt, none, "something was read before the answer");
  // The positive control, in the same process shape as the decline.
  assert.ok(o.events.fs.some((e) => /auth\.json$/.test(e)), "the recorder did not see the authentication store read");
  assert.ok(o.events.env.some((e) => e.endsWith(" ANTHROPIC_API_KEY")), "the recorder did not see a provider variable read");
  assert.deepEqual(o.events.net, []);
  assert.equal(o.decision, INSPECTION.GRANTED);
});
