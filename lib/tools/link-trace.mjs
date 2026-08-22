/**
 * Add or remove an ordinary trace edge — the operation every trace field except the evidence ones
 * has been missing.
 *
 * ⚠️ **Found by needing it, for the seventh time.** `TSK-0002` needed `acceptedBy` populated;
 * `reviseArtifact` refuses trace fields by design (#101), `linkEvidence` only knows
 * `supportedBy`/`refutedBy`, and #88 forbids the hand edit — so there was no legitimate way to link a
 * task to its acceptance criteria. The previous six were `setLifecycle` (#83), `unlinkEvidence`
 * (#101), `resolveQuestion` (#126), `migrateArtifact` (#132), `setTypeActivation` (QST-0010) and this.
 *
 * ⚠️ **It REFUSES the fields that have bespoke operations, and that refusal is what keeps #101 true.**
 * A general linker that could write `supportedBy` would let a caller bypass the dual-polarity guard —
 * the check that one record cannot both support and refute the same claim. Generality is worth having
 * only where no guard is being skipped.
 *
 * ⚠️ **Targets are validated against the schema's own `x-traceTarget`**, so the rule lives in one
 * place (#82) rather than being restated here. A field whose declared targets do not include the
 * thing you are linking is refused with both lists in the message.
 */

import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { withLock } from "../lock.mjs";
import { atomicWrite } from "../atomic-write.mjs";
import { resolveContentRoot, resolveInContentRoot } from "../content-root.mjs";
import { createValidators, assertValid, ValidationError } from "../validate.mjs";
import { effectiveSchema, loadSchemaSet, typeOfId } from "../schema-resolver.mjs";
import { artifactRelPath } from "../layout.mjs";
import { LOCK_FILE } from "./create-artifact.mjs";

const DEFAULT_SCHEMAS = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "schemas");

/** Fields with their own operation, and the operation to use instead. */
const BESPOKE = {
  supportedBy: "linkEvidence(assertionId, evidenceId, 'support')",
  refutedBy: "linkEvidence(assertionId, evidenceId, 'refute')",
  supersededBy: "setLifecycle(type, id, 'superseded', { supersededBy })",
  answeredBy: "resolveQuestion(id, 'answered', { answeredBy })",
};

async function mutate(type, id, field, targets, opts, apply) {
  if (BESPOKE[field])
    throw new ValidationError(
      `\`${field}\` has its own operation and its own guards (#101). Use ${BESPOKE[field]} instead — ` +
        `routing it through a generic linker would skip the check that operation exists for.`,
      []
    );
  if (!Array.isArray(targets) || targets.length === 0)
    throw new ValidationError("Pass at least one target ID.", []);

  const contentRoot = opts.contentRoot ?? resolveContentRoot(opts.env);
  const schemasDir = opts.schemasDir ?? DEFAULT_SCHEMAS;
  const validators = opts.validators ?? createValidators(schemasDir);
  const schemas = opts.schemas ?? loadSchemaSet(schemasDir);

  const eff = effectiveSchema(schemas, type);
  const prop = eff.properties?.[field];
  if (!prop) throw new ValidationError(`\`${type}\` has no field \`${field}\`.`, []);
  const allowed = prop["x-traceTarget"];
  if (!Array.isArray(allowed))
    throw new ValidationError(`\`${type}.${field}\` is not a trace field — it declares no x-traceTarget (#82).`, []);

  return withLock(join(contentRoot, LOCK_FILE), async () => {
    const abs = resolveInContentRoot(artifactRelPath(type, id), { contentRoot });
    if (!existsSync(abs)) throw new ValidationError(`No such ${type}: ${id}`, []);

    for (const ref of targets) {
      const refType = typeOfId(schemas, ref);
      if (!refType) throw new ValidationError(`\`${ref}\` is not an artifact ID.`, []);
      if (!allowed.includes(refType))
        throw new ValidationError(
          `\`${type}.${field}\` may target ${allowed.join(", ")}; \`${ref}\` is a ${refType}.`,
          []
        );
      // Only linking requires the target to exist. Unlinking a reference to something already gone
      // is exactly how you would repair a dangling edge, so refusing it would trap the repair.
      if (apply === "add") {
        const refPath = resolveInContentRoot(artifactRelPath(refType, ref), { contentRoot });
        if (!existsSync(refPath)) throw new ValidationError(`\`${ref}\` does not exist.`, []);
      }
    }

    const doc = JSON.parse(readFileSync(abs, "utf-8")); // fresh, inside the lock (#78)
    const before = doc[field] ?? [];
    const next =
      apply === "add"
        ? [...new Set([...before, ...targets])].sort()
        : before.filter((r) => !targets.includes(r));

    if (JSON.stringify(next) === JSON.stringify(before))
      return { id, field, changed: false, links: before, artifact: doc };

    const updated = { ...doc, [field]: next };
    // A trace edge is structural (#61), so an approved artifact that gains or loses one is amended.
    if (doc.reviewStatus === "approved") updated.reviewStatus = "amended";

    assertValid(validators, type, updated, `${type} after ${apply === "add" ? "linking" : "unlinking"}`);
    await atomicWrite(abs, JSON.stringify(updated, null, 2) + "\n");
    return { id, field, changed: true, links: next, artifact: updated };
  });
}

export const linkTrace = (type, id, field, targets, opts = {}) => mutate(type, id, field, targets, opts, "add");
export const unlinkTrace = (type, id, field, targets, opts = {}) => mutate(type, id, field, targets, opts, "remove");
