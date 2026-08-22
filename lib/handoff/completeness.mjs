/**
 * May this project publish a handoff?
 *
 * ⚠️ **A clean lint is not the test, and this project is the proof.** `evaluateHandoffGate` reports
 * ready when no artifact has a blocking finding — and today this repo lints clean while stage 5's
 * `requirements-traced-to-components` is attested **`not-satisfied`**, because REQ-0010 traces only to
 * a component that does not exist yet. **Artifact validity says the plan is well-formed; it says
 * nothing about whether the plan is FINISHED.**
 *
 * So the predicate is the conjunction of three things:
 *   1. no blocking lint findings (artifact validity);
 *   2. every stage that declares exit criteria has them attested, and **none attested
 *      `not-satisfied`** (stage completeness);
 *   3. evaluated **now** — the caller re-runs this immediately before snapshotting, under the same
 *      lock, and never reuses a result from an earlier command.
 *
 * ⚠️ `n/a` is a satisfied outcome and `pending` is not. #93's three verdicts exist so a PM who LOOKED
 * and said "not applicable" is distinguishable from nobody having looked, and only the second blocks.
 */

import { evaluateHandoffGate, lintProject } from "../lint.mjs";
import { loadStageDefinitions } from "../stages.mjs";
import { loadStageAttestations } from "../attestations.mjs";

export const BLOCKED = {
  LINT: "blocking-lint-findings",
  NOT_SATISFIED: "criterion-not-satisfied",
  PENDING: "criterion-not-attested",
  NO_DEFINITIONS: "no-stage-definitions",
};

/**
 * @param {{contentRoot: string, schemas: object, validators: object, activated: string[]}} ctx
 * @param {{toolRoot?: string}} [opts]
 * @returns {{ready: boolean, blockers: Array<{reason: string, detail: string, stageId?: string, criterion?: string}>, artifactCount: number}}
 */
export function handoffCompleteness(ctx, opts = {}) {
  const blockers = [];

  const gate = evaluateHandoffGate(ctx);
  for (const f of gate.blocking)
    blockers.push({ reason: BLOCKED.LINT, detail: `${f.ruleId}: ${f.message}`, ruleId: f.ruleId });

  const defs = loadStageDefinitions(opts.toolRoot);
  if (!defs) {
    // #90 makes stages/ the authority on exit criteria. An absent authority cannot approve a
    // publish, so this fails closed rather than treating "no criteria" as "no objections".
    blockers.push({ reason: BLOCKED.NO_DEFINITIONS, detail: "No stage definitions found; completeness cannot be evaluated." });
    return { ready: false, blockers, artifactCount: gate.artifactCount };
  }

  for (const def of Object.values(defs)) {
    const criteria = def.exitCriteria ?? [];
    if (criteria.length === 0) continue;
    const attestations = loadStageAttestations(ctx.contentRoot, def.id) ?? {};
    for (const c of criteria) {
      const a = attestations[c.id];
      if (!a)
        blockers.push({
          reason: BLOCKED.PENDING,
          detail: `Stage ${def.id}: "${c.describe ?? c.id}" has no attestation. Nobody has looked (#93).`,
          stageId: def.id,
          criterion: c.id,
        });
      else if (a.result === "not-satisfied")
        blockers.push({
          reason: BLOCKED.NOT_SATISFIED,
          detail: `Stage ${def.id}: "${c.describe ?? c.id}" is attested not-satisfied. ${a.reason ?? ""}`.trim(),
          stageId: def.id,
          criterion: c.id,
        });
      // `satisfied` and `n/a` both pass: an n/a is a PM who looked and said it does not apply.
    }
  }

  return { ready: blockers.length === 0, blockers, artifactCount: gate.artifactCount };
}

/** Group blockers for display without losing any of them. */
export function summariseBlockers(blockers) {
  const byReason = new Map();
  for (const b of blockers) {
    if (!byReason.has(b.reason)) byReason.set(b.reason, []);
    byReason.get(b.reason).push(b);
  }
  return [...byReason.entries()].map(([reason, items]) => ({ reason, count: items.length, items }));
}
