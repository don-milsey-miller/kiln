/**
 * The Windows job host PROTOTYPE — F130 mechanism 2 (TSK-0058). Production does not use it yet.
 *
 * What these establish before any supervisor uses the host: the agent's exact arguments, its standard input, output
 * and exit code pass through unchanged; the job's own list names a survivor after the agent exits; terminating the job
 * ends that survivor within a bound; a host that dies ends everything left in its job; and a host that cannot start
 * the agent refuses rather than starting it some other way. Start-up time is printed for the record.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { JobHostRefusal, quoteWindowsArg, startInJob, windowsCommandLine } from "../lib/windows-job.mjs";

const windowsOnly = { skip: process.platform === "win32" ? false : "a Windows job object exists only on Windows" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const until = async (fn, ms) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const v = await fn();
    if (v) return v;
    await sleep(20);
  }
  return null;
};
const workspace = (name) => mkdtempSync(join(tmpdir(), `kiln-job-${name}-`));
const TRICKY = ["plain", "with space", 'quote"in', "trail\\", 'back\\"slash', "", "ünïcødé", "a\\\\b c\\", "--flag=va lue", "/kiln-start"];

test("the command line quotes each argument so the C runtime parses it back to itself", () => {
  assert.equal(quoteWindowsArg("plain"), "plain");
  assert.equal(quoteWindowsArg(""), '""');
  assert.equal(quoteWindowsArg("with space"), '"with space"');
  assert.equal(quoteWindowsArg('quote"in'), '"quote\\"in"');
  assert.equal(quoteWindowsArg("trail\\ x\\"), '"trail\\ x\\\\"');
  assert.equal(windowsCommandLine("C:\\Program Files\\node.exe", ["a b"]), '"C:\\Program Files\\node.exe" "a b"');
});

test("⚠️ F130 PROTOTYPE the agent receives its exact arguments, input, output and exit code through the host", windowsOnly, async () => {
  const dir = workspace("io");
  try {
    const child = join(dir, "child.mjs");
    writeFileSync(
      child,
      [
        'import { writeFileSync } from "node:fs";',
        "let input = '';",
        "process.stdin.setEncoding('utf-8');",
        "process.stdin.on('data', (d) => (input += d));",
        "process.stdin.on('end', () => {",
        "  writeFileSync(process.argv[2], JSON.stringify(process.argv.slice(3)));",
        "  process.stdout.write('OUT:' + input);",
        "  process.stderr.write('ERR-LINE');",
        "  process.exit(7);",
        "});",
      ].join("\n")
    );
    const argsOut = join(dir, "args.json");
    const job = await startInJob({ command: process.execPath, args: [child, argsOut, ...TRICKY], controlDir: dir, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    job.host.stdout.on("data", (d) => (stdout += d));
    job.host.stderr.on("data", (d) => (stderr += d));
    job.host.stdin.end("piped input\n");
    const exited = await until(() => job.exited(), 30_000);
    assert.ok(exited, "the agent never exited");
    const hostExit = new Promise((r) => job.host.once("exit", (code) => r(code)));
    assert.equal((await job.release()).ok, true);
    assert.equal(await hostExit, 7, "the host returns the agent's exit code");
    assert.equal(exited.code, 7);
    assert.deepEqual(JSON.parse(readFileSync(argsOut, "utf-8")), TRICKY, "every argument arrived exactly");
    assert.equal(stdout, "OUT:piped input\n", "the agent's input and output are the host's, unchanged");
    assert.equal(stderr, "ERR-LINE");
    console.log(`[job host] started in ${job.startedMs} ms`);
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 17, retryDelay: 100 });
  }
});

test("⚠️ #200 an exit code at or above 0x80000000 reaches the exited record and the host's own exit, and the shutdown completes", windowsOnly, async () => {
  const dir = workspace("crash-code");
  // STATUS_STACK_BUFFER_OVERRUN, the code a libuv assertion ends a process with. Signed, it is -1073740791.
  const CRASH = 0xc0000409;
  try {
    const job = await startInJob({ command: process.execPath, args: ["-e", `process.exit(${CRASH})`], controlDir: dir, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    job.host.stderr.on("data", (d) => (stderr += d));
    const hostExit = new Promise((r) => job.host.once("exit", (code) => r(code)));
    const exited = await until(() => job.exited(), 30_000);
    assert.ok(exited, `the host wrote no exited record: ${stderr}`);
    assert.equal(exited.code, 3221226505, "the record holds the unsigned code");

    const members = await job.list();
    assert.equal(members.ok, true);
    assert.deepEqual(members.pids, [], "nothing is left in the job");
    assert.equal((await job.release()).ok, true, "the host released the job");
    // Node may report a code this large as signed: the 32-bit pattern is what is compared.
    assert.equal((await hostExit) >>> 0, CRASH, "the host's own exit carries the same 32 bits");
    assert.equal(stderr, "", "the host wrote no error");
    assert.ok(await until(() => !alive(job.pid) && !alive(job.host.pid), 3000), "the agent or its host outlived the release");
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 17, retryDelay: 100 });
  }
});

test("⚠️ F130 PROTOTYPE the job names a detached survivor after the agent exits, and ending the job ends it within a bound", windowsOnly, async () => {
  const dir = workspace("survivor");
  try {
    const child = join(dir, "child.mjs");
    writeFileSync(
      child,
      [
        'import { spawn } from "node:child_process";',
        'import { writeFileSync } from "node:fs";',
        'const g = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore", detached: true });',
        "writeFileSync(process.argv[2], JSON.stringify({ pid: process.pid, survivor: g.pid }));",
        "process.exit(0);",
      ].join("\n")
    );
    const pids = join(dir, "pids.json");
    const job = await startInJob({ command: process.execPath, args: [child, pids], controlDir: dir, stdio: "ignore" });
    assert.ok(await until(() => job.exited(), 30_000), "the agent never exited");
    const { pid, survivor } = JSON.parse(readFileSync(pids, "utf-8"));
    assert.equal(job.pid, pid, "the host reports the agent's own pid");

    const members = await job.list();
    assert.equal(members.ok, true);
    assert.ok(members.pids.includes(survivor), `the survivor ${survivor} is not named: ${members.pids}`);
    assert.equal(members.pids.includes(pid), false, "the agent had exited");

    const t0 = Date.now();
    const ended = await job.terminate();
    assert.equal(ended.ok, true);
    const gone = await until(() => !alive(survivor), 3000);
    const ms = Date.now() - t0;
    assert.ok(gone, "the survivor outlived the end of its job");
    console.log(`[job host] terminate-to-gone ${ms} ms, started in ${job.startedMs} ms`);
    assert.ok(ms < 3000, `ending the job took ${ms} ms`);
    await job.release();
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 17, retryDelay: 100 });
  }
});

test("⚠️ F130 PROTOTYPE a host that dies ends everything left in its job", windowsOnly, async () => {
  const dir = workspace("host-death");
  try {
    const child = join(dir, "child.mjs");
    writeFileSync(
      child,
      [
        'import { spawn } from "node:child_process";',
        'import { writeFileSync } from "node:fs";',
        'const g = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore", detached: true });',
        "writeFileSync(process.argv[2], JSON.stringify({ survivor: g.pid }));",
        "setTimeout(() => {}, 60000);",
      ].join("\n")
    );
    const pids = join(dir, "pids.json");
    const job = await startInJob({ command: process.execPath, args: [child, pids], controlDir: dir, stdio: "ignore" });
    const { survivor } = await until(() => {
      try {
        return JSON.parse(readFileSync(pids, "utf-8"));
      } catch {
        return null;
      }
    }, 30_000);
    // Only the host, not its tree: the job's own close is what must end the agent and the survivor.
    spawnSync("taskkill", ["/pid", String(job.host.pid), "/F"], { stdio: "ignore" });
    assert.ok(await until(() => !alive(survivor) && !alive(job.pid), 5000), "the job's members outlived their host");
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 17, retryDelay: 100 });
  }
});

test("⚠️ F130 PROTOTYPE a host that cannot start the agent refuses, and nothing is started some other way", windowsOnly, async () => {
  const dir = workspace("refusal");
  try {
    await assert.rejects(
      startInJob({ command: join(dir, "no-such-program.exe"), args: [], controlDir: dir, stdio: "ignore" }),
      (e) => e instanceof JobHostRefusal && e.reason === "create-process-failed"
    );
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 17, retryDelay: 100 });
  }
});
