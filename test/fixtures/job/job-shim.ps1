# F130 mechanism 2, feasibility only (test fixture, not production): a job that holds a process from its creation.
#
# The shim puts ITSELF in a new job object before it creates the child. A process created by a member of a job is a
# member from creation, so the child is in the job before it executes, and so is everything the child starts. After
# the child exits, the shim reads the job's own process list from the operating system, which does not depend on parent
# ids or on a look racing the child's exit, writes it to the report, and ends the job.
#
# P/Invoke through a dynamic assembly, like the supervisor's process table: no compiler is needed on the host.
param([Parameter(Mandatory = $true)][string]$Plan)
$ErrorActionPreference = 'Stop'
$clock = [Diagnostics.Stopwatch]::StartNew()
$spec = Get-Content -Raw -LiteralPath $Plan | ConvertFrom-Json

$b = [AppDomain]::CurrentDomain.DefineDynamicAssembly((New-Object Reflection.AssemblyName 'KilnJobShim'), 'Run')
$t = $b.DefineDynamicModule('KilnJobShim').DefineType('KilnJobNative', 'Public,Class')
function Add-Native($name, $ret, $types) {
  $m = $t.DefinePInvokeMethod($name, 'kernel32.dll', 'Public,Static,PinvokeImpl', 'Standard', $ret, $types, 'Winapi', 'Auto')
  $m.SetImplementationFlags('PreserveSig')
}
Add-Native 'CreateJobObjectW' ([IntPtr]) @([IntPtr], [IntPtr])
Add-Native 'AssignProcessToJobObject' ([bool]) @([IntPtr], [IntPtr])
Add-Native 'GetCurrentProcess' ([IntPtr]) @()
Add-Native 'QueryInformationJobObject' ([bool]) @([IntPtr], [int], [IntPtr], [int], [IntPtr])
Add-Native 'TerminateJobObject' ([bool]) @([IntPtr], [uint32])
$n = $t.CreateType()
$m = [Runtime.InteropServices.Marshal]

# JOBOBJECT_BASIC_PROCESS_ID_LIST: two DWORD counts, then ULONG_PTR ids.
function Get-JobPids {
  $ptr = [IntPtr]::Size
  $capacity = 1024
  $size = 8 + $ptr * $capacity
  $buf = $m::AllocHGlobal($size)
  try {
    $ok = $n::QueryInformationJobObject($job, 3, $buf, $size, [IntPtr]::Zero)
    $listed = if ($ok) { $m::ReadInt32($buf, 4) } else { 0 }
    $pids = @()
    for ($i = 0; $i -lt $listed; $i++) { $pids += $m::ReadIntPtr($buf, 8 + $ptr * $i).ToInt64() }
    return @{ ok = $ok; pids = $pids }
  } finally { $m::FreeHGlobal($buf) }
}

$job = $n::CreateJobObjectW([IntPtr]::Zero, [IntPtr]::Zero)
if ($job -eq [IntPtr]::Zero) { [Console]::Error.Write('create-job-failed'); exit 90 }
if (-not $n::AssignProcessToJobObject($job, $n::GetCurrentProcess())) { [Console]::Error.Write('assign-failed'); exit 91 }
$assignedMs = $clock.ElapsedMilliseconds

$psi = New-Object Diagnostics.ProcessStartInfo
$psi.FileName = $spec.exe
$psi.Arguments = (@($spec.args) | ForEach-Object { '"' + ($_ -replace '"', '\"') + '"' }) -join ' '
$psi.UseShellExecute = $false
$child = [Diagnostics.Process]::Start($psi)
$startedMs = $clock.ElapsedMilliseconds
$childPid = $child.Id
# While the child lives: the job's list must name it, which shows it was created inside the job.
$during = $null
if ($spec.listWhileRunningMs) { Start-Sleep -Milliseconds $spec.listWhileRunningMs; $during = (Get-JobPids).pids }
$child.WaitForExit()
$exitedMs = $clock.ElapsedMilliseconds

$after = Get-JobPids
$ok = $after.ok
$pids = $after.pids
$listedMs = $clock.ElapsedMilliseconds

$report = [ordered]@{
  shimPid = $PID; childPid = $childPid; childExitCode = $child.ExitCode; queried = $ok; jobPids = $pids; jobPidsWhileRunning = $during
  assignedMs = $assignedMs; childStartedMs = $startedMs; childExitedMs = $exitedMs; listedMs = $listedMs
}
[IO.File]::WriteAllText($spec.report, ($report | ConvertTo-Json -Compress))

# Ending the job ends every member, this shim included, so the report is written first.
if ($spec.terminate) { [void]$n::TerminateJobObject($job, 0) }
exit $child.ExitCode
