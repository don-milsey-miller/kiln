/**
 * A Kiln confirmation in a real interactive Pi, measured at the pseudo-terminal - #177.
 *
 * Kiln used to hand Pi's dialog a `timeout`, and Pi then rewrote the dialog's last message line once a second for
 * the whole wait. When that line was above the visible rows, Pi's renderer cleared the screen and replayed the
 * entire transcript on every tick. Kiln now keeps the five-minute bound to itself and the dialog states it once.
 *
 * ⚠️ **THE CEILING FOR AN IDLE DIALOG IS ZERO.** Nothing new is being said while an operator reads a confirmation,
 * so nothing may be written. This is measured in bytes at the terminal, at a tall height and at one short enough
 * that the dialog's own lines overflow it, which is the case that used to replay the transcript.
 *
 * ⚠️ **THIS IS NOT A CLAIM ABOUT TOKEN RENDERING.** How Pi repaints while a model streams is Pi's, and is untouched.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { stripVTControlCharacters } from "node:util";

import { startPty } from "./helpers/pty.mjs";
import { scriptedProvider, sessionFixture, toolResults } from "./helpers/pi-session.mjs";
import { BOUNDARY_OPERATION, readBoundaryRefusals } from "../lib/operator-boundary.mjs";

const MANIFEST = "name: confirmation fixture\ncapabilities:\n  artifactTypes:\n    activated: [requirement, decision]\n  sandboxTiers:\n    active:\n      - 1\n";
const ACTIVATE = { tool: "kiln_set_type_activation", arguments: { type: "component", action: "activate", reason: "The design names components." } };
const TITLE = /Change this project's artifact types\?/;
const SLOW = 90_000;
/** How long a dialog is left alone. Long enough for several of the once-a-second repaints this used to cause. */
const IDLE_MS = 6_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const screen = (pty) => stripVTControlCharacters(pty.output());

/** Wait until the terminal has written nothing for `ms`. */
async function settled(pty, ms = 1500, limit = 30_000) {
  let last = pty.output().length;
  let still = 0;
  const started = Date.now();
  while (still < ms && Date.now() - started < limit) {
    await sleep(100);
    if (pty.output().length === last) still += 100;
    else {
      still = 0;
      last = pty.output().length;
    }
  }
}

/** Pi, interactive, in a pseudo-terminal of the given height. */
function interactive(fx, { rows }) {
  return startPty(fx.agent.args[0], [...fx.agent.args.slice(1), ...fx.args], { cwd: fx.project, cols: 120, rows, env: fx.env });
}

/** End Pi itself and wait for the terminal to report it. Not `pty.kill()`: see the session helper's probe. */
async function end(fx, pty) {
  if (pty.exit()) return;
  try {
    if (existsSync(fx.pidFile)) process.kill(Number(readFileSync(fx.pidFile, "utf-8")), "SIGKILL");
    else pty.kill();
  } catch {
    // Already gone.
  }
  await Promise.race([pty.exited(), sleep(10_000)]);
}

async function until(what, predicate, ms = SLOW) {
  const started = Date.now();
  while (Date.now() - started < ms) {
    if (await predicate()) return;
    await sleep(100);
  }
  assert.fail(`timed out waiting for ${what}`);
}

for (const rows of [40, 8]) {
  test(`⚠️ #177 a confirmation left idle writes no bytes to a ${rows}-row terminal, and Escape refuses it`, { timeout: 180_000 }, async () => {
    const provider = await scriptedProvider();
    const fx = await sessionFixture(provider, { manifest: MANIFEST });
    provider.script.push(ACTIVATE, { text: "Understood." });
    const pty = interactive(fx, { rows });
    try {
      await settled(pty, 2500, 60_000);
      pty.write("activate the component type\r");
      await pty.waitFor(TITLE, SLOW);
      await settled(pty);

      // ⚠️ THE MEASUREMENT: bytes at the terminal while the dialog is open and nobody touches it.
      const before = pty.output().length;
      await sleep(IDLE_MS);
      const idle = pty.output().slice(before);
      assert.equal(Buffer.byteLength(idle), 0, `the idle dialog wrote ${Buffer.byteLength(idle)} bytes in ${IDLE_MS} ms: ${JSON.stringify(idle.slice(0, 300))}`);

      // The limit is stated once, as text, and nothing counts down.
      const shown = screen(pty);
      assert.ok(shown.includes("This confirmation expires after five minutes."), "the dialog does not say when it expires");
      assert.doesNotMatch(shown, /\(\d+s\)/, "the dialog shows a countdown");
      assert.equal(provider.requests.length, 1, "the gated tool ran before the operator answered");

      // The dialog is a real one: Escape refuses, and the tool's refusal is what the model is told.
      pty.write("\u001b");
      await until("the refusal to reach the provider", () => provider.requests.length === 2);
      const [refusal] = toolResults(provider.requests[1]);
      assert.equal(refusal.ok, false);
      assert.equal(refusal.code, "operator-confirmation-not-granted");
      assert.ok(readFileSync(join(fx.contentRoot, "project.yaml"), "utf-8").includes("activated: [requirement, decision]"), "the refused activation changed the manifest");
    } finally {
      await end(fx, pty);
      await provider.close();
      fx.remove();
    }
  });
}

