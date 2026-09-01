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
import { join, dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  analyseReadBoundary,
  formatReadViolation,
  suspenseRanges,
  jsxUsages,
  importBindings,
  identifierUses,
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

test("⚠️ INDIRECTION: handing a reading component to a wrapper is REFUSED, not assumed safe", () => {
  // A <Suspense> exists in that fixture. It is inside the wrapper, and nothing at the call site says
  // the component ends up within it — which is precisely why the rule is fail-closed.
  const r = fixture("indirection");
  assert.deepEqual(kinds(r), ["unsupported-indirection"]);
  assert.equal(r.violations[0].line, 2, "reported at the import that creates the indirection");
  assert.match(r.violations[0].detail, /as a value/);
});

test("renaming a reader-consuming component is refused", () => {
  const bindings = importBindings('import { Panel as P } from "./x.jsx";', () => true);
  assert.deepEqual(bindings, [{ local: "P", imported: "Panel", isDefault: false, line: 1 }]);
});

test("a component imported but never rendered directly is refused", () => {
  // total === jsx === 0 is not "clean"; it is "nothing here can be shown to be enclosed".
  const src = ['import P from "./x.jsx";', "export default function A() { return <div />; }"].join("\n");
  assert.deepEqual(identifierUses(src, "P"), { total: 0, jsx: 0, indirect: 0 });
});

test("⚠️ every detector the analyser can emit has a fixture that fires it", () => {
  // ACC-0024 asks for a fixture set containing at least one instance of EACH violation detected.
  // Two detectors were falsified only against temporary real-code violations at first; this is what
  // stops a detector being added later with no control, which is how a rule becomes decoration.
  const emitted = new Set(
    ["direct", "indirect", "missing-boundary", "fs-direct", "route-read", "indirection"].flatMap((n) =>
      fixture(n).violations.map((v) => v.kind)
    )
  );
  assert.deepEqual(
    [...emitted].sort(),
    ["adapter-outside-reader", "fs-access", "missing-suspense", "read-in-route-entry", "unsupported-indirection"],
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
  // ⚠️ Built from the SHARED config, `adapterConsumers` included. An earlier version listed the
  // options by hand and went red the moment the lint learned about a new adapter consumer — two
  // descriptions of one rule, drifting apart on the first change.
  const r = analyseReadBoundary({ ...cfg, readerFile: join(ROOT, "app", "_read", "planning.js") });
  assert.equal(r.readerSeen, true, "the designated reader must exist and be scanned");
  assert.equal(resolve(r.reader), resolve(join(ROOT, "app", "_read", "planning.js")));
  assert.ok(r.scanned.length >= 5, `only ${r.scanned.length} modules scanned — going vacuous`);
  assert.deepEqual(r.violations.map((v) => formatReadViolation(v, ROOT)), []);
});

test("⚠️ every adapter's permitted consumers are DECLARED, and the list is small", () => {
  // Unlisted adapters admit the reader alone, so this map is the only place the rule is widened.
  // Pinning it makes a widening a visible act rather than a line nobody re-reads — the same
  // treatment `exclude` gets, for the same reason.
  const cfg = shellBoundaryConfig(ROOT);
  const declared = Object.entries(cfg.adapterConsumers ?? {}).map(([adapter, consumers]) => [
    adapter.split(sep).slice(-2).join("/"),
    consumers.map((c) => c.split(sep).slice(-2).join("/")),
  ]);
  assert.deepEqual(declared, [
    ["server/change-stream.js", ["events/route.js"]],
    // ⚠️ THE ONLY ADAPTER WITH TWO CONSUMERS, and it earns that by holding nothing that reads. It
    // re-exports the content-root RESOLVERS and nothing else, so the reason the content adapters
    // admit the reader alone — a second importer of `lintProject` is a second read outside
    // `connection()` — does not reach it. Splitting it out of `content.js` is what kept the widening
    // proportionate: the events route needed a directory name, not a linter.
    ["server/paths.js", ["_read/planning.js", "events/route.js"]],
    ["server/review.js", ["_write/review-action.js"]],
  ]);

  // ⚠️ THE WRITE DOOR HAS EXACTLY ONE CONSUMER, and that is the property DEC-0021's individual
  // review turns on. A second caller of the write adapter is a second place the content lock can be
  // taken from, which is the review happening again — so it fails here rather than passing quietly.
  const write = declared.find(([a]) => a.endsWith("review.js"));
  assert.deepEqual(write?.[1], ["_write/review-action.js"], "the write adapter admits the Server Action alone");

  // ...and the content adapters are NOT in it, so they still admit only the reader.
  for (const name of ["content.js", "stages.js"])
    assert.ok(
      !declared.some(([a]) => a.endsWith(name)),
      `${name} must keep the default: the reader and nobody else`
    );
});
