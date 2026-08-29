import "server-only";

/**
 * The review-status write — the FIRST and ONLY write the application may perform.
 *
 * ⚠️ DEC-0021 HELD THIS BACK FOR INDIVIDUAL REVIEW, and this file is the whole of what that review
 * approved. Every other adapter is a read; this one takes the content lock. A Server Component can
 * run concurrently in ways a CLI never does, which is the reason the line was not simply added to
 * `content.js` when the adapter layer was built.
 *
 * ⚠️ EXACTLY ONE WRITE, NAMED. `setReviewStatus` and nothing else. Not `setLifecycle`, not
 * `reviseArtifact`, not `createArtifact`, not `linkTrace` — every one of which is also a locking
 * operation sitting in the same directory of `lib/tools/`, and any of which would be a one-line
 * addition here. `test/review-write.test.mjs` pins this surface and fails if a second write appears,
 * because "we only expose what we need" is a sentence, and a sentence is not a boundary.
 *
 * ⚠️ THE OTHER TWO NAMES ARE READS, and they are here so the action never has to trust the browser
 * about what it is writing to. A form posts an id; `typeOfId` turns that id into the artifact type
 * the write needs, from the schema set rather than from a hidden field. Without them the action
 * would take the type from the client, which is the shape of every "update the record the user
 * named" defect there has ever been.
 *
 * ⚠️ IT IS NOT A GENERAL WRITE DOOR AND MUST NOT BECOME ONE. `setReviewStatus` changes exactly one
 * field of one artifact and cannot express anything else — that is a property of the operation, not
 * of the caller, which is why it can be exposed at all. An operation that took a field name would
 * fail this review however carefully the caller was written.
 */
export { setReviewStatus } from "../../lib/tools/review-status.mjs";
export { typeOfId, loadSchemaSet } from "../../lib/schema-resolver.mjs";
