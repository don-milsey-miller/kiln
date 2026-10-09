/**
 * Keyed, host-local approval and compatibility storage for approved model pools (#82).
 *
 * The committed pool is intent. This ignored record is the authority for what this operator allowed
 * on this host, one exact entry at a time. A grant and its compatibility proof live in the same
 * entry so changing or removing a pool entry invalidates both in one atomic file replacement.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "./runtime-path.mjs";

import { atomicWrite } from "./atomic-write.mjs";
import { readCompatibility } from "./compatibility-record.mjs";
import { CONSENT_READ, GIT, consentLocation, gitProtection, readConsent } from "./consent-record.mjs";
import { validateApprovedModelPool } from "./decisioning/approved-model-pool.mjs";
import { coverageState } from "./local-state.mjs";
import { withLock } from "./lock.mjs";
import { createRuntimeValidators } from "./runtime-records.mjs";

export const APPROVED_MODEL_POOL_STATE = join("runtime", "approved-model-pool-state.json");
export const APPROVED_MODEL_POOL_LOCK = join("runtime", "approved-model-pool-state.lock");
export const APPROVED_MODEL_POOL_STATE_VERSION = 1;

const CREDENTIAL_VARIABLE = /^[A-Z][A-Z0-9_]*$/;
const plain = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const canonical = (value) => {
  if (Array.isArray(value)) return value.map(canonical);
  if (plain(value)) return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
};
const same = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));

let cachedValidators = null;
const validatorsFor = (supplied) => supplied ?? (cachedValidators ??= createRuntimeValidators());

export function approvedModelPoolStateLocation(where) {
  const consent = consentLocation(where);
  return Object.freeze({
    ...consent,
    path: join(consent.roots.root, APPROVED_MODEL_POOL_STATE),
    lock: join(consent.roots.root, APPROVED_MODEL_POOL_LOCK),
  });
}

export function approvedModelPoolStateLocationFrom(consent) {
  return Object.freeze({
    ...consent,
    path: join(consent.roots.root, APPROVED_MODEL_POOL_STATE),
    lock: join(consent.roots.root, APPROVED_MODEL_POOL_LOCK),
  });
}

export function modelPoolIdentity(entry) {
  return Object.freeze({ provider: entry.provider, model: entry.model, thinkingLevel: entry.thinkingLevel });
}

export function validateCredentialRoute(route) {
  const providerDefault = plain(route) && Object.keys(route).length === 1 && route.kind === "provider-default";
  const environment = plain(route) && Object.keys(route).sort().join("\0") === "kind\0variable" &&
    route.kind === "environment" && CREDENTIAL_VARIABLE.test(route.variable ?? "");
  if (!providerDefault && !environment)
    throw new TypeError("A credential route is {kind: 'provider-default'} or {kind: 'environment', variable: 'NAME'}.");
  return route;
}

export function credentialRouteId(route) {
  validateCredentialRoute(route);
  return route.kind === "provider-default" ? route.kind : `${route.kind}:${route.variable}`;
}

function recordGate(location) {
  const coverage = coverageState({ projectRoot: location.projectRoot, mode: location.stateMode, roots: location.roots });
  if (!coverage.covered) return "unprotected";
  const git = gitProtection(location);
  if (git.state === GIT.IGNORED || git.state === GIT.NO_REPOSITORY) return null;
  return git.state === GIT.INCONCLUSIVE ? "unverified" : git.state;
}

export function readApprovedModelPoolState(location, { validators } = {}) {
  if (!existsSync(location.path)) return { state: "absent", record: null };
  const refused = recordGate(location);
  if (refused) return { state: "untrusted", record: null, why: refused };
  let text;
  try {
    text = readFileSync(location.path, "utf8");
  } catch (error) {
    return error?.code === "ENOENT"
      ? { state: "absent", record: null }
      : { state: "invalid", record: null, why: `could not be opened (${error?.code ?? "unknown"})` };
  }
  let record;
  try {
    record = JSON.parse(text);
  } catch {
    return { state: "invalid", record: null, why: "is not JSON" };
  }
  const validate = validatorsFor(validators)["approved-model-pool-state"];
  if (!validate(record) || record.recordVersion !== APPROVED_MODEL_POOL_STATE_VERSION)
    return { state: "invalid", record: null, why: "does not match its schema" };
  return { state: "valid", record };
}

async function mutate(location, change, { validators } = {}) {
  if (!existsSync(location.runtime)) return { written: false, reason: "no-runtime-dir" };
  const checks = validatorsFor(validators);
  return withLock(location.lock, async () => {
    const refused = recordGate(location);
    if (refused) return { written: false, reason: refused };
    const read = readApprovedModelPoolState(location, { validators: checks });
    if (read.state === "invalid" && read.why?.startsWith("could not be opened"))
      return { written: false, reason: "inaccessible" };
    const before = read.record ?? { recordVersion: APPROVED_MODEL_POOL_STATE_VERSION, entries: {} };
    const after = change(structuredClone(before));
    if (after === null) return { written: false, reason: "unchanged", record: before };
    const validate = checks["approved-model-pool-state"];
    if (!validate(after))
      throw new TypeError(`Refusing to write invalid approved-model-pool state: ${validate.errors?.map((e) => `${e.instancePath || "/"} ${e.message}`).join("; ")}`);
    await atomicWrite(location.path, JSON.stringify(after, null, 2) + "\n");
    return { written: true, record: after };
  });
}

const currentEntry = (entry, state) => state && same(state.identity, modelPoolIdentity(entry));

/** Remove every changed or removed entry—and its proof—in one atomic state-file replacement. */
export async function reconcileApprovedModelPoolState(location, pool, opts = {}) {
  validateApprovedModelPool(pool);
  const wanted = new Map(pool.entries.map((entry) => [entry.id, entry]));
  return mutate(location, (record) => {
    const entries = Object.fromEntries(Object.entries(record.entries).filter(([id, state]) => {
      const entry = wanted.get(id);
      return entry && currentEntry(entry, state);
    }));
    if (same(entries, record.entries)) return null;
    return { ...record, entries };
  }, opts);
}

