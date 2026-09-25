# The Windows job host — F130 mechanism 2 (TSK-0058), PROTOTYPE, opt-in only.
#
# Starts one process inside a new job object before that process executes a single instruction, and holds the job
# for the supervisor that started this host.
#
# ⚠️ THE HOST STAYS OUTSIDE THE JOB; THE CHILD IS CREATED SUSPENDED, ASSIGNED, THEN RESUMED. Assigning after an
# ordinary start would race the child's first instructions, and a host inside its own job would end with it. So the
# child is created with CREATE_SUSPENDED, put in the job, and only then resumed: everything it or its descendants start
# is a member from creation, and ending the job ends them without ending the host.
#
# ⚠️ THE CHILD GETS THIS HOST'S TERMINAL, NOT A PIPE. The host's standard handles are the supervisor's, and the child
# inherits them unchanged, so an interactive agent keeps its console and a piped one keeps its pipe. The command line
# is passed through exactly as the supervisor quoted it.
#
# ⚠️ CONTROL IS BY FILES IN A PRIVATE DIRECTORY, because the standard handles belong to the child. The supervisor
# writes `req-<id>.json` ({op: list|terminate|release}); the host answers `res-<id>.json`. `started.json` and
# `exited.json` report the child's start and end. The host exits after `release`, or when its supervisor is gone,
# returning the child's exit code; closing the job then ends anything still in it (KILL_ON_JOB_CLOSE).
#
# ⚠️ CONSOLE CONTROL EVENTS ARE THE CHILD'S. The host ignores CTRL+C, set only after the child exists because that
# setting is inherited by processes created after it, and then detaches from the console entirely.
param([Parameter(Mandatory = $true)][string]$Plan)
$ErrorActionPreference = 'Stop'
$clock = [Diagnostics.Stopwatch]::StartNew()
$spec = Get-Content -Raw -Encoding UTF8 -LiteralPath $Plan | ConvertFrom-Json
$dir = $spec.controlDir
function Write-Control($name, $value) {
  $tmp = Join-Path $dir ($name + '.tmp')
  [IO.File]::WriteAllText($tmp, ($value | ConvertTo-Json -Compress -Depth 4))
  Move-Item -LiteralPath $tmp -Destination (Join-Path $dir ($name + '.json')) -Force
}
function Fail($code, $why) { Write-Control 'failed' ([ordered]@{ reason = $why; ms = $clock.ElapsedMilliseconds }); exit $code }

try {
  $b = [AppDomain]::CurrentDomain.DefineDynamicAssembly((New-Object Reflection.AssemblyName 'KilnJobHost'), 'Run')
  $t = $b.DefineDynamicModule('KilnJobHost').DefineType('KilnJobHostNative', 'Public,Class')
  function Add-Native($name, $ret, $types) {
    $m = $t.DefinePInvokeMethod($name, 'kernel32.dll', 'Public,Static,PinvokeImpl', 'Standard', $ret, $types, 'Winapi', 'Auto')
    $m.SetImplementationFlags('PreserveSig')
  }
  Add-Native 'CreateJobObjectW' ([IntPtr]) @([IntPtr], [IntPtr])
  Add-Native 'SetInformationJobObject' ([bool]) @([IntPtr], [int], [IntPtr], [int])
  Add-Native 'AssignProcessToJobObject' ([bool]) @([IntPtr], [IntPtr])
  Add-Native 'QueryInformationJobObject' ([bool]) @([IntPtr], [int], [IntPtr], [int], [IntPtr])
  Add-Native 'TerminateJobObject' ([bool]) @([IntPtr], [uint32])
  Add-Native 'CreateProcessW' ([bool]) @([IntPtr], [IntPtr], [IntPtr], [IntPtr], [bool], [uint32], [IntPtr], [IntPtr], [IntPtr], [IntPtr])
  Add-Native 'ResumeThread' ([uint32]) @([IntPtr])
  Add-Native 'TerminateProcess' ([bool]) @([IntPtr], [uint32])
  Add-Native 'WaitForSingleObject' ([uint32]) @([IntPtr], [uint32])
  Add-Native 'GetExitCodeProcess' ([bool]) @([IntPtr], [IntPtr])
  Add-Native 'CloseHandle' ([bool]) @([IntPtr])
  Add-Native 'SetConsoleCtrlHandler' ([bool]) @([IntPtr], [bool])
  Add-Native 'FreeConsole' ([bool]) @()
  $n = $t.CreateType()
} catch { Fail 80 'native-unavailable' }
$m = [Runtime.InteropServices.Marshal]
$ptr = [IntPtr]::Size

