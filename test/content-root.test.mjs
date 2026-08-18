import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  toolRoot,
  resolveContentRoot,
  resolveInContentRoot,
  isInsideContentRoot,
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
