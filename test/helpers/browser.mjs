/**
 * A real headless Chromium, driven over the DevTools protocol with no dependencies — for tests that must observe
 * what a browser shows, not what a server sends.
 *
 * ⚠️ **THE SAME APPROACH AS bin/browser-check.mjs, COPIED RATHER THAN IMPORTED.** That file runs its checks when it
 * is loaded and exports nothing. This keeps its smallest CDP client and its browser list, and lets Chromium choose a
 * free debugging port, which it reports in `DevToolsActivePort`, so two runs cannot collide on a fixed one.
 */

import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { PROCESS_TABLE_COMMAND } from "../../lib/supervisor.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const BROWSERS = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
];

/** The first Chromium-based browser on this machine, or null. */
export const findBrowser = () => BROWSERS.find((p) => existsSync(p)) ?? null;

/**
 * Each launch gets two honest readiness phases. A loaded runner may spend most of the first one merely creating
 * Chrome's port file; that time no longer steals the page target's allowance. The sum, per attempt, is the documented
 * outer startup bound, and one clean retry is the only multiplication of it.
 */
export const BROWSER_STARTUP_LIMITS = Object.freeze({ portFileMs: 45_000, pageTargetMs: 30_000, pollMs: 300, attempts: 2 });

/**
 * Start a headless browser on about:blank and attach to its page.
 *
 * @returns {Promise<{page: object, close: () => Promise<void>}>}
 */
export async function launchBrowser(browserPath, options = {}) {
  const requestedLimits = { ...BROWSER_STARTUP_LIMITS, ...(options.limits ?? {}) };
  const limits = { ...requestedLimits, attempts: Math.max(1, Math.min(BROWSER_STARTUP_LIMITS.attempts, requestedLimits.attempts)) };
  const makeProfile = options.makeProfile ?? (() => mkdtempSync(join(tmpdir(), "kiln-browser-")));
  const spawnImpl = options.spawnImpl ?? spawn;
  const removeProfile = options.removeProfile ?? ((profile) => rmSync(profile, { recursive: true, force: true, maxRetries: 17, retryDelay: 100 }));
  const terminate = options.terminate ?? terminateBrowserTree;
  const inspectProcesses = options.inspectProcesses ?? runningProcesses;
  const attach = options.attach ?? attachToPage;
  const failures = [];

  for (let attempt = 1; attempt <= limits.attempts; attempt += 1) {
    const profile = makeProfile();
    const launched = launchAttempt(browserPath, profile, spawnImpl);
    let page = null;
    let closed = false;
    const close = async () => {
      if (closed) return;
      closed = true;
      try {
        page?.close();
      } catch {
        /* already closed */
      }
      let terminationError = null;
      try {
        await terminate(launched.proc);
      } catch (error) {
        terminationError = error;
      }
      let removalError = null;
      try {
        removeProfile(profile);
      } catch (error) {
        removalError = error;
      }
      if (terminationError || removalError)
        throw new Error(
          [terminationError && `process tree: ${terminationError.message}`, removalError && `profile: ${removalError.message}`].filter(Boolean).join("; ")
        );
    };
    try {
      page = await attach(profile, launched.startup, { ...limits, ...(options.readiness ?? {}) });
      return { page, close };
    } catch (error) {
      let processes;
      try {
        processes = sanitiseDiagnostics(inspectProcesses(profile), profile);
      } catch (inspection) {
        processes = { available: false, reason: diagnosticText(inspection?.message ?? inspection, profile) };
      }
      let cleanupError = null;
      try {
        await close();
      } catch (cleanup) {
        cleanupError = diagnosticText(cleanup?.message ?? cleanup, profile);
      }
      failures.push({
        attempt,
        phase: error?.phase ?? "launch",
        ...sanitiseDiagnostics(error?.diagnostics ?? {}, profile),
        startup: startupDiagnostics(launched.startup, profile),
        processes,
        cleanup: { complete: cleanupError === null, error: cleanupError },
      });
      // Retrying without proving cleanup would let the second attempt compete with the process that just failed.
      if (cleanupError !== null) break;
    }
  }

  const diagnostics = { attempts: failures, limits: { portFileMs: limits.portFileMs, pageTargetMs: limits.pageTargetMs, attempts: limits.attempts } };
  console.log(`[browser] start failed: ${JSON.stringify(diagnostics)}`);
  if (process.env.BROWSER_DIAG_OUT)
    try {
      appendFileSync(process.env.BROWSER_DIAG_OUT, JSON.stringify({ at: new Date().toISOString(), ...diagnostics }) + "\n");
    } catch {
      /* the printed line still carries it */
    }
  throw Object.assign(new Error(`the browser did not become ready after ${failures.length} attempt(s): ${JSON.stringify(diagnostics)}`), { diagnostics });
}

