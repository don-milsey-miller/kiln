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
 *   node bin/lint-plan.mjs --json --include-records   the same, with every parsed artifact record
 *
 * ⚠️ **`--json` IS SIZED BY THE FINDINGS, NOT BY THE PLAN (#187).** It carries a summary, the findings and the
 * gate result. It used to carry every parsed record as well, so a 216-artifact project with eight findings printed
 * 7,836 lines and the reader's terminal truncated the part that mattered. The records are still one flag away for
 * the reader who is debugging the lint itself, and `lintProject()` returns them to every other caller as before:
 * only this file's serialisation changed.
 *
 * A finding is printed whole. Its `artifactId`, `path`, message and details are what a repair needs.
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
const includeRecords = args.includes("--include-records");
if (includeRecords && !asJson) {
  console.error("--include-records adds the parsed artifact records to --json output and has no effect without it.\nUsage: lint-plan [--gate handoff | --gate stage:<id>] [--json [--include-records]]");
  process.exit(2);
}
const gateArg = (args.find((a) => a.startsWith("--gate")) ?? "").split("=")[1] ?? args[args.indexOf("--gate") + 1];

const ICON = { [SEVERITY.ERROR]: "✖", [SEVERITY.WARNING]: "▲", [SEVERITY.ADVISORY]: "·" };

/**
 * What `--json` says about the size of the plan and of the result, in place of the records themselves.
 *
 * ⚠️ EVERY FINDING IS COUNTED ONCE. A gate result presents the lint's findings more than once: a stage gate has
 * `allFindings` and the blocking subset of it, a handoff gate has them split by severity. So the count is taken from
 * the lint's own list plus the gate's own findings, never from the views.
 */
function summarise(lint, gateFindings = []) {
  const byType = {};
  for (const record of lint.records) {
    const type = typeof record.doc?.type === "string" && record.doc.type ? record.doc.type : "unknown";
    byType[type] = (byType[type] ?? 0) + 1;
  }
  const all = [...lint.findings, ...gateFindings];
  const count = (severity) => all.filter((f) => f.severity === severity).length;
  return {
    artifacts: { total: lint.records.length, byType: Object.fromEntries(Object.entries(byType).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) },
    findings: { total: all.length, error: count(SEVERITY.ERROR), warning: count(SEVERITY.WARNING), advisory: count(SEVERITY.ADVISORY) },
  };
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
  activated: readActivatedTypes(contentRoot),
};

// One lint pass, whichever mode: a gate is given this result rather than running its own.
const lint = lintProject(ctx);

let result;
if (gateArg === "handoff") result = { kind: "handoff", ...evaluateHandoffGate(ctx, { lint }) };
else if (gateArg?.startsWith("stage:")) {
  const stageId = gateArg.slice(6);
  try {
    result = { kind: "stage", ...evaluateStageGate(ctx, stageId, { lint, attestations: loadStageAttestations(contentRoot, stageId) }) };
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
else result = { kind: "report", ...lint };

if (asJson) {
  const { kind, records: _records, ...rest } = result;
  console.log(JSON.stringify({ kind, summary: summarise(lint, result.gateFindings), ...rest, ...(includeRecords ? { records: lint.records } : {}) }, null, 2));
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
//
// ⚠️ THE CODE IS SET AND THE PROCESS IS LEFT TO END, NOT EXITED (#187). `process.exit()` does not wait for stdout,
// and on Linux a pipe takes writes asynchronously: measured in CI, a 241,013-byte `--json --include-records` report
// reached its reader cut off at byte 146,176 and did not parse. Nothing here holds the process open, so it ends as
// soon as the output has drained.
process.exitCode = result.kind === "report" || result.ready ? 0 : 1;
