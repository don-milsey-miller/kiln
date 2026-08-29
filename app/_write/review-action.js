"use server";

import { redirect } from "next/navigation";

import { setReviewStatus, typeOfId, loadSchemaSet } from "../server/review.js";
import { planningRoots } from "../_read/planning.js";
import { applyReviewSubmission } from "./review-logic.js";

/**
 * The review-status Server Action — CMP-0018's wiring, and nothing else.
 *
 * ⚠️ IT IS THIN ON PURPOSE. Everything that could be got wrong lives in `./review-logic.js`, which
 * carries no `server-only` and can therefore be tested in plain Node against the REAL locking write
 * over a temporary content root. What is left here is the parts a test cannot reach anyway: reading
 * a `FormData`, and a redirect.
 *
 * ⚠️ IT SHARES ITS ROOTS WITH THE READER RATHER THAN RESOLVING ITS OWN. `planningRoots` is exported
 * from `app/_read/planning.js` and is the single definition of where content lives. Two resolutions
 * that agreed today and drifted later would mean the page reading one directory and this writing
 * another — an operator would approve an artifact, see the page reload unchanged, and have no way to
 * tell which of the two was lying. It is imported but never awaited, which is what keeps it out of
 * the `<Suspense>` enclosure rule: this is not a component and has no boundary to sit inside.
 *
 * ⚠️ EVERY FIELD BELOW COMES FROM A BROWSER and is treated that way. Notably there is no `type`
 * field: the artifact's type is derived from its id through the schema set, so a form cannot name
 * one artifact and have a different one written.
 */
export async function submitReviewStatus(formData) {
  const { projectRoot, contentRoot } = planningRoots();
  const schemasDir = `${projectRoot}/schemas`;
  const schemas = loadSchemaSet(schemasDir);

  const result = await applyReviewSubmission(
    {
      id: formData.get("id"),
      status: formData.get("status"),
      reviewedBy: formData.get("reviewedBy"),
      path: formData.get("path"),
    },
    {
      setReviewStatus,
      typeOf: (id) => typeOfId(schemas, id),
      statuses: schemas.common.$defs.reviewStatus.enum,
      contentRoot,
      schemasDir,
    }
  );

  // ⚠️ REDIRECT RATHER THAN RETURN, so the outcome survives in the URL and the page that renders it
  // is a FRESH read of the disk. Returning a value would leave the operator looking at a page that
  // rendered before the write and asking them to believe a banner about it. `redirect` throws, so it
  // must be the last thing here.
  redirect(result.redirectTo);
}
