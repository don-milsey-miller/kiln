import { Buffer } from "node:buffer";

import { voiceCredential } from "../config.mjs";
import { VoiceError } from "../errors.mjs";

const TOKEN_ENDPOINT = "https://api.elevenlabs.io/v1/single-use-token/realtime_scribe";
const REALTIME_ENDPOINT = "wss://api.elevenlabs.io/v1/speech-to-text/realtime";
const SOCKET_CONNECTING = 0;
const SOCKET_OPEN = 1;
const DEFAULT_TOKEN_TIMEOUT_MS = 10_000;
const DEFAULT_SESSION_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_CHUNK_BYTES = 32_000;
const DEFAULT_MAX_MESSAGE_BYTES = 64 * 1024;
const MAX_TOKEN_RESPONSE_BYTES = 8 * 1024;
const PROVIDER_ERROR_TYPES = new Set([
  "auth_error",
  "chunk_size_exceeded",
  "commit_throttled",
  "error",
  "input_error",
  "insufficient_audio_activity",
  "invalid_request",
  "queue_overflow",
  "quota_exceeded",
  "rate_limited",
  "resource_exhausted",
  "session_time_limit_exceeded",
  "transcriber_error",
  "unaccepted_terms",
]);

export const ELEVENLABS_STT_ERROR = Object.freeze({
  AUTH: "stt-authentication-failed",
  CANCELLED: "stt-cancelled",
  CHUNK: "stt-audio-chunk-invalid",
  CONNECTION: "stt-connection-failed",
  DISPOSED: "stt-provider-disposed",
  FORMAT: "stt-audio-format-invalid",
  PROTOCOL: "stt-protocol-invalid",
  QUOTA: "stt-quota-exceeded",
  RATE_LIMITED: "stt-rate-limited",
  TERMS: "stt-terms-unaccepted",
  TOKEN: "stt-token-failed",
});

export const ELEVENLABS_RETENTION = Object.freeze({
  LOGGING_ACTIVE: "logging-active",
  LOGGING_ENABLED: "logging-enabled",
  ZERO_RETENTION_REQUESTED_UNCONFIRMED: "zero-retention-requested-unconfirmed",
});

function sttError(code, message, details = {}) {
  return new VoiceError(code, message, details);
}

function cancellationError() {
  return sttError(ELEVENLABS_STT_ERROR.CANCELLED, "The transcription session was cancelled.");
}

function validateFormat(format) {
  if (
    format?.encoding !== "pcm_16000" ||
    format?.sampleRate !== 16_000 ||
    format?.channels !== 1 ||
    format?.sampleFormat !== "s16le" ||
    format?.bytesPerSample !== 2
  ) {
    throw sttError(
      ELEVENLABS_STT_ERROR.FORMAT,
      "ElevenLabs realtime transcription requires mono 16 kHz signed 16-bit little-endian PCM."
    );
  }
}

function validateSetting(value, name, { nullable = false } = {}) {
  if (nullable && (value === null || value === undefined || value === "")) return null;
  if (typeof value !== "string" || value.trim().length === 0 || value.length > 256 || /[\0\r\n]/.test(value)) {
    throw sttError(ELEVENLABS_STT_ERROR.PROTOCOL, `The ElevenLabs ${name} setting is invalid.`);
  }
  return value.trim();
}

function mappedProviderError(type) {
  if (type === "auth_error") {
    return sttError(ELEVENLABS_STT_ERROR.AUTH, "ElevenLabs rejected the transcription credential.");
  }
  if (type === "quota_exceeded") {
    return sttError(ELEVENLABS_STT_ERROR.QUOTA, "The ElevenLabs transcription quota is exhausted.");
  }
  if (type === "rate_limited" || type === "resource_exhausted") {
    return sttError(ELEVENLABS_STT_ERROR.RATE_LIMITED, "ElevenLabs temporarily rate limited transcription.");
  }
  if (type === "unaccepted_terms") {
    return sttError(ELEVENLABS_STT_ERROR.TERMS, "ElevenLabs requires account terms to be accepted.");
  }
  return sttError(ELEVENLABS_STT_ERROR.PROTOCOL, "ElevenLabs rejected the transcription session.", {
    providerEvent: type,
  });
}

function safeCall(callback, value) {
  try {
    callback?.(value);
  } catch {
    // UI observers cannot own or interrupt provider lifecycle.
  }
}

