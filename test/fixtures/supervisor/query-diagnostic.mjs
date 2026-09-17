/**
 * F119 attribution: where a Windows process-table query's time actually goes (test-only).
 *
 * CI run 35055338147 settled it. The first Windows query of a run spent 7,114ms between its child starting
 * and that child's first byte, while the child itself started in 13ms and every later query answered in
 * about 300ms; both trees' first queries unblocked in the same millisecond though they began 450ms apart.
 * The cost was one shared first use of the WMI provider, which the launch now primes before spawning
 * anything (O14).
 *
 * ⚠️ **IT DECIDES NOTHING.** `psRun` runs the command the supervisor hands it, with the production timeout,
 * and returns exactly the shape the production reader returns. It only records what each phase cost.
 *
 * ⚠️ **O6 (F130): EVERY PHASE A STALL COULD HIDE IN.** A WMI-free read stalled to its full bound five times in a row
 * on windows-latest node 24 in CI run 35250274939, and nothing recorded where that time went. Each query now
 * records, on one monotonic clock: request, child created, first stdout and stderr byte, exit, timeout, kill
 * request and close, with the child's pid, its exit code or signal, and byte counts. It keeps NO output: not
 * stdout, not stderr, not a row, a path or an environment value. The spawn matches the production reader's:
 * the same pinned locale and no hidden window, so the process being timed is the one production starts.
 *
 * ⚠️ **THE TOOLHELP PROBE THAT ISOLATED THE PROVIDER IS GONE, AND SO IS ITS COMPILER.** It did its work:
 * while a CIM query waited seven seconds, a WMI-free enumeration of the same machine finished in 68ms, which
 * is what ruled out load and process creation. Run 35055338147 holds that evidence, so the suite no longer
 * carries a C# compile to re-prove a settled point.
 */
import { spawn } from "node:child_process";

import { PROCESS_TABLE_COMMAND, PROCESS_TABLE_TIMEOUT_MS, parseProcessTable } from "../../../lib/supervisor.mjs";

/**
 * A process-table reader that records each phase of every query it runs.
 *
 * @param {object} options
 * @param {string} [options.platform]  which command the supervisor would choose
 * @param {number} [options.timeoutMs] the production bound, never raised for the diagnostic
 */
/**
 * A8 (F130): what a stalled read was doing, isolated into three PowerShell runs.
 *
 * ⚠️ **THEY RUN ONLY AFTER A REAL TIMEOUT, ONE AFTER ANOTHER, AND DECIDE NOTHING.** CI run 35253655887 showed a
 * read whose child existed after 7ms and then wrote nothing for the whole bound. These three separate the parts
 * that silence could be hiding: starting PowerShell at all, defining the native call in memory, and the query
 * itself. Each writes a marker as it passes a phase, so the timings come from the child rather than from a
 * guess, and each has its own short diagnostic bound so a probe cannot outlast the test it explains.
 *
 * ⚠️ **NO TABLE COMES BACK FROM THEM.** The full probe reports how many rows it walked, never a row, and the
 * others report nothing but their markers.
 */
const COMPANION_STEPS = {
  emit: [
    "$m = [Runtime.InteropServices.Marshal]",
    "$b = [AppDomain]::CurrentDomain.DefineDynamicAssembly((New-Object Reflection.AssemblyName 'KilnProbe'), 'Run')",
    "$t = $b.DefineDynamicModule('KilnProbe').DefineType('KilnProbeNt', 'Public,Class')",
    "$q = $t.DefinePInvokeMethod('NtQuerySystemInformation', 'ntdll.dll', 'Public,Static,PinvokeImpl', 'Standard', [int], [Type[]]@([int], [IntPtr], [int], [int].MakeByRefType()), 'Winapi', 'Auto')",
    "$q.SetImplementationFlags('PreserveSig')",
    "$nt = $t.CreateType()",
  ],
  query: [
    "$size = 65536",
    "$buf = [IntPtr]::Zero",
    "for ($try = 0; $try -lt 12; $try++) {",
    "  $buf = $m::AllocHGlobal($size)",
    "  $need = 0",
    "  $status = $nt::NtQuerySystemInformation(5, $buf, $size, [ref]$need)",
    "  if ($status -eq 0) { break }",
    "  $m::FreeHGlobal($buf)",
    "  $buf = [IntPtr]::Zero",
    "  if ($status -ne -1073741820) { break }",
    "  $size = [Math]::Max($need, $size) * 2",
    "}",
    "$rows = 0",
    "if ($buf -ne [IntPtr]::Zero) {",
    "  $at = 0",
    "  while ($true) {",
    "    $rows = $rows + 1",
    "    $next = $m::ReadInt32([IntPtr]::Add($buf, $at), 0)",
    "    if ($next -eq 0) { break }",
    "    $at += $next",
    "  }",
    "  $m::FreeHGlobal($buf)",
    "}",
  ],
};
const mark = (name) => `[Console]::Out.Write('m:${name}' + [char]10); [Console]::Out.Flush()`;
/** The three probes, each a superset of the one before it, so a phase's cost is the difference. */
const COMPANIONS = {
  "powershell-start": [mark("entry"), mark("done")],
  "native-call-defined": [mark("entry"), ...COMPANION_STEPS.emit, mark("defined"), mark("done")],
  "query-run": [
    mark("entry"),
    ...COMPANION_STEPS.emit,
    mark("defined"),
    mark("beforeQuery"),
    ...COMPANION_STEPS.query,
    mark("afterQuery"),
    "[Console]::Out.Write('rows:' + $rows + [char]10)",
    mark("done"),
  ],
};

