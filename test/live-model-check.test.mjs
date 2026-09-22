/**
 * Setup's live model check and the compatibility record — TSK-0042, against ACC-0060 and ACC-0062.
 *
 * ⚠️ **THE KEY COMES FROM PI'S RESOLVED MODEL.** Each case resolves a real catalogue model through the pinned
 * SDK and hands it to the check as the zero-cost preflight would. Changing one input at a time is what shows
 * each determinant invalidates the record and reopens approval. The canary is a stub where only its outcome
 * matters, and the real bounded canary against a loopback endpoint in the end-to-end case.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  COMPATIBILITY_RECORD,
  OBSERVED_KEY_FIELDS,
  compatibilityLocation,
  computeCompatibilityKey,
  preflightContractDigest,
  readCompatibility,
  resolveEffectiveBaseUrl,
} from "../lib/compatibility-record.mjs";
import { LIVE_CANARY_REFUSAL, runLiveCanary } from "../lib/live-canary.mjs";
import { LIVE_CHECK_OUTCOME, LIVE_CHECK_REFUSAL, LiveCheckRefusal, runLiveModelCheck } from "../lib/live-model-check.mjs";
import { CanaryRefusal } from "../lib/pi-provider-canary.mjs";
import { blockText } from "../lib/project-gitignore.mjs";
import { resolvePinnedSdk } from "../lib/pi-runtime.mjs";
import { BASE_ENV } from "../lib/specialists/contract.mjs";

const ROOT = join(import.meta.dirname, "..");
const SDK = await import(resolvePinnedSdk(ROOT).url);
const PI_VERSION = resolvePinnedSdk(ROOT).version;
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

/** The pinned catalogue, for real resolved models. */
const CATALOGUE = await (async () => {
  const empty = mkdtempSync(join(tmpdir(), "kiln-lmc-cat-"));
  try {
    return new SDK.ModelRegistry(await SDK.ModelRuntime.create({ authPath: join(empty, "a.json"), modelsPath: join(empty, "m.json"), allowModelNetwork: false }));
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
})();
const openai = CATALOGUE.getAll().filter((m) => m.provider === "openai");
const PLAIN = openai.find((m) => !m.reasoning);
const OTHER = openai.find((m) => !m.reasoning && m.id !== PLAIN.id);
const ANTHROPIC = CATALOGUE.getAll().find((m) => m.provider === "anthropic");

function project() {
  const root = mkdtempSync(join(tmpdir(), "kiln-lmc-"));
  const dir = join(root, "project");
  mkdirSync(join(dir, ".pi", "runtime"), { recursive: true });
  git(dir, "init", "-q");
  writeFileSync(join(dir, ".gitignore"), blockText());
  writeFileSync(join(dir, ".pi", "kiln.json"), JSON.stringify({ recordVersion: 1, projectId: "0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f" }, null, 2) + "\n");
  return { root, dir, where: compatibilityLocation({ projectRoot: dir }) };
}

/** What `zeroCostPreflight` hands on, for a resolved model. */
const preflightFor = (model, thinkingLevel = "off", over = {}) => ({
  selection: { provider: model.provider, model: model.id, thinkingLevel },
  model,
  displayName: CATALOGUE.getProviderDisplayName(model.provider) ?? model.provider,
  piVersion: PI_VERSION,
  ...over,
});

/** A canary result proving the key this preflight computes: its observed fields and one request under its endpoint. */
function proofFor(pf, declared = {}, over = {}) {
  const key = computeCompatibilityKey({ selection: pf.selection, model: pf.model, piVersion: pf.piVersion, declared, effectiveBaseUrl: pf.effectiveBaseUrl });
  return {
    passed: true,
    challengeEchoed: true,
    observed: Object.fromEntries(OBSERVED_KEY_FIELDS.map((f) => [f, key[f]])),
    requests: [{ ...key.endpointIdentity, pathname: `${key.endpointIdentity.pathname}/responses` }],
    ...over,
  };
}

/** A canary stub that records when it ran. By default it returns a proof of the preflight it is given. */
function canaryStub(outcome = null) {
  const runs = [];
  return {
    runs,
    canary: async (ctx) => {
      runs.push(ctx.selection);
      if (outcome instanceof Error) throw outcome;
      return outcome ?? ctx.proof;
    },
  };
}

function answering(answer) {
  const asked = [];
  return { asked, ask: (q) => (asked.push(q), answer) };
}

const check = (p, pf, opts = {}) =>
  runLiveModelCheck({
    preflight: pf,
    location: p.where,
    ...opts,
    ...(opts.canary ? { canary: (ctx) => opts.canary({ ...ctx, proof: proofFor(pf, ctx.declared ?? {}) }) } : {}),
  });
const recordBytes = (p) => (existsSync(p.where.path) ? readFileSync(p.where.path) : null);

test("⚠️ ACC-0060 the approval names the provider, the exact model and the charge, and the canary runs only after it", async () => {
  const p = project();
  try {
    const pf = preflightFor(PLAIN);
    const c = canaryStub();
    const a = answering(true);
    const r = await check(p, pf, { ask: (q) => (a.ask(q), assert.equal(c.runs.length, 0, "the canary ran before approval"), true), canary: c.canary });
    assert.equal(r.outcome, LIVE_CHECK_OUTCOME.PASSED);
    assert.equal(r.ready, true);
    const [prompt] = a.asked;
    assert.match(prompt, /^Live model check/);
    assert.ok(prompt.includes(`to ${pf.displayName} using ${PLAIN.id}.`));
    assert.match(prompt, /contains no project content and cannot change planning files/);
    assert.match(prompt, /Your provider may charge for\nthis request/);
    assert.deepEqual(c.runs, [pf.selection]);

    // The record is exactly the passed result under the key computed for this selection.
    const found = readCompatibility(p.where);
    assert.equal(found.state, "valid");
    assert.deepEqual(found.record.key, computeCompatibilityKey({ selection: pf.selection, model: PLAIN, piVersion: PI_VERSION }));
    assert.equal(found.record.result.outcome, "passed");
    assert.equal(found.record.key.preflightContractDigest, preflightContractDigest());
  } finally {
    rmSync(p.root, { recursive: true, force: true });
  }
});

test("⚠️ ACC-0062 a matching record is reused without asking, and each determinant that changes reopens approval", async () => {
  const p = project();
  try {
    const base = preflightFor(PLAIN);
    await check(p, base, { ask: () => true, canary: canaryStub().canary });
    const reused = canaryStub();
    const quiet = answering(false);
    assert.equal((await check(p, base, { ask: quiet.ask, canary: reused.canary })).outcome, LIVE_CHECK_OUTCOME.REUSED);
    assert.deepEqual([quiet.asked.length, reused.runs.length], [0, 0], "a matching record was not reused");

    const changes = [
      ["provider", preflightFor(ANTHROPIC)],
      ["model", preflightFor(OTHER)],
      ["thinking level", { ...base, selection: { ...base.selection, thinkingLevel: "low" } }],
      ["Pi version", { ...base, piVersion: "0.85.0" }],
      ["API type", { ...base, model: { ...PLAIN, api: "openai-completions" } }],
      ["endpoint", { ...base, model: { ...PLAIN, baseUrl: "https://eu.api.openai.com/v1" } }],
      ["request profile", { ...base, model: { ...PLAIN, compat: { ...(PLAIN.compat ?? {}), supportsDeveloperRole: false } } }],
    ];
    const before = recordBytes(p);
    for (const [label, pf] of changes) {
      const c = canaryStub();
      const no = answering(false);
      const r = await check(p, pf, { ask: no.ask, canary: c.canary });
      assert.equal(no.asked.length, 1, `a change of ${label} did not reopen approval`);
      assert.equal(r.outcome, LIVE_CHECK_OUTCOME.DECLINED);
      assert.equal(c.runs.length, 0);
      assert.ok(recordBytes(p).equals(before), `declining after a change of ${label} changed the record`);
    }

    // The canary protocol: a record taken under another digest does not match.
    const other = JSON.parse(before);
    other.key.preflightContractDigest = "sha256:" + "d".repeat(64);
    writeFileSync(p.where.path, JSON.stringify(other));
    const no = answering(false);
    await check(p, base, { ask: no.ask, canary: canaryStub().canary });
    assert.equal(no.asked.length, 1, "a record under another canary protocol was reused");
  } finally {
    rmSync(p.root, { recursive: true, force: true });
  }
});

test("⚠️ ACC-0060 declining is a choice: not ready, no request, nothing recorded, and not an error", async () => {
  const p = project();
  try {
    const pf = preflightFor(PLAIN);
    for (const opts of [{ ask: () => false }, { ask: () => null }, { ask: () => "yes" }, { request: "deny" }, { request: "deny", ask: () => true }]) {
      const c = canaryStub();
      const r = await check(p, pf, { ...opts, canary: c.canary });
      assert.equal(r.outcome, LIVE_CHECK_OUTCOME.DECLINED);
      assert.equal(r.ready, false);
      assert.match(r.message, /by your choice/);
      assert.match(r.message, /not marked ready and intake has not begun/);
      assert.equal(c.runs.length, 0);
      assert.equal(existsSync(p.where.path), false);
    }
  } finally {
    rmSync(p.root, { recursive: true, force: true });
  }
});

test("⚠️ ACC-0060 a run that cannot ask needs --live-model-check approve when no record matches", async () => {
  const p = project();
  try {
    const pf = preflightFor(PLAIN);
    const c = canaryStub();
    await assert.rejects(
      check(p, pf, { canary: c.canary }),
      (e) => e instanceof LiveCheckRefusal && e.reason === LIVE_CHECK_REFUSAL.NEEDS_APPROVAL && e.message.includes(PLAIN.id) && /--live-model-check approve/.test(e.message)
    );
    assert.equal(c.runs.length, 0);
    const r = await check(p, pf, { request: "approve", canary: c.canary });
    assert.equal(r.outcome, LIVE_CHECK_OUTCOME.PASSED);
    assert.equal(c.runs.length, 1);
    // With a matching record, a run that cannot ask needs no flag.
    assert.equal((await check(p, pf, { canary: c.canary })).outcome, LIVE_CHECK_OUTCOME.REUSED);
  } finally {
    rmSync(p.root, { recursive: true, force: true });
  }
});

test("a failed canary records nothing and leaves an existing record exactly as it was", async () => {
  const p = project();
  try {
    const pf = preflightFor(PLAIN);
    const fresh = await check(p, pf, { ask: () => true, canary: canaryStub(new CanaryRefusal(LIVE_CANARY_REFUSAL.NO_TOOL_CALL, "prose")).canary });
    assert.deepEqual([fresh.outcome, fresh.ready, fresh.reason], [LIVE_CHECK_OUTCOME.FAILED, false, LIVE_CANARY_REFUSAL.NO_TOOL_CALL]);
    assert.equal(existsSync(p.where.path), false);

    await check(p, pf, { ask: () => true, canary: canaryStub().canary });
    const before = recordBytes(p);
    const changed = { ...pf, piVersion: "0.85.0" };
    const failed = await check(p, changed, { ask: () => true, canary: canaryStub(new CanaryRefusal(LIVE_CANARY_REFUSAL.MALFORMED_CALL, "bad")).canary });
    assert.equal(failed.outcome, LIVE_CHECK_OUTCOME.FAILED);
    assert.ok(recordBytes(p).equals(before));
    const notPassed = await check(p, changed, { ask: () => true, canary: canaryStub({ passed: false, observed: { keyError: "x" }, requests: [] }).canary });
    assert.equal(notPassed.outcome, LIVE_CHECK_OUTCOME.FAILED);
    assert.ok(recordBytes(p).equals(before));
  } finally {
    rmSync(p.root, { recursive: true, force: true });
  }
});

test("a configuration that cannot be identified is not checked at all, and a declared identity makes it checkable", async () => {
  const p = project();
  try {
    const routed = preflightFor({ ...PLAIN, baseUrl: `${PLAIN.baseUrl}?route=eu` });
    const c = canaryStub();
    const asked = answering(true);
    const r = await check(p, routed, { ask: asked.ask, canary: c.canary });
    assert.deepEqual([r.outcome, r.ready, r.reason], [LIVE_CHECK_OUTCOME.UNCACHEABLE, false, "endpoint-identity-unavailable"]);
    assert.match(r.message, /Declare a non-secret identity/);
    assert.deepEqual([asked.asked.length, c.runs.length], [0, 0], "a check that could prove nothing was asked for or sent");
    assert.equal(existsSync(p.where.path), false);

    // With a declared identity, the canary's requests must lie under that identity.
    const declared = { endpointIdentity: { scheme: "https", hostname: "api.openai.com", port: 443, pathname: "/v1" } };
    const d = await check(p, routed, { ask: () => true, canary: canaryStub().canary, declared });
    assert.equal(d.outcome, LIVE_CHECK_OUTCOME.PASSED, d.message);
    assert.equal(readCompatibility(p.where).record.key.endpointIdentitySource, "declared");
    assert.equal(readFileSync(p.where.path, "utf8").includes("route=eu"), false, "the query reached the record");
  } finally {
    rmSync(p.root, { recursive: true, force: true });
  }
});

test("⚠️ R9 an endpoint that cannot be established without the network is not checked, and one authentication replaces is the one keyed", async () => {
  const p = project();
  try {
    const c = canaryStub();
    const r = await check(p, { ...preflightFor(PLAIN), endpointUnestablished: true }, { ask: () => true, canary: c.canary });
    assert.deepEqual([r.outcome, r.ready, r.reason], [LIVE_CHECK_OUTCOME.UNCACHEABLE, false, "effective-endpoint-unestablished"]);
    assert.equal(c.runs.length, 0);

    // Pi's own resolution decides the effective endpoint, with the network refused.
    const replaced = await resolveEffectiveBaseUrl({ getProviderAuth: async () => ({ auth: { baseUrl: "https://proxy.example/openai/v1" } }) }, PLAIN);
    assert.deepEqual(replaced, { baseUrl: "https://proxy.example/openai/v1" });
    assert.deepEqual(await resolveEffectiveBaseUrl({ getProviderAuth: async () => ({ auth: {} }) }, PLAIN), { baseUrl: PLAIN.baseUrl });
    let reached = false;
    const real = globalThis.fetch;
    globalThis.fetch = async () => { reached = true; throw new Error("reached"); };
    try {
      const refused = await resolveEffectiveBaseUrl({ getProviderAuth: async () => { await fetch("https://oauth.example/token"); return { auth: {} }; } }, PLAIN);
      assert.deepEqual(refused, { unestablished: "effective-endpoint-unestablished" });
      assert.equal(reached, false, "the network was reached while establishing the endpoint");
      assert.equal(globalThis.fetch !== real, true);
    } finally {
      globalThis.fetch = real;
    }
    // The key follows the effective endpoint, not the model's own.
    const moved = await check(p, preflightFor(PLAIN, "off", { effectiveBaseUrl: "https://proxy.example/openai/v1" }), { ask: () => true, canary: canaryStub().canary });
    assert.equal(moved.outcome, LIVE_CHECK_OUTCOME.PASSED, moved.message);
    assert.deepEqual(readCompatibility(p.where).record.key.endpointIdentity, { scheme: "https", hostname: "proxy.example", port: 443, pathname: "/openai/v1" });
  } finally {
    rmSync(p.root, { recursive: true, force: true });
  }
});

test("⚠️ R8 a pass about a different request is a failure, and nothing is recorded", async () => {
  const pf = preflightFor(PLAIN);
  const base = proofFor(pf);
  for (const [label, result, reason] of [
    ["another resolved model", { ...base, observed: { ...base.observed, apiType: "openai-completions" } }, "canary-inputs-differ"],
    ["another request profile", { ...base, observed: { ...base.observed, effectiveRequestProfile: { ...base.observed.effectiveRequestProfile, reasoning: true } } }, "canary-inputs-differ"],
    ["a request elsewhere", { ...base, requests: [{ scheme: "https", hostname: "proxy.example", port: 443, pathname: "/v1/responses" }] }, "effective-endpoint-differs"],
    ["a sibling path", { ...base, requests: [{ ...base.requests[0], pathname: "/v10/responses" }] }, "effective-endpoint-differs"],
    ["no observed request", { ...base, requests: [] }, "effective-endpoint-unobserved"],
    ["no key in the child", { ...base, observed: { keyError: "effective-endpoint-unestablished" } }, "canary-key-unavailable"],
  ]) {
    const p = project();
    try {
      const r = await check(p, pf, { ask: () => true, canary: canaryStub(result).canary });
      assert.deepEqual([r.outcome, r.ready, r.reason], [LIVE_CHECK_OUTCOME.FAILED, false, reason], label);
      assert.equal(existsSync(p.where.path), false, `${label}: a record was written`);
    } finally {
      rmSync(p.root, { recursive: true, force: true });
    }
  }
});

test("⚠️ a pass is not recorded where a clone could carry it", async () => {
  for (const [label, prepare, reason] of [
    ["tracked", (p) => { writeFileSync(p.where.path, "{}"); git(p.dir, "add", "-f", ".pi/runtime/model-compatibility.json"); return p.where; }, "tracked"],
    ["unverified", (p) => compatibilityLocation({ projectRoot: p.dir, git: "kiln-no-such-git-binary" }), "unverified"],
    ["not ignored", (p) => { writeFileSync(join(p.dir, ".gitignore"), ""); return p.where; }, "unprotected"],
  ]) {
    const p = project();
    try {
      const where = prepare(p);
      const before = recordBytes(p);
      const pf = preflightFor(PLAIN);
      const r = await runLiveModelCheck({ preflight: pf, location: where, ask: () => true, canary: async () => proofFor(pf) });
      // ⚠️ D21: a pass that cannot be recorded proves this run only, so setup is awaiting a per-run check, not ready.
      assert.deepEqual([r.outcome, r.recorded, r.ready, r.awaiting, r.reason], [LIVE_CHECK_OUTCOME.PASSED_NOT_RECORDED, false, false, "per-run-check", reason], label);
      assert.match(r.message, /proves this run only/);
      assert.deepEqual(recordBytes(p), before, `${label}: the record was written`);
    } finally {
      rmSync(p.root, { recursive: true, force: true });
    }
  }
});

test("⚠️ end to end: the real bounded canary passes, its success is recorded under the computed key, and the next run reuses it", async () => {
  const requests = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const parsed = JSON.parse(body);
      requests.push(parsed);
      const seen = /[0-9a-f]{32}/.exec(JSON.stringify(parsed.messages))?.[0];
      const base = { id: "x", object: "chat.completion.chunk", created: 0, model: parsed.model };
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "c0", type: "function", function: { name: "kiln_preflight", arguments: JSON.stringify({ challenge: seen }) } }] }, finish_reason: null }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] })}\n\ndata: [DONE]\n\n`);
      res.end();
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const p = project();
  const agentDir = join(p.root, "agent");
  try {
    const config = {
      baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
      api: "openai-completions",
      models: [{ id: "acme-model", name: "Acme Model", contextWindow: 128000, maxTokens: 4096, reasoning: false }],
    };
    // Pi's resolved model for that configuration, as setup's zero-cost preflight would hand it over.
    mkdirSync(agentDir);
    writeFileSync(join(agentDir, "auth.json"), "{}");
    writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: { acme: { ...config, apiKey: "$ACME_CANARY_KEY" } } }));
    const registry = new SDK.ModelRegistry(await SDK.ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json"), allowModelNetwork: false }));
    const pf = { selection: { provider: "acme", model: "acme-model", thinkingLevel: "off" }, model: registry.find("acme", "acme-model"), displayName: "acme", piVersion: PI_VERSION };
    assert.ok(pf.model);

    const hostEnv = { ACME_CANARY_KEY: "acme-lmc-KEY-8d10" };
    for (const n of new Set([...BASE_ENV.win32, ...BASE_ENV.posix])) if (process.env[n] !== undefined) hostEnv[n] = process.env[n];
    const canary = ({ selection }) => runLiveCanary({ ...selection, custom: { id: "acme", apiKey: "$ACME_CANARY_KEY" }, customProviderConfig: config, hostEnv });

    const r = await check(p, pf, { ask: () => true, canary });
    assert.equal(r.outcome, LIVE_CHECK_OUTCOME.PASSED, r.message);
    assert.equal(requests.length, 1);
    const text = readFileSync(p.where.path, "utf8");
    assert.equal(text.includes("acme-lmc-KEY-8d10"), false, "the record holds the key");
    assert.equal(text.includes(hostEnv.ACME_CANARY_KEY.slice(0, 8)), false);
    assert.deepEqual(readCompatibility(p.where).record.key, computeCompatibilityKey({ selection: pf.selection, model: pf.model, piVersion: PI_VERSION }));

    assert.equal((await check(p, pf, { ask: () => false, canary })).outcome, LIVE_CHECK_OUTCOME.REUSED);
    assert.equal(requests.length, 1, "a matching record did not prevent a second request");
  } finally {
    server.close();
    rmSync(p.root, { recursive: true, force: true });
  }
});

test("determinant 8 digests every part of the canary protocol, and no challenge", async () => {
  const { canaryContract } = await import("../lib/compatibility-record.mjs");
  const { canaryPrompt } = await import("../lib/preflight-tool.mjs");
  const base = canaryContract();
  const digest = preflightContractDigest(base);
  // Exactly these parts, holding exactly what the canary hands Pi.
  const tool = await import("../lib/preflight-tool.mjs");
  assert.deepEqual(Object.keys(base).sort(), ["description", "maxTokens", "parameters", "promptTemplate", "successPredicateVersion", "systemPrompt", "toolName"]);
  assert.deepEqual([base.toolName, base.description, base.parameters, base.systemPrompt, base.maxTokens], [tool.PREFLIGHT_TOOL_NAME, tool.PREFLIGHT_DESCRIPTION, tool.PREFLIGHT_PARAMETERS, tool.CANARY_SYSTEM_PROMPT, tool.CANARY_MAX_TOKENS]);
  assert.equal(digest, preflightContractDigest());
  assert.match(digest, /^sha256:[0-9a-f]{64}$/);
  // The template carries a placeholder, never a real challenge, so every run digests the same.
  assert.equal(base.promptTemplate.includes("0".repeat(32)), true);
  assert.notEqual(base.promptTemplate, canaryPrompt("1".repeat(32)));
  for (const [part, value] of [
    ["toolName", "kiln_other"],
    ["description", "Different words."],
    ["parameters", { ...base.parameters, additionalProperties: true }],
    ["systemPrompt", "Another system prompt."],
    ["promptTemplate", `${base.promptTemplate} Please.`],
    ["maxTokens", base.maxTokens + 1],
    ["successPredicateVersion", base.successPredicateVersion + 1],
  ])
    assert.notEqual(preflightContractDigest({ ...base, [part]: value }), digest, `changing ${part} left the digest unchanged`);
  // Key order is not meaning.
  assert.equal(preflightContractDigest(Object.fromEntries(Object.entries(base).reverse())), digest);
});

test("determinant 7 carries the thinking value Pi sends, by Pi's mapping rule", async () => {
  const { resolvedThinkingValue } = await import("../lib/compatibility-record.mjs");
  const reasoner = { reasoning: true, thinkingLevelMap: { off: null, minimal: "minimal", high: "high", xhigh: null, low: "L" } };
  assert.equal(resolvedThinkingValue(reasoner, "high"), "high");
  assert.equal(resolvedThinkingValue(reasoner, "low"), "L", "a mapped level must carry the mapped value");
  assert.equal(resolvedThinkingValue(reasoner, "off"), null, "a level the map marks unsupported is null");
  assert.equal(resolvedThinkingValue(reasoner, "medium"), "medium", "an unmapped level is sent as itself");
  assert.equal(resolvedThinkingValue({ reasoning: true }, "high"), "high");
  assert.equal(resolvedThinkingValue({ reasoning: false, thinkingLevelMap: { high: "x" } }, "high"), undefined, "a model that does not reason sends none");

  const r = openai.find((m) => m.reasoning);
  const keyAt = (level) => computeCompatibilityKey({ selection: { provider: r.provider, model: r.id, thinkingLevel: level }, model: r, piVersion: PI_VERSION });
  assert.notDeepEqual(keyAt("low").effectiveRequestProfile, keyAt("high").effectiveRequestProfile);
});

test("only a passed canary can be recorded", async () => {
  const { recordCompatibility } = await import("../lib/compatibility-record.mjs");
  const p = project();
  try {
    const key = computeCompatibilityKey({ selection: { provider: PLAIN.provider, model: PLAIN.id, thinkingLevel: "off" }, model: PLAIN, piVersion: PI_VERSION });
    await assert.rejects(recordCompatibility(p.where, { key, result: { outcome: "failed", observedAt: "2026-09-22T00:00:00Z" } }), TypeError);
    await assert.rejects(recordCompatibility(p.where, { key: { ...key, provider: "" }, result: { outcome: "passed", observedAt: "2026-09-22T00:00:00Z" } }), TypeError);
    assert.equal(existsSync(p.where.path), false);
  } finally {
    rmSync(p.root, { recursive: true, force: true });
  }
});

test("⚠️ setup's record is the one launch accepts: preflight, live check with the real canary, then checkLaunch", async () => {
  const { zeroCostPreflight, checkLaunch } = await import("../lib/launch-checks.mjs");
  const { GRANT, consentLocation, recordGrant } = await import("../lib/consent-record.mjs");
  const requests = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const parsed = JSON.parse(body);
      requests.push(parsed);
      const seen = /[0-9a-f]{32}/.exec(JSON.stringify(parsed.messages))?.[0];
      const base = { id: "x", object: "chat.completion.chunk", created: 0, model: parsed.model };
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "c0", type: "function", function: { name: "kiln_preflight", arguments: JSON.stringify({ challenge: seen }) } }] }, finish_reason: null }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] })}\n\ndata: [DONE]\n\n`);
      res.end();
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const p = project();
  const agentDir = join(p.root, "agent");
  const saved = process.env.ACME_CANARY_KEY;
  process.env.ACME_CANARY_KEY = "acme-chain-KEY-40a1";
  try {
    const selection = { provider: "acme", model: "acme-model", thinkingLevel: "off" };
    const config = {
      baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
      api: "openai-completions",
      models: [{ id: "acme-model", name: "Acme Model", contextWindow: 128000, maxTokens: 4096, reasoning: false }],
    };
    const custom = { id: "acme", apiKey: "$ACME_CANARY_KEY" };
    mkdirSync(agentDir);
    writeFileSync(join(agentDir, "auth.json"), "{}");
    writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: { acme: { ...config, apiKey: "$ACME_CANARY_KEY" } } }));
    writeFileSync(join(p.dir, ".pi", "settings.json"), JSON.stringify({ defaultProvider: "acme", defaultModel: "acme-model", defaultThinkingLevel: "off" }));
    const consent = consentLocation({ projectRoot: p.dir });
    await recordGrant(consent, { grant: GRANT.MODEL_USE, granted: true, choice: { model: selection } });

    const hostEnv = { ACME_CANARY_KEY: process.env.ACME_CANARY_KEY };
    for (const n of new Set([...BASE_ENV.win32, ...BASE_ENV.posix])) if (process.env[n] !== undefined) hostEnv[n] = process.env[n];
    const canary = ({ selection: s }) => runLiveCanary({ ...s, custom, customProviderConfig: config, hostEnv });

    // Setup: the zero-cost preflight, then the approved live check, which records.
    const pf = await zeroCostPreflight({ projectRoot: p.dir, location: consent, agentDir, custom });
    const setup = await runLiveModelCheck({ preflight: pf, location: p.where, ask: () => true, canary });
    assert.equal(setup.outcome, LIVE_CHECK_OUTCOME.PASSED, setup.message);

    // Launch: computes its own key from what Pi resolves and accepts setup's record, with no canary.
    const launched = await checkLaunch({ projectRoot: p.dir, location: consent, stateRoot: join(p.dir, ".pi"), agentDir, custom });
    assert.equal(launched.proof, "record");
    assert.equal(launched.authSource, "custom-environment-key");
    assert.equal(requests.length, 1, "launch sent a request although a matching record existed");
  } finally {
    if (saved === undefined) delete process.env.ACME_CANARY_KEY;
    else process.env.ACME_CANARY_KEY = saved;
    server.close();
    rmSync(p.root, { recursive: true, force: true });
  }
});

