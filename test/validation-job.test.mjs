/**
 * 7b's first guard: a job is refused BEFORE anything is provisioned.
 *
 * ⚠️ Every test here runs against a pure function on purpose. If checking a job required a workspace,
 * the check could not happen before the workspace existed — and "refuse before provisioning" would
 * quietly become "refuse after provisioning, then clean up", which is a different and weaker promise.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { checkJob, JOB_REFUSED, DEFAULT_CEILING, TIER_1_BOUNDARY } from "../lib/validation/job.mjs";

const JOB = (over = {}) => ({
  tier: 1,
  commands: [["python", "-c", "print('hi')"]],
  timeoutMs: 30_000,
  maxOutputBytes: 100_000,
  capturePlan: { stdout: true, stderr: true, versions: ["python"] },
  expectedOutputs: [],
  requires: {},
  ...over,
});

test("a well-formed tier-1 job passes", () => {
  const out = checkJob(JOB());
  assert.equal(out.ok, true);
});

test("a string command is refused, not quoted", () => {
  const out = checkJob(JOB({ commands: ["python -c \"print('hi')\""] }));
  assert.equal(out.ok, false);
  assert.equal(out.reason, JOB_REFUSED.SHELL_STRING);
  // The message has to say why, because the fix is for the caller to restructure, not to escape.
  assert.match(out.detail, /argument array/);
});

test("the ceiling refuses a higher tier, and says whose decision that is", () => {
  for (const tier of [2, 3]) {
    const out = checkJob(JOB({ tier }));
    assert.equal(out.ok, false, `tier ${tier}`);
    assert.equal(out.reason, JOB_REFUSED.ABOVE_CEILING);
    assert.match(out.detail, /PM's decision/);
  }
  // ...and it passes when the ceiling is actually raised, so the check reads the ceiling rather
  // than hard-coding tier 1.
  assert.equal(checkJob(JOB({ tier: 2 }), { ...DEFAULT_CEILING, maxTier: 2 }).ok, true);
});

test("network, credentials and cost are each refused against the ceiling", () => {
  assert.equal(checkJob(JOB({ requires: { network: true } })).reason, JOB_REFUSED.ABOVE_CEILING);
  assert.equal(checkJob(JOB({ requires: { credentials: true } })).reason, JOB_REFUSED.ABOVE_CEILING);
  assert.equal(checkJob(JOB({ requires: { costUnits: 1 } })).reason, JOB_REFUSED.ABOVE_CEILING);
  assert.match(checkJob(JOB({ requires: { costUnits: 1 } })).detail, /REQ-0012/);
});

test("limits above the ceiling are refused", () => {
  assert.equal(checkJob(JOB({ timeoutMs: 999_999 })).reason, JOB_REFUSED.ABOVE_CEILING);
  assert.equal(checkJob(JOB({ maxOutputBytes: 9_999_999 })).reason, JOB_REFUSED.ABOVE_CEILING);
});

test("a missing capture plan is refused, because omissions must stay detectable", () => {
  const out = checkJob(JOB({ capturePlan: undefined }));
  assert.equal(out.reason, JOB_REFUSED.MALFORMED);
  assert.match(out.detail, /indistinguishable/);
});

test("a run with no timeout has no stopping condition", () => {
  assert.equal(checkJob(JOB({ timeoutMs: 0 })).reason, JOB_REFUSED.MALFORMED);
  assert.equal(checkJob(JOB({ timeoutMs: undefined })).reason, JOB_REFUSED.MALFORMED);
});

test("malformed shapes are refused rather than coerced", () => {
  assert.equal(checkJob(null).reason, JOB_REFUSED.MALFORMED);
  assert.equal(checkJob(JOB({ tier: "1" })).reason, JOB_REFUSED.MALFORMED);
  assert.equal(checkJob(JOB({ commands: [] })).reason, JOB_REFUSED.MALFORMED);
  assert.equal(checkJob(JOB({ commands: [[]] })).reason, JOB_REFUSED.MALFORMED);
  assert.equal(checkJob(JOB({ commands: [["python", ""]] })).reason, JOB_REFUSED.MALFORMED);
  assert.equal(checkJob(JOB({ expectedOutputs: undefined })).reason, JOB_REFUSED.MALFORMED);
});

test("tier 1's boundary is data, so it can reach an evidence record", () => {
  // ⚠️ A boundary stated only in a comment is one the reader of the evidence never sees. This is the
  // check that it stays machine-readable, since that is the only version that can be carried forward.
  assert.deepEqual(TIER_1_BOUNDARY.doesNotClaim, [
    "containment-of-hostile-code",
    "host-filesystem-denial",
    "network-isolation",
  ]);
  assert.equal(TIER_1_BOUNDARY.supplies.credentials, false);
  assert.match(TIER_1_BOUNDARY.statement, /not an OS security sandbox/);
});
