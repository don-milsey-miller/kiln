/**
 * #187 — `lint-plan --json` is sized by the findings, not by the plan.
 *
 * Every case runs the real CLI as a child process over a content root built here, and reads what it printed and how
 * it exited. Nothing imports the CLI's code: the serialisation is the thing under test, and it exists only there.
 *
 * ⚠️ **THE SENTINEL IS IN EVERY ARTIFACT'S BODY.** A requirement's `rationale` carries it, so a compact report that
 * leaked one record body would contain it, and a report with records must contain it once per artifact.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createValidators } from "../lib/validate.mjs";
import { createRequirement } from "../lib/tools/create-requirement.mjs";
import { writeStageAttestation } from "../lib/attestations.mjs";
import { loadStageDefinitions } from "../lib/stages.mjs";
import { removeTestTree } from "./helpers/cleanup.mjs";

const ROOT = join(import.meta.dirname, "..");
const SCHEMAS = join(ROOT, "schemas");
const CLI = join(ROOT, "bin", "lint-plan.mjs");
const SENTINEL = "KILN187-BODY-SENTINEL";
/** Produces `requirement`, the one type the fixture activates and holds. Its criteria are all attested by a person. */
const STAGE = "02-intent-decomposition";

const validators = createValidators(SCHEMAS);

/**
 * A content root holding `count` requirements that lint clean, each with `SENTINEL` and `bodyBytes` of filler in
 * its body. The first is written by the typed tool, so the shape is the product's and not this file's guess; the
 * rest are that record under the next ids.
 */
async function plan(t, count, { bodyBytes = 0 } = {}) {
  const base = mkdtempSync(join(tmpdir(), "kiln-lint-cli-"));
  t.after(() => removeTestTree(base, "#187 lint CLI fixture"));
  const contentRoot = join(base, "planning-content");
  mkdirSync(contentRoot, { recursive: true });
  writeFileSync(join(contentRoot, "project.yaml"), `name: lint-cli-fixture\nschemaVersion: ${JSON.parse(readFileSync(join(ROOT, "planning-content", "data", "requirements", "REQ-0001.json"), "utf8")).schemaVersion}\nartifactTypes:\n  activated: [requirement]\n`);
  const first = await createRequirement(
    { title: "Nightly replication", statement: "The system must replicate the customer table nightly.", rationale: `${SENTINEL} ${"x".repeat(bodyBytes)}`.trim() },
    { contentRoot, schemasDir: SCHEMAS, validators }
  );
  const record = JSON.parse(readFileSync(join(contentRoot, first.path), "utf8"));
  const dir = join(contentRoot, "data", "requirements");
  const id = (n) => `REQ-${String(n).padStart(4, "0")}`;
  for (let n = 2; n <= count; n++) writeFileSync(join(dir, `${id(n)}.json`), JSON.stringify({ ...record, id: id(n) }, null, 2) + "\n");
  writeFileSync(join(contentRoot, ".ids.json"), JSON.stringify({ ...JSON.parse(readFileSync(join(contentRoot, ".ids.json"), "utf8")), REQ: count }, null, 2) + "\n");
  return { contentRoot, dir, id, record };
}

/** Make `n` of the plan's requirements each produce exactly one finding: the statement is removed. */
function breakRequirements({ dir, id, record }, n) {
  const { statement: _statement, ...broken } = record;
  for (let i = 1; i <= n; i++) writeFileSync(join(dir, `${id(i)}.json`), JSON.stringify({ ...broken, id: id(i) }, null, 2) + "\n");
}

function lint(contentRoot, ...args) {
  const run = spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", maxBuffer: 256 << 20, env: { ...process.env, PLANNING_CONTENT_DIR: contentRoot } });
  return { status: run.status, stdout: run.stdout, stderr: run.stderr, bytes: Buffer.byteLength(run.stdout), json: () => JSON.parse(run.stdout) };
}

const occurrences = (text, needle) => text.split(needle).length - 1;

