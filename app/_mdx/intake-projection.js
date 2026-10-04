const inside = (node, range) =>
  range &&
  Number.isInteger(node.position?.start?.offset) &&
  Number.isInteger(node.position?.end?.offset) &&
  node.position.start.offset >= range.start &&
  node.position.end.offset <= range.end;

const component = (name, children = []) => ({ type: "mdxJsxFlowElement", name, attributes: [], children });

/**
 * Replace parser-owned source ranges after the rejection plugin has inspected the authored tree.
 * The two component nodes are therefore application-owned; an author writing either name is still
 * rejected before this transform runs.
 */
export default function remarkIntakeProjection({ intake, summary = null, workingNotes = null }) {
  return (tree) => {
    const summaryChildren = summary
      ? tree.children.filter((node) => inside(node, summary) && node.type !== "definition")
      : [];
    const projected = [];
    let inserted = false;

    for (const node of tree.children) {
      if (inside(node, intake)) {
        if (!inserted) {
          if (summaryChildren.length > 0) projected.push(component("CurrentUnderstanding", summaryChildren));
          projected.push(component("IntakeReview"));
          inserted = true;
        }
        continue;
      }
      if (inside(node, workingNotes) || inside(node, summary)) continue;
      projected.push(node);
    }

    tree.children = projected;
  };
}
