import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { createQuestion, reviseArtifact } from "../lib/tools/evidence-tools.mjs";
import { createValidators, ValidationError } from "../lib/validate.mjs";
import { loadSchemaSet, effectiveSchema } from "../lib/schema-resolver.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCHEMAS = join(ROOT, "schemas");
const schemas = loadSchemaSet(SCHEMAS);
const validators = createValidators(SCHEMAS);

function fresh() {
  const base = mkdtempSync(join(tmpdir(), "vpw-q-"));
  const contentRoot = join(base, "planning-content");
  mkdirSync(contentRoot, { recursive: true });
  return { base, o: { contentRoot, schemasDir: SCHEMAS, validators, schemas } };
}
const Q = { title: "Why?", statement: "Why did the thing happen?" };

test("REQ-0014: a question is a tracked object with its own state, defaulting to unanswered", async () => {
  const { base, o } = fresh();
  try {
    const q = await createQuestion(Q, o);
    assert.equal(q.artifact.resolution, "unanswered");
    assert.equal(q.artifact.reviewStatus, "draft");
    assert.equal(q.artifact.lifecycle, "active");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("#82: resolution is a THIRD axis — a question can be approved, active and unanswered", () => {
  const doc = {
    id: "QST-0001", type: "question", schemaVersion: 1,
    reviewStatus: "approved", lifecycle: "active", resolution: "unanswered",
    title: "T", statement: "Still open.",
  };
  assert.ok(validators.question(doc), JSON.stringify(validators.question.errors));
  // Collapsing any two of the three would lose exactly this state.
  const eff = effectiveSchema(schemas, "question");
  for (const f of ["reviewStatus", "lifecycle", "resolution"]) assert.ok(eff.properties[f], `${f} missing`);
  assert.equal(eff.properties.resolution["x-materiality"], "semantic");
});

test("an answered question must record the answer or what settled it", async () => {
  const { base, o } = fresh();
  try {
    await assert.rejects(() => createQuestion({ ...Q, resolution: "answered" }, o), /answered|Invalid|assembled/);

    const withAnswer = await createQuestion({ ...Q, resolution: "answered", answer: "Because of X." }, o);
    assert.equal(withAnswer.artifact.resolution, "answered");

    const withLink = await createQuestion({ ...Q, resolution: "answered", answeredBy: ["DEC-0001"] }, o);
    assert.deepEqual(withLink.artifact.answeredBy, ["DEC-0001"]);

    // deferred and moot need neither — they are not claims that something was settled.
    for (const r of ["deferred", "moot"]) {
      const q = await createQuestion({ ...Q, resolution: r }, o);
      assert.equal(q.artifact.resolution, r);
    }
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("#41: question is traversed by other types, which is why it is an artifact", () => {
  const traversers = [];
  for (const type of Object.keys(schemas.types))
    for (const [field, prop] of Object.entries(effectiveSchema(schemas, type).properties))
      if (prop["x-traceTarget"]?.includes("question")) traversers.push(`${type}.${field}`);

  assert.ok(traversers.length >= 3, `expected several types to traverse question, got ${traversers.join(", ")}`);
  assert.ok(traversers.includes("decision.addresses"));
  assert.ok(traversers.includes("requirement.openQuestions"));
});

test("#103: answering a question is a semantic change, so it amends an approval", async () => {
  const { base, o } = fresh();
  try {
    const q = await createQuestion(Q, o);
    const r = await reviseArtifact("question", q.id, { resolution: "answered", answer: "Because of X." }, o);
    assert.equal(r.amends, true);
    assert.equal(r.stream, "change-feed");
    assert.deepEqual(r.changedFields.map((c) => c.field).sort(), ["answer", "resolution"]);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
