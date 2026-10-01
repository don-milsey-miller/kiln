#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { evaluateProductionAudit } from "../lib/production-audit.mjs";
import { repairPiBraceExpansion } from "./repair-pi-brace-expansion.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
try {
  repairPiBraceExpansion(root, { check: true });
} catch (error) {
  process.stderr.write(`[production-audit] installed dependency check failed: ${error?.message ?? String(error)}\n`);
  process.exitCode = 1;
}
const npmCli = process.env.npm_execpath;
const audited = npmCli
  ? spawnSync(process.execPath, [npmCli, "audit", "--omit=dev", "--json"], { cwd: root, encoding: "utf8", windowsHide: true })
  : spawnSync("npm audit --omit=dev --json", { cwd: root, encoding: "utf8", windowsHide: true, shell: true });

let report;
let exceptions;
try {
  if (audited.error) throw audited.error;
  report = JSON.parse(audited.stdout);
  if (report === null || typeof report !== "object" || report.error || report.vulnerabilities === null || typeof report.vulnerabilities !== "object")
    throw new Error("npm audit did not return a vulnerability report");
  exceptions = JSON.parse(readFileSync(join(root, ".audit-exceptions.json"), "utf8"));
} catch (error) {
  process.stderr.write(`[production-audit] could not read audit data: ${error?.message ?? String(error)}\n`);
  process.exitCode = 2;
}

if (report && exceptions) {
  const result = evaluateProductionAudit(report, exceptions);
  for (const error of result.errors) process.stderr.write(`[production-audit] invalid exception: ${error}\n`);
  for (const finding of result.blocked)
    process.stderr.write(`[production-audit] blocked ${finding.severity} ${finding.package}/${finding.advisory}: ${finding.title}\n`);
  for (const entry of result.excepted)
    process.stdout.write(`[production-audit] temporary exception ${entry.package}/${entry.advisory} expires ${entry.expires} (${entry.approvedBy})\n`);
  if (result.ok) process.stdout.write(`[production-audit] pass: ${result.findings.length} high/critical production advisories, ${result.excepted.length} excepted.\n`);
  else process.exitCode = 1;
}
