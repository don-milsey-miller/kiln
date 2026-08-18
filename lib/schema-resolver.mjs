/**
 * #84 — one schema-resolution layer.
 *
 * Every schema consumer reads the EFFECTIVE COMPOSED schema through this module, never the
 * local `properties` object. A type schema may narrow a field declared in the envelope
 * (`id`, `type`), which splits the constraint from the annotation: a naive read of local
 * `properties` reports those fields as unclassified while looking entirely correct. That
 * happened on the first materiality checker written, and it is why this exists.
 *
 * Deliberately NOT a validation helper (#84). Validation asks "is this document legal" and
 * belongs to Ajv. Resolution asks "what does the schema say about this field" — which is
 * what the lint (#47), template generation (#43), the typed tools, the renderer and the
 * handoff actually need. Conflating them produces a layer that answers the easy question.
 *
 * $ref support is deliberately narrow and LOUD: local `#/$defs/x` and
 * `common.schema.json#/$defs/x` resolve; anything else throws. Silently ignoring a ref it
 * does not understand is exactly how a resolver returns a confident wrong answer.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join, basename } from "node:path";

export class SchemaResolutionError extends Error {
  constructor(message) {
    super(message);
    this.name = "SchemaResolutionError";
  }
}

const COMMON = "common.schema.json";

/** Load a schema set from a directory. Returns an opaque handle used by everything below. */
export function loadSchemaSet(dir) {
  const files = readdirSync(dir).filter((f) => f.endsWith(".schema.json"));
  if (!files.includes(COMMON))
    throw new SchemaResolutionError(`No ${COMMON} in ${dir}; the shared primitives (#82) are required.`);

  const byFile = {};
  for (const f of files) byFile[f] = JSON.parse(readFileSync(join(dir, f), "utf-8"));

  const types = {};
  for (const [f, s] of Object.entries(byFile)) {
    if (f === COMMON) continue;
    const name = s["x-artifactType"];
    if (!name)
      throw new SchemaResolutionError(`${f} has no x-artifactType; every type schema must declare one.`);
    if (name !== basename(f, ".schema.json"))
      throw new SchemaResolutionError(`${f} declares x-artifactType "${name}" — file name and type must agree.`);
    types[name] = s;
  }
  return { dir, common: byFile[COMMON], types, byFile };
}

/** Resolve one `$ref` string against the set. Throws on anything it does not understand. */
function deref(set, ref) {
  const m = /^(.*?)#\/(.+)$/.exec(ref);
  if (!m) throw new SchemaResolutionError(`Unsupported $ref (no fragment): ${ref}`);
  const [, file, pointer] = m;
  const doc = file === "" ? null : set.byFile[file];
  if (file !== "" && !doc) throw new SchemaResolutionError(`Unsupported $ref target file: ${ref}`);
  return { doc, pointer: pointer.split("/").map((p) => p.replace(/~1/g, "/").replace(/~0/g, "~")) };
}

function pointerInto(doc, pointer, ref) {
  let node = doc;
  for (const seg of pointer) {
    if (node == null || typeof node !== "object" || !(seg in node))
      throw new SchemaResolutionError(`$ref does not resolve: ${ref}`);
    node = node[seg];
  }
  return node;
}

/**
 * Flatten a subschema one level: follow `$ref`, keeping any sibling keywords, which is where
 * annotations live (`{"$ref": ..., "x-materiality": "structural"}`). Sibling keys WIN, because
 * a type schema annotating a shared primitive is saying something the primitive does not.
 */
function flatten(set, node, selfDoc, seen = new Set()) {
  if (node == null || typeof node !== "object") return { node, doc: selfDoc };
  if (!("$ref" in node)) return { node, doc: selfDoc };

  const ref = node.$ref;
  if (seen.has(ref)) throw new SchemaResolutionError(`Circular $ref: ${ref}`);
  seen.add(ref);

  // A local `#/$defs/x` must resolve against the document the REFERRING node came from,
  // not against whatever schema started the walk. common.schema.json's envelope refs its
  // own $defs that way, so losing the document here silently mis-resolves every shared
  // primitive — the resolver's own version of the bug it exists to prevent.
  const { doc, pointer } = deref(set, ref);
  const nextDoc = doc ?? selfDoc;
  const target = pointerInto(nextDoc, pointer, ref);
  const inner = flatten(set, target, nextDoc, seen);
  const merged = { ...inner.node };
  for (const [k, v] of Object.entries(node)) if (k !== "$ref") merged[k] = v;
  return { node: merged, doc: inner.doc };
}

