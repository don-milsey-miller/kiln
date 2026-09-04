/**
 * Dependency freshness — CMP-0020, the install half of ACC-0033.
 *
 * ⚠️ **THE CONDITION THIS TESTS WAS WRONG FOR A MONTH AND NOTHING COULD SEE IT.** It compared the
 * lockfile's mtime to the `node_modules` DIRECTORY mtime. A directory's mtime moves only when an
 * entry is added or removed at its top level, which reinstalling the same tree does not do — while
 * `npm install` touches the lockfile every time. One install therefore made the condition
 * permanently true, and the documented one-command launcher reinstalled on every start: two minutes
 * a run, on a checkout with nothing to do. It surfaced only when a second real launch was added to
 * the launcher suite and timed out waiting for readiness.
 *
 * ⚠️ **SO THE DECISION IS A FUNCTION OVER A DIRECTORY NOW.** Proving the warm branch through the
 * launcher costs a production build; proving the stale branch costs a real `npm install`. Here each
 * is a few files in a temp folder, which is the difference between a check that runs on every commit
 * and one that runs when somebody remembers.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { INSTALLED_MARKER, dependencyState } from "../lib/dependency-freshness.mjs";

const scratch = () => mkdtempSync(join(tmpdir(), "kiln-deps-"));
const at = (path, secondsAgo) => utimesSync(path, new Date(), new Date(Date.now() - secondsAgo * 1000));

/** A checkout, with whichever of the three artefacts the case needs. */
function checkout({ modules = true, lock = true, marker = true, lockNewer = false } = {}) {
  const dir = scratch();
  if (lock) writeFileSync(join(dir, "package-lock.json"), "{}\n");
  if (modules) mkdirSync(join(dir, "node_modules"), { recursive: true });
  if (modules && marker) writeFileSync(join(dir, "node_modules", INSTALLED_MARKER), "{}\n");

  if (lock && modules && marker) {
    // ⚠️ EXPLICIT TIMES: two files written in the same millisecond are not a test of an ordering.
    at(join(dir, "node_modules", INSTALLED_MARKER), lockNewer ? 60 : 10);
    at(join(dir, "package-lock.json"), lockNewer ? 10 : 60);
  }
  return dir;
}

test("a cold checkout installs", () => {
  const dir = checkout({ modules: false });
  try {
    assert.deepEqual(dependencyState(dir), { install: true, why: "no node_modules" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("⚠️ a warm checkout whose lockfile is not newer than npm's marker skips the install", () => {
  // ⚠️ THE BRANCH THAT WAS BROKEN. Against the directory mtime this returned `install: true`
  // forever, because `npm install` touches the lockfile and never the directory.
  const dir = checkout({ lockNewer: false });
  try {
    const state = dependencyState(dir);
    assert.equal(state.install, false, "a matching tree must not be reinstalled");
    assert.match(state.why, /matches the lockfile/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a lockfile newer than the installed tree installs", () => {
  const dir = checkout({ lockNewer: true });
  try {
    assert.deepEqual(dependencyState(dir), { install: true, why: "the lockfile is newer than the installed tree" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("⚠️ a tree npm did not lay down is installed rather than guessed about", () => {
  // ⚠️ NO MARKER MEANS NOBODY CAN VOUCH FOR WHAT IS THERE — a hand-copied `node_modules`, an
  // interrupted install. The cost of a needless install is minutes; the cost of skipping a needed
  // one is a start that fails for a reason nothing prints.
  const dir = checkout({ marker: false });
  try {
    assert.deepEqual(dependencyState(dir), { install: true, why: `no ${INSTALLED_MARKER}` });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a tree npm laid down, with no lockfile to be newer than it, is left alone", () => {
  const dir = checkout({ lock: false });
  try {
    assert.equal(dependencyState(dir).install, false, "nothing says a marked tree is stale");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("⚠️ no lockfile AND no marker still installs — the order of the two checks decides this", () => {
  // ⚠️ WITH THE LOCKFILE ASKED ABOUT FIRST, a checkout holding nothing but an empty `node_modules`
  // fell through "nothing to be newer than" and was declared usable — the one case where there is
  // least reason to believe it. Whether npm laid the tree down is a question about the TREE; whether
  // it is current is a question about the lockfile, and the second only matters once the first has
  // an answer.
  const dir = checkout({ lock: false, marker: false });
  try {
    assert.deepEqual(dependencyState(dir), { install: true, why: `no ${INSTALLED_MARKER}` });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("⚠️ the directory mtime is NOT what is compared, and this is the regression", () => {
  // A tree whose directory is old and whose marker is current: reinstalling never touches the
  // directory, so this is the ordinary state of every checkout after its first install.
  const dir = checkout({ lockNewer: false });
  try {
    at(join(dir, "node_modules"), 86_400); // a day old, as a real one is
    assert.equal(dependencyState(dir).install, false, "an old directory is not a stale install");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
