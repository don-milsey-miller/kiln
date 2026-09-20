/**
 * The task-binding observer, loaded explicitly into a specialist child — TSK-0053 (D42, D45).
 *
 * ⚠️ **IT REPORTS ON THE CHILD'S OUTBOUND REQUEST, NOT ON THE CHILD.** `before_provider_request` is the
 * last point before dispatch, so what it sees is what the model is actually about to be asked. Model
 * output and ordinary JSON events are the child's account of itself, which is the failure REQ-0026
 * exists to prevent; and writing or hashing the prompt file proves the parent PREPARED the task, not
 * that the child CONSUMED it.
 *
 * ⚠️ **THE FIRST REQUEST, AND ONLY THE FIRST (D45).** That is the request that must carry the delegated
 * task before the model can act on anything. The latch closes on the first invocation whether it
 * succeeded or failed, so a later request can never repair a missing or malformed first binding - which
 * is exactly what a child that noticed it was being checked would try to do.
 *
 * ⚠️ **THE PAYLOAD IS NEVER RETAINED OR RETURNED.** A success carries the version, the nonce, the
 * measured length and the measured digest. A failure carries the version and a stable reason. Never the
 * task text, never a credential, never a path.
 *
 * ⚠️ **MEASURED, NEVER ECHOED.** The frame header states the length and the digest; this reads the BODY
 * and computes them itself. An observer that copied the header's values would attest a tampered body.
 */

import { createHash } from "node:crypto";
import { writeSync } from "node:fs";

import { ATTESTATION_VERSION, ATTEST_FAILURE, findFramedBody, payloadTexts } from "./task-frame.mjs";
import { buildChildReport } from "./child-report.mjs";

export const NONCE_ENV = "KILN_TASK_NONCE";
export const FD_ENV = "KILN_ATTEST_FD";

/**
 * Build the observer. Exported separately from the default so a test can drive it with its own
 * environment and its own sink rather than a real file descriptor.
 *
 * @param {{env?: Record<string,string|undefined>, emit?: (line: string) => void}} [deps]
 */
export function createTaskObserver({ env = process.env, emit, pi = null, ctx = null } = {}) {
  const nonce = env[NONCE_ENV] ?? "";
  const fd = Number(env[FD_ENV] ?? "3");
  const write =
    emit ??
    ((line) => {
      try {
        writeSync(fd, line);
      } catch {
        // A closed pipe is the parent's to notice: no attestation arrives, so no binding is observed.
        // Retrying or reporting it into the transcript would put this side's account back in play.
      }
    });

  let latched = false;
  const send = (attestation) => {
    latched = true;
    write(`${JSON.stringify(attestation)}\n`);
  };

  /**
   * ⚠️ **A SECOND, TYPED LINE (D46).** What the child HELD is a different fact from whether the
   * task REACHED it, so the binding attestation stays exactly as it was and this rides the same fd
   * under its own type. Emitted once, on the same first hook: a later report would be a child
   * correcting its own account, and the parent refuses a duplicate for that reason.
   */
  const sendReport = () => write(`${JSON.stringify(buildChildReport({ pi, ctx }))}\n`);

  return {
    /** @param {{payload?: unknown}} event */
    observe(event) {
      if (latched) return;
      sendReport();

      if (nonce.length === 0) return send({ v: ATTESTATION_VERSION, ok: false, reason: ATTEST_FAILURE.NO_NONCE });

      let body;
      try {
        body = findFramedBody(payloadTexts(event?.payload), nonce);
      } catch {
        return send({ v: ATTESTATION_VERSION, ok: false, reason: ATTEST_FAILURE.UNREADABLE });
      }
      if (body === null) return send({ v: ATTESTATION_VERSION, ok: false, reason: ATTEST_FAILURE.NO_FRAME });

      return send({
        v: ATTESTATION_VERSION,
        ok: true,
        nonce,
        units: body.length,
        sha256: createHash("sha256").update(body, "utf8").digest("hex"),
      });
    },
    get latched() {
      return latched;
    },
  };
}

export default function register(pi) {
  let observer = null;
  pi?.on?.("before_provider_request", (event, ctx) => {
    // ⚠️ BUILT ON THE FIRST HOOK, because `ctx` is what carries the child's live selection and only a
    // hook invocation has one.
    observer ??= createTaskObserver({ pi, ctx });
    observer.observe(event);
    // ⚠️ NOTHING IS RETURNED. This hook may REPLACE the payload, and an observer that returned anything
    // would be editing the request it exists to watch.
  });
}
