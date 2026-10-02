#!/usr/bin/env node

import { FfmpegAudioCapture } from "../lib/voice/audio/ffmpeg-capture.mjs";
import { VOICE_ENV } from "../lib/voice/config.mjs";

if (process.env.KILN_VOICE_HARDWARE_TEST !== "1") {
  console.error("Refusing to acquire the microphone. Set KILN_VOICE_HARDWARE_TEST=1 to run this explicit local check.");
  process.exitCode = 2;
} else {
  const durationMs = 3_000;
  const capture = new FfmpegAudioCapture({
    device: process.env[VOICE_ENV.inputDevice] || null,
    maxRecordingMs: durationMs,
  });
  try {
    const session = await capture.start();
    let bytes = 0;
    let peak = 0;
    for await (const chunk of session.stream) {
      bytes += chunk.length;
      for (let offset = 0; offset + 1 < chunk.length; offset += 2) {
        peak = Math.max(peak, Math.abs(chunk.readInt16LE(offset)));
      }
    }
    const result = await session.done;
    if (!result.ok) throw result.error;
    console.log(`Voice capture OK: ${bytes} bytes of pcm_16000 received; peak=${peak}; no audio was stored.`);
  } catch (error) {
    console.error(`Voice capture failed (${error?.code ?? "audio-capture-failed"}).`);
    process.exitCode = 1;
  } finally {
    await capture.dispose();
  }
}

