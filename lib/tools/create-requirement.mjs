/**
 * The first typed tool (#13, #66) — creating a `requirement`.
 *
 * The whole point of a typed tool is that the agent cannot freehand an artifact into
 * existence. This is also the first place four decisions have to compose rather than work
 * individually: #70 (one resolver) + #72 (atomic write) + #78 (short-lived lock) +
 * #83 (ID allocation).
 *
 * The sequence, and every step in it earns its place:
 *
 *   validate caller-supplied fields        <- before consuming an ID
 *     acquire #78 lock
 *     #83 allocate + persist the counter
 *     assemble the complete artifact
 *     validate the COMPLETE artifact       <- including everything the tool injected
 *     resolve the destination under #70
 *     refuse if the destination exists     <- defends against abnormal counter state
 *     #72 atomic temp + rename
 *   release lock (always, including on throw)
 *
 * Two validations at two boundaries. The first checks what the model supplied before an ID
 * is consumed. The second checks the object actually being persisted — id, type,
 * schemaVersion, reviewStatus, lifecycle, all injected here. Without it the typed tool is
 * the one actor in the system capable of writing schema-invalid content.
 *
 * There is deliberately NO rollback of the high-water mark on failure (#83): a gap is safe,
 * reuse is not.
 */

import { existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveContentRoot, resolveInContentRoot } from "../content-root.mjs";
import { withLock } from "../lock.mjs";
import { allocateId } from "../id-allocator.mjs";
import { atomicWrite } from "../atomic-write.mjs";
import { createValidators, assertValid, ValidationError } from "../validate.mjs";

export const LOCK_FILE = ".planning.lock";
export const ARTIFACT_DIR = "data/requirements";
export const SCHEMA_VERSION = 1;

export class ArtifactExistsError extends Error {
  constructor(message) {
    super(message);
    this.name = "ArtifactExistsError";
  }
}

/** Fields the caller may supply. Anything else is the tool's to inject or the schema's to reject. */
const CALLER_FIELDS = new Set([
  "title", "statement", "rationale", "priority",
  "derivedFrom", "boundedBy", "verifiedBy", "evidencedBy", "openQuestions",
  "tags", "notes",
]);

export function artifactPath(id) {
  return `${ARTIFACT_DIR}/${id}.json`;
}

/**
 * @param {object} input caller-supplied requirement fields
 * @param {{contentRoot?: string, schemasDir?: string, validators?: object, env?: NodeJS.ProcessEnv}} [opts]
 * @returns {Promise<{id: string, path: string, artifact: object}>}
 */
export async function createRequirement(input, opts = {}) {
  const contentRoot = opts.contentRoot ?? resolveContentRoot(opts.env);
  const schemasDir = opts.schemasDir ?? join(dirname(fileURLToPath(import.meta.url)), "..", "..", "schemas");
  const validators = opts.validators ?? createValidators(schemasDir);

  // ---- boundary 1: what the caller supplied, before an ID is consumed -------------------
  if (input === null || typeof input !== "object" || Array.isArray(input))
    throw new ValidationError("Requirement input must be an object.", []);

  const unknown = Object.keys(input).filter((k) => !CALLER_FIELDS.has(k));
  if (unknown.length)
    throw new ValidationError(
      `Fields the tool owns cannot be supplied by the caller: ${unknown.join(", ")}. ` +
        `id, type, schemaVersion, reviewStatus and lifecycle are injected (#82, #83).`,
      []
    );

  // Validate the caller's half against the real schema by standing in a placeholder envelope,
  // so the model gets schema-accurate feedback WITHOUT an ID being allocated first.
  assertValid(validators, "requirement", withEnvelope(input, "REQ-0000"), "requirement input");

  // ---- inside the lock ------------------------------------------------------------------
  return withLock(join(contentRoot, LOCK_FILE), async () => {
    const id = await allocateId(contentRoot, "REQ"); // persists the counter before returning

    const artifact = withEnvelope(input, id);

    // ---- boundary 2: the complete object actually being persisted ------------------------
    assertValid(validators, "requirement", artifact, "assembled requirement");

    const rel = artifactPath(id);
    const dest = resolveInContentRoot(rel, { contentRoot });

    // Defends against abnormal counter state — a reverted, corrupted or hand-edited
    // .ids.json. Under normal operation #83 makes this impossible; when it is not
    // impossible, this must be a loud invariant failure and never a silent overwrite.
    if (existsSync(dest))
      throw new ArtifactExistsError(
        `${id} already exists at ${dest}, but the ID allocator issued it as new. ` +
          `The high-water mark in .ids.json is behind the content — refusing to overwrite (#83).`
      );

    mkdirSync(dirname(dest), { recursive: true });
    await atomicWrite(dest, JSON.stringify(artifact, null, 2) + "\n");

    return { id, path: rel, artifact };
  });
}

function withEnvelope(input, id) {
  return {
    id,
    type: "requirement",
    schemaVersion: SCHEMA_VERSION,
    reviewStatus: "draft",
    lifecycle: "active",
    ...input,
  };
}
