#!/usr/bin/env node
/**
 * A stand-in for Pi that spawns ONE real long-lived child — the agent tree's known descendant — and
 * then ends the run one of the two ways ACC-0081 names.
 *
 * `mode` is `exit` (Pi finishing on its own, the ordinary end of a run) or `wait` (Pi still working
 * when the operator interrupts). Neither path stops the child: it is the supervisor's to reach.
 *
 * ⚠️ **THE CHILD IS SPAWNED DETACHED, AND MEASURING WHY IS THE POINT.** The first version was not,
 * on the reasoning that the agent is not detached in production either — and on Windows the child
 * then died with its parent before the supervisor did anything, so the evidence recorded a stopped
 * tree that the operating system had cleaned up on its own. Measured directly: an ordinary
 * grandchild is gone 1.5s after its parent exits; a detached one is still there. A descendant that
 * dies by itself proves nothing, because every implementation passes that — including one that
 * signals only the leader.
 *
 * So this models the descendant that actually needs the mechanism: one that broke away. On POSIX
 * that also puts it outside the agent's process group, which is the case that must be enumerated
 * and signalled individually — the agent cannot be a group leader, since a detached process cannot
 * read the terminal.
 */
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

if (process.argv.length < 5) process.exit(0);

const [, , reportPath, childReportPath, mode] = process.argv;
const HERE = dirname(fileURLToPath(import.meta.url));

const child = spawn(process.execPath, [join(HERE, "long-lived-child.mjs"), childReportPath], {
  stdio: "ignore",
  detached: true,
});
child.unref?.();

writeFileSync(reportPath, JSON.stringify({ pid: process.pid, childPid: child.pid, mode }) + "\n");

// ⚠️ **ON WINDOWS THE INTERRUPT IS A CONSOLE EVENT, AND IT REACHES EVERYTHING IN THE CONSOLE.**
// The evidence harness generates a real `CTRL_BREAK_EVENT`, which Windows delivers to every process
// attached to that console — this one included. An agent that died of it would end the run by
// EXITING, and the record would say `agent-exit` on a run an operator interrupted: the observation
// replaced by the thing it is meant to be told apart from. Consuming it models Pi, which handles its
// own interrupt rather than dying of one, and leaves exactly one process for the event to end — the
// supervisor — so everything else in the record was stopped BY the supervisor.
if (process.platform === "win32") process.on("SIGBREAK", () => {});

if (mode === "exit") {
  // ⚠️ **LONG ENOUGH FOR ONE ENUMERATION TO FINISH WHILE THIS IS STILL ALIVE, which on Windows is
  // over a second.** A 400ms session was not a shorter version of a real one — it was a session the
  // platform cannot observe at all, because the process table arrives after the parent is gone and
  // its children have been re-parented. A Pi session is minutes; this is the shortest thing that is
  // still one, rather than the shortest thing that still runs.
  setTimeout(() => process.exit(0), 3000);
} else {
  // Still working. Only the interrupt ends this run — and nothing here handles the signal, because
  // Windows has no graceful request and a handler would hide that difference.
  setInterval(() => {}, 1 << 30);
  setTimeout(() => process.exit(0), 120_000).unref?.();
}