function delay(ms, signal) {
  if (signal?.aborted) return Promise.reject(cancellationError());
  return new Promise((resolve, reject) => {
    const finish = (callback, value) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", aborted);
      callback(value);
    };
    const aborted = () => {
      finish(reject, cancellationError());
    };
    const timer = setTimeout(() => finish(resolve), ms);
    signal?.addEventListener("abort", aborted, { once: true });
  });
}

async function issueSingleUseToken({ apiKey, fetchImpl, signal, retries, retryDelayMs, timeoutMs }) {
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    if (signal?.aborted) throw cancellationError();
    const abort = new AbortController();
    const timeout = setTimeout(() => abort.abort(), timeoutMs);
    timeout.unref?.();
    const cancelled = () => abort.abort();
    signal?.addEventListener("abort", cancelled, { once: true });
    try {
      const response = await fetchImpl(TOKEN_ENDPOINT, {
        method: "POST",
        headers: { "xi-api-key": apiKey },
        signal: abort.signal,
      });
      if (response.ok) {
        const bodyText = await response.text().catch(() => null);
        const body = typeof bodyText === "string" && Buffer.byteLength(bodyText, "utf8") <= MAX_TOKEN_RESPONSE_BYTES
          ? JSON.parse(bodyText)
          : null;
        if (typeof body?.token !== "string" || body.token.length === 0 || body.token.length > 4096) {
          throw sttError(ELEVENLABS_STT_ERROR.TOKEN, "ElevenLabs returned an invalid transcription token.");
        }
        return body.token;
      }
      if (response.status === 401 || response.status === 403) {
        throw sttError(ELEVENLABS_STT_ERROR.AUTH, "ElevenLabs rejected the transcription credential.");
      }
      const retryable = response.status === 429 || response.status >= 500;
      if (retryable && attempt < retries) {
        await delay(retryDelayMs, signal);
        continue;
      }
      if (response.status === 429) {
        throw sttError(ELEVENLABS_STT_ERROR.RATE_LIMITED, "ElevenLabs temporarily rate limited transcription.");
      }
      throw sttError(ELEVENLABS_STT_ERROR.TOKEN, "ElevenLabs could not issue a transcription token.");
    } catch (error) {
      if (error instanceof VoiceError) throw error;
      if (signal?.aborted) throw cancellationError();
      if (attempt < retries) {
        await delay(retryDelayMs, signal);
        continue;
      }
      throw sttError(ELEVENLABS_STT_ERROR.TOKEN, "The ElevenLabs token request failed.");
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", cancelled);
    }
  }
  throw sttError(ELEVENLABS_STT_ERROR.TOKEN, "The ElevenLabs token request failed.");
}

async function messageText(data, maximumBytes) {
  if (typeof data === "string") {
    if (Buffer.byteLength(data, "utf8") > maximumBytes) return null;
    return data;
  }
  if (data instanceof ArrayBuffer) {
    if (data.byteLength > maximumBytes) return null;
    return Buffer.from(data).toString("utf8");
  }
  if (ArrayBuffer.isView(data)) {
    if (data.byteLength > maximumBytes) return null;
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8");
  }
  if (typeof data?.text === "function" && typeof data?.size === "number" && data.size <= maximumBytes) {
    return data.text();
  }
  return null;
}

class ElevenLabsSttSession {
  #socket;
  #signal;
  #onPartial;
  #onFinal;
  #onError;
  #onWarning;
  #onClosed;
  #maxChunkBytes;
  #maxMessageBytes;
  #sessionTimeoutMs;
  #started = false;
  #finished = false;
  #closed = false;
  #failureSent = false;
  #retention;
  #openPromise;
  #resolveOpen;
  #rejectOpen;
  #startTimer;

