/**
 * The task-binding frame and observer — TSK-0053 (D42, D45), toward ACC-0076.
 *
 * ⚠️ **THE TWO-REQUEST CASE IS THE POINT OF THIS FILE.** A child that noticed it was being checked would
 * send a first request without the task and a second one with it. The latch closes on the first
 * invocation whichever way it went, so the second can never repair the first.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import {
  ATTESTATION_VERSION,
  ATTEST_FAILURE,
  BINDING_REJECTED,
  findFramedBody,
  frameTask,
  judgeAttestation,
  payloadTexts,
} from "../lib/specialists/task-frame.mjs";
import { FD_ENV, NONCE_ENV, createTaskObserver } from "../lib/specialists/task-observer.mjs";

const NONCE = "00fece891dbd4927";
const TASK = "Summarise what the port office needs from nightly dock-fee reconciliation.";
const digestOf = (text) => createHash("sha256").update(text, "utf8").digest("hex");
const framed = () => frameTask({ nonce: NONCE, task: TASK, digestOf });

/** A provider payload in the shape the pinned Pi hands the hook, carrying `text` as the user message. */
const payloadWith = (text) => ({
  model: "loopback-model",
  messages: [
    { role: "system", content: "You are a specialist." },
    { role: "user", content: [{ type: "text", text }] },
  ],
  stream: true,
  tools: [],
});

/** An observer with a scripted environment and a captured sink. */
function observer({ nonce = NONCE } = {}) {
  const lines = [];
  const it = createTaskObserver({ env: { [NONCE_ENV]: nonce, [FD_ENV]: "3" }, emit: (line) => lines.push(line) });
  return { it, lines, attestations: () => lines.map((l) => JSON.parse(l)) };
}

/* ============================================================== the frame ===================== */

test("⚠️ a framed task carries its nonce, its measured length and its digest, and is found again", () => {
  const f = framed();
  assert.equal(f.units, TASK.length);
  assert.equal(f.sha256, digestOf(TASK));
  assert.ok(f.text.includes(`nonce=${NONCE}`));
  assert.ok(f.text.includes(TASK));

  assert.equal(findFramedBody([f.text], NONCE), TASK, "the body did not survive a round trip");
  assert.equal(findFramedBody([f.text], "ffffffffffffffff"), null, "another delegation's nonce found this frame");
  assert.equal(findFramedBody(["no frame here"], NONCE), null);
  assert.equal(findFramedBody([], NONCE), null);
  assert.equal(findFramedBody([f.text], "not-hex"), null, "a malformed nonce was accepted");
});

test("⚠️ the frame refuses a weak nonce or an empty task rather than producing one", () => {
  for (const nonce of ["", "abc", "NOTHEX0000000000", "0123456789abcde"])
    assert.throws(() => frameTask({ nonce, task: TASK, digestOf }), TypeError, nonce);
  assert.throws(() => frameTask({ nonce: NONCE, task: "", digestOf }), TypeError);
});

test("⚠️ the payload is read structurally, so JSON escaping cannot hide the frame", () => {
  // ⚠️ A SPIKE VERSION SEARCHED THE SERIALISED PAYLOAD AND SILENTLY NEVER MATCHED: JSON escapes a
  // newline as two characters, so the frame's own line breaks were not there to find.
  const f = framed();
  const payload = payloadWith(f.text);
  assert.equal(JSON.stringify(payload).includes(`${TASK}\n`), false, "the serialised form still holds a real newline");
  assert.equal(findFramedBody(payloadTexts(payload), NONCE), TASK);

  // Both content shapes the pinned runtime uses, plus a system string.
  assert.deepEqual(payloadTexts({ messages: [{ role: "user", content: "plain" }] }), ["plain"]);
  assert.deepEqual(payloadTexts({ messages: [], system: "sys" }), ["sys"]);
  for (const junk of [null, undefined, "text", 7, { messages: "not a list" }]) assert.deepEqual(payloadTexts(junk), []);
});

/* ============================================================== the observer ================== */

test("⚠️ D45 the first request carrying the frame is attested, with measured values", () => {
  const f = framed();
  const o = observer();
  o.it.observe({ payload: payloadWith(f.text) });

  assert.equal(o.lines.length, 1, "exactly one attestation");
  assert.deepEqual(o.attestations()[0], { v: ATTESTATION_VERSION, ok: true, nonce: NONCE, units: f.units, sha256: f.sha256 });
  assert.deepEqual(judgeAttestation(o.attestations()[0], f), { taskBindingObserved: true, reason: null });
});

test("⚠️ D45 request one without the frame and request two with it leaves the binding false", () => {
  // ⚠️ **THE CASE THIS PROTOCOL EXISTS FOR.** A child that noticed it was being checked would omit the
  // task from the request it is measured on and supply it afterwards. The latch closed on the first
  // invocation, so the second is never observed and the attestation still says no frame.
  const f = framed();
  const o = observer();

  o.it.observe({ payload: payloadWith("Just answer helpfully.") });
  assert.equal(o.it.latched, true, "the latch did not close on a failed first observation");

  o.it.observe({ payload: payloadWith(f.text) });
  o.it.observe({ payload: payloadWith(f.text) });

  assert.equal(o.lines.length, 1, "a later request produced a second attestation");
  assert.deepEqual(o.attestations()[0], { v: ATTESTATION_VERSION, ok: false, reason: ATTEST_FAILURE.NO_FRAME });

  const judged = judgeAttestation(o.attestations()[0], f);
  assert.equal(judged.taskBindingObserved, false);
  assert.equal(judged.reason, BINDING_REJECTED.ABSENT);
  assert.equal(judged.detail, ATTEST_FAILURE.NO_FRAME, "the parent keeps why, without it becoming a public code");
});

