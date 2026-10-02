import { VoiceContractError } from "../errors.mjs";

/** Provider-neutral synthesis boundary. Providers receive prepared speech text, never Pi messages. */
export const TTS_PROVIDER_METHODS = Object.freeze(["synthesize", "dispose"]);

export function assertTtsProvider(value) {
  const missing = TTS_PROVIDER_METHODS.filter((name) => typeof value?.[name] !== "function");
  if (missing.length > 0) throw new VoiceContractError("TtsProvider", missing);
  return value;
}
