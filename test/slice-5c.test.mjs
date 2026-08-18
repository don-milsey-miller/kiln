import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { createRequirement } from "../lib/tools/create-requirement.mjs";
import { createAssertion, createEvidence, createRunbookStep, linkEvidence } from "../lib/tools/evidence-tools.mjs";
import { lintProject } from "../lib/lint.mjs";
import { buildViewModel } from "../lib/view/assertion-view.mjs";
import { startServer, makeContext } from "../app/server.mjs";
import { createValidators } from "../lib/validate.mjs";
import { loadSchemaSet } from "../lib/schema-resolver.mjs";
import { DATA_DIR } from "../lib/layout.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCHEMAS = join(ROOT, "schemas");
const schemas = loadSchemaSet(SCHEMAS);
const validators = createValidators(SCHEMAS);
const TARGET = { os: "RHEL 10", postgres: "17" };

/** Every artifact on disk, so the "nothing derived persists" check covers the whole tree. */
function allArtifacts(contentRoot) {
  const out = [];
  const root = join(contentRoot, DATA_DIR);
  for (const dir of readdirSync(root))
    for (const f of readdirSync(join(root, dir)))
      out.push({ path: `${dir}/${f}`, doc: JSON.parse(readFileSync(join(root, dir, f), "utf-8")) });
  return out;
}

const stepFindings = (ctx, id) =>
  lintProject(ctx).findings.filter((f) => f.artifactId === id && f.ruleId.startsWith("instruction/"));

test("5c: the evidence slice end to end, with the negative control first", async (t) => {
  const base = mkdtempSync(join(tmpdir(), "vpw-5c-"));
  const contentRoot = join(base, "planning-content");
  mkdirSync(contentRoot, { recursive: true });
  const o = { contentRoot, schemasDir: SCHEMAS, validators, schemas };
  const ctx = { ...makeContext(contentRoot), activated: ["requirement", "assertion", "evidence", "runbook-step"] };

  try {
    /* -- 1. requirement and assertion ---------------------------------------------------- */
    const req = await createRequirement(
      {
        title: "Replicate between environments",
        statement: "The system must replicate the customer table from staging to production nightly.",
        priority: "must",
      },
      o
    );

    const ast = await createAssertion(
      {
        title: "Logical replication satisfies the requirement",
        statement: "PostgreSQL 17 logical replication replicates the customer table on RHEL 10 as required.",
        targetEnvironment: { facts: TARGET },
        arisesFrom: [req.id],
      },
      o
    );

    /* -- 2. NEGATIVE CONTROL: the step exists while its premise is unverified ------------- */
    // ⚠️ This is the half that proves REQ-0009. Without it the slice shows that a
    // well-supported claim passes, and says nothing about unsupported claims being stopped.
    const step = await createRunbookStep(
      {
        title: "Enable logical replication",
        instruction: "Set wal_level=logical and create the publication.",
        expectedOutcome: "The subscriber receives changes to the customer table.",
        restsOn: [ast.id],
        destructive: true, // a mutating step: #58's floor, and the higher rung under #99
        remediation: "Drop the publication and restore wal_level.",
      },
      o
    );

    let blocked = stepFindings(ctx, step.id);
    assert.equal(blocked.length, 1, "an unverified premise must block");
    assert.equal(blocked[0].ruleId, "instruction/rests-on-unresolved");
    assert.equal(blocked[0].details.verdict, "unresolved");
    assert.equal(blocked[0].details.confidence, "unverified");

    /* -- 3. research: source support. Still below a mutating step's threshold ------------- */
    // `research-finding` is activated but not implemented, so the research phase is
    // represented by its output: a `source` evidence record carrying the citation.
    const source = await createEvidence(
      {
        title: "PostgreSQL 17 documentation",
        kind: "source",
        summary: "The manual states logical replication supports row-level replication of a single table.",
        sources: [{ title: "PostgreSQL 17 docs, logical replication", locator: "https://example.invalid/pg17/logical-replication", retrievedAt: "2026-08-18" }],
      },
      o
    );
    await linkEvidence(ast.id, source.id, "support", o);

    blocked = stepFindings(ctx, step.id);
    assert.equal(blocked.length, 1, "documentation is not a demonstration");
    assert.equal(blocked[0].ruleId, "instruction/rests-on-below-threshold");
    assert.equal(blocked[0].details.verdict, "supported", "the verdict moved");
    assert.equal(blocked[0].details.confidence, "source-supported", "but only to rung 2");
    assert.equal(blocked[0].details.requiredConfidence, "environment-matched", "a mutating step demands rung 4");

    /* -- 3b. an experiment in the WRONG environment still does not clear it --------------- */
    const wrongEnv = await createEvidence(
      {
        title: "Ran it on Ubuntu",
        kind: "experiment",
        summary: "Worked, but not on the target OS.",
        environment: { tier: 2, facts: { os: "Ubuntu 24", postgres: "17" } },
        observedAt: "2026-08-18",
        outcome: "success",
      },
      o
    );
    await linkEvidence(ast.id, wrongEnv.id, "support", o);

    blocked = stepFindings(ctx, step.id);
    assert.equal(blocked.length, 1, "a mismatched environment must not promote the claim");
    assert.equal(blocked[0].details.confidence, "source-supported", "the mismatched record is filtered out entirely");

    /* -- 4. validation: an applicable experiment clears the threshold --------------------- */
    const validated = await createEvidence(
      {
        title: "Validated on the target topology",
        kind: "experiment",
        summary: "Configured the publication and observed the subscriber receive changes.",
        environment: { tier: 2, facts: { ...TARGET, image: "rhel10-pg17" } },
        observedAt: "2026-08-18",
        outcome: "success",
      },
      o
    );
    await linkEvidence(ast.id, validated.id, "support", o);

    assert.deepEqual(stepFindings(ctx, step.id), [], "the step is now promotable");

    const model = buildViewModel(ctx);
    const view = model.assertions.find((a) => a.assertion.id === ast.id);
    assert.equal(view.verdict, "supported");
    assert.equal(view.confidence, "environment-matched");
    assert.equal(view.promotion.allowed, true);
    assert.equal(view.supporting.length, 2, "source + matched experiment");
    assert.equal(view.excludedEvidence.length, 1, "the Ubuntu run, excluded with its reason");
    assert.equal(view.excludedEvidence[0].excludedBecause, "environment-mismatch");

    /* -- 5. render the promotable step and its whole trail -------------------------------- */
    const started = await startServer({ contentRoot, port: 0 });
    try {
      const html = await (await fetch(started.url)).text();
      for (const id of [ast.id, source.id, wrongEnv.id, validated.id, step.id])
        assert.ok(html.includes(id), `${id} missing from the rendered trail`);
      assert.match(html, /environment-matched/);
      assert.match(html, /excluded: environment-mismatch/);
      assert.match(html, /May become an instruction/);
      assert.ok(!/instruction\/rests-on/.test(html), "no blocking finding should remain");
    } finally {
      await started.close();
    }

    /* -- the invariant that must hold across the whole sequence --------------------------- */
    for (const { path, doc } of allArtifacts(contentRoot)) {
      assert.ok(!("confidence" in doc), `${path} persisted a derived rung`);
      assert.ok(!("verdict" in doc), `${path} persisted a derived verdict`);
    }
    assert.deepEqual(lintProject(ctx).findings, [], "the finished slice lints clean");

    t.diagnostic(
      `${req.id} → ${ast.id} → [${source.id} source, ${wrongEnv.id} excluded, ${validated.id} experiment] → ${step.id}: blocked, blocked, blocked, promotable.`
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
