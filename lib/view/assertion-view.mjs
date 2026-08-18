/**
 * The render model for an assertion — 5b's skeleton target.
 *
 * Chosen over rendering raw evidence or a runbook step because it exercises the most of what
 * 5a proved: canonical files read, verdict and confidence DERIVED at render time (#96),
 * supporting / refuting / excluded evidence all shown with the reason each was excluded, and
 * lint findings surfaced as-is.
 *
 * ⚠️ "Excluded" means **not applicable to this claim**, never discredited. The same record may
 * be sound evidence for a differently scoped assertion, and the view says why it did not apply
 * here rather than implying it is worthless.
 *
 * ⚠️ Nothing here persists a derived value. The view is built on every read. If a rung ever
 * needs to be stored — the handoff may materialise one (#96) — it is labelled derived at the
 * point of storage, and this is not that point.
 *
 * ⚠️ It also invents no UI rules. Findings come from lib/lint.mjs and are rendered, not
 * re-judged; a view that decided for itself what counted as a problem would be #47's three
 * enforcement models arriving through the front end.
 */

import { effectiveAssertion, mayBecomeInstruction } from "../effective-assertion.mjs";
import { loadArtifacts, lintProject } from "../lint.mjs";

/**
 * Build the whole view model for a content root.
 * @param {{contentRoot: string, schemas: object, validators: object, activated: string[]}} ctx
 */
export function buildViewModel(ctx) {
  const { findings, records } = lintProject(ctx);
  const byId = new Map(records.filter((r) => r.doc?.id).map((r) => [r.doc.id, r.doc]));

  const evidenceById = new Map([...byId.entries()].filter(([, d]) => d.type === "evidence"));
  const findingsFor = (id) => findings.filter((f) => f.artifactId === id);

  const assertions = [...byId.values()]
    .filter((d) => d.type === "assertion")
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((a) => {
      const view = effectiveAssertion(a, evidenceById);
      const promotion = mayBecomeInstruction(view);
      return {
        assertion: a,
        ...view,
        promotion,
        // Evidence, resolved for display. The excluded ones are shown WITH their reason —
        // a filter whose decisions are invisible is indistinguishable from a bug.
        supporting: view.applicable.filter((c) => c.polarity === "support").map((c) => decorate(c, evidenceById)),
        refuting: view.applicable.filter((c) => c.polarity === "refute").map((c) => decorate(c, evidenceById)),
        excludedEvidence: view.excluded.map((c) => decorate(c, evidenceById)),
        findings: findingsFor(a.id),
      };
    });

  const steps = [...byId.values()]
    .filter((d) => d.type === "runbook-step")
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((s) => ({ step: s, findings: findingsFor(s.id) }));

  return {
    assertions,
    steps,
    counts: {
      artifacts: records.length,
      assertions: assertions.length,
      contested: assertions.filter((a) => a.verdict === "contested").length,
      refuted: assertions.filter((a) => a.verdict === "refuted").length,
    },
    findings,
  };
}

function decorate(c, evidenceById) {
  const doc = evidenceById.get(c.ref) ?? null;
  return {
    ...c,
    title: doc?.title ?? null,
    summary: doc?.summary ?? null,
    kind: doc?.kind ?? c.kind ?? null,
    outcome: doc?.outcome ?? null,
    observedAt: doc?.observedAt ?? null,
    environment: doc?.environment ?? null,
  };
}
