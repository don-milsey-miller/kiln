/**
 * The keyboard stop: one Ctrl+C in an interactive Kiln session stops the run — F130, TSK-0058, ACC-0081.
 *
 * ⚠️ **PI READS CTRL+C AS A KEY, SO NO SIGNAL EVER ARRIVES.** An interactive Pi puts the terminal in raw mode:
 * on Windows the console's ENABLE_PROCESSED_INPUT is cleared, on POSIX ISIG is, and Ctrl+C reaches Pi as the
 * byte 0x03 — which the pinned Pi binds to "clear the editor". Measured in Windows Terminal with job mode on and
 * off: a single Ctrl+C mid-turn stopped nothing, and the supervisor's signal handlers never ran. So Kiln's own
 * extension takes the key (`pi-package/extensions/kiln.js`) and tells the supervisor through the file named
 * below, and the supervisor starts its bounded shutdown when it sees that file, without waiting for Pi to exit.
 *
 * ⚠️ **THE NOTICE IS WRITTEN BEFORE PI IS ASKED TO GO, SO ITS PRESENCE ORDERS THE TWO.** The extension writes
 * the file synchronously and only then aborts the turn and asks Pi to shut down, so a Pi that exits at once still
 * leaves the file behind. When the agent's exit is observed first, the run loop asks `check()` before deciding
 * what ended the run, and a stop that was pressed is recorded as `keyboard` rather than as Pi exiting on its own.
 *
 * ⚠️ **RECORDED AS `keyboard`, NEVER AS A SIGNAL.** No SIGINT occurred, and the shutdown record says so.
 */

