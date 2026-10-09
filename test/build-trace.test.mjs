/**
 * #186 — the trace inspector's own controls.
 *
 * The inspection of a real build is in `clean-consumer-journey.test.mjs`, over the clone a consumer gets. These are
 * the cases that build never produces while the fix holds, so that the inspector is shown to refuse each of them:
 * a file outside the tool root, a file reached through a link, a file in a directory nothing justifies, an entry
 * that names nothing, and a trace that is simply too large.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";

import { TRACE_ALLOWLIST, TRACE_CEILINGS, describeTraceFailures, inspectBuildTraces } from "./helpers/build-trace.mjs";
import { removeTestTree } from "./helpers/cleanup.mjs";

/** A consumer layout: `<base>/project/.planning` is the tool root, with one route manifest naming `entries`. */
function layout(t, entries, files = {}) {
  const base = mkdtempSync(join(tmpdir(), "kiln-trace-"));
  t.after(() => removeTestTree(base, "#186 trace fixture"));
  const tool = join(base, "project", ".planning");
  const write = (rel, text = "x") => {
    const path = join(tool, rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
    return path;
  };
  write(".next/server/chunks/a.js", "chunk");
  write("node_modules/next/dist/server.js", "next");
  for (const [rel, text] of Object.entries(files)) write(rel, text);
  const manifest = write(".next/server/app/page.js.nft.json", JSON.stringify({ version: 1, files: entries }));
  return { base, tool, manifest, write };
}

const ALLOWED = ["../chunks/a.js", "../../../node_modules/next/dist/server.js"];

test("#186 a trace naming only compiled output and the framework passes, and each file is counted once", (t) => {
  const { tool, write } = layout(t, ALLOWED);
  write(".next/server/app/api/route.js.nft.json", JSON.stringify({ version: 1, files: ["../../chunks/a.js"] }));
  const report = inspectBuildTraces(tool);
  assert.deepEqual(report.violations, []);
  assert.deepEqual(report.ceilings, []);
  assert.equal(report.manifests, 2);
  assert.equal(report.files, 2, "a file named by two manifests is one file");
  assert.equal(report.bytes, "chunk".length + "next".length);
});

test("#186 a trace entry that climbs out of the tool root is refused, and the failure names the trace and the file", (t) => {
  const { base, tool } = layout(t, [...ALLOWED, "../../../../kiln186-sentinel.txt"]);
  writeFileSync(join(base, "project", "kiln186-sentinel.txt"), "the consumer's file");
  const report = inspectBuildTraces(tool);
  assert.equal(report.violations.length, 1);
  assert.equal(report.violations[0].reason, "is outside the Kiln tool root");
  const text = describeTraceFailures(report);
  assert.match(text, /^\.next\/server\/app\/page\.js\.nft\.json: 1 offending entry$/m);
  assert.ok(text.includes(`kiln186-sentinel.txt is outside the Kiln tool root`), text);
});

test("#186 an entry spelled inside an allowed root is judged by where its link leads", (t) => {
  const { base, tool } = layout(t, [...ALLOWED, "../../../node_modules/next/linked/secret.txt"]);
  const outside = join(base, "elsewhere");
  mkdirSync(outside);
  writeFileSync(join(outside, "secret.txt"), "not Kiln's");
  // A junction on Windows, which needs no privilege; a directory symlink elsewhere.
  symlinkSync(outside, join(tool, "node_modules", "next", "linked"), "junction");
  const report = inspectBuildTraces(tool);
  assert.equal(report.violations.length, 1, describeTraceFailures(report));
  assert.equal(report.violations[0].reason, "is outside the Kiln tool root");
  assert.ok(report.violations[0].resolved.endsWith(join("elsewhere", "secret.txt")), report.violations[0].resolved);
});

test("#186 files inside the tool root are refused unless a runtime root justifies them", (t) => {
  const unjustified = {
    ".git/HEAD": "ref",
    "planning-content/data/requirements/REQ-0001.json": "{}",
    "docs/plan/data/tasks.json": "[]",
    "test/fixtures/x.mjs": "",
    "schemas/runtime/consent.schema.json": "{}",
    "stages/01-intake.json": "{}",
    "package.json": "{}",
    "node_modules/left-pad/index.js": "",
    ".next/cache/x": "",
  };
  const { tool } = layout(t, [...ALLOWED, ...Object.keys(unjustified).map((rel) => `../../../${rel}`)], unjustified);
  const report = inspectBuildTraces(tool);
  assert.deepEqual(
    report.violations.map((v) => v.reason).sort(),
    Object.keys(unjustified).map((rel) => `is not under an allowed runtime root (${rel})`).sort()
  );
});

test("#186 a directory entry is refused even inside an allowed root, and adds nothing to the totals", (t) => {
  const directories = ["../../../node_modules", "../../../node_modules/next/dist", "../chunks"];
  const { tool } = layout(t, [...ALLOWED, ...directories]);
  const report = inspectBuildTraces(tool);
  assert.deepEqual(report.violations.map((v) => v.reason), Array(3).fill("is not a regular file (a directory)"));
  assert.deepEqual(report.violations.map((v) => v.entry), directories);
  assert.equal(report.files, 2, "a refused directory is not counted as a traced file");
});

test("#186 an entry that names nothing is refused rather than skipped", (t) => {
  const { tool } = layout(t, [...ALLOWED, "../chunks/gone.js"]);
  const report = inspectBuildTraces(tool);
  assert.equal(report.violations.length, 1);
  assert.match(report.violations[0].reason, /^cannot be resolved \(ENOENT\)$/);
});

test("#186 the ceilings are enforced over every manifest together", (t) => {
  const { tool } = layout(t, ALLOWED);
  const files = inspectBuildTraces(tool, { ceilings: { files: 1, bytes: 1 << 20, platformBytes: 0 } });
  assert.deepEqual(files.ceilings, ["2 traced files, over the ceiling of 1"]);
  const bytes = inspectBuildTraces(tool, { ceilings: { files: 10, bytes: 8, platformBytes: 0 } });
  assert.deepEqual(bytes.ceilings, ["9 traced bytes, over the ceiling of 8"]);
  assert.ok(describeTraceFailures(bytes).includes("9 traced bytes, over the ceiling of 8"));
});

test("#186 sharp's platform binaries are counted apart, and neither ceiling makes room for the other", (t) => {
  const binary = "node_modules/@img/sharp-libvips-linux-x64/lib/libvips.so";
  const { tool } = layout(t, [...ALLOWED, `../../../${binary}`], { [binary]: "x".repeat(100) });
  const report = inspectBuildTraces(tool);
  assert.deepEqual(report.violations, []);
  assert.deepEqual([report.files, report.bytes, report.platformBytes], [3, 9, 100]);
  // Room under the platform ceiling does not admit bytes elsewhere, and room elsewhere does not admit a binary.
  assert.deepEqual(inspectBuildTraces(tool, { ceilings: { files: 10, bytes: 8, platformBytes: 1 << 20 } }).ceilings, ["9 traced bytes, over the ceiling of 8"]);
  assert.deepEqual(inspectBuildTraces(tool, { ceilings: { files: 10, bytes: 1 << 20, platformBytes: 99 } }).ceilings, ["100 traced bytes of platform binaries, over the ceiling of 99"]);
});

test("#186 the documented ceilings sit between the measured fixed build and the measured defect", () => {
  // Measured on a clean consumer clone: 973 files and 17,328,277 bytes fixed on Windows, 977 files on Linux;
  // 2,093 files and 33,420,130 bytes on d2ff706. The journey's own clone of the defect measured 27,477,914 bytes.
  assert.ok(TRACE_CEILINGS.files > 977 && TRACE_CEILINGS.files < 2093);
  assert.ok(TRACE_CEILINGS.bytes > 17_328_277 && TRACE_CEILINGS.bytes < 27_477_914);
  // The largest platform binary measured is @img/sharp-libvips-linux-x64, 18,711,101 bytes unpacked.
  assert.ok(TRACE_CEILINGS.platformBytes > 18_711_101 && TRACE_CEILINGS.platformBytes < 2 * 18_711_101, "the platform ceiling admits one libvips and not two");
  for (const { root, why } of TRACE_ALLOWLIST) {
    assert.match(root, /^(\.next\/server|node_modules\/[^/]+(\/[^/]+)?)\/$/, `${root} is wider than one package or the compiled output`);
    assert.ok(why, `${root} has no stated reason`);
  }
});

test("#186 no module under lib/ reaches node:path except runtime-path.mjs", () => {
  // ⚠️ THE RULE runtime-path.mjs STATES, ENFORCED. One join imported from `node:path` in a module the shell bundles
  // is enough to put the clone's files back in a trace. Every way of reaching the module is looked for: a static
  // import or re-export, a dynamic import, `require`, and `getBuiltinModule`.
  const lib = join(import.meta.dirname, "..", "lib");
  const DIRECT = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*|\bgetBuiltinModule\s*\(\s*)["'`](?:node:)?path(?:\/(?:posix|win32))?["'`]/;
  const offenders = [];
  let scanned = 0;
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.(?:mjs|cjs|js)$/.test(entry.name)) {
        scanned++;
        if (relative(lib, path) === "runtime-path.mjs") continue;
        readFileSync(path, "utf8").split(/\r?\n/).forEach((line, i) => {
          if (DIRECT.test(line)) offenders.push(`${relative(lib, path).split(sep).join("/")}:${i + 1}: ${line.trim()}`);
        });
      }
    }
  };
  walk(lib);
  assert.ok(scanned > 100, `only ${scanned} modules were scanned under lib/`);
  assert.deepEqual(offenders, [], "these take path functions from node:path directly; import them from lib/runtime-path.mjs");
  // The pattern is shown to see each form, so an empty result above means something.
  for (const form of ['import { join } from "node:path";', "import path from 'path';", 'export { sep } from "node:path";', 'await import("node:path")', 'require("path")', 'process.getBuiltinModule("node:path")', 'import "node:path/posix";'])
    assert.match(form, DIRECT, form);
  for (const form of ['import { join } from "./runtime-path.mjs";', 'openBy: everything === null ? "id" : "path",', 'required: ["path"],', 'import { x } from "./path-utils.mjs";'])
    assert.doesNotMatch(form, DIRECT, form);
});