/**
 * Kiln's extension with a three-second confirmation bound, so its own expiry can be watched in a real dialog.
 *
 * ⚠️ **THE SAME `register`, CALLED WITH ONE DEPENDENCY.** Pi passes `register` no second argument, so the bound
 * cannot be shortened from outside; this wrapper is loaded in place of the packaged entry and changes nothing else.
 */
const SHORT_BOUND = ({ tool }) => `
import register from ${JSON.stringify(pathToFileURL(join(tool, "pi-package", "extensions", "kiln.js")).href)};
export default function (pi) {
  register(pi, { confirmTimeoutMs: 3000 });
}
`;

test("⚠️ #177 Kiln's own expiry closes the real dialog, records the refusal, and frees the next confirmation", { timeout: 240_000 }, async () => {
  const provider = await scriptedProvider();
  const fx = await sessionFixture(provider, { manifest: MANIFEST, packaged: false, extensions: { "kiln-short-bound.js": SHORT_BOUND } });
  // The first call is left to expire. The model is then scripted to ask again, and that one is confirmed.
  provider.script.push(ACTIVATE, ACTIVATE, { text: "Activated." });
  const pty = interactive(fx, { rows: 40 });
  try {
    await settled(pty, 2500, 60_000);
    pty.write("activate the component type\r");
    await pty.waitFor(TITLE, SLOW);
    assert.ok(screen(pty).includes("This confirmation expires after 3 seconds."), "the dialog does not state the bound it was given");

    // Nobody answers. Kiln's timer, and nothing of Pi's, ends the wait.
    await until("the expired refusal to reach the provider", () => provider.requests.length === 2, 30_000);
    const [expired] = toolResults(provider.requests[1]);
    assert.equal(expired.ok, false);
    assert.equal(expired.code, "operator-confirmation-expired");
    assert.match(expired.message, /Retry the exact action/);
    assert.deepEqual(
      readBoundaryRefusals(fx.contentRoot).refusals.map((r) => [r.operation, r.target]),
      [[BOUNDARY_OPERATION.SET_TYPE_ACTIVATION, { type: "component", action: "activate" }]],
      "the expiry was not recorded as an operator-boundary refusal"
    );
    assert.ok(readFileSync(join(fx.contentRoot, "project.yaml"), "utf-8").includes("activated: [requirement, decision]"), "the expired activation changed the manifest");

    // ⚠️ THE FIRST DIALOG IS GONE AND THE QUEUE IS FREE: the second call's own dialog opens and takes an answer.
    const titles = () => screen(pty).split("Change this project's artifact types?").length - 1;
    await until("the second dialog to open", () => titles() >= 2, 30_000);
    await settled(pty, 800);
    pty.write("\r");
    await until("the confirmed result to reach the provider", () => provider.requests.length === 3, 30_000);
    const results = toolResults(provider.requests[2]);
    assert.equal(results.length, 2);
    assert.equal(results[1].ok, true, JSON.stringify(results[1]));
    assert.equal(results[1].changed, true);
    assert.ok(readFileSync(join(fx.contentRoot, "project.yaml"), "utf-8").includes("component"), "the confirmed activation did not reach the manifest");
    assert.equal(readBoundaryRefusals(fx.contentRoot).refusals.length, 1, "the confirmed call recorded a refusal");
  } finally {
    await end(fx, pty);
    await provider.close();
    fx.remove();
  }
});
