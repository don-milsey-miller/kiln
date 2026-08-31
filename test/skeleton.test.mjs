import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { startServer, writeReviewStatus, makeContext } from "../app/server.mjs";
import { buildViewModel } from "../lib/view/assertion-view.mjs";
import { createAssertion, createEvidence, createRunbookStep, linkEvidence } from "../lib/tools/evidence-tools.mjs";
import { lintProject } from "../lib/lint.mjs";
import { artifactRelPath } from "../lib/layout.mjs";
import { createValidators } from "../lib/validate.mjs";
import { loadSchemaSet } from "../lib/schema-resolver.mjs";
import { LOCK_FILE } from "../lib/tools/create-artifact.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCHEMAS = join(ROOT, "schemas");
const schemas = loadSchemaSet(SCHEMAS);
const validators = createValidators(SCHEMAS);
const HERE = { os: "Windows 11", node: "v24.18.0" };

/** A content root holding one supported and one CONTESTED assertion, plus a blocked step. */
async function seeded() {
  const base = mkdtempSync(join(tmpdir(), "vpw-skel-"));
  const contentRoot = join(base, "planning-content");
  mkdirSync(contentRoot, { recursive: true });
  const o = { contentRoot, schemasDir: SCHEMAS, validators, schemas };

  const good = await createAssertion(
    { title: "Sound", statement: "This one holds.", targetEnvironment: { facts: HERE } }, o);
  const goodEv = await createEvidence(
    { title: "It worked", kind: "experiment", summary: "Ran it.", environment: { execution: "host", facts: HERE }, observedAt: "2026-08-18", outcome: "success" }, o);
  await linkEvidence(good.id, goodEv.id, "support", o);

  const contested = await createAssertion(
    { title: "Disputed", statement: "This one is disputed.", targetEnvironment: { facts: HERE } }, o);
  const forIt = await createEvidence(
    { title: "For", kind: "experiment", summary: "Worked.", environment: { execution: "host", facts: HERE }, observedAt: "2026-08-18", outcome: "success" }, o);
  const against = await createEvidence(
    { title: "Against", kind: "experiment", summary: "Failed.", environment: { execution: "host", facts: HERE }, observedAt: "2026-08-18", outcome: "failure" }, o);
  const stale = await createEvidence(
    { title: "Stale", kind: "experiment", summary: "Old run.", environment: { execution: "host", facts: { os: "Ubuntu 24" } }, observedAt: "2026-01-01", outcome: "failure" }, o);
  await linkEvidence(contested.id, forIt.id, "support", o);
  await linkEvidence(contested.id, against.id, "refute", o);
  await linkEvidence(contested.id, stale.id, "refute", o);

  const step = await createRunbookStep(
    { title: "Blocked", instruction: "Do it", expectedOutcome: "Done", restsOn: [contested.id] }, o);

  const ctx = { ...makeContext(contentRoot), activated: ["assertion", "evidence", "runbook-step", "requirement"] };
  return { base, contentRoot, ctx, ids: { good: good.id, contested: contested.id, step: step.id, stale: stale.id } };
}

const get = async (url) => (await fetch(url)).text();

/* -------------------------------------------------- 2, 3: derived at render time */

