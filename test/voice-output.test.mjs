import assert from "node:assert/strict";
import test from "node:test";

import { FakeAudioPlayback } from "../lib/voice/audio/fake-playback.mjs";
import { resolveVoiceConfig, VOICE_ENV } from "../lib/voice/config.mjs";
import { VoiceOutput } from "../lib/voice/output.mjs";
import { PiVoiceSession } from "../lib/voice/session.mjs";
import { PCM_24000 } from "../lib/voice/tts/elevenlabs.mjs";

function outputConfig(mode = "off") {
  return resolveVoiceConfig({
    [VOICE_ENV.enabled]: "true",
    [VOICE_ENV.ttsMode]: mode,
    [VOICE_ENV.ttsVoiceId]: "voice_123",
    [VOICE_ENV.elevenLabsApiKey]: "test-key",
  });
}

class FakeTtsProvider {
  constructor() {
    this.calls = [];
    this.disposals = 0;
  }
  async synthesize(text) {
    this.calls.push(text);
    return { format: PCM_24000, audio: Uint8Array.from([0, this.calls.length]) };
  }
  async dispose() { this.disposals += 1; }
}

function harness(mode = "off") {
  const provider = new FakeTtsProvider();
  const playback = new FakeAudioPlayback();
  const notifications = [];
  const output = new VoiceOutput({
    ui: { notify: (message, type) => notifications.push({ message, type }) },
    config: outputConfig(mode),
    createTtsProvider: () => provider,
    createPlayback: () => playback,
  });
  return { output, provider, playback, notifications };
}

test("operator-controlled output speaks only finalized assistant prose", async () => {
  const { output, provider, playback } = harness();
  assert.deepEqual(output.handleMessage({ role: "assistant", content: "not enabled" }), { accepted: false, reason: "disabled" });
  await output.on();

  assert.equal(output.handleMessage({ role: "system", content: "system" }).reason, "ineligible");
  assert.equal(output.handleMessage({ role: "toolResult", content: "tool result" }).reason, "ineligible");
  const queued = output.handleMessage({
    role: "assistant",
    content: [{ type: "thinking", thinking: "hidden" }, { type: "text", text: "**Final** response." }],
  });
  assert.equal(queued.accepted, true);
  assert.deepEqual(provider.calls, [], "message handler awaited synthesis inline");
  while (output.status().queue !== "idle") await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(provider.calls, ["Final response."]);
  assert.equal(playback.plays.length, 1);
});

test("output off cancels current work, clears pending speech, and leaves later STT independent", async () => {
  let unblock;
  const provider = new FakeTtsProvider();
  provider.synthesize = async (text, { signal }) => {
    provider.calls.push(text);
    await new Promise((resolve) => {
      unblock = resolve;
      signal.addEventListener("abort", resolve, { once: true });
    });
    return { format: PCM_24000, audio: Uint8Array.from([0, 1]) };
  };
  const playback = new FakeAudioPlayback({ autoComplete: false });
  const output = new VoiceOutput({
    ui: {},
    config: outputConfig("on"),
    createTtsProvider: () => provider,
    createPlayback: () => playback,
  });
  output.handleMessage({ role: "assistant", content: "current" });
  output.handleMessage({ role: "assistant", content: "pending" });
  while (provider.calls.length === 0) await new Promise((resolve) => setImmediate(resolve));
  await output.off();
  unblock?.();
  assert.deepEqual(provider.calls, ["current"]);
  assert.equal(output.status().status, "disabled");

  const order = [];
  const dictation = {
    start: async () => order.push("microphone"),
    stop: async () => {},
    snapshot: () => ({ listening: false }),
    status: async () => ({ state: "idle", stt: { status: "ready" }, tts: { status: "disabled" } }),
    devices: async () => [],
    dispose: async () => {},
  };
  const independentOutput = {
    interrupt: async () => order.push("playback-stopped"),
    on: async () => {},
    off: async () => {},
    handleMessage: () => {},
    status: () => ({ status: "error" }),
    dispose: async () => { throw new Error("TTS cleanup failure"); },
  };
  const session = new PiVoiceSession({ dictation, output: independentOutput });
  await session.start();
  assert.deepEqual(order, ["playback-stopped", "microphone"]);
  assert.deepEqual(await session.dispose(), { ok: false });
});

test("configured output mode is opt-in and missing output requirements do not disable dictation", async () => {
  const enabled = harness("on");
  assert.equal(enabled.output.enabled, true);
  enabled.output.handleMessage({ role: "assistant", content: "Configured opt in." });
  while (enabled.output.status().queue !== "idle") await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(enabled.provider.calls, ["Configured opt in."]);

  const missingVoice = new VoiceOutput({
    ui: {},
    config: resolveVoiceConfig({ [VOICE_ENV.enabled]: "true", [VOICE_ENV.elevenLabsApiKey]: "key" }),
    createTtsProvider: () => assert.fail("provider must not be created"),
    createPlayback: () => assert.fail("playback must not be created"),
  });
  await assert.rejects(missingVoice.on(), { code: "tts-voice-missing" });

  let starts = 0;
  const session = new PiVoiceSession({
    dictation: {
      start: async () => { starts += 1; },
      stop: async () => {},
      snapshot: () => ({ listening: false }),
      status: async () => ({ state: "idle", stt: { status: "ready" }, tts: { status: "disabled" } }),
      devices: async () => [],
      dispose: async () => {},
    },
    output: {
      interrupt: async () => {},
      on: () => missingVoice.on(),
      off: () => missingVoice.off(),
      handleMessage: (message) => missingVoice.handleMessage(message),
      status: () => missingVoice.status(),
      dispose: () => missingVoice.dispose(),
    },
  });
  await session.start();
  assert.equal(starts, 1);
  assert.equal((await session.status()).stt.status, "ready");
});
