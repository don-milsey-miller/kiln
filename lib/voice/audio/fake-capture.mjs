import { PassThrough } from "node:stream";

import { VoiceError } from "../errors.mjs";
import { AUDIO_CAPTURE_ERROR, PCM_16000 } from "./ffmpeg-capture.mjs";

/** Deterministic in-memory capture for controller and provider tests. */
export class FakeAudioCapture {
  #stream = null;
  #disposed = false;

  get format() {
    return PCM_16000;
  }

  async start({ signal } = {}) {
    if (this.#disposed) throw new VoiceError(AUDIO_CAPTURE_ERROR.DISPOSED, "Voice capture has been disposed.");
    if (this.#stream) throw new VoiceError(AUDIO_CAPTURE_ERROR.ACTIVE, "Voice capture is already active.");
    if (signal?.aborted) throw new VoiceError(AUDIO_CAPTURE_ERROR.CANCELLED, "Voice capture was cancelled before it started.");
    const stream = new PassThrough();
    const done = new Promise((resolve) => stream.once("end", () => resolve(Object.freeze({ ok: true, reason: "ended" }))));
    this.#stream = stream;
    stream.once("end", () => {
      if (this.#stream === stream) this.#stream = null;
    });
    signal?.addEventListener("abort", () => { void this.stop(); }, { once: true });
    return Object.freeze({ format: PCM_16000, stream, done });
  }

  push(chunk) {
    if (!this.#stream) throw new VoiceError(AUDIO_CAPTURE_ERROR.PROCESS, "Fake voice capture is not active.");
    this.#stream.write(Buffer.from(chunk));
  }

  async stop() {
    if (!this.#stream) return Object.freeze({ ok: true, inactive: true });
    const stream = this.#stream;
    this.#stream = null;
    stream.end();
    return Object.freeze({ ok: true, inactive: false });
  }

  async dispose() {
    if (this.#disposed) return Object.freeze({ ok: true, alreadyDisposed: true });
    this.#disposed = true;
    await this.stop();
    return Object.freeze({ ok: true, alreadyDisposed: false });
  }
}