function launchAttempt(browserPath, profile, spawnImpl) {
  const args = [
    "--headless=new",
    "--remote-debugging-port=0",
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-gpu",
    "--disable-extensions",
    // ⚠️ CHROME'S OWN LOG ON STDERR, kept as a bounded tail: a start that never wrote DevToolsActivePort said nothing
    // else (CI run 36197842986), and this is where Chrome says what it was doing.
    "--enable-logging=stderr",
    "--v=1",
    // Ubuntu 24.04 restricts the unprivileged user namespaces Chromium's sandbox needs; the page is loopback-only.
    ...(process.platform === "linux" ? ["--no-sandbox"] : []),
    "about:blank",
  ];
  // ⚠️ ITS OWN PROCESS GROUP ON POSIX, so this browser's whole tree can be stopped without touching any other.
  // Killing only the main process left its renderers writing into the profile, and removing it failed (F16).
  const proc = spawnImpl(browserPath, args, { stdio: ["ignore", "ignore", "pipe"], detached: process.platform !== "win32" });
  // ⚠️ **WHY A START FAILED, BOUNDED.** A page that never appeared used to fail with one line and nothing else (CI run
  // 36178450744, Windows Node 22). The browser's exit and the tail of its stderr are kept, at most STDERR_TAIL characters.
  const started = Date.now();
  const startup = { pid: proc.pid ?? null, exit: null, stderrTail: "" };
  proc.stderr?.on("data", (d) => (startup.stderrTail = (startup.stderrTail + d).slice(-STDERR_TAIL)));
  proc.once("exit", (code, signal) => (startup.exit = { code, signal, afterMs: Date.now() - started }));
  return { proc, startup };
}

async function terminateBrowserTree(proc) {
  const running = proc.exitCode === null && proc.signalCode === null;
  const exited = running ? new Promise((r) => proc.once("exit", r)) : Promise.resolve();
  if (process.platform === "win32") {
    if (running) spawnSync("taskkill", ["/pid", String(proc.pid), "/T", "/F"], { stdio: "ignore" });
  } else {
    try {
      process.kill(-proc.pid, "SIGKILL");
    } catch {
      /* the group is already gone */
    }
  }
  await within(exited, 10_000, "the browser leader did not exit after its process tree was terminated");
  // ⚠️ THE GROUP, NOT JUST ITS LEADER: wait until no process of this browser's group remains, within a bound.
  if (process.platform !== "win32") {
    const deadline = Date.now() + 10_000;
    for (;;) {
      try {
        process.kill(-proc.pid, 0);
      } catch {
        break;
      }
      if (Date.now() > deadline) throw new Error(`the browser's process group ${proc.pid} did not exit`);
      await sleep(100);
    }
  }
}

/** The most of the browser's stderr kept for a failed start. */
const STDERR_TAIL = 12_000;

/**
 * Which node, PowerShell and browser processes were running when a start failed: image name and pid only, no command
 * lines, within ten seconds — so a process an earlier Kiln run left behind can be told from one that is the browser's.
 */
function runningProcesses(profile) {
  const [cmd, args] = process.platform === "win32" ? ["tasklist", ["/fo", "csv", "/nh"]] : ["ps", ["-A", "-o", "pid=,comm="]];
  const r = spawnSync(cmd, args, { encoding: "utf-8", timeout: 10_000 });
  if (r.error || r.status !== 0) return { available: false, reason: r.error?.code ?? `${cmd} exited ${r.status}` };
  // Parent pid and creation time from the supervisor's own WMI-free table, so each process can be tied to this launch.
  const table = new Map();
  // ⚠️ WHY THE TABLE WAS OR WAS NOT READ, RECORDED: in CI run 36199281598 it returned no rows and said nothing.
  let tableRead = null;
  if (process.platform === "win32") {
    const at = Date.now();
    const t = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", PROCESS_TABLE_COMMAND.win32[1][3]], { encoding: "utf-8", timeout: 20_000 });
    for (const line of t.stdout?.split(/\r?\n/) ?? []) {
      const m = /^(\d+)\s+(\d+)\s+(\S+)$/.exec(line.trim());
      if (m) table.set(Number(m[1]), { ppid: Number(m[2]), created: m[3] });
    }
    tableRead = { ms: Date.now() - at, status: t.status, signal: t.signal, error: t.error?.code ?? null, rows: table.size, stderrTail: (t.stderr ?? "").slice(-600) };
  }
  const rows = [];
  for (const line of r.stdout.split(/\r?\n/)) {
    const m = process.platform === "win32" ? /^"([^"]*)","(\d+)"/.exec(line) : /^\s*(\d+)\s+(.+)$/.exec(line);
    if (!m) continue;
    const [name, pid] = process.platform === "win32" ? [m[1], Number(m[2])] : [m[2].trim(), Number(m[1])];
    if (/^(node|powershell|pwsh|chrome|msedge|chromium|google-chrome)(\.exe)?$/i.test(name)) rows.push({ name, pid, ...(table.get(pid) ?? {}) });
  }
  return { available: true, tableRead, rows, chrome: chromeProcesses(profile) };
}

