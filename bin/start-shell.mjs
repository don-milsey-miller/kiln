#!/usr/bin/env node
/**
 * The documented one-command launcher — CMP-0020, TSK-0013, and what ACC-0032 and ACC-0033 test.
 *
 * `node bin/start-shell.mjs` installs, builds and starts the application in production mode.
 *
 * ⚠️ IT OWNS ONE CHILD, AND THAT CORRECTION IS THE WHOLE SHAPE OF THIS FILE. DEC-0022 used to say a
 * launcher owns "both the application process and the file watcher" and terminates the watcher with
 * the application. There is no watcher process. The watcher is chokidar, imported dynamically inside
 * the `next start` process and held by the change-stream service in that process's memory; a parent
 * cannot call `changeStream.close()` across that boundary without IPC or a shutdown endpoint, and
 * neither is justified here. So this launcher terminates its CHILD, and process teardown releases
 * anything the child still held. That is a guarantee the operating system makes and this file can be
 * held to — the old one described a call that could not be made, and would have been "satisfied" by
 * a launcher that called nothing and reported success.
 *
 * ⚠️ NEXT IS SPAWNED DIRECTLY, NOT THROUGH `npm run`. `npm` would sit between this process and the
 * server as a second process that also has to be signalled, and on Windows it is a `.cmd` shim whose
 * child does not reliably receive a forwarded signal. The pid this launcher holds must BE the
 * server's, or "terminate the child" means terminating something that merely started the server.
 *
 * ⚠️ THE CONTENT ROOT IS ABSOLUTE AND PRINTED. `resolveContentRoot` refuses to guess (#70) and the
 * application falls back to the running project's own directory, so an operator who never sets the
 * variable still gets a correct answer — and would have no way to know WHICH answer. A tool that
 * reads one directory while the operator believes it reads another is the failure this line exists
 * to prevent, and it costs one `console.log`.
 *
 * ⚠️ INSTALL IS CONDITIONAL AND SAYS WHICH BRANCH IT TOOK. ACC-0033 asks that the command work on a
 * machine with "no prior application state"; running `npm install` on every start would also satisfy
 * that and would make every subsequent start slow enough that nobody uses the documented command,
 * which is how a documented command stops being the one people run.
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(join(dirname(fileURLToPath(import.meta.url)), ".."));
const NEXT = join(ROOT, "node_modules", "next", "dist", "bin", "next");

const PORT = Number(process.env.PORT ?? 3000);
const HOST = "127.0.0.1";
/** How long a child gets to exit on its own before it is killed. */
const GRACE_MS = Number(process.env.VPW_SHUTDOWN_GRACE_MS ?? 8000);

const say = (msg) => console.log(`[vpw] ${msg}`);

/**
 * ⚠️ ABSOLUTE, ALWAYS. A relative content root would resolve against whatever directory the child
 * happened to start in, which is the class of bug #70's refusal-to-guess exists to prevent — and
 * the launcher is exactly where a wrong answer would be invisible.
 */
function contentRoot() {
  const raw = process.env.PLANNING_CONTENT_DIR ?? join(ROOT, "planning-content");
  const abs = resolve(raw);
  if (!existsSync(abs)) {
    console.error(`[vpw] no planning content at ${abs}`);
    console.error(`[vpw] set PLANNING_CONTENT_DIR to the project's planning-content directory.`);
    process.exit(2);
  }
  return abs;
}

/** Run a build-time step to completion, inheriting stdio so the operator sees it. */
function runToCompletion(label, args, env) {
  say(label);
  const r = spawnSync(process.execPath, args, { cwd: ROOT, stdio: "inherit", env });
  if (r.status !== 0) {
    console.error(`[vpw] ${label} failed (exit ${r.status ?? "signal " + r.signal})`);
    process.exit(r.status ?? 1);
  }
}

/** True when dependencies are missing or older than the lockfile that describes them. */
function needsInstall() {
  const modules = join(ROOT, "node_modules");
  if (!existsSync(modules)) return true;
  const lock = join(ROOT, "package-lock.json");
  if (!existsSync(lock)) return false;
  try {
    return statSync(lock).mtimeMs > statSync(modules).mtimeMs;
  } catch {
    return true;
  }
}

/**
 * ⚠️ INSTALL IS THE ONE STEP THAT LEGITIMATELY NEEDS npm, so it is the one place npm is spawned.
 * `npm_execpath` is set when this launcher was itself started through npm, and running that script
 * with the current Node avoids depending on a shim being on PATH; otherwise fall back to the
 * platform's npm, which needs a shell on Windows because it is a `.cmd`.
 */
function installDependencies(env) {
  const viaNode = process.env.npm_execpath;
  if (viaNode && viaNode.endsWith(".js")) {
    runToCompletion("installing dependencies…", [viaNode, "install"], env);
    return;
  }
  say("installing dependencies…");
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const r = spawnSync(npm, ["install"], { cwd: ROOT, stdio: "inherit", env, shell: process.platform === "win32" });
  if (r.status !== 0) {
    console.error(`[vpw] install failed (exit ${r.status ?? "signal " + r.signal})`);
    process.exit(r.status ?? 1);
  }
}

