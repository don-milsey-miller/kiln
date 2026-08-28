import { Suspense } from "react";
import StagesPanel from "./stages-panel.js";
import DiagnosticsPanel from "./diagnostics-panel.js";

/**
 * The project view — `/`.
 *
 * ⚠️ THE READ LIVES IN A CHILD, NOT HERE. A route entry that awaited the reader itself would have
 * nothing above it to wrap the read, and `lint:shell` refuses exactly that (`read-in-route-entry`).
 * So this page stays synchronous and `<StagesPanel />` — which does the reading — is rendered
 * literally, inside a `<Suspense>` at this call site. That literal form is required: an alias, a
 * variable, or a boundary in the layout would each be refused as unsupported indirection.
 *
 * ⚠️ The diagnostics half — totals, the lint surface and unreadable files — is its own component
 * behind its own boundary. It fails differently from the navigation: a wrong stage is obvious, a
 * wrong total looks exactly like a right one, so the two are reviewed and rendered separately.
 */
export default function Page() {
  return (
    <main data-vpw-route="/" style={{ maxWidth: "60rem", margin: "2rem auto", padding: "0 1.5rem" }}>
      <header style={{ borderBottom: "1px solid #ddd", paddingBottom: "14px", marginBottom: "28px" }}>
        <div style={{ fontSize: "1.15rem", fontWeight: 600 }}>visual-project-workflow</div>
        <div style={{ color: "#666", fontSize: ".85rem" }}>
          Stage position is derived on every read. Nothing about it is stored.
        </div>
      </header>

      <Suspense
        fallback={
          <p data-vpw-loading="stages" style={{ color: "#666" }}>
            Reading stage definitions and attestations…
          </p>
        }
      >
        <StagesPanel />
      </Suspense>

      <div style={{ marginTop: "28px" }}>
        <Suspense
          fallback={
            <p data-vpw-loading="diagnostics" style={{ color: "#666" }}>
              Counting artifacts and reading lint findings…
            </p>
          }
        >
          <DiagnosticsPanel />
        </Suspense>
      </div>
    </main>
  );
}
