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
  const proc = spawn(browserPath, args, { stdio: ["ignore", "ignore", "ignore"], detached: process.platform !== "win32" });
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
    page = await attachToPage(profile);
    return { page, close };
  } catch (e) {
    await close();
    throw e;
  }
}

async function attachToPage(profile) {
  const deadline = Date.now() + 30_000;
  for (;;) {
    if (Date.now() > deadline) throw new Error("the browser never exposed a page target");
    try {
      const port = readFileSync(join(profile, "DevToolsActivePort"), "utf8").split("\n")[0].trim();
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const target = list.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
      if (target) return await connect(target.webSocketDebuggerUrl);
    } catch {
      /* not up yet */
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
