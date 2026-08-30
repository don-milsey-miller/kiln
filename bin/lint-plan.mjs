#!/usr/bin/env node
/**
 * #47 caller 1 of 3 — `npm run lint:plan`.
 *
 * Deliberately thin. It RENDERS structured findings and nothing else: it does not interpret
 * rules, does not decide severity, and does not define what blocks. `blocks()` and the gate
 * layer own that policy, because #47's three callers must not become three enforcement
 * models.
 *
 * Caller 2 is the application, and it arrived as the row predicted: `app/server/content.js`
 * re-exports `lintProject` from lib/lint.mjs by name and `app/_read/planning.js` calls it, so
 * the app renders findings it did not re-judge and has no rules of its own. Caller 3,
 * `pi-package/`, is still not written and imports the same entry points when it is.
 *
 * (This said "the app is not built" until 2026-08-29. The claim it was making — one rule set,
 * three callers — is the part that survived, and it is now demonstrated rather than intended.)
 *
 * Usage:
 *   node bin/lint-plan.mjs                      report everything, exit 0
 *   node bin/lint-plan.mjs --gate handoff       enforce #46's handoff boundary
 *   node bin/lint-plan.mjs --gate stage:<id>    enforce a stage transition
 *   node bin/lint-plan.mjs --json               structured output for a machine reader
 */

import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { resolveContentRoot } from "../lib/content-root.mjs";
import { loadSchemaSet } from "../lib/schema-resolver.mjs";
import { createValidators } from "../lib/validate.mjs";
import { lintProject, evaluateStageGate, evaluateHandoffGate, blocks, SEVERITY } from "../lib/lint.mjs";
import { readActivatedTypes } from "../lib/activation.mjs";
import { loadStageAttestations } from "../lib/attestations.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const asJson = args.includes("--json");
const gateArg = (args.find((a) => a.startsWith("--gate")) ?? "").split("=")[1] ?? args[args.indexOf("--gate") + 1];

const ICON = { [SEVERITY.ERROR]: "✖", [SEVERITY.WARNING]: "▲", [SEVERITY.ADVISORY]: "·" };

function render(findings) {
  if (findings.length === 0) return "No findings.";
  return findings
    .map((f) => `${ICON[f.severity] ?? "?"} ${f.severity.padEnd(9)} ${f.ruleId.padEnd(34)} ${f.path ?? ""}\n    ${f.message}`)
    .join("\n");
}

let contentRoot;
try {
  contentRoot = resolveContentRoot();
} catch (e) {
  console.error(e.message);
  process.exit(2);
}

const ctx = {
  contentRoot,
  schemas: loadSchemaSet(join(ROOT, "schemas")),
  validators: createValidators(join(ROOT, "schemas")),
  activated: readActivatedTypes(contentRoot),
};

let result;
if (gateArg === "handoff") result = { kind: "handoff", ...evaluateHandoffGate(ctx) };
else if (gateArg?.startsWith("stage:")) {
  const stageId = gateArg.slice(6);
  try {
    result = { kind: "stage", ...evaluateStageGate(ctx, stageId, { attestations: loadStageAttestations(contentRoot, stageId) }) };
  } catch (e) {
    // A mistyped stage id used to exit with a stack trace. The gate is the thing people run at a
    // transition, and a tool that crashes on a typo teaches them to distrust its output on a real
    // failure — the same reason the research CLI stopped calling process.exit() after a fetch.
    const { loadStageDefinitions } = await import("../lib/stages.mjs");
    const known = Object.keys(loadStageDefinitions()).sort();
    console.error(`${e.message}\n\nKnown stages:\n  ${known.join("\n  ")}`);
    process.exit(2);
  }
}
else result = { kind: "report", ...lintProject(ctx) };

if (asJson) {
  console.log(JSON.stringify(result, null, 2));
} else if (result.kind === "report") {
  console.log(render(result.findings));
  const counts = result.findings.reduce((a, f) => ({ ...a, [f.severity]: (a[f.severity] ?? 0) + 1 }), {});
  console.log(`\n${result.records.length} artifact(s) · ${JSON.stringify(counts)}`);
} else {
  const artifactFindings =
    result.allFindings ?? [...(result.blocking ?? []), ...(result.warnings ?? []), ...(result.advisories ?? [])];
  console.log("Artifacts:\n" + render(artifactFindings));
  if (result.kind === "stage") console.log("\nGate:\n" + render(result.gateFindings));
  console.log(`\nGate: ${result.kind}${result.stageId ? ` ${result.stageId}` : ""} — ${result.ready ? "READY" : "NOT READY"}`);
  if (result.kind === "stage" && !result.stageDefinitionsFound)
    console.log("  (no stages/ definitions found — #34/#90: the gate will not report ready on criteria it has never seen)");
  if (result.pendingHumanCriteria?.length)
    console.log(`  ${result.pendingHumanCriteria.length} criterion/criteria await a human evaluation (satisfied / not-satisfied / n/a+reason): ${result.pendingHumanCriteria.join(", ")}`);
}

// Exit policy: only a gate blocks, and only the gate decides (#46, #47).
if (result.kind === "report") process.exit(0);
process.exit(result.ready ? 0 : 1);
