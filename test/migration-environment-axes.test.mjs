/**
 * The migration, tested as a pure function — which is what lets it be tested at all before it runs.
 *
 * ⚠️ The important test is the REFUSAL. A migration that quietly did something reasonable with a
 * tier 2 record would be inventing an observation, which is the failure the whole slice is about.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { migrateArtifact, MIGRATION } from "../lib/migrations/environment-axes.mjs";

const OLD = (over = {}) => ({
  id: "EVD-0001", type: "evidence", schemaVersion: 1, reviewStatus: "approved", lifecycle: "active",
  title: "T", kind: "experiment", summary: "s", outcome: "success", observedAt: "2026-08-18",
  environment: { tier: 1, facts: { os: "Windows 11", node: "v24.18.0" } },
  ...over,
});

test("a tier-1 record becomes a host run and keeps every fact", () => {
  const r = migrateArtifact(OLD());
  assert.equal(r.action, "migrated");
  assert.equal(r.doc.environment.execution, "host");
  assert.equal("tier" in r.doc.environment, false);
  assert.equal("sandboxTier" in r.doc.environment, false, "a host run must not acquire a tier");
  assert.deepEqual(r.doc.environment.facts, { os: "Windows 11", node: "v24.18.0" });
  assert.equal(r.doc.schemaVersion, MIGRATION.toSchemaVersion);
});

test("the dropped value is recorded rather than erased", () => {
  const r = migrateArtifact(OLD());
  assert.match(r.doc.notes, /previously carried `environment\.tier: 1`/);
  assert.match(r.doc.notes, /was not an observation/);
});

test("existing notes survive", () => {
  const r = migrateArtifact(OLD({ notes: "Original note." }));
  assert.match(r.doc.notes, /^Original note\./);
});

test("a tier 2 or 3 record is REFUSED, not guessed at", () => {
  for (const tier of [2, 3]) {
    const r = migrateArtifact(OLD({ environment: { tier, facts: {} } }));
    assert.equal(r.action, "refused", `tier ${tier}`);
    assert.match(r.reason, /Decide what it was before migrating it/);
  }
});

test("source records and already-migrated records are skipped", () => {
  assert.equal(migrateArtifact({ type: "evidence", kind: "source" }).action, "skipped");
  assert.equal(migrateArtifact({ type: "requirement" }).action, "skipped");
  const once = migrateArtifact(OLD()).doc;
  assert.equal(migrateArtifact(once).action, "skipped", "migrating twice must be a no-op");
});

test("nothing about the observation itself is altered", () => {
  const before = OLD();
  const after = migrateArtifact(before).doc;
  for (const k of ["id", "kind", "summary", "outcome", "observedAt", "reviewStatus", "lifecycle"])
    assert.deepEqual(after[k], before[k], `${k} must be untouched`);
});
