/**
 * The change-stream service — CMP-0017's server half (TSK-0011).
 *
 * ⚠️ **NOTHING STARTS AT IMPORT TIME.** No watcher, no timer, no filesystem handle. `next build`
 * imports every route module to collect page data, and a watcher started at import would run during
 * the build and outlive it — a background process nobody asked for and nobody can stop. The watcher
 * is created on the FIRST subscription and closed by an explicit `close()`, which TSK-0013's
 * launcher will own.
 *
 * ⚠️ **chokidar is imported dynamically, inside the default factory.** #73 measured `fs.watch` as
 * unusable on Windows and chokidar as usable, so the dependency stays — but a static import would
 * put it in the build graph of a module that is supposed to be inert until asked.
 *
 * ⚠️ **THE WATCHER IS SHARED; THE SUBSCRIBERS ARE NOT.** One browser closing a tab must not stop the
 * others receiving change hints, so unsubscribing tears down that subscriber's timer and nothing
 * else. The watcher closes when the last subscriber leaves, or when `close()` is called.
 *
 * ⚠️ **A WATCHER FAILURE IS BROADCAST AND THEN THE STREAMS CLOSE.** Logging it would leave every open
 * page looking healthy while nothing could ever refresh it again — DEC-0022's rule, and the reason
 * the failure path is a named event rather than a console line. A client that sees the stream close
 * without a `failure` event has a network problem; one that sees the event knows the server gave up.
 *
 * ⚠️ **NO EVENT IDS AND NO REPLAY BUFFER**, deliberately. Events are hints and never deltas (#73), so
 * a reconnecting client that reloads is exactly caught up. `Last-Event-ID` would exist only to
 * reproduce what a reload already achieves.
 */

/** Named events. Anything a client listens for must be here — a comment frame fires nothing. */
export const EVENTS = { HEARTBEAT: "heartbeat", CHANGE: "change", FAILURE: "failure" };

/** The default watcher factory. Dynamic import keeps chokidar out of the module's import graph. */
async function defaultWatcherFactory(dir) {
  const { default: chokidar } = await import("chokidar");
  return chokidar.watch(dir, {
    ignoreInitial: true,
    // Node 24.19's Windows fs-event backend can abort the process on rapid atomic renames.
    // Polling preserves the same hint-only contract without entering that native code path.
    usePolling: process.platform === "win32",
    // #72's temp suffix and the lock are not content changes; a write in progress is not a change.
    ignored: (p) => p.includes(".vpw-tmp") || p.endsWith(".planning.lock"),
  });
}

/**
 * @param {{
 *   watchDir: string,
 *   heartbeatMs?: number,
 *   createWatcher?: (dir: string) => Promise<{on: Function, close: Function}>,
 *   timers?: {setInterval: Function, clearInterval: Function},
 * }} opts
 */
export function createChangeStream({
  watchDir,
  heartbeatMs = 5000,
  createWatcher = defaultWatcherFactory,
  timers = { setInterval, clearInterval },
} = {}) {
  const subscribers = new Set();
  let watcher = null;
  let starting = null;
  let failed = null;
  let closed = false;

  const broadcast = (event, data) => {
    for (const s of [...subscribers]) {
      try {
        s.send(event, data);
      } catch {
        // A send that throws is a subscriber already gone. Drop it rather than letting one dead
        // connection stop the others being told.
        remove(s);
      }
    }
  };

  function remove(sub) {
    if (!subscribers.delete(sub)) return;
    timers.clearInterval(sub.timer);
    // ⚠️ The watcher survives until the LAST subscriber leaves. A shared watcher torn down by one
    // disconnect would leave every other open page silently un-refreshed.
    if (subscribers.size === 0 && watcher) {
      const w = watcher;
      watcher = null;
      starting = null;
      try {
        w.close();
      } catch {
        /* already gone */
      }
    }
  }

  async function ensureWatcher() {
    if (closed || watcher || starting) return starting;
    starting = (async () => {
      const w = await createWatcher(watchDir);
      w.on("all", () => broadcast(EVENTS.CHANGE, { at: "content" }));
      w.on("error", (err) => {
        failed = String(err?.message ?? err);
        // Tell every subscriber WHY, then end their streams. A page that keeps a live-looking
        // connection to a watcher that has died is the defect this event exists to prevent.
        broadcast(EVENTS.FAILURE, { reason: failed });
        for (const s of [...subscribers]) {
          const done = s.close;
          remove(s);
          try {
            done();
          } catch {
            /* already gone */
          }
        }
      });
      watcher = w;
      return w;
    })();
    return starting;
  }

  return {
    get subscriberCount() {
      return subscribers.size;
    },
    get watching() {
      return watcher !== null;
    },
    get lastFailure() {
      return failed;
    },

    /**
     * @param {{send: (event: string, data: object) => void, close: () => void}} handlers
     * @returns {Promise<() => void>} unsubscribe — removes this subscriber and its timer only
     */
    async subscribe(handlers) {
      if (closed) throw new Error("change stream is closed");
      const sub = {
        send: handlers.send,
        close: handlers.close,
        timer: timers.setInterval(() => {
          try {
            handlers.send(EVENTS.HEARTBEAT, { ok: true });
          } catch {
            remove(sub);
          }
        }, heartbeatMs),
      };
      subscribers.add(sub);
      await ensureWatcher();
      return () => remove(sub);
    },

    /** Explicit teardown. TSK-0013's launcher owns calling this. */
    async close() {
      closed = true;
      for (const s of [...subscribers]) {
        const done = s.close;
        remove(s);
        try {
          done();
        } catch {
          /* already gone */
        }
      }
      if (watcher) {
        const w = watcher;
        watcher = null;
        await w.close();
      }
    },
  };
}
