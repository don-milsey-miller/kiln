/**
 * #134 — isolation is a claim-relative dimension, not a global ceiling.
 *
 * ⚠️ The four cases below are the decision, stated as tests. The one that is easiest to get wrong is
 * the last: **a claim that never asked about isolation must not be penalised for lacking it.** Getting
 * that wrong reintroduces the tier ceiling by accident, wearing different words.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { isolationMatch, combineMatch, effectiveAssertion, EXCLUSION } from "../lib/effective-assertion.mjs";

const TIER1 = { isolates: ["python-dependencies"], doesNotClaim: ["containment-of-hostile-code", "host-filesystem-denial", "network-isolation"] };
const TIER2 = { isolates: ["filesystem", "process", "network-isolation"], doesNotClaim: ["kernel-isolation"] };

test("required and matched", () => {
  assert.equal(isolationMatch(["network-isolation"], TIER2), "match");
});

test("required but absent — unknown, because a host run claims no isolation rather than denying it", () => {
  assert.equal(isolationMatch(["network-isolation"], null), "unknown");
  assert.equal(isolationMatch(["kernel-isolation"], { isolates: ["filesystem"], doesNotClaim: [] }), "unknown");
});

test("required and explicitly not claimed — incompatible", () => {
  // ⚠️ This is what DEC-0005's `doesNotClaim` list buys: an explicit denial is a CONTRADICTION of the
  // requirement, where silence would only have been unknown.
  assert.equal(isolationMatch(["containment-of-hostile-code"], TIER1), "mismatch");
});

test("not required — neutral, with no global penalty", () => {
  assert.equal(isolationMatch([], TIER1), "not-required");
  assert.equal(isolationMatch(undefined, null), "not-required");
  // ...and neutral really means neutral in the combination.
  assert.equal(combineMatch("match", "not-required"), "match");
  assert.equal(combineMatch("unknown", "not-required"), "unknown");
  assert.equal(combineMatch("not-required", "not-required"), "unknown", "nothing compared at all is unknown");
});

test("combination is conservative: any mismatch wins, then any unknown", () => {
  assert.equal(combineMatch("match", "mismatch"), "mismatch");
  assert.equal(combineMatch("unknown", "mismatch"), "mismatch");
  assert.equal(combineMatch("match", "unknown"), "unknown");
  assert.equal(combineMatch("match", "match"), "match");
});

/* -------------------------------------------------- the decision, end to end through the view */

const evidenceMap = (env) =>
  new Map([["EVD-1", { id: "EVD-1", type: "evidence", kind: "experiment", lifecycle: "active", outcome: "success", environment: env }]]);

const assertion = (targetEnvironment) => ({ id: "AST-1", type: "assertion", statement: "s", targetEnvironment, supportedBy: ["EVD-1"] });

test("a HOST run reaches environment-matched for a claim about that host (AST-0013's case)", () => {
  // ⚠️ The case the PM used to settle #134. Nothing about this claim turns on isolation, so the
  // absence of isolation is not a shortfall — it is irrelevant to what is being claimed.
  const view = effectiveAssertion(
    assertion({ facts: { os: "Windows", backend: "tavily" } }),
    evidenceMap({ execution: "host", facts: { os: "Windows", backend: "tavily" } })
  );
  assert.equal(view.verdict, "supported");
  assert.equal(view.confidence, "environment-matched");
});

test("tier 1 does NOT lift an OS-containment claim merely because a venv existed", () => {
  const view = effectiveAssertion(
    assertion({ facts: { os: "Windows" }, requiresIsolation: ["containment-of-hostile-code"] }),
    evidenceMap({ execution: "controller", sandboxTier: 1, isolationBoundary: TIER1, facts: { os: "Windows" } })
  );
  // Excluded outright: tier 1 states it does not contain hostile code, so this record cannot bear
  // on a claim that depends on containment.
  assert.equal(view.verdict, "unresolved");
  assert.equal(view.excluded[0].excludedBecause, EXCLUSION.ISOLATION_INCOMPATIBLE);
});

test("a containment claim backed by a host run is capped, not excluded", () => {
  const view = effectiveAssertion(
    assertion({ facts: { os: "Windows" }, requiresIsolation: ["network-isolation"] }),
    evidenceMap({ execution: "host", facts: { os: "Windows" } })
  );
  // The run is silent about isolation rather than contradicting it, so it still bears on the claim —
  // it just cannot carry it to rung 4.
  assert.equal(view.verdict, "supported");
  assert.equal(view.confidence, "experimentally-validated");
  assert.equal(view.excluded.length, 0);
});

test("a tier-2 run satisfying the requirement reaches rung 4", () => {
  const view = effectiveAssertion(
    assertion({ facts: { os: "Ubuntu 24" }, requiresIsolation: ["network-isolation"] }),
    evidenceMap({ execution: "controller", sandboxTier: 2, isolationBoundary: TIER2, facts: { os: "Ubuntu 24" } })
  );
  assert.equal(view.confidence, "environment-matched");
});

test("isolation exclusion is distinguishable from a fact mismatch", () => {
  // Two different problems with two different fixes: run it somewhere else, versus run it under
  // something that offers the boundary.
  const factMismatch = effectiveAssertion(
    assertion({ facts: { os: "RHEL 10" } }),
    evidenceMap({ execution: "host", facts: { os: "Windows" } })
  );
  assert.equal(factMismatch.excluded[0].excludedBecause, EXCLUSION.ENVIRONMENT_MISMATCH);
});
