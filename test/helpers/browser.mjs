/**
 * A real headless Chromium, driven over the DevTools protocol with no dependencies — for tests that must observe
 * what a browser shows, not what a server sends.
 *
 * ⚠️ **THE SAME APPROACH AS bin/browser-check.mjs, COPIED RATHER THAN IMPORTED.** That file runs its checks when it
 * is loaded and exports nothing. This keeps its smallest CDP client and its browser list, and lets Chromium choose a
 * free debugging port, which it reports in `DevToolsActivePort`, so two runs cannot collide on a fixed one.
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
 * Start a headless browser on about:blank and attach to its page.
 *
 * @returns {Promise<{page: object, close: () => Promise<void>}>}
 */
export async function launchBrowser(browserPath) {
  const profile = mkdtempSync(join(tmpdir(), "kiln-browser-"));
  const args = [
    "--headless=new",
    "--remote-debugging-port=0",
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-gpu",
    "--disable-extensions",
    // Ubuntu 24.04 restricts the unprivileged user namespaces Chromium's sandbox needs; the page is loopback-only.
    ...(process.platform === "linux" ? ["--no-sandbox"] : []),
    "about:blank",
  ];
  // ⚠️ ITS OWN PROCESS GROUP ON POSIX, so this browser's whole tree can be stopped without touching any other.
  // Killing only the main process left its renderers writing into the profile, and removing it failed (F16).
  const proc = spawn(browserPath, args, { stdio: ["ignore", "ignore", "pipe"], detached: process.platform !== "win32" });
  // ⚠️ **WHY A START FAILED, BOUNDED.** A page that never appeared used to fail with one line and nothing else (CI run
  // 36178450744, Windows Node 22). The browser's exit and the tail of its stderr are kept, at most STDERR_TAIL characters.
  const started = Date.now();
  const startup = { exit: null, stderrTail: "" };
  proc.stderr.on("data", (d) => (startup.stderrTail = (startup.stderrTail + d).slice(-STDERR_TAIL)));
  proc.once("exit", (code, signal) => (startup.exit = { code, signal, afterMs: Date.now() - started }));
  let page = null;
  const close = async () => {
    try {
      page?.close();
    } catch {
      /* already closed */
    }
    if (process.platform === "win32") {
      if (proc.exitCode === null && proc.signalCode === null) spawnSync("taskkill", ["/pid", String(proc.pid), "/T", "/F"], { stdio: "ignore" });
    } else {
      try {
        process.kill(-proc.pid, "SIGKILL");
      } catch {
        /* the group is already gone */
      }
    }
    if (proc.exitCode === null && proc.signalCode === null) await new Promise((r) => proc.once("exit", r));
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
    rmSync(profile, { recursive: true, force: true, maxRetries: 17, retryDelay: 100 });
  };
  try {
    page = await attachToPage(profile, startup);
    return { page, close };
  } catch (e) {
    await close();
    throw e;
  }
}

/** The most of the browser's stderr kept for a failed start. */
const STDERR_TAIL = 4000;

/**
 * Which node, PowerShell and browser processes were running when a start failed: image name and pid only, no command
 * lines, within ten seconds — so a process an earlier Kiln run left behind can be told from one that is the browser's.
 */
function runningProcesses() {
  const [cmd, args] = process.platform === "win32" ? ["tasklist", ["/fo", "csv", "/nh"]] : ["ps", ["-A", "-o", "pid=,comm="]];
  const r = spawnSync(cmd, args, { encoding: "utf-8", timeout: 10_000 });
  if (r.error || r.status !== 0) return { available: false, reason: r.error?.code ?? `${cmd} exited ${r.status}` };
  const rows = [];
  for (const line of r.stdout.split(/\r?\n/)) {
    const m = process.platform === "win32" ? /^"([^"]*)","(\d+)"/.exec(line) : /^\s*(\d+)\s+(.+)$/.exec(line);
    if (!m) continue;
    const [name, pid] = process.platform === "win32" ? [m[1], Number(m[2])] : [m[2].trim(), Number(m[1])];
    if (/^(node|powershell|pwsh|chrome|msedge|chromium|google-chrome)(\.exe)?$/i.test(name)) rows.push({ name, pid });
  }
  return { available: true, rows };
}

async function attachToPage(profile, startup) {
  const started = Date.now();
  const deadline = started + 30_000;
  const probe = { probes: 0, portFileAfterMs: null, port: null, lastError: null, targetTypes: null };
  for (;;) {
    if (Date.now() > deadline) {
      const diagnostics = { ...startup, ...probe, waitedMs: Date.now() - started, processes: runningProcesses() };
      console.log(`[browser] start failed: ${JSON.stringify(diagnostics)}`);
      throw Object.assign(new Error(`the browser never exposed a page target: ${JSON.stringify(diagnostics)}`), { diagnostics });
    }
    probe.probes += 1;
    try {
      const port = readFileSync(join(profile, "DevToolsActivePort"), "utf8").split("\n")[0].trim();
      probe.portFileAfterMs ??= Date.now() - started;
      probe.port = port;
      // Bounded, so one probe that never answers cannot carry the wait past its deadline.
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(2000) })).json();
      probe.targetTypes = list.map((t) => t.type);
      const target = list.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
      if (target) return await connect(target.webSocketDebuggerUrl);
      probe.lastError = "no page target yet";
    } catch (e) {
      probe.lastError = `${e?.code ?? e?.cause?.code ?? e?.name ?? "error"}: ${String(e?.message ?? e).slice(0, 200)}`;
    }
    await sleep(300);
  }
}

async function connect(url) {
  const ws = new WebSocket(url);
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
