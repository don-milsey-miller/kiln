/**
 * The change-stream service — TSK-0011, ACC-0028 and ACC-0031.
 *
 * ⚠️ THE WATCHER AND THE TIMERS ARE INJECTED, so failure, heartbeat, disconnect and cleanup are
 * decided by the test rather than waited for. A suite that slept five seconds hoping for a heartbeat
 * would be slow AND flaky, and a watcher failure is not something a real filesystem can be asked to
 * produce on demand.
 *
 * ⚠️ What is NOT faked is the module under test. The service is the one the route imports; only its
 * two collaborators are supplied.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createChangeStream, EVENTS } from "../lib/change-stream.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** A watcher whose events the test fires, and which records whether it was closed. */
function fakeWatcher() {
  const handlers = {};
  const w = {
    closed: false,
    on(event, fn) {
      (handlers[event] ??= []).push(fn);
      return w;
    },
    close() {
      w.closed = true;
    },
    fire(event, arg) {
      for (const fn of handlers[event] ?? []) fn(arg);
    },
  };
  return w;
}

/** Timers the test advances by hand. */
function fakeTimers() {
  const running = new Map();
  let next = 1;
  return {
    cleared: [],
    api: {
      setInterval(fn) {
        running.set(next, fn);
        return next++;
      },
      clearInterval(id) {
        running.delete(id);
      },
    },
    get liveCount() {
      return running.size;
    },
    tick() {
      for (const fn of [...running.values()]) fn();
    },
  };
}

function harness({ heartbeatMs = 1000 } = {}) {
  const watcher = fakeWatcher();
  const timers = fakeTimers();
  let created = 0;
  const stream = createChangeStream({
    watchDir: "/nowhere",
    heartbeatMs,
    createWatcher: async () => {
      created += 1;
      return watcher;
    },
    timers: timers.api,
  });
  const client = () => {
    const events = [];
    let closed = false;
    return {
      events,
      get closed() {
        return closed;
      },
      handlers: { send: (event, data) => events.push({ event, data }), close: () => (closed = true) },
    };
  };
  return { stream, watcher, timers, client, createdCount: () => created };
}

/* ------------------------------------------------------------------ lazy start */

test("⚠️ nothing starts until someone subscribes", async () => {
  const h = harness();
  assert.equal(h.createdCount(), 0, "creating the service must not create a watcher");
  assert.equal(h.stream.watching, false);
  assert.equal(h.timers.liveCount, 0, "and no timer");

  await h.stream.subscribe(h.client().handlers);
  assert.equal(h.createdCount(), 1, "the first subscriber starts it");
  assert.equal(h.stream.watching, true);
});

test("the service module starts no watcher merely by being imported", () => {
  // `next build` imports every route module to collect page data. A watcher started at import would
  // run during the build and outlive it.
  const src = readFileSync(join(ROOT, "lib", "change-stream.mjs"), "utf-8");
  assert.ok(!/^import .*chokidar/m.test(src), "chokidar must not be a static import");
  assert.match(src, /await import\("chokidar"\)/, "it is loaded inside the factory, on demand");

  const route = readFileSync(join(ROOT, "app", "events", "route.js"), "utf-8");
  assert.ok(
    !/^const service = createChangeStream/m.test(route),
    "the route must not build the service at module scope"
  );
});

/* ------------------------------------------------------------------ heartbeat */

test("a heartbeat is a NAMED event carrying data", async () => {
  const h = harness();
  const c = h.client();
  await h.stream.subscribe(c.handlers);
  h.timers.tick();

  const beat = c.events.find((e) => e.event === EVENTS.HEARTBEAT);
  assert.ok(beat, "a comment frame would fire nothing in a client (AST-0036)");
  assert.equal(beat.event, "heartbeat");
  assert.deepEqual(beat.data, { ok: true }, "with data, so a listener receives something");
});

/* ------------------------------------------------------------------ several subscribers */

