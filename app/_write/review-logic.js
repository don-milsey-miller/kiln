/**
 * What a review submission means, with the write injected — CMP-0018's decidable half.
 *
 * ⚠️ IT LIVES HERE, NOT BESIDE THE ACTION, FOR THE REASON `app/_stream/logic.js` DOES: the action
 * itself imports `app/server/review.js`, which carries `server-only`, so a plain Node test cannot
 * load it. Everything worth testing about a write — that an unknown id is refused before the lock is
 * taken, that a bad status never reaches the disk, that two concurrent submissions leave one valid
 * artifact rather than half of two — would then be reachable only through a running web server, and
 * concurrency is exactly what a browser test is worst at provoking on purpose.
 *
 * ⚠️ NOTHING HERE TRUSTS THE FORM. Every field arrives from a browser: the id, the status, the
 * operator's name and the path to return to. The id is matched against the schema set rather than
 * accompanied by a type, the status is checked against the enum before the write is attempted, and
 * the return path is matched against a literal shape rather than sanitised. Sanitising means
 * removing what is dangerous and hoping the list was complete; matching means nothing that does not
 * look exactly like a stage URL can be a redirect target at all.
 *
 * ⚠️ IT CANNOT EXPRESS A LIFECYCLE CHANGE, AND THAT IS STRUCTURAL RATHER THAN CAREFUL. The only
 * write it is given is `setReviewStatus`, whose signature has no field parameter. There is no
 * argument this module could pass, and no string a form could post, that would retire an artifact.
 * ACC-0034 asks for `lifecycle` to be unchanged; the way to guarantee that is to hold an operation
 * that has no way to change it.
 */

/** Return codes. Every failure is one of these — the browser never sees a raw error string. */
export const REVIEW = {
  OK: "ok",
  NO_ID: "no-id",
  UNKNOWN_ARTIFACT: "unknown-artifact",
  BAD_STATUS: "bad-status",
  NEEDS_REVIEWER: "needs-reviewer",
  WRITE_FAILED: "write-failed",
};

/**
 * ⚠️ MESSAGES ARE SERVER-SIDE AND CODE-KEYED, so a failure travels back as `?reviewError=bad-status`
 * rather than as text. A URL that carried the message would let anyone hand someone else a link that
 * renders an arbitrary sentence inside the application's own error styling — the failure reporter
 * becoming the delivery route, which is the mechanism `document-panel.js` already refuses for
 * compiler diagnostics.
 */
export const REVIEW_MESSAGE = {
  [REVIEW.NO_ID]: "No artifact was named, so nothing was changed.",
  [REVIEW.UNKNOWN_ARTIFACT]: "That artifact does not exist. Nothing was changed.",
  [REVIEW.BAD_STATUS]: "That is not a review status. Nothing was changed.",
  [REVIEW.NEEDS_REVIEWER]: "Approving needs a reviewer's name — an approval nobody is attached to cannot be questioned later. Nothing was changed.",
  [REVIEW.WRITE_FAILED]: "The write did not complete. Nothing was changed.",
};

/**
 * ⚠️ A LITERAL SHAPE, NOT A SANITISER. A stage path is lowercase letters, digits and hyphens after
 * `/stage/` and nothing else — no dots, no slashes, no scheme, so neither `..` nor `//evil.example`
 * nor a `javascript:` URL can match. An id is the project's own pattern. Anything that fails either
 * falls back to the site root, which is a real page rather than an error.
 */
const STAGE_PATH = /^\/stage\/[a-z0-9-]+$/;
const ARTIFACT_ID = /^[A-Z]{3}-[0-9]{4,}$/;

/** Rebuild the URL to return to, from parts that were each matched rather than trusted. */
export function returnUrl({ path, artifactId, error }) {
  const base = STAGE_PATH.test(path ?? "") ? path : "/";
  const query = [];
  if (ARTIFACT_ID.test(artifactId ?? "")) query.push(`artifact=${artifactId}`);
  if (error && error !== REVIEW.OK) query.push(`reviewError=${error}`);
  return query.length ? `${base}?${query.join("&")}` : base;
}

/**
 * Apply one review submission.
 *
 * @param {{id?: string, status?: string, reviewedBy?: string, path?: string}} fields  from the form
 * @param {{setReviewStatus: Function, typeOf: Function, statuses: string[], contentRoot: string, schemasDir: string}} deps
 * @returns {Promise<{code: string, redirectTo: string, changed?: boolean}>}
 */
export async function applyReviewSubmission(fields, deps) {
  const id = (fields.id ?? "").trim();
  const status = (fields.status ?? "").trim();
  const reviewedBy = (fields.reviewedBy ?? "").trim();

  const fail = (code) => ({ code, redirectTo: returnUrl({ path: fields.path, artifactId: id, error: code }) });

  if (!ARTIFACT_ID.test(id)) return fail(REVIEW.NO_ID);

  // ⚠️ CHECKED BEFORE THE LOCK IS TAKEN, IN THIS ORDER, ON PURPOSE. A refusal that happens after
  // acquisition holds the content lock while deciding to do nothing, and every other writer —
  // including the CLI — waits behind it.
  const type = deps.typeOf(id);
  if (!type) return fail(REVIEW.UNKNOWN_ARTIFACT);
  if (!deps.statuses.includes(status)) return fail(REVIEW.BAD_STATUS);
  if (status === "approved" && !reviewedBy) return fail(REVIEW.NEEDS_REVIEWER);

  try {
    const result = await deps.setReviewStatus(type, id, status, {
      contentRoot: deps.contentRoot,
      schemasDir: deps.schemasDir,
      reviewedBy: reviewedBy || undefined,
    });
    return {
      code: REVIEW.OK,
      changed: result.changed,
      redirectTo: returnUrl({ path: fields.path, artifactId: id }),
    };
  } catch (e) {
    // ⚠️ `typeOfId` ANSWERS FROM THE ID'S SHAPE, NOT FROM THE DISK, so a well-formed id for an
    // artifact that does not exist gets this far and is refused inside the lock. That refusal is
    // worth reporting as itself rather than as a generic failure, and the only thing distinguishing
    // it is the tool's message — so `test/review-write.test.mjs` pins that wording against the real
    // `setReviewStatus`. If it ever changes, a test fails rather than this quietly degrading every
    // missing artifact into "the write did not complete".
    //
    // Checking existence here instead would mean touching the filesystem from application code,
    // which `lint:shell` refuses, and would be a race in any case: the answer could change between
    // the check and the lock.
    if (String(e?.message ?? "").startsWith("No such ")) return fail(REVIEW.UNKNOWN_ARTIFACT);

    // ⚠️ EVERY OTHER REASON IS DELIBERATELY NOT FORWARDED. A `ValidationError` from the write quotes
    // file paths and schema internals, and this string ends up in a URL. The operator gets a code;
    // the detail belongs in the server log, where it does not travel.
    return fail(REVIEW.WRITE_FAILED);
  }
}
