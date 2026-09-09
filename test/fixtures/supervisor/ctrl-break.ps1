# The Windows interrupt, delivered the way Windows delivers one.
#
# WARNING: `child.kill("SIGINT")` on Windows is `TerminateProcess`. Measured here: the target's
# handler never runs, it dies reporting `SIGKILL`, and nothing it would have done on the way out
# happens. What an operator's Ctrl+C or Ctrl+Break actually delivers is a CONSOLE CONTROL EVENT,
# which is not a signal to a pid and which no Node API can generate. `GenerateConsoleCtrlEvent` is
# the only way to produce one, so this script exists to call it.
#
# WARNING: IT IS SENT TO THE SUPERVISOR'S OWN PROCESS GROUP, NOT TO THE CONSOLE. `dwProcessGroupId`
# of 0 means "everything sharing my console", and that was the first version: it reached this script
# too, PowerShell answers Ctrl+Break by breaking into its debugger, and the harness died at the
# moment it sent — leaving the observation unwritten and the run unwatched. So the process under
# observation is created with CREATE_NEW_PROCESS_GROUP and the event is addressed to that group,
# which is also what a console sends to a foreground group: it reaches the supervisor and the two
# children it started, and nothing else.
#
# WARNING: IT IS CTRL+BREAK AND NOT CTRL+C, AND THE REASON IS MEASURED. Both were tried against a
# child that handles each: the Ctrl+Break handler ran, the Ctrl+C handler never did, whether the
# child was started by `Start-Process` or by a raw `ProcessStartInfo`. A process started from
# PowerShell inherits Ctrl+C disabled, that state is inherited by its children, and nothing lets one
# process clear it in another — and a process in a NEW process group ignores Ctrl+C by definition.
# Ctrl+Break is a real operator interrupt, Node surfaces it as SIGBREAK, and the supervisor watches
# SIGINT, SIGTERM, SIGHUP and SIGBREAK through one handler and one shutdown. What this cannot
# observe is the SIGINT DELIVERY itself, which the POSIX cell observes.
#
# The child keeps a console — that is the point, it must be able to receive the event. Anything it
# spawns `detached` does not: libuv passes DETACHED_PROCESS along with CREATE_NEW_PROCESS_GROUP, so
# a detached grandchild has no console at all and no console event can reach it. That is exactly the
# descendant this evidence is about — the one only the supervisor's enumeration and kill can stop.
param([Parameter(Mandatory = $true)][string]$Plan)

$ErrorActionPreference = "Stop"
$spec = Get-Content -Raw -Path $Plan | ConvertFrom-Json

$src = @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class KilnConsole {
  [DllImport("kernel32.dll", SetLastError = true)] public static extern bool FreeConsole();
  [DllImport("kernel32.dll", SetLastError = true)] public static extern bool AllocConsole();
  [DllImport("kernel32.dll", SetLastError = true)] public static extern bool GenerateConsoleCtrlEvent(uint dwCtrlEvent, uint dwProcessGroupId);
  [DllImport("kernel32.dll", SetLastError = true)] public static extern uint GetConsoleProcessList(uint[] lpdwProcessList, uint dwProcessCount);
  [DllImport("kernel32.dll", SetLastError = true)] public static extern IntPtr GetConsoleWindow();
  [DllImport("user32.dll", SetLastError = true)] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

  [StructLayout(LayoutKind.Sequential)]
  public struct PROCESS_INFORMATION { public IntPtr hProcess; public IntPtr hThread; public uint dwProcessId; public uint dwThreadId; }

  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct STARTUPINFO {
    public uint cb; public string lpReserved; public string lpDesktop; public string lpTitle;
    public uint dwX; public uint dwY; public uint dwXSize; public uint dwYSize;
    public uint dwXCountChars; public uint dwYCountChars; public uint dwFillAttribute; public uint dwFlags;
    public ushort wShowWindow; public ushort cbReserved2; public IntPtr lpReserved2;
    public IntPtr hStdInput; public IntPtr hStdOutput; public IntPtr hStdError;
  }

  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern bool CreateProcess(
    string lpApplicationName, StringBuilder lpCommandLine, IntPtr lpProcessAttributes, IntPtr lpThreadAttributes,
    bool bInheritHandles, uint dwCreationFlags, IntPtr lpEnvironment, string lpCurrentDirectory,
    ref STARTUPINFO lpStartupInfo, out PROCESS_INFORMATION lpProcessInformation);

  public const uint CREATE_NEW_PROCESS_GROUP = 0x00000200;

  // Started in its own process group, sharing this console, so one group can be addressed.
  public static uint StartInOwnGroup(string commandLine) {
    STARTUPINFO si = new STARTUPINFO();
    si.cb = (uint)Marshal.SizeOf(typeof(STARTUPINFO));
    PROCESS_INFORMATION pi;
    bool ok = CreateProcess(null, new StringBuilder(commandLine), IntPtr.Zero, IntPtr.Zero, true,
      CREATE_NEW_PROCESS_GROUP, IntPtr.Zero, null, ref si, out pi);
    if (!ok) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
    return pi.dwProcessId;
  }

  public static uint[] Inhabitants() {
    uint[] buf = new uint[64];
    uint n = GetConsoleProcessList(buf, (uint)buf.Length);
    uint[] outp = new uint[n];
    Array.Copy(buf, outp, (int)n);
    return outp;
  }
}
"@
Add-Type -TypeDefinition $src

