/**
 * The client watchdog's logic, with `EventSource` and timers injected — TSK-0017.
 *
 * ⚠️ THESE DO NOT EVALUATE ACC-0029 OR ACC-0030. Those criteria are about what a PAGE does — a
 * visibly stale indication within the watchdog window, and a reconnection that reloads and recovers
 * a missed change. What is proven here is the logic that would produce that behaviour, in Node, with
 * a fake EventSource. No browser was available, so the page-level behaviour has not been observed
 * and both criteria stay `not-evaluated`. Marking them on the strength of this file would be
 * claiming a measurement that was never taken.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createStreamWatchdog, STATE } from "../app/_stream/logic.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** An EventSource the test drives, counting how many were ever constructed. */
function fakeEventSource() {
  const made = [];
  class ES {
    constructor(url) {
      this.url = url;
      this.closed = false;
      this.handlers = {};
      made.push(this);
    }
    addEventListener(type, fn) {
      (this.handlers[type] ??= []).push(fn);
    }
    close() {
      this.closed = true;
    }
    fire(type, data) {
      for (const fn of this.handlers[type] ?? []) fn({ data });
    }
  }
  return { ES, made };
}

function fakeTimers() {
  let pending = null;
  let id = 0;
  return {
    api: {
      setTimeout(fn) {
        pending = fn;
        return ++id;
      },
      clearTimeout() {
        pending = null;
      },
    },
    get armed() {
      return pending !== null;
    },
    expire() {
      const fn = pending;
      pending = null;
      fn?.();
    },
  };
}

function harness({ watchdogMs = 15000 } = {}) {
  const { ES, made } = fakeEventSource();
  const timers = fakeTimers();
  const states = [];
  let reloads = 0;
  const wd = createStreamWatchdog({
    EventSourceImpl: ES,
    timers: timers.api,
    watchdogMs,
    reload: () => (reloads += 1),
    onState: (s) => states.push(s),
  });
  return { wd, made, timers, states, reloadCount: () => reloads, source: () => made[made.length - 1] };
}

/* ------------------------------------------------------------------ connection vs reconnection */

test("⚠️ the FIRST open goes live and does not reload", () => {
  const h = harness();
  h.wd.start();
  h.source().fire("open");

  assert.equal(h.wd.state, STATE.LIVE);
  assert.equal(h.reloadCount(), 0, "reloading on the first open is a page that never settles");
  assert.equal(h.timers.armed, true, "and the watchdog is armed");
});

test("⚠️ a RECONNECTION reloads — the gap is unrecoverable by design", () => {
  const h = harness();
  h.wd.start();
  h.source().fire("open");
  h.source().fire("error"); // the connection drops
  assert.equal(h.wd.state, STATE.STALE);

  h.source().fire("open"); // EventSource reconnects on its own
  assert.equal(h.reloadCount(), 1, "the server keeps no buffer, so only a reload is correct");
});

test("an open with nothing wrong in between does not reload", () => {
  // Guards the distinction from being implemented as "reload on every open after the first".
  const h = harness();
  h.wd.start();
  h.source().fire("open");
  h.source().fire("heartbeat");
  h.source().fire("open");
  assert.equal(h.reloadCount(), 0);
});

/* ------------------------------------------------------------------ the watchdog */

test("each named heartbeat resets the deadline and restores live", () => {
  const h = harness();
  h.wd.start();
  h.source().fire("open");
  h.timers.expire();
  assert.equal(h.wd.state, STATE.STALE, "no heartbeat within the window means stale");

  h.source().fire("heartbeat");
  assert.equal(h.wd.state, STATE.LIVE, "a heartbeat brings it back");
  assert.equal(h.timers.armed, true, "and re-arms the deadline");
});

test("⚠️ watchdog expiry goes stale even though the connection still looks open", () => {
  // The whole reason the watchdog exists: AST-0034 measured an idle stream and a dead stream as
  // byte-identical, so "still connected" proves nothing.
  const h = harness();
  h.wd.start();
  h.source().fire("open");
  assert.equal(h.wd.state, STATE.LIVE);

  h.timers.expire();
  assert.equal(h.wd.state, STATE.STALE);
  assert.equal(h.source().closed, false, "the socket was never closed — that is the point");
});

test("a watcher-failure event goes stale immediately, without waiting for the window", () => {
  const h = harness();
  h.wd.start();
  h.source().fire("open");
  h.source().fire("failure");

  assert.equal(h.wd.state, STATE.STALE);
  assert.equal(h.timers.armed, false, "and stops waiting for a heartbeat that will never come");
});

/* ------------------------------------------------------------------ change hints */

test("a change hint reloads", () => {
  const h = harness();
  h.wd.start();
  h.source().fire("open");
  h.source().fire("change");
  assert.equal(h.reloadCount(), 1);
});

test("⚠️ several change hints reload once, not once each", () => {
  const h = harness();
  h.wd.start();
  h.source().fire("open");
  h.source().fire("change");
  h.source().fire("change");
  h.source().fire("change");
  assert.equal(h.reloadCount(), 1, "the page is leaving; a second reload is a loop");
});

/* ------------------------------------------------------------------ lifecycle */

test("start() twice makes one EventSource, not two", () => {
  // React can invoke an effect twice. A second source would double every heartbeat and leave one
  // connection with nothing to close it.
  const h = harness();
  h.wd.start();
  h.wd.start();
  assert.equal(h.made.length, 1);
});

test("stop() closes the connection, clears the timer, and refuses to restart", () => {
  const h = harness();
  h.wd.start();
  h.source().fire("open");

  h.wd.stop();
  assert.equal(h.source().closed, true);
  assert.equal(h.timers.armed, false);
  assert.equal(h.wd.connected, false);

  h.wd.start();
  assert.equal(h.made.length, 1, "a stopped watchdog stays stopped");
});

test("a change hint after unmount does not reload", () => {
  const h = harness();
  h.wd.start();
  const s = h.source();
  h.wd.stop();
  s.fire("change");
  assert.equal(h.reloadCount(), 0, "an unmounted page must not navigate");
});

/* ------------------------------------------------------------------ the component's own rules */

test("the component reloads in place, preserving the URL", () => {
  const src = readFileSync(join(ROOT, "app", "_stream", "watchdog.js"), "utf-8");
  assert.match(src, /location\.reload\(\)/, "reload() keeps the current URL");
  assert.ok(!/location\.href\s*=/.test(src), "assigning href would discard the selection in the URL");
  assert.ok(!/location\.assign|location\.replace/.test(src), "same reason");
});

test("live and stale are distinguished by TEXT, not by colour alone", () => {
  const src = readFileSync(join(ROOT, "app", "_stream", "watchdog.js"), "utf-8");
  for (const word of ["Receiving updates", "Not receiving updates"])
    assert.ok(src.includes(word), `the state must be readable as words: missing ${JSON.stringify(word)}`);
});
