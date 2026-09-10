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

import {
  AGENT_DIR_ENV,
  AGENT_SESSION_DIR_ENV,
  BASE_ENV,
  CHILD_REFUSED,
  ChildEnvRefusal,
  ENV_REFUSAL,
  OS_INJECTED_WIN32,
  ROLES,
  childEnv,
  contractFor,
  mayWrite,
  signaturesMatch,
  verifyChild,
} from "../lib/specialists/contract.mjs";
import { AUTH_SOURCE, resolveProviderCredentials, validateCustomDeclaration } from "../lib/pi-provider-credentials.mjs";
import { RESEARCH_TOOL_SIGNATURES } from "../lib/research/tools.mjs";
import { VALIDATION_TOOL_SIGNATURES } from "../lib/validation/tools.mjs";

const KEY = "tvly-SECRET-only-research-may-see";
const AGENT_DIR = "/kiln-test-agent-dir";

/**
 * A host environment carrying, deliberately, far more than any child may have: the base runtime, the
 * Pi locator, the research credential, FOUR different providers' credentials, and three sentinels
 * shaped like the things a naive implementation would match.
 *
 * ⚠️ **THE SENTINELS ARE NOT ALL `KILN_SENTINEL_*`, AND THAT IS ACC-0057'S WORDING.** It asks for
 * names "a naive implementation would match". A prefix nothing else uses is trivially excluded by any
 * implementation, including a broken one; `ACME_API_KEY` and `AWS_SECRET_ACCESS_KEY` are what a
 * pattern match on `_API_KEY` or `_SECRET` would sweep up.
 */
const SENTINELS = Object.freeze({
  ACME_API_KEY: "sentinel-acme-not-a-real-key",
  SOMETHING_TOKEN: "sentinel-token-not-a-real-token",
  AWS_SECRET_ACCESS_KEY: "sentinel-aws-not-a-real-secret",
});

const OTHER_PROVIDER_KEYS = Object.freeze({
  OPENAI_API_KEY: "sk-openai-not-for-this-run",
  GEMINI_API_KEY: "gemini-not-for-this-run",
  CLOUDFLARE_API_KEY: "cf-not-for-this-run",
  CLOUDFLARE_ACCOUNT_ID: "cf-account-not-for-this-run",
});

const HOST = Object.freeze({
  PATH: process.env.PATH,
  HOME: process.env.HOME ?? "/home/kiln",
  TMPDIR: process.env.TMPDIR ?? "/tmp",
  SystemRoot: process.env.SystemRoot,
  COMSPEC: process.env.COMSPEC,
  PATHEXT: process.env.PATHEXT,
  [AGENT_DIR_ENV]: AGENT_DIR,
  TAVILY_API_KEY: KEY,
  ANTHROPIC_API_KEY: "sk-ant-for-the-selected-provider",
  ...OTHER_PROVIDER_KEYS,
  ...SENTINELS,
});

const ANTHROPIC = resolveProviderCredentials("anthropic");

/**
 * Contracts with no stored route, which is what makes an incomplete environment fatal.
 *
 * ⚠️ **EVERY BUILT-IN PROVIDER SUPPORTS `stored` AS WELL, so none of them can witness a refusal.**
 * That is the whole of D17: an incomplete environment on a provider that also accepts `auth.json` is
 * a run that should use the auth file, not a run that should fail. A custom declaration is genuinely
 * environment-only, and the `anyOf` case needs a shape no built-in and no custom declaration has, so
 * it is written out here — `childEnv` takes a contract, and what is under test is what it does with
 * one.
 */
const ENV_ONLY = validateCustomDeclaration({ id: "acme", apiKey: "$ACME_ONLY_KEY" });

const ENV_ONLY_ANYOF = Object.freeze({
  id: "env-only-anyof",
  authSources: Object.freeze([AUTH_SOURCE.ENVIRONMENT_KEY]),
  required: Object.freeze([]),
  anyOf: Object.freeze([Object.freeze(["EO_TOKEN_A", "EO_TOKEN_B"])]),
  optional: Object.freeze([]),
});

const STORED_ONLY = Object.freeze({
  id: "stored-only",
  authSources: Object.freeze([AUTH_SOURCE.STORED]),
  required: Object.freeze(["STORED_ONLY_KEY"]),
  anyOf: Object.freeze([]),
  optional: Object.freeze([]),
});

