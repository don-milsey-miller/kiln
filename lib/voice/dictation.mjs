import { inspectVoiceCapability } from "./capability.mjs";
import { resolveVoiceConfig } from "./config.mjs";
import { createVoiceController, VOICE_STATES } from "./controller.mjs";
import { VoiceError, VOICE_ERROR_CODES } from "./errors.mjs";
import {
  FfmpegAudioCapture,
  listFfmpegInputDevices,
  probeFfmpegAudioCapture,
} from "./audio/ffmpeg-capture.mjs";
import { createElevenLabsSttProviderFromConfig } from "./stt/elevenlabs.mjs";

const STATUS_KEY = "kiln-voice";
const PARTIAL_KEY = "kiln-voice-partial";
const MAX_PARTIAL_CHARACTERS = 240;
const MAX_DEVICE_COUNT = 32;
const MAX_DEVICE_CHARACTERS = 160;
const DEFAULT_FINAL_TIMEOUT_MS = 20_000;

export const DICTATION_ERROR = Object.freeze({
  DISABLED: "voice-dictation-disabled",
  FINAL_TIMEOUT: "voice-dictation-final-timeout",
  MODE: "voice-dictation-tui-required",
  NOT_LISTENING: "voice-dictation-not-listening",
});

function dictationError(code, message, details = {}) {
  return new VoiceError(code, message, details);
}

function safeUi(callback) {
  try {
    callback?.();
  } catch {
    // Pi UI feedback is observational and cannot own audio/provider lifecycle.
  }
}

function boundedPartial(text) {
  if (typeof text !== "string") return "";
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= MAX_PARTIAL_CHARACTERS) return normalized;
  return `${normalized.slice(0, MAX_PARTIAL_CHARACTERS - 1)}…`;
}

function boundedDeviceValue(value) {
  if (typeof value !== "string") return "";
  const normalized = value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  return normalized.slice(0, MAX_DEVICE_CHARACTERS);
}

export function appendDictation(current, transcript) {
  const existing = typeof current === "string" ? current : "";
  const addition = typeof transcript === "string" ? transcript.trim() : "";
  if (!addition) return existing;
  if (!existing) return addition;
  return /\s$/.test(existing) ? `${existing}${addition}` : `${existing} ${addition}`;
}

function safeFailure(error) {
  return Object.freeze({
    code: typeof error?.code === "string" ? error.code : VOICE_ERROR_CODES.OPERATION,
    message: error instanceof VoiceError ? error.message : "Voice dictation failed.",
  });
}

