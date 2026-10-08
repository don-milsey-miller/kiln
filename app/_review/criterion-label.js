/**
 * One exit criterion as a person reads it: what it asks, then its stable id - #183.
 *
 * ⚠️ **THE DESCRIPTION IS THE LABEL, AND THE ID IS THE DETAIL.** The id is what the stage definition, the
 * attestation record and the terminal call the criterion, so it stays on the page as text that can be read,
 * selected and searched for. It is not what tells a reader why a stage is blocked: `runbook-steps-above-threshold`
 * has to be decoded, and the definition's own sentence does not.
 *
 * ⚠️ **THE SAME ON THE PROJECT VIEW AND THE STAGE VIEW**, because both render this and nothing else for a criterion.
 *
 * A criterion whose definition has no description is labelled by its id alone, once.
 */

/** Read by assistive technology and not drawn: says what the code beside it is. */
const VISUALLY_HIDDEN = {
  position: "absolute",
  width: "1px",
  height: "1px",
  margin: "-1px",
  padding: 0,
  overflow: "hidden",
  clip: "rect(0 0 0 0)",
  whiteSpace: "nowrap",
  border: 0,
};

const ID_STYLE = {
  background: "#f6f6f6",
  padding: "0 .25rem",
  borderRadius: "3px",
  fontSize: ".78em",
  fontWeight: 400,
  color: "#5f5a52",
  // An id is one long unspaced word. Without this a narrow page would have to scroll sideways to show it.
  overflowWrap: "anywhere",
};

export default function CriterionLabel({ id, describe }) {
  const description = typeof describe === "string" ? describe.trim() : "";
  if (description.length === 0)
    return (
      <span data-vpw-criterion-label={id} style={{ minWidth: 0 }}>
        <span style={VISUALLY_HIDDEN}>Criterion ID: </span>
        <code data-vpw-criterion-id={id} style={{ ...ID_STYLE, fontSize: ".85em" }}>
          {id}
        </code>
      </span>
    );
  return (
    <span data-vpw-criterion-label={id} style={{ display: "inline-flex", flexDirection: "column", alignItems: "flex-start", gap: "2px", minWidth: 0 }}>
      <span data-vpw-criterion-description={id} style={{ overflowWrap: "anywhere" }}>
        {description}
      </span>
      {/* A space that is read and copied and never drawn, so the description and the id are not run together as text. */}
      {" "}
      <span style={{ minWidth: 0 }}>
        <span style={VISUALLY_HIDDEN}>Criterion ID: </span>
        <code data-vpw-criterion-id={id} style={ID_STYLE}>
          {id}
        </code>
      </span>
    </span>
  );
}
