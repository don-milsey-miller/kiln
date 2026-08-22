/**
 * 7c — specialist contracts, against the PM's eight decisive checks.
 *
 * ⚠️ The credential tests spawn REAL child processes and ask them what they can read. A test that
 * only inspected `childEnv`'s return value would prove the function builds an object; it would not
 * prove a child cannot reach the credential — and "the planning child cannot read the key" is a claim
 * about a process, not about a dictionary.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

import { contractFor, childEnv, verifyChild, mayWrite, signaturesMatch, ROLES, CHILD_REFUSED } from "../lib/specialists/contract.mjs";
import { RESEARCH_TOOL_SIGNATURES } from "../lib/research/tools.mjs";
import { VALIDATION_TOOL_SIGNATURES } from "../lib/validation/tools.mjs";

const KEY = "tvly-SECRET-only-research-may-see";
const HOST = { PATH: process.env.PATH, TEMP: process.env.TEMP, TAVILY_API_KEY: KEY, AWS_SECRET_ACCESS_KEY: "aws-secret" };

/** Ask a real child what it can see. Returns whatever it prints. */
const askChild = (role) =>
  execFileSync(process.execPath, ["-e", "process.stdout.write(JSON.stringify({tavily: process.env.TAVILY_API_KEY ?? null, aws: process.env.AWS_SECRET_ACCESS_KEY ?? null, keys: Object.keys(process.env).length}))"], {
    env: childEnv(role, HOST),
    encoding: "utf-8",
  });

/* ------------------------------------------- 1: contracts derive from measured signatures */

test("a contract REFERENCES the measured signature; it does not copy it", () => {
  const c = contractFor("research");
  for (const name of ["research_capability", "research_search", "research_fetch"])
    assert.equal(c.toolSignatures[name], RESEARCH_TOOL_SIGNATURES[name], `${name} must be the same object, not a copy`);
  const v = contractFor("validation");
  assert.equal(v.toolSignatures.validation_run, VALIDATION_TOOL_SIGNATURES.validation_run);
});

test("every named capability has a measured signature behind it", () => {
  // ⚠️ This test exists because the first validation contract failed it: it required
  // `validation_controller`, a name with no signature anywhere, so the signature check would have
  // compared the child against an empty object and passed. A verification that cannot fail is not one.
  for (const role of ROLES) {
    const c = contractFor(role);
    assert.deepEqual(c.undefinedCapabilities, [], `${role} names a capability nothing defines`);
    assert.deepEqual(Object.keys(c.toolSignatures).sort(), [...c.requiredCapabilities].sort(), role);
  }
});

test("a contract reports writes it cannot perform rather than hiding them", () => {
  for (const role of ROLES) {
    const c = contractFor(role);
    assert.deepEqual(c.unimplemented, [], `${role} claims a create it has no typed tool for`);
    assert.deepEqual(c.unknownMutations, [], `${role} claims a mutation that does not exist`);
  }
});

/* ------------------------------ 2, 3: stdin, timeout and capability checked before acceptance */

const REPORTED = () => ({
  research_capability: RESEARCH_TOOL_SIGNATURES.research_capability,
  research_search: RESEARCH_TOOL_SIGNATURES.research_search,
  research_fetch: RESEARCH_TOOL_SIGNATURES.research_fetch,
});

test("output is accepted only after stdin, timeout and capability all pass", () => {
  const c = contractFor("research");
  const ok = verifyChild(c, { stdinDelivered: true, timedOut: false, reportedTools: REPORTED(), output: "x" });
  assert.equal(ok.accepted, true);

  assert.equal(verifyChild(c, { stdinDelivered: false, timedOut: false, reportedTools: REPORTED() }).reason, CHILD_REFUSED.NO_STDIN);
  assert.equal(verifyChild(c, { stdinDelivered: true, timedOut: true, reportedTools: REPORTED() }).reason, CHILD_REFUSED.TIMED_OUT);
  const { research_search, ...missing } = REPORTED();
  assert.equal(verifyChild(c, { stdinDelivered: true, timedOut: false, reportedTools: missing }).reason, CHILD_REFUSED.CAPABILITY_MISSING);
});

