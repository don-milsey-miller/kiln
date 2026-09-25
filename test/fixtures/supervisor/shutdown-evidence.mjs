#!/usr/bin/env node
/**
 * One observed shutdown, run as its own process, recorded as a file.
 *
 * ⚠️ **THE SUPERVISOR HERE IS THE PRODUCTION ONE, AND SO ARE THE PROCESSES.** Nothing about the
 * routing, the readiness rule, the descendant enumeration or the platform's kill mechanism is
 * simulated: real children, real grandchildren, a real port, the real process table — `ps` on POSIX,
 * the kernel's process list on Windows, read without WMI (F122) — and the real
 * `kill`/`taskkill`. That is what makes the record evidence rather than a restatement of the tests.
 *
 * ⚠️ **IT RUNS AS A SEPARATE PROCESS BECAUSE THE INTERRUPT PATH NEEDS ONE.** A signal is delivered
 * to a process; observing what a supervisor does about `SIGINT` means having a process to send it
 * to, and sending it to the test runner would end the run rather than measure it.
 */
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { runSupervisor, SupervisorRefusal } from "../../../lib/supervisor.mjs";
import { resolvePinnedSessionLister } from "../../../lib/pi-runtime.mjs";
import { firstLookWindowMs } from "./observation-window.mjs";
import { createQueryDiagnostic } from "./query-diagnostic.mjs";
import { startInJob } from "../../../lib/windows-job.mjs";

const jobMode = process.platform === "win32" && process.env.KILN_EVIDENCE_JOB === "1";

if (process.argv.length < 9) process.exit(0);

const [, , projectRoot, out, port, mode, launcherReport, launcherChild, agentReport, agentChild, readyFlag, agentDir] =
  process.argv;
const HERE = dirname(fileURLToPath(import.meta.url));
const TOOL_ROOT = join(HERE, "..", "..", "..");

/**
 * F119 (diagnostic only): where each Windows process-table query's time goes.
 *
 * ⚠️ **IT CHANGES NO DECISION.** `psRun` is the seam the supervisor already has; it runs the same command
 * with the same timeout and returns the same shape, recording only what each phase of it cost. On POSIX
 * nothing is injected at all, and the production reader runs.
 *
 * The Toolhelp probe that isolated the stall to the WMI provider has been removed with its compiler; CI run
 * 35055338147 holds that evidence, and the launch now primes the provider before spawning anything (O14).
 */
const diagnostic = process.platform === "win32" ? createQueryDiagnostic() : null;

/**
 * A7 and A8 (F130): before the record is written, any killed query is given a bounded moment to close, and a
 * real timeout starts the companion probes that say which phase of the read stalled. Neither changes a decision
 * the supervisor has already taken; both only fill in the record it leaves behind.
 */
const settleDiagnostics = async () => {
  if (!diagnostic) return;
  await diagnostic.settle();
  await diagnostic.companions();
};

const record = (o) =>
  writeFileSync(
    out,
    JSON.stringify(
      { platform: process.platform, node: process.versions.node, mode, ...o, diagnostics: diagnostic?.snapshot() ?? null },
      null,
      2
    ) + "\n"
  );

try {
  const result = await runSupervisor({
    projectRoot,
    // The harness granted trust in this temporary directory, so the real gate runs and passes.
    agentDir,
    launcher: {
      command: process.execPath,
      args: [join(HERE, "tree-launcher.mjs"), launcherReport, readyFlag, launcherChild],
    },
    agent: {
      command: process.execPath,
      // O9: on Windows the agent lives long enough for a first process-table look to finish however slow the table
      // is; POSIX keeps the three seconds it was measured with.
      args: [join(HERE, "tree-agent.mjs"), agentReport, agentChild, mode === "interrupt" ? "wait" : "exit", String(firstLookWindowMs() ?? 3000)],
    },
    spawn,
    // The diagnostic reader on Windows, the production reader everywhere else (F119).
    psRun: diagnostic?.psRun,
    randomBytes,
    // Pi's own lister, as the production command supplies (F121).
    sessionLister: await resolvePinnedSessionLister(TOOL_ROOT),
    env: { ...process.env, PORT: port },
    build: null,
    readyMs: 30_000,
    graceMs: 5000,
    hardMs: 3000,
    // F130, PROTOTYPE: KILN_EVIDENCE_JOB=1 runs both trees inside jobs their hosts hold, on Windows only.
    ...(jobMode ? { agentJob: startInJob, launcherJob: startInJob } : {}),
    // ⚠️ **TO A FILE WHEN ONE IS NAMED, because the console route has no pipe to read.** The Windows
    // interrupt harness starts this process with `CreateProcess`, in its own process group and with
    // its own hidden console: nothing is capturing stdout, and a run that refuses there would leave a
    // failing CI cell with nothing to read. The variable is set by that harness only.
    log: (m) => {
      const line = `[sup] ${m}`;
      console.log(line);
      if (process.env.KILN_EVIDENCE_LOG) {
        try {
          appendFileSync(process.env.KILN_EVIDENCE_LOG, line + "\n");
        } catch {
          /* a log that cannot be written is not a reason to fail the run being observed */
        }
      }
    },
  });
  // ⚠️ THE RUN ID IS RECORDED BECAUSE THE OWNED FILE IS NAMED AFTER IT. Clause 6 is about the file
  // THIS invocation created; the observer has to be able to name it without guessing.
  await settleDiagnostics();
  record({
    ok: true,
    runId: result.runId,
    port: result.port,
    trigger: result.trigger,
    agentExit: result.agentExit,
    // What priming the process table cost this launch, apart from the shutdown budget it precedes (O14).
    preflight: result.preflight,
    shutdown: result.shutdown,
  });
  process.exit(0);
} catch (e) {
  // ⚠️ A REFUSAL IS AN OBSERVATION TOO, AND IT IS RECORDED RATHER THAN THROWN AWAY. A shutdown the
  // supervisor could not complete is precisely the outcome ACC-0081 asks to be reported as partial,
  // so the evidence has to be able to say so instead of leaving a non-zero exit and no record.
  await settleDiagnostics();
  record({
    ok: false,
    refusal: e instanceof SupervisorRefusal ? e.reason : String(e?.message ?? e),
    // A launch refused for an unreadable process table says so here, with the reason and what it cost.
    // A refused shutdown carries the launch preflight it followed (F131); a launch refused FOR an unreadable
    // process table says so with the reason and what it cost.
    preflight:
      e?.detail?.preflight ??
      (e?.detail?.reason ? { ok: false, reason: e.detail.reason, ms: e.detail.ms ?? null, rows: e.detail.rows ?? null } : null),
    shutdown: e?.detail?.shutdown ?? null,
    agentExit: e?.detail?.agentExit ?? null,
  });
  process.exit(1);
}
