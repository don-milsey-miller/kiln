/** Deterministic boundaries around advisory semantic decisions. */

export const TOOL_FAMILIES = Object.freeze([
  "read",
  "author",
  "mutate",
  "research",
  "validate",
  "delegate",
  "approve",
  "attest",
]);

const FAMILY_DESCRIPTIONS = Object.freeze({
  read: "Inspect project status, stage context, artifacts, lint, or capabilities without changing state.",
  author: "Create or revise planning content that the current stage permits.",
  mutate: "Change an existing relationship, lifecycle, answer, or canonical payload through a typed operation.",
  research: "Discover or retrieve external information through the approved research boundary.",
  validate: "Run declared validation work in an isolated workspace.",
  delegate: "Delegate a bounded task to a specialist role permitted by the current stage.",
  approve: "Request the operator's explicit approval for a review or activation decision.",
  attest: "Request and record the operator's explicit stage attestation.",
});

export function toolFamilyCriteria(families) {
  return Object.fromEntries(families.map((family) => [family, FAMILY_DESCRIPTIONS[family]]));
}

/**
 * Derive the families Jev may choose. This can only narrow semantic choices; it does not grant a tool.
 * The stage definition remains authoritative for every eventual operation.
 */
export function permittedToolFamilies(stageDefinition) {
  const activities = new Set(stageDefinition?.nextActivity?.activities ?? []);
  const mutations = new Set(stageDefinition?.mutationBoundary?.mayMutate ?? []);
  const delegationRoles = new Set((stageDefinition?.delegations ?? []).map((entry) => entry?.role));
  const families = ["read"];

  if (activities.has("question") || activities.has("author")) families.push("author");
  if (activities.has("author") && mutations.size > 0) families.push("mutate");
  if (delegationRoles.has("research")) families.push("research");
  if (delegationRoles.has("validation")) families.push("validate");
  if (activities.has("delegate")) families.push("delegate");
  if (mutations.has("setReviewStatus") || mutations.has("setTypeActivation")) families.push("approve");
  if (activities.has("attest")) families.push("attest");
  return TOOL_FAMILIES.filter((family) => families.includes(family));
}

export const ARTIFACT_RELATIONSHIPS = Object.freeze([
  "distinct",
  "duplicate",
  "overlaps",
  "refines",
  "contradicts",
]);

export const ARTIFACT_RELATIONSHIP_CRITERIA = Object.freeze({
  distinct: "The records express materially different obligations or ideas.",
  duplicate: "They express substantially the same obligation or idea in different words.",
  overlaps: "They share material scope, but each also contains meaning the other does not.",
  refines: "The proposed artifact narrows, details, or makes the candidate more specific without contradicting it.",
  contradicts: "They cannot both be satisfied or treated as true in the same project state.",
});

export const TRACE_RELEVANCE = Object.freeze(["strong", "possible", "unrelated"]);
export const TRACE_RELEVANCE_CRITERIA = Object.freeze({
  strong: "The source meaning directly supports the declared trace relationship to this target.",
  possible: "The target is plausibly related, but the declared trace relationship needs human or Pi review.",
  unrelated: "The source meaning does not materially support the declared trace relationship to this target.",
});

export const RESEARCH_TRIAGE = Object.freeze(["essential", "relevant", "uncertain", "duplicate", "irrelevant"]);
export const RESEARCH_TRIAGE_CRITERIA = Object.freeze({
  essential: "Directly answers a material part of the research question with distinctive information.",
  relevant: "Likely useful to answering the research question and not substantially duplicated by another result.",
  uncertain: "May bear on the question, but the snippet is insufficient to include or omit confidently.",
  duplicate: "Substantially repeats a more useful candidate in this result set.",
  irrelevant: "Says nothing material about the research question.",
});

export const EVIDENCE_RELATIONSHIPS = Object.freeze(["supports", "contradicts", "says_nothing"]);
export const EVIDENCE_RELATIONSHIP_CRITERIA = Object.freeze({
  supports: "The evidence content materially increases confidence that the assertion is true.",
  contradicts: "The evidence content materially increases confidence that the assertion is false.",
  says_nothing: "The evidence content does not materially bear on whether the assertion is true or false.",
});

/** Confidence is returned for calibration; Kiln intentionally does not invent an automatic-action threshold. */
export const advisoryPolicy = Object.freeze({
  advisory: true,
  automaticAction: false,
  explanation:
    "No confidence threshold is configured. The result may rank or focus Pi's review, but cannot mutate state, pass a gate, or grant a tool.",
});
