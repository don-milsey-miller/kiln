import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  ARTIFACT_READ_TYPES_ENV,
  ArtifactReadRefusal,
  artifactReadTypesForRole,
  listArtifacts,
  readArtifact,
  readSource,
} from "../lib/tools/read-artifacts.mjs";
import { createRequirement } from "../lib/tools/create-requirement.mjs";
import { createSource, reviseArtifact } from "../lib/tools/evidence-tools.mjs";
import { loadSchemaSet } from "../lib/schema-resolver.mjs";
import { createValidators } from "../lib/validate.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCHEMAS = join(ROOT, "schemas");

async function fixture() {
  const base = mkdtempSync(join(tmpdir(), "kiln-artifact-read-"));
  const contentRoot = join(base, "planning-content");
  mkdirSync(contentRoot, { recursive: true });
  const schemas = loadSchemaSet(SCHEMAS);
  const validators = createValidators(SCHEMAS);
  const options = { contentRoot, schemasDir: SCHEMAS, schemas, validators };
  const made = [];
  for (const statement of ["Alpha", "Bravo", "Charlie", "Delta"])
    made.push(await createRequirement({ title: statement, statement }, options));

  const approvedPath = join(contentRoot, made[1].path);
  const approved = JSON.parse(readFileSync(approvedPath, "utf8"));
  approved.reviewStatus = "approved";
  writeFileSync(approvedPath, `${JSON.stringify(approved, null, 2)}\n`);

  return {
    base,
    contentRoot,
    ctx: { contentRoot, schemas, validators, activated: ["requirement"] },
    options,
    made,
  };
}

const refused = (code) => (error) => error instanceof ArtifactReadRefusal && error.code === code;

test("artifact lists are typed, filtered, stable, paginated records with content hashes", async () => {
  const f = await fixture();
  try {
    const first = listArtifacts({ type: "requirement", limit: 2 }, f.ctx, { env: {} });
    assert.deepEqual(first.records.map((record) => record.artifact.id), ["REQ-0001", "REQ-0002"]);
    assert.match(first.records[0].hash, /^sha256:(?:[0-9a-f]{8}-){7}[0-9a-f]{8}$/);
    assert.equal(typeof first.nextCursor, "string");

    const second = listArtifacts({ type: "requirement", limit: 2, cursor: first.nextCursor }, f.ctx, { env: {} });
    assert.deepEqual(second.records.map((record) => record.artifact.id), ["REQ-0003", "REQ-0004"]);
    assert.equal(second.nextCursor, null);

    const approved = listArtifacts({ type: "requirement", reviewStatus: "approved" }, f.ctx, { env: {} });
    assert.deepEqual(approved.records.map((record) => record.artifact.id), ["REQ-0002"]);
    const drafts = listArtifacts({ type: "requirement", reviewStatus: "draft", limit: 2 }, f.ctx, { env: {} });
    assert.deepEqual(drafts.records.map((record) => record.artifact.id), ["REQ-0001", "REQ-0003"]);
    assert.ok(drafts.nextCursor, "a filtered page reports another matching draft, not merely another file");
  } finally {
    rmSync(f.base, { recursive: true, force: true });
  }
});

test("reads return only the current validated record and a hash that changes after revision", async () => {
  const f = await fixture();
  try {
    const before = readArtifact({ id: "REQ-0001" }, f.ctx, { env: {} });
    assert.equal(before.artifact.statement, "Alpha");
    await reviseArtifact("requirement", "REQ-0001", { statement: "Alpha revised" }, f.options);
    const after = readArtifact({ id: "REQ-0001" }, f.ctx, { env: {} });
    assert.equal(after.artifact.statement, "Alpha revised");
    assert.notEqual(after.hash, before.hash);
  } finally {
    rmSync(f.base, { recursive: true, force: true });
  }
});

test("unknown ids, inactive types, role-denied types and mismatched cursors fail closed", async () => {
  const f = await fixture();
  try {
    assert.throws(() => readArtifact({ id: "REQ-9999" }, f.ctx, { env: {} }), refused("unknown-id"));
    assert.throws(() => readArtifact({ id: "../../REQ-0001" }, f.ctx, { env: {} }), refused("unknown-id"));
    assert.throws(
      () => readArtifact({ id: "REQ-0001" }, { ...f.ctx, activated: [] }, { env: {} }),
      refused("inactive-type")
    );
    assert.throws(
      () => readArtifact({ id: "REQ-0001" }, f.ctx, { env: { [ARTIFACT_READ_TYPES_ENV]: "evidence" } }),
      refused("type-not-permitted")
    );
    const page = listArtifacts({ type: "requirement", reviewStatus: "draft", limit: 1 }, f.ctx, { env: {} });
    assert.throws(
      () => listArtifacts({ type: "requirement", reviewStatus: "approved", cursor: page.nextCursor }, f.ctx, { env: {} }),
      refused("invalid-cursor")
    );
    const nonFile = join(f.contentRoot, f.made[0].path);
    rmSync(nonFile);
    mkdirSync(nonFile);
    assert.throws(() => readArtifact({ id: "REQ-0001" }, f.ctx, { env: {} }), refused("artifact-path-refused"));
  } finally {
    rmSync(f.base, { recursive: true, force: true });
  }
});