/**
 * Ask a REAL child which variable names it can read. Names only, never values.
 *
 * ⚠️ **NAMES, BECAUSE A TEST THAT PRINTED VALUES WOULD PUT THEM IN EVERY CI LOG.** What is being
 * proved is which variables crossed a process boundary, and a name answers that. Where the VALUE
 * matters — that the right key crossed, not merely a variable of the right name — `childEnv`'s return
 * is inspected in-process, which needs no child and leaks nothing.
 */
const PROBE = "process.stdout.write(JSON.stringify(Object.keys(process.env).sort()))";

const askChild = (env) => JSON.parse(execFileSync(process.execPath, ["-e", PROBE], { env, encoding: "utf-8" }));

const observe = (role, opts = {}) => askChild(childEnv(role, HOST, { platform: process.platform, ...opts }));

/** What the OS added on top of what Kiln passed. On POSIX this must be empty. */
const unexpected = (observed, passed) => observed.filter((n) => !Object.keys(passed).includes(n));

/** What Kiln refused, rather than the fact of a refusal: these assert on reason and detail. */
function refusal(fn) {
  try {
    fn();
  } catch (e) {
    assert.ok(e instanceof ChildEnvRefusal, `expected a ChildEnvRefusal, got ${e}`);
    return e;
  }
  assert.fail("expected a ChildEnvRefusal, and nothing was thrown");
}

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

/* --------------------------------------- C1: provider credentials cross only when declared ------ */

test("⚠️ C1 only the SELECTED provider's declared names cross, asked of a real process", () => {
  // ⚠️ **FOUR OTHER PROVIDERS' KEYS ARE IN THE HOST, AND THAT IS THE POINT.** A builder that added
  // the union of every known provider name passes a single-provider test perfectly. What distinguishes
  // it is a host holding several at once and a child that sees exactly one contract's worth.
  for (const role of ROLES) {
    const seen = observe(role, { contract: ANTHROPIC });
    assert.ok(seen.includes("ANTHROPIC_API_KEY"), `${role} must receive the selected provider's name`);
    for (const name of Object.keys(OTHER_PROVIDER_KEYS))
      assert.ok(!seen.includes(name), `${role} received ${name}, which belongs to a provider nobody selected`);
  }

  // ⚠️ AND NO PROVIDER NAME AT ALL WHEN NO CONTRACT WAS SUPPLIED. The model plane is opt-in per run.
  const none = observe("planning");
  for (const name of ["ANTHROPIC_API_KEY", ...Object.keys(OTHER_PROVIDER_KEYS)])
    assert.ok(!none.includes(name), `${name} crossed with no provider contract selected`);
});

test("C1 the value that crosses is the selected provider's, not merely a name of the right shape", () => {
  // In-process, because this is the one claim about a VALUE and printing it from a child would put it
  // in every CI log.
  const built = childEnv("planning", HOST, { contract: ANTHROPIC, platform: process.platform });
  assert.equal(built.ANTHROPIC_API_KEY, HOST.ANTHROPIC_API_KEY);
  assert.equal(built.OPENAI_API_KEY, undefined);
});

/* --------------------------------------- C2: anyOf and optional halves -------------------------- */

