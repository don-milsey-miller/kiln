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
 * ⚠️ THE CONTENT ROOT IS RESOLVED BY THE SHARED RESOLVER, ABSOLUTE, AND PRINTED BEFORE THE BUILD.
 * `resolveContentRoot` refuses to guess (#70), and this file used to carry a private fallback that
 * disagreed with it — `<toolRoot>/planning-content` rather than the sibling `<toolRoot>/../planning-content`
 * — which is the same directory in this repository and a DIFFERENT project's content in every consumer
 * install. A tool that reads one directory while the operator believes it reads another is the failure
 * the printed line exists to prevent, and a second resolution rule is how it happens. It is printed
 * before install and build rather than after, because the operator should not have to wait out a
 * production build to find out which project was opened.
 *
 * ⚠️ INSTALL IS CONDITIONAL AND SAYS WHICH BRANCH IT TOOK. ACC-0033 asks that the command work on a
 * machine with "no prior application state"; running `npm install` on every start would also satisfy
 * that and would make every subsequent start slow enough that nobody uses the documented command,
 * which is how a documented command stops being the one people run.
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { contentRootCandidate, resolveContentRoot, ContentRootError } from "../lib/content-root.mjs";
import { dependencyState } from "../lib/dependency-freshness.mjs";
import { PROJECT_ID_ENV, RUN_ID_ENV, parsePort, readSuppliedIdentity } from "../lib/run-identity.mjs";

const ROOT = resolve(join(dirname(fileURLToPath(import.meta.url)), ".."));
const NEXT = join(ROOT, "node_modules", "next", "dist", "bin", "next");

/**
 * ⚠️ **PARSED AND REFUSED, NOT COERCED.** This was `Number(process.env.PORT ?? 3000)`, so `PORT=abc`
 * became `NaN` and was handed to `--port` as the string "NaN" — a shell that fails to start for a
 * reason printed nowhere. The parse is shared with the supervisor, which bind-tests the same number.
 */
const port = parsePort(process.env.PORT);
if (port.problem) {
  console.error(`[vpw] ${port.problem}`);
  process.exit(2);
}
const PORT = port.port;
const HOST = "127.0.0.1";
/** How long a child gets to exit on its own before it is killed. */
const GRACE_MS = Number(process.env.VPW_SHUTDOWN_GRACE_MS ?? 8000);

const say = (msg) => console.log(`[vpw] ${msg}`);

/**
 * ⚠️ ABSOLUTE, ALWAYS. A relative content root would resolve against whatever directory the child
 * happened to start in, which is the class of bug #70's refusal-to-guess exists to prevent — and
 * the launcher is exactly where a wrong answer would be invisible.
 *
 * ⚠️ IT ASKS THE SHARED RESOLVER, AND THE PRIVATE FALLBACK IT REPLACED WAS THE BUG. This used to
 * default to `<toolRoot>/planning-content` — the tool's OWN content — while #70's single rule is
 * `<toolRoot>/../planning-content`, the SIBLING directory. In this repository those two happen to
 * name the same real directory, which is why the disagreement survived: every dev run was correct
 * and every consumer install opened Kiln's own 261-artifact history under the consumer's project
 * name, silently, having printed a path that looked right. A second definition of where content
 * lives is #70's exact failure, and the launcher is the worst place to keep one.
 *
 * For this repository, `PLANNING_CONTENT_DIR` is how the dev commands say which project they mean.
 */
function contentRoot() {
  try {
    return resolveContentRoot();
  } catch (e) {
    if (!(e instanceof ContentRootError)) throw e;
    console.error(`[vpw] no planning content at ${contentRootCandidate().path}`);
    console.error(`[vpw] set PLANNING_CONTENT_DIR to the project's planning-content directory.`);
    for (const line of e.message.split("\n")) console.error(`[vpw]   ${line}`);

    // ⚠️ A HINT, NOT A FALLBACK, AND THE DISTINCTION IS THE WHOLE POINT OF #70. This repository is its
    // own consumer, so the sibling rule does not reach its content and `npm start` here refuses. The
    // useful thing to do about that is SAY which directory the operator probably meant; the harmful
    // thing is to open it, which is what the removed fallback did in every consumer install too.
    const own = join(ROOT, "planning-content");
    if (existsSync(own)) {
      console.error(`[vpw]`);
      console.error(`[vpw] This looks like the Kiln repository itself, which is its own consumer.`);
      console.error(`[vpw] Its content is at ${own} — name it explicitly:`);
      console.error(`[vpw]   PowerShell   $env:PLANNING_CONTENT_DIR = (Resolve-Path .\\planning-content).Path`);
      console.error(`[vpw]   sh           PLANNING_CONTENT_DIR="$PWD/planning-content" npm start`);
    }
    process.exit(2);
  }
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
  say(`planning content root: ${root}`);

  /**
   * ⚠️ **THE IDENTITY IS VALIDATED HERE AND PROPAGATED FROM HERE.** The application answers
   * `/health/kiln` from its own environment, so what this passes down IS what the supervisor's
   * handshake will compare against. A malformed value forwarded unchecked would produce a health
   * response that never matches, reported two processes away as a readiness timeout.
   */
  const identity = readSuppliedIdentity(process.env);
  if (identity.mode === "invalid") {
    console.error(`[vpw] ${identity.problem}`);
    process.exit(2);
  }

  const env = {
    ...process.env,
    NODE_ENV: "production",
    PLANNING_CONTENT_DIR: root,
    // ⚠️ Set from the VALIDATED values rather than inherited: `...process.env` would carry whatever
    // was there, and "we checked it" and "we passed the thing we checked" are different claims.
    ...(identity.mode === "supervised"
      ? { [RUN_ID_ENV]: identity.runId, [PROJECT_ID_ENV]: identity.projectId }
      : {}),
  };

  // ⚠️ SAID OUT LOUD, because standalone and supervised differ in how this process can be stopped
  // and in whether anything is polling it. An operator reading the log should not have to infer it.
  say(identity.mode === "supervised" ? `supervised run ${identity.runId}` : "standalone (no supervisor identity)");

  // ⚠️ IT SAYS WHICH BRANCH IT TOOK, AND WHY. An install that happens silently on every start is
  // indistinguishable from one that is needed, which is how the broken condition survived.
  const deps = dependencyState(ROOT);
  if (deps.install) installDependencies(env);
  else say(`dependencies present; skipping install (${deps.why})`);

  runToCompletion("building (production)…", [NEXT, "build"], env);

  say(`starting on http://${HOST}:${PORT}`);

  // ⚠️ CREATED AFTER THE BUILD, AND THAT ORDER IS A FIX RATHER THAN A TIDY-UP. It used to be the first
  // thing `main` did, so every install or build failure leaked one: `runToCompletion` reports and
  // calls `process.exit`, which runs no cleanup, and there is no child yet for the exit handler to be
  // attached to. Measured by `consumer-flow.test.mjs`, which runs this launcher in a tool copy that
  // deliberately has no dependencies — two `vpw-launch-*` directories survived a green suite.
  //
  // The record describes a RUNNING SERVER, so there is nothing to record until there is one. It holds
  // the pid a cleanup test reads, and its removal is one of the three things ACC-0032 observes.
  const runDir = mkdtempSync(join(tmpdir(), "vpw-launch-"));

  // ⚠️ DIRECTLY, so the pid held here IS the server's. Output is inherited — the child's output is
  // the operator's output and there is nothing here to parse out of it.
  //
  // ⚠️ **STDIN IS `ignore`, AND THAT IS THE LAUNCHER'S HALF OF "THE BACKGROUND PROCESS NEVER READS
  // THE TERMINAL".** It was `stdio: "inherit"`, which hands the child whatever this process was
  // given: standalone that is the operator's terminal, and under the supervisor it is the private
  // pipe this launcher's own stop control arrives on. Either way a second reader on that handle
  // steals bytes from the reader that was meant to have them. The application needs no stdin at all,
  // so it is given none — which makes the guarantee structural rather than a matter of who reads first.
  const child = spawn(process.execPath, [NEXT, "start", "--hostname", HOST, "--port", String(PORT)], {
    cwd: ROOT,
    env,
    stdio: ["ignore", "inherit", "inherit"],
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
