import { Buffer } from "node:buffer";

import { VOICE_DEFAULTS, VOICE_LIMITS, voiceCredential } from "../config.mjs";
import { VoiceError } from "../errors.mjs";

const TTS_ENDPOINT = "https://api.elevenlabs.io/v1/text-to-speech";
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_AUDIO_BYTES = 64 * 1024 * 1024;

export const PCM_24000 = Object.freeze({
  encoding: "pcm_24000",
  sampleRate: 24_000,
  channels: 1,
  sampleFormat: "s16le",
  bytesPerSample: 2,
});

export const ELEVENLABS_TTS_RETENTION = Object.freeze({
  LOGGING_ENABLED: "logging-enabled",
  ZERO_RETENTION_REQUESTED_UNCONFIRMED: "zero-retention-requested-unconfirmed",
});

export const ELEVENLABS_TTS_ERROR = Object.freeze({
  AUTH: "tts-authentication-failed",
  BOUNDS: "tts-response-bounds-exceeded",
  CANCELLED: "tts-cancelled",
  DISPOSED: "tts-provider-disposed",
  INVALID: "tts-request-invalid",
  PROVIDER: "tts-provider-failed",
  QUOTA: "tts-quota-exceeded",
  RATE_LIMITED: "tts-rate-limited",
  TIMEOUT: "tts-request-timeout",
  TRANSPORT: "tts-connection-failed",
});

function ttsError(code, message, details = {}) {
  return new VoiceError(code, message, details);
}

function validateIdentifier(value, name) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,256}$/.test(value)) {
    throw ttsError(ELEVENLABS_TTS_ERROR.INVALID, `The ElevenLabs ${name} setting is invalid.`);
  }
  return value;
}

function validateBound(value, name, maximum) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw ttsError(ELEVENLABS_TTS_ERROR.INVALID, `The ElevenLabs ${name} bound is invalid.`);
  }
  return value;
}

function responseError(status) {
  if (status === 401 || status === 403) {
    return ttsError(ELEVENLABS_TTS_ERROR.AUTH, "ElevenLabs rejected the speech credential.");
  }
  if (status === 402) {
    return ttsError(ELEVENLABS_TTS_ERROR.QUOTA, "The ElevenLabs speech quota is exhausted.");
  }
  if (status === 429) {
    return ttsError(ELEVENLABS_TTS_ERROR.RATE_LIMITED, "ElevenLabs temporarily rate limited speech synthesis.");
  }
  return ttsError(ELEVENLABS_TTS_ERROR.PROVIDER, "ElevenLabs rejected the speech synthesis request.", {
    status: Number.isInteger(status) ? status : null,
  });
}

async function readBoundedAudio(response, maximumBytes) {
  const declared = Number(response.headers?.get?.("content-length"));
  if (Number.isFinite(declared) && declared > maximumBytes) {
    throw ttsError(ELEVENLABS_TTS_ERROR.BOUNDS, "Synthesized speech exceeded the audio byte bound.", {
      maximumBytes,
    });
  }
  const chunks = [];
  let bytes = 0;
  if (typeof response.body?.[Symbol.asyncIterator] === "function") {
    for await (const chunk of response.body) {
      if (!(chunk instanceof Uint8Array)) {
        throw ttsError(ELEVENLABS_TTS_ERROR.PROVIDER, "ElevenLabs returned an invalid speech response.");
      }
      bytes += chunk.byteLength;
      if (bytes > maximumBytes) {
        throw ttsError(ELEVENLABS_TTS_ERROR.BOUNDS, "Synthesized speech exceeded the audio byte bound.", {
          maximumBytes,
        });
      }
      chunks.push(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength));
    }
  } else if (typeof response.arrayBuffer === "function") {
    const value = new Uint8Array(await response.arrayBuffer());
    bytes = value.byteLength;
    if (bytes > maximumBytes) {
      throw ttsError(ELEVENLABS_TTS_ERROR.BOUNDS, "Synthesized speech exceeded the audio byte bound.", {
        maximumBytes,
      });
    }
    chunks.push(Buffer.from(value));
  } else {
    throw ttsError(ELEVENLABS_TTS_ERROR.PROVIDER, "ElevenLabs returned an invalid speech response.");
  }
  if (bytes === 0 || bytes % 2 !== 0) {
    throw ttsError(ELEVENLABS_TTS_ERROR.PROVIDER, "ElevenLabs returned invalid PCM speech audio.");
  }
  return new Uint8Array(Buffer.concat(chunks, bytes));
}

/** ElevenLabs HTTP adapter. It accepts prepared prose and returns provider-neutral in-memory PCM. */
export class ElevenLabsTtsProvider {
  #apiKey;
  #voiceId;
  #model;
  #fetch;
  #timeoutMs;
  #maxAudioBytes;
  #maxTextCharacters;
  #enableLogging;
  #active = new Set();
  #disposed = false;

