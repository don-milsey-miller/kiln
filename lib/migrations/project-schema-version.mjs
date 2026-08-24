/**
 * Migration 3 — the content version becomes project-wide (#50).
 *
 * ⚠️ **This migration changes NO shape, and that is the point rather than a weakness.** Migration 2
 * (#131) reshaped `evidence.environment` and bumped `schemaVersion` only on the records it reshaped,
 * which quietly redefined the field: on those records it meant "migrated", and on everything the
 * authoring tool stamped afterwards it meant "authored after the bump". The result was 104 artifacts
 * split evenly across two versions with no way to tell which sense either number carried.
 *
 * ⚠️ **So this one moves the records that migration 2 correctly left alone.** Four evidence records
 * had no `environment` at all — source records, nothing to reshape — and stayed at 1 beside migrated
 * siblings at 2. Under a project-wide version they were never behind on anything; they were behind on
 * a number that had stopped describing them.
 *
 * ⚠️ **No note is appended, unlike migration 2.** Migration 2 dropped a value and said so on every
 * record it touched, because a migration that silently rewrites history is the same defect as one
 * that invents data. Nothing here is rewritten: the field being changed is the project's version, not
 * an observation. A note claiming otherwise would be the invention.
 *
 * ⚠️ **It refuses anything still owing a SHAPE migration**, so the order cannot be got wrong by
 * running this one alone. A record bumped to 2 while still carrying the pre-#131 environment would be
 * labelled current and be unmigratable afterwards — migration 2 skips anything whose version has
 * already moved.
 */

import { SCHEMA_VERSION } from "../content-version.mjs";

export const MIGRATION = {
  id: "project-schema-version",
  fromSchemaVersion: 1,
  toSchemaVersion: SCHEMA_VERSION,
  describe: "schemaVersion is the PROJECT's content version (#50): every artifact carries it, shape change or not",
};

/**
 * @param {object} doc
 * @returns {{action: "migrated"|"skipped"|"refused", doc?: object, reason: string}}
 */
export function migrateArtifact(doc) {
  const version = doc?.schemaVersion;
  if (version === MIGRATION.toSchemaVersion) return { action: "skipped", reason: "already at the project version" };

  if (!Number.isInteger(version) || version < 1)
    return { action: "refused", reason: `schemaVersion is ${JSON.stringify(version)}; only a declared integer version can be advanced.` };

  if (version > MIGRATION.toSchemaVersion)
    return {
      action: "refused",
      reason:
        `schemaVersion is ${version} and this tool writes ${MIGRATION.toSchemaVersion}. The content is ` +
        `NEWER than the tool — update the tool rather than moving the content backwards.`,
    };

  if (doc.type === "evidence" && doc.environment && !doc.environment.execution)
    return {
      action: "refused",
      reason:
        "still carries the pre-#131 environment shape. The environment-axes migration must run first; " +
        "bumping the version here would label it current and put it out of that migration's reach.",
    };

  return {
    action: "migrated",
    reason: `version bump only: nothing about this record's shape changed, and ${MIGRATION.toSchemaVersion} is what this project's content is written against`,
    doc: { ...doc, schemaVersion: MIGRATION.toSchemaVersion },
  };
}