/** A companion probe may not outlast the test it explains. */
export const COMPANION_TIMEOUT_MS = 5000;
/** How long a record waits for a killed child to close before it is printed (A7). */
export const CLOSE_WAIT_MS = 3000;

export function createQueryDiagnostic({ platform = process.platform, spawnImpl = spawn, timeoutMs = PROCESS_TABLE_TIMEOUT_MS } = {}) {
  const origin = performance.now();
  const at = () => Math.round((performance.now() - origin) * 10) / 10;
  const queries = [];
  const companions = [];

  /** Run one command, recording when it was asked for, started, first spoke, and finished. */
  const runRecorded = (cmd, args, record) =>
    new Promise((resolve) => {
      record.spawnRequestedMs = at();
      let settled = false;
      // Only what the returned shape needs; nothing of it is kept in the record.
      const stdoutChunks = [];
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
        record.killRequestedMs = at();
        try {
          record.killSent = child ? child.kill("SIGTERM") : false;
        } catch {
          /* a child that has already gone needs no signal */
          record.killSent = false;
        }
        finish({ status: 1, stdout: "", error: Object.assign(new Error("process-table-timeout"), { killed: true, signal: "SIGTERM", code: null }) });
      }, timeoutMs);

      try {
        // As the production reader spawns it: the pinned locale, and no hidden window.
        child = spawnImpl(cmd, args, { env: { ...process.env, LC_ALL: "C" } });
      } catch (e) {
        record.outcome = "spawn-threw";
        record.error = e?.code ?? e?.name ?? "unknown";
        finish({ status: 1, stdout: "", error: e });
        return;
      }
      record.pid = typeof child.pid === "number" ? child.pid : null;
      child.once("spawn", () => {
        record.childCreatedMs = at();
        record.pid ??= typeof child.pid === "number" ? child.pid : null;
      });
      child.stdout?.on("data", (d) => {
        record.firstStdoutMs ??= at();
        record.stdoutBytes += Buffer.byteLength(d);
        stdoutChunks.push(Buffer.from(d));
      });
      child.stderr?.on("data", (d) => {
        record.firstStderrMs ??= at();
        record.stderrBytes += Buffer.byteLength(d);
      });
      child.once("exit", (code, signal) => {
        record.exitMs = at();
        record.exitCode = code;
        record.signal = signal ?? null;
      });
      child.once("error", (e) => {
        record.outcome ??= "spawn-error";
        record.error = e?.code ?? e?.name ?? "unknown";
        finish({ status: 1, stdout: "", error: e });
      });
      child.once("close", (code, signal) => {
        record.closeMs = at();
        record.exitCode ??= code;
        record.signal ??= signal ?? null;
        // A close after the timeout already answered is recorded, and changes nothing that was returned.
        if (settled) return;
        record.exitedMs = record.closeMs;
        record.outcome ??= code === 0 ? "exit" : "non-zero-exit";
        const stdout = Buffer.concat(stdoutChunks).toString("utf-8");
        record.rows = code === 0 ? parseProcessTable(stdout).size : 0;
        finish(code === 0 ? { status: 0, stdout } : { status: code ?? 1, stdout: "", error: Object.assign(new Error("exit"), { code }) });
      });
    });

  const blank = (id, extra) => ({
    id,
    pid: null,
    spawnRequestedMs: null,
    childCreatedMs: null,
    firstStdoutMs: null,
    firstStderrMs: null,
    exitMs: null,
    exitedMs: null,
    timedOutMs: null,
    killRequestedMs: null,
    killSent: null,
    closeMs: null,
    exitCode: null,
    signal: null,
    outcome: null,
    rows: null,
    stdoutBytes: 0,
    stderrBytes: 0,
    error: null,
    ...extra,
  });

  /** Run one companion to its own short bound, timestamping each marker its child writes. */
  const runCompanion = (name, script, timeoutMs) =>
    new Promise((resolve) => {
      const record = blank(name, { markers: {}, rows: null });
      companions.push(record);
      record.spawnRequestedMs = at();
      let child;
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        record.timedOutMs = at();
        record.outcome = "timeout";
        record.killRequestedMs = at();
        try {
          record.killSent = child ? child.kill("SIGTERM") : false;
        } catch {
          record.killSent = false;
        }
        finish();
      }, timeoutMs);

      try {
        child = spawnImpl("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], { env: { ...process.env, LC_ALL: "C" } });
      } catch (e) {
        record.outcome = "spawn-threw";
        record.error = e?.code ?? e?.name ?? "unknown";
        finish();
        return;
      }
      record.pid = typeof child.pid === "number" ? child.pid : null;
      child.once("spawn", () => (record.childCreatedMs = at()));
      let pending = "";
      child.stdout?.on("data", (d) => {
        record.firstStdoutMs ??= at();
        record.stdoutBytes += Buffer.byteLength(d);
        // ⚠️ MARKERS AND A ROW COUNT ONLY: no line of a process table is kept, or even looked at.
        pending += d;
        for (const line of pending.split(String.fromCharCode(10))) {
          if (line.startsWith("m:")) record.markers[line.slice(2)] ??= at();
          else if (line.startsWith("rows:")) record.rows = Number(line.slice(5)) || record.rows;
        }
        pending = pending.slice(pending.lastIndexOf(String.fromCharCode(10)) + 1);
      });
      child.stderr?.on("data", (d) => {
        record.firstStderrMs ??= at();
        record.stderrBytes += Buffer.byteLength(d);
      });
      child.once("error", (e) => {
        record.outcome ??= "spawn-error";
        record.error = e?.code ?? e?.name ?? "unknown";
        finish();
      });
      child.once("exit", (code, signal) => {
        record.exitMs = at();
        record.exitCode = code;
        record.signal = signal ?? null;
      });
      child.once("close", (code, signal) => {
        record.closeMs = at();
        record.exitCode ??= code;
        record.signal ??= signal ?? null;
        record.outcome ??= code === 0 ? "exit" : "non-zero-exit";
        finish();
      });
    });

  return {
    /** Exactly the seam the supervisor injects: its command, the production timeout, the same returned shape. */
    psRun: (cmd, args) => {
      const record = blank(`q${queries.length + 1}`, { command: cmd });
      queries.push(record);
      return runRecorded(cmd, args, record);
    },

    /** What the supervisor would run, so a caller can hand the production command straight back to `psRun`. */
    command: () => PROCESS_TABLE_COMMAND[platform === "win32" ? "win32" : "posix"],

    /**
     * A7: wait, at most `ms`, for every child that has been started to close.
     *
     * ⚠️ **IT DELAYS ONLY THE REPORT.** A query answered the moment its own bound was reached, and this changes
     * neither that answer nor when the caller got it: the kill request, the signal and the close simply exist by
     * the time the record is printed, instead of being empty because the child was still going.
     */
    settle: async (ms = CLOSE_WAIT_MS) => {
      const until = Date.now() + ms;
      while (queries.some((q) => q.closeMs === null && q.outcome !== "spawn-threw" && q.outcome !== "spawn-error") && Date.now() < until)
        await new Promise((r) => setTimeout(r, 25));
      return queries.every((q) => q.closeMs !== null || q.outcome === "spawn-threw" || q.outcome === "spawn-error");
    },

    /**
     * A8: only after a query really timed out, run the three probes in turn.
     *
     * ⚠️ **SEQUENTIAL, AND ONLY ON WINDOWS.** Run together they would time each other's contention instead of the
     * phase each exists to isolate.
     */
    companions: async ({ timeoutMs = COMPANION_TIMEOUT_MS, force = false } = {}) => {
      if (platform !== "win32") return { ran: false, reason: "not-windows" };
      if (!force && !queries.some((q) => q.outcome === "timeout")) return { ran: false, reason: "no-timeout" };
      for (const [name, lines] of Object.entries(COMPANIONS)) await runCompanion(name, lines.join(String.fromCharCode(10)), timeoutMs);
      return { ran: true, reason: null };
    },

    /** Every query's phases, and any companion's, as plain values fit for a record. */
    snapshot: () => ({ queries: queries.map((q) => ({ ...q })), companions: companions.map((c) => ({ ...c, markers: { ...c.markers } })) }),
  };
}