/**
 * Every Chrome process with its parent, creation date and command line, which names its role (`--type=`) and its
 * profile, so the processes of a stalled start can be identified. Windows only, through CIM, within twenty seconds;
 * read only when a start has already failed.
 */
function chromeProcesses(profile) {
  if (process.platform !== "win32") return null;
  const script =
    "Get-CimInstance Win32_Process -Filter \"Name='chrome.exe'\" | " +
    "Select-Object ProcessId,ParentProcessId,@{n='Created';e={$_.CreationDate.ToString('o')}},CommandLine | ConvertTo-Json -Compress";
  const at = Date.now();
  const r = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf-8", timeout: 20_000 });
  const read = { ms: Date.now() - at, status: r.status, error: r.error?.code ?? null };
  try {
    const parsed = JSON.parse(r.stdout || "[]");
    return {
      ...read,
      processes: (Array.isArray(parsed) ? parsed : [parsed]).map((p) => {
        const command = String(p.CommandLine ?? "");
        return {
          ProcessId: p.ProcessId,
          ParentProcessId: p.ParentProcessId,
          Created: p.Created,
          Type: /--type=([^\s"]+)/.exec(command)?.[1] ?? "browser",
          UsesAttemptProfile: command.includes(profile),
        };
      }),
    };
  } catch {
    return { ...read, processes: null, stdoutTail: (r.stdout ?? "").slice(-600), stderrTail: (r.stderr ?? "").slice(-600) };
  }
}

export async function attachToPage(profile, startup, options = {}) {
  const now = options.now ?? Date.now;
  const sleepImpl = options.sleep ?? sleep;
  const readPort = options.readPort ?? (() => readFileSync(join(profile, "DevToolsActivePort"), "utf8").split("\n")[0].trim());
  const fetchImpl = options.fetchImpl ?? fetch;
  const connectImpl = options.connectImpl ?? connect;
  const portFileMs = options.portFileMs ?? BROWSER_STARTUP_LIMITS.portFileMs;
  const pageTargetMs = options.pageTargetMs ?? BROWSER_STARTUP_LIMITS.pageTargetMs;
  const pollMs = options.pollMs ?? BROWSER_STARTUP_LIMITS.pollMs;
  const diagnostics = {
    portFile: { limitMs: portFileMs, probes: 0, readyAfterMs: null, lastError: null },
    pageTarget: { limitMs: pageTargetMs, probes: 0, readyAfterMs: null, lastError: null, targetTypes: null },
  };

  const portStarted = now();
  const portDeadline = portStarted + portFileMs;
  let port = null;
  while (port === null) {
    if (startup.exit) throw readinessFailure("port-file", diagnostics, `browser exited before writing DevToolsActivePort`);
    diagnostics.portFile.probes += 1;
    try {
      const candidate = readPort();
      if (!/^\d+$/.test(candidate)) throw new Error("DevToolsActivePort did not contain a numeric port");
      port = candidate;
      diagnostics.portFile.readyAfterMs = now() - portStarted;
      diagnostics.portFile.lastError = null;
    } catch (error) {
      diagnostics.portFile.lastError = shortError(error);
      if (now() >= portDeadline) throw readinessFailure("port-file", diagnostics, `DevToolsActivePort was not ready within ${portFileMs}ms`);
      await sleepImpl(Math.min(pollMs, Math.max(0, portDeadline - now())));
    }
  }

  const targetStarted = now();
  const targetDeadline = targetStarted + pageTargetMs;
  for (;;) {
    if (startup.exit) throw readinessFailure("page-target", diagnostics, `browser exited before exposing a page target`);
    diagnostics.pageTarget.probes += 1;
    try {
      // Bounded, so one probe that never answers cannot carry the wait past its phase deadline.
      const requestMs = Math.min(2_000, Math.max(1, targetDeadline - now()));
      const list = await (await fetchImpl(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(requestMs) })).json();
      diagnostics.pageTarget.targetTypes = list.map((t) => t.type);
      const target = list.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
      if (target) {
        const page = await connectImpl(target.webSocketDebuggerUrl, Math.max(1, targetDeadline - now()));
        diagnostics.pageTarget.readyAfterMs = now() - targetStarted;
        return page;
      }
      diagnostics.pageTarget.lastError = "no page target yet";
    } catch (error) {
      diagnostics.pageTarget.lastError = shortError(error);
    }
    if (now() >= targetDeadline) throw readinessFailure("page-target", diagnostics, `a page target was not ready within ${pageTargetMs}ms`);
    await sleepImpl(Math.min(pollMs, Math.max(0, targetDeadline - now())));
  }
}

const shortError = (error) => `${error?.code ?? error?.cause?.code ?? error?.name ?? "error"}: ${String(error?.message ?? error).slice(0, 200)}`;

function readinessFailure(phase, diagnostics, message) {
  return Object.assign(new Error(message), { phase, diagnostics: structuredClone(diagnostics) });
}

function diagnosticText(value, profile = "") {
  let out = String(value ?? "");
  for (const sensitive of [profile, tmpdir(), homedir(), process.env.USERPROFILE, process.env.HOME].filter(Boolean).sort((a, b) => b.length - a.length))
    out = out.split(sensitive).join(sensitive === profile ? "<browser-profile>" : "<local-path>");
  return out.slice(-STDERR_TAIL);
}

function sanitiseDiagnostics(value, profile) {
  if (Array.isArray(value)) return value.map((item) => sanitiseDiagnostics(item, profile));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sanitiseDiagnostics(item, profile)]));
  return typeof value === "string" ? diagnosticText(value, profile) : value;
}

