/**
 * The delegated task's frame, and how it is found again — TSK-0053 (D42, D45).
 *
 * A parent frames the task with a one-time nonce, the body's UTF-16 code-unit length and its digest.
 * An observer loaded into the child finds that frame in the child's FIRST outbound provider request and
 * attests what it measured there. The parent then compares the attestation with what it generated.
 *
 * ⚠️ **ONE DESCRIPTION OF THE FORMAT, USED BY BOTH SIDES.** The parent builds the frame and the observer
 * reads it, and a second spelling on either side would drift the first time the markers changed - the
 * same reason the stage-document format has exactly one writer and one parser.
 *
 * ⚠️ **THE OBSERVER MEASURES; IT NEVER ECHOES.** The header carries the length and the digest so a reader
 * can see them, but an observer that copied them into its attestation would attest a tampered body as
 * readily as a true one. `findFramedBody` returns the BODY, and the caller measures it.
 *
 * ⚠️ **THE PAYLOAD IS READ STRUCTURALLY, NOT SEARCHED AS A BLOB.** A spike version stringified the whole
 * provider payload and looked for the frame in it, which silently never matched: JSON escapes a newline
 * as two characters, so the frame's own line breaks were not there to find. `payloadTexts` walks the
 * messages and returns the text the model is about to receive, in the form it will receive it.
 */

export const ATTESTATION_VERSION = 1;

/** Why no binding was attested. Internal detail; the public wire code stays `task-not-delivered`. */
export const ATTEST_FAILURE = Object.freeze({
  NO_FRAME: "frame-absent-from-first-request",
  NO_NONCE: "observer-has-no-nonce",
  UNREADABLE: "first-request-unreadable",
  NOT_REACHED: "observation-not-reached",
});

/** Why the parent rejected an attestation it did receive. */
export const BINDING_REJECTED = Object.freeze({
  ABSENT: "no-attestation",
  MALFORMED: "attestation-malformed",
  VERSION: "attestation-version-unknown",
  NONCE: "nonce-mismatch",
  UNITS: "length-mismatch",
  DIGEST: "digest-mismatch",
});

const NONCE_PATTERN = /^[0-9a-f]{16,64}$/;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;

const openMarker = (nonce) => `<<<KILN-TASK nonce=${nonce} `;
const closeMarker = (nonce) => `<<<KILN-TASK-END nonce=${nonce}>>>`;

/**
 * The framed task, and what the parent must later see attested.
 *
 * @param {{nonce: string, task: string, digestOf: (text: string) => string}} spec
 */
export function frameTask({ nonce, task, digestOf }) {
  if (!NONCE_PATTERN.test(nonce ?? "")) throw new TypeError("A task frame needs a lowercase hex nonce of at least 16 characters.");
  if (typeof task !== "string" || task.length === 0) throw new TypeError("A task frame needs a non-empty task.");

  const units = task.length;
  const sha256 = digestOf(task);
  return {
    nonce,
    units,
    sha256,
    text: [`${openMarker(nonce)}units=${units} sha256=${sha256}>>>`, task, closeMarker(nonce)].join("\n"),
  };
}

/** Every text the payload would actually send to the model, as text. */
export function payloadTexts(payload) {
  const out = [];
  const take = (content) => {
    if (typeof content === "string") out.push(content);
    else if (Array.isArray(content))
      for (const part of content) {
        if (typeof part === "string") out.push(part);
        else if (part && typeof part.text === "string") out.push(part.text);
      }
  };
  if (payload && typeof payload === "object") {
    for (const message of Array.isArray(payload.messages) ? payload.messages : []) {
      if (!message || typeof message !== "object") continue;
      take(message.content);
      if (typeof message.text === "string") out.push(message.text);
    }
    if (typeof payload.system === "string") out.push(payload.system);
    else take(payload.system);
  }
  return out;
}

/** The framed body carried by one of those texts, or null. */
export function findFramedBody(texts, nonce) {
  if (!NONCE_PATTERN.test(nonce ?? "")) return null;
  const head = openMarker(nonce);
  const tail = `\n${closeMarker(nonce)}`;
  for (const text of Array.isArray(texts) ? texts : []) {
    if (typeof text !== "string") continue;
    const at = text.indexOf(head);
    if (at < 0) continue;
    const headerEnd = text.indexOf(">>>\n", at);
    if (headerEnd < 0) continue;
    const start = headerEnd + 4;
    const end = text.indexOf(tail, start);
    if (end < 0) continue;
    return text.slice(start, end);
  }
  return null;
}

/**
 * The parent's judgement on an attestation.
 *
 * ⚠️ **ALL THREE FIELDS, OR NO BINDING.** The nonce proves it is this delegation's frame, the length and
 * the digest together prove the body was the one sent. A same-length edit is caught by the digest and a
 * truncation by the length, and both controls are exercised.
 *
 * @param {object|null} attestation
 * @param {{nonce: string, units: number, sha256: string}} expected
 */
export function judgeAttestation(attestation, expected) {
  if (attestation === null || attestation === undefined) return { taskBindingObserved: false, reason: BINDING_REJECTED.ABSENT };
  if (typeof attestation !== "object" || Array.isArray(attestation)) return { taskBindingObserved: false, reason: BINDING_REJECTED.MALFORMED };
  if (attestation.ok !== true) return { taskBindingObserved: false, reason: BINDING_REJECTED.ABSENT, detail: typeof attestation.reason === "string" ? attestation.reason : null };
  if (attestation.v !== ATTESTATION_VERSION) return { taskBindingObserved: false, reason: BINDING_REJECTED.VERSION };
  if (typeof attestation.nonce !== "string" || attestation.nonce !== expected.nonce) return { taskBindingObserved: false, reason: BINDING_REJECTED.NONCE };
  if (!Number.isInteger(attestation.units) || attestation.units !== expected.units) return { taskBindingObserved: false, reason: BINDING_REJECTED.UNITS };
  if (typeof attestation.sha256 !== "string" || !DIGEST_PATTERN.test(attestation.sha256) || attestation.sha256 !== expected.sha256)
    return { taskBindingObserved: false, reason: BINDING_REJECTED.DIGEST };
  return { taskBindingObserved: true, reason: null };
}
