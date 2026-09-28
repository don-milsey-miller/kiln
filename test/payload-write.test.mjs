import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { installReaper, reapLater } from "./helpers/reap.mjs";
import { PayloadExistsError, PayloadValidationError, writePayload } from "../lib/payload-write.mjs";
import { PathEscapeError } from "../lib/content-root.mjs";

installReaper();

const root = () => {
  const contentRoot = join(reapLater(mkdtempSync(join(tmpdir(), "kiln-payload-"))), "planning-content");
  mkdirSync(contentRoot, { recursive: true });
  return contentRoot;
};

const schema = { $schema: "https://json-schema.org/draft/2020-12/schema", type: "object", properties: { title: { type: "string" } }, required: ["title"] };

test("writePayload creates a formatted canonical JSON Schema and its parents", async () => {
  const contentRoot = root();
  const result = await writePayload({ format: "json-schema", path: "payloads/todo/task.schema.json", content: schema }, { contentRoot });

  assert.equal(result.path, "payloads/todo/task.schema.json");
  assert.deepEqual(JSON.parse(readFileSync(join(contentRoot, result.path), "utf-8")), schema);
  assert.equal(readFileSync(join(contentRoot, result.path), "utf-8").endsWith("\n"), true);
  assert.deepEqual(readdirSync(join(contentRoot, "payloads", "todo")), ["task.schema.json"]);
});

test("writePayload refuses invalid schemas, escaping paths, and unsupported names", async () => {
  const contentRoot = root();
  await assert.rejects(writePayload({ format: "json-schema", path: "payloads/bad.schema.json", content: { type: 17 } }, { contentRoot }), PayloadValidationError);
  await assert.rejects(writePayload({ format: "yaml", path: "payloads/bad.schema.json", content: schema }, { contentRoot }), PayloadValidationError);
  await assert.rejects(writePayload({ format: "json-schema", path: "payloads/bad.json", content: schema }, { contentRoot }), PayloadValidationError);
  await assert.rejects(writePayload({ format: "json-schema", path: "../bad.schema.json", content: schema }, { contentRoot }), PathEscapeError);
  assert.equal(existsSync(join(contentRoot, "payloads")), false, "a refused payload created directories");
});

test("writePayload never overwrites an existing payload or leaves a temporary file", async () => {
  const contentRoot = root();
  const path = join(contentRoot, "payloads", "task.schema.json");
  mkdirSync(join(contentRoot, "payloads"));
  writeFileSync(path, "original\n");

  await assert.rejects(writePayload({ format: "json-schema", path: "payloads/task.schema.json", content: schema }, { contentRoot }), PayloadExistsError);
  assert.equal(readFileSync(path, "utf-8"), "original\n");
  assert.deepEqual(readdirSync(join(contentRoot, "payloads")), ["task.schema.json"]);
});
