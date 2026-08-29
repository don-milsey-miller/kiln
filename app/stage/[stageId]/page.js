import { Suspense } from "react";
import CriteriaPanel from "./criteria-panel.js";
import DocumentPanel from "./document-panel.js";
import ReviewPanel from "./review-panel.js";

/**
 * The stage view — `/stage/[stageId]`.
 *
 * ⚠️ THREE READS, THREE BOUNDARIES. The criteria, the document and the review panel resolve
 * independently: a slow document must not hold up the criteria, and a refused document must not take
 * them down with it. One boundary around the lot would make the whole page the fallback and satisfy
 * DEC-0019 on paper while buying nothing.
 *
 * ⚠️ THE PAGE ITSELF READS NOTHING. It awaits `params` and `searchParams` — which Next.js hands over
 * as promises — and passes the values down. A route entry that awaited the READER would have nothing
 * above it to wrap the read, and `lint:shell` refuses exactly that.
 *
 * ⚠️ THE STAGE ID IS NEVER TURNED INTO A PATH. It is passed to the reader, which matches it against
 * the stage definitions by exact key and against document names by exact comparison. An unknown id
 * becomes a 404 inside `CriteriaPanel`, not a filesystem lookup that has to be sanitised.
 *
 * ⚠️ Each panel is rendered as a literal `<Name />` here, which the boundary check requires: aliasing
 * one, or moving a boundary up into the layout, is refused as unsupported indirection.
 */
export default async function StagePage({ params, searchParams }) {
  const { stageId } = await params;
  const { artifact, reviewError } = (await searchParams) ?? {};
  const artifactId = typeof artifact === "string" ? artifact : null;
  // ⚠️ The outcome of a write comes back as a CODE in the URL, looked up in the panel rather than
  // rendered. A message carried in the query string would let a crafted link put an arbitrary
  // sentence inside the application's own error styling.
  const reviewErrorCode = typeof reviewError === "string" ? reviewError : null;

  return (
    <main data-vpw-route="/stage" style={{ maxWidth: "60rem", margin: "2rem auto", padding: "0 1.5rem" }}>
      <header style={{ borderBottom: "1px solid #ddd", paddingBottom: "12px", marginBottom: "26px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: ".85rem", color: "#666", flexWrap: "wrap" }}>
          <a href="/" style={{ color: "#1a4f8a" }}>
            visual-project-workflow
          </a>
          <span>/</span>
          <code style={{ background: "#f6f6f6", padding: "0 .25rem", borderRadius: "3px", overflowWrap: "anywhere" }}>
            {`/stage/${stageId}${artifactId ? `?artifact=${artifactId}` : ""}`}
          </code>
        </div>
      </header>

      <div style={{ display: "flex", flexDirection: "column", gap: "28px" }}>
        <Suspense fallback={<p data-vpw-loading="criteria" style={{ color: "#666" }}>Reading attestations…</p>}>
          <CriteriaPanel stageId={stageId} />
        </Suspense>

        <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
          <p style={{ margin: 0, fontSize: ".8rem", textTransform: "uppercase", letterSpacing: ".04em", color: "#666" }}>
            Stage document
          </p>
          <Suspense fallback={<p data-vpw-loading="document" style={{ color: "#666" }}>Compiling the stage document…</p>}>
            <DocumentPanel stageId={stageId} />
          </Suspense>
        </div>

        <Suspense fallback={<p data-vpw-loading="review" style={{ color: "#666" }}>Reading the artifact…</p>}>
          <ReviewPanel artifactId={artifactId} stageId={stageId} reviewError={reviewErrorCode} />
        </Suspense>
      </div>
    </main>
  );
}