/**
 * The effective composed schema for one artifact type: every property that can appear,
 * with its annotations resolved through `allOf` and `$ref`, plus merged `required`, plus
 * the conditionals that #82 requires be nested inside `allOf`.
 */
export function effectiveSchema(set, typeName) {
  const schema = set.types[typeName];
  if (!schema) throw new SchemaResolutionError(`Unknown artifact type: ${typeName}`);

  const properties = {};
  const required = new Set();
  const conditionals = [];

  const absorb = (node, origin) => {
    const { node: s, doc: sDoc } = flatten(set, node, schema);
    for (const [name, prop] of Object.entries(s.properties ?? {})) {
      // sDoc, not `schema`: a property of the envelope refs common's own $defs locally.
      const { node: resolved } = flatten(set, prop, sDoc);
      // Later sources NARROW earlier ones; annotations already present are kept unless
      // the narrower source restates them. This is what makes `id` (narrowed locally,
      // annotated on the envelope) resolve correctly.
      properties[name] = { ...(properties[name] ?? {}), ...resolved, _origin: properties[name]?._origin ?? origin };
      if (resolved["x-materiality"]) properties[name]["x-materiality"] = resolved["x-materiality"];
      else if (properties[name]["x-materiality"]) properties[name]["x-materiality"] = properties[name]["x-materiality"];
    }
    for (const r of s.required ?? []) required.add(r);
    if (s.if) conditionals.push({ if: s.if, then: s.then, else: s.else, origin });
  };

  for (const sub of schema.allOf ?? []) absorb(sub, "composed");
  absorb(schema, "local");

  // #82's rule: a top-level conditional breaks annotation propagation. Refuse it loudly
  // rather than let it produce a schema that rejects every valid document.
  if (schema.if)
    throw new SchemaResolutionError(
      `${typeName}: conditional found at the top level. #82 requires every conditional to be nested inside allOf — ` +
        `a top-level \`if\` beside \`allOf: [$ref]\` drops the referenced envelope's evaluated-property annotations.`
    );

  return {
    type: typeName,
    stage: schema["x-stage"] ?? null,
    properties,
    required: [...required].sort(),
    conditionals,
    wrapsExternalFormat: schema["x-wrapsExternalFormat"] ?? null,
    unresolvableTraceTargets: schema["x-unresolvableTraceTargets"]?.targets ?? [],
  };
}

/** The materiality class of one field, resolved through composition. Never null on a valid set. */
export function materialityOf(set, typeName, field) {
  const eff = effectiveSchema(set, typeName);
  const prop = eff.properties[field];
  if (!prop) throw new SchemaResolutionError(`${typeName} has no field "${field}".`);
  const m = prop["x-materiality"];
  if (!m) throw new SchemaResolutionError(`${typeName}.${field} carries no x-materiality (#61 requires one).`);
  return m;
}

/** Every trace edge in the set: {from, field, to[], materiality}. The graph, from schemas alone. */
export function traceEdges(set) {
  const edges = [];
  for (const typeName of Object.keys(set.types)) {
    const eff = effectiveSchema(set, typeName);
    for (const [field, prop] of Object.entries(eff.properties)) {
      const targets = prop["x-traceTarget"];
      if (!targets) continue;
      edges.push({ from: typeName, field, to: targets, materiality: prop["x-materiality"] ?? null });
    }
  }
  return edges;
}

/**
 * Reverse index: which fields point AT a given type. This is what makes
 * `downstreamDependencies` a derived query rather than a stored duplicate of the graph
 * (see decision.schema.json's x-derivedRelations).
 */
export function reverseTraceIndex(set) {
  const index = {};
  for (const e of traceEdges(set))
    for (const target of e.to) (index[target] ??= []).push(`${e.from}.${e.field}`);
  for (const k of Object.keys(index)) index[k].sort();
  return index;
}

/** The ID prefix table from #82, as data. */
export function typePrefixes(set) {
  const table = set.common.$defs?.typePrefixes?.const;
  if (!table) throw new SchemaResolutionError(`${COMMON} has no $defs.typePrefixes.const (#82).`);
  return table;
}

/** The artifact type a trace reference names, from the reference alone — no registry (#82). */
export function typeOfId(set, id) {
  const m = /^([A-Z]+)-[0-9]{4,}$/.exec(id);
  if (!m) return null;
  const found = Object.entries(typePrefixes(set)).find(([, prefix]) => prefix === m[1]);
  return found ? found[0] : null;
}
