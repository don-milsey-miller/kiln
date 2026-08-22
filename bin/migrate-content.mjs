#!/usr/bin/env node
/**
 * Apply a content migration — the operation #50 assumed and nobody had built.
 *
 * ⚠️ **This exists because the alternative was hand-editing JSON, which #88 forbids.** #50 says the
 * tool detects and migrates older content; `reviseArtifact` refuses `schemaVersion` (correctly — it is
 * identity, not payload); so a schema change had no legitimate way to reach existing records. That is
 * the same defect as #83's missing lifecycle setter and #126's missing question resolver, now on its
 * fourth appearance, and again it was found by needing it rather than by auditing for it.
 *
 * ⚠️ **Dry run is the default.** `--apply` writes. A migration that runs on invocation is one you
 * discover by reading a diff, and the diff is the thing you wanted to read BEFORE it ran.
 *
 * Usage:
 *   node bin/migrate-content.mjs              # report what would change
 *   node bin/migrate-content.mjs --apply      # do it, under the lock, with atomic writes
 */

import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { resolveContentRoot } from "../lib/content-root.mjs";
import { withLock } from "../lib/lock.mjs";
import { atomicWrite } from "../lib/atomic-write.mjs";
import { createValidators, assertValid } from "../lib/validate.mjs";
import { DATA_DIR } from "../lib/layout.mjs";
import { migrateArtifact, MIGRATION } from "../lib/migrations/environment-axes.mjs";

const apply = process.argv.includes("--apply");

let contentRoot;
try {
  contentRoot = resolveContentRoot();
} catch (e) {
  console.error(e.message);
  process.exitCode = 2;
}

if (contentRoot) {
  const validators = createValidators(new URL("../schemas", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
  const dataDir = join(contentRoot, DATA_DIR);
  const files = existsSync(dataDir)
    ? readdirSync(dataDir).flatMap((d) => {
        const dir = join(dataDir, d);
        if (!statSync(dir).isDirectory()) return []; // data/ holds .gitkeep too
        return readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => join(dir, f));
      })
    : [];

  const results = files.map((path) => ({ path, doc: JSON.parse(readFileSync(path, "utf-8")) }))
    .map(({ path, doc }) => ({ path, id: doc.id, ...migrateArtifact(doc) }));

  const migrated = results.filter((r) => r.action === "migrated");
  const refused = results.filter((r) => r.action === "refused");

  console.log(`migration   ${MIGRATION.id} — ${MIGRATION.describe}`);
  console.log(`schemaVersion ${MIGRATION.fromSchemaVersion} -> ${MIGRATION.toSchemaVersion}\n`);
  for (const r of migrated) console.log(`  would migrate  ${r.id}  (${r.reason})`);
  for (const r of refused) console.log(`  REFUSED        ${r.id}  ${r.reason}`);
  if (!migrated.length && !refused.length) console.log("  nothing to migrate");

  if (refused.length) {
    console.error(`\n${refused.length} record(s) refused. Nothing was written: a partial migration is worse than none.`);
    process.exitCode = 1;
  } else if (apply && migrated.length) {
    // Validate everything BEFORE writing anything. A migration that writes six records and then
    // discovers the seventh is invalid has left the content in a state no schema describes.
    for (const r of migrated) assertValid(validators, r.doc.type, r.doc, `${r.id} after migration`);
    await withLock(join(contentRoot, ".planning.lock"), async () => {
      for (const r of migrated) await atomicWrite(r.path, JSON.stringify(r.doc, null, 2) + "\n");
    });
    console.log(`\napplied     ${migrated.length} record(s)`);
  } else if (migrated.length) {
    console.log(`\ndry run. Re-run with --apply to write ${migrated.length} record(s).`);
  }
}
