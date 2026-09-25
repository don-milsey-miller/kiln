/**
 * F11: the first refusal to remove a test's directory is diagnosed before any retry — test/helpers/cleanup.mjs.
 *
 * A process whose working directory is the directory holds it the way F11's hold behaves: the directory cannot be
 * removed while that process runs, and can be once it has gone.
 *
 * ⚠️ **TWO CASES, BECAUSE THE DIAGNOSTICS AND THE BOUND ARE SEPARATE CLAIMS.** A holder that outlives the whole bound
 * must be named in the record, with `handle64`'s answer or the reason it was unavailable, and the original error
 * must be thrown when the 15.3 s bound runs out. A holder that goes early must leave the directory removed by the
 * same bound.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { removeTestTree } from "./helpers/cleanup.mjs";

const windowsOnly = { skip: process.platform === "win32" ? false : "a working directory holds a directory against removal only on Windows" };

/** A directory with some content, held as a child's working directory for `holdMs`. */
async function held(holdMs) {
  const dir = mkdtempSync(join(tmpdir(), "kiln-f11-hold-"));
  mkdirSync(join(dir, "inner"));
  writeFileSync(join(dir, "inner", "file.txt"), "x");
  const holder = spawn(process.execPath, ["-e", `setTimeout(() => {}, ${holdMs})`], { cwd: dir, stdio: "ignore" });
  await new Promise((r) => setTimeout(r, 300));
  return { dir, holder };
}

/** Run `removeTestTree` with `F11_OUT` pointed at a fresh file; return what it threw and the record it wrote. */
function removeRecorded(dir) {
  const out = join(tmpdir(), `kiln-f11-out-${process.pid}-${Date.now()}.jsonl`);
  const saved = process.env.F11_OUT;
  process.env.F11_OUT = out;
  let thrown = null;
  try {
    removeTestTree(dir, "cleanup-diagnostics");
  } catch (e) {
    thrown = e;
  } finally {
    if (saved === undefined) delete process.env.F11_OUT;
    else process.env.F11_OUT = saved;
  }
  const record = existsSync(out) ? JSON.parse(readFileSync(out, "utf-8").trim().split("\n").at(-1)) : null;
  rmSync(out, { force: true });
  return { thrown, record };
}

test("⚠️ F11 a holder that outlasts the bound is named in the first refusal's record, and the original error is thrown", windowsOnly, async () => {
  const { dir, holder } = await held(60_000);
  try {
    const { thrown, record } = removeRecorded(dir);
    console.log(`[f11 test] handles ${JSON.stringify(record?.handles)} diagnostics ${record?.diagnosticsMs} ms, retry ${record?.retry?.ms} ms`);
    assert.ok(record, "no record was written");
    assert.ok(["EBUSY", "EPERM", "ENOTEMPTY"].includes(record.error.code), JSON.stringify(record.error));
    assert.ok(thrown && thrown.code === record.error.code, "the original error was not thrown");
    // ⚠️ AN INVENTORY THAT RAN OUT OF TIME IS RECORDED AS UNAVAILABLE, WITH ITS REASON — which is the rule, not a failure.
    // A loaded Windows runner timed the process table out at 15 s (CI run 36171409254) while handle64 named the holder.
    // What is required is that the holder is named by at least one diagnostic, and that nothing is silently absent.
    if (record.inventory.available) {
      const named = record.inventory.processes.find((p) => p.pid === holder.pid);
      assert.ok(named, `the inventory does not name the holder ${holder.pid}`);
      assert.equal(named.ppid, process.pid, "with its parent");
      assert.ok(!JSON.stringify(record.inventory).includes("setTimeout"), "the inventory carries no command line");
    } else assert.ok(record.inventory.reason, `an unavailable inventory without a reason: ${JSON.stringify(record.inventory)}`);
    const holderPid = new RegExp(`\\bpid: ${holder.pid}\\b`);
    assert.ok(
      record.inventory.processes?.some((p) => p.pid === holder.pid) || holderPid.test(record.handles.output ?? ""),
      `no diagnostic names the holder ${holder.pid}: ${JSON.stringify({ handles: record.handles, inventory: record.inventory.available })}`
    );
    assert.deepEqual(record.remaining.entries, ["inner/", "inner/file.txt"]);
    // handle64's answer is recorded whatever it is; its absence is recorded with the reason.
    if (process.env.HANDLE_EXE) assert.equal(record.handles.available, true, JSON.stringify(record.handles));
    else assert.equal(record.handles.reason, "HANDLE_EXE is not set on this host");
    for (const d of ["handles", "inventory", "remaining"]) assert.equal(typeof record[d].ms, "number", `${d} was not timed`);
    assert.equal(record.retry.removed, false);
    assert.equal(record.retry.tries, 17, "the whole bound was used");
    assert.equal(typeof record.diagnosticsMs, "number", "the diagnostics were not timed as a whole");
    assert.ok(record.retry.startMs >= record.diagnosticsMs, "the retry began before the diagnostics ended");
    assert.ok(record.retry.ms >= 15_300, `the bound was cut short: ${JSON.stringify(record.retry)}`);
  } finally {
    holder.kill();
    await new Promise((r) => setTimeout(r, 300));
    rmSync(dir, { recursive: true, force: true });
  }
});

test("⚠️ F11 a holder that goes within the bound leaves the directory removed by it", windowsOnly, async () => {
  const { dir, holder } = await held(3000);
  try {
    const { thrown, record } = removeRecorded(dir);
    assert.equal(thrown, null, `the directory was not removed: ${JSON.stringify(record?.retry)}`);
    assert.ok(record, "the refusal was not recorded");
    assert.equal(record.retry.removed, true);
    assert.equal(existsSync(dir), false);
  } finally {
    holder.kill();
    rmSync(dir, { recursive: true, force: true });
  }
});
