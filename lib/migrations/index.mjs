/**
 * The migration chain, in order.
 *
 * ⚠️ **Ordered, and applied as a fold rather than picked from.** `bin/migrate-content.mjs` used to
 * import one migration module directly, so shipping a second one meant editing the CLI and hoping
 * whoever did it got the sequence right. The order matters concretely: #131's reshape must reach a
 * record before its version is advanced, because a version bump puts it out of that reshape's reach.
 *
 * ⚠️ **A refusal anywhere in the chain refuses the DOCUMENT.** A record that is half-migrated is one
 * no schema describes and no migration will finish, which is the same reason the CLI validates
 * everything before it writes anything.
 */

import * as environmentAxes from "./environment-axes.mjs";
import * as projectSchemaVersion from "./project-schema-version.mjs";

export const MIGRATIONS = [environmentAxes, projectSchemaVersion];

/**
 * Run every migration over one document, in order.
 *
 * @param {object} doc
 * @returns {{action: "migrated"|"skipped"|"refused", doc: object, reason: string, steps: Array<{id: string, action: string, reason: string}>}}
 */
export function migrateDocument(doc, migrations = MIGRATIONS) {
  let current = doc;
  const steps = [];

  for (const m of migrations) {
    const out = m.migrateArtifact(current);
    steps.push({ id: m.MIGRATION.id, action: out.action, reason: out.reason });
    if (out.action === "refused") return { action: "refused", doc, reason: `${m.MIGRATION.id}: ${out.reason}`, steps };
    if (out.action === "migrated") current = out.doc;
  }

  const applied = steps.filter((s) => s.action === "migrated");
  return {
    action: applied.length ? "migrated" : "skipped",
    doc: current,
    reason: applied.length ? applied.map((s) => `${s.id} (${s.reason})`).join("; ") : steps.map((s) => s.reason).join("; "),
    steps,
  };
}
