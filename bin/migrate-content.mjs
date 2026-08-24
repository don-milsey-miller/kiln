#!/usr/bin/env node
/**
 * Apply the content migrations — the operation #50 assumed and nobody had built.
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
 * ⚠️ **The MANIFEST moves with the content, in the same write.** Advancing the records and leaving
 * `project.yaml` behind is how the version came to mean two things in the first place; doing both
 * under one lock is what makes "one version for all content" a state rather than an intention.
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
import { MIGRATIONS, migrateDocument } from "../lib/migrations/index.mjs";
import { SCHEMA_VERSION, manifestPath, readManifestSchemaVersion, withManifestSchemaVersion } from "../lib/content-version.mjs";

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
    .map(({ path, doc }) => ({ path, id: doc.id, ...migrateDocument(doc) }));

  const migrated = results.filter((r) => r.action === "migrated");
  const refused = results.filter((r) => r.action === "refused");

  const declared = readManifestSchemaVersion(contentRoot);
  const manifestText = existsSync(manifestPath(contentRoot)) ? readFileSync(manifestPath(contentRoot), "utf-8") : null;
  const manifestNext = declared !== SCHEMA_VERSION && manifestText !== null ? withManifestSchemaVersion(manifestText, SCHEMA_VERSION) : null;

  for (const m of MIGRATIONS) console.log(`migration   ${m.MIGRATION.id} — ${m.MIGRATION.describe}`);
  console.log(`content     schemaVersion ${declared ?? "undeclared"} -> ${SCHEMA_VERSION}\n`);

  for (const r of migrated) console.log(`  would migrate  ${r.id}  (${r.reason})`);
  for (const r of refused) console.log(`  REFUSED        ${r.id}  ${r.reason}`);
  if (!migrated.length && !refused.length) console.log("  nothing to migrate");

  if (declared !== SCHEMA_VERSION) {
    if (manifestText === null) console.log(`\n  no project.yaml — the manifest version cannot be advanced here`);
    else if (manifestNext === null)
      console.log(`\n  project.yaml declares no schemaVersion line to advance; add \`schemaVersion: ${SCHEMA_VERSION}\` to it`);
    else console.log(`\n  would advance  project.yaml  schemaVersion ${declared ?? "undeclared"} -> ${SCHEMA_VERSION}`);
  }

  if (refused.length) {
    console.error(`\n${refused.length} record(s) refused. Nothing was written: a partial migration is worse than none.`);
    process.exitCode = 1;
  } else if (apply && (migrated.length || manifestNext)) {
    // Validate everything BEFORE writing anything. A migration that writes six records and then
    // discovers the seventh is invalid has left the content in a state no schema describes.
    for (const r of migrated) assertValid(validators, r.doc.type, r.doc, `${r.id} after migration`);
    await withLock(join(contentRoot, ".planning.lock"), async () => {
      for (const r of migrated) await atomicWrite(r.path, JSON.stringify(r.doc, null, 2) + "\n");
      // ⚠️ Inside the same lock as the records. The manifest and the content it describes must never
      // be observable in disagreement, which is exactly the state this migration exists to end.
      if (manifestNext) await atomicWrite(manifestPath(contentRoot), manifestNext);
    });
    console.log(`\napplied     ${migrated.length} record(s)${manifestNext ? " and the manifest" : ""}`);
  } else if (migrated.length || manifestNext) {
    console.log(`\ndry run. Re-run with --apply to write ${migrated.length} record(s)${manifestNext ? " and the manifest" : ""}.`);
  }
}
