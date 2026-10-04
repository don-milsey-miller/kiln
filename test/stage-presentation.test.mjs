import { test } from "node:test";
import assert from "node:assert/strict";
import { deriveStagePresentation } from "../app/_review/stage-presentation.js";

const criteria = (...results) => results.map((result, index) => ({ id: `criterion-${index + 1}`, result }));

for (const [name, results, ready, state, ids] of [
  ["all criteria unattested", ["unattested", "unattested"], false, "awaiting-attestation", ["criterion-1", "criterion-2"]],
  ["some satisfied and some unattested", ["satisfied", "unattested"], false, "awaiting-attestation", ["criterion-2"]],
  ["any not-satisfied", ["satisfied", "not-satisfied"], false, "blocked", ["criterion-2"]],
  ["all satisfied or n/a", ["satisfied", "n/a"], true, "ready", []],
  ["not-satisfied takes precedence over unattested", ["unattested", "not-satisfied"], false, "blocked", ["criterion-2"]],
])
  test(`${name} -> ${state}`, () => {
    const result = deriveStagePresentation(criteria(...results), ready);
    assert.equal(result.state, state);
    assert.deepEqual(result.criterionIds, ids);
  });

test("a non-ready mechanised gate with no pending human decision is blocked", () => {
  assert.equal(deriveStagePresentation(criteria("satisfied", "n/a"), false).state, "blocked");
});

test("the three states have distinct visible words and tones", () => {
  const states = [
    deriveStagePresentation(criteria("satisfied"), true),
    deriveStagePresentation(criteria("unattested"), false),
    deriveStagePresentation(criteria("not-satisfied"), false),
  ];
  assert.equal(new Set(states.map((state) => state.label)).size, 3);
  assert.equal(new Set(states.map((state) => state.colour)).size, 3);
});
