/**
 * The wire names, stated twice and compared — TSK-0051 (S11, D45).
 *
 * ⚠️ **TWO INDEPENDENT STATEMENTS, NOT ONE AGREEING WITH ITSELF.** `lib/tool-wire-names.mjs` exists
 * because `lib/` must not import the package; `pi-package/extensions/kiln.js` spells the same names out
 * because it must load with nothing but `pi-package/` present, which a fixture measures. Neither can
 * import the other, so this file is the only thing keeping them honest. It compares in BOTH directions:
 * a name in one and not the other is a defect whichever side it is missing from.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { CREATE_TOOL_NAMES, MUTATION_TOOL_NAMES, TYPE_ACTIVATION_TOOL_NAME, UnknownOperationError, createToolName, mutationToolName } from "../lib/tool-wire-names.mjs";
import { MUTATION_TOOLS, TYPED_TOOLS } from "../lib/tools/registry.mjs";
import register from "../pi-package/extensions/kiln.js";

/** Every tool name the package actually registers. */
const registered = () => {
  const names = [];
  register({ registerTool: (tool) => names.push(tool.name) });
  return new Set(names);
};

test("⚠️ every wire name this library claims is a tool the package really registers", () => {
  const names = registered();
  for (const [type, name] of Object.entries(CREATE_TOOL_NAMES))
    assert.ok(names.has(name), `${type}: the package registers no ${name}`);
  for (const [entry, name] of Object.entries(MUTATION_TOOL_NAMES))
    assert.ok(names.has(name), `${entry}: the package registers no ${name}`);
  assert.ok(names.has(TYPE_ACTIVATION_TOOL_NAME));
});

test("⚠️ and every tool the package registers for an operation is claimed here", () => {
  // The other direction. A tool added to the package and not to this map would be invisible to a role's
  // derived allowlist, so a specialist would silently never be offered it.
  const names = registered();
  const claimed = new Set([...Object.values(CREATE_TOOL_NAMES), ...Object.values(MUTATION_TOOL_NAMES), TYPE_ACTIVATION_TOOL_NAME]);
  const operational = [...names].filter((n) => /^kiln_(create_|link_|unlink_|revise_|set_|resolve_)/.test(n) && n !== "kiln_write_stage_attestation");
  assert.deepEqual(
    operational.filter((n) => !claimed.has(n)),
    [],
    "a package tool for a create or mutation is missing from lib/tool-wire-names.mjs"
  );
});

test("⚠️ the map covers exactly the registry's operations, so a role can name any of them", () => {
  assert.deepEqual(Object.keys(CREATE_TOOL_NAMES).sort(), Object.keys(TYPED_TOOLS).sort());
  assert.deepEqual(Object.keys(MUTATION_TOOL_NAMES).sort(), Object.keys(MUTATION_TOOLS).sort());
});

test("⚠️ an operation with no tool is refused, never given a constructed name", () => {
  // ⚠️ A CONSTRUCTED NAME WOULD REACH A ROLE'S ALLOWLIST and then vanish at intersection time, narrowing
  // the child in a way nothing reported.
  for (const [fn, kind, bad] of [
    [createToolName, "create", "sprint"],
    [mutationToolName, "mutation", "deleteEverything"],
  ]) {
    assert.throws(
      () => fn(bad),
      (e) => e instanceof UnknownOperationError && e.kind === kind && e.operation === bad && e.message.includes(bad)
    );
  }
});

test("⚠️ the names are not derivable from the operation, which is why they are written out", () => {
  // Two counterexamples to any rule that would map one to the other.
  assert.equal(CREATE_TOOL_NAMES["acceptance-criterion"], "kiln_create_acceptance_criterion");
  assert.equal(CREATE_TOOL_NAMES["runbook-step"], "kiln_create_runbook_step");
  assert.equal(MUTATION_TOOL_NAMES.reviseArtifact, "kiln_revise_artifact");
});
