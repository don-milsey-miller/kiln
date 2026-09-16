/**
 * F119 attribution: where a Windows process-table query's time actually goes (test-only).
 *
 * CI has shown the same shape three times: the FIRST query of a Windows evidence run takes 3.3 to 8.4
 * seconds, or exceeds the 10 second timeout entirely, while every later query in the same run answers in
 * about half a second. One number per query cannot say whether that time goes on starting a process, on
 * waiting for the WMI provider, or on reading the answer, so each phase is recorded separately.
 *
 * ⚠️ **IT DECIDES NOTHING.** `psRun` runs the command the supervisor hands it, with the production timeout,
 * and returns exactly the shape the production reader returns. The Toolhelp probe's output is recorded and
 * is never returned to the supervisor, never merged with a tracked identity, and never reaches a signal.
 *
 * ⚠️ **IT IS NOT A ROUTE PROPOSAL.** Toolhelp32 creation times keep 100ns precision where WMI truncates to
 * microseconds, so the two identity formats are incompatible. What is recorded here is the measurement of
 * that incompatibility, not a step towards adopting it.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { PROCESS_TABLE_COMMAND, PROCESS_TABLE_TIMEOUT_MS, parseProcessTable } from "../../../lib/supervisor.mjs";

/** The C# the probe compiles: Toolhelp32 for pid and parent, GetProcessTimes for the creation FILETIME. */
const TOOLHELP_SOURCE = `
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class KilnToolhelp {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct ENTRY {
    public uint dwSize; public uint cntUsage; public uint th32ProcessID; public IntPtr th32DefaultHeapID;
    public uint th32ModuleID; public uint cntThreads; public uint th32ParentProcessID; public int pcPriClassBase;
    public uint dwFlags; [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string szExeFile;
  }
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr CreateToolhelp32Snapshot(uint f, uint p);
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern bool Process32FirstW(IntPtr s, ref ENTRY e);
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern bool Process32NextW(IntPtr s, ref ENTRY e);
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint a, bool i, uint p);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetProcessTimes(IntPtr h, out long c, out long x, out long k, out long u);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool CloseHandle(IntPtr h);
  public static int Main() {
    var sb = new StringBuilder();
    IntPtr snap = CreateToolhelp32Snapshot(0x2, 0);
    if (snap == new IntPtr(-1)) { Console.Error.WriteLine("snapshot-failed"); return 1; }
    try {
      var e = new ENTRY(); e.dwSize = (uint)Marshal.SizeOf(typeof(ENTRY));
      if (!Process32FirstW(snap, ref e)) { Console.Error.WriteLine("first-failed"); return 1; }
      do {
        string created = "-";
        IntPtr h = OpenProcess(0x1000, false, e.th32ProcessID);
        if (h != IntPtr.Zero) {
          long c, x, k, u;
          if (GetProcessTimes(h, out c, out x, out k, out u) && c > 0) created = c.ToString();
          CloseHandle(h);
        }
        sb.Append(e.th32ProcessID).Append(' ').Append(e.th32ParentProcessID).Append(' ').Append(created).Append('\\n');
      } while (Process32NextW(snap, ref e));
    } finally { CloseHandle(snap); }
    Console.Out.Write(sb.ToString());
    return 0;
  }
}`;

/** The compiler that ships with .NET Framework, which is present on Windows and on the runners. */
export const CSC_PATH = join(process.env.WINDIR ?? "C:\\Windows", "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe");

/**
 * Compile the probe once, before any query is timed.
 *
 * ⚠️ **A COMPILER THAT IS NOT THERE IS RECORDED, NEVER PASSED OVER IN SILENCE.** A run with no probe has to
 * say so, or its missing measurements read as a probe that looked and found nothing.
 */
export function compileToolhelp(dir, { platform = process.platform, csc = CSC_PATH, run = spawnSync } = {}) {
  if (platform !== "win32") return { available: false, reason: "not-windows" };
  if (!existsSync(csc)) return { available: false, reason: "csc-not-found", csc };
  const started = performance.now();
  try {
    mkdirSync(dir, { recursive: true });
    const source = join(dir, "KilnToolhelp.cs");
    const exe = join(dir, "kiln-toolhelp.exe");
    writeFileSync(source, TOOLHELP_SOURCE, "utf-8");
    const out = run(csc, ["/nologo", "/optimize+", `/out:${exe}`, source], { encoding: "utf-8", timeout: 60_000 });
    const compileMs = Math.round((performance.now() - started) * 10) / 10;
    if (out?.status !== 0 || !existsSync(exe))
      return {
        available: false,
        reason: "compile-failed",
        status: out?.status ?? null,
        stderr: String(out?.stderr || out?.stdout || "").trim().slice(0, 200),
        compileMs,
      };
    return { available: true, exe, compileMs };
  } catch (e) {
    return { available: false, reason: "compile-threw", error: e?.code ?? e?.name ?? "unknown", compileMs: Math.round((performance.now() - started) * 10) / 10 };
  }
}