test("⚠️ D20 a force-added record in a clone is not reused: approval reopens", async () => {
  const first = project();
  const second = mkdtempSync(join(tmpdir(), "kiln-lmc-clone-"));
  try {
    const pf = preflightFor(PLAIN);
    await check(first, pf, { ask: () => true, canary: canaryStub().canary });
    assert.equal(readCompatibility(first.where).state, "valid");
    git(first.dir, "add", "-A");
    git(first.dir, "add", "-f", ".pi/runtime/model-compatibility.json");
    git(first.dir, "-c", "user.name=kiln-test", "-c", "user.email=kiln-test@example.invalid", "commit", "-q", "-m", "carried");
    const cloneDir = join(second, "project");
    git(second, "clone", "-q", first.dir, cloneDir);
    const clone = { dir: cloneDir, where: compatibilityLocation({ projectRoot: cloneDir }) };
    assert.equal(existsSync(clone.where.path), true, "the clone did not receive the record");
    assert.deepEqual(readCompatibility(clone.where), { state: "untrusted", why: "tracked" });

    const asked = answering(false);
    const r = await runLiveModelCheck({ preflight: pf, location: clone.where, ask: asked.ask, canary: async () => proofFor(pf) });
    assert.equal(asked.asked.length, 1, "a carried record was reused without asking");
    assert.equal(r.outcome, LIVE_CHECK_OUTCOME.DECLINED);
  } finally {
    rmSync(first.root, { recursive: true, force: true });
    rmSync(second, { recursive: true, force: true });
  }
});