test("⚠️ one subscriber leaving does not stop the others", async () => {
  const h = harness();
  const a = h.client();
  const b = h.client();
  const dropA = await h.stream.subscribe(a.handlers);
  await h.stream.subscribe(b.handlers);
  assert.equal(h.stream.subscriberCount, 2);

  dropA();
  assert.equal(h.stream.subscriberCount, 1);
  assert.equal(h.stream.watching, true, "the shared watcher must survive one disconnect");
  assert.equal(h.watcher.closed, false);

  h.watcher.fire("all");
  assert.ok(b.events.some((e) => e.event === EVENTS.CHANGE), "the remaining subscriber still hears changes");
  assert.ok(!a.events.some((e) => e.event === EVENTS.CHANGE), "and the departed one does not");
});

test("a subscriber's timer goes with it, and the watcher closes when the last one leaves", async () => {
  const h = harness();
  const dropA = await h.stream.subscribe(h.client().handlers);
  const dropB = await h.stream.subscribe(h.client().handlers);
  assert.equal(h.timers.liveCount, 2, "one timer per subscriber");

  dropA();
  assert.equal(h.timers.liveCount, 1, "its timer is cleared, not left running");

  dropB();
  assert.equal(h.timers.liveCount, 0);
  assert.equal(h.watcher.closed, true, "the last one out closes the watcher");
  assert.equal(h.stream.watching, false);
});

test("a change hint reaches every subscriber, with no id and no replay", async () => {
  const h = harness();
  const a = h.client();
  const b = h.client();
  await h.stream.subscribe(a.handlers);
  await h.stream.subscribe(b.handlers);

  h.watcher.fire("all");
  for (const c of [a, b]) {
    const hint = c.events.find((e) => e.event === EVENTS.CHANGE);
    assert.ok(hint, "both subscribers hear it");
    assert.ok(!("id" in hint.data), "hints carry no id — they are hints, not deltas (#73)");
  }

  // A late subscriber gets NOTHING replayed: reconnecting and reloading is what catches it up.
  const late = h.client();
  await h.stream.subscribe(late.handlers);
  assert.deepEqual(late.events, [], "no replay buffer");
});

/* ------------------------------------------------------------------ failure */

test("⚠️ a watcher failure is broadcast as a named event AND closes every stream", async () => {
  const h = harness();
  const a = h.client();
  const b = h.client();
  await h.stream.subscribe(a.handlers);
  await h.stream.subscribe(b.handlers);

  h.watcher.fire("error", new Error("ENOSPC: watchers exhausted"));

  for (const c of [a, b]) {
    const fail = c.events.find((e) => e.event === EVENTS.FAILURE);
    assert.ok(fail, "logging alone would leave every page looking healthy (DEC-0022)");
    assert.match(fail.data.reason, /ENOSPC/, "and it says why");
    assert.equal(c.closed, true, "then the stream ends, so a client can tell the difference");
  }
  assert.equal(h.stream.subscriberCount, 0);
  assert.equal(h.timers.liveCount, 0, "no timer survives a failure");
  assert.match(h.stream.lastFailure, /ENOSPC/);
});

test("a subscriber whose send throws is dropped without taking the others down", async () => {
  const h = harness();
  const ok = h.client();
  const dead = { send: () => { throw new Error("socket gone"); }, close: () => {} };
  await h.stream.subscribe(dead);
  await h.stream.subscribe(ok.handlers);

  h.watcher.fire("all");
  assert.equal(h.stream.subscriberCount, 1, "the dead one is removed");
  assert.ok(ok.events.some((e) => e.event === EVENTS.CHANGE), "the live one still got the hint");
});

/* ------------------------------------------------------------------ explicit teardown */

test("close() ends every stream and releases the watcher — TSK-0013 will own calling it", async () => {
  const h = harness();
  const c = h.client();
  await h.stream.subscribe(c.handlers);

  await h.stream.close();
  assert.equal(c.closed, true);
  assert.equal(h.watcher.closed, true);
  assert.equal(h.timers.liveCount, 0);
  await assert.rejects(() => h.stream.subscribe(h.client().handlers), /closed/);
});
