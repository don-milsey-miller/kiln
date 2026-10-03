import { Suspense } from "react";
import { readProjectIdentity, readProjectOverview } from "./_read/planning.js";
import DiagnosticsPanel from "./diagnostics-panel.js";
import IngestPanel from "./ingest-panel.js";
import StagesPanel from "./stages-panel.js";
import { isFirstRunWorkspace } from "./first-run.js";

const card = {
  border: "1px solid #e1ddd5",
  borderRadius: "16px",
  background: "#fff",
  boxShadow: "0 12px 40px rgba(36, 31, 24, .07)",
};

function SecondaryWorkspace() {
  return (
    <details style={{ ...card, marginTop: "28px", padding: "4px 20px 20px" }}>
      <summary style={{ cursor: "pointer", padding: "16px 0", fontWeight: 650 }}>Project details and tools</summary>
      <IngestPanel />
      <Suspense fallback={<p style={{ color: "#706b63" }}>Reading planning stages…</p>}>
        <StagesPanel />
      </Suspense>
      <div style={{ marginTop: "28px" }}>
        <Suspense fallback={<p style={{ color: "#706b63" }}>Reading project diagnostics…</p>}>
          <DiagnosticsPanel />
        </Suspense>
      </div>
    </details>
  );
}

/** Canonical first-run state: no validated planning artifact has been written yet. */
export default async function Workspace() {
  const [identity, overview] = await Promise.all([readProjectIdentity(), readProjectOverview()]);
  const firstRun = isFirstRunWorkspace(overview);

  if (firstRun)
    return (
      <div data-kiln-first-run="true">
        <section
          aria-labelledby="first-run-title"
          style={{
            ...card,
            padding: "clamp(28px, 6vw, 64px)",
            background: "linear-gradient(145deg, #fffdf8 0%, #f6f0e5 100%)",
          }}
        >
          <p style={{ margin: "0 0 10px", color: "#8a5a28", fontWeight: 700, letterSpacing: ".08em", textTransform: "uppercase", fontSize: ".75rem" }}>
            Your kiln is ready
          </p>
          <h1 id="first-run-title" style={{ margin: 0, maxWidth: "18ch", fontSize: "clamp(2rem, 6vw, 3.7rem)", lineHeight: 1.05, letterSpacing: "-.035em" }}>
            Start shaping {identity.name || "your project"}
          </h1>
          {identity.description ? <p style={{ maxWidth: "56ch", color: "#5d574f", fontSize: "1.08rem", margin: "18px 0 0" }}>{identity.description}</p> : null}
          <div style={{ marginTop: "34px", display: "flex", flexWrap: "wrap", alignItems: "center", gap: "16px" }}>
            <a
              href="/stage/01-intake"
              data-kiln-primary-action="start-planning"
              style={{ display: "inline-block", borderRadius: "999px", padding: "13px 22px", background: "#b9572d", color: "white", fontWeight: 700, textDecoration: "none" }}
            >
              Start planning
            </a>
            <span style={{ color: "#706b63" }}>First step: describe what success looks like.</span>
          </div>
        </section>
        <SecondaryWorkspace />
      </div>
    );

  return (
    <div data-kiln-first-run="false">
      <IngestPanel />
      <Suspense fallback={<p data-vpw-loading="stages" style={{ color: "#666" }}>Reading stage definitions and attestations…</p>}>
        <StagesPanel />
      </Suspense>
      <div style={{ marginTop: "28px" }}>
        <Suspense fallback={<p data-vpw-loading="diagnostics" style={{ color: "#666" }}>Counting artifacts and reading lint findings…</p>}>
          <DiagnosticsPanel />
        </Suspense>
      </div>
    </div>
  );
}