test("⚠️ C2 an anyOf group crosses whichever members are set, and refuses when none are", () => {
  const host = { ...HOST };
  delete host.ANTHROPIC_API_KEY;
  host.ANTHROPIC_OAUTH_TOKEN = "oauth-token-for-this-run";

  const seen = askChild(childEnv("planning", host, { contract: ANTHROPIC, platform: process.platform }));
  assert.ok(seen.includes("ANTHROPIC_OAUTH_TOKEN"), "the member that is set must cross");
  for (const name of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"])
    assert.ok(!seen.includes(name), `${name} is unset in the host and must not appear`);

  // ⚠️ WITH NONE OF THE THREE SET, Anthropic does NOT refuse: it also supports `stored`, so the run
  // uses the auth file. The refusal case needs a contract with no such fallback, and has its own test.
  const bare = { ...HOST };
  for (const name of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_OAUTH_TOKEN"]) delete bare[name];
  const stored = childEnv("planning", bare, { contract: ANTHROPIC, platform: process.platform });
  for (const name of ANTHROPIC.anyOf.flat()) assert.equal(stored[name], undefined);
});

test("C2 a missing required name refuses when nothing else can authenticate", () => {
  const e = refusal(() => childEnv("planning", HOST, { contract: ENV_ONLY, platform: process.platform }));
  assert.equal(e.reason, ENV_REFUSAL.PROVIDER_NAME_MISSING);
  assert.deepEqual(e.detail.missing, ["ACME_ONLY_KEY"]);
  assert.match(e.message, /stored credential/, "the refusal must say why there is no fallback");

  // Complete, and the one declared name crosses.
  const built = childEnv("planning", { ...HOST, ACME_ONLY_KEY: "v" }, { contract: ENV_ONLY, platform: process.platform });
  assert.equal(built.ACME_ONLY_KEY, "v");
});

test("C2 an unsatisfied anyOf group refuses when nothing else can authenticate", () => {
  const e = refusal(() => childEnv("planning", HOST, { contract: ENV_ONLY_ANYOF, platform: process.platform }));
  assert.equal(e.reason, ENV_REFUSAL.PROVIDER_ANYOF_UNSATISFIED);
  assert.deepEqual(e.detail.group, ["EO_TOKEN_A", "EO_TOKEN_B"]);
});

test("C2 an unset optional name is simply absent", () => {
  const azure = resolveProviderCredentials("azure-openai-responses");
  const host = { ...HOST, AZURE_OPENAI_API_KEY: "k", AZURE_OPENAI_BASE_URL: "https://x" };
  const built = childEnv("planning", host, { contract: azure, platform: process.platform });
  assert.equal(built.AZURE_OPENAI_API_KEY, "k");
  assert.equal(built.AZURE_OPENAI_BASE_URL, "https://x");
  assert.equal(built.AZURE_OPENAI_API_VERSION, undefined, "an unset optional name is simply absent");
});

/* --------------------------------------- D17: the stored route stays open ---------------------- */

test("⚠️ D17 a provider with no environment key still builds, on its Pi locator alone", (tc) => {
  // ⚠️ **THIS IS THE CASE THE FIRST IMPLEMENTATION BLOCKED.** Every built-in provider supports both
  // routes, so requiring the environment names unconditionally refused a perfectly good `auth.json`
  // credential because the environment did not also carry a copy. CMP-0029 PREFERS the auth store —
  // the child then needs the variable that LOCATES the credential rather than the credential — and
  // TSK-0040's canary could never have discovered the stored source through a run that refused first.
  const bare = { ...HOST };
  for (const name of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_OAUTH_TOKEN"]) delete bare[name];

  const built = childEnv("planning", bare, { contract: ANTHROPIC, platform: process.platform });
  assert.equal(built[AGENT_DIR_ENV], AGENT_DIR, "the isolated locator is what the child authenticates through");
  for (const name of ANTHROPIC.anyOf.flat())
    assert.equal(built[name], undefined, `${name} is unset and must not appear`);

  // And a real child sees the locator and no provider variable at all.
  const seen = askChild(built);
  assert.ok(seen.includes(AGENT_DIR_ENV));
  for (const name of [...ANTHROPIC.anyOf.flat(), ...Object.keys(OTHER_PROVIDER_KEYS)])
    assert.ok(!seen.includes(name), `${name} reached a child authenticating from the auth file`);
  tc.diagnostic(`stored-route child received ${seen.length} names, none of them a provider credential`);
});

test("⚠️ D17 an incomplete environment emits NOTHING, never a partial set", () => {
  // ⚠️ Two of Cloudflare's three names are set. Handing those over produces a child configured to
  // reach a gateway it cannot address, or one that silently falls back to a stored credential the
  // operator did not intend for this run. Either the environment route is complete and used, or it is
  // not used.
  const cloudflare = resolveProviderCredentials("cloudflare-ai-gateway");
  const partial = { ...HOST, CLOUDFLARE_API_KEY: "cf", CLOUDFLARE_ACCOUNT_ID: "acct" };
  const built = childEnv("planning", partial, { contract: cloudflare, platform: process.platform });
  for (const name of cloudflare.required) assert.equal(built[name], undefined, `${name} crossed as part of a partial set`);
  assert.equal(built[AGENT_DIR_ENV], AGENT_DIR);

  // Complete, and all three cross together.
  const whole = { ...partial, CLOUDFLARE_GATEWAY_ID: "gw" };
  const full = childEnv("planning", whole, { contract: cloudflare, platform: process.platform });
  for (const name of cloudflare.required) assert.ok(full[name], `${name} must cross once the set is complete`);
});

test("⚠️ D17 a stored-only contract emits no provider variable even when the host has one", () => {
  // ⚠️ NOT THE SAME CASE AS AN INCOMPLETE ONE. A provider with no environment route must not receive
  // an environment credential merely because a variable of the right name exists on the host.
  const built = childEnv("planning", { ...HOST, STORED_ONLY_KEY: "v" }, { contract: STORED_ONLY, platform: process.platform });
  assert.equal(built.STORED_ONLY_KEY, undefined);
  assert.equal(built[AGENT_DIR_ENV], AGENT_DIR);
});

/* --------------------------------------- C3: Tavily as a 2x2 ----------------------------------- */

test("⚠️ C3 TAVILY_API_KEY crosses only for research AND only while enabled", () => {
  // ⚠️ **FOUR CELLS, NOT TWO.** The key is in the host in every one of them. Deriving enablement from
  // the key's presence would collapse the two columns and make the negative case unreachable, which is
  // exactly why `researchEnabled` is supplied rather than inferred.
  const cells = [
    ["research", true, true],
    ["research", false, false],
    ["planning", true, false],
    ["planning", false, false],
    ["validation", true, false],
  ];
  for (const [role, researchEnabled, shouldCross] of cells) {
    const seen = observe(role, { researchEnabled });
    assert.equal(
      seen.includes("TAVILY_API_KEY"),
      shouldCross,
      `${role} with researchEnabled=${researchEnabled} must ${shouldCross ? "" : "not "}see the credential`
    );
  }

  // ⚠️ **A SUPPLIED NON-BOOLEAN IS A REFUSAL, NOT A QUIET `false`.** Reading `"false"` as disabled
  // would be right by accident — it is truthy, so the same value would have OPENED the gate under a
  // truthiness check. A caller that passed something has expressed a choice this cannot read.
  for (const sloppy of [1, 0, "true", "false", "yes", {}, null]) {
    const e = refusal(() => childEnv("research", HOST, { researchEnabled: sloppy, platform: process.platform }));
    assert.equal(e.reason, ENV_REFUSAL.RESEARCH_FLAG_INVALID, `${JSON.stringify(sloppy)} must refuse`);
  }

  // ⚠️ OMITTING IT IS THE SAFE DEFAULT AND NOT A REFUSAL: a caller with no research to enable.
  assert.ok(!observe("research").includes("TAVILY_API_KEY"), "an omitted flag means disabled");
});

test("C3 research enabled with no credential refuses rather than starting a child that cannot retrieve", () => {
  const host = { ...HOST };
  delete host.TAVILY_API_KEY;
  const e = refusal(() => childEnv("research", host, { researchEnabled: true, platform: process.platform }));
  assert.equal(e.reason, ENV_REFUSAL.RESEARCH_CREDENTIAL_MISSING);
  assert.equal(e.detail.variable, "TAVILY_API_KEY");

  // Disabled and absent is an ordinary run, not a refusal.
  assert.ok(!childEnv("research", host, { researchEnabled: false, platform: process.platform }).TAVILY_API_KEY);
});

/* --------------------------------------- C4: sentinels, with a control -------------------------- */

test("⚠️ C4 no sentinel crosses, against a control that shows all of them crossing", (t) => {
  const names = Object.keys(SENTINELS);

  for (const role of ROLES) {
    const seen = observe(role, { contract: ANTHROPIC, researchEnabled: role === "research" });
    for (const name of names) assert.ok(!seen.includes(name), `${role} observed the sentinel ${name}`);
  }

  // ⚠️ **THE CONTROL, AND WITHOUT IT THE CLEAN RESULT PROVES NOTHING.** A child sees no sentinels
  // when the parent never had any, which is indistinguishable from a working boundary. This child is
  // spawned with the environment INHERITED and must observe every one of them.
  const control = askChild({ ...process.env, ...SENTINELS });
  for (const name of names) assert.ok(control.includes(name), `the control did not observe ${name}`);
  t.diagnostic(`control observed ${names.length} sentinels; sanitised children observed 0`);
});

test("⚠️ C4 what the OS adds is reported, and what Kiln adds is asserted", (t) => {
  // ⚠️ **AST-0045: THE BOUNDARY IS A LOWER BOUND ON WINDOWS AND AN EXACT SET ON POSIX.** Windows
  // injects nine names into every child whatever environment it is handed, so asserting that a
  // child's environment equals what Kiln passed would report the operating system as a defect — and a
  // real leak would then be one red line among familiar red lines.
  const passed = childEnv("planning", HOST, { contract: ANTHROPIC, platform: process.platform });
  const observed = askChild(passed);
  const extra = unexpected(observed, passed);

  if (process.platform === "win32") {
    t.diagnostic(`windows injected ${extra.length} name(s) Kiln did not pass: ${extra.join(", ")}`);
    const known = OS_INJECTED_WIN32.map((n) => n.toLowerCase());
    const unrecognised = extra.filter((n) => !known.includes(n.toLowerCase()));
    if (unrecognised.length) t.diagnostic(`not among AST-0045's nine: ${unrecognised.join(", ")}`);
  } else {
    // ⚠️ THE STRONG ASSERTION IS AVAILABLE ON EXACTLY ONE PLATFORM, so it is made there.
    assert.deepEqual(extra, [], "on POSIX a child receives exactly what it was passed");
  }

  // ⚠️ THE CLAIM THAT SURVIVES ON BOTH: nothing credential-shaped is among what Kiln adds.
  for (const name of [...Object.keys(SENTINELS), ...Object.keys(OTHER_PROVIDER_KEYS), "TAVILY_API_KEY"])
    assert.ok(!observed.includes(name), `${name} reached a planning child`);
});

/* --------------------------------------- the agent directory and the base ---------------------- */

test("⚠️ an absent PI_CODING_AGENT_DIR refuses, because omitting it does not isolate on Windows", () => {
  const host = { ...HOST };
  delete host[AGENT_DIR_ENV];
  for (const role of ROLES) {
    const e = refusal(() => childEnv(role, host, { platform: process.platform }));
    assert.equal(e.reason, ENV_REFUSAL.AGENT_DIR_MISSING);
    assert.match(e.message, /USERPROFILE/, "the refusal must say why omission is not isolation");
  }
  // The session directory is optional: a first run has none.
  const built = childEnv("planning", HOST, { platform: process.platform });
  assert.equal(built[AGENT_DIR_ENV], AGENT_DIR);
  assert.equal(built[AGENT_SESSION_DIR_ENV], undefined);
  assert.equal(
    childEnv("planning", { ...HOST, [AGENT_SESSION_DIR_ENV]: "/s" }, { platform: process.platform })[AGENT_SESSION_DIR_ENV],
    "/s"
  );
});

test("⚠️ the base list is platform-specific and each variable is emitted once", () => {
  // ⚠️ **THE OLD SHARED LIST CARRIED `Path` BESIDE `PATH`.** Windows environment names are
  // case-insensitive, so both entries read one variable and both were written into every child.
  const win = childEnv("planning", { PATH: "A", Path: "A", WINDIR: "W", [AGENT_DIR_ENV]: "/a" }, { platform: "win32" });
  assert.deepEqual(Object.keys(win).sort(), ["PATH", "PI_CODING_AGENT_DIR", "windir"]);

  const posix = childEnv("planning", { PATH: "A", SHELL: "/bin/sh", TERM: "xterm", TEMP: "/t", [AGENT_DIR_ENV]: "/a" }, { platform: "linux" });
  assert.deepEqual(Object.keys(posix).sort(), ["PATH", "PI_CODING_AGENT_DIR", "SHELL", "TERM"].sort());
  assert.equal(posix.TEMP, undefined, "TEMP is a Windows spelling and is not on the POSIX list");

  // ⚠️ COMSPEC AND SHELL STAY: shell execution is forbidden by the ABSENCE of the tool, and a
  // boundary enforced by withholding a runtime variable is one a default interpreter path defeats.
  assert.ok(BASE_ENV.win32.includes("COMSPEC") && BASE_ENV.posix.includes("SHELL"));
  for (const role of ROLES) assert.ok(contractFor(role).forbidden.includes("shell execution"), role);
});

test("an unknown role refuses before anything is built", () => {
  const e = refusal(() => childEnv("architect", HOST, { platform: process.platform }));
  assert.equal(e.reason, ENV_REFUSAL.UNKNOWN_ROLE);
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
