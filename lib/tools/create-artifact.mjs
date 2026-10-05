/**
 * #88's create contract, once, for every type.
 *
 *   validate caller fields → #78 lock → #83 allocate+persist → assemble
 *     → validate the COMPLETE artifact → resolve destination (#70)
 *     → refuse if it exists → #72 atomic write → release (always)
 *
 * Extracted when the second type needed it. Four copies of a contract with two validation
 * boundaries and a no-overwrite invariant is four chances for one of them to lose a step —
 * and the step most likely to be lost is the second validation, which is the one that stops
 * the typed tool being the only actor able to write schema-invalid content.
 *
 * ⚠️ Each type declares which fields a CALLER may supply. Everything else is either injected
 * here or refused. That list is where #96's split is enforced at the input boundary: an
 * assertion tool that accepted `confidence` would re-create the stored value the derivation
 * exists to replace, and it would look like a convenience.
 */

import { existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveContentRoot, resolveInContentRoot } from "../content-root.mjs";
import { withLock } from "../lock.mjs";
import { allocateId, readHighWaterMarks, AllocationError } from "../id-allocator.mjs";
import { atomicWrite } from "../atomic-write.mjs";
import { createValidators, assertValid, ValidationError } from "../validate.mjs";
import { artifactRelPath } from "../layout.mjs";
import { typePrefixes, loadSchemaSet } from "../schema-resolver.mjs";
import { SCHEMA_VERSION } from "../content-version.mjs";
import { validateTraceTargets } from "./trace-target-validation.mjs";

export const LOCK_FILE = ".planning.lock";
// ⚠️ Re-exported, not defined. The version is the PROJECT's (#50) and the lint has to read it too;
// two modules each declaring "the version we write" is how the manifest and the authoring tool came
// to disagree in the first place.
export { SCHEMA_VERSION };

export class ArtifactExistsError extends Error {
  constructor(message) {
    super(message);
    this.name = "ArtifactExistsError";
  }
}

const DEFAULT_SCHEMAS = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "schemas");

/**
 * @param {string} type          artifact type, as in #38
 * @param {Set<string>} callerFields fields a caller may supply
 * @param {object} input
 * @param {object} [opts]
 *   `lock` is passed to `withLock`, so a caller already holding this lock can say so (`reuseHeld`).
 *   `reservedId` creates under an ID the caller already consumed with `reserveId`, instead of allocating.
 *   `assumeExisting` names reserved ids the same lock hold will create (see `validateTraceTargets`).
 *   `dryRun` runs every check and writes nothing; the result says whether the destination `exists`.
 */
export async function createArtifact(type, callerFields, input, opts = {}) {
  const contentRoot = opts.contentRoot ?? resolveContentRoot(opts.env);
  const schemasDir = opts.schemasDir ?? DEFAULT_SCHEMAS;
  const validators = opts.validators ?? createValidators(schemasDir);
  const schemas = opts.schemas ?? loadSchemaSet(schemasDir);
  const prefix = typePrefixes(schemas)[type];
  if (!prefix) throw new ValidationError(`No ID prefix for artifact type ${JSON.stringify(type)} (#82).`, []);

  // ---- boundary 1: the caller's fields, before an ID is consumed -------------------------
  if (input === null || typeof input !== "object" || Array.isArray(input))
    throw new ValidationError(`${type} input must be an object.`, []);

  const unknown = Object.keys(input).filter((k) => !callerFields.has(k));
  if (unknown.length)
    throw new ValidationError(
      `Fields the tool owns cannot be supplied by the caller: ${unknown.join(", ")}. ` +
        `id, type, schemaVersion, reviewStatus and lifecycle are injected (#82, #83)` +
        (type === "assertion" ? `, and confidence/verdict are DERIVED, never stored (#96).` : `.`),
      []
    );

  assertValid(validators, type, envelope(input, `${prefix}-0000`, type), `${type} input`);

  // ---- inside the lock --------------------------------------------------------------------
  return withLock(join(contentRoot, LOCK_FILE), async () => {
    // JSON Schema validates trace ID shape, but not the referenced file or its artifact type.
    // Validate before allocation so a refused create neither writes an invalid graph nor burns an ID.
    validateTraceTargets(type, input, { schemas, contentRoot, assumeExisting: opts.assumeExisting });

    let id;
    if (opts.reservedId !== undefined) {
      id = opts.reservedId;
      const number = new RegExp(`^${prefix}-([0-9]{4,})$`).exec(id)?.[1];
      if (number === undefined) throw new ValidationError(`${JSON.stringify(id)} is not a ${type} ID.`, []);
      // ⚠️ A RESERVED ID IS ONE THE COUNTER HAS ALREADY PASSED. Writing above the mark would let the
      // next allocation issue the same ID (#83).
      if (!opts.dryRun && (readHighWaterMarks(contentRoot)[prefix] ?? 0) < Number(number))
        throw new AllocationError(`${id} is above the ${prefix} high-water mark, so it was never reserved (#83).`);
    } else {
      id = opts.dryRun ? `${prefix}-0000` : await allocateId(contentRoot, prefix);
    }
    const artifact = envelope(input, id, type);

    // ---- boundary 2: the complete object being persisted ----------------------------------
    assertValid(validators, type, artifact, `assembled ${type}`);

    const rel = artifactRelPath(type, id);
    const dest = resolveInContentRoot(rel, { contentRoot });

    if (opts.dryRun) return { id, path: rel, artifact, exists: existsSync(dest), dryRun: true };

    if (existsSync(dest))
      throw new ArtifactExistsError(
        `${id} already exists at ${dest}, but the allocator issued it as new. ` +
          `The high-water mark is behind the content — refusing to overwrite (#83).`
      );

    mkdirSync(dirname(dest), { recursive: true });
    await atomicWrite(dest, JSON.stringify(artifact, null, 2) + "\n");
    return { id, path: rel, artifact };
  }, opts.lock);
}

function envelope(input, id, type) {
  return { id, type, schemaVersion: SCHEMA_VERSION, reviewStatus: "draft", lifecycle: "active", ...input };
}
