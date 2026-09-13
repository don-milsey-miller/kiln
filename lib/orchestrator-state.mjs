/**
 * Where a project stands, derived from its files on every call — TSK-0048 (G2), toward ACC-0068.
 *
 * ⚠️ **NOTHING HERE IS STORED, AND NOTHING HERE DECIDES A GATE.** The current stage is the first stage, in
 * canonical definition order, whose existing gate (`evaluateStageGate`) is not ready. Its blockers are that
 * gate's own findings. This module adds exactly two things the gate does not: an order, and one recommended
 * next action picked from the first blocker. It reads the stage definitions, the attestations and the
 * artifacts, and it writes nothing — a stored "current stage" would be a second description of state the
 * attestations already hold, and the two would drift.
 *
 * ⚠️ **ONE LINT PASS.** The project is linted once and that result is handed to every stage gate, as
 * `handoffCompleteness` does. A project-wide lint error therefore blocks the first stage it reaches, which
 * is the existing behaviour and is kept.
 *
 * ⚠️ **ORDER IS CANONICAL, NOT WHAT THE FILESYSTEM RETURNED.** `loadStageDefinitions` and `loadArtifacts` both
 * list directories, and directory order differs between filesystems. Stage ids are sorted by code unit, and
 * lint blockers by path, rule, artifact and message, so the same project yields the same answer everywhere.
 *
 * ⚠️ **THE OPERATOR'S DECISIONS ARE NOT NEXT ACTIONS.** Approving an artifact and attesting an exit criterion
 * belong to the operator. An unattested criterion recommends working toward it; a malformed or unjustified
 * attestation recommends raising it with the operator. No action attests or approves anything.
 *
 * ⚠️ **THIS IS NOT A DISCLOSURE BOUNDARY (F103, F105).** A finding's raw message is never returned, because it
 * can quote project-authored text - a criterion's description, an artifact's contents, a parse error's
 * excerpt - and this module adds no machine path of its own. That is all it promises. The identifiers it keeps
 * so later code can locate an affected artifact - the artifact id and its path relative to the content root -
 * are project-authored and untrusted, and a refusal, including a loader error, keeps its own identity and
 * content (F101). The package boundary (G3) must sanitise every string field, recursively, before returning
 * any result or refusal to a model.
 */

import { loadStageAttestations } from "./attestations.mjs";
import { evaluateStageGate, lintProject } from "./lint.mjs";
import { byCodeUnit } from "./project-scaffold.mjs";
import { loadStageDefinitions } from "./stages.mjs";

export class OrchestratorStateError extends Error {
  constructor(reason, message, detail = {}) {
    super(message);
    this.name = "OrchestratorStateError";
    this.reason = reason;
    this.detail = detail;
  }
}

export const ORCHESTRATOR_STATE_REFUSAL = Object.freeze({
  NO_DEFINITIONS: "stage-definitions-missing",
  UNEXPLAINED_GATE: "stage-not-ready-without-finding",
});

/** The recommendation kinds. None of them attests or approves. */
export const NEXT_ACTION = Object.freeze({
  RESOLVE_FINDING: "resolve-finding",
  RECORD_CAPABILITY_GAP: "record-capability-gap",
  CREATE_ARTIFACT: "create-artifact",
  REVISIT_CRITERION: "revisit-unsatisfied-criterion",
  RESOLVE_GATE_FINDING: "resolve-gate-finding",
  RAISE_WITH_OPERATOR: "raise-with-operator",
  WORK_TOWARD_CRITERION: "work-toward-criterion",
});

/**
 * Which gate finding is dealt with first. A type nothing can author comes before an artifact nobody has
 * written; a criterion found not satisfied comes before one nobody has evaluated. Rules not listed here -
 * a mechanised criterion's own `gate/<id>`, or a rule added later - sit after the attestation problems and
 * before the unevaluated criteria, and keep the gate's own order among themselves.
 */
const GATE_PRECEDENCE = Object.freeze([
  "gate/type-not-implemented",
  "gate/no-artifacts-for-stage-type",
  "gate/criterion-not-satisfied",
  "gate/attestation-malformed",
  "gate/attestation-unjustified",
  null,
  "gate/criterion-pending-human",
]);

const ACTION_FOR_GATE_RULE = Object.freeze({
  "gate/type-not-implemented": NEXT_ACTION.RECORD_CAPABILITY_GAP,
  "gate/no-artifacts-for-stage-type": NEXT_ACTION.CREATE_ARTIFACT,
  "gate/criterion-not-satisfied": NEXT_ACTION.REVISIT_CRITERION,
  "gate/attestation-malformed": NEXT_ACTION.RAISE_WITH_OPERATOR,
  "gate/attestation-unjustified": NEXT_ACTION.RAISE_WITH_OPERATOR,
  "gate/criterion-pending-human": NEXT_ACTION.WORK_TOWARD_CRITERION,
});

