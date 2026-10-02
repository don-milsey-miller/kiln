import { resolveVoiceConfig } from "./config.mjs";

export const VOICE_CAPABILITY_STATUS = Object.freeze({
  DISABLED: "disabled",
  READY: "ready",
  INVALID_CONFIGURATION: "invalid-configuration",
  MISSING_CREDENTIAL: "missing-credential",
  AUDIO_INPUT_UNAVAILABLE: "audio-input-unavailable",
  AUDIO_OUTPUT_UNAVAILABLE: "audio-output-unavailable",
  PROVIDER_UNAVAILABLE: "provider-unavailable",
  MISSING_VOICE: "missing-voice",
  UNSUPPORTED_MODE: "unsupported-mode",
});

function result(status, reason = null, checked = false) {
  return Object.freeze({ status, reason, checked });
}

const SAFE_REASONS = new Set([
  "auth-failed",
  "dependency-missing",
  "network-unavailable",
  "no-microphone",
  "no-speaker",
  "not-found",
  "permission-denied",
  "probe-failed",
  "provider-rejected",
  "rate-limited",
  "unavailable",
  "unsupported-platform",
]);

function safeReason(value, fallback) {
  return SAFE_REASONS.has(value) ? value : fallback;
}

function relevantProblem(config, names) {
  return config.problems.find((entry) => names.includes(entry.name)) ?? null;
}

async function hardwareStatus(probe, unavailableStatus) {
  if (typeof probe !== "function") return result(VOICE_CAPABILITY_STATUS.READY, "not-probed", false);
  try {
    const answer = await probe();
    return answer?.available === true
      ? result(VOICE_CAPABILITY_STATUS.READY, null, true)
      : result(unavailableStatus, safeReason(answer?.reason, "unavailable"), true);
  } catch (error) {
    return result(unavailableStatus, safeReason(error?.code, "probe-failed"), true);
  }
}

async function liveProviderStatus(config, live, providerProbe) {
  if (!live) return result(VOICE_CAPABILITY_STATUS.READY, "not-probed", false);
  if (typeof providerProbe !== "function") return result(VOICE_CAPABILITY_STATUS.PROVIDER_UNAVAILABLE, "probe-unavailable", false);
  try {
    const answer = await providerProbe({ provider: "elevenlabs", sttModel: config.stt.model, ttsModel: config.tts.model });
    return answer?.available === true
      ? result(VOICE_CAPABILITY_STATUS.READY, null, true)
      : result(VOICE_CAPABILITY_STATUS.PROVIDER_UNAVAILABLE, safeReason(answer?.reason, "unavailable"), true);
  } catch (error) {
    return result(
      VOICE_CAPABILITY_STATUS.PROVIDER_UNAVAILABLE,
      safeReason(error?.code, "probe-failed"),
      true
    );
  }
}

/**
 * Produce a bounded status for `/voice status`. Hardware probes are injectable and provider traffic
 * occurs only when `live` is exactly true.
 */
export async function inspectVoiceCapability({
  config = resolveVoiceConfig(),
  live = false,
  inputProbe,
  outputProbe,
  providerProbe,
} = {}) {
  const enabledProblem = relevantProblem(config, ["KILN_VOICE_ENABLED"]);
  if (enabledProblem) {
    const invalid = result(VOICE_CAPABILITY_STATUS.INVALID_CONFIGURATION, enabledProblem.reason);
    return Object.freeze({ status: invalid.status, stt: invalid, tts: invalid, liveProviderChecked: false });
  }
  if (!config.enabled) {
    const disabled = result(VOICE_CAPABILITY_STATUS.DISABLED);
    return Object.freeze({ status: disabled.status, stt: disabled, tts: disabled, liveProviderChecked: false });
  }

  const sttProblem = relevantProblem(config, ["KILN_STT_PROVIDER", "KILN_STT_MODEL", "KILN_STT_LANGUAGE", "KILN_VOICE_INPUT_DEVICE", "KILN_VOICE_MAX_RECORDING_MS", "KILN_ELEVENLABS_ENABLE_LOGGING"]);
  const ttsProblem = relevantProblem(config, ["KILN_TTS_PROVIDER", "KILN_TTS_MODEL", "KILN_TTS_VOICE_ID", "KILN_VOICE_OUTPUT_DEVICE", "KILN_TTS_MAX_CHARACTERS", "KILN_ELEVENLABS_ENABLE_LOGGING"]);
  const modeProblem = relevantProblem(config, ["KILN_TTS_MODE"]);

  let stt;
  if (sttProblem) {
    const status = sttProblem.reason === "unsupported-provider" ? VOICE_CAPABILITY_STATUS.PROVIDER_UNAVAILABLE : VOICE_CAPABILITY_STATUS.INVALID_CONFIGURATION;
    stt = result(status, sttProblem.reason);
  } else if (!config.credentialPresent) {
    stt = result(VOICE_CAPABILITY_STATUS.MISSING_CREDENTIAL);
  } else {
    stt = await hardwareStatus(inputProbe, VOICE_CAPABILITY_STATUS.AUDIO_INPUT_UNAVAILABLE);
  }

  let tts;
  if (modeProblem) {
    tts = result(VOICE_CAPABILITY_STATUS.UNSUPPORTED_MODE, modeProblem.reason);
  } else if (config.tts.mode === "off") {
    tts = result(VOICE_CAPABILITY_STATUS.DISABLED);
  } else if (ttsProblem) {
    const status = ttsProblem.reason === "unsupported-provider" ? VOICE_CAPABILITY_STATUS.PROVIDER_UNAVAILABLE : VOICE_CAPABILITY_STATUS.INVALID_CONFIGURATION;
    tts = result(status, ttsProblem.reason);
  } else if (!config.credentialPresent) {
    tts = result(VOICE_CAPABILITY_STATUS.MISSING_CREDENTIAL);
  } else if (!config.tts.voiceId) {
    tts = result(VOICE_CAPABILITY_STATUS.MISSING_VOICE);
  } else {
    tts = await hardwareStatus(outputProbe, VOICE_CAPABILITY_STATUS.AUDIO_OUTPUT_UNAVAILABLE);
  }

  let provider = result(VOICE_CAPABILITY_STATUS.READY, "not-needed", false);
  if (config.credentialPresent && (stt.status === VOICE_CAPABILITY_STATUS.READY || tts.status === VOICE_CAPABILITY_STATUS.READY)) {
    provider = await liveProviderStatus(config, live === true, providerProbe);
    if (provider.status !== VOICE_CAPABILITY_STATUS.READY) {
      if (stt.status === VOICE_CAPABILITY_STATUS.READY) stt = provider;
      if (tts.status === VOICE_CAPABILITY_STATUS.READY) tts = provider;
    }
  }

  return Object.freeze({
    status: stt.status,
    stt,
    tts,
    liveProviderChecked: provider.checked,
  });
}

