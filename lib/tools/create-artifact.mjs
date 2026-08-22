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
import { allocateId } from "../id-allocator.mjs";
import { atomicWrite } from "../atomic-write.mjs";
import { createValidators, assertValid, ValidationError } from "../validate.mjs";
import { artifactRelPath } from "../layout.mjs";
import { typePrefixes, loadSchemaSet } from "../schema-resolver.mjs";

export const LOCK_FILE = ".planning.lock";
export const SCHEMA_VERSION = 2; // bumped 2026-08-22 by #131's environment reshape (#50)

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
    const id = await allocateId(contentRoot, prefix);
    const artifact = envelope(input, id, type);

    // ---- boundary 2: the complete object being persisted ----------------------------------
    assertValid(validators, type, artifact, `assembled ${type}`);

    const rel = artifactRelPath(type, id);
    const dest = resolveInContentRoot(rel, { contentRoot });

    if (existsSync(dest))
      throw new ArtifactExistsError(
        `${id} already exists at ${dest}, but the allocator issued it as new. ` +
          `The high-water mark is behind the content — refusing to overwrite (#83).`
      );

    mkdirSync(dirname(dest), { recursive: true });
    await atomicWrite(dest, JSON.stringify(artifact, null, 2) + "\n");
    return { id, path: rel, artifact };
  });
}

function envelope(input, id, type) {
  return { id, type, schemaVersion: SCHEMA_VERSION, reviewStatus: "draft", lifecycle: "active", ...input };
}
