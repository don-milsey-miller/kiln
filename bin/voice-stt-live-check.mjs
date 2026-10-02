#!/usr/bin/env node

import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";

import { PCM_16000 } from "../lib/voice/audio/ffmpeg-capture.mjs";
import { ElevenLabsSttProvider } from "../lib/voice/stt/elevenlabs.mjs";

const MAX_PCM_BYTES = 10 * 1024 * 1024;
const CHUNK_BYTES = 6_400;
const CHUNK_INTERVAL_MS = 200;
const FINAL_TIMEOUT_MS = 20_000;

function wait(ms) {
  return new Promise((resolveWait) => setTimeout(resolveWait, ms));
}

function timeout(ms, abort) {
  return new Promise((_, reject) => {
    const timer = setTimeout(() => {
      abort.abort();
      const error = new Error("No committed transcript arrived before the live-check deadline.");
      error.code = "stt-live-final-timeout";
      reject(error);
    }, ms);
    timer.unref?.();
  });
}

async function main() {
  if (process.env.KILN_VOICE_LIVE_TEST !== "1") {
    throw Object.assign(new Error("Set KILN_VOICE_LIVE_TEST=1 to authorize the opt-in network check."), {
      code: "stt-live-check-disabled",
    });
  }

  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (typeof apiKey !== "string" || apiKey.trim().length === 0) {
    throw Object.assign(new Error("ELEVENLABS_API_KEY is required for the live check."), {
      code: "stt-live-key-missing",
    });
  }
  const input = process.argv[2] ?? process.env.KILN_VOICE_LIVE_PCM;
  if (typeof input !== "string" || input.trim().length === 0) {
    throw Object.assign(new Error("Pass a headerless pcm_16000 file path to the live check."), {
      code: "stt-live-audio-missing",
    });
  }
  const path = resolve(input);
  const metadata = await stat(path);
  if (!metadata.isFile() || metadata.size < 2 || metadata.size > MAX_PCM_BYTES || metadata.size % 2 !== 0) {
    throw Object.assign(new Error("The live-check audio file is not bounded, sample-aligned pcm_16000."), {
      code: "stt-live-audio-invalid",
    });
  }
  const audio = await readFile(path);
  const abort = new AbortController();
  const provider = new ElevenLabsSttProvider({ apiKey, enableLogging: false });
  const warnings = [];
  let resolveFinal;
  let rejectFinal;
  const finalTranscript = new Promise((resolveTranscript, rejectTranscript) => {
    resolveFinal = resolveTranscript;
    rejectFinal = rejectTranscript;
  });
  let session;
  try {
    session = await provider.start({
      format: PCM_16000,
      signal: abort.signal,
      onFinal: ({ text }) => resolveFinal(text),
      onError: rejectFinal,
      onWarning: ({ code }) => warnings.push(code),
    });
    for (let offset = 0; offset < audio.byteLength; offset += CHUNK_BYTES) {
      session.write(audio.subarray(offset, Math.min(offset + CHUNK_BYTES, audio.byteLength)));
      if (offset + CHUNK_BYTES < audio.byteLength) await wait(CHUNK_INTERVAL_MS);
    }
    session.finish();
    const transcript = await Promise.race([finalTranscript, timeout(FINAL_TIMEOUT_MS, abort)]);
    if (typeof transcript !== "string" || transcript.trim().length === 0) {
      throw Object.assign(new Error("ElevenLabs committed an empty transcript."), { code: "stt-live-empty-transcript" });
    }
    console.log(JSON.stringify({
      ok: true,
      transcript: transcript.trim(),
      retention: session.retention,
      warnings,
    }));
  } finally {
    session?.close();
    abort.abort();
    await provider.dispose();
  }
}

main().catch((error) => {
  console.error(JSON.stringify({ ok: false, code: typeof error?.code === "string" ? error.code : "stt-live-check-failed" }));
  process.exitCode = 1;
});
