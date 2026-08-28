/**
 * The read and `<Suspense>` confinement check, and the fixtures that prove each detector fails —
 * TSK-0015, ACC-0021 and ACC-0022, and the second half of ACC-0024.
 *
 * ⚠️ FOUR DETECTORS, SIX FIXTURES, AND A TEST THAT COUNTS THEM. A check with several rules can
 * pass its whole suite while one rule has never fired, and that rule is then decoration. Each is
 * falsified separately below; each was ALSO falsified against a temporary violation in the real
 * application, because a fixture only proves the detector works on a fixture.
 *
 * ⚠️ THE FIXTURES ARE `.jsx` ON PURPOSE. `node --test` collects every `.js`, `.mjs` and `.cjs`
 * under `test/`, and these files contain JSX, which Node cannot parse — collected, they failed the
 * suite for a reason unrelated to anything they test. `.jsx` is outside the runner's patterns and
 * inside the analyser's, which is exactly the gap a fixture wants to sit in.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  analyseReadBoundary,
  formatReadViolation,
  suspenseRanges,
  jsxUsages,
  shellBoundaryConfig,
} from "../lib/shell-boundary.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FIX = join(ROOT, "test", "fixtures", "readboundary");
const fixture = (name) =>
  analyseReadBoundary({
    appDir: join(FIX, name, "app"),
    allowedDir: join(FIX, name, "app", "server"),
    readerFile: join(FIX, name, "app", "_read", "planning.jsx"),
  });
const kinds = (r) => r.violations.map((v) => v.kind).sort();

/* ------------------------------------------------------------------ the JSX primitives */

test("a Suspense range encloses what is inside it and not what follows", () => {
  const src = '<main><Suspense fallback={<p>x</p>}><A /></Suspense><B /></main>';
  const [range] = suspenseRanges(src);
  assert.ok(range, "one range");
  assert.deepEqual(jsxUsages(src, "A").map((u) => u.enclosed), [true]);
  assert.deepEqual(jsxUsages(src, "B").map((u) => u.enclosed), [false]);
});

test("a self-closing Suspense opens no range", () => {
  assert.deepEqual(suspenseRanges("<Suspense />"), []);
});

/* ------------------------------------------------------------------ the fixtures */

test("ALLOWED: the reader is used and the reading component is wrapped", () => {
  const r = fixture("allowed");
  assert.deepEqual(r.violations.map((v) => formatReadViolation(v, join(FIX, "allowed"))), []);
  assert.equal(r.readerSeen, true, "the designated reader must have been examined");
  assert.ok(r.consumers.length > 0, "a clean result with no consumers would mean nothing was checked");
});

test("DIRECT: a component reaching the adapter itself is caught, with file and line", () => {
  const r = fixture("direct");
  assert.deepEqual(kinds(r), ["adapter-outside-reader"]);
  const [v] = r.violations;
  assert.ok(v.file.endsWith(join("app", "panel.jsx")), v.file);
  assert.equal(v.line, 1);
});

test("⚠️ INDIRECT: a helper re-exporting the adapter cannot hide the access", () => {
  const r = fixture("indirect");
  assert.deepEqual(kinds(r), ["adapter-outside-reader"]);
  const [v] = r.violations;
  // Reported against the helper — the file whose import statement is the access.
  assert.ok(v.file.endsWith(join("app", "_helpers", "data.jsx")), v.file);
  assert.equal(v.line, 1);
  assert.match(formatReadViolation(v, join(FIX, "indirect")), /_helpers\/data\.jsx:1/);
});

test("MISSING BOUNDARY: a reading component rendered bare is caught at the rendering site", () => {
  const r = fixture("missing-boundary");
  assert.deepEqual(kinds(r), ["missing-suspense"]);
  const [v] = r.violations;
  assert.ok(v.file.endsWith(join("app", "page.jsx")), "reported where the component is RENDERED");
  assert.equal(v.line, 3);
  assert.match(v.detail, /<Panel> reads planning content and is not enclosed/);
});

test("FS-DIRECT: a component reading the filesystem itself is caught", () => {
  const r = fixture("fs-direct");
  assert.deepEqual(kinds(r), ["fs-access"]);
  assert.equal(r.violations[0].line, 1);
  assert.ok(r.violations[0].file.endsWith(join("app", "panel.jsx")));
});

test("ROUTE-READ: a route entry awaiting the reader has nothing above it to wrap the read", () => {
  const r = fixture("route-read");
  assert.deepEqual(kinds(r), ["read-in-route-entry"]);
  assert.equal(r.violations[0].line, 3);
  assert.match(r.violations[0].detail, /no <Suspense> can enclose it/);
});

test("⚠️ every detector the analyser can emit has a fixture that fires it", () => {
  // ACC-0024 asks for a fixture set containing at least one instance of EACH violation detected.
  // Two detectors were falsified only against temporary real-code violations at first; this is what
  // stops a detector being added later with no control, which is how a rule becomes decoration.
  const emitted = new Set(
    ["direct", "indirect", "missing-boundary", "fs-direct", "route-read"].flatMap((n) =>
      fixture(n).violations.map((v) => v.kind)
    )
  );
  assert.deepEqual(
    [...emitted].sort(),
    ["adapter-outside-reader", "fs-access", "missing-suspense", "read-in-route-entry"],
    "a detector without a failing fixture is a rule nobody has seen fire"
  );
});

test("a missing reader is a REFUSAL, not a clean result", () => {
  const r = analyseReadBoundary({
    appDir: join(FIX, "allowed", "app"),
    allowedDir: join(FIX, "allowed", "app", "server"),
    readerFile: join(FIX, "allowed", "app", "_read", "typo.jsx"),
  });
  // ⚠️ Without this the check confines reads to a file that does not exist and reports success.
  assert.equal(r.readerSeen, false);
});

/* ------------------------------------------------------------------ the real project */

test("the real application confines its reads, and the reader was examined", () => {
  const cfg = shellBoundaryConfig(ROOT);
  const r = analyseReadBoundary({
    appDir: cfg.appDir,
    allowedDir: cfg.allowedDir,
    readerFile: join(ROOT, "app", "_read", "planning.js"),
    exclude: cfg.exclude,
  });
  assert.equal(r.readerSeen, true, "the designated reader must exist and be scanned");
  assert.equal(resolve(r.reader), resolve(join(ROOT, "app", "_read", "planning.js")));
  assert.ok(r.scanned.length >= 5, `only ${r.scanned.length} modules scanned — going vacuous`);
  assert.deepEqual(r.violations.map((v) => formatReadViolation(v, ROOT)), []);
});
