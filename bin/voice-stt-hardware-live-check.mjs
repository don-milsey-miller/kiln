#!/usr/bin/env node
import { FfmpegAudioCapture } from "../lib/voice/audio/ffmpeg-capture.mjs";
import { resolveVoiceConfig, VOICE_ENV } from "../lib/voice/config.mjs";
import { createElevenLabsSttProviderFromConfig } from "../lib/voice/stt/elevenlabs.mjs";

const enabled = process.env.KILN_VOICE_LIVE_TEST === "1" && process.env.KILN_VOICE_HARDWARE_TEST === "1";
if (!enabled) {
  console.error("Refusing live microphone transcription: set KILN_VOICE_LIVE_TEST=1 and KILN_VOICE_HARDWARE_TEST=1 explicitly.");
  process.exitCode = 2;
} else {
  const config = resolveVoiceConfig(process.env);
  if (!config.credentialPresent) {
    console.error(`Live microphone transcription requires ${VOICE_ENV.elevenLabsApiKey}.`);
    process.exitCode = 2;
  } else {
    const capture = new FfmpegAudioCapture({
      device: config.audio.inputDevice,
      maxRecordingMs: 5_000,
    });
    const provider = createElevenLabsSttProviderFromConfig(config);
    let session;
    try {
      let resolveFinal;
      let rejectFinal;
      const final = new Promise((resolve, reject) => {
        resolveFinal = resolve;
        rejectFinal = reject;
      });
      void final.catch(() => {});
      session = await provider.start({
        format: capture.format,
        onFinal: ({ text, retention }) => resolveFinal({ text, retention }),
        onError: rejectFinal,
        onWarning: ({ message }) => console.warn(message),
      });
      console.log("Speak a short test phrase now. Capture ends after five seconds; no audio is saved.");
      const recording = await capture.start();
      for await (const chunk of recording.stream) session.write(chunk);
      const captured = await recording.done;
      if (!captured.ok) throw captured.error;
      session.finish();
      let finalTimer;
      const deadline = new Promise((_, reject) => {
        finalTimer = setTimeout(() => reject(Object.assign(new Error(), { code: "stt-final-timeout" })), 20_000);
      });
      let result;
      try {
        result = await Promise.race([final, deadline]);
      } finally {
        clearTimeout(finalTimer);
      }
      console.log(`Committed transcript: ${result.text}`);
      console.log(`Provider retention status: ${result.retention ?? session.retention ?? "unknown"}`);
    } catch (error) {
      console.error(`Live microphone transcription failed (${error?.code ?? "voice-operation-failed"}).`);
      process.exitCode = 1;
    } finally {
      try { session?.close(); } catch {}
      await capture.dispose();
      await provider.dispose();
    }
  }
}
