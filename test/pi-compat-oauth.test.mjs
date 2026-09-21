/**
 * The retained record of the manual OAuth check — TSK-0066, toward ACC-0091.
 *
 * ⚠️ **THIS READS WHAT `tools/pi-compat/oauth-check.mjs` SAVED; IT RUNS NOTHING.** The run needs a real
 * subscription and an operator, so it is manual, account-bound and single-instance. What this holds is
 * the record: three fresh discovery readings, the stored credential's shape and nothing more, the
 * removal, and that nothing credential-shaped or machine-identifying survived.
 *
 * ⚠️ **REGISTRY DISCOVERY, NOT A WORKING REQUEST.** Availability after the login and its loss after the
 * credential was removed are all the record claims. No model request and no token refresh was made.
 *
 * ⚠️ **IT CANNOT PROVE THE TOKEN IS ABSENT.** Pi stored the credential in the isolated configuration
 * during the login, and that configuration was deleted after the run, so nothing here knows it. That
 * no credential value is in the record rests on the capture-time check, which refused to save if any 8-character run of any stored
 * credential value, the username or the home path appeared. This adds the redaction scan and checks
 * for token-shaped content.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { redactionViolations } from "../tools/pi-compat/lib/redact.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FILE = join(ROOT, "tools", "pi-compat", "runs", "oauth", "oauth-windows.json");
const PINNED = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).dependencies["@earendil-works/pi-coding-agent"];
const text = readFileSync(FILE, "utf8");
const r = JSON.parse(text);

/** Written out rather than imported, so the harness and this assertion are two statements. */
const PROVIDER = "openai-codex";
const MODEL = "gpt-5.5";
const LAUNCH_ARGS = [
  "--no-session", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-themes",
  "--no-context-files", "--no-approve", "--offline",
];

test("the OAuth record is labelled manual and account-bound, and names its target and pin", () => {
  assert.match(r.meta.label, /manual, account-bound, single-instance; not a suite result/);
  assert.equal(r.meta.platform, "win32");
  assert.equal(r.meta.pinned, PINNED, `the record was taken against pin ${r.meta.pinned}`);
  assert.equal(r.meta.piVersion, PINNED);
  assert.equal(r.meta.provider, PROVIDER);
  assert.equal(r.meta.model, MODEL);
  assert.deepEqual(r.meta.launchArgs, LAUNCH_ARGS);
  // ⚠️ NO CREDENTIAL NAME REACHED ANY CHILD, and the isolated agent directory did.
  assert.ok(r.meta.environmentNames.includes("PI_CODING_AGENT_DIR"));
  for (const name of r.meta.environmentNames)
    assert.equal(/(API_?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|_AUTH)/i.test(name), false, `${name} reached a child`);
});

test("three fresh readings: unavailable, available after the login, unavailable after removal", () => {
  const reading = (x) => ({ freshProcess: x.freshProcess, inCatalogue: x.inCatalogue, available: x.available, hasConfiguredAuth: x.hasConfiguredAuth, providerAuthStatus: x.providerAuthStatus });
  const unavailable = { freshProcess: true, inCatalogue: true, available: false, hasConfiguredAuth: false, providerAuthStatus: { configured: false, source: null } };

  assert.deepEqual(reading(r.baseline), unavailable, "the model was not unavailable before the login");
  assert.equal(r.login.piExit, 0, "Pi's exit after the login was not 0");
  assert.deepEqual(reading(r.afterLogin),
    { freshProcess: true, inCatalogue: true, available: true, hasConfiguredAuth: true, providerAuthStatus: { configured: true, source: "stored" } },
    "the model was not available from the stored credential after the login");
  // ⚠️ THE REVOCATION CONTROL. Without it, availability after the login could have had another cause.
  assert.deepEqual(reading(r.afterRemoval), unavailable, "the model stayed available after the credential was removed");
});

test("the stored credential is recorded by shape only, and removal left no provider entry", () => {
  assert.deepEqual(r.storedAfterLogin, { present: true, providers: { [PROVIDER]: { type: "oauth" } } });
  for (const entry of Object.values(r.storedAfterLogin.providers))
    assert.deepEqual(Object.keys(entry), ["type"], "a stored credential field other than its type was recorded");
  assert.deepEqual(r.storedAfterRemoval, { present: true, providers: {} });
});

test("the record claims no model request or token refresh", () => {
  assert.ok(r.limits.some((l) => /no model request or token refresh was made/.test(l)));
  assert.match(r.meta.discovery, /allowModelNetwork: false/);
});

test("the OAuth record passes the redaction scan and carries nothing token-shaped", () => {
  assert.deepEqual(redactionViolations(text), [], "the record retains machine-identifying or credential-shaped content");
  assert.equal(/eyJ[A-Za-z0-9_-]{10,}/.test(text), false, "the record carries a JWT-shaped value");
  assert.equal(/bearer\s/i.test(text), false, "the record carries an authorisation header");
  assert.equal(/[A-Za-z0-9+/_-]{32,}/.test(text), false, "the record carries a long opaque value");
  assert.equal(/[\w.+-]+@[\w-]+\.[\w.]+/.test(text), false, "the record carries an email address");
  assert.equal(/"(access|refresh|token|accessToken|refreshToken|id_token|accountId|email|expires)"/.test(text), false,
    "the record carries a credential field name");
});
