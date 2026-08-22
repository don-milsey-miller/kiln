/**
 * `TSK-0002` — what stage 6 actually has to check.
 *
 * ⚠️ **Derived from graph USE, never from an author's flag.** Stage 6's criterion reads *every
 * load-bearing assertion has reached its required confidence rung*, and its scope was
 * `assertion.loadBearing` — an optional boolean somebody sets by hand. Running stage 6 found that
 * criterion **passing vacuously**: exactly one assertion carried the flag, while `RBS-0001` rested on
 * `AST-0002`, which did not. **An instruction resting on an unflagged claim satisfied the criterion
 * while being precisely what #57 exists to prevent.**
 *
 * The scope is now the set of assertions that **active instructions actually rest on**, which is the
 * same move #84 made for runbook membership and #143 made for the role set: read the edges rather
 * than store a summary of them.
 *
 * ⚠️ **`loadBearing` is not consulted here and the name does not appear in this file** — asserted by a
 * test, because a scope that quietly still read the flag would look identical from outside.
 *
 * ⚠️ **The vacuity does not disappear; it MOVES, and the move is the point.** With no active runbook
 * steps the scope is empty and the criterion is again satisfiable with nothing checked — but now that
 * is a **fact about the plan** (nothing rests on anything) rather than a fact about whether someone
 * remembered to tick a box. The first is visible in the artifact graph; the second was visible
 * nowhere. `scopeBasis` reports which case you are in so an attestation can say so.
 */

/** Instruction-bearing types whose premises stage 6 must check. Extended when a new one appears. */
const INSTRUCTION_TYPES = new Set(["runbook-step"]);

const isActive = (d) => (d.lifecycle ?? "active") === "active";

/**
 * @param {Array<{doc: object}>} records lint records, or anything with `.doc`
 * @returns {{assertionIds: string[], basis: Array<{instruction: string, restsOn: string[]}>, empty: boolean}}
 */
export function stage6Scope(records) {
  const docs = records.map((r) => r.doc ?? r).filter(Boolean);
  const instructions = docs.filter((d) => INSTRUCTION_TYPES.has(d.type) && isActive(d));

  const basis = instructions
    .map((d) => ({ instruction: d.id, restsOn: [...(d.restsOn ?? [])].sort() }))
    .sort((a, b) => a.instruction.localeCompare(b.instruction));

  const assertionIds = [...new Set(basis.flatMap((b) => b.restsOn))].sort();
  return { assertionIds, basis, empty: assertionIds.length === 0 };
}

/**
 * Human-readable basis for the attestation, so a `satisfied` or `n/a` says WHY.
 *
 * ⚠️ An empty scope is reported as `n/a` rather than `satisfied`. An empty set clears every bar
 * vacuously, and calling that satisfied is an assurance nobody earned — the same distinction stage 9's
 * runbook criterion had to draw when `RBS-0001` was retired.
 */
export function describeStage6Scope(scope) {
  if (scope.empty)
    return {
      suggested: "n/a",
      detail:
        "No active instruction rests on any assertion, so there is nothing for the rung threshold to " +
        "apply to. Recorded as n/a rather than satisfied: an empty set clears every bar vacuously.",
    };
  return {
    suggested: "evaluate",
    detail:
      `${scope.assertionIds.length} assertion(s) are under an active instruction: ` +
      scope.basis.map((b) => `${b.instruction} rests on ${b.restsOn.join(", ")}`).join("; ") +
      ". Each must have reached the rung its instruction's class requires (#57).",
  };
}
