#!/usr/bin/env node
/**
 * #47 caller 1 of 3 — `npm run lint:plan`.
 *
 * Deliberately thin. It RENDERS structured findings and nothing else: it does not interpret
 * rules, does not decide severity, and does not define what blocks. `blocks()` and the gate
 * layer own that policy, because #47's three callers must not become three enforcement
 * models.
 *
 * The other two callers cannot exist yet: the app is not built, and `pi-package/` is not
 * written. Both will import the SAME entry points from lib/lint.mjs — that is the whole
 * point of the row — and neither gets its own rules.
 *
 * Usage:
 *   node bin/lint-plan.mjs                      report everything, exit 0
 *   node bin/lint-plan.mjs --gate handoff       enforce #46's handoff boundary
 *   node bin/lint-plan.mjs --gate stage:<id>    enforce a stage transition
 *   node bin/lint-plan.mjs --json               structured output for a machine reader
 */

import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync, existsSync } from "node:fs";
import { resolveContentRoot } from "../lib/content-root.mjs";
import { loadSchemaSet } from "../lib/schema-resolver.mjs";
import { createValidators } from "../lib/validate.mjs";
import { lintProject, evaluateStageGate, evaluateHandoffGate, blocks, SEVERITY } from "../lib/lint.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const asJson = args.includes("--json");
const gateArg = (args.find((a) => a.startsWith("--gate")) ?? "").split("=")[1] ?? args[args.indexOf("--gate") + 1];

const ICON = { [SEVERITY.ERROR]: "✖", [SEVERITY.WARNING]: "▲", [SEVERITY.ADVISORY]: "·" };

function activatedTypes(contentRoot) {
  // #39: activation is a stage-2 decision recorded in project.yaml, never inferred here.
  const manifest = join(contentRoot, "project.yaml");
  if (!existsSync(manifest)) return [];
  const m = /artifactTypes:\s*[\s\S]*?activated:\s*\[([^\]]*)\]/.exec(readFileSync(manifest, "utf-8"));
  if (!m) return [];
  return m[1].split(",").map((s) => s.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
}

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
  activated: activatedTypes(contentRoot),
};

let result;
if (gateArg === "handoff") result = { kind: "handoff", ...evaluateHandoffGate(ctx) };
else if (gateArg?.startsWith("stage:")) result = { kind: "stage", ...evaluateStageGate(ctx, gateArg.slice(6)) };
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
  if (result.unmechanisedCriteria?.length)
    console.log(`  ${result.unmechanisedCriteria.length} criterion/criteria need a human decision: ${result.unmechanisedCriteria.join(", ")}`);
}

// Exit policy: only a gate blocks, and only the gate decides (#46, #47).
if (result.kind === "report") process.exit(0);
process.exit(result.ready ? 0 : 1);
