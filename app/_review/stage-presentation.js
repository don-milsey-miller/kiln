/**
 * Derive the UI state of a stage gate without creating another stored authority. Gate readiness
 * remains evaluateStageGate's decision; criterion results only distinguish why a non-ready gate
 * needs attention.
 */
export const STAGE_PRESENTATION = Object.freeze({
  ready: Object.freeze({ state: "ready", label: "READY", shortLabel: "ready", colour: "#2e7d32" }),
  "awaiting-attestation": Object.freeze({ state: "awaiting-attestation", label: "AWAITING ATTESTATION", shortLabel: "awaiting attestation", colour: "#9a6700" }),
  blocked: Object.freeze({ state: "blocked", label: "BLOCKED", shortLabel: "blocked", colour: "#c62828" }),
});

/**
 * `criteria` on the result is what holds the gate, in the order the stage definition lists them: each one's id and
 * the definition's own description of it (#183). `criterionIds` is the same list as ids alone.
 */
export function deriveStagePresentation(criteria = [], ready = false) {
  const holding = (result) =>
    criteria
      .filter((criterion) => criterion.result === result)
      .map((criterion) => ({ id: criterion.id, describe: typeof criterion.describe === "string" ? criterion.describe : "" }));
  const withIds = (presentation, held) => ({ ...presentation, criterionIds: held.map((criterion) => criterion.id), criteria: held });

  if (ready) return withIds(STAGE_PRESENTATION.ready, []);

  const blocked = holding("not-satisfied");
  if (blocked.length > 0) return withIds(STAGE_PRESENTATION.blocked, blocked);

  const awaiting = holding("unattested");
  if (awaiting.length > 0) return withIds(STAGE_PRESENTATION["awaiting-attestation"], awaiting);

  // A mechanised rule or another gate input may keep the authoritative gate closed even when every
  // human criterion is attested. That is blocked work, not an attestation the operator forgot.
  return withIds(STAGE_PRESENTATION.blocked, []);
}
