import assert from "node:assert/strict";
import test from "node:test";

import { FakeAudioPlayback } from "../lib/voice/audio/fake-playback.mjs";
import { VoiceError } from "../lib/voice/errors.mjs";
import { SpeechQueue } from "../lib/voice/speech-queue.mjs";
import {
  ELEVENLABS_TTS_ERROR,
  ELEVENLABS_TTS_RETENTION,
  ElevenLabsTtsProvider,
  PCM_24000,
} from "../lib/voice/tts/elevenlabs.mjs";

const SECRET = "temporary-test-secret-that-must-never-escape";
const AUDIO = Uint8Array.from([0, 1, 2, 3]);

function response({ status = 200, audio = AUDIO, headers = new Map() } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => headers.get(name.toLowerCase()) ?? null },
    async arrayBuffer() { return audio.buffer.slice(audio.byteOffset, audio.byteOffset + audio.byteLength); },
  };
}

function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

test("ElevenLabs receives only prepared text and returns provider-neutral PCM", async () => {
  const requests = [];
  const provider = new ElevenLabsTtsProvider({
    apiKey: SECRET,
    voiceId: "voice_123",
    fetchImpl: async (url, init) => {
      requests.push({ url, init });
      return response();
    },
    enableLogging: true,
  });

  const synthesis = await provider.synthesize("Prepared assistant prose.");
  assert.deepEqual(synthesis.format, PCM_24000);
  assert.deepEqual(synthesis.audio, AUDIO);
  assert.equal(requests.length, 1);
  const url = new URL(requests[0].url);
  assert.equal(url.pathname, "/v1/text-to-speech/voice_123");
  assert.equal(url.searchParams.get("output_format"), "pcm_24000");
  assert.equal(url.searchParams.get("enable_logging"), "true");
  assert.equal(requests[0].init.headers["xi-api-key"], SECRET);
  assert.deepEqual(JSON.parse(requests[0].init.body), {
    text: "Prepared assistant prose.",
    model_id: "eleven_flash_v2_5",
  });
  assert.equal(synthesis.retention, ELEVENLABS_TTS_RETENTION.LOGGING_ENABLED);
  assert.equal(requests[0].url.includes(SECRET), false);
});

test("ElevenLabs synthesis is cancellable and provider failures never disclose credentials", async () => {
  let requestSignal;
  const provider = new ElevenLabsTtsProvider({
    apiKey: SECRET,
    voiceId: "voice_123",
    fetchImpl: async (_url, init) => {
      requestSignal = init.signal;
      await new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(new Error(SECRET)), { once: true }));
    },
  });
  const controller = new AbortController();
  const pending = provider.synthesize("Cancel me.", { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, (error) => {
    assert.equal(error.code, ELEVENLABS_TTS_ERROR.CANCELLED);
    assert.equal(JSON.stringify(error).includes(SECRET), false);
    return true;
  });
  assert.equal(requestSignal.aborted, true);

  const rejected = new ElevenLabsTtsProvider({
    apiKey: SECRET,
    voiceId: "voice_123",
    fetchImpl: async () => ({ ...response({ status: 401 }), async text() { return SECRET; } }),
  });
  await assert.rejects(rejected.synthesize("No secret."), (error) => {
    assert.equal(error.code, ELEVENLABS_TTS_ERROR.AUTH);
    assert.equal(`${error.message}${JSON.stringify(error.details)}`.includes(SECRET), false);
    return true;
  });
});

test("ElevenLabs logging remains off by default and rejected response bodies are cancelled", async () => {
  let cancelled = 0;
  let requestedUrl;
  const provider = new ElevenLabsTtsProvider({
    apiKey: SECRET,
    voiceId: "voice_123",
    fetchImpl: async (url) => {
      requestedUrl = url;
      return {
        ...response({ status: 400 }),
        body: { async cancel() { cancelled += 1; } },
      };
    },
  });

  await assert.rejects(provider.synthesize("Privacy first."), { code: ELEVENLABS_TTS_ERROR.PROVIDER });
  assert.equal(new URL(requestedUrl).searchParams.get("enable_logging"), "false");
  assert.equal(cancelled, 1);
});

