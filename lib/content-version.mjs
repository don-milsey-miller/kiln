/**
 * #50 — the PROJECT-WIDE content schema version, and the one place it is defined.
 *
 * ⚠️ **This exists because the version had drifted into meaning two different things.** `project.yaml`
 * declared `schemaVersion: 1` and described itself as the version "that this file and everything under
 * `planning-content/` is written against"; the authoring tool stamped `2` on every new artifact; and
 * the stored content was split across both — 52 records at 1 and 52 at 2 on 2026-08-22. Nothing
 * anywhere read the manifest's number, so the disagreement had no way to surface.
 *
 * ⚠️ **The number is a property of the CONTENT, not of the record's shape.** That is the confusion
 * that produced the split: migration 2 (#131) reshaped `evidence.environment`, and it bumped the
 * version only on the records whose shape it touched — so four evidence records with no `environment`
 * at all stayed at 1 while their neighbours moved to 2, and a requirement authored the same afternoon
 * was stamped 2 for a change that had nothing to do with requirements. Either reading is defensible;
 * having both at once is not, because "schemaVersion: 1" then means "not migrated" on one record and
 * "authored before Tuesday" on the next.
 *
 * The resolution (PM, 2026-08-23): **project-wide, advanced and enforced.** One version for all
 * content, declared in the manifest, carried by every artifact, and checked by the lint — so content
 * written against a version this tool does not know is a finding rather than a surprise.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The content schema version THIS TOOL writes and understands.
 *
 * ⚠️ Bump this on a breaking change to the shape of content, never on a tool release, and ship a
 * migration in the same change — `lib/migrations/` is what carries existing content across.
 */
export const SCHEMA_VERSION = 2; // 2 (2026-08-22): #131's environment reshape.

export const MANIFEST_FILE = "project.yaml";

export function manifestPath(contentRoot) {
  return join(contentRoot, MANIFEST_FILE);
}

/**
 * Read the manifest's declared content schema version, and say whether there was a manifest at all.
 *
 * ⚠️ **Three outcomes, not two.** "No manifest" and "a manifest that declares no version" are
 * different facts and call for different reports: the first is a content root with nothing to
 * disagree with — a fixture, or a project that predates the manifest contract — and the second is a
 * manifest that forgot the one line the tool needs. Collapsing them would either put a finding on
 * every fixture or hide a real omission in a real project.
 *
 * ⚠️ `version: null` is "undeclared", NOT "version zero": reporting a number the manifest does not
 * carry would invent the very agreement this module exists to verify.
 *
 * @returns {{manifest: boolean, version: number|null}}
 */
export function manifestSchemaVersion(contentRoot) {
  const path = manifestPath(contentRoot);
  if (!existsSync(path)) return { manifest: false, version: null };
  // Top-level key only — anchored at column 0, so a `schemaVersion:` nested under some future block
  // cannot be mistaken for the project's own declaration.
  const m = /^schemaVersion:[ \t]*(\d+)[ \t]*(?:#[^\n]*)?$/m.exec(readFileSync(path, "utf-8"));
  return { manifest: true, version: m ? Number(m[1]) : null };
}

/** The declared version alone, for callers that have no use for the distinction. */
export function readManifestSchemaVersion(contentRoot) {
  return manifestSchemaVersion(contentRoot).version;
}

/**
 * Rewrite the manifest's declared version in place, preserving every comment around it.
 *
 * ⚠️ Rewrites the ONE line rather than re-serialising the file. `project.yaml` is mostly prose — the
 * rationale for every declaration in it lives in the comments — and a YAML round-trip would drop all
 * of it to change one integer.
 *
 * @returns {string|null} the new file text, or null when there is no line to rewrite.
 */
export function withManifestSchemaVersion(text, version) {
  const line = /^schemaVersion:[ \t]*\d+[ \t]*(#[^\n]*)?$/m;
  if (!line.test(text)) return null;
  return text.replace(line, (_, comment) => `schemaVersion: ${version}${comment ? ` ${comment}` : ""}`);
}
