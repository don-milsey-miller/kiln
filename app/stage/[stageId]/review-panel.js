import { readArtifactSummary } from "../../_read/planning.js";
import { submitReviewStatus } from "../../_write/review-action.js";
import { REVIEW_MESSAGE } from "../../_write/review-logic.js";

/**
 * The artifact-scoped review panel — identity and current status only.
 *
 * ⚠️ THE WRITE WAS ADDED BY TSK-0012, AFTER THE INDIVIDUAL REVIEW DEC-0021 REQUIRES. It is the
 * only write in the application, it goes through `app/server/review.js` — an adapter exposing
 * exactly one locking operation — and that operation cannot express anything but a `reviewStatus`
 * change. `lifecycle` is unreachable from here by construction rather than by care.
 *
 * ⚠️ A PLAIN `<form action={...}>`, NO CLIENT COMPONENT. The submission needs no interactivity the
 * platform does not already give it, and the outcome comes back as a fresh render of the page rather
 * than as a message about one. A failure returns in the URL as a CODE, mapped to its sentence here —
 * never as text carried in the query string, which would let a crafted link render an arbitrary
 * sentence inside the application's own error styling.
 *
 * ⚠️ IT IS ARTIFACT-SCOPED, NOT DOCUMENT-SCOPED. `reviewStatus` is a property of an artifact and a
 * stage document is not one, so the panel names the artifact's id, type, title and current status.
 * Which artifact is selected comes from the URL, so the selection survives the reload DEC-0022 will
 * perform without warning.
 */

/** The four statuses, in the order a review moves through them. */
const STATUSES = ["draft", "in-review", "approved", "amended"];

const STATUS_TONE = {
  draft: { bg: "#fdfaf2", border: "#d8cfa8", fg: "#6b5410" },
  "in-review": { bg: "#f2f7fd", border: "#b9cfe8", fg: "#1a4f8a" },
  approved: { bg: "#f3faf4", border: "#b9dcc0", fg: "#2e7d32" },
  amended: { bg: "#f7f4fb", border: "#cfc2e0", fg: "#5b4380" },
};

export default async function ReviewPanel({ artifactId, stageId, reviewError }) {
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
  // ⚠️ Looked up, never interpolated: an unrecognised code renders nothing rather than itself.
  const message = REVIEW_MESSAGE[reviewError] ?? null;

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

      {message ? (
        <div
          data-vpw-review-error={reviewError}
          role="alert"
          style={{
            border: "1px solid #d9a3a3",
            borderLeft: "5px solid #c62828",
            background: "#fdf6f6",
            borderRadius: "4px",
            padding: "9px 12px",
            color: "#7a2020",
            fontSize: ".82rem",
          }}
        >
          {message}
        </div>
      ) : null}

      <form
        action={submitReviewStatus}
        style={{ borderTop: "1px solid #eee", paddingTop: "12px", display: "flex", flexDirection: "column", gap: "10px" }}
      >
        {/* The artifact and the page to come back to. No `type` field: it is derived from the id. */}
        <input type="hidden" name="id" value={artifact.id} />
        <input type="hidden" name="path" value={`/stage/${stageId}`} />

        <label style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: ".82rem", flexWrap: "wrap" }}>
          <span style={{ color: "#666" }}>change to</span>
          <select name="status" defaultValue={artifact.reviewStatus} style={{ padding: ".2rem .3rem", fontSize: ".82rem" }}>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>

        <label style={{ display: "flex", alignItems: "center", gap: "8px", fontSize: ".82rem", flexWrap: "wrap" }}>
          <span style={{ color: "#666" }}>reviewed by</span>
          <input
            name="reviewedBy"
            type="text"
            placeholder="required to approve"
            style={{ padding: ".2rem .35rem", fontSize: ".82rem", minWidth: "12rem" }}
          />
        </label>

        <button type="submit" style={{ alignSelf: "flex-start", padding: ".3rem .8rem", fontSize: ".82rem", cursor: "pointer" }}>
          Update review status
        </button>

        <span style={{ color: "#888", fontSize: ".78rem" }}>
          Changes this artifact&rsquo;s review status only, through the typed path — lock, fresh read
          inside the lock, atomic write.
        </span>
      </form>
    </section>
  );
}