import { existsSync, readFileSync, watch, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** The environment variable that carries the notice file's path to the agent, and only to an interactive one. */
export const KEYBOARD_STOP_ENV = "KILN_KEYBOARD_STOP_FILE";

/** The stop a keyboard notice requests, beside the signal names `watchForStop` records. */
export const KEYBOARD_STOP = "keyboard";

/** How often the file is looked for when the directory watch says nothing: a watch can miss an event. */
export const KEYBOARD_POLL_MS = 25;

/**
 * Watch for the notice file and call `onNotice` once, with when the key was pressed and when it was seen.
 *
 * @param {string} file
 * @param {(notice: {keyAtMs: number|null, noticedAtMs: number, via: string}) => void} onNotice
 * @returns {{check: () => boolean, dispose: () => void}} `check()` looks now, synchronously, and reports whether
 *   the notice exists (firing `onNotice` if it had not fired yet).
 */
export function watchKeyboardStop(file, onNotice, { pollMs = KEYBOARD_POLL_MS, exists = existsSync, read = readFileSync, watchImpl = watch, now = Date.now } = {}) {
  let fired = false;
  let timer = null;
  let watcher = null;
  const look = (via) => {
    if (fired) return true;
    if (!exists(file)) return false;
    fired = true;
    let keyAtMs = null;
    try {
      const at = JSON.parse(read(file, "utf-8"))?.at;
      if (Number.isFinite(at)) keyAtMs = at;
    } catch {
      // The file's presence is the notice; a torn or unreadable body only loses the key's time.
    }
    dispose();
    onNotice({ keyAtMs, noticedAtMs: now(), via });
    return true;
  };
  const dispose = () => {
    if (timer) clearInterval(timer);
    timer = null;
    try {
      watcher?.close();
    } catch {}
    watcher = null;
  };
  try {
    watcher = watchImpl(dirname(file), () => look("watch"));
    watcher.on?.("error", () => {});
  } catch {
    watcher = null;
  }
  // ⚠️ **NOT UNREFERENCED.** The supervisor is waiting on this, and `dispose()` runs on every path out of the run. An
  // unreferenced timer let a process with nothing else pending exit mid-wait (CI run 36169304790, Ubuntu, Node 22).
  timer = setInterval(() => look("poll"), pollMs);
  return { check: () => look("check"), dispose };
}


/**
 * Whether terminal input is Ctrl+C: `"press"` (or a repeat), `"release"`, or `null` for anything else.
 *
 * ⚠️ **EVERY ENCODING THE PINNED PI READS AS CTRL+C, BECAUSE THE TERMINAL DECIDES WHICH ONE ARRIVES.** The legacy byte
 * 0x03, the Kitty keyboard protocol's `CSI 99 ; mods u` (Caps and Num Lock bits ignored, a shifted or base-layout key
 * of 99, an event type), and xterm's modifyOtherKeys `CSI 27 ; mods ; 99 ~`. A test holds this equal to the pinned
 * `@earendil-works/pi-tui` `matchesKey(data, "ctrl+c")` over each form. A release is reported apart, so it is consumed
 * without being a second press.
 */
export function ctrlCInput(data) {
  if (data === "\x03") return "press";
  const ctrlOnly = (mods) => ((Number(mods) - 1) & ~(64 | 128)) === 4;
  const kitty = /^\x1b\[(\d+)(?::(\d*))?(?::(\d+))?;(\d+)(?::(\d+))?(?:;[\d:]*)?u$/.exec(data);
  if (kitty) {
    const [, code, , base, mods, event] = kitty;
    if ((code !== "99" && base !== "99") || !ctrlOnly(mods)) return null;
    return event === "3" ? "release" : "press";
  }
  const other = /^\x1b\[27;(\d+);99~$/.exec(data);
  return other && ctrlOnly(other[1]) ? "press" : null;
}

/** Pi's exit status when the key was pressed but its notice could not be written: an interrupt, never a clean exit. */
export const UNNOTIFIED_STOP_EXIT_CODE = 130;

/** How long Pi's own shutdown may take on that path before the process is ended: the shutdown deadline's length. */
export const UNNOTIFIED_STOP_FORCE_MS = 8000;

/**
 * The terminal-input listener Kiln's Pi extension subscribes (`pi-package/extensions/kiln.js`).
 *
 * ⚠️ **ONE CTRL+C STOPS THE RUN, FROM THE EDITOR OR FROM A DIALOG.** Pi's input listeners run before whichever
 * component has focus, so consuming the key here keeps Pi's "clear the editor" and a dialog's "cancel" from seeing
 * it. The notice is written FIRST and synchronously, so it exists before Pi can exit; then an active turn is aborted
 * and Pi is asked to shut down, which it does once idle. The supervisor does not wait for that.
 *
 * ⚠️ **A NOTICE THAT CANNOT BE WRITTEN IS NEVER A CLEAN EXIT, AND NEVER A WAIT WITHOUT END.** The supervisor then has
 * nothing but Pi's exit to go on, and Pi's own shutdown exits 0 — which reads as an operator's ordinary quit. So the
 * exit status is set to 130 as the process exits (Node applies an `exit` listener's `process.exitCode`), and if Pi's
 * shutdown has not ended the process within the shutdown deadline's length, the process is ended with 130 directly.
 */
export function keyboardStopListener(
  ctx,
  file,
  {
    write = writeFileSync,
    now = Date.now,
    onExit = (fn) => process.once("exit", fn),
    setExitCode = (code) => (process.exitCode = code),
    forceExit = (code) => process.exit(code),
    forceAfterMs = UNNOTIFIED_STOP_FORCE_MS,
  } = {}
) {
  let pressed = false;
  return (data) => {
    const kind = ctrlCInput(data);
    if (kind === null) return undefined;
    if (kind === "press" && !pressed) {
      pressed = true;
      try {
        write(file, JSON.stringify({ at: now() }), { flag: "wx" });
      } catch (e) {
        // EEXIST is an earlier press, already noticed. Anything else: Pi still stops, and says it was interrupted.
        if (e?.code !== "EEXIST") {
          ctx?.ui?.notify?.(`Kiln could not tell its supervisor about Ctrl+C (${e?.code ?? "error"}); stopping Pi.`, "warning");
          onExit(() => setExitCode(UNNOTIFIED_STOP_EXIT_CODE));
          setTimeout(() => forceExit(UNNOTIFIED_STOP_EXIT_CODE), forceAfterMs).unref?.();
        }
      }
      try {
        if (ctx?.isIdle?.() === false) ctx.abort?.();
      } catch {}
      try {
        ctx?.shutdown?.();
      } catch {}
    }
    return { consume: true };
  };
}

/** The listener for this Pi, or null when no Kiln supervisor named a notice file: then Pi keeps its own Ctrl+C. */
export function keyboardStopFor(ctx, env = process.env) {
  const file = env[KEYBOARD_STOP_ENV];
  return file ? keyboardStopListener(ctx, file) : null;
}
