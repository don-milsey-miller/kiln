import { assertAudioCapture } from "./audio/capture.mjs";
import { assertAudioPlayback } from "./audio/playback.mjs";
import { VoiceError, VOICE_ERROR_CODES, VoiceTransitionError, voiceOperationError } from "./errors.mjs";
import { assertSttProvider } from "./stt/provider.mjs";
import { assertTtsProvider } from "./tts/provider.mjs";

export const VOICE_STATES = Object.freeze({
  IDLE: "idle",
  LISTENING: "listening",
  FINALIZING: "finalizing",
  SPEAKING: "speaking",
  ERROR: "error",
  DISPOSED: "disposed",
});

const FACTORIES = Object.freeze({
  capture: ["createCapture", assertAudioCapture],
  stt: ["createSttProvider", assertSttProvider],
  tts: ["createTtsProvider", assertTtsProvider],
  playback: ["createPlayback", assertAudioPlayback],
});

const START_REQUIREMENTS = Object.freeze({
  listening: Object.freeze(["capture", "stt"]),
  speaking: Object.freeze(["tts", "playback"]),
});

function safeStateNotice(listener, snapshot) {
  try {
    listener?.(snapshot);
  } catch {
    // Operator UI callbacks are observers. A broken observer must not take down Pi or own lifecycle.
  }
}

async function terminateResource(resource) {
  const errors = [];
  for (const method of ["stop", "close", "dispose"]) {
    if (typeof resource?.[method] !== "function") continue;
    try {
      await resource[method]();
    } catch (error) {
      errors.push({ method, code: typeof error?.code === "string" ? error.code : null });
    }
  }
  return errors;
}

/**
 * Session-scoped owner for voice state, cancellation, and injected resources.
 *
 * Construction is pure. Factories are called only by `startListening` or `startSpeaking`, which are
 * operator-facing actions in the eventual Pi integration. Provider/device work therefore cannot
 * happen merely because Kiln imports or registers its extension.
 */
export class VoiceController {
  #deps;
  #state = VOICE_STATES.IDLE;
  #operation = null;
  #failure = null;

  constructor(deps = {}) {
    this.#deps = Object.freeze({ ...deps });
  }

  get state() {
    return this.#state;
  }

  snapshot() {
    return Object.freeze({
      state: this.#state,
      operation: this.#operation?.kind ?? null,
      failure: this.#failure,
      disposed: this.#state === VOICE_STATES.DISPOSED,
    });
  }

  #setState(state, failure = null) {
    this.#state = state;
    this.#failure = failure;
    const snapshot = this.snapshot();
    safeStateNotice(this.#deps.onStateChange, snapshot);
    return snapshot;
  }

  #require(action, allowed) {
    if (!allowed.includes(this.#state)) throw new VoiceTransitionError(this.#state, action, allowed);
  }

  async #start(kind, context) {
    this.#require(`start-${kind}`, [VOICE_STATES.IDLE]);
    const abort = new AbortController();
    const operation = { kind, abort, resources: [] };
    this.#operation = operation;
    this.#setState(kind === "listening" ? VOICE_STATES.LISTENING : VOICE_STATES.SPEAKING);

    try {
      const resources = {};
      for (const boundary of START_REQUIREMENTS[kind]) {
        const [factoryName, assertContract] = FACTORIES[boundary];
        const factory = this.#deps[factoryName];
        if (typeof factory !== "function") {
          throw new VoiceError(
            VOICE_ERROR_CODES.DEPENDENCY,
            `Voice ${kind} is unavailable because ${boundary} is not configured.`,
            { operation: kind, dependency: boundary }
          );
        }
        const resource = assertContract(await factory({ signal: abort.signal, context }));
        operation.resources.push(resource);
        resources[boundary] = resource;
      }
      return Object.freeze({ signal: abort.signal, ...resources });
    } catch (error) {
      const failure = voiceOperationError(kind, error);
      await this.#endOperation();
      this.#setState(VOICE_STATES.ERROR, failure);
      throw failure;
    }
  }

  startListening(context = {}) {
    return this.#start("listening", context);
  }

  startSpeaking(context = {}) {
    return this.#start("speaking", context);
  }

  beginFinalizing() {
    this.#require("begin-finalizing", [VOICE_STATES.LISTENING]);
    return this.#setState(VOICE_STATES.FINALIZING);
  }

  async complete() {
    this.#require("complete", [VOICE_STATES.FINALIZING, VOICE_STATES.SPEAKING]);
    const cleanup = await this.#endOperation();
    if (cleanup.errors.length > 0) {
      const failure = new VoiceError(VOICE_ERROR_CODES.OPERATION, "Voice resource cleanup failed.", {
        operation: cleanup.kind,
        cleanupErrors: cleanup.errors,
      });
      this.#setState(VOICE_STATES.ERROR, failure);
      return Object.freeze({ ok: false, error: failure });
    }
    this.#setState(VOICE_STATES.IDLE);
    return Object.freeze({ ok: true });
  }

  async fail(error) {
    this.#require("fail", [VOICE_STATES.LISTENING, VOICE_STATES.FINALIZING, VOICE_STATES.SPEAKING]);
    const kind = this.#operation?.kind ?? "operation";
    const failure = voiceOperationError(kind, error);
    const cleanup = await this.#endOperation();
    this.#setState(VOICE_STATES.ERROR, failure);
    return Object.freeze({ ok: false, error: failure, cleanupErrors: cleanup.errors });
  }

  reset() {
    this.#require("reset", [VOICE_STATES.ERROR]);
    return this.#setState(VOICE_STATES.IDLE);
  }

  async #endOperation() {
    const operation = this.#operation;
    this.#operation = null;
    if (!operation) return { kind: null, errors: [] };

    operation.abort.abort(new VoiceError(VOICE_ERROR_CODES.OPERATION, "The voice operation ended."));
    const errors = [];
    for (const resource of [...operation.resources].reverse()) errors.push(...(await terminateResource(resource)));
    operation.resources.length = 0;
    return { kind: operation.kind, errors };
  }

  async dispose() {
    if (this.#state === VOICE_STATES.DISPOSED) return Object.freeze({ ok: true, alreadyDisposed: true, cleanupErrors: [] });
    this.#setState(VOICE_STATES.DISPOSED);
    const cleanup = await this.#endOperation();
    return Object.freeze({ ok: cleanup.errors.length === 0, alreadyDisposed: false, cleanupErrors: cleanup.errors });
  }
}

export function createVoiceController(deps) {
  return new VoiceController(deps);
}
