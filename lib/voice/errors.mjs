/** Stable voice-layer failures. Provider and device details must be translated into these codes. */
export const VOICE_ERROR_CODES = Object.freeze({
  CONTRACT: "voice-contract-invalid",
  DEPENDENCY: "voice-dependency-unavailable",
  DISPOSED: "voice-controller-disposed",
  OPERATION: "voice-operation-failed",
  TRANSITION: "voice-transition-invalid",
});

/**
 * A bounded voice failure. `details` is deliberately caller-authored: raw provider errors can carry
 * credentials, device paths, or request payloads and therefore never become part of the message.
 */
export class VoiceError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "VoiceError";
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

/** The deterministic refusal returned for an illegal state transition. */
export class VoiceTransitionError extends VoiceError {
  constructor(from, action, allowed) {
    super(
      VOICE_ERROR_CODES.TRANSITION,
      `Voice action ${JSON.stringify(action)} is not allowed while the controller is ${JSON.stringify(from)}.`,
      { from, action, allowed: [...allowed] }
    );
    this.name = "VoiceTransitionError";
  }
}

/** A contract failure that names the boundary, never a secret-bearing value. */
export class VoiceContractError extends VoiceError {
  constructor(boundary, missing) {
    super(
      VOICE_ERROR_CODES.CONTRACT,
      `The ${boundary} implementation does not satisfy the voice contract.`,
      { boundary, missing: [...missing] }
    );
    this.name = "VoiceContractError";
  }
}

/** Translate an arbitrary implementation failure without copying its message. */
export function voiceOperationError(operation, error) {
  if (error instanceof VoiceError) return error;
  return new VoiceError(VOICE_ERROR_CODES.OPERATION, `The voice ${operation} operation failed.`, {
    operation,
    causeCode: typeof error?.code === "string" ? error.code : null,
  });
}