test("#187 500 clean artifacts: the compact report is a summary with correct counts and no record body", async (t) => {
  const { contentRoot } = await plan(t, 500);
  const run = lint(contentRoot, "--json");
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(run.json(), {
    kind: "report",
    summary: { artifacts: { total: 500, byType: { requirement: 500 } }, findings: { total: 0, error: 0, warning: 0, advisory: 0 } },
    findings: [],
  });
  assert.equal(run.stdout.includes(SENTINEL), false, "a record body reached the compact report");
  assert.ok(run.bytes < 400, `500 clean artifacts printed ${run.bytes} bytes`);
});

test("#187 ten findings: the report is bounded by a fixed base and an allowance per finding, and each finding is whole", async (t) => {
  const fixture = await plan(t, 500);
  breakRequirements(fixture, 10);
  const run = lint(fixture.contentRoot, "--json");
  assert.equal(run.status, 0, run.stderr);
  const report = run.json();
  assert.equal(report.findings.length, 10, JSON.stringify(report.findings.map((f) => f.ruleId)));
  assert.deepEqual(report.summary, { artifacts: { total: 500, byType: { requirement: 500 } }, findings: { total: 10, error: 10, warning: 0, advisory: 0 } });
  assert.equal("records" in report, false);
  assert.equal(run.stdout.includes(SENTINEL), false, "a record body reached the compact report");
  // The allowance is for one finding printed whole: its rule, artifact, path, message and details.
  const BASE = 400;
  const PER_FINDING = 1500;
  assert.ok(run.bytes <= BASE + 10 * PER_FINDING, `ten findings printed ${run.bytes} bytes, over ${BASE} + 10 x ${PER_FINDING}`);
  // Repair information is not record-body noise: every field a finding has is still there.
  for (const finding of report.findings) {
    assert.deepEqual(Object.keys(finding).sort(), ["artifactId", "details", "message", "path", "ruleId", "severity"]);
    assert.match(finding.artifactId, /^REQ-00(0[1-9]|10)$/);
    assert.equal(finding.path, `data/requirements/${finding.artifactId}.json`);
    assert.ok(finding.message.length > 0 && finding.details);
  }
  // With records, the findings are the same objects and the exit is the same.
  const full = lint(fixture.contentRoot, "--json", "--include-records");
  assert.equal(full.status, 0);
  assert.deepEqual(full.json().findings, report.findings);
  assert.deepEqual(full.json().summary, report.summary);
});

test("#187 the compact report does not grow with the artifacts' bodies, and the report with records does", async (t) => {
  const small = await plan(t, 40);
  const large = await plan(t, 40, { bodyBytes: 4000 });
  breakRequirements(small, 3);
  breakRequirements(large, 3);
  const [a, b] = [lint(small.contentRoot, "--json"), lint(large.contentRoot, "--json")];
  assert.equal(b.bytes, a.bytes, `160,000 more bytes of artifact body changed the compact report from ${a.bytes} to ${b.bytes} bytes`);
  assert.equal(b.stdout, a.stdout);

  const [fa, fb] = [lint(small.contentRoot, "--json", "--include-records"), lint(large.contentRoot, "--json", "--include-records")];
  assert.equal(fa.json().records.length, 40);
  assert.equal(occurrences(fa.stdout, SENTINEL), 40, "every record's body is in the report with records");
  // Each of the 40 records carries the 4,000 bytes of filler.
  assert.ok(fb.bytes - fa.bytes >= 40 * 4000, `the report with records grew by ${fb.bytes - fa.bytes} bytes`);
  // And with the number of records.
  const more = await plan(t, 80);
  breakRequirements(more, 3);
  const fc = lint(more.contentRoot, "--json", "--include-records");
  assert.equal(fc.json().records.length, 80);
  assert.ok(fc.bytes > fa.bytes * 1.8, `80 records printed ${fc.bytes} bytes against ${fa.bytes} for 40`);
  assert.equal(lint(more.contentRoot, "--json").bytes, a.bytes, "40 more clean artifacts changed the size of the compact report");
});

test("#187 --include-records restores the records the lint read, unchanged", async (t) => {
  const { contentRoot, record } = await plan(t, 5);
  const report = lint(contentRoot, "--json", "--include-records").json();
  assert.deepEqual(Object.keys(report), ["kind", "summary", "findings", "records"]);
  assert.deepEqual(report.records.map((r) => r.relPath), [1, 2, 3, 4, 5].map((n) => `data/requirements/REQ-000${n}.json`));
  assert.deepEqual(report.records[0].doc, record);
});

