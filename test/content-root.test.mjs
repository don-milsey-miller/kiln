import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  toolRoot,
  resolveContentRoot,
  resolveInContentRoot,
  isInsideContentRoot,
  projectRootCandidate,
  resolveProjectRoot,
  ContentRootError,
  PathEscapeError,
  OVERRIDE_ENV,
} from "../lib/content-root.mjs";

/** The consumer layout 0(d) owes a fixture test for: `.planning/` beside a sibling `planning-content/`. */
function consumerLayout() {
  const base = mkdtempSync(join(tmpdir(), "vpw-consumer-"));
  mkdirSync(join(base, ".planning", "lib"), { recursive: true });
  mkdirSync(join(base, "planning-content", "data"), { recursive: true });
  writeFileSync(join(base, "planning-content", "project.yaml"), "name: consumer\n");
  // The trap #70 was reasoned from: the TOOL ships its own planning-content/, so the wrong
  // one exists and parses in every consumer install.
  mkdirSync(join(base, ".planning", "planning-content"), { recursive: true });
  writeFileSync(join(base, ".planning", "planning-content", "project.yaml"), "name: THE-TOOLS-OWN\n");
  return base;
}

test("toolRoot is derived from module location, not cwd", () => {
  const before = process.cwd();
  process.chdir(tmpdir());
  try {
    assert.equal(toolRoot(), before.replace(/[\\/]$/, ""));
  } finally {
    process.chdir(before);
  }
});

