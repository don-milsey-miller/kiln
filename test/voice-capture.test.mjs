import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";

import {
  AUDIO_CAPTURE_ERROR,
  FfmpegAudioCapture,
  PCM_16000,
  ffmpegCaptureArgs,
  listFfmpegInputDevices,
  probeFfmpegAudioCapture,
} from "../lib/voice/audio/ffmpeg-capture.mjs";
import { FakeAudioCapture } from "../lib/voice/audio/fake-capture.mjs";
import { createVoiceController } from "../lib/voice/controller.mjs";

class FakeChild extends EventEmitter {
  constructor({ closeCode = 0, listOutput = null, spawnError = null } = {}) {
    super();
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.signals = [];
    this.closeCode = closeCode;
    this.listOutput = listOutput;
    this.spawnError = spawnError;
  }

  launch() {
    queueMicrotask(() => {
      if (this.spawnError) {
        this.emit("error", this.spawnError);
        return;
      }
      this.emit("spawn");
      if (this.listOutput !== null) {
        this.stderr.end(this.listOutput);
        this.stdout.end();
        this.emit("close", this.closeCode, null);
      }
    });
  }

  kill(signal) {
    this.signals.push(signal);
    queueMicrotask(() => {
      if (this.stdout.destroyed) return;
      this.stdout.end();
      this.stderr.end();
      this.emit("close", 0, signal);
    });
    return true;
  }

  fail(code = this.closeCode) {
    this.stdout.end();
    this.stderr.end("device failure containing sensitive host detail");
    this.emit("close", code, null);
  }
}

function scriptedSpawn(children) {
  const calls = [];
  const spawn = (command, args, options) => {
    calls.push({ command, args: [...args], options });
    const child = children.shift();
    if (!child) throw new Error("unexpected spawn");
    child.launch();
    return child;
  };
  return { spawn, calls };
}