const gateRank = (ruleId) => {
  const known = GATE_PRECEDENCE.indexOf(ruleId);
  return known === -1 ? GATE_PRECEDENCE.indexOf(null) : known;
};

/** One blocker shape for both sources: structured fields the finding already holds, and never its message (F103). */
function blocker(source, f) {
  const d = f.details ?? {};
  return {
    source,
    ruleId: f.ruleId,
    severity: f.severity,
    artifactId: f.artifactId ?? null,
    path: f.path ?? null,
    stageId: typeof d.stageId === "string" ? d.stageId : null,
    criterion: typeof d.criterion === "string" ? d.criterion : null,
    type: typeof d.type === "string" ? d.type : null,
    missing: Array.isArray(d.missing) ? [...d.missing] : null,
  };
}

/**
 * Canonical lint order, computed on the findings before they become blockers. The message is only the last
 * tiebreaker between findings that share path, rule and artifact; it is compared here and never returned.
 */
const lintKey = (f) => [f.path ?? "", f.ruleId ?? "", f.artifactId ?? "", f.message ?? ""];

function compareKeys(a, b) {
  for (let i = 0; i < a.length; i++) {
    const c = byCodeUnit(a[i], b[i]);
    if (c !== 0) return c;
  }
  return 0;
}

/** The current stage's blockers: blocking lint findings first, in canonical order, then the gate's findings by precedence. */
function orderedBlockers(gate) {
  const lint = [...gate.blockingArtifactFindings].sort((a, b) => compareKeys(lintKey(a), lintKey(b))).map((f) => blocker("lint", f));
  const gateFindings = gate.gateFindings
    .map((f, index) => ({ b: blocker("gate", f), index }))
    .sort((x, y) => gateRank(x.b.ruleId) - gateRank(y.b.ruleId) || x.index - y.index)
    .map(({ b }) => b);
  return [...lint, ...gateFindings];
}

function nextActionFor(stageId, first) {
  const kind = first.source === "lint" ? NEXT_ACTION.RESOLVE_FINDING : ACTION_FOR_GATE_RULE[first.ruleId] ?? NEXT_ACTION.RESOLVE_GATE_FINDING;
  return {
    kind,
    stageId,
    ruleId: first.ruleId,
    artifactId: first.artifactId,
    path: first.path,
    criterion: first.criterion,
    type: first.type,
  };
}

/**
 * Derive the project's orchestration state.
 *
 * @param {{contentRoot: string, schemas: object, validators: object, activated: string[]}} ctx
 * @param {{toolRoot?: string, stageDefinitions?: object|null}} [opts]  `stageDefinitions` replaces the loaded set, as `evaluateStageGate` allows
 * @returns {{fresh: boolean, complete: boolean, currentStage: {id: string, name: string|null, decidedBy: string|null}|null, blockers: object[], nextAction: object|null}}
 */
export function deriveOrchestratorState(ctx, opts = {}) {
  const defs = "stageDefinitions" in opts ? opts.stageDefinitions : loadStageDefinitions(opts.toolRoot);
  // ⚠️ AN EMPTY SET IS AS MISSING AS NONE (F104). `{}` would otherwise yield no stage ids, no gate to fail,
  // and a project reported complete on the strength of nothing having been checked.
  if (!defs || Object.keys(defs).length === 0)
    throw new OrchestratorStateError(
      ORCHESTRATOR_STATE_REFUSAL.NO_DEFINITIONS,
      "No stage definitions were found, so no stage can be current. Nothing was read further and nothing was written."
    );

  const stageIds = Object.keys(defs).sort(byCodeUnit);
  const lint = lintProject("stageDefinitions" in ctx ? ctx : { ...ctx, stageDefinitions: defs });

  // Every stage's attestations are read before any gate runs, so freshness sees all of them.
  const attestations = stageIds.map((id) => [id, loadStageAttestations(ctx.contentRoot, id)]);
  const fresh = lint.records.length === 0 && attestations.every(([, a]) => Object.keys(a).length === 0);

  for (const [id, stageAttestations] of attestations) {
    const gate = evaluateStageGate(ctx, id, { lint, stageDefinitions: defs, attestations: stageAttestations });
    if (gate.ready) continue;

    const blockers = orderedBlockers(gate);
    if (blockers.length === 0)
      throw new OrchestratorStateError(
        ORCHESTRATOR_STATE_REFUSAL.UNEXPLAINED_GATE,
        `Stage ${id} is not ready and its gate reports no finding${gate.criteriaDeclared ? "" : " (it declares no exit criteria)"}, so no next action can be chosen.`,
        { stageId: id, criteriaDeclared: gate.criteriaDeclared }
      );

    const def = defs[id];
    return {
      fresh,
      complete: false,
      currentStage: { id, name: typeof def.name === "string" ? def.name : null, decidedBy: typeof def.decidedBy === "string" ? def.decidedBy : null },
      blockers,
      nextAction: nextActionFor(id, blockers[0]),
    };
  }

  return { fresh, complete: true, currentStage: null, blockers: [], nextAction: null };
}
