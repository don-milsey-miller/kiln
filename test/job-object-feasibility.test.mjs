/**
 * F130 mechanism 2, FEASIBILITY ONLY: can a Windows job object hold an agent and its descendants from creation, so a
 * shutdown can observe them from the operating system instead of racing the agent's exit? Production shutdown does
 * not use this.
 *
 * ⚠️ **THE ORDERING IS THE QUESTION.** Assigning a job after an ordinary `spawn()` would leave the same race: the agent
 * could run, spawn and exit before the assignment. So the shim joins a new job BEFORE it creates the child, and the
 * job's own process list, read while the child runs, must name the child and the grandchild it started first.
 *
 * ⚠️ **TWO PLATFORM FACTS THIS RECORDS.** Node's libuv puts every non-detached child it spawns into a job of its own
 * that kills its members when that Node process exits, so an ATTACHED grandchild does not outlive a Node child at all.
 * A DETACHED grandchild does outlive it, and stays in the shim's job after its parent is gone: the job still names it,
 * and ending the job ends it. That survivor is exactly what a shutdown racing the parent's exit could not observe.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SHIM = join(import.meta.dirname, "fixtures", "job", "job-shim.ps1");
const windowsOnly = { skip: process.platform === "win32" ? false : "a Windows job object exists only on Windows" };
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** Run `childSource` as a Node child of the shim, inside a new job; return the shim's report and the child's own. */
function inJob(dir, childSource, { listWhileRunningMs = 0, terminate = true } = {}) {
  const childScript = join(dir, "child.mjs");
  const childOut = join(dir, "child.json");
  const report = join(dir, "report.json");
  const plan = join(dir, "plan.json");
  writeFileSync(childScript, childSource);
  writeFileSync(plan, JSON.stringify({ exe: process.execPath, args: [childScript, childOut], report, listWhileRunningMs, terminate }));
  const t0 = Date.now();
  const r = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", SHIM, "-Plan", plan], {
    encoding: "utf-8",
    timeout: 120_000,
  });
  const read = (p) => {
    try {
      return JSON.parse(readFileSync(p, "utf-8"));
    } catch {
      return null;
    }
  };
  return { ms: Date.now() - t0, status: r.status, stderr: r.stderr.slice(0, 400), job: read(report), child: read(childOut) };
}

test("⚠️ F130 FEASIBILITY a job joined before the child is created holds the child and its first grandchild from creation", windowsOnly, async () => {
  const dir = mkdtempSync(join(tmpdir(), "kiln-job-feasibility-"));
  const outsider = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
  try {
    // The stand-in agent: its first act is to start a grandchild; it lives one second, long enough to be listed.
    const run = inJob(
      dir,
      [
        'import { spawn } from "node:child_process";',
        'import { writeFileSync } from "node:fs";',
        'const g = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });',
        "writeFileSync(process.argv[2], JSON.stringify({ childPid: process.pid, grandchildPid: g.pid }));",
        "setTimeout(() => process.exit(0), 1000);",
      ].join("\n"),
      { listWhileRunningMs: 400 }
    );
    console.log(`[job feasibility: ordering] ${JSON.stringify(run)}`);
    assert.ok(run.job && run.child, `the shim did not run: ${run.stderr}`);
    const during = (run.job.jobPidsWhileRunning ?? []).map(Number);
    assert.ok(during.includes(run.child.childPid), `the child was not in the job while it ran: ${during}`);
    assert.ok(during.includes(run.child.grandchildPid), `the grandchild it started first was not in the job: ${during}`);
    assert.ok(during.includes(run.job.shimPid), "the shim joined before creating the child");
    for (const list of [during, run.job.jobPids.map(Number)]) {
      assert.equal(list.includes(outsider.pid), false, "a process started outside the job is not in it");
      assert.equal(list.includes(process.pid), false, "nor is the test runner");
    }
    // libuv's own job ended the attached grandchild with its Node parent, before the list after the exit was read.
    assert.equal(run.job.jobPids.map(Number).includes(run.child.grandchildPid), false, "an attached grandchild outlived its Node parent");
    assert.equal(alive(run.child.grandchildPid), false);
    assert.equal(alive(outsider.pid), true, "the outsider did not end with the job");
  } finally {
    outsider.kill();
    rmSync(dir, { recursive: true, force: true, maxRetries: 17, retryDelay: 100 });
  }
});

test("⚠️ F130 FEASIBILITY a detached grandchild that outlives its parent is still named by the job, and ending the job ends it", windowsOnly, async () => {
  const dir = mkdtempSync(join(tmpdir(), "kiln-job-breakaway-"));
  try {
    const run = inJob(
      dir,
      [
        'import { spawn } from "node:child_process";',
        'import { writeFileSync } from "node:fs";',
        "let pid = null, error = null;",
        "try {",
        '  const g = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore", detached: true });',
        "  pid = g.pid ?? null;",
        '  g.on("error", (e) => (error = e.code ?? e.message));',
        "} catch (e) { error = e.code ?? e.message; }",
        "setTimeout(() => { writeFileSync(process.argv[2], JSON.stringify({ childPid: process.pid, detachedPid: pid, error })); process.exit(0); }, 200);",
      ].join("\n")
    );
    console.log(`[job feasibility: breakaway] ${JSON.stringify(run)}`);
    assert.ok(run.job && run.child, `the shim did not run: ${run.stderr}`);
    assert.equal(run.child.error, null, `the detached spawn failed: ${JSON.stringify(run.child)}`);
    assert.ok(run.child.detachedPid, "a detached grandchild was started");
    assert.ok(run.job.jobPids.map(Number).includes(run.child.detachedPid), `the job did not name the survivor after its parent exited: ${run.job.jobPids}`);
    assert.equal(run.job.jobPids.map(Number).includes(run.child.childPid), false, "its parent had exited");
    const deadline = Date.now() + 10_000;
    while (alive(run.child.detachedPid) && Date.now() < deadline) await new Promise((res) => setTimeout(res, 100));
    assert.equal(alive(run.child.detachedPid), false, "the survivor outlived the end of the job");
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 17, retryDelay: 100 });
  }
});
