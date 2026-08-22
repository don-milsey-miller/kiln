/**
 * A cancellable timeout signal.
 *
 * ⚠️ Replaces `AbortSignal.timeout(ms)`, which leaves a live timer behind after the request settles.
 * On Windows that surfaced as a libuv assertion printed AFTER a perfectly correct refusal:
 *
 *   Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\win\async.c, line 94
 *
 * ⚠️ Worth fixing rather than ignoring, for a reason beyond tidiness: **a crash printed after a
 * refusal makes a working refusal look like a failure.** The refusal path is the one clause 7a exists
 * to prove (#127), and a user cannot tell "declined correctly" from "blew up" when both appear.
 */

export function withTimeout(ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DOMException(`Timed out after ${ms}ms`, "TimeoutError")), ms);
  timer.unref?.(); // never hold the process open on our account
  return { signal: controller.signal, cancel: () => clearTimeout(timer) };
}
