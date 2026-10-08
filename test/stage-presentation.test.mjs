import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
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

/* ------------------------------------------------------------------ #183: what holds the gate, as a reader is shown it */

const STAGES = join(dirname(fileURLToPath(import.meta.url)), "..", "stages");
const definitions = readdirSync(STAGES)
  .filter((name) => /^[0-9]{2}-[a-z0-9-]+[.]json$/.test(name))
  .map((name) => JSON.parse(readFileSync(join(STAGES, name), "utf-8")));

test("#183 each criterion that holds the gate carries its description, in the definition's order", () => {
  const defined = [
    { id: "first", describe: "The first thing asked.", result: "unattested" },
    { id: "second", describe: "The second thing asked.", result: "satisfied" },
    { id: "third", describe: "The third thing asked.", result: "unattested" },
    { id: "fourth", describe: "The fourth thing asked.", result: "not-satisfied" },
    { id: "fifth", describe: "The fifth thing asked.", result: "not-satisfied" },
  ];
  // Blocked: every refused criterion, in the order they are defined, and nothing that is only waiting.
  const blocked = deriveStagePresentation(defined, false);
  assert.deepEqual(blocked.criteria, [{ id: "fourth", describe: "The fourth thing asked." }, { id: "fifth", describe: "The fifth thing asked." }]);
  assert.deepEqual(blocked.criterionIds, ["fourth", "fifth"]);
  // Waiting: the same, for the ones nobody has decided.
  const awaiting = deriveStagePresentation(defined.slice(0, 3), false);
  assert.deepEqual(awaiting.criteria, [{ id: "first", describe: "The first thing asked." }, { id: "third", describe: "The third thing asked." }]);
  // Reversing the definition reverses the list: the order is the definition's and is not sorted here.
  assert.deepEqual(deriveStagePresentation([...defined.slice(0, 3)].reverse(), false).criteria.map((c) => c.id), ["third", "first"]);

  // ⚠️ THE MECHANISED-GATE FALLBACK: nothing human is pending, the gate is still closed, and no criterion is named.
  const mechanised = deriveStagePresentation([{ id: "first", describe: "x", result: "satisfied" }], false);
  assert.deepEqual([mechanised.state, mechanised.criteria, mechanised.criterionIds], ["blocked", [], []]);
  assert.deepEqual(deriveStagePresentation(defined, true).criteria, []);
  // A criterion read without a description is still named, by its id, and never by `undefined`.
  assert.deepEqual(deriveStagePresentation([{ id: "bare", result: "unattested" }, { id: "odd", describe: 7, result: "unattested" }], false).criteria, [{ id: "bare", describe: "" }, { id: "odd", describe: "" }]);
});

test("#183 every stage's criteria have a description to show, and Stage 9's long one is carried whole", () => {
  for (const definition of definitions) {
    const criteria = definition.exitCriteria.map((c) => ({ id: c.id, describe: c.describe, result: "unattested" }));
    const presentation = deriveStagePresentation(criteria, false);
    assert.deepEqual(presentation.criteria, definition.exitCriteria.map((c) => ({ id: c.id, describe: c.describe })), definition.id);
    for (const c of presentation.criteria) assert.ok(c.describe.trim().length > 0 && c.describe !== c.id, `${definition.id}/${c.id} has no description of its own`);
  }
  const handoff = definitions.find((definition) => definition.id === "09-handoff");
  const long = deriveStagePresentation(handoff.exitCriteria.map((c) => ({ ...c, result: "not-satisfied" })), false).criteria.find((c) => c.id === "runbook-steps-above-threshold");
  assert.equal(long.describe, handoff.exitCriteria.find((c) => c.id === "runbook-steps-above-threshold").describe);
  assert.ok(long.describe.length > 150, "Stage 9's criterion is no longer the long one this is here for");
});