/** Record one explicit yes/no. A changed route replaces the entry and clears its old proof. */
export async function recordApprovedModelDecision(location, { entry, credentialRoute, granted, now = () => new Date() }, opts = {}) {
  validateApprovedModelPool({ recordVersion: 1, entries: [entry] });
  validateCredentialRoute(credentialRoute);
  if (typeof granted !== "boolean") throw new TypeError("Only an explicit boolean is a model-pool decision.");
  const decidedAt = now().toISOString();
  return mutate(location, (record) => ({
    ...record,
    entries: {
      ...record.entries,
      [entry.id]: {
        identity: modelPoolIdentity(entry),
        credentialRoute: structuredClone(credentialRoute),
        grant: { granted, decidedAt },
      },
    },
  }), opts);
}

/** Persist a passed proof only beside the exact positive decision it belongs to. */
export async function recordApprovedModelCompatibility(
  location,
  { entry, credentialRoute, key, result },
  opts = {}
) {
  validateApprovedModelPool({ recordVersion: 1, entries: [entry] });
  validateCredentialRoute(credentialRoute);
  if (result?.outcome !== "passed") throw new TypeError("Only a passed model-pool canary is recorded.");
  if (!same(modelPoolIdentity(entry), { provider: key?.provider, model: key?.model, thinkingLevel: key?.thinkingLevel }))
    throw new TypeError("The compatibility key does not belong to this pool entry.");
  return mutate(location, (record) => {
    const state = record.entries[entry.id];
    if (!currentEntry(entry, state) || !same(state.credentialRoute, credentialRoute) || state.grant.granted !== true)
      throw new TypeError("A passed proof requires this exact pool entry and credential route to be approved first.");
    return {
      ...record,
      entries: {
        ...record.entries,
        [entry.id]: { ...state, compatibility: { key: structuredClone(key), result: structuredClone(result) } },
      },
    };
  }, opts);
}

