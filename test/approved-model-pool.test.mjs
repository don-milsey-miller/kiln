import { test } from "node:test";
import assert from "node:assert/strict";

import {
  deriveApprovedModelCandidates,
  recommendApprovedModel,
  validateApprovedModelPool,
} from "../lib/decisioning/approved-model-pool.mjs";

const key = (provider, model, thinkingLevel) => ({
  provider, model, thinkingLevel, piVersion: "0.87.1", apiType: "openai-completions",
  endpointIdentity: { scheme: "https", hostname: "example.test", port: 443, pathname: "/v1" },
  endpointIdentitySource: "derived", effectiveRequestProfile: { category: "known", maxTokens: 4096 },
  preflightContractDigest: "sha256:abc",
});
const pool = {
  recordVersion: 1,
  entries: [
    { id: "fast-planner", provider: "provider-a", model: "fast-1", thinkingLevel: "low", taskClasses: ["planning"], capabilities: ["text", "tools"] },
    { id: "deep-planner", provider: "provider-b", model: "deep-2", thinkingLevel: "high", taskClasses: ["planning", "validation"], capabilities: ["text", "tools"] },
    { id: "research-only", provider: "provider-c", model: "search-1", thinkingLevel: "medium", taskClasses: ["research"], capabilities: ["text"] },
  ],
};
const approval = (entry, over = {}) => ({
  poolEntryId: entry.id,
  granted: true,
  identity: { provider: entry.provider, model: entry.model, thinkingLevel: entry.thinkingLevel },
  credentialRoute: "built-in",
  ...over,
});
const proof = (entry, over = {}) => {
  const compatible = key(entry.provider, entry.model, entry.thinkingLevel);
  return { poolEntryId: entry.id, key: compatible, expectedKey: structuredClone(compatible), result: { outcome: "passed" }, ...over };
};

test("issue #71: the committed pool representation is closed and cannot carry a credential", () => {
  assert.equal(validateApprovedModelPool(pool), pool);
  assert.throws(() => validateApprovedModelPool({
    ...pool,
    entries: [{ ...pool.entries[0], apiKey: "secret" }],
  }), /closed/);
});

test("issue #71: approval, compatibility, task class, and capabilities narrow before inference", () => {
  const approvals = pool.entries.map((entry) => approval(entry));
  const compatibility = pool.entries.map((entry) => proof(entry));
  compatibility[1] = proof(pool.entries[1], { expectedKey: { ...key("provider-b", "deep-2", "high"), piVersion: "changed" } });
  const candidates = deriveApprovedModelCandidates({
    pool, approvals, compatibility, taskClass: "planning", requiredCapabilities: ["tools"],
  });
  assert.deepEqual(candidates.map((entry) => entry.id), ["fast-planner"]);
});

test("issue #71: Jev sees and may choose only individually approved, compatible candidates", async () => {
  const calls = [];
  const out = await recommendApprovedModel({
    task: "Choose a model for one bounded planning comparison.",
    pool,
    approvals: pool.entries.map((entry) => approval(entry)),
    compatibility: pool.entries.map((entry) => proof(entry)),
    taskClass: "planning",
    requiredCapabilities: ["tools"],
  }, {
    evaluate: async (request) => {
      calls.push(request);
      return {
        ok: true, backend: "stand-in", model: "jev-test",
        answers: { model_pool_entry: { type: "choice", choice: "deep-planner", confidence: 0.7, probabilities: { "fast-planner": 0.3, "deep-planner": 0.7 } } },
      };
    },
  });
  assert.deepEqual(Object.keys(calls[0].questions.model_pool_entry.criteria), ["fast-planner", "deep-planner"]);
  assert.deepEqual(out.candidateIds, ["fast-planner", "deep-planner"]);
  assert.equal(out.recommendation.choice, "deep-planner");
  assert.equal(out.executionAuthorized, false);
  assert.equal(out.billingAuthorizationCreated, false);
});

test("issue #71: an unapproved or out-of-pool Jev choice is rejected", async () => {
  const out = await recommendApprovedModel({
    task: "Route this planning task.", pool,
    approvals: pool.entries.map((entry) => approval(entry)),
    compatibility: pool.entries.map((entry) => proof(entry)),
    taskClass: "planning", requiredCapabilities: ["tools"],
  }, {
    evaluate: async () => ({
      ok: true,
      answers: { model_pool_entry: { type: "choice", choice: "cheap-unapproved-model", confidence: 1, probabilities: { "cheap-unapproved-model": 1 } } },
    }),
  });
  assert.equal(out.ok, false);
  assert.equal(out.reason, "invalid-response");
  assert.match(out.fallback, /single-model/);
});

test("issue #71: an unapproved sole model produces no inference and no fallback substitution", async () => {
  let calls = 0;
  const out = await recommendApprovedModel({
    task: "Route this planning task.", pool,
    approvals: [approval(pool.entries[0], { granted: false })],
    compatibility: [proof(pool.entries[0])],
    taskClass: "planning", requiredCapabilities: ["tools"],
  }, { evaluate: async () => (calls += 1) });
  assert.equal(calls, 0);
  assert.equal(out.ok, false);
  assert.equal(out.reason, "no-approved-compatible-model");
});
