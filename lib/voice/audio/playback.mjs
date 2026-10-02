import { VoiceContractError } from "../errors.mjs";

/**
 * AudioPlayback contract. Playback backends are constructed inertly and acquire speaker resources
 * only when `play` is called by an explicit voice-output operation.
 */
export const AUDIO_PLAYBACK_METHODS = Object.freeze(["play", "stop", "dispose"]);

export function assertAudioPlayback(value) {
  const missing = AUDIO_PLAYBACK_METHODS.filter((name) => typeof value?.[name] !== "function");
  if (missing.length > 0) throw new VoiceContractError("AudioPlayback", missing);
  return value;
}
