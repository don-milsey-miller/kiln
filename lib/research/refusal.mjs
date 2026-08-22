/**
 * The structured refusal — #124's load-bearing clause, given one shape so every path uses it.
 *
 * DEC-0004: *"If search or retrieval is unavailable the specialist returns a structured capability
 * refusal and records the gap, and MUST NOT answer from model memory."* A refusal that is merely a
 * thrown string would be summarised into prose by the first caller that caught it, which is the
 * failure this exists to prevent — so a refusal is DATA, with a reason a machine can switch on.
 *
 * ⚠️ **Two kinds, kept apart on purpose.** A capability that is unavailable and a request the
 * boundary refused are different facts about different things: the first says the specialist cannot
 * work at all and a gap must be recorded, the second says this one URL was out of bounds while the
 * capability is fine. Collapsing them would let a blocked link read as "research is down" — the same
 * class of error as #123's claim-relative judgements stored where only one copy exists.
 */

/** The capability itself cannot be used. Record a gap; do not answer from memory. */
export const UNAVAILABLE = {
  NO_CREDENTIAL: "no-credential",
  AUTH_FAILED: "auth-failed",
  QUOTA_EXHAUSTED: "quota-exhausted",
  BACKEND_UNREACHABLE: "backend-unreachable",
  NOT_CONFIGURED: "not-configured",
};

/** The capability works; THIS request was out of bounds. */
export const REFUSED = {
  BLOCKED_SCHEME: "blocked-scheme",
  URL_CREDENTIALS: "url-credentials",
  PRIVATE_DESTINATION: "private-destination",
  UNRESOLVABLE_HOST: "unresolvable-host",
  TOO_MANY_REDIRECTS: "too-many-redirects",
  TOO_LARGE: "too-large",
  UNSUPPORTED_MEDIA_TYPE: "unsupported-media-type",
  HTTP_ERROR: "http-error",
  TIMEOUT: "timeout",
};

const UNAVAILABLE_VALUES = new Set(Object.values(UNAVAILABLE));
const REFUSED_VALUES = new Set(Object.values(REFUSED));

export function capabilityUnavailable(reason, detail, extra = {}) {
  if (!UNAVAILABLE_VALUES.has(reason)) throw new Error(`Unknown unavailable reason: ${reason}`);
  return { ok: false, kind: "capability-unavailable", reason, detail, ...extra };
}

export function requestRefused(reason, detail, extra = {}) {
  if (!REFUSED_VALUES.has(reason)) throw new Error(`Unknown refusal reason: ${reason}`);
  return { ok: false, kind: "request-refused", reason, detail, ...extra };
}

/**
 * True when the caller must record a gap rather than proceed. The specialist contract switches on
 * this, so it is one function rather than a condition each caller re-derives (#47's argument).
 */
export const mustRecordGap = (r) => r?.ok === false && r.kind === "capability-unavailable";
