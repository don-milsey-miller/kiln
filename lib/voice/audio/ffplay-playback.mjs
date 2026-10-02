import { spawn as spawnChild } from "node:child_process";
import { once } from "node:events";

import { VOICE_LIMITS } from "../config.mjs";
import { VoiceError } from "../errors.mjs";

const FFPLAY = "ffplay";
const STOP_GRACE_MS = 1_000;
const DEFAULT_MAX_AUDIO_BYTES = 64 * 1024 * 1024;
const SUPPORTED_PLATFORMS = new Set(["win32", "linux"]);
const SAFE_CAUSE_CODES = new Set(["EACCES", "ENOENT", "EPIPE", "EPERM"]);

export const AUDIO_PLAYBACK_ERROR = Object.freeze({
  ACTIVE: "audio-playback-already-active",
  BOUNDS: "audio-playback-bounds-exceeded",
  CANCELLED: "audio-playback-cancelled",
  DEPENDENCY: "audio-playback-dependency-unavailable",
  DISPOSED: "audio-playback-disposed",
  FORMAT: "audio-playback-format-invalid",
  INVALID_DEVICE: "audio-output-device-invalid",
  OUTPUT: "audio-output-unavailable",
  PROCESS: "audio-playback-failed",
  SOURCE: "audio-playback-source-invalid",
  UNSUPPORTED: "audio-playback-unsupported-platform",
});

function playbackError(code, message, details = {}) {
  return new VoiceError(code, message, details);
}

function causeCode(error) {
  return SAFE_CAUSE_CODES.has(error?.code) ? error.code : null;
}

function validateDevice(device) {
  if (device === null || device === undefined || device === "") return null;
  if (
    typeof device !== "string" ||
    device.trim().length === 0 ||
    device.length > VOICE_LIMITS.maxSettingCharacters ||
    /[\0\r\n]/.test(device)
  ) {
    throw playbackError(AUDIO_PLAYBACK_ERROR.INVALID_DEVICE, "The configured voice output device is invalid.");
  }
  return device.trim();
}

function validateMaximumBytes(value) {
  if (!Number.isSafeInteger(value) || value < 2 || value > DEFAULT_MAX_AUDIO_BYTES) {
    throw playbackError(AUDIO_PLAYBACK_ERROR.BOUNDS, "The voice playback byte bound is invalid.", {
      maximumBytes: DEFAULT_MAX_AUDIO_BYTES,
    });
  }
  return value;
}

export function validatePcmPlaybackFormat(format) {
  if (
    typeof format?.encoding !== "string" ||
    !/^pcm_[1-9][0-9]{3,5}$/.test(format.encoding) ||
    !Number.isSafeInteger(format.sampleRate) ||
    format.sampleRate < 8_000 ||
    format.sampleRate > 48_000 ||
    !Number.isSafeInteger(format.channels) ||
    format.channels < 1 ||
    format.channels > 2 ||
    format.sampleFormat !== "s16le" ||
    format.bytesPerSample !== 2
  ) {
    throw playbackError(
      AUDIO_PLAYBACK_ERROR.FORMAT,
      "Voice playback requires signed 16-bit little-endian PCM at a supported sample rate."
    );
  }
  return Object.freeze({
    encoding: format.encoding,
    sampleRate: format.sampleRate,
    channels: format.channels,
    sampleFormat: "s16le",
    bytesPerSample: 2,
  });
}

export function ffplayPlaybackArgs(format) {
  const pcm = validatePcmPlaybackFormat(format);
  return Object.freeze([
    "-hide_banner",
    "-loglevel",
    "error",
    "-nostdin",
    "-nodisp",
    "-autoexit",
    "-f",
    "s16le",
    "-ar",
    String(pcm.sampleRate),
    "-ac",
    String(pcm.channels),
    "-i",
    "pipe:0",
  ]);
}