test("#70: resolves the sibling, not the tool's own copy", () => {
  const base = consumerLayout();
  try {
    const root = resolveContentRoot({ [OVERRIDE_ENV]: join(base, "planning-content") });
    assert.match(root, /planning-content$/);
    assert.ok(!root.includes(".planning"), "resolved the tool's own planning-content");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("#70: a missing content root refuses to start and names the path", () => {
  const missing = join(tmpdir(), "vpw-definitely-not-here");
  assert.throws(
    () => resolveContentRoot({ [OVERRIDE_ENV]: missing }),
    (e) => e instanceof ContentRootError && e.message.includes(missing)
  );
});

test("#70: a file where a directory belongs is refused", () => {
  const base = mkdtempSync(join(tmpdir(), "vpw-file-"));
  const f = join(base, "planning-content");
  writeFileSync(f, "not a directory");
  try {
    assert.throws(() => resolveContentRoot({ [OVERRIDE_ENV]: f }), ContentRootError);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("#86: an ordinary payload path resolves inside the root", () => {
  const base = consumerLayout();
  const root = join(base, "planning-content");
  try {
    const p = resolveInContentRoot("data/openapi.json", { contentRoot: root });
    assert.ok(p.endsWith(join("data", "openapi.json")));
    assert.ok(isInsideContentRoot("data/schema.yaml", { contentRoot: root }));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("#86: traversal, absolute and drive-letter paths are all refused", () => {
  const base = consumerLayout();
  const root = join(base, "planning-content");
  try {
    for (const bad of ["../.planning/planning-content/project.yaml", "a/../../escape.txt", "/etc/passwd", "C:\\Windows\\win.ini", ""]) {
      assert.throws(() => resolveInContentRoot(bad, { contentRoot: root }), PathEscapeError, `accepted ${JSON.stringify(bad)}`);
      assert.equal(isInsideContentRoot(bad, { contentRoot: root }), false);
    }
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("#86: a symlink out of the content root is refused — the reason syntax is not the boundary", (t) => {
  const base = consumerLayout();
  const root = join(base, "planning-content");
  const outside = join(base, "outside");
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(outside, "secret.json"), "{}");
  try {
    try {
      symlinkSync(outside, join(root, "linked"), "junction");
    } catch {
      t.skip("symlink/junction creation not permitted in this environment");
      return;
    }
    // Syntactically innocent: no `..`, not absolute. The schema pattern would accept it.
    assert.match("linked/secret.json", /^(?!.*\.\.)[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/);
    assert.throws(() => resolveInContentRoot("linked/secret.json", { contentRoot: root }), PathEscapeError);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("a path that does not exist yet still resolves and is still contained", () => {
  const base = consumerLayout();
  const root = join(base, "planning-content");
  try {
    const p = resolveInContentRoot("data/not-written-yet.json", { contentRoot: root });
    assert.ok(p.endsWith(join("data", "not-written-yet.json")));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

/* ===================================================== TSK-0025: the project root ============== */

/**
 * ⚠️ **THE PROJECT ROOT IS DERIVED FROM THE CONTENT ROOT, NEVER FROM THE TOOL ROOT.** The two agree
 * in a normal consumer install, which is exactly why deriving it the wrong way would pass every
 * ordinary test and fail only where it matters: under `PLANNING_CONTENT_DIR`, where the project is
 * the owner of THAT directory and `<toolRoot>/..` names somewhere else entirely.
 *
 * These tests are written around that divergence rather than around the agreement.
 */

test("with no override, the project root is the parent of the derived content root", () => {
  const base = consumerLayout();
  try {
    const candidate = projectRootCandidate({});
    assert.equal(candidate.override, false);
    assert.match(candidate.how, /^dirname\(<toolRoot>\/\.\.\/planning-content\)$/);
    // In THIS repository the sibling content root does not exist, so resolution refuses — which is
    // the same refusal `resolveContentRoot` gives, inherited rather than reimplemented.
    assert.throws(() => resolveProjectRoot({ env: {} }), ContentRootError);
    assert.ok(base);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("with the override set, the project root owns the OVERRIDE — not the tool's parent", () => {
  const base = consumerLayout();
  try {
    const env = { [OVERRIDE_ENV]: join(base, "planning-content") };

    const resolved = resolveProjectRoot({ env });
    assert.equal(resolved, realpathSync(base), "the project is the owner of the overridden content directory");

    // ⚠️ THE ASSERTION THAT MAKES THIS WORTH WRITING. `<toolRoot>/..` is a real directory and a
    // plausible answer, and it is the wrong one. A resolver that took it would pass the test above.
    assert.notEqual(resolved, resolve(toolRoot(), ".."), "the tool's parent must not be mistaken for the project");
    assert.equal(projectRootCandidate(env).override, true);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("an explicit project root that disagrees with the content owner refuses, naming both", () => {
  const base = consumerLayout();
  const other = mkdtempSync(join(tmpdir(), "vpw-elsewhere-"));
  try {
    const env = { [OVERRIDE_ENV]: join(base, "planning-content") };

    // Agreement passes, and passes on the CANONICAL comparison — an un-normalised spelling of the
    // same directory is the same directory.
    assert.equal(resolveProjectRoot({ env, expect: base }), realpathSync(base));
    assert.equal(resolveProjectRoot({ env, expect: join(base, ".", "") }), realpathSync(base));

    // ⚠️ A MISMATCH REFUSES RATHER THAN CHOOSING. Setup is handed one project root and resolves
    // another; picking either silently is how a command initialises one project and reports a
    // different one. Both paths and the rule that produced each go in the message.
    let err;
    try {
      resolveProjectRoot({ env, expect: other });
    } catch (e) {
      err = e;
    }
    assert.ok(err instanceof ContentRootError, "a disagreement must refuse");
    assert.match(err.message, new RegExp(escapeForRegExp(realpathSync(other))), "the supplied path must appear");
    assert.match(err.message, new RegExp(escapeForRegExp(realpathSync(base))), "the resolved path must appear");
    assert.match(err.message, /rule:/, "the rule that produced the resolved path must appear");
    assert.match(err.message, new RegExp(OVERRIDE_ENV), "the override must be named, since it is one of the two things to correct");
  } finally {
    rmSync(base, { recursive: true, force: true });
    rmSync(other, { recursive: true, force: true });
  }
});

test("the project root is canonical, so a symlinked route to it compares equal", () => {
  const base = consumerLayout();
  const linkBase = mkdtempSync(join(tmpdir(), "vpw-link-"));
  const link = join(linkBase, "via-symlink");
  try {
    try {
      symlinkSync(base, link, "junction");
    } catch {
      return; // symlink creation is privileged on some Windows configurations; skip rather than fail
    }
    const env = { [OVERRIDE_ENV]: join(link, "planning-content") };
    // ⚠️ CANONICAL, NOT LEXICAL. Two spellings of one directory must not read as a disagreement, or
    // the refusal above would fire on a correct setup invocation that happened to arrive by a link.
    assert.equal(resolveProjectRoot({ env, expect: base }), realpathSync(base));
  } finally {
    rmSync(linkBase, { recursive: true, force: true });
    rmSync(base, { recursive: true, force: true });
  }
});

function escapeForRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
