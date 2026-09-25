/**
 * F11: the first refusal to remove a test's directory is diagnosed before any retry — test/helpers/cleanup.mjs.
 *
 * A process whose working directory is the directory holds it for six seconds, long enough for a slow inventory to list
 * it and well inside the 15.3 s bound. It holds it the way F11's hold behaves: the directory cannot be
 * removed while it runs and can be once it has gone. The record must carry the refusal, the remaining entries, a
 * process inventory that names the holder, and `handle64` or the reason it was unavailable; and the unchanged retry
 * must then remove the directory.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { removeTestTree } from "./helpers/cleanup.mjs";

test(
  "⚠️ F11 the first refusal records the holder, the remaining entries and handle64's answer or its absence, then the unchanged retry removes the directory",
  { skip: process.platform === "win32" ? false : "a working directory holds a directory against removal only on Windows" },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "kiln-f11-hold-"));
    const out = join(tmpdir(), `kiln-f11-out-${process.pid}.jsonl`);
    mkdirSync(join(dir, "inner"));
    writeFileSync(join(dir, "inner", "file.txt"), "x");
    const holder = spawn(process.execPath, ["-e", "setTimeout(() => {}, 6000)"], { cwd: dir, stdio: "ignore" });
    await new Promise((r) => setTimeout(r, 300));
    const saved = process.env.F11_OUT;
    process.env.F11_OUT = out;
    try {
      removeTestTree(dir, "cleanup-diagnostics");
      assert.equal(existsSync(dir), false, "the retry did not remove the directory");
      const record = JSON.parse(readFileSync(out, "utf-8").trim().split("\n").at(-1));
      assert.ok(["EBUSY", "EPERM", "ENOTEMPTY"].includes(record.error.code), JSON.stringify(record.error));
      assert.equal(record.remaining.available, true);
      assert.equal(record.inventory.available, true, JSON.stringify(record.inventory));
      const held = record.inventory.processes.find((p) => p.pid === holder.pid);
      assert.ok(held, `the inventory does not name the holder ${holder.pid}`);
      assert.equal(held.ppid, process.pid, "with its parent");
      assert.ok(!JSON.stringify(record.inventory).includes("setTimeout"), "the inventory carries no command line");
      if (process.env.HANDLE_EXE) assert.equal(record.handles.available, true, JSON.stringify(record.handles));
      else assert.deepEqual(record.handles, { available: false, reason: "HANDLE_EXE is not set on this host" });
      assert.equal(record.retry.removed, true);
    } finally {
      if (saved === undefined) delete process.env.F11_OUT;
      else process.env.F11_OUT = saved;
      holder.kill();
      rmSync(out, { force: true });
      rmSync(dir, { recursive: true, force: true, maxRetries: 17, retryDelay: 100 });
    }
  }
);