$result = [ordered]@{ sent = $false; isolated = $false; refusal = $null; inhabitants = @(); pid = $null; exitCode = $null }
function Report {
  ($result | ConvertTo-Json -Compress) | Out-File -Encoding utf8 -FilePath $spec.result
}

# 1. A console of our own — the child needs one to receive a console event, and this one belongs to
#    nobody else. `FreeConsole` fails when there was none to free (a service-hosted CI runner), which
#    is not an error: `AllocConsole` succeeding is what matters, and it fails if the process already
#    has one, so a false here means we are still sharing somebody else's.
[void][KilnConsole]::FreeConsole()
if (-not [KilnConsole]::AllocConsole()) {
  $result.refusal = "alloc-console-failed"
  Report
  exit 3
}

# ⚠️ **AND THE WINDOW IT OPENED IS HIDDEN.** `AllocConsole` on an interactive desktop puts a real
# console window on the operator's screen; a run was lost to somebody closing that window, which
# kills every process attached to the console — the observation destroyed by its own harness.
$hwnd = [KilnConsole]::GetConsoleWindow()
if ($hwnd -ne [IntPtr]::Zero) { [void][KilnConsole]::ShowWindow($hwnd, 0) }

# 2. The gate, before anything is started: a console holding only this script is one nobody else can
#    be interrupted through. Everything that joins it afterwards joins it by being started here.
$alone = [KilnConsole]::Inhabitants()
if ($alone.Length -ne 1 -or $alone[0] -ne $PID) {
  $result.refusal = "console-not-private"
  $result.inhabitants = $alone
  Report
  exit 4
}

# 3. The process under observation, in its own group so the event can be addressed to it alone.
#    Quoted argument by argument: a command line is one string, and a path under "Program Files"
#    would otherwise arrive as two arguments.
if ($spec.log) { $env:KILN_EVIDENCE_LOG = $spec.log }
$commandLine = (@("`"$($spec.exe)`"") + @($spec.args | ForEach-Object { '"' + $_ + '"' })) -join ' '
$childPid = [KilnConsole]::StartInOwnGroup($commandLine)
$result.pid = $childPid
$child = [System.Diagnostics.Process]::GetProcessById($childPid)

# 4. Wait for the harness to say the trees are up.
$deadline = (Get-Date).AddSeconds(120)
while (-not (Test-Path $spec.trigger) -and (Get-Date) -lt $deadline -and -not $child.HasExited) {
  Start-Sleep -Milliseconds 50
}
if (-not (Test-Path $spec.trigger)) {
  $result.refusal = "never-triggered"
  Report
  try { $child.Kill() } catch { }
  exit 5
}
if ($child.HasExited) {
  # Nothing was interrupted: the run ended on its own before the event could be sent.
  $result.refusal = "child-exited-before-the-interrupt"
  Report
  exit 6
}

$result.inhabitants = [KilnConsole]::Inhabitants()
$result.isolated = $true

# 5. CTRL_BREAK_EVENT (1), addressed to the supervisor's process group.
$result.sent = [KilnConsole]::GenerateConsoleCtrlEvent(1, $childPid)

$child.WaitForExit(120000) | Out-Null
if ($child.HasExited) { $result.exitCode = $child.ExitCode }
Report
exit 0
