import assert from "node:assert/strict";
import test from "node:test";

import { inspectVoiceCapability } from "../lib/voice/capability.mjs";
import {
  resolveVoiceConfig,
  voiceCredential,
  VOICE_DEFAULTS,
  VOICE_ENV,
  VOICE_LIMITS,
} from "../lib/voice/config.mjs";
import register from "../pi-package/extensions/kiln.js";

const SECRET = "throw-away-secret-for-tests";

test("voice configuration has deterministic, provider-independent defaults", () => {
  const config = resolveVoiceConfig({});
  assert.equal(config.enabled, false);
  assert.deepEqual(config.stt, { provider: "elevenlabs", model: "scribe_v2_realtime", language: null });
  assert.deepEqual(config.tts, { provider: "elevenlabs", model: "eleven_flash_v2_5", voiceId: null, mode: "off" });
  assert.deepEqual(config.elevenLabs, { enableLogging: false });
  assert.deepEqual(config.limits, {
    maxRecordingMs: VOICE_DEFAULTS.maxRecordingMs,
    maxTtsCharacters: VOICE_DEFAULTS.maxTtsCharacters,
  });
  assert.deepEqual(config.problems, []);
});

test("complete configuration is bounded and keeps credentials out of serializable state", () => {
  const config = resolveVoiceConfig({
    [VOICE_ENV.enabled]: "yes",
    [VOICE_ENV.sttModel]: "scribe-custom",
    [VOICE_ENV.ttsModel]: "flash-custom",
    [VOICE_ENV.ttsVoiceId]: "voice-123",
    [VOICE_ENV.sttLanguage]: "en",
    [VOICE_ENV.inputDevice]: "studio microphone",
    [VOICE_ENV.outputDevice]: "headphones",
    [VOICE_ENV.ttsMode]: "on",
    [VOICE_ENV.maxRecordingMs]: "90000",
    [VOICE_ENV.maxTtsCharacters]: "2500",
    [VOICE_ENV.elevenLabsEnableLogging]: "true",
    [VOICE_ENV.elevenLabsApiKey]: SECRET,
    ANTHROPIC_API_KEY: "unrelated-pi-provider-secret",
  });

  assert.equal(config.enabled, true);
  assert.equal(config.credentialPresent, true);
  assert.equal(config.stt.model, "scribe-custom");
  assert.equal(config.tts.voiceId, "voice-123");
  assert.equal(config.elevenLabs.enableLogging, true);
  assert.deepEqual(config.limits, { maxRecordingMs: 90_000, maxTtsCharacters: 2_500 });
  assert.equal(voiceCredential(config), SECRET);
  assert.equal(JSON.stringify(config).includes(SECRET), false);
  assert.equal(JSON.stringify(config).includes("unrelated-pi-provider-secret"), false);
});

test("malformed settings are reported without copying their values", () => {
  const oversized = "x".repeat(VOICE_LIMITS.maxSettingCharacters + 1);
  const config = resolveVoiceConfig({
    [VOICE_ENV.enabled]: "perhaps",
    [VOICE_ENV.elevenLabsEnableLogging]: "sometimes",
    [VOICE_ENV.sttProvider]: oversized,
    [VOICE_ENV.ttsMode]: "whenever-the-model-wants",
    [VOICE_ENV.maxRecordingMs]: String(VOICE_LIMITS.maxRecordingMs + 1),
    [VOICE_ENV.maxTtsCharacters]: "-1",
    [VOICE_ENV.elevenLabsApiKey]: SECRET,
  });
  const serialized = JSON.stringify(config);

  assert.equal(serialized.includes(SECRET), false);
  assert.equal(serialized.includes(oversized), false);
  assert.deepEqual(
    config.problems.map(({ name, reason }) => [name, reason]),
    [
      [VOICE_ENV.enabled, "invalid-boolean"],
      [VOICE_ENV.elevenLabsEnableLogging, "invalid-boolean"],
      [VOICE_ENV.sttProvider, "invalid-string"],
      [VOICE_ENV.maxRecordingMs, "exceeds-hard-limit"],
      [VOICE_ENV.maxTtsCharacters, "invalid-positive-integer"],
      [VOICE_ENV.ttsMode, "unsupported-mode"],
    ]
  );
});

