/**
 * Remove a test's temporary directory, recording why Windows still holds it the first time it refuses — F11.
 *
 * ⚠️ **THE DIAGNOSTICS COME AT THE FIRST `EBUSY`, BEFORE ANY RETRY.** Earlier attempts took a slow process snapshot
 * first and asked who held the directory seconds later, by which time it had been let go. So on the first refusal,
 * in this order and each within a bound: `handle64` for the exact directory, a process inventory, and what is left
 * inside the directory, each with its own start and duration. Then the removal is retried within the bound it always
 * had (17 tries, 100 ms more each, at most 15.3 s), kept by this module's own loop, and if the directory is still
 * held the original error is thrown. The record gives the diagnostics' total (`diagnosticsMs`) and the retry loop's
 * own start and duration (`retry.startMs`, `retry.ms`) separately.
 *
 * ⚠️ **NO COMMAND LINES, NO ENVIRONMENT VALUES.** The inventory is pid, parent pid, creation time and image name. A
 * diagnostic that cannot run is recorded as unavailable, with the reason, never omitted.
 *
 * The record is appended to `F11_OUT` when set, and always printed as one `[f11]` line so a CI log carries it.
 */

import { spawnSync } from "node:child_process";
import { appendFileSync, readdirSync, rmSync } from "node:fs";
import { join, relative } from "node:path";

import { PROCESS_TABLE_COMMAND } from "../../lib/supervisor.mjs";

/** The supervisor's own WMI-free process-table script: pid, parent pid and creation time. */
const WINDOWS_PROCESS_TABLE = PROCESS_TABLE_COMMAND.win32[1][3];

const HOLD_CODES = new Set(["EBUSY", "EPERM", "ENOTEMPTY"]);
const RETRIES = 17;
const RETRY_STEP_MS = 100;
const LINE_BREAK = /\r?\n/;
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

/**
 * Every process: pid, parent pid and creation time from the supervisor's own process table, which is read without WMI,
 * and each image name from `tasklist`. No command lines and no environment values are read.
 */
function inventory() {
  if (process.platform !== "win32") {
    const r = spawnSync("ps", ["-A", "-o", "pid=,ppid=,lstart=,comm="], { encoding: "utf-8", timeout: 15_000 });
    if (r.error || r.status !== 0) return { available: false, reason: r.error?.code ?? `ps exited ${r.status}` };
    return { available: true, processes: r.stdout.trim().split(LINE_BREAK).slice(0, 2000) };
  }
  const table = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_PROCESS_TABLE], { encoding: "utf-8", timeout: 15_000 });
  if (table.error || table.status !== 0) return { available: false, reason: table.error?.code ?? `process table exited ${table.status}` };
  const names = new Map();
  const tl = spawnSync("tasklist", ["/fo", "csv", "/nh"], { encoding: "utf-8", timeout: 15_000 });
  if (!tl.error && tl.status === 0)
    for (const line of tl.stdout.split(LINE_BREAK)) {
      const m = line.match(/^"([^"]*)","(\d+)"/);
      if (m) names.set(Number(m[2]), m[1]);
    }
  const processes = [];
  for (const line of table.stdout.split(LINE_BREAK)) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)$/);
    if (m) processes.push({ pid: Number(m[1]), ppid: Number(m[2]), created: m[3] === "-" ? null : m[3], name: names.get(Number(m[1])) ?? null });
  }
  return { available: true, names: names.size > 0, processes };
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
    };
    const timed = (name, fn) => {
      const at = Date.now();
      record[name] = fn();
      record[name].startMs = at - t0;
      record[name].ms = Date.now() - at;
    };
    // handle64 first: it is the one that can name the holder of the exact path. Asked with `dir`, not the error's path: on
    // Node 24 that carries the `\\?\` prefix, which handle64 matches against nothing (CI run 36160238262).
    timed("handles", () => handles(dir));
    timed("inventory", () => inventory());
    timed("remaining", () => remaining(dir));
    record.diagnosticsMs = Date.now() - t0;
    // The retry loop's own duration is reported apart from the diagnostics' so a hold's length is not read off their sum.
    const retryAt = Date.now();
    const retried = removeWithinBound(dir);
    retried.startMs = retryAt - t0;
    retried.ms = Date.now() - retryAt;
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
