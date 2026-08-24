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
 *   2. **every stage gate passes** — the handoff COMPOSES `evaluateStageGate` per stage rather than
 *      re-deriving a subset of it. It used to check attestations only, which silently exempted
 *      capability gaps and missing stage outputs: this repo published `ready: true` with zero
 *      blockers while stage 03-discovery was NOT READY. #46 has two boundaries and one engine.
 *   3. evaluated **now** — the caller re-runs this immediately before snapshotting, under the same
 *      lock, and never reuses a result from an earlier command.
 *
 * ⚠️ `n/a` is a satisfied outcome and `pending` is not. #93's three verdicts exist so a PM who LOOKED
 * and said "not applicable" is distinguishable from nobody having looked, and only the second blocks.
 */

import { evaluateHandoffGate, evaluateStageGate, lintProject } from "../lint.mjs";
import { loadStageDefinitions } from "../stages.mjs";
import { loadStageAttestations } from "../attestations.mjs";

export const BLOCKED = {
  LINT: "blocking-lint-findings",
  NOT_SATISFIED: "criterion-not-satisfied",
  PENDING: "criterion-not-attested",
  NO_DEFINITIONS: "no-stage-definitions",
  NO_CRITERIA: "stage-declares-no-exit-criteria",
  STAGE_GATE: "stage-gate-failing",
  TASK_UNACCOUNTABLE: "task-without-acceptance-criteria",
  UNAPPROVED_EXECUTABLE: "executable-content-not-approved",
};

/**
 * The stage gate speaks in rule ids; the handoff report speaks in blocker reasons. These two
 * mappings are the ones callers already depend on — everything else arrives as `STAGE_GATE` with its
 * `ruleId` attached, so a new gate rule surfaces immediately rather than waiting to be translated.
 */
const STAGE_BLOCK_REASON = {
  "gate/criterion-pending-human": BLOCKED.PENDING,
  "gate/criterion-not-satisfied": BLOCKED.NOT_SATISFIED,
};

/**
 * Every active task must have at least one acceptance criterion.
 *
 * ⚠️ **Added after the first real publication.** `TSK-0002` shipped with `acceptedBy: []`, which means
 * **nothing in the package could say when it was finished** — a recipient could work on it forever and
 * no artifact would disagree. It is not the same as an outstanding task: an outstanding task has a
 * finish line nobody has crossed, and this one has no finish line at all.
 *
 * ⚠️ Scoped to ACTIVE tasks. A retired task is not work anybody is being handed.
 */
function unaccountableTasks(records) {
  return records
    .map((r) => r.doc)
    .filter((d) => d?.type === "task" && (d.lifecycle ?? "active") === "active")
    .filter((d) => !(d.acceptedBy ?? []).length)
    .map((d) => ({
      reason: BLOCKED.TASK_UNACCOUNTABLE,
      detail:
        `${d.id} ("${d.title ?? d.statement ?? ""}") has no acceptance criteria, so nothing in the ` +
        `package can say when it is done. Give it an objective criterion or retire it.`,
      taskId: d.id,
    }));
}

/**
 * @param {{contentRoot: string, schemas: object, validators: object, activated: string[]}} ctx
 * @param {{toolRoot?: string}} [opts]
 * @returns {{ready: boolean, blockers: Array<{reason: string, detail: string, stageId?: string, criterion?: string}>, artifactCount: number}}
 */
export function handoffCompleteness(ctx, opts = {}) {
  const blockers = [];

  // One lint pass, shared by the handoff gate and by every stage gate composed below. Linting once
  // per gate would cost eleven passes to answer one question, and — worse — would let two gates
  // disagree because they read the content at two different moments.
  const lint = lintProject(ctx);
  const { records } = lint;
  const gate = evaluateHandoffGate(ctx, { lint });
  blockers.push(...unaccountableTasks(records));
  blockers.push(...unapprovedExecutable(records));
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
    // ⚠️ COMPOSE THE STAGE GATE; DO NOT RE-DERIVE IT. This loop used to read attestations directly
    // and check only those, which made the handoff boundary a PARTIAL copy of the stage boundary —
    // and a partial copy is worse than a second implementation, because it agrees often enough to
    // look authoritative. It missed everything `evaluateStageGate` knows and this loop did not:
    // `gate/type-not-implemented`, `gate/no-artifacts-for-stage-type`, malformed and unjustified
    // attestations, and every mechanised criterion. This project WAS the defect report: stage
    // 03-discovery was NOT READY (`research-finding` is activated with no schema and no typed tool)
    // while `handoffCompleteness` reported ready with zero blockers. #46's two boundaries ask
    // different questions of the same engine; they do not get different engines.
    const stage = evaluateStageGate(ctx, def.id, {
      lint,
      stageDefinitions: defs,
      attestations: loadStageAttestations(ctx.contentRoot, def.id) ?? {},
    });

    // A stage with no declared exit criteria cannot be judged complete. `evaluateStageGate` already
    // refuses to report ready on criteria it has never seen; the handoff must not be more permissive
    // than the transition it is downstream of.
    if (!stage.criteriaDeclared)
      blockers.push({
        reason: BLOCKED.NO_CRITERIA,
        detail: `Stage ${def.id} declares no exit criteria, so nothing can say it is finished (#34, #90).`,
        stageId: def.id,
      });

    for (const f of stage.gateFindings)
      blockers.push({
        reason: STAGE_BLOCK_REASON[f.ruleId] ?? BLOCKED.STAGE_GATE,
        detail: `Stage ${def.id}: ${f.message}`,
        stageId: def.id,
        ruleId: f.ruleId,
        ...(f.details?.criterion ? { criterion: f.details.criterion } : {}),
      });
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

/**
 * DEC-0015: executable handoff content must be reviewed before it is published.
 *
 * ⚠️ **The line is drawn at EXECUTABILITY, not at importance.** A draft question is a note; a draft
 * runbook step is an instruction someone follows. The first real package shipped 98 artifacts as
 * `draft` while describing itself as approved state — an ambiguity visible to machine consumers,
 * which is the strongest kind of defect report because the package said two things at once.
 *
 * ⚠️ `amended` passes as well as `approved`: #16 makes `amended` mean "was approved, then changed",
 * which is a reviewed artifact with a flag on it — not an unreviewed one.
 */
const EXECUTABLE_TYPES = new Set(["runbook-step", "task"]);

function unapprovedExecutable(records) {
  return records
    .map((r) => r.doc)
    .filter((d) => d && EXECUTABLE_TYPES.has(d.type) && (d.lifecycle ?? "active") === "active")
    .filter((d) => d.reviewStatus !== "approved" && d.reviewStatus !== "amended")
    .map((d) => ({
      reason: BLOCKED.UNAPPROVED_EXECUTABLE,
      detail:
        `${d.id} (${d.type}) is \`${d.reviewStatus}\`. Executable handoff content must be reviewed ` +
        `before publication (DEC-0015) — a recipient acts on it.`,
      artifactId: d.id,
    }));
}
