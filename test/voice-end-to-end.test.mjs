import assert from "node:assert/strict";
import test from "node:test";

import { FakeAudioCapture } from "../lib/voice/audio/fake-capture.mjs";
import { FakeAudioPlayback } from "../lib/voice/audio/fake-playback.mjs";
import { resolveVoiceConfig, VOICE_ENV } from "../lib/voice/config.mjs";
import { VoiceDictation } from "../lib/voice/dictation.mjs";
import { VoiceOutput } from "../lib/voice/output.mjs";
import { PiVoiceSession } from "../lib/voice/session.mjs";
import { PCM_24000 } from "../lib/voice/tts/elevenlabs.mjs";

function config(mode = "on") {
  return resolveVoiceConfig({
    [VOICE_ENV.enabled]: "true",
    [VOICE_ENV.ttsMode]: mode,
    [VOICE_ENV.ttsVoiceId]: "voice_123",
    [VOICE_ENV.maxRecordingMs]: "1000",
    [VOICE_ENV.maxTtsCharacters]: "1000",
    [VOICE_ENV.elevenLabsApiKey]: "e2e-test-key",
  });
}

function editor(initial = "") {
  let text = initial;
  const writes = [];
  const notifications = [];
  let submissions = 0;
  let confirmations = 0;
  return {
    ui: {
      getEditorText: () => text,
      setEditorText: (value) => { text = value; writes.push(value); },
      setStatus: () => {},
      setWidget: () => {},
      notify: (message, type) => notifications.push({ message, type }),
      confirm: () => { confirmations += 1; throw new Error("voice opened a confirmation"); },
    },
    type: (value) => { text = value; },
    submit: () => { submissions += 1; },
    text: () => text,
    writes,
    notifications,
    submissions: () => submissions,
    confirmations: () => confirmations,
  };
}

class FakeStt {
  constructor(finalText = "yes, keep the concurrent text") {
    this.finalText = finalText;
    this.callbacks = null;
    this.audio = [];
    this.commits = 0;
    this.disposals = 0;
  }
  async start(callbacks) {
    this.callbacks = callbacks;
    return {
      write: (chunk) => this.audio.push(Buffer.from(chunk)),
      finish: () => {
        this.commits += 1;
        queueMicrotask(() => callbacks.onFinal({ text: this.finalText }));
      },
      close: () => {},
    };
  }
  partial(text) { this.callbacks.onPartial({ text }); }
  async dispose() { this.disposals += 1; }
}

class FakeTts {
  constructor() { this.texts = []; this.disposals = 0; }
  async synthesize(text) {
    this.texts.push(text);
    return { format: PCM_24000, audio: Uint8Array.from([0, this.texts.length]) };
  }
  async dispose() { this.disposals += 1; }
}

function buildSession({ view = editor(), capture = new FakeAudioCapture(), stt = new FakeStt(), tts = new FakeTts(), playback = new FakeAudioPlayback(), mode = "on" } = {}) {
  const settings = config(mode);
  const dictation = new VoiceDictation({
    ui: view.ui,
    config: settings,
    createCapture: () => capture,
    createSttProvider: () => stt,
    inputProbe: async () => ({ available: true }),
    listDevices: async () => [],
    finalTimeoutMs: 500,
  });
  const output = new VoiceOutput({
    ui: view.ui,
    config: settings,
    createTtsProvider: () => tts,
    createPlayback: () => playback,
  });
  return { session: new PiVoiceSession({ dictation, output }), dictation, output, view, capture, stt, tts, playback };
}

async function eventually(predicate) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail("condition did not become true");
}

