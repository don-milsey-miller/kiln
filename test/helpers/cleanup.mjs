/**
 * Remove a test's temporary directory, recording why Windows still holds it the first time it refuses — F11.
 *
 * ⚠️ **THE DIAGNOSTICS COME AT THE FIRST `EBUSY`, BEFORE ANY RETRY.** Earlier attempts took a slow process snapshot
 * first and asked who held the directory seconds later, by which time it had been let go. So on the first refusal,
 * in this order and each within a bound: `handle64` for the exact directory, a process inventory, and what is left
 * inside the directory. Then the removal is retried within the bound it always had (17 tries, 100 ms more each, at most
 * 15.3 s), kept by this module's own loop, and if the directory is still held the original error is thrown.
 *
 * ⚠️ **NO COMMAND LINES, NO ENVIRONMENT VALUES.** The inventory is pid, parent pid, name and start time. A diagnostic
 * that cannot run is recorded as unavailable, with the reason, never omitted.
 *
 * The record is appended to `F11_OUT` when set, and always printed as one `[f11]` line so a CI log carries it.
 */

import { spawnSync } from "node:child_process";
import { appendFileSync, readdirSync, rmSync } from "node:fs";
import { join, relative } from "node:path";

const HOLD_CODES = new Set(["EBUSY", "EPERM", "ENOTEMPTY"]);
const RETRIES = 17;
const RETRY_STEP_MS = 100;
const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/**
 * ⚠️ **THE BOUND IS KEPT BY THIS LOOP, NOT BY `rmSync`'s `maxRetries`.** Measured on Windows with Node 24.18: a directory
 * held as another process's working directory fails with EPERM at once, and `rmSync` with `maxRetries: 17` returned it
 * after 0 ms without retrying. So the same bound — 17 tries, 100 ms more before each, 15.3 s at most — is applied here.
 */
function removeWithinBound(dir) {
  let last = null;
  for (let i = 1; i <= RETRIES; i++) {
    pause(i * RETRY_STEP_MS);
    try {
      rmSync(dir, { recursive: true, force: true });
      return { removed: true, tries: i };
    } catch (e) {
      if (!HOLD_CODES.has(e.code)) throw e;
      last = e;
    }
  }
  return { removed: false, tries: RETRIES, code: last?.code ?? null };
}

function handles(dir) {
  const exe = process.env.HANDLE_EXE;
  if (!exe) return { available: false, reason: "HANDLE_EXE is not set on this host" };
  const r = spawnSync(exe, ["-accepteula", "-nobanner", dir], { encoding: "utf-8", timeout: 15_000 });
  if (r.error) return { available: false, reason: r.error.code ?? String(r.error.message) };
  return { available: true, status: r.status, output: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim().slice(0, 6000) };
}

function inventory() {
  if (process.platform !== "win32") {
    const r = spawnSync("ps", ["-A", "-o", "pid=,ppid=,lstart=,comm="], { encoding: "utf-8", timeout: 15_000 });
    if (r.error || r.status !== 0) return { available: false, reason: r.error?.code ?? `ps exited ${r.status}` };
    return { available: true, processes: r.stdout.trim().split("\n").slice(0, 2000) };
  }
  // Id, name and start time from Get-Process; the parent from Win32_Process, asked for that one property only.
  const script =
    "$p = @{}; Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId | ForEach-Object { $p[[int]$_.ProcessId] = [int]$_.ParentProcessId }; " +
    "Get-Process | ForEach-Object { try { $s = $_.StartTime.ToUniversalTime().ToString('o') } catch { $s = $null }; " +
    "[pscustomobject]@{ pid = $_.Id; ppid = $p[$_.Id]; name = $_.ProcessName; started = $s } } | ConvertTo-Json -Compress";
  const r = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf-8", timeout: 30_000 });
  if (r.error || r.status !== 0) return { available: false, reason: r.error?.code ?? `powershell exited ${r.status}` };
  try {
    return { available: true, processes: JSON.parse(r.stdout || "[]") };
  } catch {
    return { available: false, reason: "inventory-unparseable" };
  }
}

function remaining(dir) {
  const out = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (out.length >= 500) return;
      const p = join(d, e.name);
      out.push(relative(dir, p).split("\\").join("/") + (e.isDirectory() ? "/" : ""));
      if (e.isDirectory() && !e.isSymbolicLink()) walk(p);
    }
  };
  try {
    walk(dir);
    return { available: true, entries: out };
  } catch (e) {
    return { available: false, reason: e.code ?? String(e.message) };
  }
}

/**
 * @param {string} dir    the directory to remove
 * @param {string} label  which test's cleanup this is, for the record
 */
export function removeTestTree(dir, label) {
  try {
    rmSync(dir, { recursive: true, force: true });
    return;
  } catch (first) {
    if (!HOLD_CODES.has(first.code)) throw first;
    const t0 = Date.now();
    const record = {
      label,
      at: new Date(t0).toISOString(),
      error: { code: first.code, path: first.path },
      handles: handles(first.path ?? dir),
      remaining: remaining(dir),
      inventory: inventory(),
    };
    record.diagnosticsMs = Date.now() - t0;
    const retried = { ...removeWithinBound(dir), afterMs: null };
    retried.afterMs = Date.now() - t0;
    record.retry = retried;
    const line = JSON.stringify(record);
    if (process.env.F11_OUT) {
      try {
        appendFileSync(process.env.F11_OUT, line + "\n");
      } catch {
        /* the printed line still carries it */
      }
    }
    console.log(`[f11] ${line}`);
    if (!retried.removed) throw first;
  }
}
