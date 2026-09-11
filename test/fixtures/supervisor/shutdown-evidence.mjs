#!/usr/bin/env node
/**
 * One observed shutdown, run as its own process, recorded as a file.
 *
 * ⚠️ **THE SUPERVISOR HERE IS THE PRODUCTION ONE, AND SO ARE THE PROCESSES.** Nothing about the
 * routing, the readiness rule, the descendant enumeration or the platform's kill mechanism is
 * simulated: real children, real grandchildren, a real port, the real process table — `ps` on POSIX,
 * `Get-CimInstance Win32_Process` on Windows, where `wmic` is absent from 26200 — and the real
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

if (process.argv.length < 9) process.exit(0);

const [, , projectRoot, out, port, mode, launcherReport, launcherChild, agentReport, agentChild, readyFlag, agentDir] =
  process.argv;
const HERE = dirname(fileURLToPath(import.meta.url));

const record = (o) =>
  writeFileSync(
    out,
    JSON.stringify({ platform: process.platform, node: process.versions.node, mode, ...o }, null, 2) + "\n"
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
      args: [join(HERE, "tree-agent.mjs"), agentReport, agentChild, mode === "interrupt" ? "wait" : "exit"],
    },
    spawn,
    randomBytes,
    env: { ...process.env, PORT: port },
    build: null,
    readyMs: 30_000,
    graceMs: 5000,
    hardMs: 3000,
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
  record({
    ok: true,
    runId: result.runId,
    port: result.port,
    trigger: result.trigger,
    agentExit: result.agentExit,
    shutdown: result.shutdown,
  });
  process.exit(0);
} catch (e) {
  // ⚠️ A REFUSAL IS AN OBSERVATION TOO, AND IT IS RECORDED RATHER THAN THROWN AWAY. A shutdown the
  // supervisor could not complete is precisely the outcome ACC-0081 asks to be reported as partial,
  // so the evidence has to be able to say so instead of leaving a non-zero exit and no record.
  record({
    ok: false,
    refusal: e instanceof SupervisorRefusal ? e.reason : String(e?.message ?? e),
    shutdown: e?.detail?.shutdown ?? null,
    agentExit: e?.detail?.agentExit ?? null,
  });
  process.exit(1);
}