test("⚠️ D45 the latch also closes on a successful first observation", () => {
  const f = framed();
  const o = observer();
  o.it.observe({ payload: payloadWith(f.text) });
  o.it.observe({ payload: payloadWith(f.text) });
  assert.equal(o.lines.length, 1, "a second request was attested as well");
});

test("⚠️ D45 an observer with no nonce attests a failure rather than staying silent", () => {
  const o = observer({ nonce: "" });
  o.it.observe({ payload: payloadWith(framed().text) });
  assert.deepEqual(o.attestations()[0], { v: ATTESTATION_VERSION, ok: false, reason: ATTEST_FAILURE.NO_NONCE });
  assert.equal(o.it.latched, true);
});

test("⚠️ an attestation carries no task text, no payload and no path", () => {
  const f = framed();
  for (const o of [observer(), observer({ nonce: "" })]) {
    o.it.observe({ payload: { ...payloadWith(f.text), apiKey: "sk-ant-PLANTED-TASKBINDING", baseUrl: "https://example.invalid/v1" } });
    const line = o.lines.join("");
    assert.equal(line.includes("port office"), false, "the task text reached the attestation");
    assert.equal(line.includes("sk-ant-PLANTED-TASKBINDING"), false, "a credential reached the attestation");
    assert.equal(line.includes("example.invalid"), false, "a provider address reached the attestation");
    assert.equal(/[A-Za-z]:[\\/]/.test(line), false, "a drive-lettered path reached the attestation");
    assert.equal(/\/(home|Users)\//.test(line), false, "a home directory reached the attestation");
  }
});

/* ============================================================== the parent's judgement ======== */

test("⚠️ only all three fields agreeing is a binding", () => {
  const f = framed();
  const good = { v: ATTESTATION_VERSION, ok: true, nonce: NONCE, units: f.units, sha256: f.sha256 };
  assert.equal(judgeAttestation(good, f).taskBindingObserved, true);

  const cases = [
    [null, BINDING_REJECTED.ABSENT],
    [undefined, BINDING_REJECTED.ABSENT],
    ["an attestation", BINDING_REJECTED.MALFORMED],
    [[good], BINDING_REJECTED.MALFORMED],
    [{ ...good, ok: false, reason: ATTEST_FAILURE.NO_FRAME }, BINDING_REJECTED.ABSENT],
    [{ ...good, v: 2 }, BINDING_REJECTED.VERSION],
    [{ ...good, nonce: "ffffffffffffffff" }, BINDING_REJECTED.NONCE],
    [{ ...good, units: f.units - 1 }, BINDING_REJECTED.UNITS],
    [{ ...good, units: "74" }, BINDING_REJECTED.UNITS],
    [{ ...good, sha256: digestOf("something else") }, BINDING_REJECTED.DIGEST],
    [{ ...good, sha256: "not-a-digest" }, BINDING_REJECTED.DIGEST],
  ];
  for (const [attestation, reason] of cases) assert.equal(judgeAttestation(attestation, f).reason, reason, JSON.stringify(attestation));
});

test("⚠️ a same-length edit is caught by the digest, and a truncation by the length", () => {
  // Two controls, because either check alone leaves one of these through.
  const f = framed();
  const sameLength = TASK.replace("port office", "port offico");
  assert.equal(sameLength.length, TASK.length, "the control is not same-length");

  const o = observer();
  o.it.observe({ payload: payloadWith(frameTask({ nonce: NONCE, task: sameLength, digestOf }).text) });
  assert.equal(judgeAttestation(o.attestations()[0], f).reason, BINDING_REJECTED.DIGEST);

  const shorter = observer();
  shorter.it.observe({ payload: payloadWith(frameTask({ nonce: NONCE, task: TASK.slice(0, 20), digestOf }).text) });
  assert.equal(judgeAttestation(shorter.attestations()[0], f).reason, BINDING_REJECTED.UNITS);
});

test("⚠️ the observer measures the body rather than echoing the header's claim about it", () => {
  // ⚠️ A HEADER-ECHOING OBSERVER WOULD ATTEST A TAMPERED BODY AS READILY AS A TRUE ONE. The frame here
  // states the length and digest of the ORIGINAL task while carrying a different body.
  const f = framed();
  const lying = f.text.replace(TASK, "A different task entirely, of another length.");
  const o = observer();
  o.it.observe({ payload: payloadWith(lying) });

  const attested = o.attestations()[0];
  assert.equal(attested.ok, true, "the frame was still found");
  assert.notEqual(attested.sha256, f.sha256, "the observer echoed the header's digest");
  assert.notEqual(attested.units, f.units, "the observer echoed the header's length");
  assert.equal(judgeAttestation(attested, f).taskBindingObserved, false);
});
