import { spawn as spawnChild } from "node:child_process";
import { Transform } from "node:stream";

import { VoiceError } from "../errors.mjs";
import { VOICE_DEFAULTS, VOICE_LIMITS } from "../config.mjs";

const FFMPEG = "ffmpeg";
const STOP_GRACE_MS = 1_000;
const PROCESS_PROBE_MS = 5_000;
const MAX_PROBE_OUTPUT_BYTES = 64 * 1024;
const BYTES_PER_MILLISECOND = 16_000 * 2 / 1_000;
const SUPPORTED_PLATFORMS = new Set(["win32", "linux"]);
const SAFE_CAUSE_CODES = new Set(["EACCES", "ENOENT", "EPERM"]);

export const PCM_16000 = Object.freeze({
  encoding: "pcm_16000",
  sampleRate: 16_000,
  channels: 1,
  sampleFormat: "s16le",
  bytesPerSample: 2,
});

export const AUDIO_CAPTURE_ERROR = Object.freeze({
  ACTIVE: "audio-capture-already-active",
  BOUNDS: "audio-capture-invalid-bounds",
  CANCELLED: "audio-capture-cancelled",
  DEPENDENCY: "audio-capture-dependency-unavailable",
  DISPOSED: "audio-capture-disposed",
  INPUT: "audio-input-unavailable",
  INVALID_DEVICE: "audio-input-device-invalid",
  PROCESS: "audio-capture-failed",
  UNSUPPORTED: "audio-capture-unsupported-platform",
});

function captureError(code, message, details = {}) {
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
    throw captureError(AUDIO_CAPTURE_ERROR.INVALID_DEVICE, "The configured voice input device is invalid.");
  }
  return device;
}

function validateDuration(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > VOICE_LIMITS.maxRecordingMs) {
    throw captureError(AUDIO_CAPTURE_ERROR.BOUNDS, "The microphone recording bound is invalid.", {
      maximumMs: VOICE_LIMITS.maxRecordingMs,
    });
  }
  return value;
}

export function ffmpegCaptureArgs(device = null, platform = process.platform) {
  const selected = validateDevice(device) ?? "";
  const input = platform === "win32"
    ? ["-f", "dshow", "-i", `audio=${selected}`]
    : ["-f", "openal", "-i", selected];
  return Object.freeze([
    "-hide_banner",
    "-loglevel",
    "error",
    "-nostdin",
    ...input,
    "-vn",
    "-ac",
    "1",
    "-ar",
    "16000",
    "-acodec",
    "pcm_s16le",
    "-f",
    "s16le",
    "pipe:1",
  ]);
}

function spawnOptions() {
  return { shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] };
}

function boundedProcess(spawnImpl, args, { timeoutMs = PROCESS_PROBE_MS } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnImpl(FFMPEG, args, spawnOptions());
    } catch (error) {
      reject(captureError(AUDIO_CAPTURE_ERROR.DEPENDENCY, "FFmpeg is unavailable for voice capture.", { causeCode: causeCode(error) }));
      return;
    }

    let output = "";
    let settled = false;
    const append = (chunk) => {
      if (Buffer.byteLength(output) >= MAX_PROBE_OUTPUT_BYTES) return;
      output += Buffer.from(chunk).toString("utf8", 0, MAX_PROBE_OUTPUT_BYTES - Buffer.byteLength(output));
    };
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    const timer = setTimeout(() => {
      if (settled) return;
      child.kill("SIGKILL");
      settled = true;
      resolve({ code: null, output, timedOut: true });
    }, timeoutMs);
    timer.unref?.();
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(captureError(AUDIO_CAPTURE_ERROR.DEPENDENCY, "FFmpeg is unavailable for voice capture.", { causeCode: causeCode(error) }));
    });
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, output, timedOut: false });
    });
  });
}

function parseOpenAlDevices(output) {
  const devices = [];
  let inCaptureList = false;
  for (const raw of output.split(/\r?\n/)) {
    const line = raw.replace(/^\[[^\]]+\]\s*/, "");
    if (/List of OpenAL capture devices/i.test(line)) {
      inCaptureList = true;
      continue;
    }
    if (!inCaptureList) continue;
    const name = line.trim();
    if (!name || /^Error /i.test(name)) continue;
    devices.push(Object.freeze({ id: name, label: name }));
  }
  return Object.freeze(devices);
}

