const SECRET_BY_CONFIG = new WeakMap();

export const VOICE_ENV = Object.freeze({
  enabled: "KILN_VOICE_ENABLED",
  sttProvider: "KILN_STT_PROVIDER",
  ttsProvider: "KILN_TTS_PROVIDER",
  sttModel: "KILN_STT_MODEL",
  ttsModel: "KILN_TTS_MODEL",
  ttsVoiceId: "KILN_TTS_VOICE_ID",
  sttLanguage: "KILN_STT_LANGUAGE",
  inputDevice: "KILN_VOICE_INPUT_DEVICE",
  outputDevice: "KILN_VOICE_OUTPUT_DEVICE",
  ttsMode: "KILN_TTS_MODE",
  maxRecordingMs: "KILN_VOICE_MAX_RECORDING_MS",
  maxTtsCharacters: "KILN_TTS_MAX_CHARACTERS",
  elevenLabsEnableLogging: "KILN_ELEVENLABS_ENABLE_LOGGING",
  elevenLabsApiKey: "ELEVENLABS_API_KEY",
});

export const VOICE_DEFAULTS = Object.freeze({
  enabled: false,
  sttProvider: "elevenlabs",
  ttsProvider: "elevenlabs",
  sttModel: "scribe_v2_realtime",
  ttsModel: "eleven_flash_v2_5",
  ttsMode: "off",
  maxRecordingMs: 120_000,
  maxTtsCharacters: 4_000,
  elevenLabsEnableLogging: false,
});

export const VOICE_LIMITS = Object.freeze({
  maxRecordingMs: 300_000,
  maxTtsCharacters: 20_000,
  maxSettingCharacters: 256,
});

const TRUE_VALUES = new Set(["1", "true", "yes", "on"]);
const FALSE_VALUES = new Set(["0", "false", "no", "off"]);
const TTS_MODES = new Set(["off", "on"]);
const PROVIDERS = new Set(["elevenlabs"]);

function problem(name, reason) {
  return Object.freeze({ name, reason });
}

function optionalString(env, name, problems, { lower = false, max = VOICE_LIMITS.maxSettingCharacters } = {}) {
  const raw = env[name];
  if (raw === undefined || raw === "") return null;
  if (typeof raw !== "string" || raw.length > max || raw.trim().length === 0) {
    problems.push(problem(name, "invalid-string"));
    return null;
  }
  const value = raw.trim();
  return lower ? value.toLowerCase() : value;
}

function booleanSetting(env, name, fallback, problems) {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  if (typeof raw !== "string") {
    problems.push(problem(name, "invalid-boolean"));
    return fallback;
  }
  const normalized = raw.trim().toLowerCase();
  if (TRUE_VALUES.has(normalized)) return true;
  if (FALSE_VALUES.has(normalized)) return false;
  problems.push(problem(name, "invalid-boolean"));
  return fallback;
}

function boundedInteger(env, name, fallback, ceiling, problems) {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  if (typeof raw !== "string" || !/^[1-9][0-9]*$/.test(raw)) {
    problems.push(problem(name, "invalid-positive-integer"));
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value > ceiling) {
    problems.push(problem(name, "exceeds-hard-limit"));
    return fallback;
  }
  return value;
}

/**
 * Resolve voice settings only when an operator-facing caller asks for them.
 *
 * The returned object is deliberately safe to log or snapshot. The credential is retained in a
 * module-private WeakMap and can only be retrieved explicitly with `voiceCredential`.
 */
export function resolveVoiceConfig(env = process.env) {
  const problems = [];
  const enabled = booleanSetting(env, VOICE_ENV.enabled, VOICE_DEFAULTS.enabled, problems);
  const elevenLabsEnableLogging = booleanSetting(
    env,
    VOICE_ENV.elevenLabsEnableLogging,
    VOICE_DEFAULTS.elevenLabsEnableLogging,
    problems
  );
  const sttProvider = optionalString(env, VOICE_ENV.sttProvider, problems, { lower: true }) ?? VOICE_DEFAULTS.sttProvider;
  const ttsProvider = optionalString(env, VOICE_ENV.ttsProvider, problems, { lower: true }) ?? VOICE_DEFAULTS.ttsProvider;
  const sttModel = optionalString(env, VOICE_ENV.sttModel, problems) ?? VOICE_DEFAULTS.sttModel;
  const ttsModel = optionalString(env, VOICE_ENV.ttsModel, problems) ?? VOICE_DEFAULTS.ttsModel;
  const ttsVoiceId = optionalString(env, VOICE_ENV.ttsVoiceId, problems);
  const sttLanguage = optionalString(env, VOICE_ENV.sttLanguage, problems, { max: 64 });
  const inputDevice = optionalString(env, VOICE_ENV.inputDevice, problems);
  const outputDevice = optionalString(env, VOICE_ENV.outputDevice, problems);
  const ttsMode = optionalString(env, VOICE_ENV.ttsMode, problems, { lower: true }) ?? VOICE_DEFAULTS.ttsMode;
  const maxRecordingMs = boundedInteger(
    env,
    VOICE_ENV.maxRecordingMs,
    VOICE_DEFAULTS.maxRecordingMs,
    VOICE_LIMITS.maxRecordingMs,
    problems
  );
  const maxTtsCharacters = boundedInteger(
    env,
    VOICE_ENV.maxTtsCharacters,
    VOICE_DEFAULTS.maxTtsCharacters,
    VOICE_LIMITS.maxTtsCharacters,
    problems
  );

  if (!PROVIDERS.has(sttProvider)) problems.push(problem(VOICE_ENV.sttProvider, "unsupported-provider"));
  if (!PROVIDERS.has(ttsProvider)) problems.push(problem(VOICE_ENV.ttsProvider, "unsupported-provider"));
  if (!TTS_MODES.has(ttsMode)) problems.push(problem(VOICE_ENV.ttsMode, "unsupported-mode"));

  const rawCredential = env[VOICE_ENV.elevenLabsApiKey];
  const credential = typeof rawCredential === "string" && rawCredential.trim().length > 0 ? rawCredential : null;
  const config = Object.freeze({
    enabled,
    stt: Object.freeze({ provider: sttProvider, model: sttModel, language: sttLanguage }),
    tts: Object.freeze({ provider: ttsProvider, model: ttsModel, voiceId: ttsVoiceId, mode: ttsMode }),
    audio: Object.freeze({ inputDevice, outputDevice }),
    elevenLabs: Object.freeze({ enableLogging: elevenLabsEnableLogging }),
    limits: Object.freeze({ maxRecordingMs, maxTtsCharacters }),
    credentialPresent: credential !== null,
    problems: Object.freeze(problems),
  });
  SECRET_BY_CONFIG.set(config, credential);
  return config;
}

/** Return the credential only to a provider factory that already holds the resolved configuration. */
export function voiceCredential(config, provider = "elevenlabs") {
  if (!SECRET_BY_CONFIG.has(config) || provider !== "elevenlabs") return null;
  return SECRET_BY_CONFIG.get(config);
}

