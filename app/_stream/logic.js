/**
 * The client half of the change stream, as pure logic — CMP-0017, TSK-0017.
 *
 * ⚠️ **IT LIVES IN `app/`, NOT `lib/`, and the boundary check is what said so.** The first draft put
 * it in `lib/` beside the server half and `lint:shell` refused the import immediately — correctly.
 * `lib/` is the tool the CLI and the test suite share; a browser-side watchdog is the shell's alone.
 * It also could not have gone through `app/server/*`: those modules carry `server-only`, which throws
 * in a client component by design. A client component needs code that is neither tool nor adapter,
 * and that is what this directory is.
 *
 * ⚠️ **NO REACT HERE, DELIBERATELY.** Every hard part of this component is timing: an initial
 * connection is not a reconnection, a heartbeat resets a deadline, an expiry means stale, and a
 * reload must not cause another reload. None of that is easier to reason about inside a hook, and
 * all of it becomes untestable under plain Node if it lives there. The component is a thin wrapper.
 *
 * ⚠️ **THE INITIAL CONNECTION AND A RECONNECTION ARE DIFFERENT EVENTS**, and `EventSource` gives
 * them the same one. `onopen` fires for both, so a naive "reload on open" reloads immediately on
 * every page load — a loop that looks like the page refusing to settle. The distinction is whether
 * anything has gone wrong since the last open.
 *
 * ⚠️ **A RECONNECTION RELOADS BECAUSE THE GAP IS UNRECOVERABLE.** The server sends no ids and keeps
 * no buffer (#73): a change during the disconnected window is simply not delivered. Reloading on
 * reconnect is what makes that harmless, and it is why the server can stay that simple.
 */

export const STATE = { CONNECTING: "connecting", LIVE: "live", STALE: "stale" };

/**
 * @param {{
 *   url?: string,
 *   watchdogMs?: number,
 *   EventSourceImpl: new (url: string) => EventTarget & { close(): void },
 *   timers?: {setTimeout: Function, clearTimeout: Function},
 *   reload: () => void,
 *   onState?: (state: string) => void,
 * }} opts
 */
export function createStreamWatchdog({
  url = "/events",
  watchdogMs = 15000,
  EventSourceImpl,
  timers = { setTimeout, clearTimeout },
  reload,
  onState = () => {},
}) {
  let source = null;
  let timer = null;
  let state = STATE.CONNECTING;
  let everOpened = false;
  let sawTrouble = false; // an error or failure since the last successful open
  let reloading = false; // ⚠️ one reload per lifetime; the page is leaving either way
  let stopped = false;

  const setState = (next) => {
    if (state === next) return;
    state = next;
    onState(state);
  };

  const clearWatchdog = () => {
    if (timer !== null) {
      timers.clearTimeout(timer);
      timer = null;
    }
  };

  /** Restart the deadline. Every named heartbeat does this; nothing else does. */
  const armWatchdog = () => {
    clearWatchdog();
    timer = timers.setTimeout(() => {
      timer = null;
      // No heartbeat within the window. The connection may still look open — that is the point.
      sawTrouble = true;
      setState(STATE.STALE);
    }, watchdogMs);
  };

  const goStale = () => {
    sawTrouble = true;
    clearWatchdog();
    setState(STATE.STALE);
  };

  const doReload = () => {
    if (reloading || stopped) return;
    reloading = true;
    clearWatchdog();
    reload();
  };

  return {
    get state() {
      return state;
    },
    get connected() {
      return source !== null;
    },

    start() {
      // ⚠️ One EventSource per watchdog, ever. React may invoke an effect twice; a second source
      // would double every heartbeat and leave one connection with nothing to close it.
      if (source || stopped) return;
      source = new EventSourceImpl(url);

      source.addEventListener("open", () => {
        if (everOpened && sawTrouble) {
          // A RECONNECTION. Anything that changed while the stream was down was never delivered,
          // so the only way to be correct is to start again.
          doReload();
          return;
        }
        everOpened = true;
        sawTrouble = false;
        setState(STATE.LIVE);
        armWatchdog();
      });

      // The NAMED heartbeat. A comment frame fires nothing here (AST-0036), which is why the server
      // sends an event rather than a keepalive.
      source.addEventListener("heartbeat", () => {
        sawTrouble = false;
        setState(STATE.LIVE);
        armWatchdog();
      });

      source.addEventListener("change", () => doReload());

      // The server said its watcher died. Nothing will arrive again, so say so immediately rather
      // than waiting a whole watchdog window to infer it.
      source.addEventListener("failure", () => goStale());

      source.addEventListener("error", () => goStale());

      return this;
    },

    /** Close the connection and clear the timer. Called on unmount. */
    stop() {
      stopped = true;
      clearWatchdog();
      if (source) {
        try {
          source.close();
        } catch {
          /* already gone */
        }
        source = null;
      }
    },
  };
}
