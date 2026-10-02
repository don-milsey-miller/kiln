import { VoiceContractError } from "../errors.mjs";

/**
 * Provider-neutral streaming STT boundary. `start` creates a session only after operator action;
 * provider protocol messages must be translated into partial/final callbacks by the adapter.
 */
export const STT_PROVIDER_METHODS = Object.freeze(["start", "dispose"]);
export const STT_SESSION_METHODS = Object.freeze(["write", "finish", "close"]);

export function assertSttProvider(value) {
  const missing = STT_PROVIDER_METHODS.filter((name) => typeof value?.[name] !== "function");
  if (missing.length > 0) throw new VoiceContractError("SttProvider", missing);
  return value;
}

export function assertSttSession(value) {
  const missing = STT_SESSION_METHODS.filter((name) => typeof value?.[name] !== "function");
  if (missing.length > 0) throw new VoiceContractError("SttSession", missing);
  return value;
}
