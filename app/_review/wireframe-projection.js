/**
 * The display projection of one wireframe artifact, or a bounded reason there is none (#188).
 *
 * This stays pure so nesting, ordering and every malformed case can be proved without the server-only reader. The
 * viewer is given what this returns and nothing else.
 *
 * ⚠️ A RECORD THAT FAILS ITS SCHEMA NEVER BECOMES GEOMETRY. Lint records deliberately keep invalid documents for
 * diagnosis, and the review panel is handed them as they are. So the schema is checked here, by the validator the
 * caller supplies, before any field is read as a number.
 *
 * ⚠️ EVERY `bounds` IS IN VIEWPORT COORDINATES, AT EVERY DEPTH. The schema says so. Nothing here adds a parent's
 * origin to a child's.
 *
 * ⚠️ AN ELEMENT'S KEY IS ITS PLACE IN THE TREE, NOT ITS DECLARED ID. Two elements may declare the same id. Each still
 * has a key of its own (`r0.c2`), so both are drawn and both can be selected.
 *
 * ⚠️ OVERLAP IS NOT A DEFECT. Elements are returned in document order: a region, then its components, then its nested
 * regions. That is the order they are drawn in, so a later element lies over an earlier one.
 *
 * ⚠️ WHAT COMES BACK FOR A MALFORMED RECORD IS BOUNDED, in how many messages and in how long each is. The record's
 * own strings are quoted in those messages, and a record can be any size.
 */

export const WIREFRAME_LIMITS = Object.freeze({
  /** Regions and components together. */
  elements: 2000,
  /** A top-level region is at depth 1. */
  depth: 32,
  annotations: 500,
  /** The largest magnitude a coordinate, an extent, or a far edge may have. */
  coordinate: 1_000_000,
  refusalMessages: 5,
  warnings: 20,
  messageLength: 240,
});

export const WIREFRAME_REFUSAL = Object.freeze({
  SCHEMA_INVALID: "wireframe/schema-invalid",
  OUT_OF_RANGE: "wireframe/geometry-out-of-range",
  TOO_LARGE: "wireframe/too-large",
});

export const WIREFRAME_WARNING = Object.freeze({
  DUPLICATE_ELEMENT_ID: "wireframe/duplicate-element-id",
  DUPLICATE_ANNOTATION_ID: "wireframe/duplicate-annotation-id",
  ANNOTATION_TARGET_MISSING: "wireframe/annotation-target-missing",
  ANNOTATION_TARGET_AMBIGUOUS: "wireframe/annotation-target-ambiguous",
  TRACE_UNRESOLVED: "wireframe/trace-unresolved",
  TRACE_WRONG_TYPE: "wireframe/trace-wrong-type",
  OUTSIDE_PARENT: "wireframe/outside-parent",
  OUTSIDE_VIEWPORT: "wireframe/outside-viewport",
});

/** The four places a wireframe names another artifact, with the id prefix each one must carry. */
const TRACE_PREFIX = Object.freeze({ implements: "REQ", decidedBy: "DEC", openQuestions: "QST", requirements: "REQ" });
const ARTIFACT_ID = /^[A-Z]{3}-[0-9]{4,}$/;

const clip = (text, length = WIREFRAME_LIMITS.messageLength) => {
  const s = String(text);
  return s.length > length ? `${s.slice(0, length - 1)}…` : s;
};
/** A record's own string, quoted for a message and cut short on its own so the sentence around it survives. */
const quote = (value) => JSON.stringify(clip(value, 60));

function refusal(code, messages) {
  return {
    ok: false,
    refusal: {
      code,
      messages: messages.slice(0, WIREFRAME_LIMITS.refusalMessages).map((m) => clip(m)),
      omitted: Math.max(0, messages.length - WIREFRAME_LIMITS.refusalMessages),
    },
  };
}

const contains = (outer, inner) =>
  inner.x >= outer.x && inner.y >= outer.y && inner.x + inner.width <= outer.x + outer.width && inner.y + inner.height <= outer.y + outer.height;

/**
 * @param {unknown} doc  the record as it was read
 * @param {{validate: ((doc: unknown) => boolean) & {errors?: Array<{instancePath?: string, message?: string}> | null},
 *          knownIds?: Iterable<string>}} opts
 *   `validate` is the compiled `wireframe.schema.json` validator. `knownIds` is every artifact id in the project.
 * @returns {{ok: true, view: object} | {ok: false, refusal: {code: string, messages: string[], omitted: number}}}
 */
