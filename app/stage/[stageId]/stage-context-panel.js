import { notFound } from "next/navigation";
import { readStageContext } from "../../_read/planning.js";

function GateMark({ ready }) {
  return ready ? (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 12l5 5L20 6" />
    </svg>
  ) : (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true">
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  );
}

/** Derived workflow position and review guidance; this component never writes project state. */
export default async function StageContextPanel({ stageId }) {
  const stage = await readStageContext(stageId);
  if (!stage) notFound();

  return (
    <section
      data-vpw-stage-context={stage.stageId}
      data-vpw-stage-position={`${stage.position}/${stage.total}`}
      data-vpw-stage-current={String(stage.isCurrent)}
      style={{ display: "flex", flexDirection: "column", gap: "12px" }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "14px", flexWrap: "wrap" }}>
        <p style={{ margin: 0, color: stage.isCurrent ? "#7a4b16" : "#666", fontSize: ".78rem", fontWeight: 700, letterSpacing: ".05em", textTransform: "uppercase" }}>
          {stage.isCurrent ? "Current stage" : "Workflow stage"}
        </p>
        <span
          data-vpw-stage-ready={String(stage.ready)}
          style={{ display: "inline-flex", alignItems: "center", gap: "6px", color: stage.ready ? "#2e7d32" : "#a01f1f", fontSize: ".8rem", fontWeight: 700 }}
        >
          <GateMark ready={stage.ready} />
          {stage.ready ? "READY" : "NOT READY"}
        </span>
      </div>

      <h1 style={{ margin: 0, fontSize: "clamp(1.65rem, 4vw, 2.25rem)", lineHeight: 1.15, letterSpacing: "-.02em" }}>
        Stage {stage.position} of {stage.total} <span style={{ color: "#777", fontWeight: 450 }}>—</span> {stage.title}
      </h1>

      <p style={{ margin: 0, maxWidth: "68ch", color: "#4f4b45" }}>
        Review the stage document below. Stage attestation is completed in the Kiln terminal; artifact review remains a separate action on this page.
      </p>

      <nav aria-label="Stage navigation" style={{ display: "flex", justifyContent: "space-between", gap: "14px", flexWrap: "wrap" }}>
        {stage.previous ? (
          <a data-vpw-stage-prev={stage.previous.id} rel="prev" href={`/stage/${stage.previous.id}`} style={{ color: "#1a4f8a" }}>
            ← Stage {stage.position - 1}: {stage.previous.title}
          </a>
        ) : <span />}
        {stage.next ? (
          <a data-vpw-stage-next={stage.next.id} rel="next" href={`/stage/${stage.next.id}`} style={{ color: "#1a4f8a", marginLeft: "auto", textAlign: "right" }}>
            Stage {stage.position + 1}: {stage.next.title} →
          </a>
        ) : null}
      </nav>
    </section>
  );
}
