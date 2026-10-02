import assert from "node:assert/strict";
import test from "node:test";

import register, { VOICE_SHORTCUT } from "../pi-package/extensions/kiln.js";
import { FakeAudioCapture } from "../lib/voice/audio/fake-capture.mjs";
import { resolveVoiceConfig, VOICE_ENV } from "../lib/voice/config.mjs";
import { appendDictation, DICTATION_ERROR, VoiceDictation } from "../lib/voice/dictation.mjs";
import { VOICE_STATES } from "../lib/voice/controller.mjs";

const SECRET = "test-only-elevenlabs-key";

function enabledConfig() {
  return resolveVoiceConfig({
    [VOICE_ENV.enabled]: "true",
    [VOICE_ENV.elevenLabsApiKey]: SECRET,
  });
}

function fakeUi(initial = "") {
  let editor = initial;
  const editorWrites = [];
  const statuses = [];
  const widgets = [];
  const notifications = [];
  return {
    ui: {
      getEditorText: () => editor,
      setEditorText: (text) => {
        editor = text;
        editorWrites.push(text);
      },
      setStatus: (key, value) => statuses.push({ key, value }),
      setWidget: (key, value) => widgets.push({ key, value }),
      notify: (message, type) => notifications.push({ message, type }),
      confirm: () => assert.fail("voice must not invoke confirmation dialogs"),
    },
    setTypedText: (text) => { editor = text; },
    editor: () => editor,
    editorWrites,
    statuses,
    widgets,
    notifications,
  };
}

class FakeSttProvider {
  constructor({ finalText = "dictated final", finishError = null } = {}) {
    this.finalText = finalText;
    this.finishError = finishError;
    this.callbacks = null;
    this.audio = [];
    this.commits = 0;
    this.closes = 0;
    this.disposals = 0;
  }

  async start(callbacks) {
    this.callbacks = callbacks;
    return {
      write: (chunk) => this.audio.push(Buffer.from(chunk)),
      finish: () => {
        this.commits += 1;
        if (this.finishError) throw this.finishError;
        queueMicrotask(() => callbacks.onFinal({ text: this.finalText }));
      },
      close: () => { this.closes += 1; },
    };
  }

  partial(text) {
    this.callbacks.onPartial({ text });
  }

  fail(error) {
    this.callbacks.onError(error);
  }

  async dispose() {
    this.disposals += 1;
  }
}

function harness({ initial = "", provider = new FakeSttProvider(), config = enabledConfig(), finalTimeoutMs = 500 } = {}) {
  const capture = new FakeAudioCapture();
  const view = fakeUi(initial);
  const dictation = new VoiceDictation({
    ui: view.ui,
    config,
    createCapture: () => capture,
    createSttProvider: () => provider,
    inputProbe: async () => ({ available: true }),
    listDevices: async () => [{ id: "default", label: "Default microphone" }],
    finalTimeoutMs,
  });
  return { capture, provider, view, dictation };
}

test("dictation streams audio, keeps partial text out of the editor, and manually commits on stop", async () => {
  const { capture, provider, view, dictation } = harness({ initial: "Existing" });
  await dictation.start();
  provider.partial("unsettled words");
  capture.push([0, 1, 2, 3]);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(dictation.state, VOICE_STATES.LISTENING);
  assert.equal(view.editor(), "Existing");
  assert.deepEqual(view.editorWrites, [], "a partial hypothesis changed the editor");
  assert.deepEqual(view.widgets.at(-1), {
    key: "kiln-voice-partial",
    value: ["Voice draft: unsettled words"],
  });
  assert.equal(Buffer.concat(provider.audio).byteLength, 4);

  view.setTypedText("Existing plus text typed during recognition");
  const stopped = await dictation.stop();
  assert.deepEqual(stopped, { text: "dictated final", state: VOICE_STATES.IDLE });
  assert.equal(view.editor(), "Existing plus text typed during recognition dictated final");
  assert.equal(provider.commits, 1);
  assert.equal(provider.disposals, 1);
  assert.equal(dictation.state, VOICE_STATES.IDLE);
});

test("editor append semantics preserve exact current content and add only finalized text", () => {
  assert.equal(appendDictation("", " final "), "final");
  assert.equal(appendDictation("existing", "final"), "existing final");
  assert.equal(appendDictation("existing\n", "final"), "existing\nfinal");
  assert.equal(appendDictation("existing", "   "), "existing");
});

test("voice status and devices are bounded operator reads independent of editor submission", async () => {
  const { dictation } = harness();
  const status = await dictation.status();
  assert.equal(status.state, VOICE_STATES.IDLE);
  assert.equal(status.stt.status, "ready");
  assert.equal(status.tts.status, "disabled");
  assert.deepEqual(await dictation.devices(), [{ id: "default", label: "Default microphone" }]);
});

