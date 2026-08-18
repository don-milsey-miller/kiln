import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { createAssertion, createEvidence, createRunbookStep, linkEvidence } from "../lib/tools/evidence-tools.mjs";
import { ValidationError, createValidators } from "../lib/validate.mjs";
import { loadSchemaSet } from "../lib/schema-resolver.mjs";
import { lintProject, SEVERITY } from "../lib/lint.mjs";
import { artifactRelPath, artifactDir } from "../lib/layout.mjs";
import { readHighWaterMarks } from "../lib/id-allocator.mjs";
import { LOCK_FILE } from "../lib/tools/create-artifact.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCHEMAS = join(ROOT, "schemas");
const schemas = loadSchemaSet(SCHEMAS);
const validators = createValidators(SCHEMAS);
const ACTIVATED = ["requirement", "decision", "assertion", "evidence", "research-finding", "question", "runbook", "runbook-step"];

function fresh() {
  const base = mkdtempSync(join(tmpdir(), "vpw-ev-"));
  const contentRoot = join(base, "planning-content");
  mkdirSync(contentRoot, { recursive: true });
  return { base, contentRoot, o: { contentRoot, schemasDir: SCHEMAS, validators, schemas } };
}
const ctxOf = (contentRoot) => ({ contentRoot, schemas, validators, activated: ACTIVATED, stageDefinitions: null });

const TARGET = { facts: { os: "RHEL 10", postgres: "17" } };
const AST_IN = { title: "Replication works", statement: "PG 17 logical replication satisfies REQ-0012.", targetEnvironment: TARGET };
const EXPERIMENT = (facts, outcome = "success") => ({
  title: "Ran it", kind: "experiment", summary: "Executed the procedure.",
  environment: { tier: 2, facts }, observedAt: "2026-08-18", outcome,
});

/* ------------------------------------------------- #96 enforced at the input boundary */

