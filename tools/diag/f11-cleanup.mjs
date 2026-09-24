/**
 * F11 diagnostic: what holds a custom-provider project's directory after the real launcher has stopped?
 *
 * Runs ACC-0116's flow (real setup, then the real bin/start-kiln.mjs with piped input) N times per mode, with and
 * without PI_OFFLINE=1, and after each run records, without retrying anything that is being measured:
 *   - the supervisor's own agent exit and shutdown lines;
 *   - every process started during the run that is still alive when the command has exited (Get-Process, no WMI);
 *   - whether the run's port still answers;
 *   - handle64's list of handles under the temporary root, when HANDLE_EXE names it;
 *   - the first removal attempt of the project directory, and, if it fails, how long until it succeeds, polled
 *     every 50 ms for up to 15 s, with a second process snapshot and handle list at the first failure.
 *
 * Usage: node tools/diag/f11-cleanup.mjs <iterations-per-mode> <out.json>
 */

import { execFileSync, spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FIXTURE_DONE, FIXTURE_KEY, FIXTURE_KEY_VAR, FIXTURE_MODEL, FIXTURE_PROVIDER, modelsJson, startProviderFixture } from "../../test/helpers/provider-fixture.mjs";
import { blockText } from "../../lib/project-gitignore.mjs";
import { withBuildLock } from "../../test/helpers/build-lock.mjs";

const ROOT = join(import.meta.dirname, "..", "..");
const [iterations = "3", outFile = "f11.json"] = process.argv.slice(2);
const HANDLE_EXE = process.env.HANDLE_EXE ?? null;

