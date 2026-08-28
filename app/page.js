/**
 * The minimal responding route — TSK-0003's whole surface.
 *
 * ⚠️ It reads NOTHING. Planning content is read only through the reader (TSK-0005) under DEC-0019's
 * `connection()` + `<Suspense>` contract, and REQ-0021 requires that confinement be checked
 * statically. A convenience read here would be the first violation of a rule whose own enforcement
 * has not been built yet (TSK-0006, TSK-0015) — so this route stays a liveness check until the
 * reader exists.
 */
export default function Page() {
  return (
    <main data-vpw-route="/" style={{ maxWidth: "60rem", margin: "2rem auto", padding: "0 1.5rem" }}>
      <h1 style={{ fontSize: "1.15rem" }}>visual-project-workflow</h1>
      <p style={{ color: "#666" }}>
        The application shell is scaffolded and serving. No planning content is read yet.
      </p>
    </main>
  );
}
