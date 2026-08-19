/**
 * #123 — the ownership boundary, made mechanical.
 *
 * Evidence stores observations and provenance. What those observations MEAN for a claim is
 * derived relative to that claim, so no derived or claim-relative concept may become a stored
 * field on `evidence` — and `verdict`/`confidence` may not become stored fields on `assertion`
 * either (#96 derives both).
 *
 * ⚠️ Honest about its own reach: this is a NAME check. It catches the obvious drift — someone
 * adding `polarity` or `confidence` because a renderer wanted it — and it cannot catch the same
 * concept arriving under a name nobody thought to forbid. It is a tripwire, not a proof.
 * The reviewable rule is #123; this is the cheap half that runs on every commit.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SCHEMAS = join(dirname(fileURLToPath(import.meta.url)), "..", "schemas");
const load = (name) => JSON.parse(readFileSync(join(SCHEMAS, `${name}.schema.json`), "utf-8"));

/** Every property name declared anywhere in a schema, at any depth. */
function propertyNames(node, out = new Set()) {
  if (!node || typeof node !== "object") return out;
  if (Array.isArray(node)) {
    for (const item of node) propertyNames(item, out);
    return out;
  }
  if (node.properties && typeof node.properties === "object") {
    for (const key of Object.keys(node.properties)) out.add(key);
  }
  for (const value of Object.values(node)) propertyNames(value, out);
  return out;
}

// Claim-relative concepts. None of these is a fact about a run; each is an answer to
// "what does this mean for THAT assertion", which changes per assertion.
const CLAIM_RELATIVE = ["polarity", "relevance", "relevant", "applicability", "applicable", "excluded", "bearing", "verdict", "confidence"];

test("#123 — evidence stores no claim-relative or derived concept", () => {
  const declared = propertyNames(load("evidence"));
  const violations = CLAIM_RELATIVE.filter((name) => declared.has(name));
  assert.deepEqual(
    violations,
    [],
    `evidence must not store ${violations.join(", ")} — bearing lives on the assertion's link ` +
      `(supportedBy/refutedBy) and applicability/verdict/confidence are derived per claim (#96, #123).`
  );
});

test("#123 — assertion stores neither verdict nor confidence", () => {
  const declared = propertyNames(load("assertion"));
  for (const name of ["verdict", "confidence"]) {
    assert.equal(declared.has(name), false, `assertion must not store ${name}; #96 derives it from the evidence graph.`);
  }
});

test("#123 — evidence.outcome is an observation, and says so", () => {
  const outcome = load("evidence").properties.outcome;
  // The one field that could be mistaken for polarity. It records what the RUN did; which way
  // that bears on a claim is the link's job. If the enum ever grows a claim-shaped value
  // (`supports`, `refutes`), this is the line that should stop it.
  assert.deepEqual(outcome.enum, ["success", "failure"]);
  assert.match(outcome.description, /NOT a verdict/);
});
