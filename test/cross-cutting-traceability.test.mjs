import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { readActivatedTypes } from "../lib/activation.mjs";
import { effectiveAssertion } from "../lib/effective-assertion.mjs";
import { artifactRelPath } from "../lib/layout.mjs";
import { lintProject } from "../lib/lint.mjs";
import { loadSchemaSet } from "../lib/schema-resolver.mjs";
import { loadStageDefinitions, producedBy, stageAnnotationDisagreements } from "../lib/stages.mjs";
import { setTypeActivation } from "../lib/tools/activate-type.mjs";
import { createAssertion, createEvidence, createRunbookStep, linkEvidence } from "../lib/tools/evidence-tools.mjs";
import { createValidators } from "../lib/validate.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCHEMAS = join(ROOT, "schemas");
const schemas = loadSchemaSet(SCHEMAS);
const validators = createValidators(SCHEMAS);

test("#29 a fresh project can carry one typed Stage 3 → Stage 6 → Stage 9 evidence trail", async () => {
  const base = mkdtempSync(join(tmpdir(), "kiln-cross-cutting-"));
  const contentRoot = join(base, "planning-content");
  mkdirSync(contentRoot, { recursive: true });
  writeFileSync(join(contentRoot, "project.yaml"), "name: fixture\ncapabilities:\n  artifactTypes:\n    activated: []\n");
  const toolOpts = { contentRoot, schemasDir: SCHEMAS, schemas, validators };

  try {
    for (const type of ["assertion", "evidence", "runbook-step"])
      await setTypeActivation(type, "activate", { ...toolOpts, toolRoot: ROOT, approvedBy: "pm" });

    const defs = loadStageDefinitions(ROOT);
    for (const stageId of ["03-discovery", "06-risk-feasibility"])
      assert.deepEqual(producedBy(defs, stageId).filter((type) => type === "assertion" || type === "evidence"), ["assertion", "evidence"]);
    assert.deepEqual(stageAnnotationDisagreements(schemas, defs), []);

    const assertion = await createAssertion(
      {
        title: "Target supports the operation",
        statement: "The target supports the planned operation.",
        targetEnvironment: { facts: { os: "Windows 11" } },
      },
      toolOpts
    );
    const evidence = await createEvidence(
      {
        title: "Validated on target",
        kind: "experiment",
        summary: "The operation completed successfully.",
        environment: { execution: "host", facts: { os: "Windows 11" } },
        observedAt: "2026-09-29",
        outcome: "success",
      },
      toolOpts
    );
    await linkEvidence(assertion.id, evidence.id, "support", toolOpts);
    const step = await createRunbookStep(
      {
        title: "Perform operation",
        instruction: "Run the validated operation.",
        expectedOutcome: "The operation completes.",
        restsOn: [assertion.id],
      },
      toolOpts
    );

    const assertionDoc = JSON.parse(readFileSync(join(contentRoot, artifactRelPath("assertion", assertion.id)), "utf8"));
    const evidenceDoc = JSON.parse(readFileSync(join(contentRoot, artifactRelPath("evidence", evidence.id)), "utf8"));
    const view = effectiveAssertion(assertionDoc, new Map([[evidence.id, evidenceDoc]]));
    assert.equal(view.verdict, "supported");
    assert.equal(view.confidence, "environment-matched");

    const ctx = { contentRoot, schemas, validators, activated: readActivatedTypes(contentRoot), stageDefinitions: null };
    const blocking = lintProject(ctx).findings.filter((finding) => finding.artifactId === step.id && finding.ruleId.startsWith("instruction/"));
    assert.deepEqual(blocking, [], JSON.stringify(blocking));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