/** Resolve once the port answers, so "started" is an observation rather than a delay. */
async function waitForListening(deadlineMs) {
  const until = Date.now() + deadlineMs;
  for (;;) {
    if (Date.now() > until) return false;
    try {
      const res = await fetch(`http://${HOST}:${PORT}/`, { signal: AbortSignal.timeout(3000) });
      await res.arrayBuffer();
      return true;
    } catch {
      await new Promise((r) => setTimeout(r, 400));
    }
  }
}

async function main() {
  const root = contentRoot();

  // ⚠️ The launcher's own scratch directory, removed on the way out. It holds the run record, which
  // is what a cleanup test reads to learn which pid to look for — and its survival is one of the
  // three things ACC-0032 observes.
  const runDir = mkdtempSync(join(tmpdir(), "vpw-launch-"));

  const env = { ...process.env, NODE_ENV: "production", PLANNING_CONTENT_DIR: root };

  if (needsInstall()) installDependencies(env);
  else say("dependencies present; skipping install");

  runToCompletion("building (production)…", [NEXT, "build"], env);

  say(`planning content root: ${root}`);
  say(`starting on http://${HOST}:${PORT}`);

  // ⚠️ DIRECTLY, so the pid held here IS the server's. `stdio: inherit` keeps the child's output the
  // operator's output; there is nothing this launcher needs to parse out of it.
  const child = spawn(process.execPath, [NEXT, "start", "--hostname", HOST, "--port", String(PORT)], {
    cwd: ROOT,
    env,
    stdio: "inherit",
  });

  writeFileSync(
    join(runDir, "run.json"),
    JSON.stringify({ pid: child.pid, launcherPid: process.pid, port: PORT, host: HOST, contentRoot: root }, null, 2) + "\n"
  );
  say(`run directory: ${runDir}`);

  let shuttingDown = false;
  let childExited = false;

  // ⚠️ Declared BEFORE the handler that calls it. A `const` referenced from a listener registered
  // above it is fine only while the listener never fires first — and the one case where it would is
  // a child that dies immediately, which is exactly when cleanup matters.
  const cleanup = () => {
    // ⚠️ `exists()` afterwards is the criterion, so this must actually remove rather than attempt.
    try {
      rmSync(runDir, { recursive: true, force: true });
    } catch {
      /* reported by the observation, not by a swallowed error */
    }
  };

  child.on("exit", (code, signal) => {
    childExited = true;
    if (!shuttingDown) {
      say(`the application exited on its own (${signal ? `signal ${signal}` : `code ${code}`})`);
      cleanup();
      process.exit(code ?? 1);
    }
  });

  /**
   * ⚠️ FORWARD, WAIT, THEN ESCALATE — in that order and bounded. Killing immediately would give the
   * change-stream service no chance to close its watcher and its subscribers no chance to see the
   * stream end; never escalating would hang the operator's terminal on a child that is not going.
   * On Windows there are no POSIX signals, so a graceful request is not available and `taskkill /T`
   * is both the request and the escalation — the tree flag matters because Next spawns workers.
   */
  const stop = async (why) => {
    if (shuttingDown) return;
    shuttingDown = true;
    say(`${why} — stopping the application…`);

    if (!childExited) {
      if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
      else child.kill("SIGTERM");
    }

    const until = Date.now() + GRACE_MS;
    while (!childExited && Date.now() < until) await new Promise((r) => setTimeout(r, 100));

    if (!childExited) {
      say(`it did not exit within ${GRACE_MS}ms — killing`);
      if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
      else child.kill("SIGKILL");
      const hard = Date.now() + 3000;
      while (!childExited && Date.now() < hard) await new Promise((r) => setTimeout(r, 100));
    }

    cleanup();
    say(childExited ? "stopped." : "stopped, but the child did not report exiting.");
    process.exit(0);
  };

  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"]) process.on(sig, () => void stop(sig));

  /**
   * ⚠️ A STOP THAT WORKS WHEN SIGNALS DO NOT, AND WINDOWS IS WHY. Ctrl+C in a terminal reaches
   * this process as SIGINT on every platform, so the handlers above are the operator's path. But a
   * SUPERVISOR — a test, a task runner, an editor — has no portable way to ask politely: on Windows
   * `process.kill(pid, "SIGTERM")` is `TerminateProcess`, which is a hard kill that no handler sees,
   * so the graceful path above would be unreachable and unprovable there. Measured, not assumed: the
   * first cleanup run sent SIGTERM, the launcher died instantly without running `stop`, and its run
   * directory survived.
   *
   * So when stdin is a pipe rather than a terminal, closing it (or sending `stop`) means stop. That
   * is the same shutdown path, reached by something a parent process can actually do.
   */
  if (!process.stdin.isTTY) {
    process.stdin.setEncoding("utf-8");
    process.stdin.on("data", (chunk) => {
      if (String(chunk).toLowerCase().includes("stop")) void stop("stop received on stdin");
    });
    process.stdin.on("end", () => void stop("stdin closed"));
    process.stdin.resume();
  }

  if (await waitForListening(90_000)) say(`ready — http://${HOST}:${PORT}`);
  else say("the application did not answer within 90s; leaving it running so its output can be read");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