test("fake end-to-end flow preserves the editor boundary through STT, Pi, TTS, and playback", async () => {
  const flow = buildSession({ view: editor("existing draft") });
  await flow.session.start();
  flow.stt.partial("unsettled yes");
  flow.capture.push([0, 1, 2, 3]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(flow.view.text(), "existing draft", "partial STT edited the draft");

  flow.view.type("existing draft plus text typed while listening");
  await flow.session.stop();
  assert.equal(flow.view.text(), "existing draft plus text typed while listening yes, keep the concurrent text");
  assert.equal(flow.view.submissions(), 0, "voice submitted the draft");
  assert.equal(flow.view.confirmations(), 0, "spoken yes opened or approved a confirmation");

  const finalAssistant = {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "must stay hidden" },
      { type: "text", text: "**Final** answer for REQ-0009." },
      { type: "toolCall", name: "kiln_set_review_status", arguments: { reviewStatus: "approved" } },
    ],
  };
  assert.equal(flow.session.handleMessage(finalAssistant).accepted, true);
  await eventually(() => flow.output.status().queue === "idle");
  assert.deepEqual(flow.tts.texts, ["Final answer for REQ 0009."]);
  assert.equal(flow.playback.plays.length, 1);
  assert.equal(flow.view.text().includes("Final answer"), false, "TTS output entered the editor/session context");
  await flow.session.dispose();
});

test("starting dictation interrupts active speech before microphone capture without stopping Pi", async () => {
  const order = [];
  class OrderedCapture extends FakeAudioCapture {
    async start(options) { order.push("microphone-start"); return super.start(options); }
  }
  class OrderedPlayback extends FakeAudioPlayback {
    async stop() { order.push("playback-stop"); return super.stop(); }
  }
  const piRun = { stopped: false };
  const flow = buildSession({
    capture: new OrderedCapture(),
    playback: new OrderedPlayback({ autoComplete: false }),
  });
  flow.session.handleMessage({ role: "assistant", content: "Long response." });
  await eventually(() => flow.playback.active);

  await flow.session.start();
  assert.deepEqual(order.slice(0, 2), ["playback-stop", "microphone-start"]);
  assert.equal(piRun.stopped, false, "voice interruption stopped the Pi agent");
  assert.equal(flow.dictation.snapshot().listening, true);
  await flow.session.dispose();
});

test("session shutdown is idempotent while recording and while speaking", async () => {
  const recording = buildSession();
  await recording.session.start();
  assert.deepEqual(await recording.session.dispose(), { ok: true });
  assert.deepEqual(await recording.session.dispose(), { ok: true });
  assert.equal(recording.stt.disposals, 1);
  assert.equal(recording.dictation.snapshot().state, "disposed");

  const speaking = buildSession({ playback: new FakeAudioPlayback({ autoComplete: false }) });
  speaking.session.handleMessage({ role: "assistant", content: "Still speaking." });
  await eventually(() => speaking.playback.active);
  assert.deepEqual(await speaking.session.dispose(), { ok: true });
  assert.equal(speaking.playback.active, false);
  assert.equal(speaking.playback.stops >= 1, true);
  assert.equal(speaking.tts.disposals, 1);
});

test("repeated dictation cycles release every fake microphone and provider", async () => {
  const captures = [];
  const providers = [];
  const view = editor();
  const settings = config("off");
  const dictation = new VoiceDictation({
    ui: view.ui,
    config: settings,
    createCapture: () => {
      const capture = new FakeAudioCapture();
      captures.push(capture);
      return capture;
    },
    createSttProvider: () => {
      const provider = new FakeStt(`cycle ${providers.length + 1}`);
      providers.push(provider);
      return provider;
    },
    inputProbe: async () => ({ available: true }),
    listDevices: async () => [],
    finalTimeoutMs: 500,
  });

  for (let cycle = 0; cycle < 5; cycle += 1) {
    await dictation.start();
    captures.at(-1).push([0, 1]);
    await dictation.stop();
  }
  assert.equal(captures.length, 5);
  assert.equal(providers.length, 5);
  assert.equal(providers.every(({ disposals }) => disposals === 1), true);
  assert.equal(dictation.snapshot().state, "idle");
  await dictation.dispose();
});