test("#187 an artifact with no declared type is counted as unknown, and types are listed in a fixed order", async (t) => {
  const fixture = await plan(t, 4);
  const { type: _type, ...untyped } = fixture.record;
  writeFileSync(join(fixture.dir, "REQ-0002.json"), JSON.stringify({ ...untyped, id: "REQ-0002" }));
  writeFileSync(join(fixture.dir, "REQ-0003.json"), "{ not json");
  writeFileSync(join(fixture.dir, "REQ-0004.json"), JSON.stringify({ ...fixture.record, id: "REQ-0004", type: "decision" }));
  const summary = lint(fixture.contentRoot, "--json").json().summary;
  assert.deepEqual(summary.artifacts, { total: 4, byType: { decision: 1, requirement: 1, unknown: 2 } });
  assert.deepEqual(Object.keys(summary.artifacts.byType), ["decision", "requirement", "unknown"]);
  assert.equal(summary.findings.total, summary.findings.error + summary.findings.warning + summary.findings.advisory);
  assert.ok(summary.findings.total > 0);
});

test("#187 gates: ready exits 0 and blocked exits 1 in both JSON modes, and each finding is counted once", async (t) => {
  const fixture = await plan(t, 12);

  // ---- ready --------------------------------------------------------------------------------------------------
  for (const extra of [[], ["--include-records"]]) {
    const ready = lint(fixture.contentRoot, "--gate", "handoff", "--json", ...extra);
    assert.equal(ready.status, 0, ready.stdout);
    const report = ready.json();
    assert.equal(report.ready, true);
    assert.deepEqual(report.summary, { artifacts: { total: 12, byType: { requirement: 12 } }, findings: { total: 0, error: 0, warning: 0, advisory: 0 } });
    assert.equal("records" in report, extra.length === 1);
    if (extra.length) assert.equal(report.records.length, 12);
    else assert.equal(ready.stdout.includes(SENTINEL), false);
    assert.equal(lint(fixture.contentRoot, "--json", ...extra).status, 0, "a report exits 0");
  }

  // ---- blocked ------------------------------------------------------------------------------------------------
  breakRequirements(fixture, 2);
  const compact = {};
  for (const extra of [[], ["--include-records"]]) {
    const handoff = lint(fixture.contentRoot, "--gate", "handoff", "--json", ...extra);
    assert.equal(handoff.status, 1, handoff.stdout);
    const h = handoff.json();
    assert.equal(h.ready, false);
    assert.equal(h.blocking.length, 2);
    // The handoff result splits the lint's findings by severity; the summary is their total, not a second count.
    assert.deepEqual(h.summary.findings, { total: 2, error: 2, warning: 0, advisory: 0 });
    assert.equal(h.summary.findings.total, h.blocking.length + h.warnings.length + h.advisories.length);

    const stage = lint(fixture.contentRoot, "--gate", `stage:${STAGE}`, "--json", ...extra);
    assert.equal(stage.status, 1, stage.stdout);
    const s = stage.json();
    assert.equal(s.kind, "stage");
    assert.equal(s.ready, false);
    assert.equal(s.allFindings.length, 2);
    assert.deepEqual(s.blockingArtifactFindings, s.allFindings, "the blocking view is a subset of the lint's findings, here all of them");
    assert.ok(s.gateFindings.length > 0, "the stage's own criteria are unattested in this fixture");
    // ⚠️ ONCE EACH: the lint's findings plus the gate's, not `allFindings` plus its blocking subset as well.
    assert.equal(s.summary.findings.total, s.allFindings.length + s.gateFindings.length);
    assert.equal(s.summary.findings.error, s.summary.findings.total);
    assert.equal("records" in s, extra.length === 1);

    // A report over the same blocked plan still exits 0: only a gate blocks.
    assert.equal(lint(fixture.contentRoot, "--json", ...extra).status, 0);

    if (extra.length === 0) Object.assign(compact, { h, s });
    else {
      // Records change nothing but the records.
      const { records: hr, ...hRest } = h;
      const { records: sr, ...sRest } = s;
      assert.deepEqual(hRest, compact.h);
      assert.deepEqual(sRest, compact.s);
      assert.equal(hr.length, 12);
      assert.equal(sr.length, 12);
    }
  }
});

