/**
 * The fields callers may supply to each typed creation tool.
 *
 * This is shared by the runtime boundary and the generator that publishes provider-visible tool
 * schemas. Keeping the allowlist here prevents the advertised contract and the accepted contract
 * from becoming two hand-maintained lists.
 */

import { effectiveSchema } from "../schema-resolver.mjs";

export const ARTIFACT_AUTHORING = Object.freeze({
  requirement: { fields: ["title", "statement", "rationale", "priority", "derivedFrom", "boundedBy", "verifiedBy", "evidencedBy", "openQuestions", "tags", "notes"] },
  assertion: { fields: ["title", "statement", "loadBearing", "targetEnvironment", "arisesFrom", "openQuestions", "notes", "tags"] },
  evidence: { fields: ["title", "kind", "summary", "sources", "environment", "outcome", "observedAt", "capture", "notes", "tags"] },
  "runbook-step": { fields: ["title", "instruction", "expectedOutcome", "ordinal", "destructive", "remediation", "restsOn", "partOf", "dependsOn", "notes", "tags"], required: ["restsOn"] },
  question: { fields: ["title", "statement", "resolution", "answer", "answeredBy", "blocks", "raisedBy", "notes", "tags"], defaults: { resolution: "unanswered" } },
  decision: { fields: ["title", "statement", "alternatives", "rationale", "decidedAt", "addresses", "derivedFrom", "evidencedBy", "assumesThat", "tags", "notes"] },
  component: { fields: ["title", "responsibility", "satisfies", "implementedBy", "notes", "tags"] },
  schema: { fields: ["title", "payload", "summary", "storageTarget", "implements", "decidedBy", "derivedFrom", "evidencedBy", "openQuestions", "tags", "notes"] },
  "api-spec": { fields: ["title", "payload", "summary", "implements", "decidedBy", "usesSchemas", "evidencedBy", "openQuestions", "tags", "notes"] },
  wireframe: { fields: ["title", "summary", "viewport", "regions", "annotations", "implements", "decidedBy", "openQuestions", "tags", "notes"] },
  "acceptance-criterion": { fields: ["title", "statement", "evaluates", "verifies", "outcome", "evidencedBy", "notes", "tags"], defaults: { outcome: "not-evaluated" } },
  task: { fields: ["title", "statement", "role", "implements", "fulfils", "acceptedBy", "dependsOn", "notes", "tags"] },
});

export function callerFieldsFor(type) {
  const contract = ARTIFACT_AUTHORING[type];
  if (!contract) throw new Error(`No authoring contract for ${JSON.stringify(type)}.`);
  return new Set(contract.fields);
}

function pointer(doc, segments, ref) {
  let value = doc;
  for (const segment of segments) {
    const key = segment.replace(/~1/g, "/").replace(/~0/g, "~");
    if (value === null || typeof value !== "object" || !(key in value))
      throw new Error(`Authoring schema reference does not resolve: ${ref}`);
    value = value[key];
  }
  return value;
}

/** Resolve every file/local reference into a provider-self-contained JSON Schema fragment. */
function resolveFragment(set, node, document, stack = new Set()) {
  if (Array.isArray(node)) return node.map((item) => resolveFragment(set, item, document, stack));
  if (node === null || typeof node !== "object") return node;

  if (typeof node.$ref === "string") {
    const match = /^(.*?)#\/(.+)$/.exec(node.$ref);
    if (!match) throw new Error(`Unsupported authoring schema reference: ${node.$ref}`);
    const [, file, rawPointer] = match;
    const targetDocument = file ? set.byFile[file] : document;
    if (!targetDocument) throw new Error(`Unsupported authoring schema reference target: ${node.$ref}`);
    const key = `${targetDocument.$id ?? file}|${rawPointer}`;
    if (stack.has(key)) {
      const recursiveTarget = pointer(targetDocument, rawPointer.split("/"), node.$ref);
      return {
        type: recursiveTarget.type ?? "object",
        description: recursiveTarget.description ?? "A nested value with the same structure as its parent.",
      };
    }
    const nextStack = new Set(stack).add(key);
    const target = resolveFragment(set, pointer(targetDocument, rawPointer.split("/"), node.$ref), targetDocument, nextStack);
    const siblings = Object.fromEntries(Object.entries(node).filter(([name]) => name !== "$ref"));
    return resolveFragment(set, { ...target, ...siblings }, targetDocument, nextStack);
  }

  return Object.fromEntries(Object.entries(node).map(([key, value]) => [key, resolveFragment(set, value, document, stack)]));
}

/** Remove storage-only annotations and translate trace metadata into guidance the model can read. */
function providerSafe(node) {
  if (Array.isArray(node)) return node.map(providerSafe);
  if (node === null || typeof node !== "object") return node;

  const traceTargets = Array.isArray(node["x-traceTarget"]) ? node["x-traceTarget"] : null;
  const entries = Object.entries(node)
    .filter(([key]) => key !== "$comment" && key !== "$schema" && key !== "$id" && !key.startsWith("x-") && key !== "_origin")
    .map(([key, value]) => [key, providerSafe(value)]);
  const out = Object.fromEntries(entries);
  if (traceTargets) {
    const guidance = `Valid trace target ${traceTargets.length === 1 ? "type" : "types"}: ${traceTargets.join(", ")}.`;
    out.description = out.description ? `${out.description} ${guidance}` : guidance;
  }
  return out;
}

export function buildArtifactAuthoringSchemas(set) {
  const result = {};
  for (const [type, contract] of Object.entries(ARTIFACT_AUTHORING)) {
    const source = set.types[type];
    if (!source) throw new Error(`No artifact schema for authoring type ${JSON.stringify(type)}.`);
    const effective = effectiveSchema(set, type);
    const properties = {};
    for (const field of contract.fields) {
      const local = source.properties?.[field];
      const property = local ?? effective.properties[field];
      if (!property) throw new Error(`${type}.${field} is caller-owned but absent from its type schema.`);
      properties[field] = providerSafe(resolveFragment(set, property, local ? source : set.common));
      if (contract.defaults && field in contract.defaults) properties[field].default = contract.defaults[field];
    }

    const defaults = new Set(Object.keys(contract.defaults ?? {}));
    const required = new Set([
      ...effective.required.filter((field) => contract.fields.includes(field) && !defaults.has(field)),
      ...(contract.required ?? []),
    ]);
    result[type] = {
      type: "object",
      properties,
      required: [...required].sort(),
      additionalProperties: false,
    };
  }
  return result;
}
