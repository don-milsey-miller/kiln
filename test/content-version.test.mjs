/**
 * #50 — the project-wide content schema version, and the enforcement that makes it mean something.
 *
 * ⚠️ **The defect these tests close was invisible for exactly one reason: nothing read the number.**
 * `project.yaml` said 1, the authoring tool stamped 2, and 104 stored artifacts sat evenly split
 * across both — with no rule comparing them, the disagreement had no way to surface, and neither
 * value was wrong on its own terms. So the decisive test here is not that the migration works: it is
 * that a record left BEHIND is a blocking finding, because that is the state the project was in.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { loadSchemaSet } from "../lib/schema-resolver.mjs";
import { createValidators } from "../lib/validate.mjs";
import { lintProject, SEVERITY } from "../lib/lint.mjs";
import { artifactDir } from "../lib/layout.mjs";
import { readActivatedTypes } from "../lib/activation.mjs";
import {
  SCHEMA_VERSION,
  manifestSchemaVersion,
  readManifestSchemaVersion,
  withManifestSchemaVersion,
} from "../lib/content-version.mjs";
import { migrateDocument, MIGRATIONS } from "../lib/migrations/index.mjs";
import { migrateArtifact as bumpVersion } from "../lib/migrations/project-schema-version.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCHEMAS = join(ROOT, "schemas");
const schemas = loadSchemaSet(SCHEMAS);
const validators = createValidators(SCHEMAS);
const ACTIVATED = ["requirement"];

const REQ = (over = {}) => ({
  id: "REQ-0001",
  type: "requirement",
  schemaVersion: SCHEMA_VERSION,
  reviewStatus: "approved",
  lifecycle: "active",
  title: "Nightly replication",
  statement: "The system must replicate the customer table nightly.",
  priority: "must",
  ...over,
});

/** A content root, optionally with a manifest and optionally with a declared version. */
function fresh({ manifest = true, version = SCHEMA_VERSION } = {}) {
  const base = mkdtempSync(join(tmpdir(), "vpw-ver-"));
  const contentRoot = join(base, "planning-content");
  mkdirSync(join(contentRoot, artifactDir("requirement")), { recursive: true });
  if (manifest)
    writeFileSync(
      join(contentRoot, "project.yaml"),
      (version === null ? "" : `schemaVersion: ${version}\n`) + "capabilities:\n  artifactTypes:\n    activated: [requirement]\n"
    );
  return { base, contentRoot, ctx: { contentRoot, schemas, validators, activated: ACTIVATED } };
}

const write = (contentRoot, doc) =>
  writeFileSync(join(contentRoot, artifactDir("requirement"), `${doc.id}.json`), JSON.stringify(doc, null, 2) + "\n");
const ids = (f) => f.map((x) => x.ruleId).sort();

/* ------------------------------------------------------------------- reading the manifest */

test("the reader distinguishes no manifest, an undeclared version, and a declared one", () => {
  const none = fresh({ manifest: false });
  const undeclared = fresh({ version: null });
  const declared = fresh({ version: 7 });
  try {
    assert.deepEqual(manifestSchemaVersion(none.contentRoot), { manifest: false, version: null });
    assert.deepEqual(manifestSchemaVersion(undeclared.contentRoot), { manifest: true, version: null });
    assert.deepEqual(manifestSchemaVersion(declared.contentRoot), { manifest: true, version: 7 });
    assert.equal(readManifestSchemaVersion(declared.contentRoot), 7);
  } finally {
    for (const f of [none, undeclared, declared]) rmSync(f.base, { recursive: true, force: true });
  }
});

test("only a TOP-LEVEL schemaVersion is the project's declaration", () => {
  // ⚠️ Anchored at column 0 on purpose. A nested `schemaVersion:` belongs to whatever block contains
  // it, and reading one as the project's would let an unrelated sub-declaration decide the gate.
  const f = fresh({ version: null });
  try {
    writeFileSync(join(f.contentRoot, "project.yaml"), "capabilities:\n  someBlock:\n    schemaVersion: 9\n");
    assert.equal(readManifestSchemaVersion(f.contentRoot), null);
  } finally {
    rmSync(f.base, { recursive: true, force: true });
  }
});

