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
  let pendingMs = null;
  let id = 0;
  let set = 0;
  return {
    api: {
      setTimeout(fn, ms) {
        pending = fn;
        pendingMs = ms;
        set += 1;
        return ++id;
      },
      clearTimeout() {
        pending = null;
        pendingMs = null;
      },
    },
    get armed() {
      return pending !== null;
    },
    /** The delay of the one timer that is waiting, or null. */
    get ms() {
      return pendingMs;
    },
    /** How many timers were ever set. */
    get set() {
      return set;
    },
    expire() {
      const fn = pending;
      pending = null;
      pendingMs = null;
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

/* ------------------------------------------------------------------ a page that is leaving (#213) */

test("⚠️ #213 once a navigation has started, the stream and the deadline are closed and the page says it is stale", () => {
  const h = harness();
  h.wd.start();
  const s = h.source();
  s.fire("open");
  assert.equal(h.timers.ms, 15000, "the heartbeat deadline is armed before leaving");

  h.wd.leaving();
  assert.equal(s.closed, true, "the stream is closed");
  assert.equal(h.wd.connected, false);
  assert.equal(h.timers.armed, false, "the heartbeat deadline is cleared, and no other timer takes its place");
  assert.equal(h.wd.state, STATE.STALE, "a page that stays after all must not go on claiming a stream it closed");
  assert.equal(h.states.at(-1), STATE.STALE, "and the component is told");
});

test("⚠️ #213 leaving is final: no reload, no timer, no new stream and no return to live, whatever arrives", () => {
  const h = harness();
  h.wd.start();
  const s = h.source();
  s.fire("open");
  h.wd.leaving();
  const timersSet = h.timers.set;
  const statesSeen = h.states.length;

  // Everything that reloads or revives a page that is staying, delivered to one that is leaving.
  for (const event of ["change", "error", "open", "heartbeat", "failure", "open", "change"]) s.fire(event);
  h.timers.expire();
  h.wd.start();
  h.wd.leaving();

  assert.equal(h.reloadCount(), 0, "a reload requested now would run after the new page commits");
  assert.equal(h.timers.set, timersSet, "no timer is set after leaving");
  assert.equal(h.timers.armed, false);
  assert.equal(h.made.length, 1, "no second stream is opened, by an event or by start()");
  assert.equal(h.wd.connected, false);
  assert.equal(h.wd.state, STATE.STALE, "the state does not come back to live");
  assert.equal(h.states.length, statesSeen, "and the component is told nothing more");
});

test("⚠️ #213 the same change hint reloads a page that is staying and not one that is leaving", () => {
  // The order CI and the local reproduction recorded: the navigation starts, then the hint arrives.
  const leaving = harness();
  leaving.wd.start();
  leaving.source().fire("open");
  leaving.wd.leaving();
  leaving.source().fire("change");
  assert.equal(leaving.reloadCount(), 0);

  const staying = harness();
  staying.wd.start();
  staying.source().fire("open");
  staying.source().fire("change");
  assert.equal(staying.reloadCount(), 1);
});

test("⚠️ #213 a reconnection reloads a page that is staying and not one that is leaving", () => {
  const leaving = harness();
  leaving.wd.start();
  leaving.source().fire("open");
  leaving.source().fire("error");
  leaving.wd.leaving();
  leaving.source().fire("open");
  assert.equal(leaving.reloadCount(), 0);

  const staying = harness();
  staying.wd.start();
  staying.source().fire("open");
  staying.source().fire("error");
  staying.source().fire("open");
  assert.equal(staying.reloadCount(), 1);
});

test("#213 the watchdog's own reload is requested once, and leaving after it changes nothing", () => {
  const h = harness();
  h.wd.start();
  h.source().fire("open");
  h.source().fire("change"); // the watchdog's own reload, which then fires beforeunload
  h.wd.leaving();
  h.source().fire("change");
  assert.equal(h.reloadCount(), 1);
  assert.equal(h.timers.armed, false);
});

test("#213 a page that leaves before its stream ever opened is closed and stale, and stays so", () => {
  const h = harness();
  h.wd.start();
  h.wd.leaving();
  assert.equal(h.source().closed, true);
  assert.equal(h.wd.state, STATE.STALE);
  h.source().fire("open");
  assert.equal(h.wd.state, STATE.STALE);
  assert.equal(h.reloadCount(), 0);
  assert.equal(h.timers.set, 0, "no timer was ever set");
});

test("#213 leaving before start() opens nothing, and stop() after leaving is still clean", () => {
  const h = harness();
  h.wd.leaving();
  h.wd.start();
  assert.equal(h.made.length, 0, "a document that is leaving never opens a stream");
  assert.equal(h.wd.state, STATE.STALE);
  h.wd.stop();
  assert.equal(h.timers.armed, false);
  assert.equal(h.wd.connected, false);
});

test("#213 leaving after stop() does nothing, not even to the state", () => {
  const h = harness();
  h.wd.start();
  h.source().fire("open");
  h.wd.stop();
  const state = h.wd.state;
  h.wd.leaving();
  assert.equal(h.wd.state, state);
  assert.equal(h.timers.armed, false);
});

/* ------------------------------------------------------------------ the component's own rules */

test("#213 the component tells the watchdog when a navigation starts, and stops listening on unmount", () => {
  const src = readFileSync(join(ROOT, "app", "_stream", "watchdog.js"), "utf-8");
  assert.ok(src.includes(`const leaving = () => wd.leaving();`));
  assert.ok(src.includes(`window.addEventListener("beforeunload", leaving);`), "beforeunload is the event that says a navigation has started");
  assert.ok(src.includes(`window.removeEventListener("beforeunload", leaving);`));
  // ⚠️ Preventing the event, or returning a value from it, makes the browser ask the operator whether to leave.
  assert.ok(!/preventDefault|returnValue|onbeforeunload/.test(src), "the handler must not turn into a leave-page prompt");
});

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

/* ------------------------------------------------ the browser's brand check, emulated in Node */

test("⚠️ the DEFAULT timers survive a WebIDL brand check — the defect a real browser found", async () => {
  // ⚠️ THIS TEST EXISTS BECAUSE THIRTEEN PASSING TESTS ABOVE MISSED A TOTAL FAILURE. The default was
  // `timers = { setTimeout, clearTimeout }`. In Node that works. In a browser, calling it as
  // `timers.setTimeout(...)` passes `timers` as `this`, `Window.setTimeout`'s brand check rejects it,
  // and the call throws `TypeError: Illegal invocation` inside an event listener that swallows it.
  // The shipped page went live and never armed its watchdog: permanently reassuring, exactly the
  // failure AST-0034 says this component is the only defence against.
  //
  // Everything above injects timers, so none of it could see the default at all. This calls the real
  // default, with `globalThis.setTimeout` temporarily wrapped in the same brand check a browser
  // applies — throw unless `this` is the global or absent.
  const realSet = globalThis.setTimeout;
  const realClear = globalThis.clearTimeout;
  const brandChecked = function (...args) {
    if (this !== undefined && this !== globalThis) throw new TypeError("Illegal invocation");
    return realSet.apply(globalThis, args);
  };
  globalThis.setTimeout = brandChecked;
  globalThis.clearTimeout = function (...args) {
    if (this !== undefined && this !== globalThis) throw new TypeError("Illegal invocation");
    return realClear.apply(globalThis, args);
  };

  try {
    const { ES, made } = fakeEventSource();
    let state = null;
    // ⚠️ NO `timers` ARGUMENT. That is the whole point: the default is what ships.
    const wd = createStreamWatchdog({
      EventSourceImpl: ES,
      watchdogMs: 20,
      reload: () => {},
      onState: (s) => (state = s),
    });
    wd.start();
    made[0].fire("open"); // arms the watchdog through the default timers

    assert.equal(state, STATE.LIVE, "the open handler must survive arming the watchdog");
    await new Promise((r) => realSet(r, 80));
    assert.equal(state, STATE.STALE, "the default timers must actually fire — a page that cannot arm never goes stale");
    wd.stop();
  } finally {
    globalThis.setTimeout = realSet;
    globalThis.clearTimeout = realClear;
  }
});
