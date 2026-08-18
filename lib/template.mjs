/**
 * #43 — templates are GENERATED from the activated artifact types plus their schemas, never
 * hand-written per stage. Hand-authored templates and schemas drift, and a template that
 * disagrees with its schema teaches the agent the wrong shape.
 *
 * This is the first consumer of #84's resolution layer, and it asks that layer the easy
 * question: "what structure does this schema imply?" The lint asks the harder one — "does
 * this artifact satisfy the planning rules beyond mere schema validity?" — which is why the
 * two are separate mechanisms rather than two names for validation.
 *
 * Nothing here contains a field list. If it did, #43 would be false the moment a schema
 * changed, and the test suite asserts exactly that by adding a field and watching the output
 * move.
 */

import { effectiveSchema } from "./schema-resolver.mjs";

/** Fields the typed tool injects (#88). A template must never invite a caller to supply them. */
export const TOOL_OWNED = new Set(["id", "type", "schemaVersion", "reviewStatus", "lifecycle"]);

const ORDER = { structural: 0, semantic: 1, advisory: 2, cosmetic: 3 };

/** Author-facing fields, required first, then by materiality, then alphabetically. */
function authorFields(eff) {
  return Object.entries(eff.properties)
    .filter(([name]) => !TOOL_OWNED.has(name))
    .map(([name, prop]) => ({
      name,
      prop,
      required: eff.required.includes(name),
      materiality: prop["x-materiality"],
      traceTarget: prop["x-traceTarget"] ?? null,
    }))
    .sort(
      (a, b) =>
        Number(b.required) - Number(a.required) ||
        ORDER[a.materiality] - ORDER[b.materiality] ||
        a.name.localeCompare(b.name)
    );
}

/** A placeholder value implied by the schema, not by a lookup table of field names. */
function placeholderFor(prop) {
  if (prop["x-traceTarget"]) return [];
  if (prop.type === "array") return [];
  if (prop.enum) return prop.enum[0];
  if (prop.oneOf) {
    const enumBranch = prop.oneOf.find((b) => b.enum);
    if (enumBranch) return enumBranch.enum[0];
  }
  if (prop.type === "integer" || prop.type === "number") return 0;
  if (prop.format === "date") return "YYYY-MM-DD";
  return "";
}

/**
 * A JSON skeleton for one artifact type: required author fields present, tool-owned fields
 * absent because the typed tool supplies them (#88).
 */
export function skeletonFor(set, type) {
  const eff = effectiveSchema(set, type);
  const out = {};
  for (const f of authorFields(eff)) if (f.required) out[f.name] = placeholderFor(f.prop);
  return out;
}

/**
 * A human/agent authoring template for one artifact type.
 *
 * @param {object} set               schema set from loadSchemaSet
 * @param {string} type              artifact type
 * @param {{guidingQuestion?: string}} [opts]  #44 — the stage's guiding question. Comes from
 *   the single `stages/` definition set (#34) once that exists; passed in until then rather
 *   than invented here, so there is never a second description of a stage.
 */
export function authoringTemplate(set, type, opts = {}) {
  const eff = effectiveSchema(set, type);
  const fields = authorFields(eff);
  const L = [];

  L.push(`# ${type}`);
  L.push("");
  L.push(`_Generated from \`${type}.schema.json\` (#43). Do not hand-edit: regenerate._`);
  if (eff.stage) L.push(`_Stage: ${eff.stage}._`);
  L.push("");

  if (opts.guidingQuestion) {
    L.push(`> ↓ ask: **${opts.guidingQuestion}**`);
    L.push("");
  }

  if (eff.wrapsExternalFormat) {
    L.push(
      `⚠️ **This artifact wraps ${eff.wrapsExternalFormat.format} (#86).** The content lives in the ` +
        `payload file; nothing about ${eff.wrapsExternalFormat.format} is described here. ` +
        `Validated by ${eff.wrapsExternalFormat.validatedBy}.`
    );
    L.push("");
  }

  L.push(`_The tool supplies ${[...TOOL_OWNED].join(", ")} — do not write them (#88)._`);
  L.push("");

  for (const f of fields) {
    L.push(`## ${f.name}${f.required ? " *(required)*" : ""}`);
    L.push("");
    if (f.prop.description) L.push(f.prop.description);
    const facts = [`materiality: \`${f.materiality}\``];
    if (f.traceTarget) {
      const dangling = f.traceTarget.filter((t) => eff.unresolvableTraceTargets.includes(t));
      facts.push(`trace → ${f.traceTarget.map((t) => `\`${t}\``).join(", ")}`);
      if (dangling.length)
        facts.push(
          `⚠️ ${dangling.map((t) => `\`${t}\``).join(", ")} not activated yet — links are permitted and ` +
            `reported at advisory weight until they are (#75)`
        );
    }
    if (f.prop.oneOf?.some((b) => b.$ref?.includes("notApplicable") || b.properties?.na))
      facts.push("may be `n/a` **with a required reason** (#45)");
    L.push("");
    L.push(facts.map((s) => `- ${s}`).join("\n"));
    L.push("");
  }

  L.push("---");
  L.push("");
  L.push("```json");
  L.push(JSON.stringify(skeletonFor(set, type), null, 2));
  L.push("```");
  L.push("");

  return L.join("\n");
}

/** Every activated type's template. `activated` comes from project.yaml (#39), never from here. */
export function templatesFor(set, activated, opts = {}) {
  const out = {};
  for (const type of activated) out[type] = authoringTemplate(set, type, opts[type] ?? {});
  return out;
}
