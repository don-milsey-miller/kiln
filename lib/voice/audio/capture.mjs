import { VoiceContractError } from "../errors.mjs";

/**
 * AudioCapture contract.
 *
 * Production implementations acquire the microphone only from `start`, emit provider-neutral audio
 * chunks through `onChunk`, and release every handle from both `stop` and `dispose`. Construction
 * itself must be inert so dependency injection never acquires hardware accidentally.
 */
export const AUDIO_CAPTURE_METHODS = Object.freeze(["start", "stop", "dispose"]);

export function assertAudioCapture(value) {
  const missing = AUDIO_CAPTURE_METHODS.filter((name) => typeof value?.[name] !== "function");
  if (missing.length > 0) throw new VoiceContractError("AudioCapture", missing);
  return value;
}
