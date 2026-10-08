import { readProjectOverview } from "./_read/planning.js";
import { deriveStagePresentation, STAGE_PRESENTATION } from "./_review/stage-presentation.js";
import StageStateMark from "./_review/stage-state-mark.js";
import CriterionLabel from "./_review/criterion-label.js";

/**
 * The project view's stage navigation — CMP-0015, TSK-0007.
 *
 * ⚠️ THIS COMPONENT IS THE READ. It is rendered as a literal `<StagesPanel />` inside a `<Suspense>`
 * at its call site, and it may only ever be rendered that way: `lint:shell` refuses an alias, a
 * render prop, a variable, or a boundary that lives in a parent layout, because each of those moves
 * the enclosure question somewhere the analysis cannot answer.
 *
 * ⚠️ NOTHING HERE IS STORED. The current stage is the first stage whose gate is not ready, computed
 * on every request from stage definitions plus recorded attestations (#16). There is no status field
 * to go stale, which is the property `ACC-0013`'s second half checks by asserting no such field
 * exists anywhere under the content root.
 *
 * ⚠️ COUNTS, LINT FINDINGS AND MALFORMED-FILE REPORTING ARE DELIBERATELY ABSENT. They are TSK-0016's,
 * and they are the half of this view that fails SILENTLY — a wrong total looks exactly like a right
 * one. Keeping them apart means each gets reviewed for the way it actually breaks.
 */

export default async function StagesPanel() {
  const { stages, currentStage } = await readProjectOverview();
  const current = stages.find((s) => s.id === currentStage) ?? null;
  const currentPresentation = current
    ? deriveStagePresentation(current.criteria, current.ready)
    : STAGE_PRESENTATION.ready;

  return (
    <div data-vpw-stages={String(stages.length)} style={{ display: "flex", flexDirection: "column", gap: "28px" }}>
      <section
        data-vpw-current={currentStage ?? "none"}
        data-vpw-gate-state={currentPresentation.state}
        style={{
          border: "1px solid #ccc",
          borderLeft: `6px solid ${currentPresentation.colour}`,
          borderRadius: "4px",
          padding: "16px 20px",
          display: "flex",
          flexDirection: "column",
          gap: "8px",
        }}
      >
        <p style={{ margin: 0, fontSize: ".8rem", textTransform: "uppercase", letterSpacing: ".04em", color: "#666" }}>
          Current stage
        </p>
        {current ? (
          <>
            <div style={{ display: "flex", alignItems: "center", gap: "12px", flexWrap: "wrap" }}>
              <span style={{ fontSize: "1.35rem", fontWeight: 600 }}>{current.title}</span>
              <span style={{ display: "inline-flex", alignItems: "center", gap: "5px", fontSize: ".8rem", fontWeight: 700, color: currentPresentation.colour }}>
                <StageStateMark state={currentPresentation.state} />
                {currentPresentation.label}
              </span>
            </div>
            {/* #183: what holds the gate, in the definition's own words, with each stable id beside it as detail. */}
            {currentPresentation.criteria.length === 0 ? (
              <div data-vpw-blockers="0" style={{ color: "#444" }}>
                Blocked on: another gate requirement.
              </div>
            ) : currentPresentation.criteria.length === 1 ? (
              <div data-vpw-blockers="1" style={{ color: "#444", display: "flex", flexDirection: "column", gap: "4px" }}>
                <span>{currentPresentation.state === "awaiting-attestation" ? "Awaiting:" : "Blocked on:"}</span>
                {" "}
                <CriterionLabel id={currentPresentation.criteria[0].id} describe={currentPresentation.criteria[0].describe} />
              </div>
            ) : (
              <div data-vpw-blockers={String(currentPresentation.criteria.length)} style={{ color: "#444", display: "flex", flexDirection: "column", gap: "4px" }}>
                <span id="vpw-blockers-heading">{currentPresentation.state === "awaiting-attestation" ? "Awaiting:" : "Blocked on:"}</span>
                {" "}
                <ul aria-labelledby="vpw-blockers-heading" style={{ margin: 0, paddingLeft: "20px", display: "flex", flexDirection: "column", gap: "8px" }}>
                  {currentPresentation.criteria.map((criterion) => (
                    <li key={criterion.id} data-vpw-blocker={criterion.id}>
                      <CriterionLabel id={criterion.id} describe={criterion.describe} />
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </>
        ) : (
          <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
            <span style={{ fontSize: "1.35rem", fontWeight: 600 }}>Every gate is ready</span>
            <span style={{ display: "inline-flex", alignItems: "center", gap: "5px", fontSize: ".8rem", fontWeight: 700, color: STAGE_PRESENTATION.ready.colour }}>
              <StageStateMark state="ready" />
              READY
            </span>
          </div>
        )}
      </section>

      <section style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
        <p style={{ margin: 0, fontSize: ".8rem", textTransform: "uppercase", letterSpacing: ".04em", color: "#666" }}>
          Stages
        </p>
        <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
          {stages.map((s) => {
            const presentation = deriveStagePresentation(s.criteria, s.ready);
            return (
              <a
                key={s.id}
                href={`/stage/${s.id}`}
                data-vpw-stage={s.id}
                data-vpw-ready={String(s.ready)}
                data-vpw-gate-state={presentation.state}
                style={{
                  display: "grid",
                  gridTemplateColumns: "32px minmax(0, 1fr) 116px",
                  gap: "12px",
                  alignItems: "center",
                  border: "1px solid #e2e2e2",
                  borderLeft: `4px solid ${presentation.colour}`,
                  borderRadius: "4px",
                  padding: "9px 14px",
                  textDecoration: "none",
                  color: "inherit",
                }}
              >
                <span style={{ color: "#888", fontVariantNumeric: "tabular-nums" }}>{s.id.slice(0, 2)}</span>
                <span style={{ fontWeight: 500, minWidth: 0 }}>{s.title}</span>
                <span
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "flex-end",
                    gap: "5px",
                    fontSize: ".78rem",
                    whiteSpace: "nowrap",
                    color: presentation.colour,
                  }}
                >
                  <StageStateMark state={presentation.state} />
                  {presentation.shortLabel}
                </span>
              </a>
            );
          })}
        </div>
      </section>
    </div>
  );
}
