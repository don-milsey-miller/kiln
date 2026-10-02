import { FfplayAudioPlayback } from "./audio/ffplay-playback.mjs";
import { VOICE_ENV, VOICE_LIMITS } from "./config.mjs";
import { VoiceError, VOICE_ERROR_CODES } from "./errors.mjs";
import { SpeechQueue } from "./speech-queue.mjs";
import { speechText } from "./speech-text.mjs";
import { createElevenLabsTtsProviderFromConfig } from "./tts/elevenlabs.mjs";

export const OUTPUT_ERROR = Object.freeze({
  CONFIGURATION: "voice-output-configuration-invalid",
  DISABLED: "voice-output-disabled",
  MISSING_CREDENTIAL: "tts-authentication-failed",
  MISSING_VOICE: "tts-voice-missing",
});

function outputError(code, message, details = {}) {
  return new VoiceError(code, message, details);
}

function safeUi(callback) {
  try {
    callback?.();
  } catch {
    // UI feedback cannot own speech output.
  }
}

function safeFailure(error) {
  return Object.freeze({
    code: typeof error?.code === "string" ? error.code : VOICE_ERROR_CODES.OPERATION,
    message: error instanceof VoiceError ? error.message : "Voice output failed.",
  });
}

/** Runtime operator control for deterministic assistant speech. */
export class VoiceOutput {
  #ui;
  #config;
  #createProvider;
  #createPlayback;
  #queue = null;
  #enabled;
  #failure = null;
  #disposed = false;

  constructor({ ui, config, createTtsProvider, createPlayback }) {
    this.#ui = ui;
    this.#config = config;
    this.#createProvider = createTtsProvider;
    this.#createPlayback = createPlayback;
    this.#enabled = config?.enabled === true && config?.tts?.mode === "on";
  }

  #validateConfiguration() {
    if (!this.#config?.enabled) {
      throw outputError(OUTPUT_ERROR.DISABLED, "Voice is disabled. Set KILN_VOICE_ENABLED=true to enable speech output.");
    }
    const problem = this.#config.problems?.find(({ name }) => [
      VOICE_ENV.ttsProvider,
      VOICE_ENV.ttsModel,
      VOICE_ENV.ttsVoiceId,
      VOICE_ENV.outputDevice,
      VOICE_ENV.maxTtsCharacters,
    ].includes(name));
    if (problem) {
      throw outputError(OUTPUT_ERROR.CONFIGURATION, "Voice output configuration is invalid.", {
        setting: problem.name,
        reason: problem.reason,
      });
    }
    if (!this.#config.credentialPresent) {
      throw outputError(OUTPUT_ERROR.MISSING_CREDENTIAL, "An ElevenLabs speech credential is required.");
    }
    if (!this.#config.tts.voiceId) {
      throw outputError(OUTPUT_ERROR.MISSING_VOICE, "KILN_TTS_VOICE_ID is required for speech output.");
    }
  }

  #ensureQueue() {
    if (this.#queue) return this.#queue;
    this.#validateConfiguration();
    const provider = this.#createProvider();
    let playback;
    try {
      playback = this.#createPlayback();
      this.#queue = new SpeechQueue({
        provider,
        playback,
        maxQueuedCharacters: VOICE_LIMITS.maxTtsCharacters,
        onError: (error) => this.#onFailure(error),
      });
      return this.#queue;
    } catch (error) {
      void Promise.resolve(playback?.dispose?.()).catch(() => {});
      void Promise.resolve(provider?.dispose?.()).catch(() => {});
      throw error;
    }
  }

  #onFailure(error) {
    this.#failure = safeFailure(error);
    safeUi(() => this.#ui?.notify?.(`Voice output failed (${this.#failure.code}).`, "error"));
  }

  get enabled() {
    return this.#enabled && !this.#disposed;
  }

  async on() {
    if (this.#disposed) throw outputError(VOICE_ERROR_CODES.DISPOSED, "Voice output is disposed.");
    try {
      this.#validateConfiguration();
      this.#ensureQueue();
      this.#enabled = true;
      this.#failure = null;
      return this.status();
    } catch (error) {
      this.#enabled = false;
      this.#failure = safeFailure(error);
      throw error;
    }
  }

  async off() {
    this.#enabled = false;
    this.#failure = null;
    const queue = this.#queue;
    this.#queue = null;
    if (queue) await queue.dispose();
    return this.status();
  }

  handleMessage(message) {
    if (!this.enabled) return Object.freeze({ accepted: false, reason: "disabled" });
    try {
      const text = speechText(message, { maxCharacters: this.#config.limits.maxTtsCharacters });
      if (!text) return Object.freeze({ accepted: false, reason: "ineligible" });
      const queued = this.#ensureQueue().enqueue(text);
      if (!queued.accepted && queued.reason === "bounds") {
        safeUi(() => this.#ui?.notify?.("Voice output queue is full; this response was not spoken.", "warning"));
      }
      return queued;
    } catch (error) {
      this.#onFailure(error);
      return Object.freeze({ accepted: false, reason: "failed" });
    }
  }

  async interrupt() {
    const queue = this.#queue;
    if (!queue) return Object.freeze({ active: false, cleared: 0 });
    const result = queue.cancel({ clear: true });
    await queue.idle();
    return result;
  }

  status() {
    if (this.#disposed) return Object.freeze({ status: "disposed", reason: null, queue: "idle" });
    if (!this.#enabled) return Object.freeze({ status: "disabled", reason: this.#failure?.code ?? null, queue: "idle" });
    if (this.#failure) return Object.freeze({ status: "error", reason: this.#failure.code, queue: this.#queue?.status.state ?? "idle" });
    return Object.freeze({ status: "ready", reason: null, queue: this.#queue?.status.state ?? "idle" });
  }

  async dispose() {
    if (this.#disposed) return Object.freeze({ ok: true, alreadyDisposed: true });
    await this.off();
    this.#disposed = true;
    return Object.freeze({ ok: true, alreadyDisposed: false });
  }
}

export function createPiVoiceOutput({ ui, config, overrides = {} }) {
  return new VoiceOutput({
    ui,
    config,
    createTtsProvider: overrides.createTtsProvider ?? (() => createElevenLabsTtsProviderFromConfig(config)),
    createPlayback: overrides.createPlayback ?? (() => new FfplayAudioPlayback({ device: config.audio.outputDevice })),
  });
}