  constructor({
    apiKey,
    voiceId,
    model = VOICE_DEFAULTS.ttsModel,
    fetchImpl = globalThis.fetch,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxAudioBytes = DEFAULT_MAX_AUDIO_BYTES,
    maxTextCharacters = VOICE_DEFAULTS.maxTtsCharacters,
    enableLogging = false,
  } = {}) {
    if (typeof apiKey !== "string" || apiKey.trim().length === 0 || apiKey.length > 4096 || /[\0\r\n]/.test(apiKey)) {
      throw ttsError(ELEVENLABS_TTS_ERROR.AUTH, "An ElevenLabs speech credential is required.");
    }
    if (typeof fetchImpl !== "function") {
      throw ttsError(ELEVENLABS_TTS_ERROR.INVALID, "The ElevenLabs speech transport is unavailable.");
    }
    if (typeof enableLogging !== "boolean") {
      throw ttsError(ELEVENLABS_TTS_ERROR.INVALID, "The ElevenLabs logging setting is invalid.");
    }
    this.#apiKey = apiKey;
    this.#voiceId = validateIdentifier(voiceId, "voice ID");
    this.#model = validateIdentifier(model, "model");
    this.#fetch = fetchImpl;
    this.#timeoutMs = validateBound(timeoutMs, "timeout", 120_000);
    this.#maxAudioBytes = validateBound(maxAudioBytes, "audio byte", DEFAULT_MAX_AUDIO_BYTES);
    this.#maxTextCharacters = validateBound(maxTextCharacters, "text character", VOICE_LIMITS.maxTtsCharacters);
    this.#enableLogging = enableLogging;
  }

  async synthesize(text, { signal } = {}) {
    if (this.#disposed) throw ttsError(ELEVENLABS_TTS_ERROR.DISPOSED, "The ElevenLabs speech provider is disposed.");
    if (typeof text !== "string" || text.trim().length === 0 || text.length > this.#maxTextCharacters) {
      throw ttsError(ELEVENLABS_TTS_ERROR.INVALID, "The prepared speech text is empty or exceeds its bound.");
    }
    if (signal?.aborted) throw ttsError(ELEVENLABS_TTS_ERROR.CANCELLED, "Speech synthesis was cancelled.");

    const controller = new AbortController();
    this.#active.add(controller);
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.#timeoutMs);
    timeout.unref?.();
    const cancelled = () => controller.abort();
    signal?.addEventListener("abort", cancelled, { once: true });
    try {
      const endpoint = new URL(`${TTS_ENDPOINT}/${encodeURIComponent(this.#voiceId)}`);
      endpoint.searchParams.set("output_format", PCM_24000.encoding);
      endpoint.searchParams.set("enable_logging", String(this.#enableLogging));
      const response = await this.#fetch(endpoint.toString(), {
        method: "POST",
        headers: {
          Accept: "audio/pcm",
          "Content-Type": "application/json",
          "xi-api-key": this.#apiKey,
        },
        body: JSON.stringify({ text, model_id: this.#model }),
        signal: controller.signal,
      });
      if (!response?.ok) {
        try { await response?.body?.cancel?.(); } catch {}
        throw responseError(response?.status);
      }
      const audio = await readBoundedAudio(response, this.#maxAudioBytes);
      if (signal?.aborted || this.#disposed) {
        throw ttsError(ELEVENLABS_TTS_ERROR.CANCELLED, "Speech synthesis was cancelled.");
      }
      return Object.freeze({
        format: PCM_24000,
        audio,
        retention: this.#enableLogging
          ? ELEVENLABS_TTS_RETENTION.LOGGING_ENABLED
          : ELEVENLABS_TTS_RETENTION.ZERO_RETENTION_REQUESTED_UNCONFIRMED,
      });
    } catch (error) {
      if (error instanceof VoiceError) throw error;
      if (signal?.aborted || this.#disposed) {
        throw ttsError(ELEVENLABS_TTS_ERROR.CANCELLED, "Speech synthesis was cancelled.");
      }
      if (timedOut) throw ttsError(ELEVENLABS_TTS_ERROR.TIMEOUT, "ElevenLabs speech synthesis timed out.");
      throw ttsError(ELEVENLABS_TTS_ERROR.TRANSPORT, "The ElevenLabs speech request failed.");
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", cancelled);
      this.#active.delete(controller);
    }
  }

  async dispose() {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const controller of this.#active) controller.abort();
    this.#active.clear();
    this.#apiKey = null;
  }
}

export function createElevenLabsTtsProviderFromConfig(config, options = {}) {
  return new ElevenLabsTtsProvider({
    ...options,
    apiKey: voiceCredential(config, "elevenlabs"),
    voiceId: config?.tts?.voiceId,
    model: config?.tts?.model,
    maxTextCharacters: config?.limits?.maxTtsCharacters,
    enableLogging: config?.elevenLabs?.enableLogging,
  });
}
