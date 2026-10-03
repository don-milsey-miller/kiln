/** A browser-local flag would drift; first-run derives from the canonical validated artifact set. */
export function isFirstRunWorkspace(overview) {
  return Number.isInteger(overview?.artifactCount) && overview.artifactCount === 0;
}
