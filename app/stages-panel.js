import { readProjectOverview } from "./_read/planning.js";

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

const STATE = {
  ready: { label: "ready", colour: "#2e7d32" },
  blocked: { label: "blocked", colour: "#c62828" },
};

function Icon({ ready }) {
  return ready ? (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 12l5 5L20 6" />
    </svg>
  ) : (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" aria-hidden="true">
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  );
}

export default async function StagesPanel() {
  const { stages, currentStage } = await readProjectOverview();
  const current = stages.find((s) => s.id === currentStage) ?? null;

  return (
    <div data-vpw-stages={String(stages.length)} style={{ display: "flex", flexDirection: "column", gap: "28px" }}>
      <section
        data-vpw-current={currentStage ?? "none"}
        style={{
          border: "1px solid #ccc",
          borderLeft: `6px solid ${current ? STATE.blocked.colour : STATE.ready.colour}`,
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
              <span style={{ display: "inline-flex", alignItems: "center", gap: "5px", fontSize: ".8rem", fontWeight: 700, color: STATE.blocked.colour }}>
                <Icon ready={false} />
                NOT READY
              </span>
            </div>
            <div style={{ color: "#444" }}>
              Blocked on{" "}
              {current.criteria
                .filter((c) => c.result !== "satisfied" && c.result !== "n/a")
                .map((c) => c.id)
                .join(", ") || "an unattested criterion"}
              .
            </div>
          </>
        ) : (
          <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
            <span style={{ fontSize: "1.35rem", fontWeight: 600 }}>Every gate is ready</span>
            <span style={{ display: "inline-flex", alignItems: "center", gap: "5px", fontSize: ".8rem", fontWeight: 700, color: STATE.ready.colour }}>
              <Icon ready />
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
            const state = s.ready ? STATE.ready : STATE.blocked;
            return (
              <a
                key={s.id}
                href={`/stage/${s.id}`}
                data-vpw-stage={s.id}
                data-vpw-ready={String(s.ready)}
                style={{
                  display: "grid",
                  gridTemplateColumns: "32px minmax(0, 1fr) 116px",
                  gap: "12px",
                  alignItems: "center",
                  border: "1px solid #e2e2e2",
                  borderLeft: `4px solid ${state.colour}`,
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
                    color: state.colour,
                  }}
                >
                  <Icon ready={s.ready} />
                  {state.label}
                </span>
              </a>
            );
          })}
        </div>
      </section>
    </div>
  );
}
