import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { createValidators, assertValid } from "../lib/validate.mjs";
import {
  effectiveAssertion,
  environmentMatch,
  mayBecomeInstruction,
  EXCLUSION,
} from "../lib/effective-assertion.mjs";

const SCHEMAS = join(dirname(fileURLToPath(import.meta.url)), "..", "schemas");
const validators = createValidators(SCHEMAS);

const env = (id, type, extra) => ({ id, type, schemaVersion: 1, reviewStatus: "draft", lifecycle: "active", title: "T", ...extra });

const AST = (extra = {}) =>
  env("AST-0001", "assertion", {
    statement: "PostgreSQL 17 logical replication satisfies REQ-0012 on the target topology.",
    targetEnvironment: { facts: { os: "RHEL 10", postgres: "17" } },
    ...extra,
  });

const SOURCE = (id, extra = {}) =>
  env(id, "evidence", { kind: "source", summary: "Vendor documentation says so.", sources: [{ title: "PG docs", locator: "https://example/pg17" }], ...extra });

const EXPERIMENT = (id, facts, extra = {}) =>
  env(id, "evidence", {
    kind: "experiment",
    summary: "Ran it.",
    environment: { tier: 2, facts },
    observedAt: "2026-08-18",
    outcome: "success",
    ...extra,
  });

const map = (...records) => new Map(records.map((r) => [r.id, r]));

/* ---------------------------------------------------------- schemas are valid */

test("the three 5a schemas accept well-formed artifacts and reject a stored confidence", () => {
  assert.ok(validators.assertion(AST()), JSON.stringify(validators.assertion.errors));
  assert.ok(validators.evidence(SOURCE("EVD-0001")), JSON.stringify(validators.evidence.errors));
  assert.ok(validators.evidence(EXPERIMENT("EVD-0002", { os: "RHEL 10" })));

  // #96: confidence and verdict are derived, so the schema must refuse to store either.
  assert.equal(validators.assertion({ ...AST(), confidence: "environment-matched" }), false);
  assert.equal(validators.assertion({ ...AST(), verdict: "supported" }), false);
});

test("#25: assertion and evidence are cross-cutting and claim no stage", () => {
  for (const t of ["assertion", "evidence"]) {
    const s = JSON.parse(readFileSync(join(SCHEMAS, `${t}.schema.json`), "utf-8"));
    assert.equal(s["x-stage"], undefined, `${t} must not claim a stage`);
    assert.ok(s["x-crossCutting"], `${t} should say why it has none`);
  }
});

test("#58: a destructive runbook step needs remediation and a backing claim", () => {
  const step = env("RBS-0001", "runbook-step", { instruction: "Do it", expectedOutcome: "It is done" });
  assert.ok(validators["runbook-step"](step));
  assert.equal(validators["runbook-step"]({ ...step, destructive: true }), false, "no remediation");
  assert.equal(
    validators["runbook-step"]({ ...step, destructive: true, remediation: "Restore", restsOn: [] }),
    false,
    "no backing assertion"
  );
  assert.ok(validators["runbook-step"]({ ...step, destructive: true, remediation: "Restore", restsOn: ["AST-0001"] }));
});

/* ------------------------------------------------- applicability, then verdict */

test("environment match distinguishes match, unknown and mismatch", () => {
  assert.equal(environmentMatch({ os: "RHEL 10" }, { os: "RHEL 10" }), "match");
  assert.equal(environmentMatch({ os: "RHEL 10" }, { os: "Ubuntu 24" }), "mismatch");
  assert.equal(environmentMatch({ os: "RHEL 10", pg: "17" }, { os: "RHEL 10" }), "unknown", "silence is not a match");
  assert.equal(environmentMatch({}, { os: "RHEL 10" }), "unknown");
});

test("no applicable evidence yields unresolved", () => {
  const v = effectiveAssertion(AST(), map());
  assert.equal(v.verdict, "unresolved");
  assert.equal(v.confidence, "unverified");
});

test("only applicable support yields supported; only refutation yields refuted", () => {
  const s = effectiveAssertion(AST({ supportedBy: ["EVD-0001"] }), map(SOURCE("EVD-0001")));
  assert.equal(s.verdict, "supported");
  assert.equal(s.confidence, "source-supported");

  const r = effectiveAssertion(AST({ refutedBy: ["EVD-0001"] }), map(SOURCE("EVD-0001")));
  assert.equal(r.verdict, "refuted");
  assert.equal(r.confidence, "source-supported", "how well examined, not which way it went");
});

