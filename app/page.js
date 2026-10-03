import { Suspense } from "react";
import ProjectIdentity from "./project-identity.js";
import Workspace from "./workspace.js";

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
        <Suspense fallback={<div style={{ color: "#666" }}>Reading project identity…</div>}>
          <ProjectIdentity />
        </Suspense>
      </header>

      <Suspense
        fallback={
          <p data-vpw-loading="workspace" style={{ color: "#666" }}>
            Reading the project workspace…
          </p>
        }
      >
        <Workspace />
      </Suspense>
    </main>
  );
}
