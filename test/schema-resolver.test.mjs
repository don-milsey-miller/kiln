import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  loadSchemaSet,
  effectiveSchema,
  materialityOf,
  traceEdges,
  reverseTraceIndex,
  typeOfId,
  typePrefixes,
  SchemaResolutionError,
} from "../lib/schema-resolver.mjs";

const SCHEMAS = join(dirname(fileURLToPath(import.meta.url)), "..", "schemas");
const set = loadSchemaSet(SCHEMAS);
const TYPES = Object.keys(set.types); // derived: the set grows as 5a lands types

test("loads every type schema plus the shared primitives", () => {
  // Step 3's four, plus 5a's evidence types. Asserted as a superset so the test does not have
  // to be edited every time a type lands, but still fails if one disappears.
  for (const t of ["requirement", "decision", "schema", "api-spec", "assertion", "evidence", "runbook-step"])
    assert.ok(set.types[t], `${t} schema missing`);
  assert.ok(set.common.$defs.artifactEnvelope, "shared primitives missing");
});

test("effective schema sees envelope fields the type never re-lists", () => {
  const eff = effectiveSchema(set, "requirement");
  for (const f of ["id", "type", "schemaVersion", "reviewStatus", "lifecycle", "title"])
    assert.ok(eff.properties[f], `envelope field ${f} missing from effective schema`);
  assert.ok(eff.properties.statement, "local field missing");
});

test("a narrowed field keeps the envelope's annotation and the local constraint", () => {
  // This is the exact case the naive checker got wrong: `id` is annotated on the envelope
  // and narrowed locally, so composition-blind lookup reports it unclassified.
  const eff = effectiveSchema(set, "requirement");
  assert.equal(eff.properties.id["x-materiality"], "structural", "annotation lost through allOf");
  assert.equal(eff.properties.id.pattern, "^REQ-[0-9]{4,}$", "local narrowing lost");
});

test("#61: every field of every type resolves to a materiality class", () => {
  const allowed = set.common.$defs.materialityValues.const;
  for (const t of TYPES)
    for (const f of Object.keys(effectiveSchema(set, t).properties))
      assert.ok(allowed.includes(materialityOf(set, t, f)), `${t}.${f} unclassified`);
});

test("required merges across composition", () => {
  const eff = effectiveSchema(set, "requirement");
  for (const f of ["id", "type", "schemaVersion", "reviewStatus", "lifecycle", "title", "statement"])
    assert.ok(eff.required.includes(f), `${f} should be required`);
});

test("#82: conditionals are visible and none sit at the top level", () => {
  const eff = effectiveSchema(set, "decision");
  assert.equal(eff.conditionals.length, 1, "the lifecycle/supersededBy invariant should be found");
  for (const t of TYPES) assert.doesNotThrow(() => effectiveSchema(set, t));
});

test("#82: a top-level conditional is refused loudly", () => {
  const broken = structuredClone(set);
  broken.types.requirement = { ...broken.types.requirement, if: { properties: {} } };
  assert.throws(() => effectiveSchema(broken, "requirement"), SchemaResolutionError);
});

test("#84: the trace graph is derivable from the schemas alone", () => {
  const edges = traceEdges(set);
  assert.ok(edges.length > 0);
  for (const e of edges) {
    assert.equal(e.materiality, "structural", `${e.from}.${e.field} trace edge should be structural`);
    for (const target of e.to)
      assert.ok(target in typePrefixes(set), `${e.from}.${e.field} points at unknown type ${target}`);
  }
});

test("#84: downstreamDependencies is a derived reverse query, not a stored field", () => {
  const index = reverseTraceIndex(set);
  assert.ok(index.decision.includes("api-spec.decidedBy"));
  assert.ok(index.decision.includes("schema.decidedBy"));
  assert.ok(index.requirement.includes("api-spec.implements"));
  for (const t of TYPES)
    assert.ok(!("downstreamDependencies" in effectiveSchema(set, t).properties), `${t} stores the reverse graph`);
});

test("#82: a trace reference names its type without a registry", () => {
  assert.equal(typeOfId(set, "REQ-0001"), "requirement");
  assert.equal(typeOfId(set, "AST-0007"), "assertion", "must work for types that are not activated");
  assert.equal(typeOfId(set, "TSK-123456"), "task", "must work past four digits");
  assert.equal(typeOfId(set, "ZZZ-0001"), null);
  assert.equal(typeOfId(set, "REQ-1"), null);
});

test("#75: unresolvable trace targets are declared, so a dangle is not a typo", () => {
  const eff = effectiveSchema(set, "decision");
  assert.deepEqual([...eff.unresolvableTraceTargets].sort(), ["assertion", "evidence", "question"]);
});

test("#86: wrapper types declare the format they wrap and model none of it", () => {
  for (const t of ["api-spec", "schema"]) {
    const eff = effectiveSchema(set, t);
    assert.ok(eff.wrapsExternalFormat, `${t} should declare x-wrapsExternalFormat`);
    assert.ok(eff.properties.payload, `${t} should carry a payloadRef`);
    for (const modelled of ["paths", "components", "entities", "tables", "endpoints", "fields"])
      assert.ok(!(modelled in eff.properties), `${t} re-models ${modelled}, which #86 refuses`);
  }
});

test("an unsupported $ref throws rather than resolving to nothing", () => {
  const broken = structuredClone(set);
  broken.types.requirement.properties.statement = { $ref: "https://example.com/other.json#/$defs/x" };
  assert.throws(() => effectiveSchema(broken, "requirement"), SchemaResolutionError);
});