test("⚠️ R8 end to end: a canary child that resolves a different model from the host fails the check, and nothing is recorded", async () => {
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const parsed = JSON.parse(body);
      const seen = /[0-9a-f]{32}/.exec(JSON.stringify(parsed.messages))?.[0];
      const base = { id: "x", object: "chat.completion.chunk", created: 0, model: parsed.model };
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "c0", type: "function", function: { name: "kiln_preflight", arguments: JSON.stringify({ challenge: seen }) } }] }, finish_reason: null }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] })}\n\ndata: [DONE]\n\n`);
      res.end();
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const p = project();
  const agentDir = join(p.root, "agent");
  try {
    const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
    // The host's configuration says the model reasons; the configuration handed to the canary says it does not.
    const hostModel = { id: "acme-model", name: "Acme Model", contextWindow: 128000, maxTokens: 4096, reasoning: true };
    mkdirSync(agentDir);
    writeFileSync(join(agentDir, "auth.json"), "{}");
    writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: { acme: { baseUrl, api: "openai-completions", apiKey: "$ACME_CANARY_KEY", models: [hostModel] } } }));
    const registry = new SDK.ModelRegistry(await SDK.ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json"), allowModelNetwork: false }));
    const pf = { selection: { provider: "acme", model: "acme-model", thinkingLevel: "off" }, model: registry.find("acme", "acme-model"), displayName: "acme", piVersion: PI_VERSION, effectiveBaseUrl: baseUrl };

    const hostEnv = { ACME_CANARY_KEY: "acme-r8-KEY-11c3" };
    for (const n of new Set([...BASE_ENV.win32, ...BASE_ENV.posix])) if (process.env[n] !== undefined) hostEnv[n] = process.env[n];
    const canaryConfig = { baseUrl, api: "openai-completions", models: [{ ...hostModel, reasoning: false }] };
    const canary = ({ selection }) => runLiveCanary({ ...selection, custom: { id: "acme", apiKey: "$ACME_CANARY_KEY" }, customProviderConfig: canaryConfig, hostEnv });

    const r = await runLiveModelCheck({ preflight: pf, location: p.where, ask: () => true, canary });
    assert.deepEqual([r.outcome, r.ready, r.reason], [LIVE_CHECK_OUTCOME.FAILED, false, "canary-inputs-differ"], r.message);
    assert.deepEqual(r.fields, ["effectiveRequestProfile"]);
    assert.equal(existsSync(p.where.path), false);
  } finally {
    server.close();
    rmSync(p.root, { recursive: true, force: true });
  }
});