function spawnOptions(device, env) {
  const selected = validateDevice(device);
  return {
    shell: false,
    windowsHide: true,
    stdio: ["pipe", "ignore", "pipe"],
    env: selected
      ? { ...env, AUDIODEV: selected, PULSE_SINK: selected, SDL_AUDIO_DEVICE_NAME: selected }
      : env,
  };
}

async function* audioChunks(source) {
  if (source instanceof Uint8Array) {
    yield source;
    return;
  }
  if (typeof source?.[Symbol.asyncIterator] !== "function") {
    throw playbackError(AUDIO_PLAYBACK_ERROR.SOURCE, "The synthesized voice audio source is invalid.");
  }
  for await (const value of source) {
    if (!(value instanceof Uint8Array)) {
      throw playbackError(AUDIO_PLAYBACK_ERROR.SOURCE, "The synthesized voice audio source is invalid.");
    }
    yield value;
  }
}

/**
 * Inert ffplay-backed PCM output. Audio exists only in the caller, this process, and ffplay's stdin.
 */
export class FfplayAudioPlayback {
  #spawn;
  #platform;
  #device;
  #maxAudioBytes;
  #env;
  #active = null;
  #disposed = false;

  constructor({
    spawnImpl = spawnChild,
    platform = process.platform,
    device = null,
    maxAudioBytes = DEFAULT_MAX_AUDIO_BYTES,
    env = process.env,
  } = {}) {
    this.#spawn = spawnImpl;
    this.#platform = platform;
    this.#device = validateDevice(device);
    this.#maxAudioBytes = validateMaximumBytes(maxAudioBytes);
    this.#env = env;
  }

  get active() {
    return this.#active !== null;
  }

  async play(format, source, { signal } = {}) {
    if (this.#disposed) throw playbackError(AUDIO_PLAYBACK_ERROR.DISPOSED, "Voice playback has been disposed.");
    if (this.#active) throw playbackError(AUDIO_PLAYBACK_ERROR.ACTIVE, "Voice playback is already active.");
    if (!SUPPORTED_PLATFORMS.has(this.#platform)) {
      throw playbackError(AUDIO_PLAYBACK_ERROR.UNSUPPORTED, "Voice playback is not supported on this platform.");
    }
    if (signal?.aborted) throw playbackError(AUDIO_PLAYBACK_ERROR.CANCELLED, "Voice playback was cancelled before it started.");

    const pcm = validatePcmPlaybackFormat(format);
    let child;
    try {
      child = this.#spawn(FFPLAY, ffplayPlaybackArgs(pcm), spawnOptions(this.#device, this.#env));
    } catch (error) {
      throw playbackError(AUDIO_PLAYBACK_ERROR.DEPENDENCY, "FFplay is unavailable for voice playback.", {
        causeCode: causeCode(error),
      });
    }
    if (!child?.stdin || !child?.stderr || typeof child.kill !== "function") {
      child?.kill?.("SIGKILL");
      throw playbackError(AUDIO_PLAYBACK_ERROR.PROCESS, "FFplay did not provide a usable voice playback process.");
    }

    let resolveDone;
    let rejectDone;
    const done = new Promise((resolve, reject) => {
      resolveDone = resolve;
      rejectDone = reject;
    });
    const active = {
      child,
      done,
      resolveDone,
      rejectDone,
      signal,
      abort: null,
      reason: null,
      failure: null,
      forceTimer: null,
      settled: false,
      spawned: false,
      bytes: 0,
    };
    this.#active = active;
    child.stderr.on("data", () => {});
    child.stdin.on("error", (error) => this.#failActive(active, playbackError(
      AUDIO_PLAYBACK_ERROR.PROCESS,
      "Voice playback failed while receiving audio.",
      { causeCode: causeCode(error) }
    )));
    child.once("close", (code, processSignal) => this.#onClose(active, code, processSignal));

    const spawned = new Promise((resolve, reject) => {
      child.once("spawn", () => {
        active.spawned = true;
        resolve();
      });
      child.on("error", (error) => {
        const failure = playbackError(
          active.spawned ? AUDIO_PLAYBACK_ERROR.PROCESS : AUDIO_PLAYBACK_ERROR.DEPENDENCY,
          active.spawned ? "Voice playback failed." : "FFplay is unavailable for voice playback.",
          { causeCode: causeCode(error) }
        );
        if (!active.spawned) reject(failure);
        else this.#failActive(active, failure);
      });
    });

    try {
      await spawned;
    } catch (error) {
      active.settled = true;
      this.#clearActive(active);
      active.resolveDone(Object.freeze({ ok: false, reason: "start-failed", bytes: 0, code: null, signal: null }));
      throw error;
    }

    if (signal) {
      active.abort = () => { void this.#stopActive(active, "aborted"); };
      signal.addEventListener("abort", active.abort, { once: true });
    }
    void this.#writeSource(active, pcm, source).catch((error) => this.#failActive(active, error));
    return done;
  }

  async #writeSource(active, format, source) {
    const frameBytes = format.channels * format.bytesPerSample;
    for await (const chunk of audioChunks(source)) {
      if (active.settled || active.reason !== null) return;
      if (chunk.byteLength === 0) continue;
      active.bytes += chunk.byteLength;
      if (active.bytes > this.#maxAudioBytes) {
        throw playbackError(AUDIO_PLAYBACK_ERROR.BOUNDS, "Synthesized voice audio exceeded the playback bound.", {
          maximumBytes: this.#maxAudioBytes,
        });
      }
      if (!active.child.stdin.write(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength))) {
        await once(active.child.stdin, "drain");
      }
    }
    if (active.bytes % frameBytes !== 0) {
      throw playbackError(AUDIO_PLAYBACK_ERROR.FORMAT, "Synthesized voice audio ended with an incomplete PCM frame.");
    }
    if (!active.settled && active.reason === null) active.child.stdin.end();
  }

  #clearActive(active) {
    if (active.forceTimer) clearTimeout(active.forceTimer);
    if (active.signal && active.abort) active.signal.removeEventListener("abort", active.abort);
    if (this.#active === active) this.#active = null;
  }

  #failActive(active, error) {
    if (active.settled || active.failure) return;
    active.failure = error instanceof VoiceError
      ? error
      : playbackError(AUDIO_PLAYBACK_ERROR.PROCESS, "Voice playback failed.");
    void this.#stopActive(active, "failed").catch(() => {});
  }

