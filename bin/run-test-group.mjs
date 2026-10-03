#!/usr/bin/env node

import { run } from "node:test";
import { spec } from "node:test/reporters";
import { finished } from "node:stream/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { CI_GROUPS } from "../test/ci-groups.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const group = process.argv[2];
// Setup tests include real locked-install controls that replace this checkout's node_modules.
// They must not overlap another setup file on Windows, where loaded native modules are locked.
const serial = process.argv.includes("--serial") || group === "setup";

if (!Object.hasOwn(CI_GROUPS, group)) {
  console.error(`[ci-tests] choose one group: ${Object.keys(CI_GROUPS).join(", ")}`);
  process.exitCode = 2;
} else {
  const files = CI_GROUPS[group].map((name) => join(ROOT, "test", name));
  const timings = new Map();
  let failed = false;
  const started = performance.now();
  const events = run({ files, ...(serial ? { concurrency: false } : {}) });

  events.on("data", (event) => {
    if ((event.type === "test:pass" || event.type === "test:fail") && event.data.nesting === 0) {
      const path = relative(ROOT, event.data.file).replaceAll("\\", "/");
      // Node reports each top-level test with its source file. Summing those durations produces a
      // useful file cost even when one file has many cases (a last-value map hid shell-smoke's build
      // behind its final sub-millisecond control).
      timings.set(path, (timings.get(path) ?? 0) + Math.round(event.data.details.duration_ms));
      if (event.type === "test:fail") failed = true;
    }
  });

  const output = events.compose(spec());
  output.pipe(process.stdout);
  await finished(output);

  const ranked = [...timings].sort((a, b) => b[1] - a[1]);
  const totalMs = Math.round(performance.now() - started);
  console.log(`\n[kiln-ci-profile] group=${group} files=${files.length} serial=${serial} wallMs=${totalMs}`);
  for (const [path, durationMs] of ranked.slice(0, 15)) {
    console.log(`[kiln-ci-profile] ${String(durationMs).padStart(8)} ms  ${path}`);
  }
  process.exitCode = failed ? 1 : 0;
}