function startupDiagnostics(startup, profile) {
  return { pid: startup.pid, exit: startup.exit, stderrTail: diagnosticText(startup.stderrTail, profile) };
}

async function connect(url, timeoutMs) {
  const ws = new WebSocket(url);
  try {
    return await within(
      (async () => {
        await new Promise((ok, bad) => {
          ws.onopen = ok;
          ws.onerror = () => bad(new Error("could not attach to the page"));
        });
        let id = 0;
        const pending = new Map();
        const events = [];
        ws.onmessage = (m) => {
          const msg = JSON.parse(m.data);
          if (msg.id && pending.has(msg.id)) {
            const { ok, bad } = pending.get(msg.id);
            pending.delete(msg.id);
            msg.error ? bad(new Error(JSON.stringify(msg.error))) : ok(msg.result);
          } else if (msg.method) events.push(msg);
        };
        const send = (method, params = {}) =>
          new Promise((ok, bad) => {
            const n = ++id;
            pending.set(n, { ok, bad });
            ws.send(JSON.stringify({ id: n, method, params }));
          });
        await send("Page.enable");
        return {
          send,
          /** Every protocol event received, in order: `Page.frameNavigated` among them. */
          events,
          close: () => ws.close(),
          async eval(expression) {
            const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
            if (r.exceptionDetails) throw new Error(r.exceptionDetails.text ?? "evaluation failed");
            return r.result?.value;
          },
          async goto(target) {
            await send("Page.navigate", { url: target });
          },
        };
      })(),
      timeoutMs,
      "the DevTools page target did not accept a connection within its readiness phase"
    );
  } catch (error) {
    try {
      ws.close();
    } catch {
      /* it never opened */
    }
    throw error;
  }
}

function within(promise, timeoutMs, message) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      timer.unref?.();
    }),
  ]).finally(() => clearTimeout(timer));
}

/** Poll `expression` in the page until `done(value)`, or give up after `budgetMs`. */
export async function until(page, expression, done, budgetMs) {
  const deadline = Date.now() + budgetMs;
  let last = null;
  while (Date.now() < deadline) {
    try {
      last = await page.eval(expression);
    } catch {
      last = null; // mid-navigation
    }
    if (done(last)) return { ok: true, value: last };
    await sleep(250);
  }
  return { ok: false, value: last };
}