test("a matched experiment reaches environment-matched; an unmatched one does not", () => {
  const matched = effectiveAssertion(
    AST({ supportedBy: ["EVD-0002"] }),
    map(EXPERIMENT("EVD-0002", { os: "RHEL 10", postgres: "17" }))
  );
  assert.equal(matched.confidence, "environment-matched");

  const partial = effectiveAssertion(
    AST({ supportedBy: ["EVD-0002"] }),
    map(EXPERIMENT("EVD-0002", { os: "RHEL 10" }))
  );
  assert.equal(partial.confidence, "experimentally-validated", "silence on `postgres` caps below rung 4");
});

/* -------------------------------- FIXTURE 1: contested must not gain authority */

test("FIXTURE 1 (#96): contradictory but equally applicable evidence does not collapse to a stronger rung", () => {
  const view = effectiveAssertion(
    AST({ supportedBy: ["EVD-0002"], refutedBy: ["EVD-0003"] }),
    map(
      EXPERIMENT("EVD-0002", { os: "RHEL 10", postgres: "17" }),
      EXPERIMENT("EVD-0003", { os: "RHEL 10", postgres: "17" }, { outcome: "failure" })
    )
  );

  assert.equal(view.verdict, "contested", "both sides applicable");
  assert.equal(view.confidence, "environment-matched", "it WAS examined that well — confidence is not the verdict");

  // ⚠️ The failure this fixture exists to catch: maximum apparent authority on a claim its own
  // evidence disputes. The rung alone would say `environment-matched` and mean nothing safe.
  const decision = mayBecomeInstruction(view);
  assert.equal(decision.allowed, false, "a contested claim must not become an instruction at ANY rung");
  assert.equal(decision.because, "contested");

  assert.ok(
    view.reasons.some((r) => r.includes("does not") || r.includes("not inferred")),
    "the cause must be exposed as undiagnosed, not guessed: " + JSON.stringify(view.reasons)
  );
});

/* ------------------------ filtering happens BEFORE the verdict, which is the point */

test("stale, retired and mismatched evidence are filtered before the verdict is computed", () => {
  const cases = [
    ["retired", EXPERIMENT("EVD-0003", { os: "RHEL 10", postgres: "17" }, { outcome: "failure", lifecycle: "retired" }), EXCLUSION.RETIRED],
    ["superseded", EXPERIMENT("EVD-0003", { os: "RHEL 10", postgres: "17" }, { outcome: "failure", supersededBy: ["EVD-0009"] }), EXCLUSION.SUPERSEDED],
    ["environment mismatch", EXPERIMENT("EVD-0003", { os: "Ubuntu 24", postgres: "17" }, { outcome: "failure" }), EXCLUSION.ENVIRONMENT_MISMATCH],
    ["missing", null, EXCLUSION.MISSING],
  ];

  for (const [name, refuting, expected] of cases) {
    const evidence = refuting
      ? map(EXPERIMENT("EVD-0002", { os: "RHEL 10", postgres: "17" }), refuting)
      : map(EXPERIMENT("EVD-0002", { os: "RHEL 10", postgres: "17" }));

    const view = effectiveAssertion(AST({ supportedBy: ["EVD-0002"], refutedBy: ["EVD-0003"] }), evidence);
    assert.equal(view.verdict, "supported", `${name}: a filtered-out record must not manufacture a contradiction`);
    assert.equal(view.excluded.length, 1, name);
    assert.equal(view.excluded[0].excludedBecause, expected, name);
    assert.ok(view.reasons.some((r) => r.includes("EVD-0003")), `${name}: the exclusion must be recorded, not silent`);
  }
});

/* ------------------------------------------------ #57's threshold, on top of verdict */

test("#57: below-threshold, refuted and unresolved each block for a distinguishable reason", () => {
  const sourceOnly = effectiveAssertion(AST({ supportedBy: ["EVD-0001"] }), map(SOURCE("EVD-0001")));
  assert.equal(mayBecomeInstruction(sourceOnly).because, "below-threshold");
  assert.equal(mayBecomeInstruction(sourceOnly, { minimumConfidence: "source-supported" }).allowed, true);

  assert.equal(mayBecomeInstruction(effectiveAssertion(AST(), map())).because, "unresolved");
  assert.equal(
    mayBecomeInstruction(effectiveAssertion(AST({ refutedBy: ["EVD-0001"] }), map(SOURCE("EVD-0001")))).because,
    "refuted"
  );

  const matched = effectiveAssertion(
    AST({ supportedBy: ["EVD-0002"] }),
    map(EXPERIMENT("EVD-0002", { os: "RHEL 10", postgres: "17" }))
  );
  assert.equal(mayBecomeInstruction(matched).allowed, true);
});