function run(args, opts, input) {
  return new Promise((done) => {
    const child = spawn(process.execPath, args, { ...opts, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    const bound = setTimeout(() => child.kill(), 300_000);
    child.on("close", (status, signal) => {
      clearTimeout(bound);
      done({ status, signal, stdout, stderr, endedAt: Date.now() });
    });
    child.stdin.end(input ?? "");
  });
}

async function freePort() {
  const server = createServer();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  await new Promise((r) => server.close(r));
  return port;
}

const answers = (port) =>
  new Promise((done) => {
    const req = request({ host: "127.0.0.1", port, path: "/", timeout: 2000 }, (res) => {
      res.resume();
      done(true);
    });
    req.on("error", () => done(false));
    req.on("timeout", () => {
      req.destroy();
      done(false);
    });
    req.end();
  });

/** Processes started at or after `sinceMs` that are alive now: pid, name, start time, path. */
function survivors(sinceMs) {
  const script =
    "Get-Process | ForEach-Object { try { $s = $_.StartTime.ToUniversalTime().ToString('o') } catch { $s = '' }; " +
    "[pscustomobject]@{ Id = $_.Id; Name = $_.ProcessName; Start = $s; Path = $_.Path } } | ConvertTo-Json -Compress";
  const r = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf-8", timeout: 30_000 });
  if (r.status !== 0) return { error: (r.stderr || r.error?.message || "").slice(0, 300) };
  const rows = JSON.parse(r.stdout || "[]");
  return (Array.isArray(rows) ? rows : [rows])
    .filter((p) => p.Start && Date.parse(p.Start) >= sinceMs - 1000 && p.Id !== process.pid)
    .map((p) => ({ pid: p.Id, name: p.Name, start: p.Start, path: p.Path }));
}

function handles(path) {
  if (!HANDLE_EXE) return null;
  const r = spawnSync(HANDLE_EXE, ["-accepteula", "-nobanner", path], { encoding: "utf-8", timeout: 60_000 });
  return (r.stdout || r.stderr || r.error?.message || "").trim().slice(0, 4000);
}

/** Remove the project directory, measuring the first attempt and, on failure, the time until one succeeds. */
async function removal(dir, snapshotSince) {
  const t0 = Date.now();
  try {
    rmSync(dir, { recursive: true, force: true });
    return { firstAttempt: "ok" };
  } catch (e) {
    const first = { code: e.code, path: e.path };
    const atFailure = { survivors: survivors(snapshotSince), handles: handles(dir) };
    for (;;) {
      await new Promise((r) => setTimeout(r, 50));
      try {
        rmSync(dir, { recursive: true, force: true });
        return { firstAttempt: first, removedAfterMs: Date.now() - t0, atFailure };
      } catch (again) {
        if (Date.now() - t0 > 15_000) return { firstAttempt: first, removedAfterMs: null, lastError: again.code, atFailure, atGiveUp: { survivors: survivors(snapshotSince), handles: handles(dir) } };
      }
    }
  }
}

async function once(offline) {
  const offered = (req) => (req.tools ?? []).map((t) => t.function?.name ?? t.name);
  const echo = (req) =>
    offered(req).includes("kiln_preflight")
      ? { toolCalls: [{ name: "kiln_preflight", arguments: { challenge: /[0-9a-f]{32}/.exec(JSON.stringify(req.messages))?.[0] ?? "absent" } }] }
      : { text: FIXTURE_DONE };
  const fixture = await startProviderFixture({ script: [echo] });
  const root = mkdtempSync(join(tmpdir(), "kiln-f11-"));
  const dir = join(root, "project");
  const agentDir = join(root, "agent");
  const link = join(dir, ".planning");
  const result = { offline };
  try {
    mkdirSync(dir);
    mkdirSync(agentDir);
    execFileSync("git", ["init", "-q"], { cwd: dir });
    symlinkSync(ROOT, link, process.platform === "win32" ? "junction" : "dir");
    writeFileSync(join(dir, ".gitignore"), blockText());
    writeFileSync(join(agentDir, "auth.json"), "{}");
    writeFileSync(join(agentDir, "models.json"), JSON.stringify(modelsJson(fixture.url)));
    const port = await freePort();
    const env = { ...process.env, PI_CODING_AGENT_DIR: agentDir, PLANNING_CONTENT_DIR: join(dir, "planning-content"), PORT: String(port), [FIXTURE_KEY_VAR]: FIXTURE_KEY };
    if (offline) env.PI_OFFLINE = "1";
    else delete env.PI_OFFLINE;

    const setup = await run(
      [
        join(ROOT, "bin", "setup.mjs"),
        ...["--project-root", dir, "--name", "F11", "--trust", "approve", "--inspect", "approve"],
        ...["--provider", FIXTURE_PROVIDER, "--model", FIXTURE_MODEL, "--thinking", "off", "--model-use", "approve"],
        ...["--research", "disabled", "--live-model-check", "approve", "--credential-var", FIXTURE_KEY_VAR, "--non-interactive"],
      ],
      { cwd: dir, env }
    );
    result.setup = setup.status;
    if (setup.status !== 0) return { ...result, setupOut: `${setup.stdout}${setup.stderr}`.slice(-1500) };

    // The same build lock the suite takes, so a concurrent suite and this run never build .next at once.
    let startedAt = Date.now();
    const started = await withBuildLock(() => {
      startedAt = Date.now();
      return run([join(ROOT, "bin", "start-kiln.mjs")], { cwd: dir, env }, "KILN-F11-PROMPT\n");
    });
    result.command = { status: started.status, signal: started.signal, ms: started.endedAt - startedAt };
    result.agentExit = /\[kiln\] the agent exited[^\n]*/.exec(started.stdout)?.[0] ?? null;
    result.stopped = /\[kiln\] stopped[^\n]*/.exec(started.stdout)?.[0] ?? null;
    result.downloads = /not found\. Downloading/.test(`${started.stdout}${started.stderr}`);
    result.afterExit = { survivors: survivors(startedAt), port: await answers(port), handles: handles(root) };
    result.removal = await removal(dir, startedAt);
  } finally {
    await fixture.close();
    try {
      rmSync(root, { recursive: true, force: true });
    } catch (e) {
      result.rootLeft = e.code;
    }
  }
  return result;
}

const report = { node: process.version, platform: process.platform, handleExe: Boolean(HANDLE_EXE), runs: [] };
for (let i = 0; i < Number(iterations); i++)
  for (const offline of [false, true]) {
    const r = await once(offline);
    report.runs.push({ i, ...r });
    console.log(JSON.stringify({ i, offline, first: r.removal?.firstAttempt, removedAfterMs: r.removal?.removedAfterMs, survivors: r.afterExit?.survivors?.length, stopped: Boolean(r.stopped) }));
  }
writeFileSync(outFile, JSON.stringify(report, null, 2) + "\n");