test("advancing the manifest rewrites one line and keeps the prose around it", () => {
  const text = "# why this number exists\nschemaVersion: 1  # bumped by hand once\n\nname: x\n";
  const out = withManifestSchemaVersion(text, 2);
  // The comment is kept; the spacing before it is normalised to one space, which is predictable.
  assert.match(out, /^schemaVersion: 2 # bumped by hand once$/m);
  assert.ok(out.includes("# why this number exists"), "the comments must survive");
  assert.ok(out.includes("name: x"));
  // Nothing to rewrite is null rather than a file with a line appended somewhere arbitrary.
  assert.equal(withManifestSchemaVersion("name: x\n", 2), null);
});

/* ------------------------------------------------------------------------- the lint rules */

test("a manifest BEHIND the tool blocks, and says to migrate", () => {
  const f = fresh({ version: SCHEMA_VERSION - 1 });
  try {
    const { findings } = lintProject(f.ctx);
    const hit = findings.find((x) => x.ruleId === "content/schema-version-behind-tool");
    assert.ok(hit, JSON.stringify(ids(findings)));
    assert.equal(hit.severity, SEVERITY.ERROR);
    assert.match(hit.message, /migrate it forward/);
  } finally {
    rmSync(f.base, { recursive: true, force: true });
  }
});

test("a manifest AHEAD of the tool blocks, and says to update the TOOL", () => {
  // ⚠️ A different action from the case above, which is why it is a different rule. Content newer
  // than the tool must not be written to — migrating it "forward" would move it backwards.
  const f = fresh({ version: SCHEMA_VERSION + 1 });
  try {
    const hit = lintProject(f.ctx).findings.find((x) => x.ruleId === "content/schema-version-ahead-of-tool");
    assert.ok(hit);
    assert.equal(hit.severity, SEVERITY.ERROR);
    assert.match(hit.message, /update the tool/);
  } finally {
    rmSync(f.base, { recursive: true, force: true });
  }
});

test("an artifact left behind by a migration is a BLOCKING finding, naming the file", () => {
  // ⚠️ THE DEFECT, in one test. This is precisely the state the real project was in: a manifest and a
  // record disagreeing about the version, with nothing to say so.
  const f = fresh();
  try {
    write(f.contentRoot, REQ());
    write(f.contentRoot, REQ({ id: "REQ-0002", schemaVersion: SCHEMA_VERSION - 1 }));
    const findings = lintProject(f.ctx).findings.filter((x) => x.ruleId === "artifact/schema-version-disagrees-with-manifest");
    assert.equal(findings.length, 1, "only the stale record, not its up-to-date sibling");
    assert.equal(findings[0].artifactId, "REQ-0002");
    assert.equal(findings[0].severity, SEVERITY.ERROR);
    assert.match(findings[0].path, /REQ-0002\.json$/);
  } finally {
    rmSync(f.base, { recursive: true, force: true });
  }
});

test("an undeclared version is an advisory; NO manifest is silent", () => {
  const undeclared = fresh({ version: null });
  const none = fresh({ manifest: false });
  try {
    write(undeclared.contentRoot, REQ());
    const hit = lintProject(undeclared.ctx).findings.find((x) => x.ruleId === "content/schema-version-undeclared");
    assert.ok(hit);
    assert.equal(hit.severity, SEVERITY.ADVISORY, "an advisory does not block a gate (#46, #75)");

    // ⚠️ And a content root with no manifest reports NOTHING. Agreement needs two declarations; a
    // finding that fires on every fixture is one nobody reads.
    write(none.contentRoot, REQ());
    assert.deepEqual(
      lintProject(none.ctx).findings.filter((x) => x.ruleId.startsWith("content/schema-version")),
      []
    );
  } finally {
    for (const f of [undeclared, none]) rmSync(f.base, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------------ the migration */

test("the version bump changes the version and NOTHING else", () => {
  const doc = REQ({ schemaVersion: 1, notes: "unchanged" });
  const out = bumpVersion(doc);
  assert.equal(out.action, "migrated");
  assert.deepEqual(out.doc, { ...doc, schemaVersion: SCHEMA_VERSION });
  // ⚠️ No migration note, unlike #131's reshape. That one dropped a value and had to say so; this one
  // rewrites nothing about the record, and a note claiming otherwise would be the invention.
  assert.equal(out.doc.notes, "unchanged");
});

test("the bump refuses a record still owing the #131 reshape, so the order cannot be got wrong", () => {
  const stale = { id: "EVD-0001", type: "evidence", schemaVersion: 1, kind: "experiment", summary: "s", environment: { tier: 1, facts: {} } };
  const out = bumpVersion(stale);
  assert.equal(out.action, "refused");
  assert.match(out.reason, /environment-axes migration must run first/);
});

test("the bump refuses content NEWER than the tool rather than moving it backwards", () => {
  const out = bumpVersion(REQ({ schemaVersion: SCHEMA_VERSION + 1 }));
  assert.equal(out.action, "refused");
  assert.match(out.reason, /NEWER than the tool/);
});

test("the chain reshapes AND advances a pre-#131 evidence record in one pass", () => {
  // ⚠️ The ordering proof. Run the bump alone and this record would be labelled current while still
  // carrying `environment.tier`, permanently out of the reshape's reach.
  const stale = {
    id: "EVD-0001", type: "evidence", schemaVersion: 1, reviewStatus: "approved", lifecycle: "active",
    title: "T", kind: "experiment", summary: "s", environment: { tier: 1, facts: { os: "x" } },
  };
  const out = migrateDocument(stale);
  assert.equal(out.action, "migrated");
  assert.equal(out.doc.schemaVersion, SCHEMA_VERSION);
  assert.equal(out.doc.environment.execution, "host");
  assert.equal("tier" in out.doc.environment, false);
  // ⚠️ The second step SKIPS, and that is the correct shape rather than a gap: #131's reshape carries
  // the record to the current version itself, so the bump finds nothing owing. What the chain
  // guarantees is that the record ends up at one version with one shape, whichever step got it there.
  assert.deepEqual(out.steps.map((s) => `${s.id}:${s.action}`), ["environment-axes:migrated", "project-schema-version:skipped"]);
  assert.deepEqual(MIGRATIONS.map((m) => m.MIGRATION.id), ["environment-axes", "project-schema-version"], "order is load-bearing");
});

test("a refusal anywhere in the chain refuses the DOCUMENT, unchanged", () => {
  const unaccountable = { id: "EVD-0002", type: "evidence", schemaVersion: 1, kind: "experiment", summary: "s", environment: { tier: 3, facts: {} } };
  const out = migrateDocument(unaccountable);
  assert.equal(out.action, "refused");
  assert.match(out.reason, /^environment-axes:/);
  assert.deepEqual(out.doc, unaccountable, "a half-migrated record is one no schema describes");
});

test("migrating an already-current record is a skip, so the chain is idempotent", () => {
  const out = migrateDocument(REQ());
  assert.equal(out.action, "skipped");
  assert.equal(out.doc.schemaVersion, SCHEMA_VERSION);
});

/* ----------------------------------------------------------------- the real project, checked */

test("the REAL project declares one version and every artifact carries it", () => {
  const contentRoot = join(ROOT, "planning-content");
  const ctx = { contentRoot, schemas, validators, activated: readActivatedTypes(contentRoot) };

  assert.equal(readManifestSchemaVersion(contentRoot), SCHEMA_VERSION);
  const { findings, records } = lintProject(ctx);
  assert.ok(records.length > 50, "this is only meaningful against the real content");
  assert.deepEqual(
    findings.filter((f) => f.ruleId.includes("schema-version")),
    [],
    "no record may be left behind by the migration"
  );
});