async function readAll(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

test("FFmpeg capture emits canonical in-memory PCM with a shell-free fixed command", async () => {
  const child = new FakeChild();
  const script = scriptedSpawn([child]);
  const hostileDevice = "Microphone; echo definitely-not-a-command --version";
  const capture = new FfmpegAudioCapture({ spawnImpl: script.spawn, platform: "win32", device: hostileDevice, maxRecordingMs: 1_000 });
  const session = await capture.start();
  const output = readAll(session.stream);
  child.stdout.write(Buffer.from([1, 0, 2, 0]));
  await capture.stop();

  assert.deepEqual(await output, Buffer.from([1, 0, 2, 0]));
  assert.deepEqual(session.format, PCM_16000);
  assert.equal(script.calls[0].command, "ffmpeg");
  assert.equal(script.calls[0].options.shell, false);
  assert.deepEqual(script.calls[0].options.stdio, ["ignore", "pipe", "pipe"]);
  assert.equal(script.calls[0].args.filter((arg) => arg === hostileDevice).length, 0);
  assert.ok(script.calls[0].args.includes("dshow"));
  assert.ok(script.calls[0].args.includes(`audio=${hostileDevice}`));
  assert.equal(script.calls[0].args.at(-1), "pipe:1");
  assert.equal(script.calls[0].args.some((arg) => /\.(wav|pcm|raw)$/i.test(arg)), false);
  assert.deepEqual(child.signals, ["SIGTERM"]);
});

test("capture start/stop is repeatable and disposal terminates controller-owned capture", async () => {
  const first = new FakeChild();
  const second = new FakeChild();
  const script = scriptedSpawn([first, second]);
  const capture = new FfmpegAudioCapture({ spawnImpl: script.spawn, platform: "linux", maxRecordingMs: 1_000 });

  await capture.start();
  await capture.stop();
  await capture.start();

  const controller = createVoiceController({
    createCapture: () => capture,
    createSttProvider: () => ({ start() {}, async dispose() {} }),
  });
  await controller.startListening();
  await controller.dispose();
  assert.deepEqual(first.signals, ["SIGTERM"]);
  assert.deepEqual(second.signals, ["SIGTERM"]);
  assert.equal(capture.active, false);
});

test("abort cancellation and byte bounds stop incoming audio promptly", async () => {
  const abortedChild = new FakeChild();
  const boundedChild = new FakeChild();
  const script = scriptedSpawn([abortedChild, boundedChild]);
  const capture = new FfmpegAudioCapture({ spawnImpl: script.spawn, platform: "linux", maxRecordingMs: 1 });
  const abort = new AbortController();
  await capture.start({ signal: abort.signal });
  abort.abort();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(abortedChild.signals, ["SIGTERM"]);

  const bounded = await capture.start();
  const output = readAll(bounded.stream);
  boundedChild.stdout.write(Buffer.alloc(128, 7));
  const bytes = await output;
  assert.equal(bytes.length, bounded.maximumBytes);
  assert.equal(bytes.length, 32);
  assert.deepEqual(boundedChild.signals, ["SIGTERM"]);
});

test("elapsed recording duration is enforced below the UI layer", async () => {
  const child = new FakeChild();
  const script = scriptedSpawn([child]);
  const capture = new FfmpegAudioCapture({ spawnImpl: script.spawn, platform: "linux", maxRecordingMs: 5 });
  const session = await capture.start();
  const result = await session.done;
  assert.equal(result.ok, true);
  assert.equal(result.reason, "max-duration");
  assert.deepEqual(child.signals, ["SIGTERM"]);
});

test("missing FFmpeg and failed hardware remain voice-specific and sanitized", async () => {
  const missing = new Error("could not launch a path with sensitive detail");
  missing.code = "ENOENT";
  const missingScript = scriptedSpawn([new FakeChild({ spawnError: missing })]);
  const absent = new FfmpegAudioCapture({ spawnImpl: missingScript.spawn, platform: "win32" });
  await assert.rejects(() => absent.start(), (error) => {
    assert.equal(error.code, AUDIO_CAPTURE_ERROR.DEPENDENCY);
    assert.deepEqual(error.details, { causeCode: "ENOENT" });
    assert.equal(error.message.includes("sensitive"), false);
    return true;
  });

  const failedChild = new FakeChild({ closeCode: 1 });
  const failedScript = scriptedSpawn([failedChild]);
  const failed = new FfmpegAudioCapture({ spawnImpl: failedScript.spawn, platform: "linux" });
  const session = await failed.start();
  session.stream.on("error", () => {});
  failedChild.fail();
  const result = await session.done;
  assert.equal(result.ok, false);
  assert.equal(result.error.code, AUDIO_CAPTURE_ERROR.INPUT);
  assert.equal(JSON.stringify(result).includes("sensitive host detail"), false);
});

test("platform-native input devices are enumerable and dependency probing does not start capture", async () => {
  const directShowListing = [
    '[dshow @ abc] "Integrated Camera" (video)',
    '[dshow @ abc] "Microphone Array" (audio)',
    '[dshow @ abc]   Alternative name "@device_cm_private"',
    '[dshow @ abc] "USB Headset" (audio)',
    "Error opening input file dummy.",
  ].join("\n");
  const listing = [
    "[openal @ abc] List of OpenAL capture devices on this system:",
    "[openal @ abc]   Default Microphone",
    "[openal @ abc]   USB Headset",
    "Error opening input file dummy.",
  ].join("\n");
  const listChild = new FakeChild({ closeCode: 1, listOutput: directShowListing });
  const probeChild = new FakeChild({ closeCode: 1, listOutput: listing });
  const script = scriptedSpawn([listChild, probeChild]);

  assert.deepEqual(await listFfmpegInputDevices({ spawnImpl: script.spawn, platform: "win32" }), [
    { id: "Microphone Array", label: "Microphone Array" },
    { id: "USB Headset", label: "USB Headset" },
  ]);
  assert.deepEqual(await probeFfmpegAudioCapture({ spawnImpl: script.spawn, platform: "linux" }), {
    available: true,
    deviceCount: 2,
  });
  assert.ok(script.calls.every((call) => call.args.includes("-list_devices")));
  assert.ok(script.calls.every((call) => !call.args.includes("pipe:1")));
  assert.ok(script.calls[0].args.includes("dshow"));
  assert.ok(script.calls[1].args.includes("openal"));
});

test("Windows capture selects the first enumerated DirectShow microphone when none is configured", async () => {
  const listing = '[dshow @ abc] "Microphone Array" (audio)\nError opening input file dummy.';
  const listChild = new FakeChild({ closeCode: 1, listOutput: listing });
  const captureChild = new FakeChild();
  const script = scriptedSpawn([listChild, captureChild]);
  const capture = new FfmpegAudioCapture({ spawnImpl: script.spawn, platform: "win32", maxRecordingMs: 1_000 });

  await capture.start();
  await capture.stop();

  assert.ok(script.calls[0].args.includes("dshow"));
  assert.ok(script.calls[0].args.includes("-list_devices"));
  assert.ok(script.calls[1].args.includes("dshow"));
  assert.ok(script.calls[1].args.includes("audio=Microphone Array"));
});

test("an FFmpeg build without OpenAL is a dependency failure, not a missing microphone", async () => {
  const child = new FakeChild({ closeCode: 1, listOutput: "Unknown input format: 'openal'" });
  const script = scriptedSpawn([child]);
  assert.deepEqual(await probeFfmpegAudioCapture({ spawnImpl: script.spawn, platform: "linux" }), {
    available: false,
    reason: "dependency-missing",
  });
});

test("fake capture supports deterministic streaming without hardware", async () => {
  const capture = new FakeAudioCapture();
  const session = await capture.start();
  const output = readAll(session.stream);
  capture.push(Buffer.from([3, 0, 4, 0]));
  await capture.stop();
  assert.deepEqual(await output, Buffer.from([3, 0, 4, 0]));
  assert.deepEqual(session.format, PCM_16000);
  assert.deepEqual(await capture.dispose(), { ok: true, alreadyDisposed: false });
});

test("unsupported platforms and invalid devices fail before spawning", async () => {
  assert.throws(() => ffmpegCaptureArgs("bad\nname"), (error) => error.code === AUDIO_CAPTURE_ERROR.INVALID_DEVICE);
  const capture = new FfmpegAudioCapture({ platform: "darwin" });
  await assert.rejects(() => capture.start(), (error) => error.code === AUDIO_CAPTURE_ERROR.UNSUPPORTED);
});