async function withTimeout(promise, timeoutMs) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => reject(dictationError(
      DICTATION_ERROR.FINAL_TIMEOUT,
      "Voice transcription did not finalize before the deadline."
    )), timeoutMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([promise, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Operator-facing bridge between provider-neutral voice resources and Pi's draft editor.
 *
 * Construction reads no environment and acquires no resources. The default factory below resolves
 * configuration only after a TUI command or shortcut asks for this object.
 */
export class VoiceDictation {
  #ui;
  #config;
  #controller;
  #inputProbe;
  #listDevices;
  #finalTimeoutMs;
  #active = null;
  #sequence = 0;
  #disposed = false;

  constructor({
    ui,
    config,
    createCapture,
    createSttProvider,
    inputProbe,
    listDevices,
    finalTimeoutMs = DEFAULT_FINAL_TIMEOUT_MS,
    controllerFactory = createVoiceController,
  }) {
    if (!ui || typeof ui.getEditorText !== "function" || typeof ui.setEditorText !== "function") {
      throw dictationError(DICTATION_ERROR.MODE, "Voice dictation requires Pi's TUI editor.");
    }
    if (!Number.isSafeInteger(finalTimeoutMs) || finalTimeoutMs < 1 || finalTimeoutMs > 60_000) {
      throw dictationError(VOICE_ERROR_CODES.CONTRACT, "The voice finalization bound is invalid.");
    }
    this.#ui = ui;
    this.#config = config;
    this.#inputProbe = inputProbe;
    this.#listDevices = listDevices;
    this.#finalTimeoutMs = finalTimeoutMs;
    this.#controller = controllerFactory({
      createCapture,
      createSttProvider,
      onStateChange: (snapshot) => this.#showState(snapshot.state),
    });
  }

  get state() {
    return this.#controller.state;
  }

  #showState(state) {
    const labels = {
      [VOICE_STATES.IDLE]: "Voice: ready",
      [VOICE_STATES.LISTENING]: "Voice: listening",
      [VOICE_STATES.FINALIZING]: "Voice: transcribing",
      [VOICE_STATES.ERROR]: "Voice: error",
      [VOICE_STATES.DISPOSED]: undefined,
    };
    safeUi(() => this.#ui.setStatus?.(STATUS_KEY, labels[state]));
    if (state !== VOICE_STATES.LISTENING) safeUi(() => this.#ui.setWidget?.(PARTIAL_KEY, undefined));
  }

  #showPartial(text) {
    const partial = boundedPartial(text);
    safeUi(() => this.#ui.setWidget?.(PARTIAL_KEY, partial ? [`Voice draft: ${partial}`] : undefined));
  }

  #appendFinal(text) {
    if (typeof text !== "string" || text.trim().length === 0) return false;
    const current = this.#ui.getEditorText();
    this.#ui.setEditorText(appendDictation(current, text));
    return true;
  }

  #ensureEnabled() {
    if (!this.#config?.enabled || this.#config?.features?.stt === false) {
      throw dictationError(DICTATION_ERROR.DISABLED, "Voice dictation is disabled. Set KILN_VOICE_ENABLED=true to enable it.");
    }
    const sttProblem = this.#config.problems?.find(({ name }) => [
      "KILN_VOICE_ENABLED",
      "KILN_STT_PROVIDER",
      "KILN_STT_MODEL",
      "KILN_STT_LANGUAGE",
      "KILN_VOICE_INPUT_DEVICE",
      "KILN_VOICE_MAX_RECORDING_MS",
    ].includes(name));
    if (sttProblem) {
      throw dictationError(VOICE_ERROR_CODES.CONTRACT, "Voice dictation configuration is invalid.", {
        setting: sttProblem.name,
        reason: sttProblem.reason,
      });
    }
    if (!this.#config.credentialPresent) {
      throw dictationError("stt-authentication-failed", "An ElevenLabs transcription credential is required.");
    }
  }

  async start() {
    if (this.#disposed) throw dictationError(VOICE_ERROR_CODES.DISPOSED, "Voice dictation is disposed.");
    this.#ensureEnabled();
    if (this.#controller.state === VOICE_STATES.ERROR) this.#controller.reset();
    if (this.#controller.state !== VOICE_STATES.IDLE) {
      throw dictationError(VOICE_ERROR_CODES.TRANSITION, "Voice dictation is already active.", {
        state: this.#controller.state,
      });
    }

    const operationId = ++this.#sequence;
    let operation;
    let sttSession;
    try {
      operation = await this.#controller.startListening({ source: "operator" });
      let resolveFinal;
      let rejectFinal;
      const final = new Promise((resolve, reject) => {
        resolveFinal = resolve;
        rejectFinal = reject;
      });
      // A provider can fail before `/voice stop` begins awaiting this promise. Mark the rejection as
      // observed immediately; `stop()` still receives it through the original promise.
      void final.catch(() => {});
      const active = {
        id: operationId,
        capture: operation.capture,
        captureRun: null,
        sttSession: null,
        pump: null,
        final,
        resolveFinal,
        rejectFinal,
        finalSeen: false,
        stopping: false,
      };
      this.#active = active;
      sttSession = await operation.stt.start({
        format: operation.capture.format,
        signal: operation.signal,
        onPartial: ({ text }) => {
          if (this.#active?.id === operationId && !active.stopping) this.#showPartial(text);
        },
        onFinal: ({ text }) => {
          if (this.#active?.id !== operationId || active.finalSeen) return;
          active.finalSeen = true;
          try {
            this.#appendFinal(text);
            resolveFinal(Object.freeze({ text }));
          } catch {
            rejectFinal(dictationError(VOICE_ERROR_CODES.OPERATION, "The transcript could not be added to Pi's editor."));
          }
        },
        onError: (error) => {
          if (this.#active?.id !== operationId) return;
          rejectFinal(error);
          void this.#fail(operationId, error);
        },
        onWarning: ({ message }) => safeUi(() => this.#ui.notify?.(message, "warning")),
      });
      active.sttSession = sttSession;
      active.captureRun = await operation.capture.start({ signal: operation.signal });
      active.pump = this.#pump(operationId, active.captureRun.stream, sttSession);
      void active.captureRun.done.then(() => {
        if (this.#active?.id === operationId && !active.stopping && this.#controller.state === VOICE_STATES.LISTENING) {
          void this.stop().catch(() => {});
        }
      }).catch((error) => this.#fail(operationId, error));
      return this.snapshot();
    } catch (error) {
      try {
        sttSession?.close();
      } catch {
        // Controller cleanup remains authoritative.
      }
      if (this.#controller.state === VOICE_STATES.LISTENING) await this.#controller.fail(error);
      if (this.#active?.id === operationId) this.#active = null;
      this.#showFailure(error);
      throw error;
    }
  }

  async #pump(operationId, stream, sttSession) {
    try {
      for await (const chunk of stream) {
        if (this.#active?.id !== operationId) break;
        sttSession.write(chunk);
      }
    } catch (error) {
      if (this.#active?.id === operationId) {
        this.#active.rejectFinal(error);
        await this.#fail(operationId, error);
      }
    }
  }

  async stop() {
    const active = this.#active;
    if (!active || this.#controller.state !== VOICE_STATES.LISTENING) {
      throw dictationError(DICTATION_ERROR.NOT_LISTENING, "Voice dictation is not currently listening.");
    }
    active.stopping = true;
    this.#controller.beginFinalizing();
    this.#showPartial("");

    try {
      await active.capture.stop();
      await active.pump;
      active.sttSession.finish();
      const result = await withTimeout(active.final, this.#finalTimeoutMs);
      if (this.#active?.id === active.id) this.#active = null;
      const completed = await this.#controller.complete();
      if (!completed.ok) throw completed.error;
      return Object.freeze({ ...result, state: this.#controller.state });
    } catch (error) {
      await this.#fail(active.id, error);
      throw error;
    }
  }

  async toggle() {
    return this.#controller.state === VOICE_STATES.LISTENING ? this.stop() : this.start();
  }

  async #fail(operationId, error) {
    if (this.#active?.id !== operationId) return;
    this.#active = null;
    if ([VOICE_STATES.LISTENING, VOICE_STATES.FINALIZING].includes(this.#controller.state)) {
      await this.#controller.fail(error);
    }
    this.#showFailure(error);
  }

  #showFailure(error) {
    const failure = safeFailure(error);
    safeUi(() => this.#ui.notify?.(`${failure.message} (${failure.code})`, "error"));
  }

  async status() {
    const capability = await inspectVoiceCapability({
      config: this.#config,
      inputProbe: this.#inputProbe,
    });
    return Object.freeze({
      state: this.#controller.state,
      enabled: this.#config.enabled,
      stt: capability.stt,
      tts: capability.tts,
    });
  }

  async devices() {
    const devices = typeof this.#listDevices === "function" ? await this.#listDevices() : [];
    return Object.freeze(devices.slice(0, MAX_DEVICE_COUNT).map(({ id, label }) => Object.freeze({
      id: boundedDeviceValue(id),
      label: boundedDeviceValue(label),
    })));
  }

  snapshot() {
    return Object.freeze({ state: this.#controller.state, listening: this.#controller.state === VOICE_STATES.LISTENING });
  }

  async dispose() {
    if (this.#disposed) return Object.freeze({ ok: true, alreadyDisposed: true });
    this.#disposed = true;
    this.#sequence += 1;
    this.#active = null;
    safeUi(() => this.#ui.setWidget?.(PARTIAL_KEY, undefined));
    safeUi(() => this.#ui.setStatus?.(STATUS_KEY, undefined));
    const result = await this.#controller.dispose();
    return Object.freeze({ ok: result.ok, alreadyDisposed: false });
  }
}

/** Resolve environment and production dependencies only after an operator invokes voice. */
export function createPiVoiceDictation({ ui, env = process.env, overrides = {} } = {}) {
  const config = overrides.config ?? resolveVoiceConfig(env);
  return new VoiceDictation({
    ui,
    config,
    createCapture: overrides.createCapture ?? (() => new FfmpegAudioCapture({
      device: config.audio.inputDevice,
      maxRecordingMs: config.limits.maxRecordingMs,
    })),
    createSttProvider: overrides.createSttProvider ?? (() => createElevenLabsSttProviderFromConfig(config)),
    inputProbe: overrides.inputProbe ?? (() => probeFfmpegAudioCapture()),
    listDevices: overrides.listDevices ?? (() => listFfmpegInputDevices()),
    finalTimeoutMs: overrides.finalTimeoutMs,
    controllerFactory: overrides.controllerFactory,
  });
}
