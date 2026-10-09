import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { dirname, join } from "../runtime-path.mjs";
import { fileURLToPath } from "node:url";

import { atomicCreate, atomicWrite } from "../atomic-write.mjs";
import { resolveInContentRoot } from "../content-root.mjs";
import { allocateId } from "../id-allocator.mjs";
import { artifactRelPath } from "../layout.mjs";
import { withLock } from "../lock.mjs";
import { loadSchemaSet, typePrefixes } from "../schema-resolver.mjs";
import { createValidators, assertValid, ValidationError } from "../validate.mjs";
import { SCHEMA_VERSION, LOCK_FILE } from "../tools/create-artifact.mjs";
import { DEFAULT_LIMITS } from "./store.mjs";
import { INGEST_ERROR, IngestError } from "./result.mjs";

const DEFAULT_SCHEMAS = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "schemas");
const NORMALIZED_NAME = /^(?:content|transcript|extracted)\.md$/;

/**
 * Create one source and its normalized payload under the content lock.
 *
 * The payload is published before the artifact, so a crash may leave an unreferenced file but can
 * never leave a source artifact pointing at a partial or absent payload. The artifact is the commit
 * point and remains the only object the normal reader treats as planning state.
 */
export async function createSourceFromNormalized(input, opts = {}) {
  const { normalized = {}, ...fields } = input ?? {};
  const { content, filename = "content.md" } = normalized;
  if (typeof content !== "string" || content.length === 0)
    throw new IngestError(INGEST_ERROR.NORMALIZATION_FAILED, "A normalized source payload must contain text.");
  if (!NORMALIZED_NAME.test(filename))
    throw new IngestError(INGEST_ERROR.NORMALIZATION_FAILED, "The normalized source filename is not approved.");
  const maxBytes = opts.limits?.maxNormalizedBytes ?? DEFAULT_LIMITS.maxNormalizedBytes;
  if (Buffer.byteLength(content, "utf-8") > maxBytes)
    throw new IngestError(INGEST_ERROR.NORMALIZATION_FAILED, `The normalized source exceeds the configured ${maxBytes}-byte limit.`);

  const contentRoot = opts.contentRoot;
  if (!contentRoot) throw new IngestError(INGEST_ERROR.STORAGE_FAILED, "A planning content root is required.");
  const schemasDir = opts.schemasDir ?? DEFAULT_SCHEMAS;
  const schemas = opts.schemas ?? loadSchemaSet(schemasDir);
  const validators = opts.validators ?? createValidators(schemasDir);
  const prefix = typePrefixes(schemas).source;
  if (prefix !== "SRC") throw new ValidationError("The source artifact prefix is not registered as SRC.", []);

  return withLock(join(contentRoot, LOCK_FILE), async () => {
    const id = await allocateId(contentRoot, prefix);
    const relativePayload = `sources/${id}/${filename}`;
    const artifact = {
      id,
      type: "source",
      schemaVersion: SCHEMA_VERSION,
      reviewStatus: "draft",
      lifecycle: "active",
      ...fields,
      derivedPayload: { format: "markdown", path: relativePayload },
    };
    assertValid(validators, "source", artifact, "assembled source");

    const artifactPath = resolveInContentRoot(artifactRelPath("source", id), { contentRoot });
    const payloadPath = resolveInContentRoot(relativePayload, { contentRoot });
    if (existsSync(artifactPath) || existsSync(payloadPath))
      throw new ValidationError(`${id} already has planning content; refusing to overwrite it.`, []);

    mkdirSync(dirname(payloadPath), { recursive: true });
    mkdirSync(dirname(artifactPath), { recursive: true });
    await atomicCreate(payloadPath, content);
    try {
      await atomicWrite(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`);
    } catch (error) {
      try {
        unlinkSync(payloadPath);
      } catch {}
      throw error;
    }
    return { id, path: artifactRelPath("source", id), artifact, payloadPath: relativePayload };
  });
}
