import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  approvedModelPoolLaunchState,
  approvedModelPoolStateLocation,
  configureApprovedModelPool,
  migrateSingletonModelState,
  readApprovedModelPoolState,
  reconcileApprovedModelPoolState,
  recordApprovedModelCompatibility,
  recordApprovedModelDecision,
} from "../lib/approved-model-pool-state.mjs";
import { compatibilityLocation } from "../lib/compatibility-record.mjs";
import { consentLocation } from "../lib/consent-record.mjs";
import { deriveApprovedModelCandidates } from "../lib/decisioning/approved-model-pool.mjs";
import { blockText } from "../lib/project-gitignore.mjs";

const NOW = "2026-10-01T12:00:00.000Z";
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const entry = (id, provider, model, thinkingLevel = "high") => ({
  id, provider, model, thinkingLevel, taskClasses: ["planning"], capabilities: ["text", "tools"],
});
const A = entry("planner-a", "provider-a", "model-a");
const B = entry("planner-b", "provider-b", "model-b");
const pool = (entries = [A, B]) => ({ recordVersion: 1, entries });
const route = { kind: "provider-default" };
const key = (modelEntry) => ({
  provider: modelEntry.provider,
  model: modelEntry.model,
  thinkingLevel: modelEntry.thinkingLevel,
  piVersion: "0.87.1",
  apiType: "openai-completions",
  endpointIdentity: { scheme: "https", hostname: `${modelEntry.provider}.example.test`, port: 443, pathname: "/v1" },
  endpointIdentitySource: "derived",
  effectiveRequestProfile: {
    reasoning: true,
    resolvedThinkingValue: modelEntry.thinkingLevel,
    compat: { supportsReasoningEffort: true },
    compatStructured: {},
    unboundedInputs: { categories: [] },
  },
  preflightContractDigest: "sha256:" + "a".repeat(64),
});
const proof = (modelEntry) => ({ key: key(modelEntry), result: { outcome: "passed", observedAt: NOW, challengeEchoed: true } });

function project({ ignored = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), "kiln-model-pool-"));
  const dir = join(root, "project");
  mkdirSync(join(dir, ".pi", "runtime"), { recursive: true });
  git(dir, "init", "-q");
  git(dir, "config", "user.name", "Kiln Test");
  git(dir, "config", "user.email", "kiln@example.test");
  if (ignored) writeFileSync(join(dir, ".gitignore"), blockText());
  writeFileSync(join(dir, "README.md"), "fixture\n");
  git(dir, "add", ".");
  git(dir, "commit", "-qm", "fixture");
  return { root, dir, location: approvedModelPoolStateLocation({ projectRoot: dir }) };
}

test("issue #82: setup confirms every pool entry independently and only proves positive decisions", async () => {
  const p = project();
  try {
    const prompts = [];
    const proved = [];
    const result = await configureApprovedModelPool({
      location: p.location,
      pool: pool(),
      credentialRouteFor: async () => route,
      ask: async (prompt, modelEntry) => {
        prompts.push(prompt);
        return modelEntry.id === A.id;
      },
      recomputeCompatibilityKey: async (modelEntry) => key(modelEntry),
      proveCompatibility: async (modelEntry) => {
        proved.push(modelEntry.id);
        return proof(modelEntry);
      },
      now: () => new Date(NOW),
    });
    assert.equal(prompts.length, 2);
    assert.match(prompts[0], /planner-a.*provider-a.*model-a.*high.*provider-default/);
    assert.match(prompts[1], /planner-b.*provider-b.*model-b.*high.*provider-default/);
    assert.deepEqual(proved, [A.id]);
    assert.deepEqual(result.outcomes.map(({ poolEntryId, state }) => [poolEntryId, state]), [[A.id, "ready"], [B.id, "declined"]]);

    const stored = readApprovedModelPoolState(p.location);
    assert.equal(stored.state, "valid");
    assert.equal(stored.record.entries[A.id].grant.granted, true);
    assert.equal(stored.record.entries[B.id].grant.granted, false);
    assert.equal("compatibility" in stored.record.entries[B.id], false);
    assert.doesNotMatch(readFileSync(p.location.path, "utf8"), /apiKey|Bearer|sk-/i);

    const changedRoutePrompts = [];
    await configureApprovedModelPool({
      location: p.location,
      pool: pool(),
      credentialRouteFor: async (modelEntry) => modelEntry.id === A.id
        ? { kind: "environment", variable: "PROVIDER_A_KEY" }
        : route,
      ask: async (prompt) => { changedRoutePrompts.push(prompt); return true; },
      recomputeCompatibilityKey: async (modelEntry) => key(modelEntry),
      proveCompatibility: async (modelEntry) => proof(modelEntry),
      now: () => new Date(NOW),
    });
    assert.equal(changedRoutePrompts.length, 1, "an unchanged declined entry was asked again");
    assert.match(changedRoutePrompts[0], /environment:PROVIDER_A_KEY/);
    assert.deepEqual(readApprovedModelPoolState(p.location).record.entries[A.id].credentialRoute,
      { kind: "environment", variable: "PROVIDER_A_KEY" });
  } finally {
    rmSync(p.root, { recursive: true, force: true });
  }
});