/**
 * Launch-time read. The compatibility key is recomputed for every positive entry; stored or
 * transcript-supplied claims are never accepted as the expected key.
 */
export async function approvedModelPoolLaunchState(location, { pool, recomputeCompatibilityKey }, opts = {}) {
  validateApprovedModelPool(pool);
  if (typeof recomputeCompatibilityKey !== "function") throw new TypeError("Launch must supply recomputeCompatibilityKey().");
  const read = readApprovedModelPoolState(location, opts);
  const approvals = [];
  const compatibility = [];
  const rejected = [];
  if (read.state !== "valid") return { state: read.state, approvals, compatibility, eligibleIds: [], rejected };

  for (const entry of pool.entries) {
    const stored = read.record.entries[entry.id];
    if (!currentEntry(entry, stored)) {
      rejected.push({ poolEntryId: entry.id, reason: "missing-or-changed-decision" });
      continue;
    }
    approvals.push({
      poolEntryId: entry.id,
      granted: stored.grant.granted,
      identity: structuredClone(stored.identity),
      credentialRoute: credentialRouteId(stored.credentialRoute),
    });
    if (!stored.grant.granted) {
      rejected.push({ poolEntryId: entry.id, reason: "declined" });
      continue;
    }
    if (!stored.compatibility) {
      rejected.push({ poolEntryId: entry.id, reason: "compatibility-absent" });
      continue;
    }
    let expectedKey;
    try {
      expectedKey = await recomputeCompatibilityKey(entry, structuredClone(stored.credentialRoute));
    } catch {
      rejected.push({ poolEntryId: entry.id, reason: "compatibility-key-unavailable" });
      continue;
    }
    const proof = {
      poolEntryId: entry.id,
      key: structuredClone(stored.compatibility.key),
      expectedKey: structuredClone(expectedKey),
      result: structuredClone(stored.compatibility.result),
    };
    compatibility.push(proof);
    if (!same(proof.key, proof.expectedKey) || proof.result.outcome !== "passed")
      rejected.push({ poolEntryId: entry.id, reason: "compatibility-stale" });
  }
  const proofById = new Map(compatibility.map((proof) => [proof.poolEntryId, proof]));
  const eligibleIds = approvals.filter((approval) => approval.granted && same(proofById.get(approval.poolEntryId)?.key, proofById.get(approval.poolEntryId)?.expectedKey))
    .map((approval) => approval.poolEntryId);
  return { state: "valid", approvals, compatibility, eligibleIds, rejected };
}

