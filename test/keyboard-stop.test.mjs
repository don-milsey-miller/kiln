/**
 * The keyboard stop: one Ctrl+C in an interactive Kiln session stops the run — F130, TSK-0058, ACC-0081.
 *
 * ⚠️ **AGAINST THE PINNED PI'S OWN CODE WHERE PI DECIDES.** Which bytes are Ctrl+C, and whether a listener sees the key
 * before the editor or a dialog does, are Pi's facts: the matcher is compared with the pinned `pi-tui` `matchesKey`, and
 * consumption is driven through the pinned `TuiMainScreen`, the class Pi's interactive mode renders with. The
 * supervisor's side, including the race with a Pi that exits at once, is in `test/supervisor.test.mjs`.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { KEYBOARD_STOP_ENV, ctrlCInput, keyboardStopFor, keyboardStopListener, watchKeyboardStop } from "../lib/keyboard-stop.mjs";
import { resolvePinnedSdk } from "../lib/pi-runtime.mjs";
import register from "../pi-package/extensions/kiln.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const piTui = await import(pathToFileURL(createRequire(resolvePinnedSdk(ROOT).url).resolve("@earendil-works/pi-tui")).href);

/** A context that records what the listener asked of Pi, in order. */
function fakeContext({ idle = false } = {}) {
  const calls = [];
  return {
    calls,
    ctx: { isIdle: () => idle, abort: () => calls.push("abort"), shutdown: () => calls.push("shutdown"), ui: { notify: (m) => calls.push(`notify ${m}`) } },
  };
}

test("⚠️ F130 the matcher reads Ctrl+C exactly as the pinned Pi does, in every encoding a terminal can send", () => {
  const forms = [
    "\x03", "\x1b[99;5u", "\x1b[99;5:1u", "\x1b[99;5:2u", "\x1b[99;5:3u", "\x1b[99;69u", "\x1b[99;133u", "\x1b[99:67;5u",
    "\x1b[1089::99;5u", "\x1b[27;5;99~",
    // Not Ctrl+C: other modifiers, other keys, plain text.
    "\x1b[99;6u", "\x1b[99;7u", "\x1b[99;9u", "\x1b[67;5u", "\x1b[99u", "\x1b[27;6;99~", "c", "\x04", "\x1b",
  ];
  for (const data of forms) {
    const pi = piTui.matchesKey(data, "ctrl+c") ? (piTui.isKeyRelease(data) ? "release" : "press") : null;
    assert.equal(ctrlCInput(data), pi, JSON.stringify(data));
  }
});

test("⚠️ F130 on the pinned Pi's TUI the key is consumed from the editor and from a dialog; other input still reaches them", () => {
  const terminal = new Proxy({ columns: 80, rows: 24 }, { get: (t, k) => (k in t ? t[k] : () => {}) });
  const ui = new piTui.TuiMainScreen(terminal);
  const seen = [];
  const component = (name) => ({ handleInput: (d) => seen.push([name, d]), render: () => [], invalidate() {} });
  const { calls, ctx } = fakeContext();
  const written = [];
  ui.addInputListener(keyboardStopListener(ctx, "notice", { write: (file, body, opts) => (calls.push("write"), written.push([file, body, opts])) }));

  ui.setFocus(component("editor"));
  ui.handleTerminalInput("x");
  ui.handleTerminalInput("\x03");
  ui.showOverlay(component("dialog"));
  ui.handleTerminalInput("y");
  ui.handleTerminalInput("\x1b[99;5u");

  assert.deepEqual(seen, [["editor", "x"], ["dialog", "y"]], "neither the editor nor the dialog saw Ctrl+C");
  // ⚠️ THE NOTICE FIRST, THEN THE TURN'S ABORT, THEN THE SHUTDOWN — and one press is one stop.
  assert.deepEqual(calls, ["write", "abort", "shutdown"]);
  assert.equal(written[0][0], "notice");
  assert.equal(written[0][2].flag, "wx", "an existing notice is never overwritten");
  assert.ok(Number.isFinite(JSON.parse(written[0][1]).at), "the key's time is in the notice");
});