test("#187 human output is what it was, and --include-records without --json is refused", async (t) => {
  const fixture = await plan(t, 6);
  breakRequirements(fixture, 1);
  const report = lint(fixture.contentRoot);
  assert.equal(report.status, 0);
  const finding = lint(fixture.contentRoot, "--json").json().findings[0];
  // The whole of the human report, rebuilt from the finding by the format the CLI has always used.
  assert.equal(
    report.stdout,
    `✖ ${finding.severity.padEnd(9)} ${finding.ruleId.padEnd(34)} ${finding.path}\n    ${finding.message}\n\n6 artifact(s) · {"error":1}\n`
  );
  const handoff = lint(fixture.contentRoot, "--gate", "handoff");
  assert.equal(handoff.status, 1);
  assert.equal(handoff.stdout, `Artifacts:\n✖ ${finding.severity.padEnd(9)} ${finding.ruleId.padEnd(34)} ${finding.path}\n    ${finding.message}\n\nGate: handoff — NOT READY\n`);
  assert.equal(report.stdout.includes(SENTINEL) || handoff.stdout.includes(SENTINEL), false);

  for (const args of [["--include-records"], ["--gate", "handoff", "--include-records"]]) {
    const refused = lint(fixture.contentRoot, ...args);
    assert.equal(refused.status, 2);
    assert.equal(refused.stdout, "");
    assert.equal(refused.stderr, "--include-records adds the parsed artifact records to --json output and has no effect without it.\nUsage: lint-plan [--gate handoff | --gate stage:<id>] [--json [--include-records]]\n");
  }
});

test("#187 a ready stage gate exits 0 in both JSON modes, with the same summary and records only on request", async (t) => {
  const fixture = await plan(t, 12);
  // The stage's readiness inputs are its own: the type it produces exists, and every criterion it declares has a
  // recorded verdict. They are written by the product's writer and read back by the CLI from disk.
  const criteria = loadStageDefinitions()[STAGE].exitCriteria.map((criterion) => criterion.id);
  assert.ok(criteria.length > 0, `${STAGE} declares no exit criteria, so this case would prove nothing`);
  for (const criterion of criteria) await writeStageAttestation(fixture.contentRoot, STAGE, criterion, { result: "satisfied", decidedBy: "#187 fixture" });

  const compact = lint(fixture.contentRoot, "--gate", `stage:${STAGE}`, "--json");
  const full = lint(fixture.contentRoot, "--gate", `stage:${STAGE}`, "--json", "--include-records");
  for (const run of [compact, full]) {
    assert.equal(run.status, 0, run.stdout);
    const report = run.json();
    assert.equal(report.kind, "stage");
    assert.equal(report.ready, true);
    assert.deepEqual(report.gateFindings, []);
    assert.deepEqual(report.pendingHumanCriteria, []);
    assert.deepEqual(report.summary, { artifacts: { total: 12, byType: { requirement: 12 } }, findings: { total: 0, error: 0, warning: 0, advisory: 0 } });
  }
  assert.equal("records" in compact.json(), false);
  assert.equal(compact.stdout.includes(SENTINEL), false, "a record body reached the compact stage report");
  const { records, ...rest } = full.json();
  assert.equal(records.length, 12);
  assert.equal(occurrences(full.stdout, SENTINEL), 12);
  assert.deepEqual(rest, compact.json(), "records change nothing but the records");

  // One verdict withdrawn, and the same gate blocks: the exit above was the gate's answer, not a default.
  await writeStageAttestation(fixture.contentRoot, STAGE, criteria[0], { result: "not-satisfied", decidedBy: "#187 fixture" });
  for (const extra of [[], ["--include-records"]]) {
    const blocked = lint(fixture.contentRoot, "--gate", `stage:${STAGE}`, "--json", ...extra);
    assert.equal(blocked.status, 1, blocked.stdout);
    assert.deepEqual(blocked.json().summary.findings, { total: 1, error: 1, warning: 0, advisory: 0 });
    assert.equal(blocked.json().gateFindings.length, 1);
  }
});
