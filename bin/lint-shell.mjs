#!/usr/bin/env node
/**
 * The shell's boundary lint — CMP-0019, both halves.
 *
 * ⚠️ Runs WITHOUT executing the application, which is the property REQ-0021 asks for: AST-0022
 * measured that a violating read is served fresh whenever a compliant one shares its route, so no
 * amount of running the app reveals it.
 *
 * Exits 1 on any violation, on any computed dynamic import — the one construct this analysis cannot
 * resolve — and if the designated reader is missing. A blind spot reported is a blind spot; a blind
 * spot passed over silently is a false clean bill, and a confinement check whose destination does
 * not exist confines reads to nowhere and calls it success.
 */
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import {
  analyseShellBoundary,
  analyseReadBoundary,
  formatViolation,
  formatReadViolation,
  shellBoundaryConfig,
} from "../lib/shell-boundary.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const cfg = shellBoundaryConfig(ROOT);
const READER = join(ROOT, "app", "_read", "planning.js");

const imports = analyseShellBoundary(cfg);
const reads = analyseReadBoundary({
  appDir: cfg.appDir,
  allowedDir: cfg.allowedDir,
  readerFile: READER,
  exclude: cfg.exclude,
});

const problems = [];
if (imports.entries.length === 0) problems.push("No route entry points under app/ — this check would pass vacuously.");
if (!reads.readerSeen)
  problems.push(`The designated reader was not found: ${relative(ROOT, READER)}. Reads would be confined to nowhere.`);
for (const v of imports.violations) problems.push(formatViolation(v, ROOT));
for (const c of imports.computed)
  problems.push(`${relative(ROOT, c.file)}:${c.line}  computed dynamic import — this analysis cannot resolve it`);
for (const v of reads.violations) problems.push(formatReadViolation(v, ROOT));

if (problems.length === 0) {
  console.log(
    `No boundary violations.\n` +
      `${imports.scanned.length} module(s) scanned under app/ · ` +
      `${imports.reachable.length} reachable from ${imports.entries.length} route entry point(s) · ` +
      `${reads.consumers.length} reader consumer(s).`
  );
} else {
  for (const p of problems) console.error(`  ${p}`);
  console.error(`\n${problems.length} problem(s).`);
  process.exitCode = 1;
}
