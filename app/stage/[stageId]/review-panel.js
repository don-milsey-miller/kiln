import { redirect } from "next/navigation";

import { readArtifactDetail, searchArtifactSummaries } from "../../_read/planning.js";
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

export default async function ReviewPanel({ artifactId, stageId, reviewError, reviewAttempt, query, type, status }) {
  const detail = artifactId ? await readArtifactDetail(artifactId) : null;
  const artifact = detail?.doc ?? null;

  if (!artifactId) {
    const search = await searchArtifactSummaries({ query, type, status });
    if (search.total === 0)
      return (
        <section data-vpw-review="empty" style={{ color: "#666", fontSize: ".85rem" }}>
          This project has no active artifacts available for review yet.
        </section>
      );

    return (
      <section data-vpw-review="chooser" style={{ borderTop: "1px solid #eee", paddingTop: "14px", display: "flex", flexDirection: "column", gap: "14px" }}>
        <form method="get" action={`/stage/${stageId}`} aria-label="Filter review artifacts" style={{ display: "flex", alignItems: "end", gap: "10px", flexWrap: "wrap" }}>
          <label style={{ display: "flex", flexDirection: "column", gap: "5px", flex: "1 1 16rem", fontSize: ".82rem" }}>
            <span style={{ color: "#666" }}>Search by ID or title</span>
            <input name="q" type="search" defaultValue={search.filters.query} placeholder="REQ-0042 or onboarding" style={{ padding: ".35rem .45rem", fontSize: ".82rem", minWidth: 0 }} />
          </label>
          <label style={{ display: "flex", flexDirection: "column", gap: "5px", fontSize: ".82rem" }}>
            <span style={{ color: "#666" }}>Type</span>
            <select name="type" defaultValue={search.filters.type} style={{ padding: ".35rem .45rem", fontSize: ".82rem" }}>
              <option value="">All types</option>
              {search.types.map((candidate) => <option key={candidate} value={candidate}>{candidate}</option>)}
            </select>
          </label>
          <label style={{ display: "flex", flexDirection: "column", gap: "5px", fontSize: ".82rem" }}>
            <span style={{ color: "#666" }}>Status</span>
            <select name="status" defaultValue={search.filters.status} style={{ padding: ".35rem .45rem", fontSize: ".82rem" }}>
              <option value="">All statuses</option>
              {search.statuses.map((candidate) => <option key={candidate} value={candidate}>{candidate}</option>)}
            </select>
          </label>
          <button type="submit" style={{ padding: ".35rem .8rem", fontSize: ".82rem", cursor: "pointer" }}>Find artifacts</button>
        </form>

        <form method="get" action={`/stage/${stageId}`} style={{ display: "flex", alignItems: "end", gap: "10px", flexWrap: "wrap" }}>
          <label style={{ display: "flex", flexDirection: "column", gap: "5px", minWidth: "min(32rem, 100%)", fontSize: ".82rem" }}>
            <span style={{ color: "#666" }}>
              {search.matched === 0 ? "No matching artifacts" : `${search.matched} matching artifact${search.matched === 1 ? "" : "s"}${search.truncated ? " · first 50 shown" : ""}`}
            </span>
            <select name="artifact" defaultValue="" required disabled={search.items.length === 0} style={{ padding: ".35rem .45rem", fontSize: ".82rem", maxWidth: "100%" }}>
              <option value="" disabled>Choose an active artifact…</option>
              {search.items.map((candidate) => (
                <option key={candidate.id} value={candidate.id}>
                  {`${candidate.id} · ${candidate.type} · ${candidate.title || "Untitled"} · ${candidate.reviewStatus}`}
                </option>
              ))}
            </select>
          </label>
          <button type="submit" disabled={search.items.length === 0} style={{ padding: ".35rem .8rem", fontSize: ".82rem", cursor: search.items.length ? "pointer" : "not-allowed" }}>
            Review artifact
          </button>
        </form>
      </section>
    );
  }

  if (!artifact)
    return (
      <section data-vpw-review="unknown" style={{ color: "#a01f1f", fontSize: ".85rem" }}>
        No artifact with id <code>{artifactId}</code>.
      </section>
    );

  const tone = STATUS_TONE[artifact.reviewStatus] ?? STATUS_TONE.draft;
  // ⚠️ Looked up, never interpolated: an unrecognised code renders nothing rather than itself.
  const message = REVIEW_MESSAGE[reviewError] ?? null;
  // A failed transition is encoded with its intended status. If a later successful write reached
  // that status while the browser retained the old query string, canonicalize the URL instead of
  // rendering a contradiction such as “approved” beside “Nothing was changed.”
  if (message && reviewAttempt === artifact.reviewStatus)
    redirect(`/stage/${stageId}?artifact=${artifact.id}`);

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

      <details open style={{ borderTop: "1px solid #eee", paddingTop: "12px" }}>
        <summary style={{ cursor: "pointer", fontWeight: 600, fontSize: ".85rem" }}>Artifact content and provenance</summary>
        <pre
          data-vpw-review-content={artifact.id}
          style={{ margin: "10px 0 0", padding: "12px", maxHeight: "28rem", overflow: "auto", background: "#f7f7f7", borderRadius: "4px", whiteSpace: "pre-wrap", overflowWrap: "break-word", fontSize: ".76rem", lineHeight: 1.45 }}
        >
          {JSON.stringify(detail.doc, null, 2)}
        </pre>
        {detail.sourcePreview ? (
          <div style={{ marginTop: "12px" }}>
            <div style={{ color: "#666", fontSize: ".78rem", marginBottom: "5px" }}>Normalized source preview</div>
            {detail.sourcePreview.unavailable ? (
              <p style={{ color: "#a01f1f", fontSize: ".82rem" }}>The normalized source preview is unavailable.</p>
            ) : (
              <pre data-vpw-source-preview style={{ margin: 0, padding: "12px", maxHeight: "22rem", overflow: "auto", background: "#fbfbfb", border: "1px solid #e2e2e2", borderRadius: "4px", whiteSpace: "pre-wrap", overflowWrap: "break-word", fontSize: ".8rem", lineHeight: 1.5 }}>
                {detail.sourcePreview.content}{detail.sourcePreview.truncated ? "\n\n[Preview truncated]" : ""}
              </pre>
            )}
          </div>
        ) : null}
      </details>

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
