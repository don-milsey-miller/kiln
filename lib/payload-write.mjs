import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import { Validator as OpenApiValidator } from "@seriousme/openapi-schema-validator";

import { atomicCreate } from "./atomic-write.mjs";
import { resolveInContentRoot } from "./content-root.mjs";

export class PayloadValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "PayloadValidationError";
  }
}

export class PayloadExistsError extends Error {
  constructor(message) {
    super(message);
    this.name = "PayloadExistsError";
  }
}

const schemaValidator = new Ajv2020({ allErrors: true, strict: false, validateSchema: true });
const OPENAPI_VERSION = Object.freeze({ "openapi-3.0": "3.0", "openapi-3.1": "3.1" });

async function validateContent(format, path, content) {
  if (content === null || Array.isArray(content) || typeof content !== "object")
    throw new PayloadValidationError("A canonical payload must be a JSON object.");

  if (format === "json-schema") {
    if (!path.endsWith(".schema.json")) throw new PayloadValidationError("A JSON Schema payload path must end with .schema.json.");
    try {
      if (!schemaValidator.validateSchema(content))
        throw new PayloadValidationError(`Invalid JSON Schema: ${schemaValidator.errorsText(schemaValidator.errors)}.`);
    } catch (e) {
      if (e instanceof PayloadValidationError) throw e;
      throw new PayloadValidationError(`Invalid JSON Schema: ${e?.message ?? String(e)}.`);
    }
    return;
  }

  const expected = OPENAPI_VERSION[format];
  if (!expected) throw new PayloadValidationError(`Unsupported payload format: ${JSON.stringify(format)}.`);
  if (!path.endsWith(".json")) throw new PayloadValidationError("An OpenAPI JSON payload path must end with .json.");
  const validator = new OpenApiValidator();
  let result;
  try {
    result = await validator.validate(content);
  } catch {
    throw new PayloadValidationError(`Invalid OpenAPI ${expected} document.`);
  }
  if (!result.valid) throw new PayloadValidationError(`Invalid OpenAPI ${expected} document.`);
  if (validator.version !== expected)
    throw new PayloadValidationError(`The document is OpenAPI ${validator.version ?? "unknown"}, not the declared ${expected} format.`);
}

/** Create a validated canonical JSON payload beneath planning-content without overwriting a file. */
export async function writePayload({ format, path, content }, opts = {}) {
  if (typeof path !== "string") throw new PayloadValidationError("A canonical payload needs a content-relative JSON path.");
  await validateContent(format, path, content);

  let target = resolveInContentRoot(path, opts);
  mkdirSync(dirname(target), { recursive: true });
  // Re-resolve after creating parents so a filesystem alias cannot bypass the containment check.
  target = resolveInContentRoot(path, opts);

  try {
    await (opts.createFile ?? atomicCreate)(target, `${JSON.stringify(content, null, 2)}\n`);
  } catch (e) {
    if (e?.cause?.code === "EEXIST" || e?.code === "EEXIST")
      throw new PayloadExistsError(`Payload already exists: ${path}.`);
    throw e;
  }
  return { format, path, reference: { format, path }, writeMode: "create-only", absolutePath: target };
}
