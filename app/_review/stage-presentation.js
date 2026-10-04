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

export function deriveStagePresentation(criteria = [], ready = false) {
  if (ready) return { ...STAGE_PRESENTATION.ready, criterionIds: [] };

  const blocked = criteria.filter((criterion) => criterion.result === "not-satisfied").map((criterion) => criterion.id);
  if (blocked.length > 0) return { ...STAGE_PRESENTATION.blocked, criterionIds: blocked };

  const awaiting = criteria.filter((criterion) => criterion.result === "unattested").map((criterion) => criterion.id);
  if (awaiting.length > 0) return { ...STAGE_PRESENTATION["awaiting-attestation"], criterionIds: awaiting };

  // A mechanised rule or another gate input may keep the authoritative gate closed even when every
  // human criterion is attested. That is blocked work, not an attestation the operator forgot.
  return { ...STAGE_PRESENTATION.blocked, criterionIds: [] };
}