function parseDirectShowDevices(output) {
  const devices = [];
  for (const raw of output.split(/\r?\n/)) {
    const line = raw.replace(/^\[[^\]]+\]\s*/, "");
    const match = line.match(/^\s*"(.+)"\s+\(audio\)\s*$/i);
    if (!match) continue;
    devices.push(Object.freeze({ id: match[1], label: match[1] }));
  }
  return Object.freeze(devices);
}

export async function listFfmpegInputDevices({ spawnImpl = spawnChild, platform = process.platform } = {}) {
  if (!SUPPORTED_PLATFORMS.has(platform)) return Object.freeze([]);
  const backend = platform === "win32" ? "dshow" : "openal";
  const result = await boundedProcess(spawnImpl, ["-hide_banner", "-list_devices", "true", "-f", backend, "-i", "dummy"]);
  if (result.timedOut)
    throw captureError(AUDIO_CAPTURE_ERROR.PROCESS, "FFmpeg did not finish the voice device check.");
  const missingBackend = new RegExp(`Unknown input format:\\s*['"]?${backend}|${backend}.*(?:not found|not known)`, "i");
  if (missingBackend.test(result.output))
    throw captureError(AUDIO_CAPTURE_ERROR.DEPENDENCY, `FFmpeg does not include the ${backend} voice capture device.`);
  return platform === "win32" ? parseDirectShowDevices(result.output) : parseOpenAlDevices(result.output);
}

/** A non-capturing dependency/device check for an explicit `/voice status` request. */
export async function probeFfmpegAudioCapture(options = {}) {
  const platform = options.platform ?? process.platform;
  if (!SUPPORTED_PLATFORMS.has(platform)) return Object.freeze({ available: false, reason: "unsupported-platform" });
  try {
    const devices = await listFfmpegInputDevices(options);
    return devices.length > 0
      ? Object.freeze({ available: true, deviceCount: devices.length })
      : Object.freeze({ available: false, reason: "no-microphone" });
  } catch (error) {
    return Object.freeze({
      available: false,
      reason: error?.code === AUDIO_CAPTURE_ERROR.DEPENDENCY ? "dependency-missing" : "probe-failed",
    });
  }
}

/**
 * FFmpeg microphone capture through DirectShow on Windows and OpenAL on Linux. Construction is
 * inert; `start` is the only acquisition path.
 * Audio is converted to raw mono 16-bit little-endian PCM at 16 kHz and exists only in memory.
 */
export class FfmpegAudioCapture {
  #spawn;
  #platform;
  #device;
  #maxRecordingMs;
  #active = null;
  #disposed = false;

  constructor({
    spawnImpl = spawnChild,
    platform = process.platform,
    device = null,
    maxRecordingMs = VOICE_DEFAULTS.maxRecordingMs,
  } = {}) {
    this.#spawn = spawnImpl;
    this.#platform = platform;
    this.#device = validateDevice(device);
    this.#maxRecordingMs = validateDuration(maxRecordingMs);
  }

  get format() {
    return PCM_16000;
  }

  get active() {
    return this.#active !== null;
  }

