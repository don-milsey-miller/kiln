import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { blobPath, ingestPaths, resolveInIngestRoot, storeBlob } from "../lib/ingest/store.mjs";
import { INGEST_ERROR, IngestError } from "../lib/ingest/result.mjs";

const made = [];
process.on("exit", () => made.forEach((path) => rmSync(path, { recursive: true, force: true })));

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "kiln-ingest-store-"));
  made.push(root);
  const contentRoot = join(root, "planning-content");
  mkdirSync(contentRoot);
  return { root, contentRoot };
}

test("raw objects are SHA-256-addressed outside planning content and identical bytes deduplicate", async () => {
  const fx = fixture();
  const first = await storeBlob(Buffer.from("same bytes"), { contentRoot: fx.contentRoot });
  const second = await storeBlob(Buffer.from("same bytes"), { contentRoot: fx.contentRoot });

  assert.equal(first.sha256, second.sha256);
  assert.equal(first.deduplicated, false);
  assert.equal(second.deduplicated, true);
  assert.equal(blobPath(first.sha256, { contentRoot: fx.contentRoot }), first.path);
  assert.deepEqual(readdirSync(ingestPaths({ contentRoot: fx.contentRoot }).blobs), [first.sha256]);
  assert.ok(!first.path.startsWith(fx.contentRoot), "raw bytes must not live beneath planning-content");
});

test("the byte limit is enforced while consuming and leaves no partial blob or work file", async () => {
  const fx = fixture();
  async function* chunks() {
    yield Buffer.alloc(4, 1);
    yield Buffer.alloc(4, 2);
  }
  await assert.rejects(
    () => storeBlob(chunks(), { contentRoot: fx.contentRoot, maxBytes: 7 }),
    (error) => error instanceof IngestError && error.code === INGEST_ERROR.FILE_TOO_LARGE
  );
  const paths = ingestPaths({ contentRoot: fx.contentRoot });
  assert.deepEqual(readdirSync(paths.blobs), []);
  assert.deepEqual(readdirSync(paths.work), []);
});

test("ingest paths cannot escape the approved local root", () => {
  const fx = fixture();
  for (const hostile of ["../outside", "jobs/../../outside", "C:\\outside", "/outside"])
    assert.throws(() => resolveInIngestRoot(hostile, { contentRoot: fx.contentRoot }), IngestError);
});
