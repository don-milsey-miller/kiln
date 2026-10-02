import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";

import { FakeAudioPlayback } from "../lib/voice/audio/fake-playback.mjs";
import {
  AUDIO_PLAYBACK_ERROR,
  FfplayAudioPlayback,
  ffplayPlaybackArgs,
} from "../lib/voice/audio/ffplay-playback.mjs";
import { PCM_16000 } from "../lib/voice/audio/ffmpeg-capture.mjs";

class FakeChild extends EventEmitter {
  constructor({ closeCode = 0, spawnError = null, closeOnInput = true } = {}) {
    super();
    this.stdin = new PassThrough();
    this.stderr = new PassThrough();
    this.signals = [];
    this.closeCode = closeCode;
    this.spawnError = spawnError;
    this.closeOnInput = closeOnInput;
    this.input = [];
    this.stdin.on("data", (chunk) => this.input.push(Buffer.from(chunk)));
    this.stdin.on("finish", () => {
      if (this.closeOnInput) queueMicrotask(() => this.emit("close", this.closeCode, null));
    });
  }

  launch() {
    queueMicrotask(() => this.spawnError ? this.emit("error", this.spawnError) : this.emit("spawn"));
  }

  kill(signal) {
    this.signals.push(signal);
    queueMicrotask(() => this.emit("close", 0, signal));
    return true;
  }

  fail(code = this.closeCode || 1) {
    this.stderr.write("host output that must not escape");
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

async function* chunks(...values) {
  for (const value of values) yield Buffer.from(value);
}

test("FFplay receives in-memory PCM through stdin with a fixed shell-free command", async () => {
  const child = new FakeChild();
  const script = scriptedSpawn([child]);
  const hostileDevice = "Headphones; echo definitely-not-a-command";
  const playback = new FfplayAudioPlayback({
    spawnImpl: script.spawn,
    platform: "win32",
    device: hostileDevice,
    env: { PATH: "test-path" },
  });

  const result = await playback.play(PCM_16000, chunks([1, 0], [2, 0]));
  assert.deepEqual(result, { ok: true, reason: "played", bytes: 4, code: 0, signal: null });
  assert.deepEqual(Buffer.concat(child.input), Buffer.from([1, 0, 2, 0]));
  assert.equal(script.calls[0].command, "ffplay");
  assert.equal(script.calls[0].options.shell, false);
  assert.deepEqual(script.calls[0].options.stdio, ["pipe", "ignore", "pipe"]);
  assert.equal(script.calls[0].options.env.SDL_AUDIO_DEVICE_NAME, hostileDevice);
  assert.equal(script.calls[0].args.includes(hostileDevice), false);
  assert.equal(script.calls[0].args.at(-1), "pipe:0");
  assert.equal(script.calls[0].args.some((arg) => /\.(wav|pcm|raw)$/i.test(arg)), false);
});

test("stop, abort, repeated playback, and disposal release each child deterministically", async () => {
  const first = new FakeChild({ closeOnInput: false });
  const second = new FakeChild({ closeOnInput: false });
  const third = new FakeChild({ closeOnInput: false });
  const script = scriptedSpawn([first, second, third]);
  const playback = new FfplayAudioPlayback({ spawnImpl: script.spawn, platform: "linux" });
  const firstPlay = playback.play(PCM_16000, Buffer.alloc(4));
  await new Promise((resolve) => setImmediate(resolve));
  await playback.stop();
  assert.equal((await firstPlay).reason, "stopped");

  const abort = new AbortController();
  const secondPlay = playback.play(PCM_16000, Buffer.alloc(4), { signal: abort.signal });
  await new Promise((resolve) => setImmediate(resolve));
  abort.abort();
  assert.equal((await secondPlay).reason, "aborted");
  assert.deepEqual(first.signals, ["SIGTERM"]);
  assert.deepEqual(second.signals, ["SIGTERM"]);

  const thirdPlay = playback.play(PCM_16000, Buffer.alloc(4));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(await playback.dispose(), { ok: true, alreadyDisposed: false });
  assert.equal((await thirdPlay).reason, "stopped");
  assert.deepEqual(third.signals, ["SIGTERM"]);
  assert.deepEqual(await playback.dispose(), { ok: true, alreadyDisposed: true });
});

test("missing player and failed output hardware stay voice-specific and sanitized", async () => {
  const missing = new Error("sensitive executable location");
  missing.code = "ENOENT";
  const missingScript = scriptedSpawn([new FakeChild({ spawnError: missing })]);
  await assert.rejects(
    () => new FfplayAudioPlayback({ spawnImpl: missingScript.spawn, platform: "win32" }).play(PCM_16000, Buffer.alloc(2)),
    (error) => error.code === AUDIO_PLAYBACK_ERROR.DEPENDENCY && !error.message.includes("sensitive")
  );

  const failed = new FakeChild({ closeCode: 1, closeOnInput: false });
  const failedScript = scriptedSpawn([failed]);
  const play = new FfplayAudioPlayback({ spawnImpl: failedScript.spawn, platform: "linux" }).play(PCM_16000, Buffer.alloc(2));
  await new Promise((resolve) => setImmediate(resolve));
  failed.fail();
  await assert.rejects(() => play, (error) => {
    assert.equal(error.code, AUDIO_PLAYBACK_ERROR.OUTPUT);
    assert.equal(error.message.includes("host output"), false);
    return true;
  });
});

test("PCM format, source, byte, device, and platform boundaries fail before persistence", async () => {
  assert.throws(() => ffplayPlaybackArgs({ ...PCM_16000, sampleFormat: "f32le" }), { code: AUDIO_PLAYBACK_ERROR.FORMAT });
  assert.throws(() => new FfplayAudioPlayback({ device: "bad\noutput" }), { code: AUDIO_PLAYBACK_ERROR.INVALID_DEVICE });
  await assert.rejects(
    () => new FfplayAudioPlayback({ platform: "darwin" }).play(PCM_16000, Buffer.alloc(2)),
    { code: AUDIO_PLAYBACK_ERROR.UNSUPPORTED }
  );

  const child = new FakeChild({ closeOnInput: false });
  const script = scriptedSpawn([child]);
  const bounded = new FfplayAudioPlayback({ spawnImpl: script.spawn, platform: "linux", maxAudioBytes: 4 });
  const play = bounded.play(PCM_16000, Buffer.alloc(6));
  await assert.rejects(() => play, { code: AUDIO_PLAYBACK_ERROR.BOUNDS });
  assert.deepEqual(child.signals, ["SIGTERM"]);
});

test("fake playback captures PCM without hardware and can be interrupted", async () => {
  const playback = new FakeAudioPlayback({ autoComplete: false });
  const play = playback.play(PCM_16000, chunks([1, 0], [2, 0]));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(playback.active, true);
  assert.deepEqual(playback.plays[0].audio, Buffer.from([1, 0, 2, 0]));
  await playback.stop();
  assert.equal((await play).reason, "stopped");
  assert.equal(playback.active, false);
  assert.deepEqual(await playback.dispose(), { ok: true, alreadyDisposed: false });
});