test("each specialist role has an explicit, immutable-by-copy readable type set", () => {
  const planning = artifactReadTypesForRole("planning");
  assert.ok(planning.includes("api-spec") && planning.includes("wireframe"));
  assert.deepEqual(artifactReadTypesForRole("research"), ["assertion", "decision", "evidence", "question", "requirement"]);
  assert.deepEqual(artifactReadTypesForRole("validation"), ["acceptance-criterion", "api-spec", "assertion", "component", "evidence", "schema"]);
  planning.length = 0;
  assert.ok(artifactReadTypesForRole("planning").length > 0);
  assert.deepEqual(artifactReadTypesForRole("unknown"), []);
});

test("source reads return bounded normalized pages, provenance, and a stale-safe cursor", async () => {
  const base = mkdtempSync(join(tmpdir(), "kiln-source-read-"));
  const contentRoot = join(base, "planning-content");
  const payloadDir = join(contentRoot, "sources", "SRC-0001");
  mkdirSync(payloadDir, { recursive: true });
  const payloadPath = join(payloadDir, "content.md");
  writeFileSync(payloadPath, "First page and second page.\n");
  const schemas = loadSchemaSet(SCHEMAS);
  const validators = createValidators(SCHEMAS);
  try {
    await createSource({
      title: "Imported notes",
      sourceKind: "text",
      relationship: "external-reference",
      origin: { kind: "upload", filename: "notes.txt" },
      integrity: { sha256: "a".repeat(64), bytes: 28, mediaType: "text/plain" },
      derivedPayload: { format: "markdown", path: "sources/SRC-0001/content.md" },
      processor: { id: "text/deterministic" },
    }, { contentRoot, schemasDir: SCHEMAS, schemas, validators });
    const ctx = { contentRoot, schemas, validators, activated: ["source"] };
    const first = readSource({ id: "SRC-0001", limit: 10 }, ctx, { env: {} });
    assert.equal(first.payload.content, "First page");
    assert.equal(typeof first.payload.nextCursor, "string");
    assert.equal(first.sourceBoundary.relationship, "external-reference");
    assert.equal(first.sourceBoundary.contentRole, "untrusted-extracted-material");
    assert.match(first.payload.hash, /^sha256:(?:[0-9a-f]{8}-){7}[0-9a-f]{8}$/);
    assert.equal(first.payload.path, "sources/SRC-0001/content.md");

    const second = readSource({ id: "SRC-0001", cursor: first.payload.nextCursor, limit: 100 }, ctx, { env: {} });
    assert.equal(second.payload.content, " and second page.\n");
    assert.equal(second.payload.nextCursor, null);

    writeFileSync(payloadPath, "Changed after cursor issuance.\n");
    assert.throws(
      () => readSource({ id: "SRC-0001", cursor: first.payload.nextCursor }, ctx, { env: {} }),
      refused("invalid-source-cursor")
    );
    assert.throws(() => readSource({ id: "REQ-0001" }, ctx, { env: {} }), refused("not-source"));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("source reads refuse a normalized payload that is no longer a regular file", async () => {
  const base = mkdtempSync(join(tmpdir(), "kiln-source-read-boundary-"));
  const contentRoot = join(base, "planning-content");
  const payloadDir = join(contentRoot, "sources", "SRC-0001");
  mkdirSync(payloadDir, { recursive: true });
  const payloadPath = join(payloadDir, "content.md");
  writeFileSync(payloadPath, "Safe at creation.\n");
  const schemas = loadSchemaSet(SCHEMAS);
  const validators = createValidators(SCHEMAS);
  try {
    await createSource({
      title: "Imported notes",
      sourceKind: "text",
      relationship: "project-manager-input",
      origin: { kind: "upload", filename: "notes.txt" },
      integrity: { sha256: "b".repeat(64), bytes: 18, mediaType: "text/plain" },
      derivedPayload: { format: "markdown", path: "sources/SRC-0001/content.md" },
      processor: { id: "text/deterministic" },
    }, { contentRoot, schemasDir: SCHEMAS, schemas, validators });
    rmSync(payloadPath);
    mkdirSync(payloadPath);
    assert.throws(
      () => readSource({ id: "SRC-0001" }, { contentRoot, schemas, validators, activated: ["source"] }, { env: {} }),
      refused("source-payload-refused")
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
