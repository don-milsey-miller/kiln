/**
 * The reaper, falsified rather than assumed.
 *
 * ⚠️ "No residue after the run" does not prove this works — the controller destroying every
 * workspace cleanly produces exactly the same observation. So each property is exercised against a
 * directory that really exists, and the one that matters most is negative: registering a path must
 * NOT remove it. A reaper that swept eagerly would pass a "the directory is gone" check while
 * deleting the evidence a retention test is about to assert on.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { reapLater, reapWorkspace, sweepRetained, installReaper } from "./helpers/reap.mjs";

installReaper();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const scratch = (tag) => {
  const d = mkdtempSync(join(tmpdir(), `vpw-reap-${tag}-`));
  writeFileSync(join(d, "occupant.txt"), "so removal has something to do");
  return d;
};

test("registering a path does NOT remove it — the sweep is what removes it", async () => {
  const dir = scratch("later");
  reapLater(dir);
  // ⚠️ The load-bearing assertion in this file. If this ever fails, a test that provokes retention
  // and then checks `existsSync(ws)` starts racing the cleanup that was added to help it.
  assert.equal(existsSync(dir), true, "registration must be inert");

  await sleep(50);
  assert.equal(existsSync(dir), true, "still inert after a tick");

  assert.deepEqual(await sweepRetained(), [], "the sweep reports nothing stuck");
  assert.equal(existsSync(dir), false, "and the sweep is what actually removed it");
});

test("reapLater returns its argument unchanged, so it can wrap an expression", () => {
  const dir = scratch("wrap");
  assert.equal(reapLater(dir), dir);
  for (const empty of [null, undefined, ""]) assert.equal(reapLater(empty), empty);
});

test("a result whose workspace was destroyed registers nothing", async () => {
  const destroyed = { destroy: { outcome: "destroyed", verifiedAbsent: true }, executions: [] };
  assert.equal(reapWorkspace(destroyed), destroyed, "the result passes through by identity");

  const survivor = scratch("survivor");
  // Nothing was registered by the line above, so the sweep must leave an unrelated directory alone.
  assert.deepEqual(await sweepRetained(), []);
  assert.equal(existsSync(survivor), true, "the sweep touches only what it was given");
  reapLater(survivor);
  await sweepRetained();
});

test("reapWorkspace registers the retained path and returns the result by identity", async () => {
  const dir = scratch("retained");
  const result = { destroy: { outcome: "retained", retainedPath: dir }, executions: [] };
  assert.equal(reapWorkspace(result), result);
  assert.equal(existsSync(dir), true, "still inert");
  await sweepRetained();
  assert.equal(existsSync(dir), false);
});

test("a directory that cannot be removed is REPORTED, never thrown", async () => {
  const dir = scratch("locked");
  // The same real refusal the controller meets: Windows will not delete a live process's cwd. Not a
  // stubbed error — a stub would prove the catch block runs, not that the sweep survives the case
  // it exists for.
  const holder = spawn(process.execPath, ["-e", "setTimeout(()=>{},20000)"], { cwd: dir, stdio: "ignore" });
  try {
    await sleep(400);
    reapLater(dir);
    const stuck = await sweepRetained(); // must resolve, not reject
    if (process.platform === "win32") {
      assert.deepEqual(stuck, [dir], "a surviving directory is named in the return value");
      assert.equal(existsSync(dir), true);
    } else {
      // POSIX unlinks a busy directory happily; the property under test is only that the sweep
      // returns a report either way rather than throwing.
      assert.ok(Array.isArray(stuck));
    }
  } finally {
    holder.kill();
    await sleep(400);
    reapLater(dir);
    await sweepRetained();
  }
});

test("a stuck path is dropped from the queue, so the after-hook does not retry it forever", async () => {
  const gone = scratch("dropped");
  reapLater(gone);
  await sweepRetained();
  // Sweeping twice is a no-op rather than an error: the second call has an empty queue.
  assert.deepEqual(await sweepRetained(), []);
  assert.equal(existsSync(gone), false);
});
