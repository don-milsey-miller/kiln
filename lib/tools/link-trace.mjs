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

/**
 * Fields with their own ADD operation, and the operation to use instead.
 *
 * Adding is where the bespoke guards live — the dual-polarity check, the successor requirement, the
 * answered-carries-something check — so a generic linker must not be able to reach these.
 */
const BESPOKE_ADD = {
  supportedBy: "linkEvidence(assertionId, evidenceId, 'support')",
  refutedBy: "linkEvidence(assertionId, evidenceId, 'refute')",
  supersededBy: "setLifecycle(type, id, 'superseded', { supersededBy })",
  answeredBy: "resolveQuestion(id, 'answered', { answeredBy })",
};

/**
 * Fields with their own REMOVE operation. Deliberately a SHORTER list than `BESPOKE_ADD`.
 *
 * ⚠️ **`answeredBy` is absent, and its absence is the point (QST-0032, DEC-0031).** `resolveQuestion`
 * can only ever MERGE `answeredBy`; nothing could withdraw one. So a question answered by a decision
 * that was later superseded kept pointing at it, the lint reported an active artifact resting on one
 * that no longer stands, and no typed operation could clear it — the only route was `reviseArtifact`,
 * which worked solely because its guard list was incomplete. One defect was the escape hatch for the
 * other. This is the half that closes first, because closing the other one first would leave the
 * damage unrepairable by any typed path while #88 forbids the hand edit.
 *
 * The two evidence fields keep their operation because `unlinkEvidence` genuinely exists, and
 * `supersededBy` keeps its own because removing a successor is a lifecycle transition rather than a
 * link edit: an artifact left `superseded` with nothing to point at is a worse state than the one
 * being repaired.
 */
const BESPOKE_REMOVE = {
  supportedBy: "unlinkEvidence(assertionId, evidenceId, 'support')",
  refutedBy: "unlinkEvidence(assertionId, evidenceId, 'refute')",
  supersededBy: "setLifecycle(type, id, <lifecycle>) — removing a successor is a lifecycle change",
};

async function mutate(type, id, field, targets, opts, apply) {
  const bespoke = apply === "add" ? BESPOKE_ADD[field] : BESPOKE_REMOVE[field];
  if (bespoke)
    throw new ValidationError(
      `\`${field}\` has its own ${apply === "add" ? "linking" : "unlinking"} operation and its own ` +
        `guards (#101). Use ${bespoke} instead — routing it through a generic linker would skip the ` +
        `check that operation exists for.`,
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

    // ⚠️ **THE TARGET IS VALIDATED ON ADD AND NOT ON REMOVE, and that asymmetry is the whole fix
    // (DEC-0031).** Validating a target on the way IN is what keeps the graph sound. Validating it
    // on the way OUT refuses precisely the operations that repair an unsound one: a link written
    // with the wrong target type, a link to something since deleted, a link to something since
    // superseded. Each is a state the lint reports and each was previously unremovable — the guard
    // rejected exactly the edges that needed rejecting, and the only escape was another defect.
    //
    // Removal therefore inspects nothing about the target. It does not have to exist, be of an
    // allowed type, or even be a well-formed artifact ID: whatever is in the array can come out of
    // it. What removal still cannot do is touch a field the schema does not declare as a trace
    // field, which is checked above and is what keeps this from becoming a general array editor.
    if (apply === "add") {
      for (const ref of targets) {
        const refType = typeOfId(schemas, ref);
        if (!refType) throw new ValidationError(`\`${ref}\` is not an artifact ID.`, []);
        if (!allowed.includes(refType))
          throw new ValidationError(
            `\`${type}.${field}\` may target ${allowed.join(", ")}; \`${ref}\` is a ${refType}.`,
            []
          );
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
