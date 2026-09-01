#!/usr/bin/env node
/**
 * `npm run handoff` — produce the frozen handoff package (DEC-0009, CMP-0011).
 *
 * ⚠️ **Explicit and deterministic, never a gate side effect.** The gate answers *"may we publish"* and
 * writes nothing; this command publishes. Keeping them apart is what lets the gate be run to ASK a
 * question — a gate that generated as a side effect could not be.
 *
 * ⚠️ **A clean lint is not readiness**, and the gate is what enforces the difference. This header
 * used to say "**It refuses this project today**... stage 5's `requirements-traced-to-components` is
 * attested `not-satisfied`, because REQ-0010 traces only to a component nothing has built." That was
 * true when it was written and stopped being true on 2026-08-29, when the application-shell cycle
 * closed: every stage gate is now attested and the package publishes — 261 artifacts, snapshot
 * 5f53af492e35bf24. The refusal was never a limitation to be removed; it was satisfied by building
 * the component, which is the only way it was ever meant to clear.
 */

import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

import { resolveContentRoot } from "../lib/content-root.mjs";
import { loadSchemaSet } from "../lib/schema-resolver.mjs";
import { createValidators } from "../lib/validate.mjs";
import { readActivatedTypes } from "../lib/activation.mjs";
import { publishHandoff, HandoffRefused } from "../lib/handoff/publish.mjs";
import { summariseBlockers } from "../lib/handoff/completeness.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const toolVersion = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf-8")).version ?? "0.0.0";

/**
 * ⚠️ **THE PACKAGE IS PUBLISHED BESIDE THE CONTENT, NOT INSIDE THE TOOL.** This used to be
 * `join(ROOT, "docs", "plan")` — the TOOL's own `docs/plan/`. In this repository the two are the same
 * directory, which is why it went unnoticed; in a consumer install it wrote the project's handoff
 * package into `.planning/docs/plan/`, a gitignored clone that `git pull` is entitled to overwrite.
 * The one derivation that is right in both layouts is the content root's parent:
 *
 *     Kiln repository:  <repo>/planning-content        ->  <repo>/docs/plan
 *     Consumer project: <project>/planning-content     ->  <project>/docs/plan
 *
 * It is derived rather than configured because the handoff package is a VIEW of the content, and a
 * view that can be pointed somewhere else is a view that eventually is.
 */
const outDirFor = (root) => join(dirname(root), "docs", "plan");

let contentRoot;
try {
  contentRoot = resolveContentRoot();
} catch (e) {
  console.error(e.message);
  console.error(
    "\nIf this is the Kiln repository itself, it is its own consumer and the sibling rule does not\n" +
      "apply to it — name its content directory explicitly:\n" +
      "  PowerShell   $env:PLANNING_CONTENT_DIR = (Resolve-Path .\\planning-content).Path\n" +
      '  sh           PLANNING_CONTENT_DIR="$PWD/planning-content"'
  );
  process.exitCode = 2;
}

if (contentRoot) {
  const ctx = {
    contentRoot,
    schemas: loadSchemaSet(join(ROOT, "schemas")),
    validators: createValidators(join(ROOT, "schemas")),
    activated: readActivatedTypes(contentRoot),
  };

  try {
    const result = await publishHandoff(ctx, { outDir: outDirFor(contentRoot), toolRoot: ROOT, toolVersion });
    console.log(`published   ${result.fileCount} file(s) to ${result.outDir}`);
    console.log(`snapshot    ${result.snapshot}`);
    console.log(`from        ${result.artifactCount} artifact(s)`);
    process.exitCode = 0;
  } catch (e) {
    if (!(e instanceof HandoffRefused)) throw e;
    console.error(`REFUSED     ${e.message}\n`);
    console.error(`target      ${outDirFor(contentRoot)} (unchanged)\n`);
    for (const group of summariseBlockers(e.blockers)) {
      console.error(`  ${group.reason}  (${group.count})`);
      for (const item of group.items.slice(0, 8)) console.error(`    - ${item.detail}`);
      if (group.items.length > 8) console.error(`    ... and ${group.items.length - 8} more`);
    }
    console.error(
      "\nNothing was written and the previous package is untouched. A stale package is wrong in a way\n" +
        "its own MANIFEST reveals; a half-replaced one is wrong in a way nothing reveals."
    );
    process.exitCode = 1;
  }
}