test("ElevenLabs enforces response and text bounds without persisting audio", async () => {
  const provider = new ElevenLabsTtsProvider({
    apiKey: SECRET,
    voiceId: "voice_123",
    maxAudioBytes: 4,
    maxTextCharacters: 5,
    fetchImpl: async () => response({ audio: Uint8Array.from([0, 1, 2, 3, 4, 5]) }),
  });
  await assert.rejects(provider.synthesize("longer"), { code: ELEVENLABS_TTS_ERROR.INVALID });
  await assert.rejects(provider.synthesize("short"), { code: ELEVENLABS_TTS_ERROR.BOUNDS });
});

class FakeTtsProvider {
  constructor({ failText = null, gate = null } = {}) {
    this.failText = failText;
    this.gate = gate;
    this.calls = [];
    this.disposals = 0;
  }
  async synthesize(text, { signal }) {
    this.calls.push(text);
    if (this.gate) await this.gate(signal);
    if (this.failText === text) throw new VoiceError("fake-provider-failure", "Sanitized fake failure.");
    return { format: PCM_24000, audio: Uint8Array.from([0, this.calls.length]) };
  }
  async dispose() { this.disposals += 1; }
}

test("speech queue enqueue is non-blocking and playback remains FIFO", async () => {
  const provider = new FakeTtsProvider();
  const playback = new FakeAudioPlayback();
  const queue = new SpeechQueue({ provider, playback });

  assert.deepEqual(queue.enqueue("first"), { accepted: true, id: 1 });
  assert.deepEqual(queue.enqueue("second"), { accepted: true, id: 2 });
  assert.deepEqual(provider.calls, []);
  await queue.idle();
  assert.deepEqual(provider.calls, ["first", "second"]);
  assert.deepEqual(playback.plays.map((play) => [...play.audio]), [[0, 1], [0, 2]]);
  assert.deepEqual(queue.status, { state: "idle", items: 0, characters: 0 });
});

test("speech queue bounds content and recovers after a provider failure", async () => {
  const provider = new FakeTtsProvider({ failText: "bad" });
  const playback = new FakeAudioPlayback();
  const errors = [];
  const queue = new SpeechQueue({ provider, playback, onError: (error, item) => errors.push({ error, item }), maxItems: 2, maxQueuedCharacters: 8 });

  assert.equal(queue.enqueue("bad").accepted, true);
  assert.equal(queue.enqueue("good").accepted, true);
  assert.deepEqual(queue.enqueue("x"), { accepted: false, reason: "bounds" });
  await queue.idle();
  assert.deepEqual(provider.calls, ["bad", "good"]);
  assert.equal(playback.plays.length, 1);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].error.code, "fake-provider-failure");
  assert.deepEqual(errors[0].item, { id: 1, characters: 3 });
});

test("speech queue cancellation clears pending work and disposal owns both resources", async () => {
  let started;
  const active = new Promise((resolve) => { started = resolve; });
  const provider = new FakeTtsProvider({
    gate: (signal) => new Promise((resolve) => {
      started();
      signal.addEventListener("abort", resolve, { once: true });
    }),
  });
  const playback = new FakeAudioPlayback({ autoComplete: false });
  const queue = new SpeechQueue({ provider, playback });
  queue.enqueue("current");
  queue.enqueue("pending");
  await active;
  assert.deepEqual(queue.cancel(), { active: true, cleared: 1 });
  await queue.idle();
  assert.deepEqual(provider.calls, ["current"]);
  assert.equal(playback.plays.length, 0);

  await queue.dispose();
  assert.equal(provider.disposals, 1);
  assert.equal(playback.stops >= 1, true);
  assert.deepEqual(queue.enqueue("later"), { accepted: false, reason: "disposed" });
  await queue.dispose();
  await flush();
});
