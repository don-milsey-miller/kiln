import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import { Validator as OpenApiValidator } from "@seriousme/openapi-schema-validator";

import { ATOMIC_WRITE_REFUSAL, atomicCreate } from "./atomic-write.mjs";
import { resolveInContentRoot } from "./content-root.mjs";

/** How many of the validator's errors are returned. How many it raised in all is returned beside these. */
export const PAYLOAD_ERRORS_SHOWN = 5;
/** The most of an error's location that is returned, in characters. */
export const PAYLOAD_POINTER_MAX = 200;

/**
 * A payload that is not what its format says it is.
 *
 * ⚠️ **BOUNDED, AND IN KILN'S WORDS (#180).** A large schema with one mistake repeated can produce hundreds of
 * validator errors, and the validator's own text quotes the payload. So `errors` is the first few as a location, a
 * rule and one fixed sentence, and `errorCount` is how many there were. Nothing here grows with the payload.
 */
export class PayloadValidationError extends Error {
  constructor(message, { errors = null, errorCount = null } = {}) {
    super(message);
    this.name = "PayloadValidationError";
    this.errors = errors;
    this.errorCount = errorCount;
    this.path = null;
  }
}

export class PayloadExistsError extends Error {
  constructor(message) {
    super(message);
    this.name = "PayloadExistsError";
    this.path = null;
  }
}

/** Why a valid payload was not written. Each of these leaves no payload file and no temporary file. */
export const PAYLOAD_WRITE_REFUSAL = Object.freeze({ CANCELLED: "payload-write-cancelled", FAILED: "payload-write-failed" });

const WRITE_REFUSALS = Object.freeze({
  [PAYLOAD_WRITE_REFUSAL.CANCELLED]: ["The write was cancelled before the payload was created. Nothing was written.", "Retry only if the operator asks for it."],
  [PAYLOAD_WRITE_REFUSAL.FAILED]: ["The payload file could not be created. Nothing was written.", "Tell the operator. Do not retry in a loop."],
});

/**
 * A valid payload that could not be written - #180.
 *
 * ⚠️ **A CODE AND FIXED WORDS.** The filesystem's own error names an absolute path and carries its own code, and
 * neither is kept on the message. `cause` holds it for a developer and is never returned to a model.
 */
export class PayloadWriteError extends Error {
  constructor(code, { cause } = {}) {
    super(WRITE_REFUSALS[code][0], { cause });
    this.name = "PayloadWriteError";
    this.code = code;
    this.retry = WRITE_REFUSALS[code][1];
    this.path = null;
  }
}

const schemaValidator = new Ajv2020({ allErrors: true, strict: false, validateSchema: true });
const OPENAPI_VERSION = Object.freeze({ "openapi-3.0": "3.0", "openapi-3.1": "3.1" });

/**
 * The path as it may be returned: content-relative, forward slashes, and nothing that climbs or is absolute.
 * `null` for anything else, so a path that was refused for where it points is never echoed back.
 */
export function relativePayloadPath(path) {
  if (typeof path !== "string" || path.length === 0 || path.length > 512) return null;
  const normalised = path.split("\\").join("/");
  if (/^(?:[A-Za-z]:|\/)/.test(normalised) || normalised.split("/").some((part) => part === ".." || part === "")) return null;
  return normalised;
}

/**
 * The validator's errors as a bounded list: where, which rule, and one fixed sentence.
 *
 * `errorCount` is every error the validator raised, and `errors` is the first few of those, in its order. One
 * mistake can raise several, for the several rules it breaks at the same place. They are counted as raised and not
 * merged, so the count is the validator's own.
 */
function boundedErrors(raw) {
  const all = Array.isArray(raw) ? raw : [];
  const errors = all.slice(0, PAYLOAD_ERRORS_SHOWN).map((error) => {
    const pointer = typeof error?.instancePath === "string" ? error.instancePath : "";
    const rule = typeof error?.keyword === "string" && /^[A-Za-z$][A-Za-z0-9$]{0,39}$/.test(error.keyword) ? error.keyword : "unknown";
    return {
      instancePath: pointer.length > PAYLOAD_POINTER_MAX ? `${pointer.slice(0, PAYLOAD_POINTER_MAX)}…` : pointer,
      rule,
      message: `The value here breaks the JSON Schema rule "${rule}".`,
    };
  });
  return { errors, errorCount: all.length };
}

