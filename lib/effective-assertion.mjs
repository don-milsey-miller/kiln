/**
 * #96 — the effective assertion view.
 *
 * `verdict` and `confidence` are DERIVED, never stored. The canonical inputs are the assertion,
 * its `supportedBy` / `refutedBy` evidence, and each evidence record's source, experiment,
 * environment, recency and lifecycle. One derivation, consumed by the gates, the renderer and
 * the handoff export — the same shape as #84's resolution layer, for the same reason: several
 * consumers each re-deriving this would be several subtly different answers to "is this claim
 * safe to act on."
 *
 * The order matters and is the load-bearing part:
 *
 *     applicability filtering  →  verdict  →  confidence
 *
 * Filtering FIRST is what stops a stale or environment-mismatched record manufacturing a
 * contradiction. Without it `contested` becomes noise nobody reads, and the whole distinction
 * degrades into the ambiguity it was built to remove.
 *
 * ⚠️ Every exclusion is RECORDED with its reason. The system exposes the condition; it does not
 * quietly drop things. A filter whose decisions cannot be inspected is indistinguishable from a
 * bug.
 */

/** #42's ladder, MVP-capped at rung 4 (rung 5 is on the far side of #24). */
export const CONFIDENCE = ["unverified", "source-supported", "experimentally-validated", "environment-matched"];

/** #96's verdict axis. Answers what the examination concluded, not how well it examined. */
export const VERDICT = ["unresolved", "supported", "refuted", "contested"];

/**
 * Why an evidence record was excluded. Named rather than boolean, because "not applicable" is
 * three different problems with three different fixes.
 *
 * ⚠️ Exclusion is CLAIM-RELATIVE. A record excluded here is not worthless — it is no evidence
 * FOR THIS ASSERTION, and the same record may be perfectly good evidence for a differently
 * scoped claim. An experiment on Ubuntu says nothing about a RHEL claim and everything about
 * an Ubuntu one. Nothing in the model retires or devalues an excluded record.
 */
export const EXCLUSION = {
  MISSING: "missing",              // the reference does not resolve
  RETIRED: "retired",              // lifecycle is not active
  SUPERSEDED: "superseded",        // a later record replaces it
  ENVIRONMENT_MISMATCH: "environment-mismatch", // observed facts contradict the target
  ISOLATION_INCOMPATIBLE: "isolation-incompatible", // the run explicitly did not claim isolation the claim requires
};

/**
 * Compare an experiment's isolation boundary against isolation the CLAIM requires (#134).
 *
 * ⚠️ **This is not a tier ceiling, and the difference is the whole decision.** Sandbox tier
 * describes how execution was provisioned and what boundary it supplied; confidence describes how
 * well applicable evidence matches a PARTICULAR claim. **Tier is a permission and an execution
 * boundary, never an epistemic rank.** A host run can legitimately reach `environment-matched` for a
 * claim about that host — `AST-0013` is exactly such a claim — and tier 1 cannot lift an
 * OS-containment claim merely because a virtual environment existed.
 *
 * So isolation enters the SAME claim-relative comparison as every other environment fact:
 *   required and matched     → may reach rung 4
 *   required but absent      → "unknown": applicable, capped below rung 4
 *   required and incompatible→ NOT applicable to this claim
 *   not required by the claim→ no comparison, and no global penalty
 */
export function isolationMatch(required = [], boundary = null) {
  // ⚠️ "not-required" is NOT "unknown", and collapsing them would reintroduce the global penalty
  // this decision removes: a claim that never asked about isolation would be capped for failing to
  // satisfy a requirement it does not have.
  if (!Array.isArray(required) || required.length === 0) return "not-required";
  if (!boundary) return "unknown"; // a host run claims no isolation: absent, not contradicted
  const isolates = new Set(boundary.isolates ?? []);
  const doesNot = new Set(boundary.doesNotClaim ?? []);
  // An explicit "does not claim" is a CONTRADICTION of the requirement, not silence about it —
  // which is exactly why DEC-0005 made tier 1 state what it does not do.
  if (required.some((r) => doesNot.has(r))) return "mismatch";
  return required.every((r) => isolates.has(r)) ? "match" : "unknown";
}

/**
 * Combine three-state comparisons conservatively: any mismatch wins, then any unknown.
 * `"not-required"` is neutral — a dimension the claim never asked about cannot weaken it.
 */
export function combineMatch(...parts) {
  const relevant = parts.filter((p) => p !== "not-required");
  if (relevant.length === 0) return "unknown"; // nothing was compared at all
  if (relevant.includes("mismatch")) return "mismatch";
  if (relevant.includes("unknown")) return "unknown";
  return "match";
}

/**
 * Compare an experiment's observed environment against what the assertion is about.
 *
 * Three outcomes, and the middle one is the reason this is not a boolean:
 *   "match"    every target fact is present and equal        → may reach rung 4
 *   "unknown"  no contradiction, but the evidence is silent  → applicable, capped below rung 4
 *   "mismatch" a target fact is present and different        → NOT applicable
 *
 * An absent fact is not a mismatch. It is unknown, and unknown does not reach
 * `environment-matched` — which is precisely what that rung means.
 */
export function environmentMatch(targetFacts = {}, observedFacts = {}) {
  const keys = Object.keys(targetFacts);
  if (keys.length === 0) return "unknown";
  let sawAll = true;
  for (const k of keys) {
    if (!(k in observedFacts)) { sawAll = false; continue; }
    if (String(observedFacts[k]).toLowerCase() !== String(targetFacts[k]).toLowerCase()) return "mismatch";
  }
  return sawAll ? "match" : "unknown";
}