  constructor({
    socket,
    signal,
    onPartial,
    onFinal,
    onError,
    onWarning,
    onClosed,
    maxChunkBytes,
    maxMessageBytes,
    sessionTimeoutMs,
    retention,
  }) {
    this.#socket = socket;
    this.#signal = signal;
    this.#onPartial = onPartial;
    this.#onFinal = onFinal;
    this.#onError = onError;
    this.#onWarning = onWarning;
    this.#onClosed = onClosed;
    this.#maxChunkBytes = maxChunkBytes;
    this.#maxMessageBytes = maxMessageBytes;
    this.#sessionTimeoutMs = sessionTimeoutMs;
    this.#retention = retention;
    this.#openPromise = new Promise((resolve, reject) => {
      this.#resolveOpen = resolve;
      this.#rejectOpen = reject;
    });
  }

  get retention() {
    return this.#retention;
  }

  async open() {
    if (this.#signal?.aborted) {
      this.#fail(cancellationError(), false);
      throw cancellationError();
    }
    try {
      this.#socket.addEventListener("message", this.#handleMessage);
      this.#socket.addEventListener("error", this.#handleSocketError);
      this.#socket.addEventListener("close", this.#handleSocketClose);
    } catch {
      const error = sttError(ELEVENLABS_STT_ERROR.CONNECTION, "The ElevenLabs transcription connection failed.");
      this.#fail(error, false);
      throw error;
    }
    this.#signal?.addEventListener("abort", this.#handleAbort, { once: true });
    this.#startTimer = setTimeout(() => {
      this.#fail(sttError(ELEVENLABS_STT_ERROR.CONNECTION, "The ElevenLabs transcription session timed out."));
    }, this.#sessionTimeoutMs);
    this.#startTimer.unref?.();
    if (this.#socket.readyState !== SOCKET_CONNECTING && this.#socket.readyState !== SOCKET_OPEN) {
      this.#fail(sttError(ELEVENLABS_STT_ERROR.CONNECTION, "The ElevenLabs transcription connection failed."));
    }
    return this.#openPromise;
  }

  #handleMessage = async (event) => {
    if (this.#closed) return;
    const text = await messageText(event?.data, this.#maxMessageBytes).catch(() => null);
    if (text === null) {
      this.#fail(sttError(ELEVENLABS_STT_ERROR.PROTOCOL, "ElevenLabs sent an invalid transcription message."));
      return;
    }
    let message;
    try {
      message = JSON.parse(text);
    } catch {
      this.#fail(sttError(ELEVENLABS_STT_ERROR.PROTOCOL, "ElevenLabs sent an invalid transcription message."));
      return;
    }
    const type = message?.message_type;
    if (type === "session_started") {
      if (!this.#started) {
        this.#started = true;
        clearTimeout(this.#startTimer);
        this.#resolveOpen(this);
      }
      return;
    }
    if (!this.#started) {
      this.#fail(sttError(ELEVENLABS_STT_ERROR.PROTOCOL, "ElevenLabs sent data before starting the session."));
      return;
    }
    if (type === "partial_transcript" || type === "committed_transcript") {
      if (typeof message.text !== "string") {
        this.#fail(sttError(ELEVENLABS_STT_ERROR.PROTOCOL, "ElevenLabs sent an invalid transcript event."));
        return;
      }
      const eventValue = Object.freeze({ text: message.text });
      safeCall(type === "partial_transcript" ? this.#onPartial : this.#onFinal, eventValue);
      return;
    }
    if (type === "warning") {
      const providerText = typeof message.warning === "string" ? message.warning : typeof message.message === "string" ? message.message : "";
      const retentionWarning = /zero[ -]?retention|still (?:be|being) logged|logging (?:is )?(?:enabled|active)/i.test(providerText);
      if (retentionWarning) {
        this.#retention = ELEVENLABS_RETENTION.LOGGING_ACTIVE;
        safeCall(this.#onWarning, Object.freeze({
          code: "retention-logging-active",
          message: "ElevenLabs reported that zero retention was not applied; this session is being logged.",
        }));
      } else {
        safeCall(this.#onWarning, Object.freeze({
          code: "provider-warning",
          message: "ElevenLabs reported a transcription warning.",
        }));
      }
      return;
    }
    if (PROVIDER_ERROR_TYPES.has(type)) this.#fail(mappedProviderError(type));
  };

  #handleSocketError = () => {
    this.#fail(sttError(ELEVENLABS_STT_ERROR.CONNECTION, "The ElevenLabs transcription connection failed."));
  };

  #handleSocketClose = () => {
    if (!this.#closed) {
      this.#fail(sttError(ELEVENLABS_STT_ERROR.CONNECTION, "The ElevenLabs transcription connection closed unexpectedly."), this.#started);
    }
  };

  #handleAbort = () => {
    this.#fail(cancellationError(), this.#started);
  };

  #send(message) {
    if (this.#closed || this.#socket.readyState !== SOCKET_OPEN) {
      throw sttError(ELEVENLABS_STT_ERROR.CONNECTION, "The ElevenLabs transcription connection is not open.");
    }
    try {
      this.#socket.send(JSON.stringify(message));
    } catch {
      const error = sttError(ELEVENLABS_STT_ERROR.CONNECTION, "The ElevenLabs transcription connection failed.");
      this.#fail(error);
      throw error;
    }
  }

  write(audio) {
    if (this.#finished || this.#closed) {
      throw sttError(ELEVENLABS_STT_ERROR.CHUNK, "The transcription session no longer accepts audio.");
    }
    if (!(audio instanceof Uint8Array) || audio.byteLength % 2 !== 0) {
      throw sttError(ELEVENLABS_STT_ERROR.CHUNK, "Transcription audio must contain complete 16-bit PCM samples.");
    }
    for (let offset = 0; offset < audio.byteLength; offset += this.#maxChunkBytes) {
      const chunk = audio.subarray(offset, Math.min(offset + this.#maxChunkBytes, audio.byteLength));
      if (chunk.byteLength === 0) continue;
      this.#send({
        message_type: "input_audio_chunk",
        audio_base_64: Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength).toString("base64"),
      });
    }
  }

  finish() {
    if (this.#closed) {
      throw sttError(ELEVENLABS_STT_ERROR.CONNECTION, "The transcription session is closed.");
    }
    if (this.#finished) return;
    this.#finished = true;
    this.#send({ message_type: "input_audio_chunk", audio_base_64: "", commit: true });
  }

  #fail(error, notify = true) {
    if (this.#closed) return;
    if (!this.#started) this.#rejectOpen(error);
    if (notify && !this.#failureSent) {
      this.#failureSent = true;
      safeCall(this.#onError, error);
    }
    this.close();
  }

  close() {
    if (this.#closed) return;
    this.#closed = true;
    clearTimeout(this.#startTimer);
    this.#signal?.removeEventListener("abort", this.#handleAbort);
    this.#socket.removeEventListener?.("message", this.#handleMessage);
    this.#socket.removeEventListener?.("error", this.#handleSocketError);
    this.#socket.removeEventListener?.("close", this.#handleSocketClose);
    if (this.#socket.readyState === SOCKET_CONNECTING || this.#socket.readyState === SOCKET_OPEN) {
      try {
        this.#socket.close(1000, "client close");
      } catch {
        // Cleanup is best effort and never includes provider details.
      }
    }
    if (!this.#started) {
      this.#rejectOpen(sttError(ELEVENLABS_STT_ERROR.CONNECTION, "The ElevenLabs transcription session closed before starting."));
    }
    this.#onClosed?.(this);
  }
}

export class ElevenLabsSttProvider {
  #apiKey;
  #model;
  #language;
  #enableLogging;
  #fetchImpl;
  #webSocketFactory;
  #tokenRetries;
  #retryDelayMs;
  #tokenTimeoutMs;
  #sessionTimeoutMs;
  #maxChunkBytes;
  #maxMessageBytes;
  #sessions = new Set();
  #disposed = false;

  constructor({
    apiKey,
    model = "scribe_v2_realtime",
    language = null,
    enableLogging = false,
    fetchImpl = globalThis.fetch,
    webSocketFactory = (url) => new globalThis.WebSocket(url),
    tokenRetries = 1,
    retryDelayMs = 100,
    tokenTimeoutMs = DEFAULT_TOKEN_TIMEOUT_MS,
    sessionTimeoutMs = DEFAULT_SESSION_TIMEOUT_MS,
    maxChunkBytes = DEFAULT_MAX_CHUNK_BYTES,
    maxMessageBytes = DEFAULT_MAX_MESSAGE_BYTES,
  } = {}) {
    if (typeof apiKey !== "string" || apiKey.trim().length === 0) {
      throw sttError(ELEVENLABS_STT_ERROR.AUTH, "An ElevenLabs transcription credential is required.");
    }
    this.#apiKey = validateSetting(apiKey, "API credential");
    this.#model = validateSetting(model, "model");
    this.#language = validateSetting(language, "language", { nullable: true });
    if (typeof enableLogging !== "boolean") {
      throw sttError(ELEVENLABS_STT_ERROR.PROTOCOL, "The ElevenLabs logging setting is invalid.");
    }
    if (typeof fetchImpl !== "function" || typeof webSocketFactory !== "function") {
      throw sttError(ELEVENLABS_STT_ERROR.PROTOCOL, "The ElevenLabs transport is unavailable.");
    }
    if (!Number.isSafeInteger(tokenRetries) || tokenRetries < 0 || tokenRetries > 3) {
      throw sttError(ELEVENLABS_STT_ERROR.PROTOCOL, "The ElevenLabs retry setting is invalid.");
    }
    for (const [name, value] of Object.entries({ retryDelayMs, tokenTimeoutMs, sessionTimeoutMs, maxChunkBytes, maxMessageBytes })) {
      if (!Number.isSafeInteger(value) || value < 1) {
        throw sttError(ELEVENLABS_STT_ERROR.PROTOCOL, `The ElevenLabs ${name} bound is invalid.`);
      }
    }
    if (maxChunkBytes % 2 !== 0 || maxChunkBytes > DEFAULT_MAX_CHUNK_BYTES) {
      throw sttError(ELEVENLABS_STT_ERROR.PROTOCOL, "The ElevenLabs audio chunk bound is invalid.");
    }
    this.#enableLogging = enableLogging;
    this.#fetchImpl = fetchImpl;
    this.#webSocketFactory = webSocketFactory;
    this.#tokenRetries = tokenRetries;
    this.#retryDelayMs = retryDelayMs;
    this.#tokenTimeoutMs = tokenTimeoutMs;
    this.#sessionTimeoutMs = sessionTimeoutMs;
    this.#maxChunkBytes = maxChunkBytes;
    this.#maxMessageBytes = maxMessageBytes;
  }

  async start({ format, signal, onPartial, onFinal, onError, onWarning } = {}) {
    if (this.#disposed) {
      throw sttError(ELEVENLABS_STT_ERROR.DISPOSED, "The ElevenLabs transcription provider is disposed.");
    }
    validateFormat(format);
    if (signal?.aborted) throw cancellationError();
    const token = await issueSingleUseToken({
      apiKey: this.#apiKey,
      fetchImpl: this.#fetchImpl,
      signal,
      retries: this.#tokenRetries,
      retryDelayMs: this.#retryDelayMs,
      timeoutMs: this.#tokenTimeoutMs,
    });
    if (this.#disposed) throw sttError(ELEVENLABS_STT_ERROR.DISPOSED, "The ElevenLabs transcription provider is disposed.");
    if (signal?.aborted) throw cancellationError();

    const url = new URL(REALTIME_ENDPOINT);
    url.searchParams.set("token", token);
    url.searchParams.set("model_id", this.#model);
    url.searchParams.set("audio_format", "pcm_16000");
    url.searchParams.set("commit_strategy", "manual");
    url.searchParams.set("enable_logging", String(this.#enableLogging));
    if (this.#language) url.searchParams.set("language_code", this.#language);

    let socket;
    try {
      socket = this.#webSocketFactory(url.toString());
    } catch {
      throw sttError(ELEVENLABS_STT_ERROR.CONNECTION, "The ElevenLabs transcription connection failed.");
    }
    if (
      typeof socket?.addEventListener !== "function" ||
      typeof socket?.send !== "function" ||
      typeof socket?.close !== "function" ||
      !Number.isInteger(socket?.readyState)
    ) {
      try {
        socket?.close?.(1000, "invalid transport");
      } catch {
        // The invalid transport cannot be trusted to clean itself up.
      }
      throw sttError(ELEVENLABS_STT_ERROR.CONNECTION, "The ElevenLabs transcription transport is invalid.");
    }
    const session = new ElevenLabsSttSession({
      socket,
      signal,
      onPartial,
      onFinal,
      onError,
      onWarning,
      onClosed: (closed) => this.#sessions.delete(closed),
      maxChunkBytes: this.#maxChunkBytes,
      maxMessageBytes: this.#maxMessageBytes,
      sessionTimeoutMs: this.#sessionTimeoutMs,
      retention: this.#enableLogging
        ? ELEVENLABS_RETENTION.LOGGING_ENABLED
        : ELEVENLABS_RETENTION.ZERO_RETENTION_REQUESTED_UNCONFIRMED,
    });
    this.#sessions.add(session);
    try {
      return await session.open();
    } catch (error) {
      session.close();
      throw error;
    }
  }

  async dispose() {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const session of [...this.#sessions]) session.close();
    this.#sessions.clear();
    this.#apiKey = null;
  }
}

export function createElevenLabsSttProviderFromConfig(config, options = {}) {
  return new ElevenLabsSttProvider({
    ...options,
    apiKey: voiceCredential(config, "elevenlabs"),
    model: config?.stt?.model,
    language: config?.stt?.language,
  });
}