/**
 * A process-table reader that records each phase of every query it runs.
 *
 * @param {object} options
 * @param {string} options.dir              where the probe is compiled
 * @param {() => number[]} [options.owned]  the pids this run owns, for the identity comparison
 * @param {number} [options.probeFirst]     how many of the first queries the probe runs beside
 */
export function createQueryDiagnostic({
  platform = process.platform,
  dir,
  owned = () => [],
  probeFirst = 2,
  spawnImpl = spawn,
  compile = compileToolhelp,
  timeoutMs = PROCESS_TABLE_TIMEOUT_MS,
} = {}) {
  const origin = performance.now();
  const at = () => Math.round((performance.now() - origin) * 10) / 10;
  const queries = [];
  const probes = [];
  // Compiled before the first query, so no query pays for it.
  const toolhelp = compile(dir, { platform });

  /** Run one command, recording when it was asked for, started, first spoke, and finished. */
  const runRecorded = (cmd, args, record) =>
    new Promise((resolve) => {
      record.spawnRequestedMs = at();
      let settled = false;
      let stdout = "";
      let stderr = "";
      let child;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      };
      // The production timeout, unchanged: the query is killed and reported the way execFile reports it,
      // so every classification downstream stays exactly what it was.
      const timer = setTimeout(() => {
        record.timedOutMs = at();
        record.outcome = "timeout";
        try {
          child?.kill("SIGTERM");
        } catch {
          /* a child that has already gone needs no signal */
        }
        finish({ status: 1, stdout: "", error: Object.assign(new Error("process-table-timeout"), { killed: true, signal: "SIGTERM", code: null }) });
      }, timeoutMs);

      try {
        child = spawnImpl(cmd, args, { windowsHide: true });
      } catch (e) {
        record.outcome = "spawn-threw";
        record.error = e?.code ?? e?.name ?? "unknown";
        finish({ status: 1, stdout: "", error: e });
        return;
      }
      child.once("spawn", () => (record.childCreatedMs = at()));
      child.stdout?.on("data", (d) => {
        record.firstStdoutMs ??= at();
        stdout += d;
      });
      child.stderr?.on("data", (d) => {
        record.firstStderrMs ??= at();
        stderr += d;
      });
      child.once("error", (e) => {
        record.outcome ??= "spawn-error";
        record.error = e?.code ?? e?.name ?? "unknown";
        finish({ status: 1, stdout: "", error: e });
      });
      child.once("close", (code) => {
        record.exitedMs = at();
        record.exitCode = code;
        record.stdoutBytes = stdout.length;
        record.stderrBytes = stderr.length;
        record.outcome ??= code === 0 ? "exit" : "non-zero-exit";
        record.rows = code === 0 ? parseProcessTable(stdout).size : 0;
        finish(code === 0 ? { status: 0, stdout } : { status: code ?? 1, stdout: "", error: Object.assign(new Error("exit"), { code }) });
      });
    });

  const blank = (id, extra) => ({
    id,
    spawnRequestedMs: null,
    childCreatedMs: null,
    firstStdoutMs: null,
    firstStderrMs: null,
    exitedMs: null,
    timedOutMs: null,
    exitCode: null,
    outcome: null,
    rows: null,
    stdoutBytes: null,
    stderrBytes: null,
    error: null,
    ...extra,
  });

  /** The probe, run beside a query, reading nothing the supervisor will act on. */
  const probeBeside = (queryId) => {
    if (!toolhelp.available) return;
    const record = blank(`probe-${probes.length + 1}`, { beside: queryId });
    probes.push(record);
    runRecorded(toolhelp.exe, [], record).then(
      (out) => (record.table = out.status === 0 ? parseProcessTable(out.stdout) : null),
      () => (record.table = null)
    );
  };

  return {
    /** Exactly the seam the supervisor injects: its command, the production timeout, the same returned shape. */
    psRun: (cmd, args) => {
      const record = blank(`q${queries.length + 1}`, { command: cmd });
      queries.push(record);
      if (queries.length <= probeFirst) probeBeside(record.id);
      return runRecorded(cmd, args, record);
    },

    /** What the supervisor would run, so a caller can hand the production command straight back to `psRun`. */
    command: () => PROCESS_TABLE_COMMAND[platform === "win32" ? "win32" : "posix"],

    /**
     * Every query's phases, the probe's, and what the probe saw of THIS run's own processes.
     *
     * The comparison is limited to pids this run owns: they are the only ones a shutdown would ever signal,
     * and the only ones whose creation time either route is sure to be allowed to read.
     */
    snapshot: () => ({
      toolhelp: toolhelp.available ? { available: true, compileMs: toolhelp.compileMs } : { available: false, ...toolhelp },
      queries: queries.map(({ table, ...q }) => q),
      probes: probes.map(({ table, ...p }) => p),
      ownedByProbe: probes
        .filter((p) => p.table)
        .map((p) => ({
          probe: p.id,
          owned: owned()
            .filter((pid) => Number.isInteger(pid) && pid > 0)
            .map((pid) => {
              const row = p.table.get(pid);
              return { pid, found: Boolean(row), ppid: row?.ppid ?? null, created: row?.created ?? null };
            }),
        })),
    }),
  };
}
