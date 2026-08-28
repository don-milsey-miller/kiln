/**
 * The import-boundary check, and the fixtures that prove it fails — TSK-0006, ACC-0023.
 *
 * ⚠️ THE FIXTURES ARE THE POINT, not decoration. A check nobody has seen fail is a check nobody has
 * seen, and this project has already shipped one: a refusal test written a week ago passed with the
 * refusal deleted, because the assertion that mattered sat behind a condition that was never true.
 * Each violation below is a real directory the analyser is run against, not a mocked return.
 *
 * ⚠️ ACC-0024 — the criterion that asks for the FULL violation set with failing fixtures — is NOT
 * evaluated here. It is satisfied by this task together with TSK-0015, which adds the read and
 * `<Suspense>` confinement half. Marking it now would claim a pair on the strength of one half.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { join, dirname, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  analyseShellBoundary,
  specifiersIn,
  stripComments,
  computedDynamicImports,
  formatViolation,
  shellBoundaryConfig,
} from "../lib/shell-boundary.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FIX = join(ROOT, "test", "fixtures", "boundary");
const fixture = (name) =>
  analyseShellBoundary({
    appDir: join(FIX, name, "app"),
    libDir: join(FIX, name, "lib"),
    allowedDir: join(FIX, name, "app", "server"),
  });

/* ------------------------------------------------------------------ the specifier scanner */

test("comments are blanked without moving any line", () => {
  const src = 'const a = 1;\n/* import x from "../lib/y.mjs" */\n// import z from "../lib/y.mjs"\nconst b = 2;\n';
  const out = stripComments(src);
  assert.equal(out.split("\n").length, src.split("\n").length, "line numbers must survive");
  assert.equal(specifiersIn(src).length, 0, "a lib path inside prose is not an import");
});

test("all three import forms are seen, with their lines", () => {
  const src = [
    'import { a } from "../server/x.js";', // 1
    'import "server-only";', //               2
    'export { b } from "./y.js";', //         3
    'const p = import("./z.js");', //         4
  ].join("\n");
  assert.deepEqual(
    specifiersIn(src).map((s) => [s.line, s.spec]),
    [
      [1, "../server/x.js"],
      [2, "server-only"],
      [3, "./y.js"],
      [4, "./z.js"],
    ]
  );
});

test("a computed dynamic import is reported as a limitation, never as absence", () => {
  const found = computedDynamicImports('const m = await import(whichever);\n');
  assert.equal(found.length, 1);
  assert.equal(found[0].line, 1);
});

/* ------------------------------------------------------------------ the fixtures */

test("ALLOWED: a page reaching lib/ through the adapter is clean", () => {
  const r = fixture("allowed");
  assert.deepEqual(r.violations, [], JSON.stringify(r.violations, null, 2));
  assert.ok(
    r.reachable.some((f) => f.endsWith(join("app", "server", "content.js"))),
    "the adapter must be walked, not skipped — otherwise 'clean' would mean 'not looked at'"
  );
});

test("DIRECT: a page importing lib/ itself is caught at its own line", () => {
  const r = fixture("direct");
  assert.equal(r.violations.length, 1, JSON.stringify(r.violations, null, 2));
  const [v] = r.violations;
  assert.ok(v.file.endsWith(join("app", "page.js")), v.file);
  assert.equal(v.line, 1);
  assert.equal(v.specifier, "../lib/thing.mjs");
});

test("⚠️ TRANSITIVE: an intermediate cannot hide the violation, and is named as its author", () => {
  const r = fixture("transitive");
  assert.equal(r.violations.length, 1, JSON.stringify(r.violations, null, 2));
  const [v] = r.violations;

  // Reported against the file whose import statement IS the violation...
  assert.ok(v.file.endsWith(join("app", "_helpers", "shim.js")), v.file);
  assert.equal(v.line, 2, "line 1 is a comment; the offending re-export is line 2");

  // ...and the chain shows how the application reaches it, so blame is locatable in both directions.
  assert.equal(v.chain.length, 2);
  assert.ok(v.chain[0].endsWith(join("app", "page.js")), v.chain[0]);
  assert.ok(v.chain[1].endsWith(join("app", "_helpers", "shim.js")), v.chain[1]);

  const line = formatViolation(v, join(FIX, "transitive"));
  assert.match(line, /app\/_helpers\/shim\.js:2/);
  assert.match(line, /reached from: app\/page\.js/);
});

test("the skeleton is excluded BY NAME, and it is the only exclusion", () => {
  // app/server.mjs is the walking skeleton DEC-0017 preserves: a standalone Node program that
  // happens to live in app/, importing lib/ directly as it always has.
  const cfg = shellBoundaryConfig(ROOT);
  assert.equal(cfg.exclude.length, 1, "exactly one exclusion — a second must be a visible act");
  assert.ok(cfg.exclude[0].endsWith(join("app", "server.mjs")));

  // Excluded by NAME, not by unreachability. Reachability would also have excluded every module no
  // view imports yet, which today is the reader and both adapters — a check examining nothing.
  const withoutExclusion = analyseShellBoundary({ ...cfg, exclude: [] });
  assert.ok(
    withoutExclusion.violations.some((v) => v.file.endsWith(join("app", "server.mjs"))),
    "the skeleton does import lib/ directly — if it ever stops, this exclusion should go"
  );
  assert.ok(
    !withoutExclusion.reachable.some((f) => f.endsWith(join("app", "server.mjs"))),
    "and no route reaches it; were one to, it would become application code and be checked"
  );
});

/* ------------------------------------------------------------------ the real project */

test("the real application has no import-boundary violations", () => {
  const r = analyseShellBoundary(shellBoundaryConfig(ROOT));
  assert.ok(r.entries.length > 0, "no route entry points found — the check would be vacuous");
  // ⚠️ The scope is every module under app/, not just what a route reaches. An earlier version
  // walked two files and reported the project clean without looking at the reader or the adapters.
  assert.ok(r.scanned.length >= 5, `only ${r.scanned.length} modules scanned — the check is going vacuous`);
  assert.deepEqual(
    r.violations.map((v) => formatViolation(v, ROOT)),
    [],
    "application modules outside app/server/ are reaching lib/"
  );
  assert.deepEqual(
    r.computed.map((c) => `${c.file.split(sep).slice(-2).join("/")}:${c.line}`),
    [],
    "a computed dynamic import is a blind spot in this analysis and must be reviewed, not ignored"
  );
});