export function projectWireframe(doc, { validate, knownIds = [] } = {}) {
  let valid = false;
  let errors = [];
  try {
    valid = typeof validate === "function" && validate(doc) === true;
    errors = (typeof validate === "function" && validate.errors) || [];
  } catch (error) {
    // A document nested deeply enough can exhaust the validator's stack. That is a record that did not validate.
    errors = [{ instancePath: "", message: `could not be validated (${error?.name ?? "error"})` }];
  }
  if (!valid || doc?.type !== "wireframe") {
    const messages = errors.map((e) => `${e.instancePath || "(root)"} ${e.message ?? "is invalid"}`);
    return refusal(WIREFRAME_REFUSAL.SCHEMA_INVALID, messages.length ? messages : ["(root) is not a wireframe record"]);
  }

  const limit = WIREFRAME_LIMITS.coordinate;
  const viewport = { width: doc.viewport.width, height: doc.viewport.height };
  const outOfRange = [];
  if (viewport.width > limit || viewport.height > limit) outOfRange.push(`viewport is larger than ${limit} units`);
  const annotationsIn = doc.annotations ?? [];
  if (annotationsIn.length > WIREFRAME_LIMITS.annotations)
    return refusal(WIREFRAME_REFUSAL.TOO_LARGE, [`${annotationsIn.length} annotations, over the limit of ${WIREFRAME_LIMITS.annotations}`]);

  const elements = [];
  let tooDeep = false;
  let tooMany = false;
  // An explicit stack, so the depth limit is what stops a deep tree and not the call stack. Children are pushed in
  // reverse, so they are taken in document order.
  const pending = [];
  for (let i = doc.regions.length - 1; i >= 0; i--) pending.push({ node: doc.regions[i], role: "region", key: `r${i}`, parentKey: null, depth: 1 });
  while (pending.length > 0) {
    const { node, role, key, parentKey, depth } = pending.pop();
    if (depth > WIREFRAME_LIMITS.depth) {
      tooDeep = true;
      break;
    }
    if (elements.length >= WIREFRAME_LIMITS.elements) {
      tooMany = true;
      break;
    }
    const { x, y, width, height } = node.bounds;
    if ([x, y, width, height, x + width, y + height].some((n) => Math.abs(n) > limit)) outOfRange.push(`${key} (${quote(node.id)}) has bounds beyond ±${limit} units`);
    elements.push({
      key,
      id: node.id,
      role,
      kind: node.kind,
      label: node.label,
      content: role === "component" && typeof node.content === "string" && node.content.length > 0 ? node.content : null,
      bounds: { x, y, width, height },
      depth,
      parentKey,
      annotations: [],
    });
    if (role !== "region") continue;
    const regions = node.regions ?? [];
    const components = node.components ?? [];
    for (let i = regions.length - 1; i >= 0; i--) pending.push({ node: regions[i], role: "region", key: `${key}.r${i}`, parentKey: key, depth: depth + 1 });
    for (let i = components.length - 1; i >= 0; i--) pending.push({ node: components[i], role: "component", key: `${key}.c${i}`, parentKey: key, depth: depth + 1 });
  }
  if (tooDeep) return refusal(WIREFRAME_REFUSAL.TOO_LARGE, [`regions are nested deeper than the limit of ${WIREFRAME_LIMITS.depth}`]);
  if (tooMany) return refusal(WIREFRAME_REFUSAL.TOO_LARGE, [`more than ${WIREFRAME_LIMITS.elements} regions and components`]);
  if (outOfRange.length > 0) return refusal(WIREFRAME_REFUSAL.OUT_OF_RANGE, outOfRange);

  const warnings = [];
  const advisories = [];
  const warn = (code, message) => warnings.push({ code, severity: "warning", message: clip(message) });
  const advise = (code, message) => advisories.push({ code, severity: "advisory", message: clip(message) });

  const byKey = new Map(elements.map((e) => [e.key, e]));
  const byId = new Map();
  for (const e of elements) byId.set(e.id, [...(byId.get(e.id) ?? []), e]);
  for (const [id, list] of byId) {
    if (list.length < 2) continue;
    for (const e of list) e.duplicateId = true;
    warn(WIREFRAME_WARNING.DUPLICATE_ELEMENT_ID, `${list.length} elements declare the id ${quote(id)}: ${list.map((e) => e.key).join(", ")}`);
  }

  const frame = { x: 0, y: 0, ...viewport };
  const extent = { left: 0, top: 0, right: viewport.width, bottom: viewport.height };
  for (const e of elements) {
    extent.left = Math.min(extent.left, e.bounds.x);
    extent.top = Math.min(extent.top, e.bounds.y);
    extent.right = Math.max(extent.right, e.bounds.x + e.bounds.width);
    extent.bottom = Math.max(extent.bottom, e.bounds.y + e.bounds.height);
    const parent = e.parentKey ? byKey.get(e.parentKey) : null;
    if (parent && !contains(parent.bounds, e.bounds)) advise(WIREFRAME_WARNING.OUTSIDE_PARENT, `${quote(e.id)} (${e.key}) extends outside ${quote(parent.id)}, the region that contains it`);
    if (!contains(frame, e.bounds)) advise(WIREFRAME_WARNING.OUTSIDE_VIEWPORT, `${quote(e.id)} (${e.key}) extends outside the viewport`);
  }

  const known = knownIds instanceof Set ? knownIds : new Set(knownIds);
  /** One trace edge as the viewer shows it: a link when the artifact exists, text when it does not. */
  const links = (ids, field, where) =>
    (ids ?? []).map((id) => {
      const wellFormed = typeof id === "string" && ARTIFACT_ID.test(id);
      const resolved = wellFormed && known.has(id);
      // The schema lets a wireframe name a question that has not been recorded yet, so that one is an advisory.
      if (!resolved) (field === "openQuestions" && wellFormed ? advise : warn)(WIREFRAME_WARNING.TRACE_UNRESOLVED, `${where} names ${quote(id)}, which is not an artifact in this project`);
      else if (!id.startsWith(`${TRACE_PREFIX[field]}-`)) warn(WIREFRAME_WARNING.TRACE_WRONG_TYPE, `${where} names ${quote(id)}, which is not a ${TRACE_PREFIX[field]} artifact`);
      return { id: String(id), resolved };
    });

  const annotationIds = new Map();
  for (const a of annotationsIn) annotationIds.set(a.id, (annotationIds.get(a.id) ?? 0) + 1);
  for (const [id, count] of annotationIds) if (count > 1) warn(WIREFRAME_WARNING.DUPLICATE_ANNOTATION_ID, `${count} annotations declare the id ${quote(id)}`);

  const annotations = annotationsIn.map((a, index) => {
    const targets = byId.get(a.target) ?? [];
    let targetKey = null;
    let targetProblem = null;
    if (targets.length === 1) {
      targetKey = targets[0].key;
      targets[0].annotations.push(index + 1);
    } else if (targets.length === 0) {
      targetProblem = "missing";
      warn(WIREFRAME_WARNING.ANNOTATION_TARGET_MISSING, `annotation ${quote(a.id)} targets ${quote(a.target)}, which no region or component declares`);
    } else {
      targetProblem = "ambiguous";
      warn(WIREFRAME_WARNING.ANNOTATION_TARGET_AMBIGUOUS, `annotation ${quote(a.id)} targets ${quote(a.target)}, which ${targets.length} elements declare`);
    }
    return { key: `a${index}`, number: index + 1, id: a.id, note: a.note, target: a.target, targetKey, targetProblem, requirements: links(a.requirements, "requirements", `annotation ${quote(a.id)}`) };
  });

  const traces = {
    implements: links(doc.implements, "implements", "implements"),
    decidedBy: links(doc.decidedBy, "decidedBy", "decidedBy"),
    openQuestions: links(doc.openQuestions, "openQuestions", "openQuestions"),
  };

  // Warnings before advisories, so a tree that is outside its viewport everywhere cannot crowd out a dangling target.
  const all = [...warnings, ...advisories];
  return {
    ok: true,
    view: {
      id: doc.id,
      title: typeof doc.title === "string" ? doc.title : "",
      viewport,
      extent: { x: extent.left, y: extent.top, width: extent.right - extent.left, height: extent.bottom - extent.top },
      elements,
      annotations,
      traces,
      warnings: all.slice(0, WIREFRAME_LIMITS.warnings),
      omittedWarnings: Math.max(0, all.length - WIREFRAME_LIMITS.warnings),
    },
  };
}
