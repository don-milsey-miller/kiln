import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { evaluateProductionAudit } from "../lib/production-audit.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const NOW = new Date("2026-09-29T12:00:00.000Z");
const empty = () => ({ auditReportVersion: 2, vulnerabilities: {} });
const vulnerable = () => ({
  auditReportVersion: 2,
  vulnerabilities: {
    next: {
      severity: "critical",
      via: [
        {
          title: "A critical regression",
          url: "https://github.com/advisories/GHSA-p293-qw3h-jr36",
          severity: "critical",
        },
      ],
    },
    undici: {
      severity: "moderate",
      via: [{ title: "Below the gate", url: "https://github.com/advisories/GHSA-3wwx-pv8p-q78v", severity: "moderate" }],
    },
  },
});
const document = (exceptions = []) => ({ schemaVersion: 1, exceptions });
const exception = (overrides = {}) => ({
  package: "next",
  advisory: "GHSA-P293-QW3H-JR36",
  severity: "critical",
  expires: "2026-10-20",
  reason: "Upgrade validation is temporarily blocked by the linked compatibility work.",
  approvedBy: "https://github.com/example/project/issues/123",
  ...overrides,
});

test("a clean production audit passes with no exception debt", () => {
  assert.deepEqual(evaluateProductionAudit(empty(), document(), { now: NOW }), {
    ok: true,
    findings: [],
    blocked: [],
    excepted: [],
    errors: [],
  });
});

test("a high or critical advisory blocks while a moderate advisory does not", () => {
  const result = evaluateProductionAudit(vulnerable(), document(), { now: NOW });
  assert.equal(result.ok, false);
  assert.deepEqual(result.blocked.map(({ package: name, advisory, severity }) => [name, advisory, severity]), [
    ["next", "GHSA-P293-QW3H-JR36", "critical"],
  ]);
});

test("an exact, issue-backed, short-lived exception is accepted", () => {
  const result = evaluateProductionAudit(vulnerable(), document([exception()]), { now: NOW });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.excepted.length, 1);
  assert.deepEqual(result.blocked, []);
});

test("a transitive advisory is matched at the affected package rather than blocked again at its parent", () => {
  const report = vulnerable();
  report.vulnerabilities.framework = { severity: "critical", via: ["next"] };
  const result = evaluateProductionAudit(report, document([exception()]), { now: NOW });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.findings.map(({ package: name }) => name), ["next"]);
});

test("expired, overlong, mismatched, malformed and stale exceptions fail closed", () => {
  for (const [label, report, entry, pattern] of [
    ["expired", vulnerable(), exception({ expires: "2026-09-28" }), /expired/],
    ["overlong", vulnerable(), exception({ expires: "2026-11-30" }), /more than 30 days/],
    ["wrong package", vulnerable(), exception({ package: "not-next" }), /unused exception/],
    ["no approval issue", vulnerable(), exception({ approvedBy: "approved verbally" }), /GitHub issue URL/],
    ["stale", empty(), exception(), /unused exception/],
  ]) {
    const result = evaluateProductionAudit(report, document([entry]), { now: NOW });
    assert.equal(result.ok, false, label);
    assert.match(result.errors.join("\n"), pattern, label);
  }
});

test("the production manifest and lock declare the patched graph", () => {
  const manifest = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  const lock = JSON.parse(readFileSync(join(ROOT, "package-lock.json"), "utf8"));
  const installed = (path) => JSON.parse(readFileSync(join(ROOT, "node_modules", ...path.split("/"), "package.json"), "utf8")).version;

  assert.equal(manifest.dependencies.next, "16.3.7");
  assert.equal(manifest.dependencies["@earendil-works/pi-coding-agent"], "0.87.1");
  assert.equal(manifest.dependencies["brace-expansion"], "5.0.12");
  assert.equal(manifest.overrides["brace-expansion"], "$brace-expansion");
  assert.equal(manifest.overrides["fast-uri"], "3.1.8");
  assert.equal(lock.packages["node_modules/next"].version, "16.3.7");
  assert.equal(lock.packages["node_modules/fast-uri"].version, "3.1.8");
  assert.equal(lock.packages["node_modules/@earendil-works/pi-coding-agent/node_modules/undici"].version, "8.10.2");
  assert.equal(lock.packages["node_modules/@earendil-works/pi-coding-agent/node_modules/brace-expansion"].version, "5.0.12");
  assert.equal(installed("next"), "16.3.7");
  assert.equal(installed("fast-uri"), "3.1.8");
  assert.equal(installed("@earendil-works/pi-coding-agent"), "0.87.1");
  assert.equal(installed("@earendil-works/pi-coding-agent/node_modules/undici"), "8.10.2");
});

test("#51 CI audits the locked production graph once on its deliberately clean install", () => {
  const workflow = readFileSync(join(ROOT, ".github", "workflows", "ci.yml"), "utf8").replace(/\r\n/g, "\n");
  const validate = workflow.slice(workflow.indexOf("  validate:"), workflow.indexOf("  core:"));
  const installAt = validate.indexOf("run: npm ci");
  const auditAt = validate.indexOf("run: npm run audit:production");
  assert.ok(installAt !== -1 && installAt < auditAt, "CI does not audit the clean installed production graph");
  assert.equal((workflow.match(/run: npm run audit:production/g) ?? []).length, 1, "the audit step is conditional or duplicated");
});
