#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { atomicWrite } from "../lib/atomic-write.mjs";
import { loadSchemaSet } from "../lib/schema-resolver.mjs";
import { buildArtifactAuthoringSchemas } from "../lib/tools/artifact-authoring.mjs";

const ROOT = join(import.meta.dirname, "..");
const DESTINATION = join(ROOT, "pi-package", "artifact-authoring-schemas.json");
const expected = JSON.stringify(buildArtifactAuthoringSchemas(loadSchemaSet(join(ROOT, "schemas"))), null, 2) + "\n";
const check = process.argv.includes("--check");

if (check) {
  if (!existsSync(DESTINATION) || readFileSync(DESTINATION, "utf-8") !== expected) {
    console.error("pi-package/artifact-authoring-schemas.json is stale; run npm run authoring-schemas:generate.");
    process.exitCode = 1;
  }
} else {
  await atomicWrite(DESTINATION, expected);
}