/** One evidence record, judged for applicability to one assertion. */
function judge(assertion, ref, byId, polarity) {
  const rec = byId.get(ref);
  if (!rec) return { ref, polarity, applicable: false, excludedBecause: EXCLUSION.MISSING };
  if (rec.lifecycle && rec.lifecycle !== "active")
    return { ref, polarity, applicable: false, excludedBecause: EXCLUSION.RETIRED, lifecycle: rec.lifecycle };
  if (Array.isArray(rec.supersededBy) && rec.supersededBy.length > 0)
    return { ref, polarity, applicable: false, excludedBecause: EXCLUSION.SUPERSEDED, supersededBy: rec.supersededBy };

  if (rec.kind === "experiment") {
    const factMatch = environmentMatch(assertion.targetEnvironment?.facts, rec.environment?.facts);
    const isoMatch = isolationMatch(assertion.targetEnvironment?.requiresIsolation, rec.environment?.isolationBoundary);
    const match = combineMatch(factMatch, isoMatch);

    // Two different exclusions, because they have two different fixes: a fact mismatch means run it
    // somewhere else; an isolation incompatibility means run it under something that offers the
    // boundary. Reporting both as "environment-mismatch" would hide which.
    if (isoMatch === "mismatch")
      return { ref, polarity, applicable: false, excludedBecause: EXCLUSION.ISOLATION_INCOMPATIBLE, match, factMatch, isoMatch };
    if (factMatch === "mismatch")
      return { ref, polarity, applicable: false, excludedBecause: EXCLUSION.ENVIRONMENT_MISMATCH, match, factMatch, isoMatch };
    // ⚠️ #131 split the axes: `execution` says WHO ran it, `sandboxTier` exists only when a
    // controller supplied the isolation. Both are carried for renderers, and NEITHER feeds the
    // confidence rung today — the tier→rung cap #56 describes is not implemented. See QST-0013.
    return {
      ref, polarity, applicable: true, kind: "experiment", match,
      execution: rec.environment?.execution ?? null,
      sandboxTier: rec.environment?.sandboxTier ?? null,
    };
  }
  return { ref, polarity, applicable: true, kind: "source", match: "unknown" };
}

/**
 * Compute the effective view of one assertion.
 *
 * @param {object} assertion
 * @param {Map<string, object>} evidenceById
 * @returns {{verdict: string, confidence: string, applicable: object[], excluded: object[], reasons: string[]}}
 */
export function effectiveAssertion(assertion, evidenceById) {
  const considered = [
    ...(assertion.supportedBy ?? []).map((ref) => judge(assertion, ref, evidenceById, "support")),
    ...(assertion.refutedBy ?? []).map((ref) => judge(assertion, ref, evidenceById, "refute")),
  ];

  const applicable = considered.filter((c) => c.applicable);
  const excluded = considered.filter((c) => !c.applicable);

  const support = applicable.filter((c) => c.polarity === "support");
  const refute = applicable.filter((c) => c.polarity === "refute");

  // --- verdict, AFTER filtering -------------------------------------------------------------
  let verdict;
  if (support.length === 0 && refute.length === 0) verdict = "unresolved";
  else if (refute.length === 0) verdict = "supported";
  else if (support.length === 0) verdict = "refuted";
  else verdict = "contested";

  // --- confidence: how well examined, on the applicable evidence only ------------------------
  // ⚠️ Deliberately computed over ALL applicable evidence, support and refutation alike. A claim
  // examined by a matched experiment has been examined that well whatever the experiment found.
  // Confidence never encodes which way the answer went — that is what verdict is for, and
  // conflating them is the ambiguity #96 exists to remove.
  let confidence = "unverified";
  if (applicable.length > 0) {
    const hasExperiment = applicable.some((c) => c.kind === "experiment");
    const hasMatched = applicable.some((c) => c.kind === "experiment" && c.match === "match");
    confidence = hasMatched ? "environment-matched" : hasExperiment ? "experimentally-validated" : "source-supported";
  }

  const reasons = [];
  if (verdict === "contested")
    reasons.push(
      "Applicable evidence both supports and refutes this claim. The cause is not inferred: it may be a modelling error, " +
        "an environment mismatch this filter could not see, stale evidence, or genuinely unsettled reality."
    );
  for (const e of excluded)
    reasons.push(`${e.ref} excluded: ${e.excludedBecause}${e.match ? ` (${e.match})` : ""}`);

  return { verdict, confidence, applicable, excluded, reasons };
}

/**
 * May an instruction rest on this claim? #57's threshold plus #96's verdict.
 *
 * `contested` blocks regardless of rung — that is the point of having two axes. A contested
 * claim can be `environment-matched`, which is maximum apparent authority on something its own
 * evidence disputes.
 */
export function mayBecomeInstruction(view, { minimumConfidence = "experimentally-validated" } = {}) {
  if (view.verdict === "contested")
    return { allowed: false, because: "contested", detail: "Applicable evidence disagrees; resolve the disagreement before instructing anyone." };
  if (view.verdict === "refuted")
    return { allowed: false, because: "refuted", detail: "The claim was examined and found false." };
  if (view.verdict === "unresolved")
    return { allowed: false, because: "unresolved", detail: "No applicable evidence bears on this claim." };
  if (CONFIDENCE.indexOf(view.confidence) < CONFIDENCE.indexOf(minimumConfidence))
    return {
      allowed: false,
      because: "below-threshold",
      detail: `Confidence is ${view.confidence}; this instruction requires ${minimumConfidence} (#57).`,
    };
  return { allowed: true };
}
