import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createIngestService } from "../lib/ingest/service.mjs";
import { ingestPaths, readJob } from "../lib/ingest/store.mjs";
import { createValidators, assertValid } from "../lib/validate.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCHEMAS = join(ROOT, "schemas");
const made = [];
process.on("exit", () => made.forEach((path) => rmSync(path, { recursive: true, force: true })));

function fixture({ activated = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), "kiln-ingest-service-"));
  made.push(root);
  const contentRoot = join(root, "planning-content");
  mkdirSync(contentRoot);
  writeFileSync(
    join(contentRoot, "project.yaml"),
    `schemaVersion: 2\ncapabilities:\n  artifactTypes:\n    activated: [${activated ? "source" : ""}]\n`
  );
  return { root, contentRoot };
}

test("plain text completes blob -> job -> processor -> payload -> valid SRC artifact", async () => {
  const fx = fixture();
  const service = createIngestService({ contentRoot: fx.contentRoot });
  const intake = await service.enqueue(
    {
      source: Buffer.from("Project intent\r\n\r\nKeep every statement.\r\n"),
      filename: "intent.txt",
      relationship: "project-manager-input",
    },
    { process: false }
  );

  assert.equal(intake.job.state, "queued");
  const completed = await service.processJob(intake.job.jobId);
  assert.equal(completed.state, "completed");
  assert.equal(completed.sourceId, "SRC-0001");

  const artifactPath = join(fx.contentRoot, "data", "sources", "SRC-0001.json");
  const artifact = JSON.parse(readFileSync(artifactPath, "utf-8"));
  assertValid(createValidators(SCHEMAS), "source", artifact, "created source");
  assert.equal(artifact.relationship, "project-manager-input");
  assert.equal(artifact.integrity.sha256, intake.blob.sha256);
  assert.ok(!JSON.stringify(artifact).includes(fx.root), "no absolute path may reach committed planning content");
  assert.equal(readFileSync(join(fx.contentRoot, artifact.derivedPayload.path), "utf-8"), "Project intent\n\nKeep every statement.\n");

  const local = ingestPaths({ contentRoot: fx.contentRoot });
  assert.ok(existsSync(join(local.blobs, intake.blob.sha256)));
  assert.equal(readJob(intake.job.jobId, { contentRoot: fx.contentRoot }).state, "completed");
});

test("duplicate bytes reuse one blob but preserve two intentional source imports", async () => {
  const fx = fixture();
  const service = createIngestService({ contentRoot: fx.contentRoot });
  const ids = [];
  for (const relationship of ["project-manager-input", "external-reference"]) {
    const queued = await service.enqueue(
      { source: Buffer.from("identical"), filename: "same.md", relationship },
      { process: false }
    );
    ids.push((await service.processJob(queued.job.jobId)).sourceId);
  }
  assert.deepEqual(ids, ["SRC-0001", "SRC-0002"]);
  assert.equal(readdirSync(ingestPaths({ contentRoot: fx.contentRoot }).blobs).length, 1);
  assert.equal(readdirSync(join(fx.contentRoot, "data", "sources")).length, 2);
});

test("missing source activation retains the blob and enters a retryable awaiting-user state", async () => {
  const fx = fixture({ activated: false });
  const service = createIngestService({ contentRoot: fx.contentRoot });
  const queued = await service.enqueue(
    { source: Buffer.from("retained"), filename: "retained.txt", relationship: "project-manager-input" },
    { process: false }
  );
  const result = await service.processJob(queued.job.jobId);
  assert.equal(result.state, "awaiting-user");
  assert.equal(result.error.code, "source-not-activated");
  assert.ok(existsSync(join(ingestPaths({ contentRoot: fx.contentRoot }).blobs, queued.blob.sha256)));
  assert.ok(!existsSync(join(fx.contentRoot, "data", "sources")));
});

test("unsupported binary input fails with a stable code and exposes no processor exception", async () => {
  const fx = fixture();
  const service = createIngestService({ contentRoot: fx.contentRoot });
  const queued = await service.enqueue(
    { source: Buffer.from([0, 1, 2, 3, 4]), filename: "unknown.bin", relationship: "external-reference" },
    { process: false }
  );
  const result = await service.processJob(queued.job.jobId);
  assert.deepEqual(result.error, { code: "unsupported-type" });
  assert.equal(result.state, "failed");
});

test("JSON is normalized deterministically as readable fenced Markdown", async () => {
  const fx = fixture();
  const service = createIngestService({ contentRoot: fx.contentRoot });
  const queued = await service.enqueue(
    { source: Buffer.from('{"b":2,"a":1}'), filename: "input.json", relationship: "external-reference" },
    { process: false }
  );
  const result = await service.processJob(queued.job.jobId);
  const artifact = JSON.parse(readFileSync(join(fx.contentRoot, "data", "sources", `${result.sourceId}.json`), "utf-8"));
  assert.equal(readFileSync(join(fx.contentRoot, artifact.derivedPayload.path), "utf-8"), '```json\n{\n  "b": 2,\n  "a": 1\n}\n```\n');
});