# The job: anything still in it when the last handle closes is ended (KILL_ON_JOB_CLOSE, 0x2000).
$job = $n::CreateJobObjectW([IntPtr]::Zero, [IntPtr]::Zero)
if ($job -eq [IntPtr]::Zero) { Fail 81 'create-job-failed' }
$limitSize = if ($ptr -eq 8) { 144 } else { 112 }
$limits = $m::AllocHGlobal($limitSize)
for ($i = 0; $i -lt $limitSize; $i++) { $m::WriteByte($limits, $i, 0) }
$m::WriteInt32($limits, 16, 0x2000)
if (-not $n::SetInformationJobObject($job, 9, $limits, $limitSize)) { Fail 82 'job-limits-failed' }
$m::FreeHGlobal($limits)

# CREATE_SUSPENDED (0x4) | CREATE_UNICODE_ENVIRONMENT (0x400); the environment and directory are this host's.
$siSize = if ($ptr -eq 8) { 104 } else { 68 }
$si = $m::AllocHGlobal($siSize)
for ($i = 0; $i -lt $siSize; $i++) { $m::WriteByte($si, $i, 0) }
$m::WriteInt32($si, 0, $siSize)
$pi = $m::AllocHGlobal(8 + 2 * $ptr)
$cmd = $m::StringToHGlobalUni([string]$spec.commandLine)
if (-not $n::CreateProcessW([IntPtr]::Zero, $cmd, [IntPtr]::Zero, [IntPtr]::Zero, $true, 0x404, [IntPtr]::Zero, [IntPtr]::Zero, $si, $pi)) { Fail 83 'create-process-failed' }
$hProcess = $m::ReadIntPtr($pi, 0)
$hThread = $m::ReadIntPtr($pi, $ptr)
$childPid = $m::ReadInt32($pi, 2 * $ptr)
if (-not $n::AssignProcessToJobObject($job, $hProcess)) {
  [void]$n::TerminateProcess($hProcess, 1)
  Fail 84 'assign-failed'
}
[void]$n::ResumeThread($hThread)
[void]$n::CloseHandle($hThread)
[void]$n::SetConsoleCtrlHandler([IntPtr]::Zero, $true)
# ⚠️ AND THEN THE HOST LEAVES THE CONSOLE. Ignoring CTRL+C does not cover CTRL+BREAK, which reaches every process on
# the console and breaks PowerShell into its debugger: measured, a host that got one stopped answering, and its
# tree could not be observed. The child already holds the console it inherited, so it keeps its terminal and its own
# CTRL+C; the host never writes to the console, so it has nothing left to receive there.
[void]$n::FreeConsole()
Write-Control 'started' ([ordered]@{ pid = $childPid; hostPid = $PID; startedMs = $clock.ElapsedMilliseconds })

function Get-Members {
  $capacity = 4096
  $size = 8 + $ptr * $capacity
  $buf = $m::AllocHGlobal($size)
  try {
    if (-not $n::QueryInformationJobObject($job, 3, $buf, $size, [IntPtr]::Zero)) { return $null }
    $listed = $m::ReadInt32($buf, 4)
    $pids = @()
    for ($i = 0; $i -lt $listed; $i++) { $pids += $m::ReadIntPtr($buf, 8 + $ptr * $i).ToInt64() }
    return , $pids
  } finally { $m::FreeHGlobal($buf) }
}

$exitCode = $null
$parentPid = [int]$spec.parentPid
$released = $false
while (-not $released) {
  if ($exitCode -eq $null -and $n::WaitForSingleObject($hProcess, 0) -eq 0) {
    $codeBuf = $m::AllocHGlobal(4)
    [void]$n::GetExitCodeProcess($hProcess, $codeBuf)
    $exitCode = [uint32]$m::ReadInt32($codeBuf, 0)
    $m::FreeHGlobal($codeBuf)
    Write-Control 'exited' ([ordered]@{ code = $exitCode; ms = $clock.ElapsedMilliseconds })
  }
  foreach ($req in @(Get-ChildItem -LiteralPath $dir -Filter 'req-*.json' -ErrorAction SilentlyContinue)) {
    $id = $req.BaseName.Substring(4)
    $body = Get-Content -Raw -Encoding UTF8 -LiteralPath $req.FullName | ConvertFrom-Json
    Remove-Item -LiteralPath $req.FullName -Force
    $answer = [ordered]@{ op = $body.op; ok = $true }
    if ($body.op -eq 'list') {
      $members = Get-Members
      if ($members -eq $null) { $answer.ok = $false } else { $answer.pids = $members }
    } elseif ($body.op -eq 'terminate') {
      $answer.ok = [bool]$n::TerminateJobObject($job, 1)
      $answer.pids = Get-Members
    } elseif ($body.op -eq 'release') {
      $released = $true
    } else { $answer.ok = $false }
    Write-Control ('res-' + $id) $answer
  }
  if (-not $released -and $parentPid -gt 0 -and -not (Get-Process -Id $parentPid -ErrorAction SilentlyContinue)) { break }
  Start-Sleep -Milliseconds 20
}
[void]$n::CloseHandle($job)
if ($exitCode -eq $null) { exit 1 }
exit [int]$exitCode