  #onClose(active, code, processSignal) {
    if (active.settled) return;
    active.settled = true;
    this.#clearActive(active);
    if (active.failure) {
      active.rejectDone(active.failure);
      return;
    }
    const expected = active.reason !== null;
    if (!expected && code !== 0) {
      active.rejectDone(playbackError(AUDIO_PLAYBACK_ERROR.OUTPUT, "The configured voice output could not be played."));
      return;
    }
    active.resolveDone(Object.freeze({
      ok: true,
      reason: active.reason ?? "played",
      bytes: active.bytes,
      code: Number.isInteger(code) ? code : null,
      signal: typeof processSignal === "string" ? processSignal : null,
    }));
  }

  async #stopActive(active, reason) {
    if (active.settled) return active.done;
    if (active.reason === null) active.reason = reason;
    active.child.stdin.destroy();
    active.child.kill("SIGTERM");
    if (!active.forceTimer) {
      active.forceTimer = setTimeout(() => {
        if (!active.settled) active.child.kill("SIGKILL");
      }, STOP_GRACE_MS);
      active.forceTimer.unref?.();
    }
    return active.done;
  }

  async stop() {
    const active = this.#active;
    if (!active) return Object.freeze({ ok: true, inactive: true });
    await this.#stopActive(active, "stopped");
    return Object.freeze({ ok: true, inactive: false });
  }

  async dispose() {
    if (this.#disposed) return Object.freeze({ ok: true, alreadyDisposed: true });
    this.#disposed = true;
    await this.stop();
    return Object.freeze({ ok: true, alreadyDisposed: false });
  }
}

export function createFfplayAudioPlayback(options) {
  return new FfplayAudioPlayback(options);
}
