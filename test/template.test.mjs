import { test } from "node:test";
import assert from "node:assert/strict";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { loadSchemaSet, effectiveSchema } from "../lib/schema-resolver.mjs";
import { authoringTemplate, skeletonFor, templatesFor, TOOL_OWNED } from "../lib/template.mjs";
import { createValidators } from "../lib/validate.mjs";

const SCHEMAS = join(dirname(fileURLToPath(import.meta.url)), "..", "schemas");
const set = loadSchemaSet(SCHEMAS);
const TYPES = ["requirement", "decision", "schema", "api-spec"];

test("#43: the template is GENERATED — a new schema field appears with no code change", () => {
  const before = authoringTemplate(set, "requirement");
  assert.ok(!before.includes("invented_field"));

  const mutated = structuredClone(set);
  mutated.types.requirement.properties.invented_field = {
    type: "string",
    description: "Added by the test to prove nothing hand-lists fields.",
    "x-materiality": "semantic",
  };
  const after = authoringTemplate(mutated, "requirement");

  assert.ok(after.includes("## invented_field"), "a schema field did not reach the template");
  assert.ok(after.includes("Added by the test"), "the schema's own description is the guidance");
});

test("#43: removing a field removes it from the template", () => {
  const mutated = structuredClone(set);
  delete mutated.types.requirement.properties.tags;
  assert.ok(authoringTemplate(set, "requirement").includes("## tags"));
  assert.ok(!authoringTemplate(mutated, "requirement").includes("## tags"));
});

test("#88: tool-owned fields never appear as things to write", () => {
  for (const type of TYPES) {
    const t = authoringTemplate(set, type);
    const skeleton = skeletonFor(set, type);
    for (const owned of TOOL_OWNED) {
      assert.ok(!t.includes(`## ${owned}`), `${type} template invites the caller to write ${owned}`);
      assert.ok(!(owned in skeleton), `${type} skeleton contains tool-owned ${owned}`);
    }
  }
});

test("every required author field reaches the template and the skeleton", () => {
  for (const type of TYPES) {
    const eff = effectiveSchema(set, type);
    const t = authoringTemplate(set, type);
    const skeleton = skeletonFor(set, type);
    for (const name of eff.required) {
      if (TOOL_OWNED.has(name)) continue;
      assert.ok(t.includes(`## ${name} *(required)*`), `${type}: ${name} not marked required`);
      assert.ok(name in skeleton, `${type}: ${name} missing from skeleton`);
    }
  }
});

test("#61: every field carries its materiality, resolved through composition", () => {
  const t = authoringTemplate(set, "requirement");
  assert.match(t, /## statement \*\(required\)\*[\s\S]*?materiality: `semantic`/);
  assert.match(t, /## derivedFrom[\s\S]*?materiality: `structural`/);
  assert.match(t, /## rationale[\s\S]*?materiality: `cosmetic`/);
});

test("#75: a trace field names its targets and flags the ones not yet activated", () => {
  const t = authoringTemplate(set, "requirement");
  assert.match(t, /## evidencedBy[\s\S]*?trace → `evidence`, `assertion`/);
  assert.match(t, /## evidencedBy[\s\S]*?not activated yet[\s\S]*?advisory weight/);
  // derivedFrom points at an activated type, so it must NOT carry the warning.
  const derivedSection = t.split("## derivedFrom")[1].split("\n## ")[0];
  assert.ok(!derivedSection.includes("not activated yet"), "activated target wrongly flagged");
});

test("#45: a field that may be n/a says so, with the reason requirement", () => {
  assert.match(authoringTemplate(set, "requirement"), /## priority[\s\S]*?may be `n\/a` \*\*with a required reason\*\*/);
});

test("#86: a wrapper type's template refuses to describe the wrapped format", () => {
  for (const type of ["api-spec", "schema"]) {
    const t = authoringTemplate(set, type);
    assert.match(t, /This artifact wraps/);
    for (const modelled of ["## paths", "## components", "## entities", "## endpoints"])
      assert.ok(!t.includes(modelled), `${type} template describes ${modelled}`);
  }
});

test("#44: the guiding question is carried, and comes from the caller not from here", () => {
  const q = "What must be true for this to be considered done?";
  assert.ok(authoringTemplate(set, "requirement", { guidingQuestion: q }).includes(`↓ ask: **${q}**`));
  assert.ok(!authoringTemplate(set, "requirement").includes("↓ ask:"), "must not invent a question");
});

test("#39: only activated types get templates, and activation is supplied not inferred", () => {
  const out = templatesFor(set, ["requirement", "decision"]);
  assert.deepEqual(Object.keys(out).sort(), ["decision", "requirement"]);
});

test("the skeleton plus tool-owned fields validates against the real schema", () => {
  const validators = createValidators(SCHEMAS);
  const skeleton = skeletonFor(set, "requirement");
  // Placeholders are intentionally empty, so the skeleton alone should NOT validate —
  // it is a form to fill, not a valid artifact.
  const asArtifact = { id: "REQ-0001", type: "requirement", schemaVersion: 1, reviewStatus: "draft", lifecycle: "active", ...skeleton };
  assert.equal(validators.requirement(asArtifact), false, "an unfilled skeleton must not pass as valid");

  const filled = { ...asArtifact, title: "T", statement: "The system must do the thing." };
  assert.ok(validators.requirement(filled), "a filled skeleton must validate: " + JSON.stringify(validators.requirement.errors));
});