test("⚠️ F130 an idle Pi is not aborted, a release is consumed without a second stop, and a failed notice still stops Pi", () => {
  const idle = fakeContext({ idle: true });
  const listener = keyboardStopListener(idle.ctx, "notice", { write: () => idle.calls.push("write") });
  assert.deepEqual(listener("\x1b[99;5:3u"), { consume: true });
  assert.deepEqual(idle.calls, [], "a release alone stops nothing");
  listener("\x03");
  listener("\x03");
  assert.deepEqual(idle.calls, ["write", "shutdown"]);
  assert.equal(listener("q"), undefined, "anything else passes through");

  const failing = fakeContext();
  keyboardStopListener(failing.ctx, "notice", {
    write: () => {
      throw Object.assign(new Error("denied"), { code: "EACCES" });
    },
  })("\x03");
  assert.equal(failing.calls.length, 3);
  assert.match(failing.calls[0], /^notify .*EACCES/);
  assert.deepEqual(failing.calls.slice(1), ["abort", "shutdown"]);
});

test("⚠️ F130 outside a Kiln supervisor there is no listener, and Pi keeps its own Ctrl+C", () => {
  assert.equal(keyboardStopFor(fakeContext().ctx, {}), null);
  assert.equal(typeof keyboardStopFor(fakeContext().ctx, { [KEYBOARD_STOP_ENV]: "notice" }), "function");
});

test("⚠️ F130 the watch fires once, by poll when no directory watch is available, and `check()` looks synchronously", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kiln-keyboard-test-"));
  try {
    const file = join(dir, "stop.json");
    const notices = [];
    const noWatch = () => {
      throw new Error("unavailable");
    };
    const polled = watchKeyboardStop(file, (n) => notices.push(n), { pollMs: 10, watchImpl: noWatch });
    writeFileSync(file, JSON.stringify({ at: 1234 }));
    for (let i = 0; i < 100 && notices.length === 0; i++) await new Promise((r) => setTimeout(r, 10));
    assert.equal(notices.length, 1);
    assert.equal(notices[0].keyAtMs, 1234);
    assert.equal(notices[0].via, "poll");
    polled.dispose();

    const checked = [];
    const quiet = watchKeyboardStop(file, (n) => checked.push(n), { pollMs: 60_000, watchImpl: noWatch });
    assert.equal(quiet.check(), true);
    assert.equal(quiet.check(), true);
    assert.deepEqual(checked.map((n) => n.via), ["check"], "once");
    quiet.dispose();

    rmSync(file);
    const none = watchKeyboardStop(file, () => assert.fail("no notice"), { pollMs: 60_000, watchImpl: noWatch });
    assert.equal(none.check(), false);
    none.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("⚠️ F130 the extension subscribes at each session start, only with a terminal, and drops its previous subscription", async () => {
  const hooks = new Map();
  const subscribed = [];
  const unsubscribed = [];
  const listener = () => undefined;
  register({ registerTool: () => {}, on: (event, handler) => hooks.set(event, handler) }, { keyboardStop: { keyboardStopFor: () => listener } });
  const ctx = (hasUI) => ({
    hasUI,
    ui: {
      onTerminalInput: (l) => {
        subscribed.push(l);
        return () => unsubscribed.push(l);
      },
    },
  });

  await hooks.get("session_start")({}, ctx(false));
  assert.equal(subscribed.length, 0, "print mode has no terminal to listen to");
  await hooks.get("session_start")({}, ctx(true));
  await hooks.get("session_start")({}, ctx(true));
  assert.deepEqual(subscribed, [listener, listener]);
  assert.deepEqual(unsubscribed, [listener], "the first subscription was dropped before the second");

  // And through the real `lib/`, with no notice named: nothing is subscribed.
  const saved = process.env[KEYBOARD_STOP_ENV];
  delete process.env[KEYBOARD_STOP_ENV];
  try {
    const real = new Map();
    register({ registerTool: () => {}, on: (event, handler) => real.set(event, handler) });
    const before = subscribed.length;
    await real.get("session_start")({}, ctx(true));
    assert.equal(subscribed.length, before);
  } finally {
    if (saved !== undefined) process.env[KEYBOARD_STOP_ENV] = saved;
  }
});
