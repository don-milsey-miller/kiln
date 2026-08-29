#!/usr/bin/env node
/**
 * ACC-0029 and ACC-0030, in a real browser — the two criteria that stayed `not-evaluated` because
 * everything else about the change-stream client could be decided in Node and these two could not.
 *
 * `node bin/browser-check.mjs`
 *
 * ⚠️ NOTHING IS INJECTED. No fake `EventSource`, no fake timers, no shortened watchdog. The page
 * under test is the shipped one, the `EventSource` is the browser's, the reconnection is the
 * browser's own, and both clocks run at real speed. `test/stream-watchdog.test.mjs` proves the logic
 * that WOULD produce this behaviour; only this file observes the behaviour.
 *
 * ⚠️ THE STALE CASE IS PROVOKED BY DELAYING HEARTBEATS, NOT BY BREAKING THE CONNECTION. The server's
 * interval is set beyond the client's 15s window, so the socket stays open and healthy while nothing
 * arrives on it. That is AST-0034's finding exactly — an idle stream and a dead one are
 * byte-identical — and it is the only way to show the watchdog is what makes the difference visible.
 *
 * ⚠️ IT DRIVES THE BROWSER OVER CDP WITH NO DEPENDENCIES. Node has a global `WebSocket`, and Chrome
 * and Edge both ship a debugging protocol; adding Playwright to observe two state changes would
 * install a browser and a toolchain to answer a question the browser already on the machine can
 * answer. If no Chromium-based browser is found this exits 3 and says so, rather than pretending.
 */

import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, mkdtempSync, rmSync, cpSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const execFileP = promisify(execFile);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const NEXT = join(ROOT, "node_modules", "next", "dist", "bin", "next");
const PORT = 4416;
const CDP_PORT = 9333;
const HOST = "127.0.0.1";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const BROWSERS = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
];

const findBrowser = () => BROWSERS.find((p) => existsSync(p)) ?? null;

async function killTree(proc) {
  if (!proc || proc.exitCode !== null) return;
  try {
    if (process.platform === "win32") await execFileP("taskkill", ["/pid", String(proc.pid), "/T", "/F"]);
    else proc.kill("SIGKILL");
  } catch {
    /* already gone */
  }
  await sleep(400);
}

/* ------------------------------------------------------------------ the smallest CDP client */

/** One page, driven over the DevTools protocol. */
async function attachToPage() {
  const until = Date.now() + 30_000;
  for (;;) {
    if (Date.now() > until) throw new Error("the browser never exposed a page target");
    try {
      const list = await (await fetch(`http://${HOST}:${CDP_PORT}/json/list`)).json();
      const page = list.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
      if (page) {
        const ws = new WebSocket(page.webSocketDebuggerUrl);
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
          } else if (msg.method) {
            events.push(msg);
          }
        };
        const send = (method, params = {}) =>
          new Promise((ok, bad) => {
            const n = ++id;
            pending.set(n, { ok, bad });
            ws.send(JSON.stringify({ id: n, method, params }));
          });
        return {
          send,
          events,
          close: () => ws.close(),
          /** Evaluate in the page and return the value. */
          async eval(expression) {
            const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
            if (r.exceptionDetails) throw new Error(r.exceptionDetails.text ?? "evaluation failed");
            return r.result?.value;
          },
          async goto(target) {
            await send("Page.enable");
            await send("Page.navigate", { url: target });
          },
        };
      }
    } catch {
      /* not up yet */
    }
    await sleep(400);
  }
}

/** What the indicator currently says — text, icon shape, colour, and the state attribute. */
const READ_INDICATOR = `(() => {
  const el = document.querySelector('[data-vpw-stream]');
  if (!el) return null;
  const svg = el.querySelector('svg');
  return {
    state: el.getAttribute('data-vpw-stream'),
    text: (el.textContent || '').trim(),
    colour: getComputedStyle(el).color,
    icon: svg ? Array.from(svg.querySelectorAll('path,circle')).map(n => n.getAttribute('d') || ('circle:' + n.getAttribute('r'))).join('|') : null,
  };
})()`;

