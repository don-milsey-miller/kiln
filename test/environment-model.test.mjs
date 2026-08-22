/**
 * 7b — the environment model, pressured by two fixtures before its shape was settled (#131).
 *
 * ⚠️ The tests that matter are the NEGATIVE ones. A schema that accepts both fixtures has proved
 * nothing: the old one accepted the controller case too. What had to change is that a host run
 * becomes recordable **and** cannot claim a tier while doing it.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { createValidators, assertValid, ValidationError } from "../lib/validate.mjs";
import { loadSchemaSet, effectiveSchema } from "../lib/schema-resolver.mjs";
import { HOST_RUN, CONTROLLER_RUN, FIXTURE_DEMANDS } from "./fixtures/environment-fixtures.mjs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SCHEMAS = join(dirname(fileURLToPath(import.meta.url)), "..", "schemas");
const validators = createValidators(SCHEMAS);
const schemas = loadSchemaSet(SCHEMAS);

const experiment = (environment, over = {}) => ({
  id: "EVD-9001",
  type: "evidence",
  schemaVersion: 1,
  reviewStatus: "draft",
  lifecycle: "active",
  title: "T",
  kind: "experiment",
  summary: "Something ran.",
  outcome: "success",
  observedAt: "2026-08-22",
  environment,
  ...over,
});

const valid = (doc) => {
  try {
    assertValid(validators, "evidence", doc, "fixture");
    return true;
  } catch (e) {
    if (e instanceof ValidationError) return false;
    throw e;
  }
};

test("FIXTURE A — a direct host run is recordable, which it was not before", () => {
  // ⚠️ This is the exact run QST-0012 blocked: the probe the PM executed on 2026-08-22.
  assert.equal(valid(experiment(HOST_RUN)), true);
});

test("FIXTURE B — a controller-managed tier-1 run is recordable", () => {
  assert.equal(valid(experiment(CONTROLLER_RUN)), true);
});

test("a host run may NOT carry a sandboxTier", () => {
  // ⚠️ The load-bearing constraint of the whole reshape. Without it the model would merely PERMIT
  // honesty rather than require it, and "no isolation claim" would be a convention someone remembers.
  assert.equal(valid(experiment({ ...HOST_RUN, sandboxTier: 1 })), false);
  assert.equal(valid(experiment({ ...HOST_RUN, sandboxTier: 3 })), false);
});

test("a controller run must name its tier AND its boundary", () => {
  const { sandboxTier, isolationBoundary, ...rest } = CONTROLLER_RUN;
  assert.equal(valid(experiment(rest)), false, "no tier");
  assert.equal(valid(experiment({ ...rest, sandboxTier: 1 })), false, "tier but no boundary");
  assert.equal(valid(experiment({ ...rest, sandboxTier: 1, isolationBoundary })), true);
});

test("every experiment still requires an environment (REQ-0006 is not weakened)", () => {
  const { environment, ...withoutEnv } = experiment(HOST_RUN);
  assert.equal(valid(withoutEnv), false);
  // ...and `execution` is required, so an environment cannot be silent about who ran it.
  assert.equal(valid(experiment({ facts: { os: "Windows" } })), false);
});

test("there is no tier 0, and inventing one is rejected", () => {
  // A rung implies a comparison. "Isolation is not a thing this run has an answer to" is not the
  // bottom of a ladder, and the enum must not quietly acquire a place for it.
  assert.equal(valid(experiment({ ...CONTROLLER_RUN, sandboxTier: 0 })), false);
  const tierEnum = effectiveSchema(schemas, "evidence").properties.environment.properties.sandboxTier.enum;
  assert.deepEqual(tierEnum, [1, 2, 3]);
});

test("every omission state the fixtures produce is accepted, and every one needs a reason", () => {
  const states = [...new Set([...HOST_RUN.omissions, ...CONTROLLER_RUN.omissions].map((o) => o.state))].sort();
  assert.deepEqual(states, [...FIXTURE_DEMANDS.omissionStates].sort(), "the two fixtures must justify all four states");

  for (const state of FIXTURE_DEMANDS.omissionStates) {
    assert.equal(valid(experiment({ ...HOST_RUN, omissions: [{ fact: "x", state, reason: "because" }] })), true, state);
    // ⚠️ A state without a reason is the thing #122 was written against: "we did not observe this"
    // and "this was not observable" license different conclusions, and the state alone does not say which.
    assert.equal(valid(experiment({ ...HOST_RUN, omissions: [{ fact: "x", state }] })), false, `${state} without reason`);
  }
  assert.equal(valid(experiment({ ...HOST_RUN, omissions: [{ fact: "x", state: "irrelevant", reason: "r" }] })), false,
    "relevance is claim-relative and is not an omission state (#123)");
});

test("omissions describe the observer, so the schema offers no place for relevance or bearing", () => {
  const omission = effectiveSchema(schemas, "evidence").properties.environment.properties.omissions.items;
  assert.deepEqual(Object.keys(omission.properties).sort(), ["fact", "reason", "state"]);
  assert.equal(omission.additionalProperties, false);
});
