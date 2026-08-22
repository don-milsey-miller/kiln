/**
 * Move an artifact's `reviewStatus` — the eighth missing operation, and the only one that already
 * had a working implementation in the wrong place.
 *
 * ⚠️ **It lived in `app/server.mjs`.** The skeleton's status write-back has done this correctly since
 * 5b — lock, fresh read, validate, atomic write — but it sat in the APP, so the only way to approve an
 * artifact was through a running web server. `reviseArtifact` refuses `reviewStatus` as identity state
 * (#102), so a CLI, a test, or a specialist had no path at all. **Moved rather than rewritten**, which
 * is #47's argument: one implementation, every caller, and nobody's second copy drifts.
 *
 * ⚠️ **`DEC-0015` makes this load-bearing rather than convenient.** Executable handoff content —
 * `runbook-step` and `task` — must be `approved` or `amended` before it may be published, because
 * those are the artifacts a recipient acts on. A policy with no mechanism is a policy nobody follows,
 * which is the same sentence #83 earned.
 */

import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { withLock } from "../lock.mjs";
import { atomicWrite } from "../atomic-write.mjs";
import { resolveContentRoot, resolveInContentRoot } from "../content-root.mjs";
import { createValidators, assertValid, ValidationError } from "../validate.mjs";
import { loadSchemaSet } from "../schema-resolver.mjs";
import { artifactRelPath } from "../layout.mjs";
import { LOCK_FILE } from "./create-artifact.mjs";

const DEFAULT_SCHEMAS = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "schemas");

/**
 * @param {string} type
 * @param {string} id
 * @param {"draft"|"in-review"|"approved"|"amended"} reviewStatus
 * @param {{contentRoot?: string, schemas?: object, validators?: object, reviewedBy?: string}} [opts]
 */
export async function setReviewStatus(type, id, reviewStatus, opts = {}) {
  const contentRoot = opts.contentRoot ?? resolveContentRoot(opts.env);
  const schemas = opts.schemas ?? loadSchemaSet(opts.schemasDir ?? DEFAULT_SCHEMAS);
  const validators = opts.validators ?? createValidators(opts.schemasDir ?? DEFAULT_SCHEMAS);

  const allowed = schemas.common.$defs.reviewStatus.enum;
  if (!allowed.includes(reviewStatus))
    throw new ValidationError(`reviewStatus must be one of ${allowed.join(", ")}, got ${JSON.stringify(reviewStatus)}.`, []);

  // ⚠️ An approval is a HUMAN act and the record says whose. #93 made the same demand of attestations
  // for the same reason: "approved" with nobody attached is a state nobody can be asked about.
  if (reviewStatus === "approved" && !opts.reviewedBy)
    throw new ValidationError("Approving requires `reviewedBy` — an approval nobody is attached to cannot be questioned later.", []);

  return withLock(join(contentRoot, LOCK_FILE), async () => {
    const abs = resolveInContentRoot(artifactRelPath(type, id), { contentRoot });
    if (!existsSync(abs)) throw new ValidationError(`No such ${type}: ${id}`, []);
    const doc = JSON.parse(readFileSync(abs, "utf-8")); // fresh, after acquisition (#78)
    if (doc.reviewStatus === reviewStatus) return { id, type, from: doc.reviewStatus, to: reviewStatus, changed: false, artifact: doc };

    const updated = { ...doc, reviewStatus };
    assertValid(validators, type, updated, "artifact after review status change");
    await atomicWrite(abs, JSON.stringify(updated, null, 2) + "\n");
    return { id, type, from: doc.reviewStatus, to: reviewStatus, changed: true, reviewedBy: opts.reviewedBy ?? null, artifact: updated };
  });
}