test("capability separates missing credentials, input hardware, and output hardware", async () => {
  const missing = await inspectVoiceCapability({ config: resolveVoiceConfig({ [VOICE_ENV.enabled]: "true" }) });
  assert.equal(missing.stt.status, "missing-credential");
  assert.equal(missing.tts.status, "disabled");

  const env = {
    [VOICE_ENV.enabled]: "true",
    [VOICE_ENV.ttsMode]: "on",
    [VOICE_ENV.ttsVoiceId]: "voice-123",
    [VOICE_ENV.elevenLabsApiKey]: SECRET,
  };
  const hardware = await inspectVoiceCapability({
    config: resolveVoiceConfig(env),
    inputProbe: async () => ({ available: false, reason: "no-microphone" }),
    outputProbe: async () => ({ available: false, reason: "no-speaker" }),
  });
  assert.equal(hardware.status, "audio-input-unavailable");
  assert.deepEqual(hardware.stt, { status: "audio-input-unavailable", reason: "no-microphone", checked: true });
  assert.deepEqual(hardware.tts, { status: "audio-output-unavailable", reason: "no-speaker", checked: true });
});

test("missing TTS voice does not disable ready STT", async () => {
  const config = resolveVoiceConfig({
    [VOICE_ENV.enabled]: "true",
    [VOICE_ENV.ttsMode]: "on",
    [VOICE_ENV.elevenLabsApiKey]: SECRET,
  });
  const capability = await inspectVoiceCapability({ config, inputProbe: async () => ({ available: true }) });
  assert.equal(capability.status, "ready");
  assert.equal(capability.stt.status, "ready");
  assert.equal(capability.tts.status, "missing-voice");
});

test("configuration failures remain distinct from provider and hardware failures", async () => {
  const invalidEnabled = await inspectVoiceCapability({
    config: resolveVoiceConfig({ [VOICE_ENV.enabled]: "sometimes", [VOICE_ENV.elevenLabsApiKey]: SECRET }),
  });
  assert.equal(invalidEnabled.status, "invalid-configuration");

  const unsupportedMode = await inspectVoiceCapability({
    config: resolveVoiceConfig({
      [VOICE_ENV.enabled]: "true",
      [VOICE_ENV.ttsMode]: "automatic",
      [VOICE_ENV.elevenLabsApiKey]: SECRET,
    }),
  });
  assert.equal(unsupportedMode.stt.status, "ready");
  assert.equal(unsupportedMode.tts.status, "unsupported-mode");

  const unsupportedProvider = await inspectVoiceCapability({
    config: resolveVoiceConfig({
      [VOICE_ENV.enabled]: "true",
      [VOICE_ENV.sttProvider]: "not-a-provider",
      [VOICE_ENV.elevenLabsApiKey]: SECRET,
    }),
  });
  assert.equal(unsupportedProvider.stt.status, "provider-unavailable");
});

test("provider checks are opt-in and sanitize provider failures", async () => {
  let calls = 0;
  const config = resolveVoiceConfig({ [VOICE_ENV.enabled]: "true", [VOICE_ENV.elevenLabsApiKey]: SECRET });
  const providerProbe = async () => {
    calls += 1;
    const error = new Error(`provider rejected ${SECRET}`);
    error.code = `AUTH_FAILED_${SECRET}`;
    throw error;
  };

  const offline = await inspectVoiceCapability({ config, providerProbe });
  assert.equal(calls, 0);
  assert.equal(offline.stt.status, "ready");
  assert.equal(offline.liveProviderChecked, false);

  const live = await inspectVoiceCapability({ config, live: true, providerProbe });
  assert.equal(calls, 1);
  assert.equal(live.stt.status, "provider-unavailable");
  assert.equal(live.stt.reason, "probe-failed");
  assert.equal(JSON.stringify(live).includes(SECRET), false);
});

test("extension registration does not inspect voice environment variables", () => {
  const original = process.env;
  const reads = [];
  process.env = new Proxy({ [VOICE_ENV.elevenLabsApiKey]: SECRET }, {
    get(target, key) {
      if (Object.values(VOICE_ENV).includes(key)) reads.push(key);
      return Reflect.get(target, key);
    },
  });
  try {
    register({ registerTool() {}, on() {} });
  } finally {
    process.env = original;
  }
  assert.deepEqual(reads, []);
});

