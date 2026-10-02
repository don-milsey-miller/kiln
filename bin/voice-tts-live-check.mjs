#!/usr/bin/env node
import { resolveVoiceConfig, VOICE_ENV, voiceCredential } from "../lib/voice/config.mjs";
import { FfplayAudioPlayback } from "../lib/voice/audio/ffplay-playback.mjs";
import { ElevenLabsTtsProvider } from "../lib/voice/tts/elevenlabs.mjs";

if (process.env.KILN_VOICE_LIVE_TEST !== "1") {
  console.error("Refusing live synthesis: set KILN_VOICE_LIVE_TEST=1 explicitly.");
  process.exitCode = 2;
} else {
  const config = resolveVoiceConfig(process.env);
  const apiKey = voiceCredential(config, "elevenlabs");
  if (!apiKey || !config.tts.voiceId) {
    console.error(`Live synthesis requires ${VOICE_ENV.elevenLabsApiKey} and ${VOICE_ENV.ttsVoiceId}.`);
    process.exitCode = 2;
  } else {
    const provider = new ElevenLabsTtsProvider({
      apiKey,
      voiceId: config.tts.voiceId,
      model: config.tts.model,
      maxTextCharacters: config.limits.maxTtsCharacters,
    });
    let playback;
    try {
      const args = process.argv.slice(2);
      const play = args.includes("--play");
      const text = args.filter((arg) => arg !== "--play").join(" ").trim() || "Kiln voice synthesis is ready.";
      const result = await provider.synthesize(text);
      if (play) {
        playback = new FfplayAudioPlayback({ device: config.audio.outputDevice });
        await playback.play(result.format, result.audio);
      }
      console.log(`ElevenLabs returned ${result.audio.byteLength} bytes of ${result.format.encoding}; audio was not saved${play ? " and playback completed" : ""}.`);
    } finally {
      await playback?.dispose();
      await provider.dispose();
    }
  }
}