test("disabled voice and provider failures remain voice-only and sanitize operator feedback", async () => {
  const disabled = harness({ config: resolveVoiceConfig({ [VOICE_ENV.elevenLabsApiKey]: SECRET }) });
  await assert.rejects(() => disabled.dictation.start(), { code: DICTATION_ERROR.DISABLED });
  assert.equal(disabled.capture.format.encoding, "pcm_16000");

  const active = harness();
  await active.dictation.start();
  active.provider.fail(Object.assign(new Error(`provider leaked ${SECRET}`), { code: "stt-connection-failed" }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(active.dictation.state, VOICE_STATES.ERROR);
  assert.equal(JSON.stringify(active.view.notifications).includes(SECRET), false);
});

test("a missing provider final is bounded and leaves the Kiln session alive", async () => {
  const provider = new FakeSttProvider();
  provider.start = async (callbacks) => {
    provider.callbacks = callbacks;
    return {
      write: (chunk) => provider.audio.push(Buffer.from(chunk)),
      finish: () => { provider.commits += 1; },
      close: () => { provider.closes += 1; },
    };
  };
  const { dictation, view } = harness({ provider, finalTimeoutMs: 10 });
  await dictation.start();
  await assert.rejects(() => dictation.stop(), { code: DICTATION_ERROR.FINAL_TIMEOUT });
  assert.equal(dictation.state, VOICE_STATES.ERROR);
  assert.equal(view.editor(), "");
  assert.equal(view.notifications.at(-1).type, "error");
});

test("dispose during recording closes capture/provider state and is idempotent", async () => {
  const { dictation, provider } = harness();
  await dictation.start();
  const first = await dictation.dispose();
  const second = await dictation.dispose();
  assert.deepEqual(first, { ok: true, alreadyDisposed: false });
  assert.deepEqual(second, { ok: true, alreadyDisposed: true });
  assert.equal(provider.disposals, 1);
  assert.equal(dictation.state, VOICE_STATES.DISPOSED);
});

test("Pi registers one TUI-only command and shortcut, never a voice tool or submission path", async () => {
  const commands = new Map();
  const shortcuts = new Map();
  const hooks = new Map();
  const tools = [];
  const calls = [];
  const subscribed = [];
  const unsubscribed = [];
  const keyboardListener = () => undefined;
  let creations = 0;
  const session = {
    start: async () => calls.push("start"),
    stop: async () => calls.push("stop"),
    toggle: async () => calls.push("toggle"),
    status: async () => ({ state: "idle", stt: { status: "ready" }, tts: { status: "disabled" } }),
    devices: async () => [{ id: "mic", label: "Test mic" }],
    dispose: async () => calls.push("dispose"),
  };
  register({
    registerTool: (tool) => tools.push(tool.name),
    registerCommand: (name, options) => commands.set(name, options),
    registerShortcut: (key, options) => shortcuts.set(key, options),
    on: (event, handler) => hooks.set(event, handler),
    sendUserMessage: () => assert.fail("voice must never submit the editor"),
  }, {
    keyboardStop: { keyboardStopFor: () => keyboardListener },
    createVoiceSession: async () => {
      creations += 1;
      return session;
    },
  });

  assert.deepEqual([...commands.keys()], ["voice"]);
  assert.deepEqual([...shortcuts.keys()], [VOICE_SHORTCUT]);
  assert.notEqual(VOICE_SHORTCUT, "ctrl+c");
  assert.equal(tools.some((name) => name.includes("voice")), false);

  const nonTui = fakeUi();
  await commands.get("voice").handler("start", { mode: "rpc", hasUI: true, ui: nonTui.ui });
  assert.equal(creations, 0);
  assert.equal(nonTui.notifications.at(-1).type, "warning");

  const tui = fakeUi();
  tui.ui.setWorkingIndicator = () => {};
  tui.ui.onTerminalInput = (listener) => {
    subscribed.push(listener);
    return () => unsubscribed.push(listener);
  };
  const ctx = { mode: "tui", hasUI: true, ui: tui.ui };
  await hooks.get("session_start")({}, ctx);
  assert.deepEqual(subscribed, [keyboardListener], "voice registration preserves Kiln's Ctrl+C listener");
  await commands.get("voice").handler("start", ctx);
  await commands.get("voice").handler("stop", ctx);
  await commands.get("voice").handler("status", ctx);
  await commands.get("voice").handler("devices", ctx);
  await shortcuts.get(VOICE_SHORTCUT).handler(ctx);
  assert.deepEqual(calls, ["start", "stop", "toggle"]);
  assert.equal(creations, 1, "one session-scoped voice owner is reused");
  assert.equal(tui.notifications.some(({ message }) => message.includes("STT: ready")), true);
  assert.equal(tui.notifications.some(({ message }) => message === "Test mic"), true);

  await hooks.get("session_shutdown")({}, ctx);
  assert.deepEqual(unsubscribed, [keyboardListener]);
  assert.deepEqual(calls, ["start", "stop", "toggle", "dispose"]);
});