test("issue #82: model A approval and proof cannot authorize model B", async () => {
  const p = project();
  try {
    await recordApprovedModelDecision(p.location, { entry: A, credentialRoute: route, granted: true, now: () => new Date(NOW) });
    await recordApprovedModelCompatibility(p.location, { entry: A, credentialRoute: route, ...proof(A) });
    const launch = await approvedModelPoolLaunchState(p.location, {
      pool: pool(),
      recomputeCompatibilityKey: async (modelEntry) => key(modelEntry),
    });
    assert.deepEqual(launch.eligibleIds, [A.id]);
    assert.deepEqual(launch.rejected, [{ poolEntryId: B.id, reason: "missing-or-changed-decision" }]);
    const candidates = deriveApprovedModelCandidates({
      pool: pool(),
      approvals: launch.approvals,
      compatibility: launch.compatibility,
      taskClass: "planning",
      requiredCapabilities: ["tools"],
    });
    assert.deepEqual(candidates.map(({ id }) => id), [A.id]);
  } finally {
    rmSync(p.root, { recursive: true, force: true });
  }
});

test("issue #82: launch recomputes the complete key and rejects a stale stored proof", async () => {
  const p = project();
  try {
    await recordApprovedModelDecision(p.location, { entry: A, credentialRoute: route, granted: true, now: () => new Date(NOW) });
    await recordApprovedModelCompatibility(p.location, { entry: A, credentialRoute: route, ...proof(A) });
    const changed = { ...key(A), piVersion: "0.88.0" };
    const launch = await approvedModelPoolLaunchState(p.location, {
      pool: pool([A]),
      recomputeCompatibilityKey: async () => changed,
    });
    assert.deepEqual(launch.eligibleIds, []);
    assert.deepEqual(launch.rejected, [{ poolEntryId: A.id, reason: "compatibility-stale" }]);
    assert.equal(launch.compatibility[0].expectedKey.piVersion, "0.88.0");
  } finally {
    rmSync(p.root, { recursive: true, force: true });
  }
});

test("issue #82: changing or removing pool entries invalidates their grants and proofs atomically", async () => {
  const p = project();
  try {
    for (const modelEntry of [A, B]) {
      await recordApprovedModelDecision(p.location, { entry: modelEntry, credentialRoute: route, granted: true, now: () => new Date(NOW) });
      await recordApprovedModelCompatibility(p.location, { entry: modelEntry, credentialRoute: route, ...proof(modelEntry) });
    }
    const changedA = { ...A, model: "model-a-v2" };
    const result = await reconcileApprovedModelPoolState(p.location, pool([changedA]));
    assert.equal(result.written, true);
    const after = readApprovedModelPoolState(p.location).record;
    assert.deepEqual(after.entries, {});
  } finally {
    rmSync(p.root, { recursive: true, force: true });
  }
});

test("issue #82: a clone inherits neither pool consent nor compatibility proof", async () => {
  const p = project();
  const clone = join(p.root, "clone");
  try {
    await recordApprovedModelDecision(p.location, { entry: A, credentialRoute: route, granted: true, now: () => new Date(NOW) });
    await recordApprovedModelCompatibility(p.location, { entry: A, credentialRoute: route, ...proof(A) });
    git(p.root, "clone", "-q", p.dir, clone);
    mkdirSync(join(clone, ".pi", "runtime"), { recursive: true });
    const cloneLocation = approvedModelPoolStateLocation({ projectRoot: clone });
    assert.equal(readApprovedModelPoolState(cloneLocation).state, "absent");
    const launch = await approvedModelPoolLaunchState(cloneLocation, {
      pool: pool([A]),
      recomputeCompatibilityKey: async (modelEntry) => key(modelEntry),
    });
    assert.deepEqual(launch.eligibleIds, []);
  } finally {
    rmSync(p.root, { recursive: true, force: true });
  }
});

test("issue #82: singleton migration is narrow and preserves the exact grant and proof", async () => {
  const p = project();
  try {
    const oldConsent = consentLocation({ projectRoot: p.dir });
    const oldCompatibility = compatibilityLocation({ projectRoot: p.dir });
    writeFileSync(oldConsent.path, JSON.stringify({
      recordVersion: 1,
      modelUse: { granted: true, decidedAt: NOW, provider: A.provider, model: A.model },
    }, null, 2));
    writeFileSync(oldCompatibility.path, JSON.stringify({ recordVersion: 1, ...proof(A) }, null, 2));

    const migrated = await migrateSingletonModelState({
      location: p.location,
      pool: pool([A, { ...A, id: "same-model-different-thinking", thinkingLevel: "low" }]),
      singletonConsentLocation: oldConsent,
      singletonCompatibilityLocation: oldCompatibility,
    });
    assert.deepEqual(migrated, { migrated: true, poolEntryId: A.id, compatibilityMigrated: true });
    const stored = readApprovedModelPoolState(p.location).record.entries;
    assert.deepEqual(Object.keys(stored), [A.id]);
    assert.equal(stored[A.id].grant.decidedAt, NOW);

    rmSync(p.location.path);
    const ambiguous = await migrateSingletonModelState({
      location: p.location,
      pool: pool([A, { ...A, id: "same-identity" }]),
      singletonConsentLocation: oldConsent,
      singletonCompatibilityLocation: oldCompatibility,
    });
    assert.deepEqual(ambiguous, { migrated: false, reason: "singleton-not-unique" });
  } finally {
    rmSync(p.root, { recursive: true, force: true });
  }
});

test("issue #82: an unignored or tracked pool record grants nothing and is never overwritten", async () => {
  const p = project({ ignored: false });
  try {
    writeFileSync(p.location.path, JSON.stringify({ recordVersion: 1, entries: {} }));
    const before = readFileSync(p.location.path, "utf8");
    assert.equal(readApprovedModelPoolState(p.location).state, "untrusted");
    const write = await recordApprovedModelDecision(p.location, { entry: A, credentialRoute: route, granted: true });
    assert.equal(write.written, false);
    assert.equal(write.reason, "unprotected");
    assert.equal(readFileSync(p.location.path, "utf8"), before);
  } finally {
    rmSync(p.root, { recursive: true, force: true });
  }
});