test("#96: the assertion tool refuses a caller-supplied confidence or verdict", async () => {
  const { base, contentRoot, o } = fresh();
  try {
    await assert.rejects(() => createAssertion({ ...AST_IN, confidence: "environment-matched" }, o), ValidationError);
    await assert.rejects(() => createAssertion({ ...AST_IN, verdict: "supported" }, o), ValidationError);
    assert.equal(readHighWaterMarks(contentRoot).AST ?? 0, 0, "a refused input must not consume an ID");

    const { artifact } = await createAssertion(AST_IN, o);
    assert.ok(!("confidence" in artifact) && !("verdict" in artifact));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("#96: the assertion tool refuses caller-supplied polarity — that arrives by linking", async () => {
  const { base, o } = fresh();
  try {
    await assert.rejects(() => createAssertion({ ...AST_IN, supportedBy: ["EVD-0001"] }, o), ValidationError);
    await assert.rejects(() => createAssertion({ ...AST_IN, refutedBy: ["EVD-0001"] }, o), ValidationError);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("evidence records what was observed and never which way it bears", async () => {
  const { base, o } = fresh();
  try {
    const { artifact } = await createEvidence(EXPERIMENT({ os: "RHEL 10" }, "failure"), o);
    assert.equal(artifact.outcome, "failure");
    for (const forbidden of ["polarity", "supports", "refutes", "verdict", "confidence"])
      await assert.rejects(() => createEvidence({ ...EXPERIMENT({ os: "RHEL 10" }), [forbidden]: "x" }, o), ValidationError);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------- linking is a separate operation */

test("linking is a separate operation, and an unattached record is a normal intermediate state", async () => {
  const { base, contentRoot, o } = fresh();
  try {
    const ast = await createAssertion(AST_IN, o);
    const ev = await createEvidence(EXPERIMENT({ os: "RHEL 10", postgres: "17" }), o);

    // After creation and before linking the evidence exists, unattached. Detectable and
    // repairable — which is the whole argument for not faking a two-file transaction.
    const before = JSON.parse(readFileSync(join(contentRoot, artifactRelPath("assertion", ast.id)), "utf-8"));
    assert.deepEqual(before.supportedBy ?? [], []);
    assert.ok(existsSync(join(contentRoot, artifactRelPath("evidence", ev.id))));

    const r = await linkEvidence(ast.id, ev.id, "support", o);
    assert.equal(r.changed, true);
    const after = JSON.parse(readFileSync(join(contentRoot, artifactRelPath("assertion", ast.id)), "utf-8"));
    assert.deepEqual(after.supportedBy, [ev.id]);
    assert.ok(validators.assertion(after), "the updated assertion must still validate");
    assert.ok(!existsSync(join(contentRoot, LOCK_FILE)), "lock released");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("linking is idempotent, refuses unknown targets, and refuses contradictory polarity", async () => {
  const { base, o } = fresh();
  try {
    const ast = await createAssertion(AST_IN, o);
    const ev = await createEvidence(EXPERIMENT({ os: "RHEL 10" }), o);

    await linkEvidence(ast.id, ev.id, "support", o);
    assert.equal((await linkEvidence(ast.id, ev.id, "support", o)).changed, false, "second link is a no-op");

    // One record cannot both support and refute the same claim. That is not `contested`,
    // it is a mistake, and contested must mean two records disagreeing.
    await assert.rejects(() => linkEvidence(ast.id, ev.id, "refute", o), ValidationError);

    await assert.rejects(() => linkEvidence("AST-9999", ev.id, "support", o), ValidationError);
    await assert.rejects(() => linkEvidence(ast.id, "EVD-9999", "support", o), ValidationError);
    await assert.rejects(() => linkEvidence(ast.id, ev.id, "maybe", o), ValidationError);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------- runbook step creation */

test("REQ-0009: a runbook step cannot be created without restsOn", async () => {
  const { base, contentRoot, o } = fresh();
  try {
    const step = { title: "Enable replication", instruction: "Run the thing", expectedOutcome: "It is enabled" };
    await assert.rejects(() => createRunbookStep(step, o), ValidationError);
    await assert.rejects(() => createRunbookStep({ ...step, restsOn: [] }, o), ValidationError);
    assert.equal(readHighWaterMarks(contentRoot).RBS ?? 0, 0, "no ID consumed");

    const ast = await createAssertion(AST_IN, o);
    const ok = await createRunbookStep({ ...step, restsOn: [ast.id] }, o);
    assert.equal(ok.artifact.restsOn.length, 1);

    // #58: destructive still needs remediation, enforced by the schema at boundary 2.
    await assert.rejects(
      () => createRunbookStep({ ...step, restsOn: [ast.id], destructive: true }, o),
      /remediation|Invalid|assembled/
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

/* ------------------- the rule the whole loop exists for: no maximum across premises */

test("REQ-0009 in the lint: one refuted premise blocks, however strong the others are", async () => {
  const { base, contentRoot, o } = fresh();
  try {
    const good = await createAssertion({ ...AST_IN, title: "Sound premise" }, o);
    const bad = await createAssertion({ ...AST_IN, title: "False premise" }, o);

    // The sound one is matched-experiment supported: the strongest state available.
    const supporting = await createEvidence(EXPERIMENT({ os: "RHEL 10", postgres: "17" }), o);
    await linkEvidence(good.id, supporting.id, "support", o);

    // The false one is refuted by an equally applicable experiment.
    const refuting = await createEvidence(EXPERIMENT({ os: "RHEL 10", postgres: "17" }, "failure"), o);
    await linkEvidence(bad.id, refuting.id, "refute", o);

    const step = await createRunbookStep(
      { title: "Step", instruction: "Do it", expectedOutcome: "Done", restsOn: [good.id, bad.id] },
      o
    );

    const findings = lintProject(ctxOf(contentRoot)).findings.filter((f) => f.artifactId === step.id);
    const blocked = findings.find((f) => f.ruleId === "instruction/rests-on-refuted");
    assert.ok(blocked, JSON.stringify(findings, null, 2));
    assert.equal(blocked.severity, SEVERITY.ERROR);
    assert.equal(blocked.details.assertion, bad.id, "the FALSE premise is what is named");
    assert.equal(blocked.details.verdict, "refuted");
    // ⚠️ The inversion this prevents: a step looking safe because its BEST premise is solid.
    assert.ok(
      findings.every((f) => f.details.assertion !== good.id),
      "the sound premise should not itself be a finding — but it must not rescue the other either"
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("REQ-0009 in the lint: contested and unresolved premises block for distinguishable reasons", async () => {
  const { base, contentRoot, o } = fresh();
  try {
    const contested = await createAssertion({ ...AST_IN, title: "Contested" }, o);
    const forIt = await createEvidence(EXPERIMENT({ os: "RHEL 10", postgres: "17" }), o);
    const against = await createEvidence(EXPERIMENT({ os: "RHEL 10", postgres: "17" }, "failure"), o);
    await linkEvidence(contested.id, forIt.id, "support", o);
    await linkEvidence(contested.id, against.id, "refute", o);

    const bare = await createAssertion({ ...AST_IN, title: "Nothing bears on it" }, o);

    const s1 = await createRunbookStep({ title: "A", instruction: "x", expectedOutcome: "y", restsOn: [contested.id] }, o);
    const s2 = await createRunbookStep({ title: "B", instruction: "x", expectedOutcome: "y", restsOn: [bare.id] }, o);

    const all = lintProject(ctxOf(contentRoot)).findings;
    const r1 = all.find((f) => f.artifactId === s1.id && f.ruleId.startsWith("instruction/"));
    const r2 = all.find((f) => f.artifactId === s2.id && f.ruleId.startsWith("instruction/"));

    assert.equal(r1.ruleId, "instruction/rests-on-contested");
    assert.equal(r1.details.confidence, "environment-matched", "contested at the TOP rung is the dangerous case");
    assert.equal(r2.ruleId, "instruction/rests-on-unresolved");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("#57: a destructive step demands a higher rung than an ordinary one", async () => {
  const { base, contentRoot, o } = fresh();
  try {
    const ast = await createAssertion(AST_IN, o);
    // An experiment silent on `postgres` reaches experimentally-validated, not rung 4.
    const partial = await createEvidence(EXPERIMENT({ os: "RHEL 10" }), o);
    await linkEvidence(ast.id, partial.id, "support", o);

    const ordinary = await createRunbookStep({ title: "A", instruction: "x", expectedOutcome: "y", restsOn: [ast.id] }, o);
    const destructive = await createRunbookStep(
      { title: "B", instruction: "drop it", expectedOutcome: "gone", restsOn: [ast.id], destructive: true, remediation: "restore" },
      o
    );

    const all = lintProject(ctxOf(contentRoot)).findings.filter((f) => f.ruleId.startsWith("instruction/"));
    assert.equal(all.filter((f) => f.artifactId === ordinary.id).length, 0, "experimentally-validated is enough here");
    const d = all.find((f) => f.artifactId === destructive.id);
    assert.ok(d, "a destructive step must require environment-matched");
    assert.equal(d.ruleId, "instruction/rests-on-below-threshold");
    assert.equal(d.details.requiredConfidence, "environment-matched");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("a fully evidenced step lints clean end to end", async () => {
  const { base, contentRoot, o } = fresh();
  try {
    const ast = await createAssertion(AST_IN, o);
    const ev = await createEvidence(EXPERIMENT({ os: "RHEL 10", postgres: "17" }), o);
    await linkEvidence(ast.id, ev.id, "support", o);
    await createRunbookStep({ title: "Step", instruction: "Do it", expectedOutcome: "Done", restsOn: [ast.id] }, o);

    const findings = lintProject(ctxOf(contentRoot)).findings;
    assert.deepEqual(findings, [], JSON.stringify(findings, null, 2));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("#94: the capability check reads the tool registry, not filenames", async () => {
  const { implementedTypes, TYPED_TOOLS } = await import("../lib/tools/registry.mjs");
  // runbook-step's tool lives in evidence-tools.mjs, not create-runbook-step.mjs. Inferring
  // capability from a file name reported a gap for a type that had a working tool — silently,
  // and only visibly at all because the gate output was read.
  assert.ok(implementedTypes().includes("runbook-step"));
  assert.ok(implementedTypes().includes("assertion") && implementedTypes().includes("evidence"));
  for (const [type, fn] of Object.entries(TYPED_TOOLS))
    assert.equal(typeof fn, "function", `${type} registry entry is not callable`);
  assert.ok(!implementedTypes().includes("runbook"), "runbook has no tool yet and must still report the gap");
});

test("#101: a link is a judgement, so it must be correctable through the typed path", async () => {
  const { unlinkEvidence } = await import("../lib/tools/evidence-tools.mjs");
  const { base, contentRoot, o } = fresh();
  try {
    const ast = await createAssertion(AST_IN, o);
    const ev = await createEvidence(EXPERIMENT({ os: "RHEL 10", postgres: "17" }, "failure"), o);

    // A failing run linked as refuting — the mistake #101 records. `outcome: failure` is an
    // observation; whether it BEARS against the claim is a judgement no schema can check.
    await linkEvidence(ast.id, ev.id, "refute", o);
    let doc = JSON.parse(readFileSync(join(contentRoot, artifactRelPath("assertion", ast.id)), "utf-8"));
    assert.deepEqual(doc.refutedBy, [ev.id]);

    const undone = await unlinkEvidence(ast.id, ev.id, "refute", o);
    assert.equal(undone.changed, true);
    doc = JSON.parse(readFileSync(join(contentRoot, artifactRelPath("assertion", ast.id)), "utf-8"));
    assert.deepEqual(doc.refutedBy, []);
    assert.ok(validators.assertion(doc));

    assert.equal((await unlinkEvidence(ast.id, ev.id, "refute", o)).changed, false, "unlinking twice is a no-op");
    assert.ok(!existsSync(join(contentRoot, LOCK_FILE)), "lock released");

    // Correcting a polarity is now: unlink, then link the other way, which the dual-link
    // guard demands rather than forbids.
    await linkEvidence(ast.id, ev.id, "support", o);
    doc = JSON.parse(readFileSync(join(contentRoot, artifactRelPath("assertion", ast.id)), "utf-8"));
    assert.deepEqual(doc.supportedBy, [ev.id]);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
