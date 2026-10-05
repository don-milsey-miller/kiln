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
 * @param {{contentRoot?: string, schemas?: object, validators?: object, reviewedBy?: string, lock?: object, dryRun?: boolean}} [opts]
 *   `lock` is passed to `withLock`; `dryRun` runs every check and writes nothing.
 */
export async function setReviewStatus(type, id, reviewStatus, opts = {}) {
  const contentRoot = opts.contentRoot ?? resolveContentRoot(opts.env);
  const schemas = opts.schemas ?? loadSchemaSet(opts.schemasDir ?? DEFAULT_SCHEMAS);
  const validators = opts.validators ?? createValidators(opts.schemasDir ?? DEFAULT_SCHEMAS);

  const allowed = schemas.common.$defs.reviewStatus.enum;
  if (!allowed.includes(reviewStatus))
    throw new ValidationError(`reviewStatus must be one of ${allowed.join(", ")}, got ${JSON.stringify(reviewStatus)}.`, []);

  // ⚠️ **AN APPROVAL IS A HUMAN ACT, SO A CALLER MUST NAME ONE — BUT THIS DOES NOT PERSIST IT (F18).**
  // The artifact envelope in `common.schema.json` has no reviewer field, so `reviewedBy` is required of
  // the caller, returned to the caller, and then dropped. What it buys today is a refusal: an approval
  // that no caller would put a name to does not happen. It is NOT durable attribution, and nothing
  // downstream may present it as such. Giving an artifact a reviewer field, or an approval history, is
  // a schema and migration decision that has not been made.
  if (reviewStatus === "approved" && !opts.reviewedBy)
    throw new ValidationError("Approving requires `reviewedBy` — an approval nobody is attached to cannot be questioned later.", []);

  return withLock(join(contentRoot, LOCK_FILE), async () => {
    const abs = resolveInContentRoot(artifactRelPath(type, id), { contentRoot });
    if (!existsSync(abs)) throw new ValidationError(`No such ${type}: ${id}`, []);
    const doc = JSON.parse(readFileSync(abs, "utf-8")); // fresh, after acquisition (#78)
    if (doc.reviewStatus === reviewStatus) return { id, type, from: doc.reviewStatus, to: reviewStatus, changed: false, artifact: doc };

    const updated = { ...doc, reviewStatus };
    assertValid(validators, type, updated, "artifact after review status change");
    if (!opts.dryRun) await atomicWrite(abs, JSON.stringify(updated, null, 2) + "\n");
    return { id, type, from: doc.reviewStatus, to: reviewStatus, changed: true, reviewedBy: opts.reviewedBy ?? null, artifact: updated };
  }, opts.lock);
}

/** The most artifacts one batch may name. A requirement set fits; an unbounded list is not one decision. */
export const MAX_REVIEW_BATCH = 50;

/** A batch write failed and at least one artifact could not be put back. The ids name what is left changed. */
export class ReviewBatchRollbackError extends Error {
  constructor(unrestored, { cause } = {}) {
    super(`A batch review-status write failed and ${unrestored.join(", ")} could not be restored.`, cause === undefined ? undefined : { cause });
    this.name = "ReviewBatchRollbackError";
    this.unrestored = unrestored;
  }
}

/**
 * Move several artifacts to one `reviewStatus`, all or none.
 *
 * ⚠️ **EVERY ARTIFACT IS READ AND VALIDATED BEFORE ANY IS WRITTEN.** A missing artifact, a duplicate, or
 * one whose new state fails its schema refuses the whole batch with nothing on disk changed. If a write
 * fails part way, the artifacts already written get their original bytes back, and a
 * `ReviewBatchRollbackError` names any that could not be restored.
 *
 * @param {{type: string, id: string}[]} targets
 * @param {"draft"|"in-review"|"approved"|"amended"} reviewStatus
 * @param {{contentRoot?: string, schemas?: object, validators?: object, reviewedBy?: string, writeFile?: Function}} [opts]
 *   `writeFile` replaces `atomicWrite`, for tests that need a write to fail.
 */
export async function setReviewStatusBatch(targets, reviewStatus, opts = {}) {
  const contentRoot = opts.contentRoot ?? resolveContentRoot(opts.env);
  const schemas = opts.schemas ?? loadSchemaSet(opts.schemasDir ?? DEFAULT_SCHEMAS);
  const validators = opts.validators ?? createValidators(opts.schemasDir ?? DEFAULT_SCHEMAS);
  const write = opts.writeFile ?? atomicWrite;

  const allowed = schemas.common.$defs.reviewStatus.enum;
  if (!allowed.includes(reviewStatus))
    throw new ValidationError(`reviewStatus must be one of ${allowed.join(", ")}, got ${JSON.stringify(reviewStatus)}.`, []);
  if (reviewStatus === "approved" && !opts.reviewedBy)
    throw new ValidationError("Approving requires `reviewedBy` — an approval nobody is attached to cannot be questioned later.", []);
  if (!Array.isArray(targets) || targets.length === 0 || targets.length > MAX_REVIEW_BATCH)
    throw new ValidationError(`A batch names between 1 and ${MAX_REVIEW_BATCH} artifacts.`, []);
  const seen = new Set();
  for (const t of targets) {
    if (typeof t?.type !== "string" || typeof t?.id !== "string") throw new ValidationError("Each batch entry needs a type and an id.", []);
    if (seen.has(t.id)) throw new ValidationError(`${t.id} is named more than once in the batch.`, []);
    seen.add(t.id);
  }

  return withLock(join(contentRoot, LOCK_FILE), async () => {
    const planned = targets.map(({ type, id }) => {
      const abs = resolveInContentRoot(artifactRelPath(type, id), { contentRoot });
      if (!existsSync(abs)) throw new ValidationError(`No such ${type}: ${id}`, []);
      const original = readFileSync(abs, "utf-8"); // fresh, after acquisition (#78)
      const doc = JSON.parse(original);
      const changed = doc.reviewStatus !== reviewStatus;
      const updated = changed ? { ...doc, reviewStatus } : doc;
      if (changed) assertValid(validators, type, updated, "artifact after review status change");
      return { type, id, abs, original, from: doc.reviewStatus, changed, updated };
    });

    const written = [];
    try {
      for (const p of planned) {
        if (!p.changed) continue;
        await write(p.abs, JSON.stringify(p.updated, null, 2) + "\n");
        written.push(p);
      }
    } catch (cause) {
      const unrestored = [];
      for (const p of written) {
        try {
          await atomicWrite(p.abs, p.original);
        } catch {
          unrestored.push(p.id);
        }
      }
      if (unrestored.length > 0) throw new ReviewBatchRollbackError(unrestored, { cause });
      throw cause;
    }

    return {
      to: reviewStatus,
      reviewedBy: opts.reviewedBy ?? null,
      results: planned.map((p) => ({ id: p.id, type: p.type, from: p.from, to: reviewStatus, changed: p.changed })),
    };
  });
}
