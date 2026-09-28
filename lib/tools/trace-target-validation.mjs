/**
 * Validate trace targets before a write enters the artifact graph.
 *
 * JSON Schema owns the shape of a trace field. This module owns the cross-file facts that JSON
 * Schema cannot establish: the ID names an artifact type allowed by `x-traceTarget`, and that
 * artifact exists. Creation and later linking deliberately call the same function so their
 * acceptance rules cannot diverge.
 */

import { existsSync } from "node:fs";

import { resolveInContentRoot } from "../content-root.mjs";
import { artifactRelPath } from "../layout.mjs";
import { effectiveSchema, typeOfId } from "../schema-resolver.mjs";
import { ValidationError } from "../validate.mjs";

/**
 * Validate every supplied field whose effective schema declares `x-traceTarget`.
 * Call this while holding the planning-content lock whenever a write follows it.
 */
export function validateTraceTargets(type, artifact, { schemas, contentRoot }) {
  const properties = effectiveSchema(schemas, type).properties;

  for (const [field, prop] of Object.entries(properties)) {
    const allowed = prop["x-traceTarget"];
    if (!Array.isArray(allowed) || artifact[field] === undefined) continue;

    for (const ref of artifact[field]) {
      const refType = typeOfId(schemas, ref);
      if (!refType) throw new ValidationError(`\`${ref}\` is not an artifact ID.`, []);
      if (!allowed.includes(refType))
        throw new ValidationError(
          `\`${type}.${field}\` expects ${allowed.join(" or ")}, but \`${ref}\` is ${refType}.`,
          []
        );

      const refPath = resolveInContentRoot(artifactRelPath(refType, ref), { contentRoot });
      if (!existsSync(refPath))
        throw new ValidationError(
          `\`${type}.${field}\` references \`${ref}\`, but that ${refType} does not exist.`,
          []
        );
    }
  }
}
