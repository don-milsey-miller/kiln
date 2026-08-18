/**
 * Validation — deliberately separate from #84's resolution layer.
 *
 * Validation asks "is this document legal". Resolution asks "what does the schema say about
 * this field". #84 keeps them distinct because conflating them produces a layer that answers
 * the easy question and leaves every consumer to walk composition for the hard one.
 *
 * Ajv's 2020-12 dialect, matching #82's explicitly chosen dialect.
 */

import Ajv from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

export class ValidationError extends Error {
  /** @param {string} message @param {Array<object>} errors */
  constructor(message, errors) {
    super(message);
    this.name = "ValidationError";
    this.errors = errors;
  }
}

const DIALECT = "https://json-schema.org/draft/2020-12/schema";

/** Build a validator set from a schemas directory. */
export function createValidators(schemasDir) {
  const files = readdirSync(schemasDir).filter((f) => f.endsWith(".schema.json"));
  const docs = Object.fromEntries(files.map((f) => [f, JSON.parse(readFileSync(join(schemasDir, f), "utf-8"))]));

  for (const [f, s] of Object.entries(docs))
    if (s.$schema !== DIALECT)
      throw new Error(`${f} declares $schema ${JSON.stringify(s.$schema)}; #82 fixes the dialect at ${DIALECT}.`);

  const ajv = new Ajv({ strict: false, allErrors: true });
  addFormats(ajv);
  ajv.addSchema(docs["common.schema.json"], "common.schema.json");

  const compiled = {};
  for (const [f, s] of Object.entries(docs)) {
    if (f === "common.schema.json") continue;
    compiled[s["x-artifactType"]] = ajv.compile(s);
  }
  return compiled;
}

/** Format Ajv errors into something a model or a human can act on. */
export function formatErrors(errors) {
  return (errors ?? [])
    .map((e) => `${e.instancePath || "(root)"} ${e.message}${e.params?.additionalProperty ? ` (${e.params.additionalProperty})` : ""}${e.params?.unevaluatedProperty ? ` (${e.params.unevaluatedProperty})` : ""}`)
    .join("; ");
}

/** Throw ValidationError unless `doc` is a legal artifact of `type`. */
export function assertValid(validators, type, doc, what = "artifact") {
  const v = validators[type];
  if (!v) throw new ValidationError(`No schema for artifact type ${JSON.stringify(type)}`, []);
  if (!v(doc)) throw new ValidationError(`Invalid ${what} (${type}): ${formatErrors(v.errors)}`, v.errors ?? []);
  return doc;
}