test("5b/2,3: verdict and confidence derive at render time, with excluded evidence and reasons shown", async () => {
  const { base, ctx, ids } = await seeded();
  try {
    const model = buildViewModel(ctx);
    const contested = model.assertions.find((a) => a.assertion.id === ids.contested);

    assert.equal(contested.verdict, "contested");
    assert.equal(contested.confidence, "environment-matched", "contested at the top rung is the case that matters");
    assert.equal(contested.supporting.length, 1);
    assert.equal(contested.refuting.length, 1, "the stale one must not count as applicable refutation");
    assert.equal(contested.excludedEvidence.length, 1);
    assert.equal(contested.excludedEvidence[0].ref, ids.stale);
    assert.equal(contested.excludedEvidence[0].excludedBecause, "environment-mismatch");
    assert.equal(contested.promotion.allowed, false);

    const good = model.assertions.find((a) => a.assertion.id === ids.good);
    assert.equal(good.verdict, "supported");
    assert.equal(good.promotion.allowed, true);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------ 4: nothing derived persists */

test("5b/4: rendering persists no derived value", async () => {
  const { base, contentRoot, ctx } = await seeded();
  try {
    const dir = join(contentRoot, "data", "assertions");
    const before = readdirSync(dir).map((f) => readFileSync(join(dir, f), "utf-8"));

    const { url, close } = await startServer({ contentRoot, port: 0 });
    const html = await get(url);
    await close();

    const after = readdirSync(dir).map((f) => readFileSync(join(dir, f), "utf-8"));
    assert.deepEqual(after, before, "rendering must not rewrite an artifact");
    for (const text of after) {
      const doc = JSON.parse(text);
      assert.ok(!("confidence" in doc), "a derived rung was persisted");
      assert.ok(!("verdict" in doc), "a derived verdict was persisted");
    }
    assert.match(html, /derived at render time/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------ 7: lint findings, not UI rules */

test("5b/7: the view surfaces lint findings verbatim and invents none", async () => {
  const { base, ctx, ids } = await seeded();
  try {
    const model = buildViewModel(ctx);
    const lintFindings = lintProject(ctx).findings;

    const step = model.steps.find((s) => s.step.id === ids.step);
    assert.equal(step.findings.length, 1);
    assert.equal(step.findings[0].ruleId, "instruction/rests-on-contested");

    // Two properties, and they need different comparisons.
    // (a) Within one build, every finding shown is one of the model's own lint findings —
    //     identity, so a view that constructed a lookalike would fail.
    const shown = [...model.assertions.flatMap((a) => a.findings), ...model.steps.flatMap((s) => s.findings)];
    for (const f of shown) assert.ok(model.findings.includes(f), `view invented a finding: ${f.ruleId}`);

    // (b) The model's findings ARE the lint's, compared by value across a separate run.
    assert.deepEqual(model.findings, lintFindings, "the view is not reporting what the lint reports");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

/* ------------------------------------------- 6: status write-back through lock + atomic */

test("5b/6: the status write-back goes through the lock and atomic write, and touches reviewStatus only", async () => {
  const { base, contentRoot, ctx, ids } = await seeded();
  try {
    const path = join(contentRoot, artifactRelPath("assertion", ids.good));
    const before = JSON.parse(readFileSync(path, "utf-8"));

    const updated = await writeReviewStatus(ctx, ids.good, "assertion", "approved");
    assert.equal(updated.reviewStatus, "approved");

    const after = JSON.parse(readFileSync(path, "utf-8"));
    assert.equal(after.reviewStatus, "approved");
    assert.equal(after.lifecycle, before.lifecycle, "#82's split: the app must not be able to retire an artifact here");
    assert.deepEqual({ ...after, reviewStatus: null }, { ...before, reviewStatus: null }, "nothing else changed");

    assert.ok(!existsSync(join(contentRoot, LOCK_FILE)), "lock released");
    assert.ok(!readdirSync(dirname(path)).some((f) => f.includes("vpw-tmp")), "no temp file left behind");

    await assert.rejects(() => writeReviewStatus(ctx, ids.good, "assertion", "retired"), /reviewStatus must be one of/);
    // The message now names the TYPE ("No such assertion"), because the implementation moved to
    // lib/tools/review-status.mjs (#145) and every typed operation there says which type it looked for.
    await assert.rejects(() => writeReviewStatus(ctx, "AST-9999", "assertion", "approved"), /No such assertion/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

/* --------------------------------------------------------- 5: the watcher refreshes */

test("5b/5: a change to an assertion OR its evidence notifies the page", async () => {
  const { base, contentRoot, ctx, ids } = await seeded();
  const started = await startServer({ contentRoot, port: 0 });
  try {
    for (const [what, act] of [
      ["the assertion", () => writeReviewStatus(ctx, ids.good, "assertion", "in-review")],
      ["its evidence", () => writeReviewStatus(ctx, ids.stale, "evidence", "amended")],
    ]) {
      const controller = new AbortController();
      const res = await fetch(`${started.url}events`, { signal: controller.signal });
      const reader = res.body.getReader();

      const heard = new Promise((resolve) => {
        const pump = () =>
          reader.read().then(({ value, done }) => {
            if (done) return resolve(false);
            if (new TextDecoder().decode(value).includes("data: changed")) return resolve(true);
            pump();
          }, () => resolve(false));
        pump();
      });

      await act();

      const got = await Promise.race([heard, new Promise((r) => setTimeout(() => r("timeout"), 8000))]);
      controller.abort();
      assert.equal(got, true, `no refresh after changing ${what}`);
    }
  } finally {
    await started.close();
    rmSync(base, { recursive: true, force: true });
  }
});

/* -------------------------------------------------------------- end to end through HTTP */

test("5b: the rendered page shows the contested case rather than only the happy path", async () => {
  const { base, contentRoot, ids } = await seeded();
  const started = await startServer({ contentRoot, port: 0 });
  try {
    const html = await get(started.url);
    assert.match(html, /CONTESTED/);
    assert.match(html, /Blocked from becoming an instruction/);
    assert.match(html, /Excluded from the derivation/);
    assert.match(html, /excluded: environment-mismatch/);
    assert.match(html, /instruction\/rests-on-contested/);
    assert.ok(html.includes(ids.contested) && html.includes(ids.stale));
  } finally {
    await started.close();
    rmSync(base, { recursive: true, force: true });
  }
});
