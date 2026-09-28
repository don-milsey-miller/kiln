import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Ajv2020 from "ajv/dist/2020.js";

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

/** Create a canonical JSON Schema payload beneath planning-content without overwriting a file. */
export async function writePayload({ format, path, content }, opts = {}) {
  if (format !== "json-schema") throw new PayloadValidationError(`Unsupported payload format: ${JSON.stringify(format)}.`);
  if (typeof path !== "string" || !path.endsWith(".schema.json"))
    throw new PayloadValidationError("A JSON Schema payload path must end with .schema.json.");
  if (content === null || Array.isArray(content) || typeof content !== "object")
    throw new PayloadValidationError("A JSON Schema payload must be a JSON object.");
  try {
    if (!schemaValidator.validateSchema(content))
      throw new PayloadValidationError(`Invalid JSON Schema: ${schemaValidator.errorsText(schemaValidator.errors)}.`);
  } catch (e) {
    if (e instanceof PayloadValidationError) throw e;
    throw new PayloadValidationError(`Invalid JSON Schema: ${e?.message ?? String(e)}.`);
  }

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
  return { format, path, absolutePath: target };
}
