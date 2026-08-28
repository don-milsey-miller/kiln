import { readArtifactSummary } from "../../_read/planning.js";

/**
 * The artifact-scoped review panel — identity and current status only.
 *
 * ⚠️ NO WRITE CAPABILITY, DELIBERATELY. DEC-0021 holds locking capabilities back for individual
 * review before the adapter exposes them, and the review-status write is the first of them: a Server
 * Component may run concurrently in ways a CLI never does, and that is what needs examining before
 * the line is added. TSK-0012 does that. Until then the control is inert and says so, rather than
 * being absent — an operator should be able to see what the action will be.
 *
 * ⚠️ IT IS ARTIFACT-SCOPED, NOT DOCUMENT-SCOPED. `reviewStatus` is a property of an artifact and a
 * stage document is not one, so the panel names the artifact's id, type, title and current status.
 * Which artifact is selected comes from the URL, so the selection survives the reload DEC-0022 will
 * perform without warning.
 */

const STATUS_TONE = {
  draft: { bg: "#fdfaf2", border: "#d8cfa8", fg: "#6b5410" },
  "in-review": { bg: "#f2f7fd", border: "#b9cfe8", fg: "#1a4f8a" },
  approved: { bg: "#f3faf4", border: "#b9dcc0", fg: "#2e7d32" },
  amended: { bg: "#f7f4fb", border: "#cfc2e0", fg: "#5b4380" },
};

export default async function ReviewPanel({ artifactId }) {
  const artifact = artifactId ? await readArtifactSummary(artifactId) : null;

  if (!artifactId)
    return (
      <section data-vpw-review="none" style={{ color: "#888", fontSize: ".85rem" }}>
        No artifact selected. Add <code>?artifact=AST-0021</code> to review one.
      </section>
    );

  if (!artifact)
    return (
      <section data-vpw-review="unknown" style={{ color: "#a01f1f", fontSize: ".85rem" }}>
        No artifact with id <code>{artifactId}</code>.
      </section>
    );

  const tone = STATUS_TONE[artifact.reviewStatus] ?? STATUS_TONE.draft;

  return (
    <section
      data-vpw-review={artifact.id}
      style={{ border: "1px solid #ccc", borderRadius: "4px", padding: "16px 18px", display: "flex", flexDirection: "column", gap: "14px" }}
    >
      <p style={{ margin: 0, fontSize: ".8rem", textTransform: "uppercase", letterSpacing: ".04em", color: "#666" }}>
        Review
      </p>

      <div style={{ display: "flex", flexDirection: "column", gap: "3px", minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: "10px", flexWrap: "wrap" }}>
          <code style={{ background: "#f6f6f6", padding: "0 .25rem", borderRadius: "3px", fontWeight: 600 }}>{artifact.id}</code>
          <span style={{ fontSize: ".75rem", background: "#f0f0f0", borderRadius: "3px", padding: ".05rem .4rem", color: "#555" }}>
            {artifact.type}
          </span>
        </div>
        <div style={{ fontWeight: 500, overflowWrap: "anywhere" }}>{artifact.title}</div>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
        <span style={{ color: "#888", fontSize: ".8rem" }}>current status</span>
        <span
          data-vpw-review-status={artifact.reviewStatus}
          style={{
            fontSize: ".8rem",
            border: `1px solid ${tone.border}`,
            background: tone.bg,
            color: tone.fg,
            borderRadius: "3px",
            padding: ".1rem .5rem",
          }}
        >
          {artifact.reviewStatus}
        </span>
      </div>

      <div style={{ borderTop: "1px solid #eee", paddingTop: "10px", color: "#888", fontSize: ".8rem" }}>
        Changing review status is not available yet. The write goes through the typed path — lock,
        fresh read inside the lock, atomic write — and that capability is reviewed on its own before
        it is exposed.
      </div>
    </section>
  );
}
