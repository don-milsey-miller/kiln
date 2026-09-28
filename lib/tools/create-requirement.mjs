/**
 * The requirement typed tool. #88's contract now lives in create-artifact.mjs and is shared by
 * every type; this file is the requirement-specific half: which fields a caller may supply.
 */

import { createArtifact } from "./create-artifact.mjs";
import { artifactRelPath } from "../layout.mjs";
import { callerFieldsFor } from "./artifact-authoring.mjs";

export { ArtifactExistsError, LOCK_FILE, SCHEMA_VERSION } from "./create-artifact.mjs";
export const ARTIFACT_DIR = "data/requirements";

const CALLER_FIELDS = callerFieldsFor("requirement");

/** Delegates to #87 layout so the tool and the lint cannot disagree about where things live. */
export function artifactPath(id) {
  return artifactRelPath("requirement", id);
}

export const createRequirement = (input, opts) => createArtifact("requirement", CALLER_FIELDS, input, opts);
