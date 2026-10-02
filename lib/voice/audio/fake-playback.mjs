import { VoiceError } from "../errors.mjs";
import { AUDIO_PLAYBACK_ERROR, validatePcmPlaybackFormat } from "./ffplay-playback.mjs";

async function collect(source, maximumBytes) {
  const chunks = [];
  let bytes = 0;
  const values = source instanceof Uint8Array
    ? [source]
    : typeof source?.[Symbol.asyncIterator] === "function" ? source : null;
  if (!values) throw new VoiceError(AUDIO_PLAYBACK_ERROR.SOURCE, "The synthesized voice audio source is invalid.");
  for await (const value of values) {
    if (!(value instanceof Uint8Array)) {
      throw new VoiceError(AUDIO_PLAYBACK_ERROR.SOURCE, "The synthesized voice audio source is invalid.");
    }
    bytes += value.byteLength;
    if (bytes > maximumBytes) {
      throw new VoiceError(AUDIO_PLAYBACK_ERROR.BOUNDS, "Synthesized voice audio exceeded the playback bound.");
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

/** Deterministic output sink used by TTS and voice-integration tests. */
export class FakeAudioPlayback {
  #active = null;
  #disposed = false;
  #failure;
  #autoComplete;
  #maximumBytes;

  constructor({ failure = null, autoComplete = true, maximumBytes = 64 * 1024 * 1024 } = {}) {
    this.#failure = failure;
    this.#autoComplete = autoComplete;
    this.#maximumBytes = maximumBytes;
    this.plays = [];
    this.stops = 0;
  }

  get active() {
    return this.#active !== null;
  }

  async play(format, source, { signal } = {}) {
    if (this.#disposed) throw new VoiceError(AUDIO_PLAYBACK_ERROR.DISPOSED, "Voice playback has been disposed.");
    if (this.#active) throw new VoiceError(AUDIO_PLAYBACK_ERROR.ACTIVE, "Voice playback is already active.");
    if (signal?.aborted) throw new VoiceError(AUDIO_PLAYBACK_ERROR.CANCELLED, "Voice playback was cancelled before it started.");
    const pcm = validatePcmPlaybackFormat(format);
    const audio = await collect(source, this.#maximumBytes);
    if (this.#failure) throw this.#failure;
    let resolve;
    const completion = new Promise((done) => { resolve = done; });
    const record = { format: pcm, audio, completion, resolve, signal, abort: null };
    this.plays.push(record);
    this.#active = record;
    if (signal) {
      record.abort = () => this.#finish(record, "aborted");
      signal.addEventListener("abort", record.abort, { once: true });
    }
    if (this.#autoComplete) queueMicrotask(() => this.#finish(record, "played"));
    return completion;
  }

  #finish(record, reason) {
    if (this.#active !== record) return;
    if (record.signal && record.abort) record.signal.removeEventListener("abort", record.abort);
    this.#active = null;
    record.resolve(Object.freeze({ ok: true, reason, bytes: record.audio.byteLength }));
  }

  release() {
    if (this.#active) this.#finish(this.#active, "played");
  }

  async stop() {
    this.stops += 1;
    if (!this.#active) return Object.freeze({ ok: true, inactive: true });
    this.#finish(this.#active, "stopped");
    return Object.freeze({ ok: true, inactive: false });
  }

  async dispose() {
    if (this.#disposed) return Object.freeze({ ok: true, alreadyDisposed: true });
    this.#disposed = true;
    await this.stop();
    return Object.freeze({ ok: true, alreadyDisposed: false });
  }
}
