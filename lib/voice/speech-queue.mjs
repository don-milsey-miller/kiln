import { VOICE_LIMITS } from "./config.mjs";
import { VoiceError, voiceOperationError } from "./errors.mjs";
import { assertTtsProvider } from "./tts/provider.mjs";

const DEFAULT_MAX_ITEMS = 8;

function validateBound(value, name, maximum) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new RangeError(`${name} must be an integer from 1 to ${maximum}`);
  }
  return value;
}

function safeError(callback, error, item) {
  try {
    callback?.(error, Object.freeze({ id: item.id, characters: item.text.length }));
  } catch {
    // Observers never own queue progress.
  }
}

/**
 * Bounded, serial speech output. `enqueue` never returns a Promise and starts no work inline.
 */
export class SpeechQueue {
  #provider;
  #playback;
  #onError;
  #maxItems;
  #maxQueuedCharacters;
  #items = [];
  #characters = 0;
  #nextId = 1;
  #scheduled = false;
  #running = false;
  #active = null;
  #idleWaiters = new Set();
  #drainPromise = null;
  #disposed = false;

  constructor({
    provider,
    playback,
    onError = null,
    maxItems = DEFAULT_MAX_ITEMS,
    maxQueuedCharacters = VOICE_LIMITS.maxTtsCharacters,
  } = {}) {
    this.#provider = assertTtsProvider(provider);
    if (typeof playback?.play !== "function" || typeof playback?.stop !== "function" || typeof playback?.dispose !== "function") {
      throw new TypeError("The AudioPlayback implementation does not satisfy the voice contract.");
    }
    if (onError !== null && typeof onError !== "function") throw new TypeError("onError must be a function or null");
    this.#playback = playback;
    this.#onError = onError;
    this.#maxItems = validateBound(maxItems, "maxItems", 128);
    this.#maxQueuedCharacters = validateBound(
      maxQueuedCharacters,
      "maxQueuedCharacters",
      VOICE_LIMITS.maxTtsCharacters
    );
  }

  get status() {
    return Object.freeze({
      state: this.#disposed ? "disposed" : this.#active ? "speaking" : this.#items.length > 0 ? "queued" : "idle",
      items: this.#items.length + (this.#active ? 1 : 0),
      characters: this.#characters,
    });
  }

  enqueue(text) {
    if (this.#disposed) return Object.freeze({ accepted: false, reason: "disposed" });
    if (typeof text !== "string" || text.trim().length === 0) {
      return Object.freeze({ accepted: false, reason: "empty" });
    }
    const count = this.#items.length + (this.#active ? 1 : 0);
    if (count >= this.#maxItems || this.#characters + text.length > this.#maxQueuedCharacters) {
      return Object.freeze({ accepted: false, reason: "bounds" });
    }
    const item = Object.freeze({ id: this.#nextId, text });
    this.#nextId += 1;
    this.#items.push(item);
    this.#characters += text.length;
    this.#schedule();
    return Object.freeze({ accepted: true, id: item.id });
  }

  #schedule() {
    if (this.#scheduled || this.#running || this.#disposed) return;
    this.#scheduled = true;
    queueMicrotask(() => {
      this.#scheduled = false;
      if (this.#running || this.#disposed) return this.#resolveIdleIfReady();
      this.#drainPromise = this.#drain();
    });
  }

  async #drain() {
    this.#running = true;
    try {
      while (!this.#disposed && this.#items.length > 0) {
        const item = this.#items.shift();
        const controller = new AbortController();
        this.#active = { item, controller };
        try {
          const synthesis = await this.#provider.synthesize(item.text, { signal: controller.signal });
          if (!controller.signal.aborted && !this.#disposed) {
            await this.#playback.play(synthesis?.format, synthesis?.audio, { signal: controller.signal });
          }
        } catch (error) {
          if (!controller.signal.aborted && !this.#disposed) {
            safeError(this.#onError, error instanceof VoiceError ? error : voiceOperationError("speech-output", error), item);
          }
        } finally {
          this.#characters -= item.text.length;
          this.#active = null;
        }
      }
    } finally {
      this.#running = false;
      this.#drainPromise = null;
      if (!this.#disposed && this.#items.length > 0) this.#schedule();
      this.#resolveIdleIfReady();
    }
  }

  cancel({ clear = true } = {}) {
    const active = this.#active !== null;
    const cleared = clear ? this.#items.length : 0;
    if (clear) {
      for (const item of this.#items) this.#characters -= item.text.length;
      this.#items.length = 0;
    }
    this.#active?.controller.abort();
    void Promise.resolve(this.#playback.stop()).catch(() => {});
    this.#resolveIdleIfReady();
    return Object.freeze({ active, cleared });
  }

  idle() {
    if (!this.#scheduled && !this.#running && !this.#active && this.#items.length === 0) return Promise.resolve();
    return new Promise((resolve) => this.#idleWaiters.add(resolve));
  }

  #resolveIdleIfReady() {
    if (this.#scheduled || this.#running || this.#active || this.#items.length > 0) return;
    for (const resolve of this.#idleWaiters) resolve();
    this.#idleWaiters.clear();
  }

  async dispose() {
    if (this.#disposed) return Object.freeze({ ok: true, alreadyDisposed: true });
    this.cancel({ clear: true });
    this.#disposed = true;
    if (this.#drainPromise) await this.#drainPromise;
    await Promise.allSettled([this.#playback.dispose(), this.#provider.dispose()]);
    this.#resolveIdleIfReady();
    return Object.freeze({ ok: true, alreadyDisposed: false });
  }
}