async function validateContent(format, path, content) {
  if (content === null || Array.isArray(content) || typeof content !== "object")
    throw new PayloadValidationError("A canonical payload must be a JSON object.");

  if (format === "json-schema") {
    if (!path.endsWith(".schema.json")) throw new PayloadValidationError("A JSON Schema payload path must end with .schema.json.");
    let valid;
    try {
      valid = schemaValidator.validateSchema(content);
    } catch {
      // The validator's own text for this quotes the payload. What it means is fixed.
      throw new PayloadValidationError("Invalid JSON Schema: it could not be checked against the dialect its $schema names.");
    }
    if (!valid) {
      const bounded = boundedErrors(schemaValidator.errors);
      throw new PayloadValidationError(`Invalid JSON Schema: ${bounded.errorCount} error${bounded.errorCount === 1 ? "" : "s"}. The first ${bounded.errors.length} ${bounded.errors.length === 1 ? "is" : "are"} in \`errors\`.`, bounded);
    }
    return;
  }

  const expected = OPENAPI_VERSION[format];
  if (!expected) throw new PayloadValidationError("Unsupported payload format. Use json-schema, openapi-3.0 or openapi-3.1.");
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
    throw new PayloadValidationError(`The document is OpenAPI ${OPENAPI_VERSION[`openapi-${validator.version}`] ?? "of another version"}, not the declared ${expected} format.`);
}

/**
 * Create a validated canonical JSON payload beneath planning-content without overwriting a file.
 *
 * ⚠️ **NO LOCK, AND NONE NEEDED.** The payload becomes visible through an exclusive hard link: it is created whole or
 * not at all, and a second writer of the same path is refused.
 *
 * ⚠️ **`opts.signal` CANCELS UP TO THAT LINK (#180).** It is looked at before validation, before any directory is
 * made, and inside the create up to its commit point. After the link the payload exists and this returns it.
 * Nothing races the write from outside.
 *
 * Every error this throws carries `path`: the content-relative path, or `null` when it is not one to repeat.
 */
export async function writePayload({ format, path, content }, opts = {}) {
  const signal = opts.signal ?? null;
  const relative = relativePayloadPath(path);
  const tagged = (error) => Object.assign(error, { path: relative });
  const cancelledIfAborted = () => {
    if (signal?.aborted) throw tagged(new PayloadWriteError(PAYLOAD_WRITE_REFUSAL.CANCELLED));
  };

  if (typeof path !== "string") throw new PayloadValidationError("A canonical payload needs a content-relative JSON path.");
  cancelledIfAborted();
  try {
    await validateContent(format, path, content);
  } catch (e) {
    throw e instanceof PayloadValidationError ? tagged(e) : e;
  }
  cancelledIfAborted();

  let target = resolveInContentRoot(path, opts);
  try {
    mkdirSync(dirname(target), { recursive: true });
  } catch (cause) {
    throw tagged(new PayloadWriteError(PAYLOAD_WRITE_REFUSAL.FAILED, { cause }));
  }
  // Re-resolve after creating parents so a filesystem alias cannot bypass the containment check.
  target = resolveInContentRoot(path, opts);

  try {
    await (opts.createFile ?? atomicCreate)(target, `${JSON.stringify(content, null, 2)}\n`, { signal });
  } catch (e) {
    if (e?.cause?.code === "EEXIST" || e?.code === "EEXIST") throw tagged(new PayloadExistsError(`Payload already exists: ${relative ?? "that path"}.`));
    if (e?.code === ATOMIC_WRITE_REFUSAL.CANCELLED) throw tagged(new PayloadWriteError(PAYLOAD_WRITE_REFUSAL.CANCELLED, { cause: e }));
    throw tagged(new PayloadWriteError(PAYLOAD_WRITE_REFUSAL.FAILED, { cause: e }));
  }
  return { format, path, reference: { format, path }, writeMode: "create-only", absolutePath: target };
}
