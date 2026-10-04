export function CurrentUnderstanding({ review, children }) {
  return (
    <aside
      data-vpw-current-understanding={review.name}
      data-vpw-current-understanding-revision={String(review.revision)}
      data-vpw-author="kiln"
      style={{ border: "1px solid #d8c79f", borderLeft: "5px solid #9a6700", borderRadius: "8px", background: "#fffaf0", padding: "14px 18px", margin: "0 0 18px" }}
    >
      <p style={{ margin: "0 0 8px", color: "#76520d", fontSize: ".76rem", fontWeight: 750, letterSpacing: ".05em", textTransform: "uppercase" }}>
        Kiln-authored current understanding
      </p>
      {children}
    </aside>
  );
}

export default function IntakeReview({ entries }) {
  return (
    <section data-vpw-intake-review={String(entries.length)} aria-labelledby="intake-review-title" style={{ margin: "18px 0" }}>
      <h2 id="intake-review-title">Intake review</h2>
      <p style={{ color: "#666", maxWidth: "68ch" }}>
        Each operator answer is paired with Kiln&rsquo;s interpretation. The version-controlled stage document remains authoritative.
      </p>
      {entries.length === 0 ? <p data-vpw-intake-empty>No answers have been recorded yet.</p> : null}
      <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
        {entries.map((entry) => (
          <article key={entry.label} data-vpw-intake-entry={`A${entry.label}`} style={{ border: "1px solid #ddd8cd", borderRadius: "10px", overflow: "hidden" }}>
            <h3 style={{ margin: 0, padding: "9px 14px", background: "#f4f1ea", fontSize: ".9rem" }}>A{entry.label}</h3>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 19rem), 1fr))" }}>
              <div style={{ padding: "13px 14px", minWidth: 0 }}>
                <p style={{ margin: "0 0 6px", color: "#555", fontSize: ".75rem", fontWeight: 750, letterSpacing: ".04em", textTransform: "uppercase" }}>
                  Operator&rsquo;s exact words
                </p>
                <p data-vpw-operator-words={`A${entry.label}`} style={{ margin: 0, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{entry.verbatim}</p>
              </div>
              <div style={{ padding: "13px 14px", minWidth: 0, background: "#fafafa", borderLeft: "1px solid #ebe7de" }}>
                <p style={{ margin: "0 0 6px", color: "#555", fontSize: ".75rem", fontWeight: 750, letterSpacing: ".04em", textTransform: "uppercase" }}>
                  Kiln&rsquo;s interpretation
                </p>
                <p data-vpw-kiln-interpretation={`A${entry.label}`} style={{ margin: 0, overflowWrap: "anywhere" }}>{entry.interpretation}</p>
              </div>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
