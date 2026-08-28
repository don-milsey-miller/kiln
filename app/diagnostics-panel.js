import { readProjectOverview } from "./_read/planning.js";

/**
 * The project view's totals, lint surface and unreadable-file reporting — CMP-0015, TSK-0016.
 *
 * ⚠️ THIS IS THE HALF OF THE VIEW THAT FAILS SILENTLY, which is why it is a separate component and a
 * separate task. A wrong stage is obvious; a wrong total looks exactly like a right one. AST-0035
 * measured the skeleton printing 178 artifacts while rendering 177 — the count is what turns an
 * incomplete page into a misleading one, because an operator reading the total has been told the
 * missing thing is there.
 *
 * ⚠️ EVERY TOTAL COMES FROM THE PARSED SET FOR THIS REQUEST. The reader counts records that produced
 * a document and nothing else — never a file count, never a cached summary, never something the page
 * already displayed. A file that failed to parse contributes to no total and appears below instead.
 *
 * ⚠️ LINT FINDINGS ARE SURFACED, NEVER RE-JUDGED (#47). Their severity and message are printed as
 * reported; this component does not decide what a finding means, and does not recompute a verdict
 * the lint already reached.
 *
 * ⚠️ PATHS AND DIAGNOSTICS ARE RENDERED AS TEXT. JSX escapes string children, and that is being
 * relied on deliberately: a parse error quotes content from a file the agent wrote, so rendering it
 * as markup would let a malformed artifact inject into the page that reports it malformed.
 */

const SEVERITY_TONE = {
  error: "#c62828",
  warning: "#ef6c00",
  advisory: "#666",
};

export default async function DiagnosticsPanel() {
  const { counts, artifactCount, unreadable, findings } = await readProjectOverview();
  const types = Object.keys(counts).sort();

  return (
    <div data-vpw-diagnostics={String(artifactCount)} style={{ display: "flex", flexDirection: "column", gap: "28px" }}>
      {unreadable.length > 0 ? (
        <section
          data-vpw-unreadable={String(unreadable.length)}
          style={{
            border: "1px solid #d9a3a3",
            borderLeft: "6px solid #c62828",
            background: "#fdf6f6",
            borderRadius: "4px",
            padding: "15px 18px",
            display: "flex",
            flexDirection: "column",
            gap: "8px",
          }}
        >
          <div style={{ display: "flex", alignItems: "baseline", gap: "10px", flexWrap: "wrap" }}>
            <span style={{ display: "inline-flex", alignItems: "center", gap: "6px", fontWeight: 600, color: "#a01f1f" }}>
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true">
                <path d="M6 6l12 12M18 6L6 18" />
              </svg>
              {unreadable.length === 1 ? "1 artifact could not be read" : `${unreadable.length} artifacts could not be read`}
            </span>
            <span style={{ fontSize: ".78rem", color: "#a01f1f" }}>
              not shown below, and not counted
            </span>
          </div>

          {unreadable.map((u) => (
            <div
              key={u.path}
              data-vpw-unreadable-at={`${u.path}:${u.line ?? "?"}:${u.column ?? "?"}`}
              style={{
                background: "#fff",
                border: "1px solid #e8cfcf",
                borderRadius: "4px",
                padding: "10px 12px",
                display: "flex",
                flexDirection: "column",
                gap: "4px",
                fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
                fontSize: ".85rem",
              }}
            >
              <span>{`${u.path}:${u.line ?? "?"}:${u.column ?? "?"}`}</span>
              <span style={{ color: "#7a2020" }}>{u.message}</span>
            </div>
          ))}

          <span style={{ fontSize: ".84rem", color: "#6b3030" }}>
            Every other artifact rendered normally. Fix the file and this page will show it.
          </span>
        </section>
      ) : null}

      <section style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: "16px", flexWrap: "wrap" }}>
          <p style={{ margin: 0, fontSize: ".8rem", textTransform: "uppercase", letterSpacing: ".04em", color: "#666" }}>
            Artifacts
          </p>
          <span style={{ color: "#888", fontSize: ".8rem" }}>every total below was parsed on this request</span>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(5, minmax(0, 1fr))", gap: "10px" }}>
          {types.map((type) => (
            <div
              key={type}
              data-vpw-count={type}
              data-vpw-count-value={String(counts[type])}
              style={{
                border: "1px solid #e2e2e2",
                borderRadius: "4px",
                padding: "10px 12px",
                display: "flex",
                flexDirection: "column",
                gap: "1px",
                minWidth: 0,
              }}
            >
              <span style={{ fontSize: "1.3rem", fontWeight: 600, fontVariantNumeric: "tabular-nums" }}>
                {counts[type]}
              </span>
              <span style={{ color: "#888", fontSize: ".8rem" }}>{type}</span>
            </div>
          ))}
        </div>
      </section>

      <section style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
        <p style={{ margin: 0, fontSize: ".8rem", textTransform: "uppercase", letterSpacing: ".04em", color: "#666" }}>
          Lint
        </p>
        {findings.length === 0 ? (
          <div
            data-vpw-lint="0"
            style={{
              border: "1px solid #e2e2e2",
              borderLeft: "4px solid #2e7d32",
              borderRadius: "4px",
              padding: "12px 14px",
              display: "flex",
              alignItems: "center",
              gap: "8px",
            }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#2e7d32" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M4 12l5 5L20 6" />
            </svg>
            <span style={{ fontWeight: 500 }}>No findings.</span>
          </div>
        ) : (
          <div data-vpw-lint={String(findings.length)} style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
            {findings.map((f, i) => (
              <div
                key={`${f.ruleId}-${i}`}
                data-vpw-finding={f.ruleId}
                style={{
                  border: "1px solid #e2e2e2",
                  borderLeft: `4px solid ${SEVERITY_TONE[f.severity] ?? "#999"}`,
                  borderRadius: "4px",
                  padding: "10px 14px",
                  display: "flex",
                  flexDirection: "column",
                  gap: "3px",
                }}
              >
                <div style={{ display: "flex", alignItems: "baseline", gap: "10px", flexWrap: "wrap" }}>
                  <code style={{ background: "#f6f6f6", padding: "0 .25rem", borderRadius: "3px", fontSize: ".85em" }}>
                    {f.ruleId}
                  </code>
                  <span style={{ fontSize: ".78rem", color: SEVERITY_TONE[f.severity] ?? "#999" }}>{f.severity}</span>
                </div>
                <div style={{ color: "#444", fontSize: ".9rem" }}>{f.message}</div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