test("every refusal is structured, and none carries the output through", () => {
  const c = contractFor("research");
  for (const run of [
    { stdinDelivered: false, timedOut: false, reportedTools: REPORTED(), output: "plausible prose" },
    { stdinDelivered: true, timedOut: true, reportedTools: REPORTED(), output: "plausible prose" },
    { stdinDelivered: true, timedOut: false, reportedTools: {}, output: "plausible prose" },
  ]) {
    const r = verifyChild(c, run);
    assert.equal(r.accepted, false);
    assert.ok(r.reason && r.detail, "a refusal must say which check failed and why");
    // ⚠️ The output is not passed through on any refusal path. A refusal that still hands back the
    // text is an invitation to use it, which is the fallback-to-prose failure wearing a warning label.
    assert.equal("output" in r, false);
  }
});

/* ------------------------------------- 7: a changed signature falsifies the contract check */

test("a changed or removed signature is a mismatch, not a pass", () => {
  const c = contractFor("research");

  const renamed = REPORTED();
  renamed.research_search = { ...RESEARCH_TOOL_SIGNATURES.research_search, input: { type: "object", properties: { q: {} }, required: ["q"] } };
  assert.equal(verifyChild(c, { stdinDelivered: true, timedOut: false, reportedTools: renamed }).reason, CHILD_REFUSED.SIGNATURE_MISMATCH);

  const relaxed = REPORTED();
  relaxed.research_search = { ...RESEARCH_TOOL_SIGNATURES.research_search, input: { type: "object", properties: { query: {}, maxResults: {} }, required: [] } };
  assert.equal(
    verifyChild(c, { stdinDelivered: true, timedOut: false, reportedTools: relaxed }).reason,
    CHILD_REFUSED.SIGNATURE_MISMATCH,
    "dropping a REQUIRED field is a signature change even though the properties still match"
  );

  assert.equal(signaturesMatch(RESEARCH_TOOL_SIGNATURES.research_fetch, RESEARCH_TOOL_SIGNATURES.research_fetch), true);
  assert.equal(signaturesMatch(RESEARCH_TOOL_SIGNATURES.research_fetch, undefined), false);
});

/* ------------------------------------------- 4, 5: the credential reaches only the research child */

test("only the research child receives TAVILY_API_KEY — asked of real processes", () => {
  const research = JSON.parse(askChild("research"));
  assert.equal(research.tavily, KEY, "the research child needs it");

  for (const role of ["planning", "validation"]) {
    const seen = JSON.parse(askChild(role));
    assert.equal(seen.tavily, null, `the ${role} child must not be able to read the credential`);
  }
});

test("no child inherits unrelated secrets from the host", () => {
  // ⚠️ The allowlist is the boundary, so a secret nobody named is absent everywhere — including from
  // the research child, which is allowed ONE credential and not "credentials".
  for (const role of ROLES) {
    const seen = JSON.parse(askChild(role));
    assert.equal(seen.aws, null, `${role} inherited AWS_SECRET_ACCESS_KEY`);
    assert.ok(seen.keys < 20, `${role} child has ${seen.keys} env vars — that looks like an inherited environment`);
  }
});

/* ------------------------------------------------ 6: tool allowlists enforce the write boundary */

test("each role may write only within its boundary", () => {
  const research = contractFor("research");
  const planning = contractFor("planning");
  const validation = contractFor("validation");

  assert.equal(mayWrite(research, { create: "evidence" }), true);
  assert.equal(mayWrite(research, { create: "requirement" }), false, "research does not author requirements");
  assert.equal(mayWrite(research, { create: "decision" }), false, "research does not decide");

  assert.equal(mayWrite(validation, { create: "evidence" }), true);
  assert.equal(mayWrite(validation, { create: "assertion" }), false, "validation observes; it does not claim");
  assert.equal(mayWrite(validation, { mutate: "reviseArtifact" }), false);

  assert.equal(mayWrite(planning, { create: "requirement" }), true);
  assert.equal(mayWrite(planning, { create: "evidence" }), false, "planning does not manufacture observations");
});

test("the forbidden list names the failure each role is most likely to commit", () => {
  assert.ok(contractFor("research").forbidden.some((f) => /model memory/.test(f)));
  for (const role of ["research", "validation"])
    assert.ok(contractFor(role).forbidden.some((f) => /requirements or decisions/.test(f)), role);
  for (const role of ROLES) assert.ok(contractFor(role).forbidden.includes("shell execution"), role);
});
