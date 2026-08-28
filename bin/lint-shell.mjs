#!/usr/bin/env node
/**
 * The shell's boundary lint — CMP-0019 as a command.
 *
 * ⚠️ Runs WITHOUT executing the application, which is the property REQ-0021 asks for: AST-0022
 * measured that a violating read is served fresh whenever a compliant one shares its route, so no
 * amount of running the app reveals it.
 *
 * Exits 1 on any violation, and on any computed dynamic import — the one construct this analysis
 * cannot follow. A blind spot reported is a blind spot; a blind spot passed over silently is a
 * false clean bill.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { analyseShellBoundary, formatViolation, shellBoundaryConfig } from "../lib/shell-boundary.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const r = analyseShellBoundary(shellBoundaryConfig(ROOT));

if (r.entries.length === 0) {
  console.error("No route entry points under app/ — this check would pass vacuously. Refusing.");
  process.exitCode = 1;
} else if (r.violations.length === 0 && r.computed.length === 0) {
  console.log(
    `No boundary violations.\n` +
      `${r.scanned.length} module(s) scanned under app/, ` +
      `${r.reachable.length} reachable from ${r.entries.length} route entry point(s).`
  );
} else {
  for (const v of r.violations) console.error(`  ${formatViolation(v, ROOT)}`);
  for (const c of r.computed)
    console.error(`  ${c.file}:${c.line}  computed dynamic import — this analysis cannot follow it`);
  console.error(`\n${r.violations.length} violation(s), ${r.computed.length} unfollowable import(s).`);
  process.exitCode = 1;
}
