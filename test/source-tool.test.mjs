import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createSource } from "../lib/tools/evidence-tools.mjs";
import { TYPED_TOOLS } from "../lib/tools/registry.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCHEMAS = join(ROOT, "schemas");
const made = [];
process.on("exit", () => made.forEach((path) => rmSync(path, { recursive: true, force: true })));

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "kiln-source-tool-"));
  made.push(root);
  const contentRoot = join(root, "planning-content");
  mkdirSync(join(contentRoot, "sources", "SRC-0001"), { recursive: true });
  writeFileSync(join(contentRoot, "sources", "SRC-0001", "content.md"), "normalized\n");
  return { contentRoot };
}

const input = {
  title: "Imported notes",
  sourceKind: "text",
  relationship: "project-manager-input",
  origin: { kind: "upload", filename: "notes.txt" },
  integrity: { sha256: "a".repeat(64), bytes: 11, mediaType: "text/plain" },
  derivedPayload: { format: "markdown", path: "sources/SRC-0001/content.md" },
  processor: { id: "text/deterministic" },
};

test("source is registered as a typed creation path and validates provenance", async () => {
  const fx = fixture();
  assert.equal(TYPED_TOOLS.source, createSource);
  const made = await createSource(input, { contentRoot: fx.contentRoot, schemasDir: SCHEMAS });
  assert.equal(made.id, "SRC-0001");
  assert.equal(made.artifact.type, "source");
});

test("typed source creation refuses a missing normalized payload", () => {
  const fx = fixture();
  assert.throws(
    () => createSource({ ...input, derivedPayload: { format: "markdown", path: "sources/SRC-9999/content.md" } }, { contentRoot: fx.contentRoot, schemasDir: SCHEMAS }),
    /does not exist/
  );
});
