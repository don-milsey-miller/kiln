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
  const attested = stage.criteria.filter((criterion) => criterion.result !== "unattested").length;

  return (
    <section style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
      <details data-vpw-criteria={stage.stageId} style={{ border: "1px solid #dedbd4", borderRadius: "8px", background: "#faf9f6" }}>
        <summary
          data-vpw-criteria-summary={`${attested}/${stage.criteria.length}`}
          style={{ cursor: "pointer", padding: "12px 14px", fontWeight: 650 }}
        >
          Exit criteria · {attested} of {stage.criteria.length} attested · {stage.ready ? "Ready" : "Not ready"}
        </summary>
        <div data-vpw-criteria-details style={{ padding: "0 14px 14px", display: "flex", flexDirection: "column", gap: "8px" }}>
          <p style={{ margin: 0, color: "#666", fontSize: ".82rem" }}>
            Live attestation status is shown here. Canonical criterion definitions remain in the stage document above.
          </p>
          {stage.criteria.map((c) => {
            const v = VERDICT[c.result] ?? VERDICT.unattested;
            return (
              <div
                key={c.id}
                data-vpw-criterion={c.id}
                style={{ borderLeft: `4px solid ${v.colour}`, padding: "8px 10px", background: "#fff", display: "flex", flexDirection: "column", gap: "5px" }}
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
                {c.reason ? (
                  <div style={{ borderLeft: "2px solid #e2e2e2", paddingLeft: "10px", color: "#555", fontSize: ".85rem" }}>
                    {c.reason.length > 320 ? `${c.reason.slice(0, 320)}…` : c.reason}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      </details>
    </section>
  );
}
