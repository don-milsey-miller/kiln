/**
 * Every stage document reaches the package, and the check is SET EQUALITY.
 *
 * ⚠️ This exists because of AST-0028, which was found by reading the publisher rather than by a
 * failing test — and that is the point. `readStageDocs` filtered on `.endsWith(".md")`, so renaming a
 * stage document to `.mdx` would have removed it from every package while the package still
 * validated, still rendered, and reported a MANIFEST whose counts were never about stage documents.
 * A well-formed false success reached through a two-character change to a filename.
 *
 * ⚠️ A COUNT WOULD NOT HAVE CAUGHT IT, which is why none of these assert one. A count agrees with
 * itself the moment one document is dropped and another is added, and it agrees trivially whenever
 * both sides are derived from the same map. The comparison has to be source-directory against
 * emitted-package, by name.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
import { publishHandoff, HandoffRefused, stageDocSetProblems, readStageDocs, STAGE_DOC_EXTENSIONS } from "../lib/handoff/publish.mjs";
import { reapLater, installReaper } from "./helpers/reap.mjs";

installReaper();

/* ------------------------------------------------------ the pure half: the comparison itself */

const pkg = (...names) => new Map(names.map((n) => [`docs/${n}`, "text"]));
const src = (...names) => new Map(names.map((n) => [n, "text"]));

test("set equality passes only when both sides name the same documents", () => {
  assert.deepEqual(stageDocSetProblems(src("01.md", "02.mdx"), pkg("01.md", "02.mdx")), []);
});

test("a document that never entered the package is named, not counted", () => {
  const problems = stageDocSetProblems(src("01.md", "02.mdx"), pkg("01.md"));
  assert.equal(problems.length, 1);
  assert.match(problems[0], /missing from the package: 02\.mdx/);
});

test("⚠️ one dropped and one added is the case a count cannot see", () => {
  // Same number on both sides. This is the assertion that makes the whole file worth having.
  const problems = stageDocSetProblems(src("01.md", "02.mdx"), pkg("01.md", "99-invented.md"));
  assert.equal(problems.length, 2, JSON.stringify(problems));
  assert.match(problems.join(" "), /missing from the package: 02\.mdx/);
  assert.match(problems.join(" "), /no source: 99-invented\.md/);
});

test("the package inventing a document is a problem in its own right", () => {
  const problems = stageDocSetProblems(src("01.md"), pkg("01.md", "02.md"));
  assert.deepEqual(problems.length, 1);
  assert.match(problems[0], /no source: 02\.md/);
});

test("`.mdx` is a stage-document extension, so the contract can change format without losing content", () => {
  assert.deepEqual([...STAGE_DOC_EXTENSIONS].sort(), [".md", ".mdx"]);
});

/* ------------------------------------------------ the wired half: through a real publish */

function fixture() {
  const base = reapLater(mkdtempSync(join(tmpdir(), "vpw-stagedocs-")));
  const contentRoot = join(base, "planning-content");
  for (const d of ["stages", "data", "state/stage-attestations"]) mkdirSync(join(contentRoot, d), { recursive: true });
  return { base, contentRoot, stages: join(contentRoot, "stages") };
}

test("an unrecognised file in stages/ is REFUSED, never quietly skipped", () => {
  // ⚠️ Calls readStageDocs DIRECTLY, and the first version of this test did not — it drove a whole
  // publish against an incomplete fixture, which refused at the STAGE GATE long before reaching this
  // code. Falsification caught it: deleting the refusal left the test green, because the assertion
  // that mattered sat behind an `if` that was never true. A test that cannot fail is a claim nobody
  // checked, which is the same defect this refusal exists to prevent.
  const f = fixture();
  try {
    writeFileSync(join(f.stages, "01-intake.md"), "# Stage 1\n");
    writeFileSync(join(f.stages, "notes.txt"), "scratch");
    let err = null;
    try { readStageDocs(f.contentRoot); } catch (e) { err = e; }
    assert.ok(err instanceof HandoffRefused, `expected a refusal, got ${err ?? "a successful read"}`);
    assert.match(err.message, /notes\.txt/, "the refusal names the file");
    assert.match(err.message, /dropped them silently/, "and says what it prevented");
  } finally {
    rmSync(f.base, { recursive: true, force: true, maxRetries: 3 });
  }
});

test("recognised stage documents are read, in both formats", () => {
  const f = fixture();
  try {
    writeFileSync(join(f.stages, "01-intake.md"), "# One\n");
    writeFileSync(join(f.stages, "06-risk.mdx"), "# Six\n");
    assert.deepEqual([...readStageDocs(f.contentRoot).keys()], ["01-intake.md", "06-risk.mdx"]);
  } finally {
    rmSync(f.base, { recursive: true, force: true, maxRetries: 3 });
  }
});

test("a renderer that drops a stage document is caught by the set check", () => {
  // The integration shape, without needing a complete publishable project: the renderer emits a
  // package that is internally consistent and missing one authored document. `validatePackage`
  // cannot see this -- it compares the emitted map against disk, and the map never had the file.
  const stageDocs = src("01-intake.md", "06-risk-feasibility.mdx");
  const emitted = new Map([
    ["MANIFEST.json", "{}"],
    ["docs/01-intake.md", "text"],
  ]);
  const problems = stageDocSetProblems(stageDocs, emitted);
  assert.deepEqual(problems, ["stage documents missing from the package: 06-risk-feasibility.mdx"]);
});

test("a dotfile in stages/ is exempt, because it is not authored content", async () => {
  const f = fixture();
  try {
    writeFileSync(join(f.stages, "01-intake.md"), "# Stage 1\n");
    writeFileSync(join(f.stages, ".gitkeep"), "");
    assert.deepEqual([...readStageDocs(f.contentRoot).keys()], ["01-intake.md"], "the dotfile is ignored, the document is not");
  } finally {
    rmSync(f.base, { recursive: true, force: true, maxRetries: 3 });
  }
});

test("every non-dotfile in the real project's stages/ is a stage document", () => {
  // ⚠️ Guards the refusal above against the project itself: if a stray file ever lands in stages/,
  // this fails here rather than the next publish failing for a reason nobody expected. It found
  // `.gitkeep` the first time it ran, which is why the dotfile exemption exists at all.
  const dir = join(ROOT, "planning-content", "stages");
  const names = readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && !e.name.startsWith("."))
    .map((e) => e.name);
  assert.ok(names.length >= 9, `expected at least the nine stage documents, saw ${names.length}`);
  for (const n of names)
    assert.ok(
      STAGE_DOC_EXTENSIONS.some((e) => n.endsWith(e)),
      `${n} is not a stage document, and publishing would now refuse rather than drop it`
    );
});