/** Setup-facing orchestration: each new/changed entry is asked independently and proved only after yes. */
export async function configureApprovedModelPool({
  location,
  pool,
  ask,
  credentialRouteFor,
  recomputeCompatibilityKey,
  proveCompatibility,
  now = () => new Date(),
  validators,
}) {
  if (typeof ask !== "function" || typeof credentialRouteFor !== "function")
    throw new TypeError("Pool setup requires ask() and credentialRouteFor().");
  await reconcileApprovedModelPoolState(location, pool, { validators });
  const outcomes = [];
  for (const entry of pool.entries) {
    let stored = readApprovedModelPoolState(location, { validators }).record?.entries?.[entry.id];
    // Setup resolves the current route every time after its inspection-consent boundary. Reusing
    // the stored name here would make a route change invisible and silently preserve old approval.
    const route = await credentialRouteFor(entry);
    validateCredentialRoute(route);
    if (!currentEntry(entry, stored) || !same(stored.credentialRoute, route)) {
      const answer = await ask(
        `Allow this computer to use approved model pool entry ${entry.id}: ${entry.provider} ${entry.model} ` +
          `(${entry.thinkingLevel}) through ${credentialRouteId(route)}?`,
        entry
      );
      if (typeof answer !== "boolean") {
        outcomes.push({ poolEntryId: entry.id, state: "unanswered" });
        continue;
      }
      const recorded = await recordApprovedModelDecision(location, { entry, credentialRoute: route, granted: answer, now }, { validators });
      if (!recorded.written && recorded.reason !== "unchanged") {
        outcomes.push({ poolEntryId: entry.id, state: answer ? "approved-for-run" : "declined-for-run", persisted: false, reason: recorded.reason });
        continue;
      }
      stored = recorded.record.entries[entry.id];
    }
    if (!stored.grant.granted) {
      outcomes.push({ poolEntryId: entry.id, state: "declined", persisted: true });
      continue;
    }
    let current = false;
    if (stored.compatibility && typeof recomputeCompatibilityKey === "function") {
      const expected = await recomputeCompatibilityKey(entry, structuredClone(route));
      current = same(stored.compatibility.key, expected) && stored.compatibility.result.outcome === "passed";
    }
    if (!current && typeof proveCompatibility === "function") {
      const proof = await proveCompatibility(entry, structuredClone(route));
      const recorded = await recordApprovedModelCompatibility(location, { entry, credentialRoute: route, ...proof }, { validators });
      outcomes.push({ poolEntryId: entry.id, state: recorded.written ? "ready" : "proved-for-run", persisted: recorded.written, ...(recorded.reason ? { reason: recorded.reason } : {}) });
    } else {
      outcomes.push({ poolEntryId: entry.id, state: current ? "ready" : "approved-awaiting-proof", persisted: true });
    }
  }
  return { outcomes };
}

/**
 * One-time narrow migration. A singleton grant is copied only when exactly one pool entry matches;
 * a singleton proof is copied only when its complete key names that same entry.
 */
export async function migrateSingletonModelState({
  location,
  pool,
  singletonConsentLocation,
  singletonCompatibilityLocation,
  validators,
}) {
  validateApprovedModelPool(pool);
  const existing = readApprovedModelPoolState(location, { validators });
  if (existing.state === "valid" && Object.keys(existing.record.entries).length)
    return { migrated: false, reason: "pool-state-present" };
  const consent = readConsent(singletonConsentLocation, { validators });
  if (consent.state !== CONSENT_READ.VALID || !consent.record.modelUse)
    return { migrated: false, reason: "singleton-consent-unavailable" };
  const legacyGrant = consent.record.modelUse;
  const legacyCompatibility = readCompatibility(singletonCompatibilityLocation, { validators });
  const proof = legacyCompatibility.state === "valid" ? legacyCompatibility.record : null;
  const matches = pool.entries.filter((entry) =>
    entry.provider === legacyGrant.provider && entry.model === legacyGrant.model &&
    (!proof || entry.thinkingLevel === proof.key.thinkingLevel)
  );
  if (matches.length !== 1) return { migrated: false, reason: "singleton-not-unique" };
  const entry = matches[0];
  const credentialRoute = legacyGrant.credentialVar
    ? { kind: "environment", variable: legacyGrant.credentialVar }
    : { kind: "provider-default" };
  const compatibility = proof && same(modelPoolIdentity(entry), {
    provider: proof.key.provider,
    model: proof.key.model,
    thinkingLevel: proof.key.thinkingLevel,
  }) ? { key: structuredClone(proof.key), result: structuredClone(proof.result) } : undefined;
  const result = await mutate(location, (record) => ({
    ...record,
    entries: {
      ...record.entries,
      [entry.id]: {
        identity: modelPoolIdentity(entry),
        credentialRoute,
        grant: { granted: legacyGrant.granted, decidedAt: legacyGrant.decidedAt },
        ...(legacyGrant.granted && compatibility ? { compatibility } : {}),
      },
    },
  }), { validators });
  return result.written
    ? { migrated: true, poolEntryId: entry.id, compatibilityMigrated: Boolean(legacyGrant.granted && compatibility) }
    : { migrated: false, reason: result.reason };
}
