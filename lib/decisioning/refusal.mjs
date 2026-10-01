/** Structured decisioning refusals. A caller must be able to fall back without parsing prose. */

export const DECISIONING_UNAVAILABLE = Object.freeze({
  NO_CREDENTIAL: "no-credential",
  AUTH_FAILED: "auth-failed",
  PERMISSION_DENIED: "permission-denied",
  RATE_LIMITED: "rate-limited",
  BACKEND_UNREACHABLE: "backend-unreachable",
  INVALID_RESPONSE: "invalid-response",
  NOT_CONFIGURED: "not-configured",
});

const KNOWN = new Set(Object.values(DECISIONING_UNAVAILABLE));

export function decisioningUnavailable(reason, detail, extra = {}) {
  if (!KNOWN.has(reason)) throw new TypeError(`Unknown decisioning unavailable reason: ${reason}`);
  return {
    ok: false,
    kind: "capability-unavailable",
    reason,
    detail,
    fallback: "Use Kiln's existing deterministic state and Pi reasoning path.",
    ...extra,
  };
}

export function invalidDecisioningInput(detail) {
  return {
    ok: false,
    kind: "invalid-input",
    reason: "invalid-input",
    detail,
    fallback: "Correct the request before retrying; no decision was made.",
  };
}

export const isDecisioningUnavailable = (value) =>
  value?.ok === false && value.kind === "capability-unavailable";