/** Poll the page until `read` satisfies `done`, or give up. */
async function until(page, expression, done, budgetMs, label) {
  const deadline = Date.now() + budgetMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await page.eval(expression);
    if (done(last)) return { ok: true, value: last, waitedMs: budgetMs - (deadline - Date.now()) };
    await sleep(500);
  }
  return { ok: false, value: last, waitedMs: budgetMs, label };
}

/* ------------------------------------------------------------------ the server under test */

function startServer(contentRoot, extraEnv = {}) {
  return spawn(process.execPath, [NEXT, "start", "--hostname", HOST, "--port", String(PORT)], {
    cwd: ROOT,
    env: { ...process.env, NODE_ENV: "production", PLANNING_CONTENT_DIR: contentRoot, ...extraEnv },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

async function waitForServer(budgetMs = 90_000) {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://${HOST}:${PORT}/`, { signal: AbortSignal.timeout(4000) });
      await res.arrayBuffer();
      return true;
    } catch {
      await sleep(400);
    }
  }
  return false;
}

/* ------------------------------------------------------------------ the run */

async function main() {
  const browserPath = findBrowser();
  if (!browserPath) {
    console.error("No Chromium-based browser found. ACC-0029 and ACC-0030 stay not-evaluated.");
    process.exit(3);
  }

  console.error(`browser: ${browserPath}`);
  console.error("building…");
  rmSync(join(ROOT, ".next"), { recursive: true, force: true });
  await execFileP(process.execPath, [NEXT, "build"], { cwd: ROOT, timeout: 600_000, maxBuffer: 32 << 20 });

  // A COPY, so a content change made mid-run never touches the project's own planning content.
  const work = mkdtempSync(join(tmpdir(), "vpw-browser-"));
  const contentRoot = join(work, "planning-content");
  cpSync(join(ROOT, "planning-content"), contentRoot, { recursive: true });
  const profile = join(work, "profile");

  const browser = spawn(
    browserPath,
    [
      "--headless=new",
      `--remote-debugging-port=${CDP_PORT}`,
      `--user-data-dir=${profile}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-gpu",
      "--disable-extensions",
      "about:blank",
    ],
    { stdio: ["ignore", "pipe", "pipe"] }
  );

  let server = null;
  let page = null;
  const result = { browser: browserPath, acc0029: null, acc0030: null };

  try {
    page = await attachToPage();

    /* ============================================================ ACC-0029: a stopped heartbeat */

    // ⚠️ The server's heartbeat is pushed WELL beyond the client's 15s window. One frame arrives on
    // subscribe (the route sends it immediately) and the next is 10 minutes away, so the connection
    // stays open and silent — an idle stream that is indistinguishable, on the wire, from a dead one.
    console.error("ACC-0029: starting with heartbeats delayed past the watchdog window…");
    server = startServer(contentRoot, { VPW_HEARTBEAT_MS: "600000" });
    if (!(await waitForServer())) throw new Error("the server never became ready");

    await page.send("Network.enable");
    await page.goto(`http://${HOST}:${PORT}/`);
    await sleep(2500);

    const live = await until(page, READ_INDICATOR, (v) => v && v.state === "live", 30_000, "never went live");
    if (!live.ok) throw new Error(`the indicator never reported a live stream: ${JSON.stringify(live.value)}`);
    console.error(`  live after ${(live.waitedMs / 1000).toFixed(1)}s: ${JSON.stringify(live.value)}`);

    const stale = await until(page, READ_INDICATOR, (v) => v && v.state === "stale", 40_000, "never went stale");
    console.error(`  stale after ${(stale.waitedMs / 1000).toFixed(1)}s: ${JSON.stringify(stale.value)}`);

    // ⚠️ THE CONNECTION MUST STILL BE OPEN, AND THIS IS OBSERVED RATHER THAN ARGUED. If the socket
    // had simply dropped, the page would have gone stale down the ERROR path and this test would be
    // about something else entirely — the watchdog would never have been the thing that fired. So
    // the browser's own network events are read: the `/events` request must have received a response
    // and must NOT have finished or failed.
    const eventsReq = page.events.filter((e) => e.params?.request?.url?.endsWith("/events") || e.params?.response?.url?.endsWith("/events"));
    const streamIds = new Set(eventsReq.map((e) => e.params.requestId));
    const responded = page.events.some((e) => e.method === "Network.responseReceived" && streamIds.has(e.params.requestId));
    const ended = page.events.some(
      (e) => (e.method === "Network.loadingFinished" || e.method === "Network.loadingFailed") && streamIds.has(e.params.requestId)
    );
    const streamStillOpen = responded && !ended;

    result.acc0029 = {
      passed:
        stale.ok &&
        streamStillOpen &&
        live.value.text !== stale.value.text &&
        /receiving updates/i.test(live.value.text) &&
        /not receiving updates/i.test(stale.value.text) &&
        live.value.icon !== stale.value.icon,
      live: live.value,
      stale: stale.value,
      wentStaleAfterMs: stale.waitedMs,
      textChanged: live.value.text !== stale.value.text,
      iconChanged: live.value.icon !== stale.value.icon,
      colourChanged: live.value.colour !== stale.value.colour,
      streamStillOpen,
      streamRequestsSeen: streamIds.size,
    };

    /* ============================================================ ACC-0030: reconnect and recover */

    console.error("ACC-0030: restarting the server under a live page…");
    await killTree(server);
    server = null;

    // The change the page must end up showing. `data-vpw-current` is derived from attestations, so
    // making the first stage unready moves it — the same lever the smoke test uses.
    const attestations = join(contentRoot, "state", "stage-attestations", "01-intake.json");
    const doc = JSON.parse(readFileSync(attestations, "utf-8"));
    const firstCriterion = Object.keys(doc.attestations)[0];
    const originalCurrent = await page.eval(
      `(document.querySelector('[data-vpw-current]')?.getAttribute('data-vpw-current')) ?? null`
    );
    doc.attestations[firstCriterion] = {
      result: "not-satisfied",
      decidedBy: "browser-check",
      reason: "Temporary, in a copy: proving a page reconnects and picks up what changed while it was disconnected.",
    };
    writeFileSync(attestations, JSON.stringify(doc, null, 2) + "\n");

    // ⚠️ THE SAME PRODUCTION BUILD, restarted. Rebuilding would confuse "the page reloaded and read
    // fresh content" with "the page reloaded and got a different bundle".
    await sleep(2500);
    server = startServer(contentRoot, { VPW_HEARTBEAT_MS: "5000" });
    if (!(await waitForServer())) throw new Error("the server never came back");

    const recovered = await until(
      page,
      `(document.querySelector('[data-vpw-current]')?.getAttribute('data-vpw-current')) ?? null`,
      (v) => v === "01-intake",
      60_000,
      "the page never picked up the change"
    );
    console.error(`  current stage after ${(recovered.waitedMs / 1000).toFixed(1)}s: ${recovered.value}`);

    const backLive = await until(page, READ_INDICATOR, (v) => v && v.state === "live", 30_000, "never returned to live");
    console.error(`  indicator back to: ${JSON.stringify(backLive.value)}`);

    const finalUrl = await page.eval("location.pathname + location.search");

    result.acc0030 = {
      passed: recovered.ok && recovered.value === "01-intake" && backLive.ok,
      originalCurrent,
      afterReconnect: recovered.value,
      recoveredAfterMs: recovered.waitedMs,
      indicatorAfter: backLive.value,
      urlPreserved: finalUrl === "/",
      finalUrl,
    };
  } finally {
    page?.close();
    await killTree(server);
    await killTree(browser);
    rmSync(work, { recursive: true, force: true });
  }

  console.log(JSON.stringify(result, null, 2));
  if (!result.acc0029?.passed || !result.acc0030?.passed) process.exitCode = 2;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
