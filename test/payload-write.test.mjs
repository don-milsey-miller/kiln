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
const openapi = (version) => ({ openapi: version, info: { title: "Dock API", version: "1.0.0" }, paths: {} });

test("writePayload creates a formatted canonical JSON Schema and its parents", async () => {
  const contentRoot = root();
  const result = await writePayload({ format: "json-schema", path: "payloads/todo/task.schema.json", content: schema }, { contentRoot });

  assert.equal(result.path, "payloads/todo/task.schema.json");
  assert.deepEqual(JSON.parse(readFileSync(join(contentRoot, result.path), "utf-8")), schema);
  assert.equal(readFileSync(join(contentRoot, result.path), "utf-8").endsWith("\n"), true);
  assert.deepEqual(readdirSync(join(contentRoot, "payloads", "todo")), ["task.schema.json"]);
  assert.deepEqual(result.reference, { format: "json-schema", path: "payloads/todo/task.schema.json" });
  assert.equal(result.writeMode, "create-only");
});

test("writePayload validates and creates OpenAPI 3.0 and 3.1 JSON with directly reusable references", async () => {
  for (const [format, version] of [["openapi-3.0", "3.0.3"], ["openapi-3.1", "3.1.0"]]) {
    const contentRoot = root();
    const path = `payloads/dock-${version}.openapi.json`;
    const result = await writePayload({ format, path, content: openapi(version) }, { contentRoot });
    assert.deepEqual(result.reference, { format, path });
    assert.equal(result.writeMode, "create-only");
    assert.deepEqual(JSON.parse(readFileSync(join(contentRoot, path), "utf8")), openapi(version));
  }
});

test("writePayload rejects malformed, mismatched, non-JSON and unsupported OpenAPI before publication", async () => {
  const contentRoot = root();
  let writes = 0;
  const opts = { contentRoot, createFile: async () => { writes += 1; } };
  await assert.rejects(writePayload({ format: "openapi-3.1", path: "payloads/malformed.json", content: { openapi: "3.1.0" } }, opts), PayloadValidationError);
  await assert.rejects(writePayload({ format: "openapi-3.0", path: "payloads/mismatch.json", content: openapi("3.1.0") }, opts), PayloadValidationError);
  await assert.rejects(writePayload({ format: "openapi-3.1", path: "payloads/not-json.yaml", content: openapi("3.1.0") }, opts), PayloadValidationError);
  await assert.rejects(writePayload({ format: "openapi-2.0", path: "payloads/unsupported.json", content: openapi("3.0.3") }, opts), PayloadValidationError);
  assert.equal(writes, 0, "validation reached publication");
  assert.equal(existsSync(join(contentRoot, "payloads")), false);
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
