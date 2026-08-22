/**
 * `TSK-0002`, evaluated against `ACC-0011` and `ACC-0012`.
 *
 * ⚠️ Constructed fixtures throughout (#117). The live project cannot exercise `ACC-0012` any more:
 * `RBS-0001` — the very step whose unflagged premise produced the finding — was retired, so the real
 * graph now has no instruction at all. **The case the criterion is about has to be built.**
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stage6Scope, describeStage6Scope } from "../lib/stage-scope.mjs";

const doc = (o) => ({ lifecycle: "active", ...o });
const step = (id, restsOn, over = {}) => doc({ id, type: "runbook-step", restsOn, ...over });
const assertion = (id, over = {}) => doc({ id, type: "assertion", statement: "s", ...over });

/* ---------------------------------------------------------------------------------- ACC-0011 */

test("ACC-0011: the scope is computed from restsOn, and the module never mentions loadBearing", () => {
  const records = [
    step("RBS-0001", ["AST-0002"]),
    assertion("AST-0002"),
    // ⚠️ Flagged loadBearing and under NO instruction. Under the old rule it defined the scope;
    // under the new one it is simply not in it, because nothing rests on it.
    assertion("AST-0013", { loadBearing: true }),
  ];
  assert.deepEqual(stage6Scope(records).assertionIds, ["AST-0002"]);

  // A name check, like #123's: it catches the obvious regression, not a clever equivalent. Comments
  // are stripped first so the file may explain the rule it enforces (the #142 lesson).
  const src = readFileSync(new URL("../lib/stage-scope.mjs", import.meta.url), "utf-8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  assert.equal(/loadBearing/.test(src), false, "the scope must not consult the flag");
});

/* ---------------------------------------------------------------------------------- ACC-0012 */

test("ACC-0012: an UNFLAGGED premise of an active step is in scope", () => {
  // ⚠️ The exact case that passed vacuously: RBS-0001 rested on AST-0002, which had no flag.
  for (const flag of [undefined, false]) {
    const records = [step("RBS-0001", ["AST-0002"]), assertion("AST-0002", flag === undefined ? {} : { loadBearing: flag })];
    assert.deepEqual(stage6Scope(records).assertionIds, ["AST-0002"], `loadBearing: ${flag}`);
  }
});

test("a retired instruction takes its premises out of scope", () => {
  const records = [step("RBS-0001", ["AST-0002"], { lifecycle: "retired" }), assertion("AST-0002")];
  const scope = stage6Scope(records);
  assert.deepEqual(scope.assertionIds, []);
  assert.equal(scope.empty, true);
});

test("multiple instructions union their premises, and the basis says which came from where", () => {
  const records = [
    step("RBS-0002", ["AST-0003", "AST-0002"]),
    step("RBS-0001", ["AST-0002"]),
    assertion("AST-0002"),
    assertion("AST-0003"),
  ];
  const scope = stage6Scope(records);
  assert.deepEqual(scope.assertionIds, ["AST-0002", "AST-0003"]);
  assert.deepEqual(scope.basis, [
    { instruction: "RBS-0001", restsOn: ["AST-0002"] },
    { instruction: "RBS-0002", restsOn: ["AST-0002", "AST-0003"] },
  ]);
});

test("an empty scope is reported as n/a, never as satisfied", () => {
  // ⚠️ The vacuity did not vanish — it MOVED. With nothing resting on anything the criterion is
  // again satisfiable with nothing checked, but that is now a fact about the PLAN rather than about
  // whether someone remembered to set a flag. The difference is that this one is visible.
  const empty = describeStage6Scope(stage6Scope([]));
  assert.equal(empty.suggested, "n/a");
  assert.match(empty.detail, /clears every bar vacuously/);

  const full = describeStage6Scope(stage6Scope([step("RBS-0001", ["AST-0002"]), assertion("AST-0002")]));
  assert.equal(full.suggested, "evaluate");
  assert.match(full.detail, /RBS-0001 rests on AST-0002/);
});
