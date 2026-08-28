import { notFound } from "next/navigation";
import { readStageCriteria } from "../../_read/planning.js";

/**
 * A stage's exit criteria with their recorded attestations — the first of the stage view's two
 * independent reads.
 *
 * ⚠️ THE UNKNOWN-STAGE CHECK LIVES HERE, NOT IN THE PAGE. A route entry that awaited the reader
 * would have nothing above it to wrap the read, and `lint:shell` refuses that outright. So the page
 * stays synchronous and this component — which is already reading — is where an id that matches no
 * stage becomes a 404.
 *
 * ⚠️ THE LOOKUP IS AN EXACT MATCH AGAINST THE DEFINITIONS, never a path built from the URL segment.
 * `readStageCriteria` indexes an object by key; nothing is concatenated onto a directory, so there
 * is no sanitising step that could be got wrong.
 */

const VERDICT = {
  satisfied: { colour: "#2e7d32", label: "satisfied" },
  "not-satisfied": { colour: "#c62828", label: "not satisfied" },
  "n/a": { colour: "#999", label: "n/a" },
  unattested: { colour: "#ef6c00", label: "unattested" },
};

function Mark({ result }) {
  if (result === "satisfied")
    return (
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M4 12l5 5L20 6" />
      </svg>
    );
  if (result === "n/a")
    return (
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" aria-hidden="true">
        <path d="M5 12h14" />
      </svg>
    );
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" aria-hidden="true">
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  );
}

export default async function CriteriaPanel({ stageId }) {
  const stage = await readStageCriteria(stageId);
  if (!stage) notFound();

  return (
    <section data-vpw-criteria={stage.stageId} style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: "12px", flexWrap: "wrap" }}>
        <h1 style={{ fontSize: "1.35rem", fontWeight: 600, margin: 0 }}>{stage.title}</h1>
        <span
          data-vpw-stage-ready={String(stage.ready)}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: "5px",
            fontSize: ".8rem",
            fontWeight: 700,
            color: stage.ready ? "#2e7d32" : "#c62828",
          }}
        >
          <Mark result={stage.ready ? "satisfied" : "not-satisfied"} />
          {stage.ready ? "READY" : "NOT READY"}
        </span>
      </div>

      <p style={{ margin: 0, fontSize: ".8rem", textTransform: "uppercase", letterSpacing: ".04em", color: "#666" }}>
        Exit criteria
      </p>

      {stage.criteria.map((c) => {
        const v = VERDICT[c.result] ?? VERDICT.unattested;
        return (
          <div
            key={c.id}
            data-vpw-criterion={c.id}
            style={{
              border: "1px solid #e2e2e2",
              borderLeft: `4px solid ${v.colour}`,
              borderRadius: "4px",
              padding: "12px 14px",
              display: "flex",
              flexDirection: "column",
              gap: "6px",
            }}
          >
            <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: "14px", flexWrap: "wrap" }}>
              <code style={{ background: "#f6f6f6", padding: "0 .25rem", borderRadius: "3px", fontSize: ".85em", overflowWrap: "anywhere", fontWeight: 500 }}>
                {c.id}
              </code>
              <span style={{ display: "inline-flex", alignItems: "center", gap: "5px", fontSize: ".78rem", whiteSpace: "nowrap", color: v.colour }}>
                <Mark result={c.result} />
                {v.label}
                {c.decidedBy ? ` · ${c.decidedBy}` : ""}
              </span>
            </div>
            {c.describe ? <div style={{ color: "#444", fontSize: ".9rem" }}>{c.describe}</div> : null}
            {c.reason ? (
              <div style={{ borderLeft: "2px solid #e2e2e2", paddingLeft: "10px", color: "#555", fontSize: ".85rem" }}>
                {c.reason.length > 320 ? `${c.reason.slice(0, 320)}…` : c.reason}
              </div>
            ) : null}
          </div>
        );
      })}
    </section>
  );
}