  async start({ signal } = {}) {
    if (this.#disposed) throw captureError(AUDIO_CAPTURE_ERROR.DISPOSED, "Voice capture has been disposed.");
    if (this.#active) throw captureError(AUDIO_CAPTURE_ERROR.ACTIVE, "Voice capture is already active.");
    if (!SUPPORTED_PLATFORMS.has(this.#platform))
      throw captureError(AUDIO_CAPTURE_ERROR.UNSUPPORTED, "Voice capture is not supported on this platform.");
    if (signal?.aborted) throw captureError(AUDIO_CAPTURE_ERROR.CANCELLED, "Voice capture was cancelled before it started.");

    let selectedDevice = this.#device;
    if (this.#platform === "win32" && !selectedDevice) {
      const devices = await listFfmpegInputDevices({ spawnImpl: this.#spawn, platform: this.#platform });
      selectedDevice = devices[0]?.id ?? null;
      if (!selectedDevice)
        throw captureError(AUDIO_CAPTURE_ERROR.INPUT, "No microphone is available for voice capture.");
    }

    let child;
    try {
      child = this.#spawn(FFMPEG, ffmpegCaptureArgs(selectedDevice, this.#platform), spawnOptions());
    } catch (error) {
      throw captureError(AUDIO_CAPTURE_ERROR.DEPENDENCY, "FFmpeg is unavailable for voice capture.", {
        causeCode: causeCode(error),
      });
    }
    if (!child?.stdout || !child?.stderr || typeof child.kill !== "function") {
      child?.kill?.("SIGKILL");
      throw captureError(AUDIO_CAPTURE_ERROR.PROCESS, "FFmpeg did not provide a usable voice capture process.");
    }

    const maximumBytes = Math.floor(this.#maxRecordingMs * BYTES_PER_MILLISECOND / 2) * 2;
    let bytes = 0;
    let resolveDone;
    const done = new Promise((resolve) => { resolveDone = resolve; });
    const active = {
      child,
      done,
      resolveDone,
      reason: null,
      timer: null,
      forceTimer: null,
      abort: null,
      signal,
      settled: false,
      stream: null,
    };

    const stream = new Transform({
      transform: (chunk, _encoding, callback) => {
        const source = Buffer.from(chunk);
        let take = Math.min(source.length, maximumBytes - bytes);
        take -= take % PCM_16000.bytesPerSample;
        if (take > 0) {
          bytes += take;
          stream.push(source.subarray(0, take));
        }
        if (bytes >= maximumBytes && active.reason === null) {
          active.reason = "max-bytes";
          queueMicrotask(() => { void this.#stopActive(active, "max-bytes"); });
        }
        callback();
      },
    });
    active.stream = stream;
    this.#active = active;

    child.stderr.on("data", () => {});
    child.stdout.pipe(stream);
    child.once("close", (code, processSignal) => this.#onClose(active, code, processSignal));

    const spawned = new Promise((resolve, reject) => {
      let started = false;
      child.once("spawn", () => {
        started = true;
        resolve();
      });
      child.on("error", (error) => {
        const failure = captureError(
          started ? AUDIO_CAPTURE_ERROR.PROCESS : AUDIO_CAPTURE_ERROR.DEPENDENCY,
          started ? "Voice capture failed." : "FFmpeg is unavailable for voice capture.",
          { causeCode: causeCode(error) }
        );
        if (!started) reject(failure);
        else this.#failActive(active, failure);
      });
    });

    try {
      await spawned;
    } catch (error) {
      this.#clearActive(active);
      child.stdout.unpipe(stream);
      stream.end();
      throw error;
    }

    active.timer = setTimeout(() => { void this.#stopActive(active, "max-duration"); }, this.#maxRecordingMs);
    active.timer.unref?.();
    if (signal) {
      active.abort = () => { void this.#stopActive(active, "aborted"); };
      signal.addEventListener("abort", active.abort, { once: true });
    }

    return Object.freeze({ format: PCM_16000, stream, done, maximumBytes });
  }

  #clearActive(active) {
    if (active.timer) clearTimeout(active.timer);
    if (active.forceTimer) clearTimeout(active.forceTimer);
    if (active.signal && active.abort) active.signal.removeEventListener("abort", active.abort);
    if (this.#active === active) this.#active = null;
  }

  #failActive(active, error) {
    if (active.settled) return;
    active.reason = "failed";
    active.stream.destroy(error);
    void this.#stopActive(active, "failed");
  }

  #onClose(active, code, processSignal) {
    if (active.settled) return;
    active.settled = true;
    this.#clearActive(active);
    const expected = active.reason !== null;
    const failure = !expected && code !== 0
      ? captureError(AUDIO_CAPTURE_ERROR.INPUT, "The configured microphone could not be captured.")
      : null;
    if (failure && !active.stream.destroyed) active.stream.destroy(failure);
    active.resolveDone(Object.freeze({
      ok: failure === null,
      reason: failure ? "input-unavailable" : active.reason ?? "ended",
      code: Number.isInteger(code) ? code : null,
      signal: typeof processSignal === "string" ? processSignal : null,
      ...(failure ? { error: failure } : {}),
    }));
  }

  async #stopActive(active, reason) {
    if (active.settled) return active.done;
    if (active.reason === null) active.reason = reason;
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

export function createFfmpegAudioCapture(options) {
  return new FfmpegAudioCapture(options);
}

