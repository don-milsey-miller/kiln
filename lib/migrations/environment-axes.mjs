/**
 * Migration 2 — `evidence.environment` gains two axes (#131).
 *
 * Before: `{ tier: 1, facts: {...} }`, where `tier` was REQUIRED, so every recorded experiment had to
 * name a sandbox tier whether or not one existed.
 * After:  `{ execution: "host" | "controller", facts: {...} }`, with `sandboxTier` present only when
 * a controller supplied the isolation.
 *
 * ⚠️ **Every existing record migrates to `host`, and that DROPS a value they carried.** Justified,
 * and the justification is the whole reason this file has prose in it: no validation controller has
 * ever existed on this project, so every one of these runs executed directly on the PM's machine.
 * Their `tier: 1` was **not an observation** — it was the only value the old schema would accept.
 * Keeping it would preserve a claim of isolation that no run ever had, which is exactly the false
 * confidence rung #42's ladder exists to prevent.
 *
 * ⚠️ **The dropped value is recorded, not erased.** Each migrated record gets a note saying what it
 * used to carry and why it no longer does. "Preserve the original observation exactly" cuts both
 * ways: a migration that silently rewrote history would be the same defect as one that invented data.
 *
 * ⚠️ **It refuses to guess.** A record whose `tier` is 2 or 3 would describe a run this project cannot
 * account for, so the migration reports it and changes nothing rather than assuming.
 */

export const MIGRATION = {
  id: "environment-axes",
  fromSchemaVersion: 1,
  toSchemaVersion: 2,
  describe: "evidence.environment: tier -> execution + optional sandboxTier (#131)",
};

const NOTE =
  " ⚠️ MIGRATED 2026-08-22 (#131): this record previously carried `environment.tier: 1`. It was not an " +
  "observation — the old schema REQUIRED a sandbox tier, and tier 1 was the only value that fit a run " +
  "with no controller. No validation controller existed when this was recorded, so the run executed " +
  "directly on the host and is now recorded as `execution: \"host\"` with no tier. The value is dropped " +
  "rather than kept because keeping it would claim isolation the run never had.";

/**
 * @param {object} doc
 * @returns {{action: "migrated"|"skipped"|"refused", doc?: object, reason: string}}
 */
export function migrateArtifact(doc) {
  if (doc?.type !== "evidence") return { action: "skipped", reason: "not evidence" };
  const env = doc.environment;
  if (!env) return { action: "skipped", reason: "no environment (a source record)" };
  if (env.execution) return { action: "skipped", reason: "already migrated" };

  if (env.tier !== 1)
    return {
      action: "refused",
      reason:
        `environment.tier is ${JSON.stringify(env.tier)}. Only tier 1 can be migrated automatically: ` +
        `a tier 2 or 3 record describes a controller-managed run, and no controller has ever run on ` +
        `this project. Decide what it was before migrating it.`,
    };

  const { tier, ...rest } = env;
  return {
    action: "migrated",
    reason: "tier 1 with no controller -> execution: host",
    doc: {
      ...doc,
      schemaVersion: MIGRATION.toSchemaVersion,
      environment: { execution: "host", ...rest },
      notes: (doc.notes ?? "") + NOTE,
    },
  };
}
