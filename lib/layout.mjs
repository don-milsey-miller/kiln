/**
 * #87 — where an artifact lives. One place, because the typed tools and the lint must agree
 * on it exactly: the lint's storage-identity rules compare a file's location against its
 * contents, and two definitions of "where it should be" would make that comparison
 * meaningless.
 *
 * One file per artifact: `data/<type>s/<ID>.json`, relative to the content root (#70).
 */

import { join } from "node:path";

export const DATA_DIR = "data";

/** Directory for a type. Deterministic and dumb on purpose — no irregular-plural table. */
export function artifactDir(type) {
  return `${DATA_DIR}/${type}s`;
}

/** Content-root-relative path for one artifact. */
export function artifactRelPath(type, id) {
  return `${artifactDir(type)}/${id}.json`;
}

export function artifactAbsPath(contentRoot, type, id) {
  return join(contentRoot, artifactDir(type), `${id}.json`);
}

/**
 * Read a stored path back into what it CLAIMS to be. The lint compares this against what the
 * file actually contains — that comparison is the whole point of #87's storage-identity rules,
 * and it only works because the claim and the content come from different places.
 *
 * @returns {{dirType: string|null, filenameId: string|null}}
 */
export function parseArtifactRelPath(relPath) {
  const m = /^data\/([A-Za-z-]+)s\/([A-Z]+-[0-9]{4,})\.json$/.exec(relPath.replace(/\\/g, "/"));
  return m ? { dirType: m[1], filenameId: m[2] } : { dirType: null, filenameId: null };
}
